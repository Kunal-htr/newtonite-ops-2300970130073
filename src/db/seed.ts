import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool, tx } from './pool';

/**
 * Demo seed: 4 teams, 10 users (viewer/member/lead/admin coverage,
 * including cross-team users with different roles) and 5000 work items
 * spread across teams, types, priorities and statuses.
 *
 * Re-seed guard (confirmed approach): the whole seed runs in one transaction.
 * It takes a transaction-scoped advisory lock, then skips if the users table
 * already has rows - so `docker compose up` never seeds twice, and concurrent
 * container starts cannot double-insert.
 */

const DEMO_PASSWORD = 'demo-password-123';
const BCRYPT_ROUNDS = 10;
const BATCH_SIZE = 500;
const ITEM_COUNT = 5000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type TeamName = 'Platform' | 'Payments' | 'Support' | 'Compliance';
type Role = 'viewer' | 'member' | 'lead' | 'admin';

const TEAMS: TeamName[] = ['Platform', 'Payments', 'Support', 'Compliance'];

interface SeedUser {
  email: string;
  name: string;
  memberships: Array<{ team: TeamName; role: Role }>;
}

const USERS: SeedUser[] = [
  {
    email: 'ada.admin@demo.newtonite.dev',
    name: 'Ada Admin',
    memberships: [
      { team: 'Platform', role: 'admin' },
      { team: 'Payments', role: 'admin' },
      { team: 'Support', role: 'admin' },
      { team: 'Compliance', role: 'admin' },
    ],
  },
  // Cross-team user #1: Lead in Platform, Member in Payments.
  {
    email: 'liam.lead@demo.newtonite.dev',
    name: 'Liam Lead',
    memberships: [
      { team: 'Platform', role: 'lead' },
      { team: 'Payments', role: 'member' },
    ],
  },
  { email: 'luna.lead@demo.newtonite.dev', name: 'Luna Lead', memberships: [{ team: 'Payments', role: 'lead' }] },
  { email: 'nora.lead@demo.newtonite.dev', name: 'Nora Lead', memberships: [{ team: 'Support', role: 'lead' }] },
  { email: 'leo.lead@demo.newtonite.dev', name: 'Leo Lead', memberships: [{ team: 'Compliance', role: 'lead' }] },
  { email: 'maria.member@demo.newtonite.dev', name: 'Maria Member', memberships: [{ team: 'Platform', role: 'member' }] },
  { email: 'marco.member@demo.newtonite.dev', name: 'Marco Member', memberships: [{ team: 'Payments', role: 'member' }] },
  { email: 'mia.member@demo.newtonite.dev', name: 'Mia Member', memberships: [{ team: 'Support', role: 'member' }] },
  { email: 'victor.viewer@demo.newtonite.dev', name: 'Victor Viewer', memberships: [{ team: 'Platform', role: 'viewer' }] },
  // Cross-team user #2: Viewer in Compliance, Member in Support.
  {
    email: 'vera.viewer@demo.newtonite.dev',
    name: 'Vera Viewer',
    memberships: [
      { team: 'Compliance', role: 'viewer' },
      { team: 'Support', role: 'member' },
    ],
  },
];

const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'] as const;
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
// Weighted round-robin: OPEN x3, IN_PROGRESS x3, AWAITING_APPROVAL x1, RESOLVED x2, CLOSED x1.
const STATUS_POOL = [
  'OPEN',
  'OPEN',
  'OPEN',
  'IN_PROGRESS',
  'IN_PROGRESS',
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RESOLVED',
  'RESOLVED',
  'CLOSED',
] as const;

const TITLE_SUBJECTS = [
  'Payment reconciliation failure',
  'Login timeout spike',
  'Customer refund request',
  'Compliance audit export',
  'Data sync lag',
  'Invoice PDF not rendering',
  'SSO login loop',
  'Duplicate charge report',
  'Webhook retries exhausted',
  'Slow dashboard queries',
];

const ITEM_COLUMNS = [
  'id',
  'title',
  'description',
  'type',
  'priority',
  'status',
  'team_id',
  'assignee_id',
  'created_by',
  'due_date',
  'version',
  'created_at',
  'updated_at',
];

/** One multi-row INSERT; caller decides the batch size. Table/column names are internal constants. */
async function bulkInsert(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
}

async function main(): Promise<void> {
  // Hash once; every demo user shares the same password.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);

  const teamIds = new Map<TeamName, string>();
  for (const team of TEAMS) teamIds.set(team, randomUUID());
  const userIds = new Map<string, string>();
  for (const user of USERS) userIds.set(user.email, randomUUID());

  // Members eligible to be assignee/creator per team (viewers excluded - they cannot create or claim).
  const eligibleByTeam = new Map<TeamName, Array<{ id: string; name: string }>>();
  for (const team of TEAMS) eligibleByTeam.set(team, []);
  for (const user of USERS) {
    for (const membership of user.memberships) {
      if (membership.role === 'viewer') continue;
      eligibleByTeam.get(membership.team)!.push({ id: userIds.get(user.email)!, name: user.name });
    }
  }

  const now = Date.now();
  const items: unknown[][] = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    const team = TEAMS[Math.floor(i / 10) % TEAMS.length];
    const eligible = eligibleByTeam.get(team)!;
    const type = TYPES[i % TYPES.length];
    const priority = PRIORITIES[i % PRIORITIES.length];
    const status = STATUS_POOL[i % STATUS_POOL.length];
    // ~36% unassigned; i % 7 === 0 also hits urgent rows (i % 4 === 3), so every team
    // has unassigned urgent OPEN/IN_PROGRESS rows for the "Unassigned urgent" view.
    const unassigned = i % 4 === 0 || i % 7 === 0;
    const assignee = unassigned ? null : eligible[i % eligible.length];
    const creator = eligible[(i * 3 + 1) % eligible.length];

    const createdAt = new Date(now - ((i * 89) % 2160) * HOUR); // spread over ~90 days
    const updatedAt = new Date(Math.min(createdAt.getTime() + ((i * 13) % 336) * HOUR, now));
    const dueDate = i % 5 === 0 ? null : new Date(now + (((i * 7) % 45) - 15) * DAY); // some overdue

    items.push([
      randomUUID(),
      `${TITLE_SUBJECTS[i % TITLE_SUBJECTS.length]} (#${1000 + i})`,
      `Seeded demo item ${i + 1}/${ITEM_COUNT}: ${type} for the ${team} team, reported by ${creator.name}.`,
      type,
      priority,
      status,
      teamIds.get(team)!,
      assignee ? assignee.id : null,
      creator.id,
      dueDate,
      1 + (i % 4),
      createdAt,
      updatedAt,
    ]);
  }

  const membershipRows: unknown[][] = [];
  for (const user of USERS) {
    for (const membership of user.memberships) {
      membershipRows.push([userIds.get(user.email)!, teamIds.get(membership.team)!, membership.role]);
    }
  }

  let skipped = false;

  await tx(async (client) => {
    // Re-seed guard (Task 9, Option A): serialise concurrent seeders, then skip
    // if already seeded. "Any row in users" is a reliable completion marker
    // because the whole seed commits or rolls back as one transaction.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('newtonite_ops_seed'))`);
    const { rows } = await client.query<{ seeded: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS seeded');
    if (rows[0].seeded) {
      skipped = true;
      return;
    }

    await bulkInsert(
      client,
      'teams',
      ['id', 'name'],
      TEAMS.map((team) => [teamIds.get(team)!, team])
    );

    await bulkInsert(
      client,
      'users',
      ['id', 'email', 'name', 'password_hash'],
      USERS.map((user) => [userIds.get(user.email)!, user.email, user.name, passwordHash])
    );

    await bulkInsert(client, 'memberships', ['user_id', 'team_id', 'role'], membershipRows);

    // 5000 items in batches of 500 (10 statements, one transaction).
    for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
      await bulkInsert(client, 'work_items', ITEM_COLUMNS, items.slice(offset, offset + BATCH_SIZE));
    }
  });

  if (skipped) {
    console.log('Database already seeded (found existing rows in users); skipping.');
    console.log('To force a re-seed: docker compose down -v, then docker compose up.');
  } else {
    console.log('Seed complete:');
    console.log(`  teams:       ${TEAMS.length}`);
    console.log(`  users:       ${USERS.length}`);
    console.log(`  memberships: ${membershipRows.length}`);
    console.log(`  work_items:  ${items.length}`);
  }
  console.log('');
  console.log('Demo logins (every account shares the same password):');
  for (const user of USERS) {
    const roles = user.memberships.map((m) => `${m.role} in ${m.team}`).join(', ');
    console.log(`  ${user.email.padEnd(34)} ${roles}`);
  }
  console.log('');
  console.log(`Shared demo password: ${DEMO_PASSWORD}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exitCode = 1;
  });
