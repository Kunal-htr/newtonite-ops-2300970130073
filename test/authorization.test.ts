import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/server';
import {
  authHeader,
  countEvents,
  countItemsByTitle,
  createItem,
  createTeam,
  createUser,
  getItem,
  type ItemRecord,
  type TestUser,
} from './helpers';

/**
 * Behaviour: team scoping is part of every read and write, so a user outside
 * the item's team gets 404 (not 403: team membership must not leak) and
 * nothing is written; viewers are read-only. The list endpoint only ever
 * returns the caller's teams.
 */
describe('team authorization', () => {
  let teamA: string;
  let teamB: string;
  let userA: TestUser;
  let userB: TestUser;
  let viewerA: TestUser;
  let itemA: ItemRecord;
  let itemA2: ItemRecord;
  let itemB: ItemRecord;

  beforeAll(async () => {
    teamA = await createTeam('Auth Team A');
    teamB = await createTeam('Auth Team B');
    userA = await createUser('auth-user-a@test.local', [{ teamId: teamA, role: 'member' }]);
    userB = await createUser('auth-user-b@test.local', [{ teamId: teamB, role: 'member' }]);
    viewerA = await createUser('auth-viewer-a@test.local', [{ teamId: teamA, role: 'viewer' }]);
    itemA = await createItem({ teamId: teamA, createdBy: userA.id, title: 'Team A item' });
    itemA2 = await createItem({ teamId: teamA, createdBy: userA.id, title: 'Team A item 2' });
    itemB = await createItem({ teamId: teamB, createdBy: userB.id, title: 'Team B item' });
  });

  it('an outsider gets 404 on read and write, and nothing is written', async () => {
    const read = await request(app).get(`/items/${itemA.id}`).set(authHeader(userB.token)).expect(404);
    expect(read.body.error.code).toBe('NOT_FOUND');

    await request(app).post(`/items/${itemA.id}/claim`).set(authHeader(userB.token)).expect(404);
    await request(app)
      .patch(`/items/${itemA.id}`)
      .set(authHeader(userB.token))
      .send({ version: itemA.version, title: 'Outsider edit' })
      .expect(404);
    await request(app)
      .post(`/items/${itemA.id}/comments`)
      .set(authHeader(userB.token))
      .set('Idempotency-Key', randomUUID())
      .send({ text: 'Outsider comment' })
      .expect(404);

    const stored = await getItem(itemA.id);
    expect(stored.title).toBe('Team A item');
    expect(stored.assignee_id).toBeNull();
    expect(await countEvents(itemA.id)).toBe(0);
  });

  it("lists only the caller's teams, and a foreign team filter yields nothing", async () => {
    const list = await request(app).get('/items').set(authHeader(userA.token)).expect(200);
    const ids = (list.body.items as Array<{ id: string; teamId: string }>).map((entry) => entry.id);
    expect(ids).toContain(itemA.id);
    expect(ids).toContain(itemA2.id);
    expect(ids).not.toContain(itemB.id);
    for (const entry of list.body.items as Array<{ teamId: string }>) {
      expect(entry.teamId).toBe(teamA);
    }

    const filtered = await request(app)
      .get(`/items?team=${teamB}`)
      .set(authHeader(userA.token))
      .expect(200);
    expect(filtered.body.items).toHaveLength(0);
  });

  it('a viewer cannot create or claim', async () => {
    const create = await request(app)
      .post('/items')
      .set(authHeader(viewerA.token))
      .set('Idempotency-Key', randomUUID())
      .send({ title: 'Viewer item', type: 'task', priority: 'low', team_id: teamA })
      .expect(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(await countItemsByTitle('Viewer item')).toBe(0);

    const claim = await request(app)
      .post(`/items/${itemA2.id}/claim`)
      .set(authHeader(viewerA.token))
      .expect(403);
    expect(claim.body.error.code).toBe('FORBIDDEN');

    const stored = await getItem(itemA2.id);
    expect(stored.assignee_id).toBeNull();
    expect(stored.status).toBe('OPEN');
    expect(await countEvents(itemA2.id)).toBe(0);
  });
});
