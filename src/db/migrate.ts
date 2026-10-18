import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pool } from './pool';

/**
 * Minimal raw-SQL migration runner.
 * - Applies src/db/migrations/*.sql in filename order.
 * - Records each applied file in `schema_migrations` and skips files already recorded.
 * - Each file runs in its own transaction: BEGIN -> file SQL -> record -> COMMIT.
 * - A Postgres advisory lock serialises concurrent runners (e.g. multiple api replicas).
 */

const MIGRATIONS_DIR_CANDIDATES = [
  join(__dirname, 'migrations'), // tsx (src/db) or node dist/db (Dockerfile copies migrations next to dist/db)
  resolve(process.cwd(), 'src/db/migrations'),
];

const LOCK_NAME = 'newtonite_ops_schema_migrations';

function findMigrationsDir(): string {
  for (const dir of MIGRATIONS_DIR_CANDIDATES) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`Migrations directory not found. Tried: ${MIGRATIONS_DIR_CANDIDATES.join(', ')}`);
}

async function runMigrations(): Promise<void> {
  const dir = findMigrationsDir();
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.name));

    for (const file of files) {
      if (alreadyApplied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration failed: ${file}`, { cause: err });
      }
      console.log(`apply ${file}`);
      applied += 1;
    }

    console.log(`Migrations complete: ${applied} applied, ${files.length - applied} skipped of ${files.length}.`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]).catch(() => undefined);
    client.release();
  }
}

runMigrations()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exitCode = 1;
  });
