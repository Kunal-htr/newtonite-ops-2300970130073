import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import { authHeader, createItem, createTeam, createUser, getEvents, getItem } from './helpers';

/**
 * Behaviour: PATCH is a guarded UPDATE on (id, version). A request that still
 * carries the old version must be rejected with 409 VERSION_CONFLICT -- and
 * must have written nothing, including no activity event.
 */
describe('stale writes', () => {
  it('a PATCH with an old version is rejected and the row is untouched', async () => {
    const teamId = await createTeam('Stale Team');
    const lead = await createUser('stale-lead@test.local', [{ teamId, role: 'lead' }]);
    const item = await createItem({ teamId, createdBy: lead.id, title: 'Original title' });

    // First edit succeeds: version 1 -> 2.
    const first = await request(app)
      .patch(`/items/${item.id}`)
      .set(authHeader(lead.token))
      .send({ version: item.version, title: 'First edit' })
      .expect(200);
    expect(first.body.version).toBe(2);

    // Second edit still carries the base version 1: rejected without writing.
    const second = await request(app)
      .patch(`/items/${item.id}`)
      .set(authHeader(lead.token))
      .send({ version: item.version, title: 'Stale edit' })
      .expect(409);
    expect(second.body.error.code).toBe('VERSION_CONFLICT');
    expect(second.body.item.title).toBe('First edit');
    expect(second.body.item.version).toBe(2);

    const stored = await getItem(item.id);
    expect(stored.title).toBe('First edit');
    expect(stored.version).toBe(2);

    // Only the successful edit produced an event, with correct from/to values.
    const events = await getEvents(item.id);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('FIELD_CHANGED');
    expect(events[0].payload).toEqual({ field: 'title', from: 'Original title', to: 'First edit' });
  });
});
