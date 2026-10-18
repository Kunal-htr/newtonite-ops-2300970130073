import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import { pool } from '../src/db/pool';
import {
  authHeader,
  createItem,
  createTeam,
  createUser,
  getEvents,
  getItem,
  type ItemRecord,
  type TestUser,
} from './helpers';

/**
 * Behaviour: claiming is decided by a single guarded UPDATE, so any number of
 * parallel claims still produces exactly one assignee, one CLAIMED event and
 * one outbox job (the losers get 409 ALREADY_CLAIMED with the latest item).
 */
describe('concurrent claims', () => {
  let claimants: TestUser[];
  let item: ItemRecord;

  beforeAll(async () => {
    const teamId = await createTeam('Claim Team');
    const creator = await createUser('claim-creator@test.local', [{ teamId, role: 'member' }]);
    item = await createItem({ teamId, createdBy: creator.id });
    claimants = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createUser(`claim-${index}@test.local`, [{ teamId, role: 'member' }]),
      ),
    );
  });

  it('10 parallel claims: exactly one winner, nine 409 ALREADY_CLAIMED, one event, one outbox job', async () => {
    const responses = await Promise.all(
      claimants.map((user) =>
        request(app).post(`/items/${item.id}/claim`).set(authHeader(user.token)),
      ),
    );

    const winners = responses.filter((response) => response.status === 200);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const conflict of conflicts) {
      expect(conflict.body.error.code).toBe('ALREADY_CLAIMED');
      expect(conflict.body.item).toBeDefined();
    }

    const winner = claimants[responses.indexOf(winners[0])];

    // Database state: the winner owns the item, status moved, version bumped once.
    const stored = await getItem(item.id);
    expect(stored.assignee_id).toBe(winner.id);
    expect(stored.status).toBe('IN_PROGRESS');
    expect(stored.version).toBe(2);

    // Exactly one CLAIMED event plus the single OPEN -> IN_PROGRESS event.
    const events = await getEvents(item.id);
    expect(events.map((event) => event.type)).toEqual(['CLAIMED', 'STATUS_CHANGED']);
    expect(events[0].payload).toEqual({ assigneeId: winner.id });
    expect(events[1].payload).toEqual({ from: 'OPEN', to: 'IN_PROGRESS' });

    // Exactly one outbox job, written in the same transaction as the claim.
    const jobs = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM outbox_jobs WHERE payload->>'item_id' = $1",
      [item.id],
    );
    expect(jobs.rows[0].count).toBe(1);
  });
});
