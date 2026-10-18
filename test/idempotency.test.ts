import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/server';
import { authHeader, countEvents, countItemsByTitle, createTeam, createUser, type TestUser } from './helpers';

/**
 * Behaviour: POST /items is idempotent per (user, Idempotency-Key). The key
 * row is inserted inside the same transaction as the item; a duplicate key
 * replays the stored response, and a duplicate key with a different body is
 * rejected with 422 IDEMPOTENCY_CONFLICT.
 */
describe('create idempotency', () => {
  let teamId: string;
  let user: TestUser;

  beforeAll(async () => {
    teamId = await createTeam('Idempotency Team');
    user = await createUser('idempotency-user@test.local', [{ teamId, role: 'member' }]);
  });

  it('replays the same response for the same key and body (sequential)', async () => {
    const key = randomUUID();
    const payload = { title: 'Idempotent item', type: 'task', priority: 'high', team_id: teamId };

    const first = await request(app)
      .post('/items')
      .set(authHeader(user.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);
    const second = await request(app)
      .post('/items')
      .set(authHeader(user.token))
      .set('Idempotency-Key', key)
      .send(payload)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(await countItemsByTitle(payload.title)).toBe(1);
    expect(await countEvents(first.body.id as string, 'CREATED')).toBe(1);
  });

  it('two parallel requests with the same key create one item and share one id', async () => {
    const key = randomUUID();
    const payload = { title: 'Parallel item', type: 'task', priority: 'low', team_id: teamId };

    const [first, second] = await Promise.all([
      request(app).post('/items').set(authHeader(user.token)).set('Idempotency-Key', key).send(payload),
      request(app).post('/items').set(authHeader(user.token)).set('Idempotency-Key', key).send(payload),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).toBe(second.body.id);
    expect(await countItemsByTitle(payload.title)).toBe(1);
  });

  it('rejects the same key with a different body (422 IDEMPOTENCY_CONFLICT)', async () => {
    const key = randomUUID();
    await request(app)
      .post('/items')
      .set(authHeader(user.token))
      .set('Idempotency-Key', key)
      .send({ title: 'Original payload', type: 'task', priority: 'low', team_id: teamId })
      .expect(201);

    const conflict = await request(app)
      .post('/items')
      .set(authHeader(user.token))
      .set('Idempotency-Key', key)
      .send({ title: 'Different payload', type: 'task', priority: 'low', team_id: teamId })
      .expect(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');

    expect(await countItemsByTitle('Original payload')).toBe(1);
    expect(await countItemsByTitle('Different payload')).toBe(0);
  });
});
