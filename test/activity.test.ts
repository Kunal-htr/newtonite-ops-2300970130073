import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import { pool } from '../src/db/pool';
import {
  authHeader,
  countEvents,
  createItem,
  createTeam,
  createUser,
  getEvents,
  type ItemRecord,
  type TestUser,
} from './helpers';

/**
 * Behaviour: every state, owner and priority change writes exactly one
 * activity event (with old and new values) in the same transaction as the
 * change, and the table is append-only by database trigger.
 */
describe('activity log', () => {
  let teamId: string;
  let lead: TestUser;
  let member: TestUser;
  let item: ItemRecord;

  beforeAll(async () => {
    teamId = await createTeam('Activity Team');
    lead = await createUser('activity-lead@test.local', [{ teamId, role: 'lead' }]);
    member = await createUser('activity-member@test.local', [{ teamId, role: 'member' }]);
    item = await createItem({ teamId, createdBy: lead.id, priority: 'low' });
  });

  it('records priority, owner and status changes with correct old and new values, in order', async () => {
    // Each request carries the version it is based on: 1 -> 2 -> 3 -> 4 -> 5.
    await request(app)
      .patch(`/items/${item.id}`)
      .set(authHeader(lead.token))
      .send({ version: 1, priority: 'high' })
      .expect(200);
    await request(app)
      .post(`/items/${item.id}/assign`)
      .set(authHeader(lead.token))
      .send({ version: 2, assignee_id: member.id })
      .expect(200);
    await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(lead.token))
      .send({ version: 3, to: 'IN_PROGRESS' })
      .expect(200);
    await request(app)
      .post(`/items/${item.id}/transition`)
      .set(authHeader(lead.token))
      .send({ version: 4, to: 'AWAITING_APPROVAL' })
      .expect(200);

    const events = await getEvents(item.id);
    expect(events.map((event) => event.type)).toEqual([
      'FIELD_CHANGED',
      'ASSIGNED',
      'STATUS_CHANGED',
      'STATUS_CHANGED',
    ]);
    expect(events[0].payload).toEqual({ field: 'priority', from: 'low', to: 'high' });
    expect(events[1].payload).toEqual({ from: null, to: member.id });
    expect(events[2].payload).toEqual({ from: 'OPEN', to: 'IN_PROGRESS' });
    expect(events[3].payload).toEqual({ from: 'IN_PROGRESS', to: 'AWAITING_APPROVAL' });
    for (const event of events) {
      expect(event.actor_id).toBe(lead.id);
    }
  });

  it('is append-only: UPDATE and DELETE are rejected by a database trigger', async () => {
    const fresh = await createItem({ teamId, createdBy: lead.id, title: 'Append-only item' });
    await request(app)
      .patch(`/items/${fresh.id}`)
      .set(authHeader(lead.token))
      .send({ version: 1, title: 'Renamed item' })
      .expect(200);

    const events = await getEvents(fresh.id);
    expect(events).toHaveLength(1);

    await expect(
      pool.query('UPDATE activity_events SET type = $1 WHERE id = $2', ['TAMPERED', events[0].id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM activity_events WHERE id = $1', [events[0].id])).rejects.toThrow(
      /append-only/,
    );

    // The rejected statements changed nothing.
    const after = await getEvents(fresh.id);
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('FIELD_CHANGED');
    expect(await countEvents(fresh.id)).toBe(1);
  });
});
