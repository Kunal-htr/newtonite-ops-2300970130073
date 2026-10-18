import { beforeAll, describe, expect, it } from 'vitest';
import { pool, tx } from '../src/db/pool';
import { enqueue } from '../src/outbox/enqueue';
import { notifyAssignee, processOne } from '../src/worker';
import { createItem, createTeam, createUser, type ItemRecord, type TestUser } from './helpers';

/**
 * Behaviour: the outbox worker turns NOTIFY_ASSIGNEE jobs into exactly one
 * notification per assignment event (dedupe key), a throwing handler retries
 * with backoff and ends 'failed' at max_attempts, and importing the worker
 * module has no side effects -- tests drive processOne() directly instead of
 * running a loop or sending signals.
 */

interface JobRow {
  status: string;
  attempts: number;
  last_error: string | null;
  run_at: Date;
  locked_at: Date | null;
}

async function getJob(jobId: string): Promise<JobRow> {
  const { rows } = await pool.query<JobRow>(
    'SELECT status, attempts, last_error, run_at, locked_at FROM outbox_jobs WHERE id = $1',
    [jobId],
  );
  return rows[0];
}

async function insertEvent(itemId: string, actorId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO activity_events (item_id, actor_id, type, payload)
     VALUES ($1, $2, 'CLAIMED', '{}'::jsonb)
     RETURNING id`,
    [itemId, actorId],
  );
  return rows[0].id;
}

describe('outbox worker', () => {
  let teamId: string;
  let user: TestUser;
  let item: ItemRecord;

  beforeAll(async () => {
    teamId = await createTeam('Outbox Team');
    user = await createUser('outbox-user@test.local', [{ teamId, role: 'member' }]);
    item = await createItem({ teamId, createdBy: user.id });
  });

  it('notifyAssignee run twice for the same event inserts exactly one notification', async () => {
    const eventId = await insertEvent(item.id, user.id);
    const payload = { item_id: item.id, assignee_id: user.id, event_id: eventId };

    await tx((client) => notifyAssignee(client, payload));
    await tx((client) => notifyAssignee(client, payload));

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE dedupe_key = $1',
      [`assign:${eventId}`],
    );
    expect(rows[0].count).toBe(1);
  });

  it('processOne drains queued jobs: both done, one notification per event', async () => {
    const eventId = await insertEvent(item.id, user.id);
    const payload = { item_id: item.id, assignee_id: user.id, event_id: eventId };

    await tx((client) => enqueue(client, 'NOTIFY_ASSIGNEE', payload));
    await tx((client) => enqueue(client, 'NOTIFY_ASSIGNEE', payload));

    expect(await processOne()).toBe(true);
    expect(await processOne()).toBe(true);
    expect(await processOne()).toBe(false); // queue drained: nothing left to claim

    const jobs = await pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM outbox_jobs ORDER BY id',
    );
    expect(jobs.rows.map((row) => row.status)).toEqual(['done', 'done']);
    expect(jobs.rows.map((row) => row.attempts)).toEqual([0, 0]);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE dedupe_key = $1',
      [`assign:${eventId}`],
    );
    expect(rows[0].count).toBe(1);
  });

  it('a throwing handler retries with backoff and ends failed at max_attempts', async () => {
    await tx((client) => enqueue(client, 'BOOM_HANDLER', {}));
    const { rows } = await pool.query<{ id: string }>(
      "UPDATE outbox_jobs SET max_attempts = 2 WHERE type = 'BOOM_HANDLER' RETURNING id",
    );
    const jobId = rows[0].id;

    expect(await processOne()).toBe(true); // first attempt: handler throws

    let job = await getJob(jobId);
    expect(job.status).toBe('pending'); // retry scheduled, not failed yet
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain('Unknown job type');
    expect(job.locked_at).toBeNull();
    expect(job.run_at.getTime()).toBeGreaterThan(Date.now()); // backoff (2^1 seconds)

    // Not due yet: nothing to claim, attempt count unchanged.
    expect(await processOne()).toBe(false);
    job = await getJob(jobId);
    expect(job.attempts).toBe(1);

    // Make the retry immediately due instead of sleeping two seconds.
    await pool.query('UPDATE outbox_jobs SET run_at = now() WHERE id = $1', [jobId]);
    expect(await processOne()).toBe(true); // second attempt: 2 >= max_attempts -> failed

    job = await getJob(jobId);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(job.last_error).toContain('Unknown job type');
    expect(job.locked_at).toBeNull();
  });
});
