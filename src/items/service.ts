import { can } from '../authz/can';
import type { Action, CanItem } from '../authz/can';
import type { AuthUser } from '../auth/middleware';
import { pool, tx } from '../db/pool';
import { denyReasonToError, HttpError, NotFound } from '../middleware/errors';
import { TRANSITIONS } from './workflow';
import type { ItemStatus } from './workflow';
import {
  completeIdempotencyKey,
  getItemById,
  getIdempotencyKey,
  insertActivityEvent,
  insertIdempotencyKey,
  insertItem,
  listActivityEvents,
  listItems as listItemsInDb,
} from './repository';
import type { ActivityRow, ItemView, WorkItemRow } from './repository';

/**
 * Item services: rules + transactions. Routes never touch SQL, repositories
 * never check permissions; every write goes through tx() and every permission
 * question goes through can().
 */

/** API shape: camelCase, ISO-8601 timestamps. */
export interface ApiItem {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: ItemStatus;
  teamId: string;
  assigneeId: string | null;
  createdBy: string;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function toApiItem(row: WorkItemRow): ApiItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    type: row.type,
    priority: row.priority,
    status: row.status,
    teamId: row.team_id,
    assigneeId: row.assignee_id,
    createdBy: row.created_by,
    dueDate: row.due_date ? row.due_date.toISOString() : null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function teamIdsOf(user: AuthUser): string[] {
  return user.memberships.map((m) => m.teamId);
}

function approvalTeamIdsOf(user: AuthUser): string[] {
  return user.memberships.filter((m) => m.role === 'lead' || m.role === 'admin').map((m) => m.teamId);
}

function itemContext(row: WorkItemRow): CanItem {
  return { teamId: row.team_id, assigneeId: row.assignee_id, status: row.status };
}

/** The single permission gate used by services; deny reasons map to 403/404. */
function assertCan(user: AuthUser, action: Action, item: CanItem): void {
  const decision = can(user, action, item);
  if (!decision.allowed) throw denyReasonToError(decision.reason);
}

// ---- List ------------------------------------------------------------------

export interface ListItemsInput {
  status?: ItemStatus;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: string; // uuid, or 'me' resolved to the caller
  team?: string;
  q?: string;
  view?: ItemView;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

function encodeCursor(row: WorkItemRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id })).toString('base64url');
}

export async function listItems(
  user: AuthUser,
  input: ListItemsInput
): Promise<{ items: ApiItem[]; nextCursor: string | null }> {
  const rows = await listItemsInDb(pool, {
    teamIds: teamIdsOf(user),
    userId: user.id,
    approvalTeamIds: approvalTeamIdsOf(user),
    status: input.status,
    priority: input.priority,
    assigneeId: input.assignee === 'me' ? user.id : input.assignee,
    teamId: input.team,
    q: input.q,
    view: input.view,
    limit: input.limit,
    cursor: input.cursor,
  });

  const last = rows[rows.length - 1];
  const nextCursor = rows.length === input.limit ? encodeCursor(last) : null;
  return { items: rows.map(toApiItem), nextCursor };
}

// ---- Detail ----------------------------------------------------------------

export interface ItemDetail extends ApiItem {
  allowedActions: Action[];
}

const ALLOWED_ACTIONS: Action[] = ['read', 'create', 'edit', 'comment', 'claim', 'transition', 'reassign'];

/**
 * allowedActions mirrors what can() allows for this item - the UI never
 * computes permissions. 'transition' is included when at least one defined
 * transition from the item's status is permitted (enforcement stays in can()).
 */
function computeAllowedActions(user: AuthUser, row: WorkItemRow): Action[] {
  const item = itemContext(row);
  return ALLOWED_ACTIONS.filter((action) => {
    if (action === 'transition') {
      return TRANSITIONS.some(
        (rule) => rule.from === row.status && can(user, 'transition', { ...item, targetStatus: rule.to }).allowed
      );
    }
    return can(user, action, item).allowed;
  });
}

export async function getItemDetail(user: AuthUser, itemId: string): Promise<ItemDetail> {
  // Team scoping happens in SQL: items outside the caller's teams are 404.
  const row = await getItemById(pool, itemId, teamIdsOf(user));
  if (!row) throw new NotFound('Item not found');
  assertCan(user, 'read', itemContext(row));
  return { ...toApiItem(row), allowedActions: computeAllowedActions(user, row) };
}

// ---- Create (idempotent) ---------------------------------------------------

export interface CreateItemInput {
  title: string;
  description?: string;
  type: 'incident' | 'customer_issue' | 'payment' | 'compliance' | 'task';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  team_id: string;
  due_date?: string;
}

export interface CreateItemResult {
  statusCode: number;
  responseBody: unknown;
}

export async function createItem(
  user: AuthUser,
  input: CreateItemInput,
  idempotencyKey: string,
  requestHash: string
): Promise<CreateItemResult> {
  assertCan(user, 'create', { teamId: input.team_id });

  try {
    return await tx(async (client) => {
      // (a) Claim the key first with a plain INSERT (no ON CONFLICT). A
      // concurrent request with the same key blocks on the unique index until
      // this transaction commits or rolls back; if it committed first, the
      // loser gets a unique_violation (23505) and replays in the catch below.
      await insertIdempotencyKey(client, { userId: user.id, key: idempotencyKey, requestHash });

      // (b) Create the item: status OPEN, version 1, created_by = caller.
      const row = await insertItem(client, {
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        priority: input.priority,
        teamId: input.team_id,
        createdBy: user.id,
        dueDate: input.due_date ?? null,
      });

      // (c) Activity event in the SAME transaction (single-writer rule).
      await insertActivityEvent(client, {
        itemId: row.id,
        actorId: user.id,
        type: 'CREATED',
        payload: { title: row.title },
      });

      const body = toApiItem(row);
      await completeIdempotencyKey(client, { userId: user.id, key: idempotencyKey, statusCode: 201, responseBody: body });
      return { statusCode: 201, responseBody: body };
    });
  } catch (err) {
    // The transaction that owned the key committed first. tx() has rolled the
    // failed transaction back, so re-read the committed response in a fresh
    // statement and replay it (never 409).
    if (!isIdempotencyKeyConflict(err)) throw err;
    const existing = await getIdempotencyKey(pool, user.id, idempotencyKey);
    if (!existing) throw err;
    if (existing.request_hash !== requestHash) {
      throw new HttpError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request body');
    }
    return { statusCode: existing.status_code, responseBody: existing.response_body };
  }
}

/** True when err is the unique_violation (23505) raised by the idempotency_keys insert. */
function isIdempotencyKeyConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pgError = err as { code?: unknown; table?: unknown };
  return pgError.code === '23505' && pgError.table === 'idempotency_keys';
}

// ---- Activity --------------------------------------------------------------

export interface ApiActivityEvent {
  id: string;
  itemId: string;
  actorId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

function toApiEvent(row: ActivityRow): ApiActivityEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listActivity(
  user: AuthUser,
  itemId: string,
  limit: number,
  cursorId?: string
): Promise<{ events: ApiActivityEvent[]; nextCursor: string | null }> {
  // Visibility: the item must be in one of the caller's teams (SQL -> 404 otherwise).
  const item = await getItemById(pool, itemId, teamIdsOf(user));
  if (!item) throw new NotFound('Item not found');
  assertCan(user, 'read', itemContext(item));

  const rows = await listActivityEvents(pool, { itemId, teamIds: teamIdsOf(user), limit, cursorId });
  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit ? last.id : null;
  return { events: rows.map(toApiEvent), nextCursor };
}
