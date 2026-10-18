# Newtonite Ops — System Design Document

**Date:** Oct 18, 2026

## Architecture Overview

```
Browser (React + Vite, TanStack Query)
  |  HTTPS / JSON, Bearer JWT, Idempotency-Key on POST
  v
API (Node + Express + TypeScript)
  |  routes -> services -> repositories (raw SQL via pg)
  |  one transaction per write: item change + activity event + outbox row
  v
PostgreSQL <---- Worker (same codebase, own process) polls outbox_jobs with FOR UPDATE SKIP LOCKED
```

Everything runs from one `docker compose up`.

## Frontend Architecture

A thin React + Vite single-page app with plain CSS. Holds no business rules; every permission and workflow decision is made by the server, and the UI only reflects what the server allows.

**Pages:** Login, Dashboard (tabs: Assigned to me, Unassigned urgent, Awaiting my approval), Item list with filters and search, Item detail with activity timeline and comment box.

**Data fetching:** TanStack Query. Lists use cursor pagination with a "Load more" button, refetch on window focus and every 15 seconds on the dashboard (polling replaces websockets).

**API client:** One fetch wrapper that attaches the JWT, sends a fresh Idempotency-Key UUID per create or transition click, and turns 409 and 403 responses into typed errors.

**Conflict handling:** On a 409 version conflict the UI shows "This item changed, reload" and refetches the item. No optimistic updates.

**Buttons:** Actions shown/hidden using the `allowedActions` array the server returns with each item — never computed in the browser.

## Backend Architecture

Three layers with strict direction: routes parse and validate input, services hold rules and run transactions, repositories hold SQL. Routes never touch SQL, repositories never check permissions.

```
src/
  server.ts          app bootstrap
  worker.ts          outbox worker entry
  config.ts          env parsing (fail fast)
  db/
    pool.ts, tx() helper
    migrations/*.sql
    seed.ts
  auth/              login, JWT middleware, password hashing
  authz/
    can.ts           <- the ONLY permission check
  items/
    routes.ts
    service.ts
    repository.ts
    workflow.ts
  activity/          append-only event writer
  outbox/            enqueue(), worker loop, handlers
  middleware/        idempotency, error handler, validation (zod)
  tests/             api tests against a real Postgres
```

**`tx(fn)` helper:** Opens a transaction, runs `fn(client)`, commits or rolls back. Every write path uses it, so the item change, activity event and outbox row commit or fail together.

**`workflow.ts`:** A plain map of allowed transitions plus the role required for each. The service reads it; nothing else encodes workflow rules.

**Errors:** Typed errors (`NotFound`, `Forbidden`, `Conflict`, `Invalid`) mapped to status codes in one handler.

**Validation:** Zod schemas on every request body and query string.

## Database Schema

Eight tables. Enums are **text columns with CHECK constraints** (easier to migrate than Postgres enum types). Comments are stored as activity events of type `COMMENTED` — no separate comments table.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | `id uuid`, `email unique`, `name`, `password_hash` | Seeded; no sign-up |
| `teams` | `id uuid`, `name` | 4 seeded |
| `memberships` | `user_id`, `team_id`, `role` | PK `(user_id, team_id)`; role CHECK in `(viewer, member, lead, admin)` |
| `work_items` | `id uuid`, `title`, `description`, `type`, `priority`, `status`, `team_id`, `assignee_id null`, `created_by`, `due_date`, `version int default 1`, `created_at`, `updated_at` | CHECK constraints on type, priority, status |
| `activity_events` | `id bigserial`, `item_id`, `actor_id`, `type`, `payload jsonb`, `created_at` | Append-only: a trigger raises on UPDATE and DELETE |
| `idempotency_keys` | `user_id`, `key`, `request_hash`, `status_code`, `response_body jsonb`, `created_at` | PK `(user_id, key)` |
| `outbox_jobs` | `id bigserial`, `type`, `payload jsonb`, `status`, `attempts`, `max_attempts default 5`, `run_at`, `last_error`, `created_at` | status: pending, processing, done, failed |
| `notifications` | `id`, `user_id`, `item_id`, `dedupe_key unique`, `created_at` | Written by the idempotent job handler |

## Indexes

1. `work_items (team_id, status, created_at DESC, id DESC)` — filtered list + keyset pagination
2. Partial `work_items (assignee_id, updated_at DESC) WHERE status <> 'CLOSED'` — "Assigned to me"
3. Partial `work_items (team_id, created_at DESC) WHERE assignee_id IS NULL AND priority = 'urgent' AND status IN ('OPEN','IN_PROGRESS')` — "Unassigned urgent"
4. Partial `work_items (team_id, updated_at DESC) WHERE status = 'AWAITING_APPROVAL'` — approvals
5. GIN trigram on `work_items.title` (`pg_trgm`) — search
6. `activity_events (item_id, id DESC)` — timeline
7. `outbox_jobs (run_at) WHERE status = 'pending'` — worker poll

**Pagination:** Keyset on `(created_at, id)` with an opaque base64 cursor. **No OFFSET.**

## Authentication and Authorization

1. `POST /auth/login` → bcrypt compare → HS256 JWT (8h expiry), payload contains **only the user id**.
2. Browser stores token in memory + sessionStorage, sends as `Authorization: Bearer`.
3. Auth middleware verifies token, loads user's memberships from DB on **every request**.
4. Roles are NOT in the token — role change takes effect immediately.
5. Each endpoint calls `can(user, action, item)` → allow, or deny reason → 403 or 404.
6. List queries add `team_id = ANY($userTeamIds)` in SQL.

## Permission Matrix

| Action | Viewer | Member | Lead | Admin |
|--------|--------|--------|------|-------|
| Read items and activity | ✓ | ✓ | ✓ | ✓ |
| Create item, comment | — | ✓ | ✓ | ✓ |
| Edit fields | — | ✓ | ✓ | ✓ |
| Claim | — | ✓ | ✓ | ✓ |
| Move OPEN→IN_PROGRESS, IN_PROGRESS→AWAITING_APPROVAL | — | assignee only | ✓ | ✓ |
| Approve or reject (AWAITING_APPROVAL out) | — | — | ✓ (not own item) | — |
| Resolve to CLOSED | — | — | ✓ | ✓ |
| Reassign | — | — | ✓ | ✓ |

## API Structure

All routes except login require Bearer token. Errors: `{ "error": { "code": "...", "message": "..." } }`

| Method | Path | Purpose | Success | Failures |
|--------|------|---------|---------|---------|
| POST | `/auth/login` | Get a token | 200 | 401 |
| GET | `/me` | Current user and team roles | 200 | 401 |
| GET | `/items` | List with filters + cursor | 200 | 400, 401 |
| POST | `/items` | Create (needs `Idempotency-Key`) | 201 | 400, 403, 422 |
| GET | `/items/:id` | Detail with `allowedActions` | 200 | 404 |
| PATCH | `/items/:id` | Edit fields, body includes `version` | 200 | 400, 403, 404, 409 |
| POST | `/items/:id/claim` | Atomic claim | 200 | 403, 404, 409 |
| POST | `/items/:id/transition` | Body: `to`, `version` | 200 | 403, 404, 409, 422 |
| POST | `/items/:id/assign` | Lead reassigns, body includes `version` | 200 | 403, 404, 409 |
| GET | `/items/:id/activity` | Paginated timeline | 200 | 404 |
| POST | `/items/:id/comments` | Add comment (needs `Idempotency-Key`) | 201 | 400, 403, 404 |

Dashboard views: `GET /items?view=assigned_to_me`, `view=unassigned_urgent`, `view=awaiting_my_approval`.

**Status code semantics:**
- `409` — state or version conflict
- `422` — valid JSON but breaks a workflow rule
- `403` — role failure
- `404` — not found OR "not your team" (existence not revealed)
- On `409` version conflict, body includes the latest item.

## Critical Behaviours

| Behaviour | Design | Test |
|-----------|--------|------|
| Concurrent claim | `UPDATE work_items SET assignee_id=$1, version=version+1 WHERE id=$2 AND assignee_id IS NULL AND status IN ('OPEN','IN_PROGRESS') RETURNING *`. Zero rows → re-read: missing=404, else 409. Activity event in same tx. | 10 parallel claims → exactly one 200, nine 409, one activity event |
| Stale edit | `UPDATE ... WHERE id=$1 AND version=$2`, version incremented on success. Zero rows → 409 with latest item. | PATCH with old version → 409, row unchanged |
| Idempotency | Inside create tx, insert into `idempotency_keys` first. Unique violation → return stored response. Different `request_hash` under same key → 422. | Same key twice → one row, identical responses |
| Workflow rules | `workflow.ts` map of from/to/required-role. Transition does `UPDATE ... WHERE id=$1 AND version=$2 AND status=$3`. | OPEN→CLOSED=422; non-Lead approval=403; Lead self-approval=403 |
| Resource authorization | `can()` for single items, `team_id = ANY(...)` in every list query | Outsider gets 404 on read, 403/404 on write |
| Reliable async | Item change + activity event + outbox row `NOTIFY_ASSIGNEE` in one tx. Worker: `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, `failed` after `max_attempts`. Handler: `INSERT INTO notifications ... ON CONFLICT DO NOTHING`. | Handler run twice → one notification; throwing handler retries then fails |

**Single-writer rule:** The activity event is inserted by the same service function and same `tx()` as the change. There is no code path that updates an item outside that helper.

## Caching Strategy

**No server-side cache.** Correct indexes + keyset pagination answer every query in milliseconds. A cache adds stale-data risk.

- **Client:** TanStack Query, ~10s stale time, invalidates after mutations, refetches on focus.
- **HTTP:** `Cache-Control: no-store` on all API responses.
- **At 10× scale:** Read replicas for list queries, short-lived Redis for dashboard counts, search engine if trigram slows. Name these as next steps in discussion, not as built features.

## Deployment Strategy

**The graded deployment is local:** `docker compose up` must start Postgres, run migrations and seed, then start API, worker, and built frontend.

**Services in docker-compose:**
- `db` — postgres:16 with healthcheck
- `api` — waits for db healthy, runs migrations and seed, then serves
- `worker` — same image, different command
- Frontend served as static files by the API

**Config:** All settings via env vars. `.env.example` committed, no secrets in repo.

**Supabase (optional):** Point `DATABASE_URL` at the direct connection string. Do NOT use the transaction pooler for the worker.

**Azure (optional, last priority):** B1s VM with Docker only. Skip unless all else is done.

## Risks and Known Limitations

- **Time:** ~13 hours remain. If M3 not finished by early hours, cut M4, keep four critical behaviours.
- **Agent-written locking code:** Claim, version and idempotency queries are the ones you'll be asked to modify live. Read each one.
- **Idempotency in-flight:** Two identical requests arriving at once rely on the unique key insert blocking the second until the first commits. Test explicitly.
- **Polling, not push:** Dashboard is up to 15 seconds stale. State in Known Limitations.
- **Search:** Trigram on titles only, not descriptions.
- **No refresh tokens or rate limiting:** Single 8-hour JWT, no login throttling.
