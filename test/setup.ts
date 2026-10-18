/**
 * Per-test-file bootstrap. The suite runs against a real PostgreSQL server --
 * concurrency behaviour is database behaviour, so nothing is mocked.
 *
 * - Test database: TEST_DATABASE_URL if set, otherwise `<name>_test` derived
 *   from DATABASE_URL on the same server, created when missing.
 * - Every test file resets the schema (DROP SCHEMA public CASCADE / CREATE
 *   SCHEMA public) and re-applies src/db/migrations/*.sql, then ends the app
 *   pool in afterAll -- runs are independent and re-runnable.
 * - DATABASE_URL is pointed at the test database BEFORE any application
 *   module is imported (config.ts reads env at import time).
 */
import 'dotenv/config';
import { afterAll, beforeAll } from 'vitest';
import { Client } from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function resolveTestDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'Tests need a PostgreSQL connection: copy .env.example to .env (DATABASE_URL) ' +
        'or set TEST_DATABASE_URL.',
    );
  }

  const url = new URL(base);
  url.pathname = `${url.pathname}_test`;
  return url.toString();
}

const testDatabaseUrl = resolveTestDatabaseUrl();

// Synchronous: must happen before any application module reads config.ts.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.VITEST_TEST_DB_READY = '1';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'vitest-jwt-secret';

async function ensureDatabaseExists(): Promise<void> {
  const url = new URL(testDatabaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const adminUrl = new URL(testDatabaseUrl);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach the PostgreSQL server for tests (${url.host}): ${(err as Error).message}. ` +
        'Is it running? For the compose database: docker compose up -d db.',
    );
  }
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

async function resetSchemaAndMigrate(): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');

    const migrationsDir = join(process.cwd(), 'src', 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Test setup failed applying ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await ensureDatabaseExists();
  await resetSchemaAndMigrate();
});

afterAll(async () => {
  const { pool } = await import('../src/db/pool');
  await pool.end().catch(() => undefined);
});
