# Engineering Decisions

ADR-style notes for the five decisions that shape this codebase: context,
options considered, the choice, and the trade-off accepted.

## 1. Claim is a conditional UPDATE, not SELECT ... FOR UPDATE

**Context.** Two members clicking "Claim" at the same moment must yield exactly
one assignee, one CLAIMED event and one outbox job.

**Options.** (a) `SELECT ... FOR UPDATE`, check in code, then UPDATE; (b) a
single `UPDATE ... WHERE assignee_id IS NULL AND status IN ('OPEN','IN_PROGRESS')`
whose row count decides the outcome; (c) an advisory lock or a partial unique
index on the assignee column.

**Choice.** (b). The state precondition lives in the WHERE clause
(`updateItemClaim` in `src/items/repository.ts`). A 0-row result is re-read
only to classify the conflict (`ALREADY_CLAIMED` vs `NOT_CLAIMABLE`) and
returns 409 with the latest item.

**Trade-off.** Classifying the conflict costs one extra read, and the guard is
written in SQL rather than code. In exchange no lock is held between
statements, there is no read-then-write window, and every write in the system
has the same shape. Proven by `test/claim.concurrent.test.ts`: ten parallel
claims, one winner.

## 2. Optimistic locking with a version column

**Context.** Users keep an item open while someone else edits it; silently
overwriting is worse than rejecting.

**Options.** pessimistic locks at read time; `If-Match`/ETag headers; a
`version` integer sent with every write.

**Choice.** Every write is a guarded UPDATE with `WHERE version = $n` and
`SET version = version + 1`; transitions additionally guard `status = $from`
(`src/items/repository.ts`). A 0-row result becomes 409 `VERSION_CONFLICT`
carrying the current item.

**Trade-off.** Clients must refetch after a 409 (no auto-merge) and the
`version` value has to be threaded through the UI. In exchange the contract is
uniform and documented instead of ad-hoc per endpoint. Proven by
`test/stale-update.test.ts`.

## 3. Idempotency keys inserted inside the write transaction

**Context.** A retried `POST /items` (network timeout, double click) must not
create a second item.

**Options.** an external store (Redis) for keys; `INSERT ... ON CONFLICT DO
NOTHING` plus a separate lookup; a plain INSERT on the `(user_id, key)` primary
key inside the same transaction.

**Choice.** The plain INSERT (`createItem`/`addComment` in
`src/items/service.ts`). A concurrent duplicate blocks on the unique index
until the owner commits (or rolls back); the loser gets 23505 and replays the
stored response. The same key with a different body hash is 422
`IDEMPOTENCY_CONFLICT`. Because the key row belongs to the transaction, a
failed request never consumes its key.

**Trade-off.** Keys live in the primary database (one more table, one more
write per request) and are never expired -- a cleanup job is on the next-week
list. The stored response is replayed verbatim, so responses must stay
JSON-serializable (DB rows are mapped to camelCase API shapes before storage).
Proven by `test/idempotency.test.ts`.

## 4. Activity events in the same transaction (append-only)

**Context.** Every state change must be auditable, and the audit history must
never disagree with the item row.

**Options.** emit events asynchronously (queue or triggers); event sourcing as
the primary data model; application-level inserts in the same transaction plus
an append-only database trigger.

**Choice.** Same-transaction inserts: `insertActivityEvent` is called by every
write, always inside `tx()`, and migration 004 rejects UPDATE/DELETE on
`activity_events`. A rollback removes the row change, the event and the outbox
job together.

**Trade-off.** Every write pays for its history instead of deferring it, and
correcting or redacting an event would require a migration (deliberate for an
audit log). Proven by `test/activity.test.ts`.

## 5. Roles are loaded per request, never stored in the JWT

**Context.** Membership and roles change (promotion, removal) while sessions
are active; a stale token must not keep old rights.

**Options.** role claims inside the JWT (fast, stale); server-side sessions
(with a store and revocation); id-only JWT plus a per-request membership load.

**Choice.** The token carries only `sub` (user id); `requireAuth` loads the
user and all memberships from PostgreSQL on every request, and `can()` is a
pure function over that data.

**Trade-off.** Two extra queries per request (indexed point lookups) instead of
a self-contained token; in exchange role changes and deactivations apply
immediately and tokens stay simple (HS256, 8h expiry).

## Known limitations

- Notifications are rows in the `notifications` table; no email/push provider
  is wired up.
- One API process and one worker process in compose. The worker claims with
  `FOR UPDATE SKIP LOCKED`, so multiple workers should be safe, but a
  multi-worker soak test has not been run.
- No refresh-token flow; tokens expire after 8 hours and the user logs in
  again.
- The frontend has no automated tests (verified manually); the test suite
  covers the API and the database behaviour.
- Search is simple `ILIKE` pattern matching over the title: no ranking, no
  fuzzy search.
- Idempotency keys are never deleted; the table grows with retried writes.
- The `unassigned_urgent` view is a fixed server-side definition; users cannot
  save custom filters.

## Next week I would

1. Cleanup jobs: expire idempotency keys, archive `done` outbox jobs.
2. A real notification channel (email/Slack) behind the existing
   `NOTIFY_ASSIGNEE` handler -- the outbox already isolates delivery.
3. Multi-worker soak test and a `Retry-After` header on 409s.
4. CI: `npm test` + `npm run build` against a postgres service container.
5. Frontend smoke tests (Playwright) for login -> claim -> approve, reading the
   server's `allowedActions` instead of duplicating rules.
