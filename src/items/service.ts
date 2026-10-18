import type { PoolClient } from 'pg';
import { can } from '../authz/can';
import type { Action, CanItem } from '../authz/can';
import type { AuthUser } from '../auth/middleware';
import { pool, tx } from '../db/pool';
import { denyReasonToError, HttpError, NotFound } from '../middleware/errors';
import { getAllowedTransitions, getTransitionRule } from './workflow';
import type { ItemStatus } from './workflow';
import {
  completeIdempotencyKey,
  getItemById,
  getIdempotencyKey,
  hasTeamMembership,
  insertActivityEvent,
  insertIdempotencyKey,
  insertItem,
  listActivityEvents,
  listItems as listItemsInDb,
  updateItemAssignee,
  updateItemClaim,
  updateItemFields,
  updateItemStatus,
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
      return getAllowedTransitions(row.status).some(
        (rule) => can(user, 'transition', { ...item, targetStatus: rule.to }).allowed
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

// ---- Writes: claim / patch / transition / assign / comment -----------------
//
// Concurrency contract: each state change is ONE guarded UPDATE whose WHERE
// clause decides the conflict; a 0-row result is resolved to 409/404 after it.
// No read-then-write outside the guarded statement.

/** Result a write route sends as-is; 409 bodies carry the current item. */
export interface WriteResult {
  statusCode: number;
  responseBody: unknown;
}

function conflictResult(code: string, message: string, row: WorkItemRow): WriteResult {
  return {
    statusCode: 409,
    responseBody: { error: { code, message }, item: toApiItem(row) },
  };
}

/** A guarded UPDATE matched 0 rows: 404 if the item is not in the caller's teams, else 409 + latest item. */
async function versionConflict(client: PoolClient, itemId: string, teamIds: string[]): Promise<WriteResult> {
  const current = await getItemById(client, itemId, teamIds);
  if (!current) throw new NotFound('Item not found');
  return conflictResult('VERSION_CONFLICT', 'Item was modified - reload it and retry', current);
}

export async function claimItem(user: AuthUser, itemId: string): Promise<WriteResult> {
  return tx(async (client) => {
    // Read first only for permission context; the claim itself is decided by the UPDATE.
    const row = await getItemById(client, itemId, teamIdsOf(user));
    if (!row) throw new NotFound('Item not found');
    assertCan(user, 'claim', itemContext(row));

    const updated = await updateItemClaim(client, { id: itemId, userId: user.id });
    if (!updated) {
      const current = await getItemById(client, itemId, teamIdsOf(user));
      if (!current) throw new NotFound('Item not found');
      if (current.assignee_id !== null) {
        return conflictResult('ALREADY_CLAIMED', 'Item is already assigned', current);
      }
      return conflictResult('NOT_CLAIMABLE', 'Item status does not allow claiming', current);
    }

    await insertActivityEvent(client, {
      itemId: updated.id,
      actorId: user.id,
      type: 'CLAIMED',
      payload: { assigneeId: user.id },
    });
    // The claim also moved OPEN -> IN_PROGRESS; one event per actual change.
    if (row.status === 'OPEN') {
      await insertActivityEvent(client, {
        itemId: updated.id,
        actorId: user.id,
        type: 'STATUS_CHANGED',
        payload: { from: 'OPEN', to: updated.status },
      });
    }
    return { statusCode: 200, responseBody: toApiItem(updated) };
  });
}

export interface PatchItemInput {
  version: number;
  fields: {
    title?: string;
    description?: string | null;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    due_date?: string | null;
  };
}

export async function patchItem(user: AuthUser, itemId: string, input: PatchItemInput): Promise<WriteResult> {
  return tx(async (client) => {
    const row = await getItemById(client, itemId, teamIdsOf(user));
    if (!row) throw new NotFound('Item not found');
    assertCan(user, 'edit', itemContext(row));

    // Only provided fields whose value differs are written, and each one
    // produces its FIELD_CHANGED event in the same transaction.
    const fields: { title?: string; description?: string | null; priority?: string; dueDate?: string | null } = {};
    const changes: { field: string; from: string | null; to: string | null }[] = [];

    if (input.fields.title !== undefined && input.fields.title !== row.title) {
      fields.title = input.fields.title;
      changes.push({ field: 'title', from: row.title, to: input.fields.title });
    }
    if (input.fields.description !== undefined && input.fields.description !== row.description) {
      fields.description = input.fields.description;
      changes.push({ field: 'description', from: row.description, to: input.fields.description });
    }
    if (input.fields.priority !== undefined && input.fields.priority !== row.priority) {
      fields.priority = input.fields.priority;
      changes.push({ field: 'priority', from: row.priority, to: input.fields.priority });
    }
    if (input.fields.due_date !== undefined) {
      const currentDue = row.due_date ? row.due_date.toISOString() : null;
      const nextDue = input.fields.due_date === null ? null : new Date(input.fields.due_date).toISOString();
      if (nextDue !== currentDue) {
        fields.dueDate = nextDue;
        changes.push({ field: 'due_date', from: currentDue, to: nextDue });
      }
    }

    const updated = await updateItemFields(client, {
      id: itemId,
      teamIds: teamIdsOf(user),
      version: input.version,
      fields,
    });
    if (!updated) return versionConflict(client, itemId, teamIdsOf(user));

    for (const change of changes) {
      await insertActivityEvent(client, {
        itemId: updated.id,
        actorId: user.id,
        type: 'FIELD_CHANGED',
        payload: change,
      });
    }
    return { statusCode: 200, responseBody: toApiItem(updated) };
  });
}

export interface TransitionItemInput {
  to: string;
  version: number;
}

export async function transitionItem(user: AuthUser, itemId: string, input: TransitionItemInput): Promise<WriteResult> {
  return tx(async (client) => {
    const row = await getItemById(client, itemId, teamIdsOf(user));
    if (!row) throw new NotFound('Item not found');

    // Workflow rule first (422), then role/assignee/self checks in can() (403).
    const rule = getTransitionRule(row.status, input.to as ItemStatus);
    if (!rule) {
      throw new HttpError(422, 'INVALID_TRANSITION', `Transition ${row.status} -> ${input.to} is not allowed`);
    }
    assertCan(user, 'transition', { ...itemContext(row), targetStatus: rule.to });

    const updated = await updateItemStatus(client, {
      id: itemId,
      teamIds: teamIdsOf(user),
      version: input.version,
      fromStatus: row.status,
      toStatus: rule.to,
    });
    if (!updated) return versionConflict(client, itemId, teamIdsOf(user));

    await insertActivityEvent(client, {
      itemId: updated.id,
      actorId: user.id,
      type: 'STATUS_CHANGED',
      payload: { from: row.status, to: updated.status },
    });
    return { statusCode: 200, responseBody: toApiItem(updated) };
  });
}

export interface AssignItemInput {
  assigneeId: string;
  version: number;
}

export async function assignItem(user: AuthUser, itemId: string, input: AssignItemInput): Promise<WriteResult> {
  return tx(async (client) => {
    const row = await getItemById(client, itemId, teamIdsOf(user));
    if (!row) throw new NotFound('Item not found');
    assertCan(user, 'reassign', itemContext(row));

    // The new assignee must belong to the item's team.
    const isMember = await hasTeamMembership(client, input.assigneeId, row.team_id);
    if (!isMember) {
      throw new HttpError(400, 'INVALID_ASSIGNEE', 'Assignee must be a member of the item team');
    }

    const updated = await updateItemAssignee(client, {
      id: itemId,
      teamIds: teamIdsOf(user),
      version: input.version,
      assigneeId: input.assigneeId,
    });
    if (!updated) return versionConflict(client, itemId, teamIdsOf(user));

    await insertActivityEvent(client, {
      itemId: updated.id,
      actorId: user.id,
      type: 'ASSIGNED',
      payload: { from: row.assignee_id, to: updated.assignee_id },
    });
    return { statusCode: 200, responseBody: toApiItem(updated) };
  });
}

export async function addComment(
  user: AuthUser,
  itemId: string,
  text: string,
  idempotencyKey: string,
  requestHash: string
): Promise<WriteResult> {
  try {
    return await tx(async (client) => {
      const row = await getItemById(client, itemId, teamIdsOf(user));
      if (!row) throw new NotFound('Item not found');
      assertCan(user, 'comment', itemContext(row));

      // Same idempotency pattern as createItem: plain INSERT, 23505 replays.
      await insertIdempotencyKey(client, { userId: user.id, key: idempotencyKey, requestHash });
      const event = await insertActivityEvent(client, {
        itemId: row.id,
        actorId: user.id,
        type: 'COMMENTED',
        payload: { text },
      });

      const body = toApiEvent(event);
      await completeIdempotencyKey(client, { userId: user.id, key: idempotencyKey, statusCode: 201, responseBody: body });
      return { statusCode: 201, responseBody: body };
    });
  } catch (err) {
    // The transaction that owned the key committed first: replay its response.
    if (!isIdempotencyKeyConflict(err)) throw err;
    const existing = await getIdempotencyKey(pool, user.id, idempotencyKey);
    if (!existing) throw err;
    if (existing.request_hash !== requestHash) {
      throw new HttpError(422, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request body');
    }
    return { statusCode: existing.status_code, responseBody: existing.response_body };
  }
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
