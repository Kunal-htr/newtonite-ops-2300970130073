import type { Pool, PoolClient } from 'pg';
import type { ItemStatus } from './workflow';

/**
 * Item repository: raw SQL only, no permission checks or workflow rules
 * (those live in service.ts / can() / workflow.ts).
 *
 * Reads accept a Pool (no transaction needed); writes receive the PoolClient
 * that runs inside the caller's tx() so the item, its activity event and its
 * idempotency row commit or roll back together.
 */

export type Db = Pool | PoolClient;

export interface WorkItemRow {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: string;
  status: ItemStatus;
  team_id: string;
  assignee_id: string | null;
  created_by: string;
  due_date: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const ITEM_COLUMNS = `wi.id, wi.title, wi.description, wi.type, wi.priority, wi.status,
       wi.team_id, wi.assignee_id, wi.created_by, wi.due_date,
       wi.version, wi.created_at, wi.updated_at`;

/** Escapes LIKE/ILIKE metacharacters so `q` can only ever add literal text. */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

export type ItemView = 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';

export interface ListItemsQuery {
  /** Caller's team ids - every query is scoped to them (or to a subset). */
  teamIds: string[];
  /** Caller id, used by the view predicates. */
  userId: string;
  /** For view=awaiting_my_approval: teams where the caller is lead/admin. */
  approvalTeamIds: string[];
  status?: ItemStatus;
  priority?: string;
  assigneeId?: string;
  teamId?: string;
  q?: string;
  view?: ItemView;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

export async function listItems(db: Db, query: ListItemsQuery): Promise<WorkItemRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => `$${params.push(value)}`;

  if (query.view === 'awaiting_my_approval') {
    // Team scope is the caller's lead/admin teams (a subset of their teams).
    conditions.push(`wi.team_id = ANY(${addParam(query.approvalTeamIds)}::uuid[])`);
    conditions.push(`wi.status = 'AWAITING_APPROVAL'`);
    // IS DISTINCT FROM also keeps rows with assignee_id IS NULL.
    conditions.push(`wi.assignee_id IS DISTINCT FROM ${addParam(query.userId)}::uuid`);
  } else {
    conditions.push(`wi.team_id = ANY(${addParam(query.teamIds)}::uuid[])`);
    if (query.view === 'assigned_to_me') {
      conditions.push(`wi.assignee_id = ${addParam(query.userId)}::uuid`);
      conditions.push(`wi.status <> 'CLOSED'`);
    } else if (query.view === 'unassigned_urgent') {
      conditions.push(`wi.assignee_id IS NULL`);
      conditions.push(`wi.priority = 'urgent'`);
      conditions.push(`wi.status IN ('OPEN', 'IN_PROGRESS')`);
    }
  }

  if (query.status) conditions.push(`wi.status = ${addParam(query.status)}`);
  if (query.priority) conditions.push(`wi.priority = ${addParam(query.priority)}`);
  if (query.assigneeId) conditions.push(`wi.assignee_id = ${addParam(query.assigneeId)}::uuid`);
  if (query.teamId) conditions.push(`wi.team_id = ${addParam(query.teamId)}::uuid`);
  if (query.q) {
    // PostgreSQL default escape character is backslash; escapeLikeTerm escapes %, _ and \.
    conditions.push(`wi.title ILIKE '%' || ${addParam(escapeLikeTerm(query.q))} || '%'`);
  }
  if (query.cursor) {
    conditions.push(
      `(wi.created_at, wi.id) < (${addParam(query.cursor.createdAt)}::timestamptz, ${addParam(query.cursor.id)}::uuid)`
    );
  }

  const sql = `
    SELECT ${ITEM_COLUMNS}
    FROM work_items wi
    WHERE ${conditions.join('\n      AND ')}
    ORDER BY wi.created_at DESC, wi.id DESC
    LIMIT ${addParam(query.limit)}
  `;
  const { rows } = await db.query<WorkItemRow>(sql, params);
  return rows;
}

export async function getItemById(db: Db, itemId: string, teamIds: string[]): Promise<WorkItemRow | undefined> {
  const { rows } = await db.query<WorkItemRow>(
    `SELECT ${ITEM_COLUMNS}
     FROM work_items wi
     WHERE wi.id = $1 AND wi.team_id = ANY($2::uuid[])`,
    [itemId, teamIds]
  );
  return rows[0];
}

export interface NewItemInput {
  title: string;
  description: string | null;
  type: string;
  priority: string;
  teamId: string;
  createdBy: string;
  dueDate: string | null;
}

export async function insertItem(client: PoolClient, input: NewItemInput): Promise<WorkItemRow> {
  const { rows } = await client.query<WorkItemRow>(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, created_by, due_date)
     VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7)
     RETURNING id, title, description, type, priority, status, team_id, assignee_id,
               created_by, due_date, version, created_at, updated_at`,
    [input.title, input.description, input.type, input.priority, input.teamId, input.createdBy, input.dueDate]
  );
  return rows[0];
}

/** Unqualified column list for UPDATE ... RETURNING of a full work_items row. */
const RETURNING_ITEM_COLUMNS = `id, title, description, type, priority, status, team_id,
       assignee_id, created_by, due_date, version, created_at, updated_at`;

/**
 * Version/state-guarded writes: a single UPDATE whose WHERE clause decides the
 * conflict. `undefined` means 0 rows matched (conflict or no visibility).
 */
export async function updateItemClaim(
  client: PoolClient,
  input: { id: string; userId: string }
): Promise<WorkItemRow | undefined> {
  const { rows } = await client.query<WorkItemRow>(
    `UPDATE work_items
     SET assignee_id = $2,
         status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
         version = version + 1,
         updated_at = now()
     WHERE id = $1 AND assignee_id IS NULL AND status IN ('OPEN', 'IN_PROGRESS')
     RETURNING ${RETURNING_ITEM_COLUMNS}`,
    [input.id, input.userId]
  );
  return rows[0];
}

export async function updateItemFields(
  client: PoolClient,
  input: {
    id: string;
    teamIds: string[];
    version: number;
    fields: { title?: string; description?: string | null; priority?: string; dueDate?: string | null };
  }
): Promise<WorkItemRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => `$${params.push(value)}`;

  if (input.fields.title !== undefined) sets.push(`title = ${addParam(input.fields.title)}`);
  if (input.fields.description !== undefined) sets.push(`description = ${addParam(input.fields.description)}`);
  if (input.fields.priority !== undefined) sets.push(`priority = ${addParam(input.fields.priority)}`);
  if (input.fields.dueDate !== undefined) sets.push(`due_date = ${addParam(input.fields.dueDate)}::timestamptz`);
  sets.push('version = version + 1', 'updated_at = now()');

  const { rows } = await client.query<WorkItemRow>(
    `UPDATE work_items
     SET ${sets.join(', ')}
     WHERE id = ${addParam(input.id)} AND version = ${addParam(input.version)}
       AND team_id = ANY(${addParam(input.teamIds)}::uuid[])
     RETURNING ${RETURNING_ITEM_COLUMNS}`,
    params
  );
  return rows[0];
}

export async function updateItemStatus(
  client: PoolClient,
  input: { id: string; teamIds: string[]; version: number; fromStatus: ItemStatus; toStatus: ItemStatus }
): Promise<WorkItemRow | undefined> {
  const { rows } = await client.query<WorkItemRow>(
    `UPDATE work_items
     SET status = $4, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2 AND status = $3 AND team_id = ANY($5::uuid[])
     RETURNING ${RETURNING_ITEM_COLUMNS}`,
    [input.id, input.version, input.fromStatus, input.toStatus, input.teamIds]
  );
  return rows[0];
}

export async function updateItemAssignee(
  client: PoolClient,
  input: { id: string; teamIds: string[]; version: number; assigneeId: string }
): Promise<WorkItemRow | undefined> {
  const { rows } = await client.query<WorkItemRow>(
    `UPDATE work_items
     SET assignee_id = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND version = $2 AND team_id = ANY($4::uuid[])
     RETURNING ${RETURNING_ITEM_COLUMNS}`,
    [input.id, input.version, input.assigneeId, input.teamIds]
  );
  return rows[0];
}

/** Membership check used to validate a new assignee before the guarded UPDATE. */
export async function hasTeamMembership(db: Db, userId: string, teamId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND team_id = $2`, [userId, teamId]);
  return rows.length > 0;
}

export async function insertActivityEvent(
  client: PoolClient,
  input: { itemId: string; actorId: string; type: string; payload: unknown }
): Promise<ActivityRow> {
  const { rows } = await client.query<ActivityRow>(
    `INSERT INTO activity_events (item_id, actor_id, type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, item_id, actor_id, type, payload, created_at`,
    [input.itemId, input.actorId, input.type, JSON.stringify(input.payload)]
  );
  return rows[0];
}

export interface ActivityRow {
  id: string; // bigint, returned as string by pg
  item_id: string;
  actor_id: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

export async function listActivityEvents(
  db: Db,
  params: { itemId: string; teamIds: string[]; limit: number; cursorId?: string }
): Promise<ActivityRow[]> {
  const conditions = ['ae.item_id = $1', 'wi.team_id = ANY($3::uuid[])'];
  const values: unknown[] = [params.itemId, params.limit, params.teamIds];
  if (params.cursorId) {
    conditions.push(`ae.id < $4`);
    values.push(params.cursorId);
  }
  const { rows } = await db.query<ActivityRow>(
    `SELECT ae.id, ae.item_id, ae.actor_id, ae.type, ae.payload, ae.created_at
     FROM activity_events ae
     JOIN work_items wi ON wi.id = ae.item_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ae.id DESC
     LIMIT $2`,
    values
  );
  return rows;
}

export interface IdempotencyRow {
  user_id: string;
  key: string;
  request_hash: string;
  status_code: number;
  response_body: unknown;
  created_at: Date;
}

/**
 * Step (a) of a write: claim the (user_id, key) row with a plain INSERT and no
 * ON CONFLICT clause. Under concurrency the unique index makes this statement
 * wait for the conflicting transaction: if it commits first, the unique
 * violation (SQLSTATE 23505) is thrown for the caller to catch and replay; if
 * it rolls back, the INSERT simply succeeds.
 */
export async function insertIdempotencyKey(
  client: PoolClient,
  input: { userId: string; key: string; requestHash: string }
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_body)
     VALUES ($1, $2, $3, 0, 'null'::jsonb)`,
    [input.userId, input.key, input.requestHash]
  );
}

export async function getIdempotencyKey(
  db: Db,
  userId: string,
  key: string
): Promise<IdempotencyRow | undefined> {
  const { rows } = await db.query<IdempotencyRow>(
    `SELECT user_id, key, request_hash, status_code, response_body, created_at
     FROM idempotency_keys
     WHERE user_id = $1 AND key = $2`,
    [userId, key]
  );
  return rows[0];
}

/** Stores the final response inside the same transaction, before COMMIT. */
export async function completeIdempotencyKey(
  client: PoolClient,
  input: { userId: string; key: string; statusCode: number; responseBody: unknown }
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET status_code = $3, response_body = $4::jsonb
     WHERE user_id = $1 AND key = $2`,
    [input.userId, input.key, input.statusCode, JSON.stringify(input.responseBody)]
  );
}
