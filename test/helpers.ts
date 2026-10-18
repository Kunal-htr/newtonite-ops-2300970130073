/**
 * Shared fixtures for the integration suite. Where it matters, code goes
 * through the real application surface (login, HTTP); users/teams/items are
 * seeded with plain SQL because there is no public registration endpoint.
 */
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/server';
import { pool } from '../src/db/pool';

// Guard against the one catastrophic misconfiguration: the bootstrap in
// test/setup.ts (which repoints DATABASE_URL at the test database) must have
// executed before any application module was imported. If it did not, these
// helpers would happily write fixtures into the development database.
if (process.env.VITEST_TEST_DB_READY !== '1') {
  throw new Error('test/setup.ts did not run before the test helpers were imported');
}

export const TEST_PASSWORD = 'test-password-123';

export type TestRole = 'admin' | 'lead' | 'member' | 'viewer';

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface ItemRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  version: number;
  team_id: string;
  assignee_id: string | null;
  created_by: string;
}

export interface EventRecord {
  id: string; // bigint, returned as string by pg
  type: string;
  actor_id: string;
  payload: Record<string, unknown>;
}

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export async function createTeam(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

/** Inserts a user (bcrypt cost 4: test speed) + memberships, then logs in via the real endpoint. */
export async function createUser(
  email: string,
  memberships: Array<{ teamId: string; role: TestRole }>,
): Promise<TestUser> {
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, email, passwordHash],
  );
  const id = rows[0].id;
  for (const membership of memberships) {
    await pool.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)', [
      id,
      membership.teamId,
      membership.role,
    ]);
  }
  return { id, email, token: await login(email) };
}

/** Token via the real login endpoint (exercises POST /auth/login in every file). */
export async function login(email: string): Promise<string> {
  const response = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD }).expect(200);
  return response.body.token as string;
}

export interface CreateItemInput {
  teamId: string;
  createdBy: string;
  title?: string;
  description?: string | null;
  priority?: string;
  status?: string;
  assigneeId?: string | null;
}

export async function createItem(input: CreateItemInput): Promise<ItemRecord> {
  const { rows } = await pool.query<ItemRecord>(
    `INSERT INTO work_items (title, description, type, priority, status, team_id, assignee_id, created_by)
     VALUES ($1, $2, 'task', $3, $4, $5, $6, $7)
     RETURNING id, title, status, priority, version, team_id, assignee_id, created_by`,
    [
      input.title ?? 'Test item',
      input.description ?? null,
      input.priority ?? 'medium',
      input.status ?? 'OPEN',
      input.teamId,
      input.assigneeId ?? null,
      input.createdBy,
    ],
  );
  return rows[0];
}

export async function getItem(itemId: string): Promise<ItemRecord> {
  const { rows } = await pool.query<ItemRecord>(
    `SELECT id, title, status, priority, version, team_id, assignee_id, created_by
     FROM work_items WHERE id = $1`,
    [itemId],
  );
  return rows[0];
}

export async function getEvents(itemId: string): Promise<EventRecord[]> {
  const { rows } = await pool.query<EventRecord>(
    'SELECT id, type, actor_id, payload FROM activity_events WHERE item_id = $1 ORDER BY id',
    [itemId],
  );
  return rows;
}

export async function countEvents(itemId: string, type?: string): Promise<number> {
  const { rows } = type
    ? await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM activity_events WHERE item_id = $1 AND type = $2',
        [itemId, type],
      )
    : await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM activity_events WHERE item_id = $1',
        [itemId],
      );
  return rows[0].count;
}

export async function countItemsByTitle(title: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM work_items WHERE title = $1',
    [title],
  );
  return rows[0].count;
}
