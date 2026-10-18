import type { PoolClient } from 'pg';
import { pool, tx } from './db/pool';

/**
 * Outbox worker (module M4): same codebase, own process (docker compose
 * service `worker`, command `npm run worker`).
 *
 * Lifecycle per job: claim (status=processing, locked_at=now) -> run handler ->
 * status=done. On handler error: attempts+1, last_error, run_at = now() +
 * 2^attempts seconds, and status=failed once attempts reaches max_attempts.
 * A job stranded in 'processing' by a crashed worker is reclaimed once its
 * lease is older than PROCESSING_TIMEOUT_MS. The API never depends on this
 * process; polling errors are logged and retried, never fatal.
 */

interface OutboxJob {
  id: string; // bigint, returned as string by pg
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/** Stale 'processing' lease (crashed worker) -> job becomes claimable again. */
const PROCESSING_TIMEOUT_MS = 5 * 60_000;
const IDLE_SLEEP_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Handlers --------------------------------------------------------------

type Handler = (client: PoolClient, payload: unknown) => Promise<void>;

/**
 * NOTIFY_ASSIGNEE: exactly one notification per assignment event. The dedupe
 * key makes re-processing (reclaim or retry) a no-op for the notification.
 */
export async function notifyAssignee(client: PoolClient, payload: unknown): Promise<void> {
  const { item_id, assignee_id, event_id } = payload as {
    item_id?: string;
    assignee_id?: string;
    event_id?: string;
  };
  if (!item_id || !assignee_id || !event_id) {
    throw new Error('NOTIFY_ASSIGNEE payload must include item_id, assignee_id, event_id');
  }
  await client.query(
    `INSERT INTO notifications (user_id, item_id, dedupe_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [assignee_id, item_id, `assign:${event_id}`]
  );
}

const HANDLERS: Record<string, Handler> = {
  NOTIFY_ASSIGNEE: notifyAssignee,
};

// ---- Job lifecycle ---------------------------------------------------------

/**
 * Claims the next due job: a pending job whose run_at has passed, or a
 * processing job whose lease expired. FOR UPDATE SKIP LOCKED plus the
 * committed status change keep concurrent workers off the same row.
 */
async function claimNextJob(): Promise<OutboxJob | undefined> {
  return tx(async (client) => {
    const { rows } = await client.query<OutboxJob>(
      `SELECT id, type, payload, attempts, max_attempts
       FROM outbox_jobs
       WHERE (status = 'pending' AND run_at <= now())
          OR (status = 'processing' AND locked_at <= now() - ($1::int * interval '1 millisecond'))
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [PROCESSING_TIMEOUT_MS]
    );
    const job = rows[0];
    if (!job) return undefined;
    await client.query(`UPDATE outbox_jobs SET status = 'processing', locked_at = now() WHERE id = $1`, [job.id]);
    return job;
  });
}

/** Runs the handler and marks the job done in one transaction. */
async function runJob(job: OutboxJob): Promise<void> {
  const handler = HANDLERS[job.type];
  if (!handler) throw new Error(`Unknown job type: ${job.type}`);

  await tx(async (client) => {
    await handler(client, job.payload);
    await client.query(`UPDATE outbox_jobs SET status = 'done', locked_at = NULL WHERE id = $1`, [job.id]);
  });
}

/** Records a failed attempt: attempts+1, last_error, backoff; failed at max. */
async function failJob(job: OutboxJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const nextAttempts = job.attempts + 1;
  const backoffSeconds = 2 ** nextAttempts; // 2s, 4s, 8s, ...

  await pool.query(
    `UPDATE outbox_jobs
     SET attempts = $2,
         last_error = $3,
         status = CASE WHEN $2 >= max_attempts THEN 'failed' ELSE 'pending' END,
         run_at = now() + ($4::int * interval '1 second'),
         locked_at = NULL
     WHERE id = $1`,
    [job.id, nextAttempts, message, backoffSeconds]
  );
}

// ---- Loop ------------------------------------------------------------------

let stopping = false;

/** Claims and runs one job. Returns false when the queue is empty. */
export async function processOne(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;

  console.log(`job ${job.id} (${job.type}) attempt ${job.attempts + 1}`);
  try {
    await runJob(job);
    console.log(`job ${job.id} done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`job ${job.id} failed: ${message}`);
    await failJob(job, err);
  }
  return true;
}

async function main(): Promise<void> {
  console.log(`outbox worker started (lease timeout ${PROCESSING_TIMEOUT_MS / 60_000} min)`);
  while (!stopping) {
    try {
      const worked = await processOne();
      if (!worked && !stopping) await sleep(IDLE_SLEEP_MS);
    } catch (err) {
      // Transient DB errors (startup race, connection blip) must not kill the worker.
      console.error('worker poll error:', err);
      if (!stopping) await sleep(IDLE_SLEEP_MS);
    }
  }
  await pool.end();
  console.log('outbox worker stopped');
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received: finishing current job, then exiting`);
}

// Only run the polling loop when this file is the process entry point
// (node dist/worker.js). Importing the module -- e.g. from tests that call
// processOne() directly -- must have zero side effects: no timers, no signal
// handlers, no pool shutdown.
if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
}
