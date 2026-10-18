import type { PoolClient } from 'pg';

/**
 * Transactional outbox: inserts a job with the caller's transaction client, so
 * the job and the item change (plus its activity event) commit or roll back
 * together. The worker process picks jobs up later (src/worker.ts).
 *
 * status/run_at use their column defaults: 'pending' and now().
 */
export async function enqueue(client: PoolClient, type: string, payload: unknown): Promise<void> {
  await client.query(
    `INSERT INTO outbox_jobs (type, payload)
     VALUES ($1, $2::jsonb)`,
    [type, JSON.stringify(payload)]
  );
}
