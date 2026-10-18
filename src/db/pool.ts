import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { config } from '../config';

export const pool = new Pool({ connectionString: config.DATABASE_URL });

/**
 * Runs `fn` inside a single database transaction.
 * BEGIN -> fn(client) -> COMMIT, ROLLBACK + rethrow on error, always release.
 * Every write path uses this (SYSTEM_DESIGN.md "tx(fn) helper"), so an item
 * change, its activity event and its outbox row commit or fail together.
 */
export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection may already be broken; release() below returns/discards the client.
    }
    throw err;
  } finally {
    client.release();
  }
}
