# Newtonite Ops — PRD

**Date:** Oct 18, 2026

## Reality Check

You have about 16 hours to the Monday 19 Oct, 10 AM deadline. Four corrections to the stated setup:

- Supabase as the app database breaks "one-command run". Use a Postgres container in docker-compose as the primary database; treat Supabase as an optional deployment target via `DATABASE_URL`.
- Azure F1 is not a VM. Live deployment is optional — skip it unless everything else is finished and tested.
- DeepSeek via OpenCode is fine, but you must explain every line.
- Keep the frontend minimal. Backend correctness and tests carry the score.

## Minimum Modules

- **M1 Foundation** — Repo, docker-compose (app + Postgres), migrations, seed (4 teams, ~10 users, ~5k items), `.env.example`
- **M2 Auth and authorization** — Login/token, per-team membership roles, one `can(user, action, item)` function used by every endpoint
- **M3 Work items core** — Create, list (filters, search, cursor pagination, indexes), detail, versioned PATCH, atomic claim, workflow transitions, idempotency keys, activity event in the same transaction
- **M4 Outbox worker** — Outbox row in the same transaction, worker with retries and max attempts, idempotent handler
- **M5 Thin UI and docs** — Login, dashboard (3 views), item detail with timeline, conflict message; README, ENGINEERING_DECISIONS.md

## Product

An internal ops tracker where teams create, assign, track and resolve work items, with strict correctness under concurrent use.

## Roles (per team)

| Role | Permissions |
|------|-------------|
| Viewer | Read only |
| Member | Create, claim, edit, comment, move items forward |
| Lead | Everything a Member can, plus approve and reassign |
| Admin | Manage memberships (seeded only) |

## Work Item Fields

`title`, `description`, `type` (incident, customer_issue, payment, compliance, task), `priority` (low, medium, high, urgent), `status`, `team`, `assignee` (nullable), `created_by`, `due_date`, `version`, `timestamps`

## Workflow

```
OPEN → IN_PROGRESS → AWAITING_APPROVAL → RESOLVED → CLOSED
                            ↓ (reject)
                        IN_PROGRESS
```

- Only a **Lead** of the item's team can move `AWAITING_APPROVAL → RESOLVED`.
- `CLOSED` is terminal.
- Invalid jumps return 409 or 422.

## Assumptions (confirmed)

- **A**: Claiming needs Member or above in the item's team, and the item must be unassigned and OPEN or IN_PROGRESS.
- **B**: Claim moves OPEN to IN_PROGRESS automatically.
- **C**: Only the assignee or a Lead can move an item to AWAITING_APPROVAL.
- **D**: A Lead cannot approve their own item (separation of duties).
- **E**: Users outside the team get 404 on read and 403 on write.
- **F**: The activity log is append-only, with no update or delete endpoints.
- **G**: Notifications are only a "notify new assignee" outbox job, written to a table or logged, with no email.

## Out of Scope

Sign-up, attachments, SSO, websockets, email, mobile app, fancy styling.

## Success Criteria

`docker compose up` works on a fresh clone, one command runs all tests, and each of the five critical behaviours has a passing test.

## Open Questions — All Answered

- ☑ Assumptions A to G confirmed, especially D.
- ☑ Frontend: React with Vite and plain CSS.
- ☑ Data access: raw `pg` with SQL migrations.
- ☑ Roll number: `2300970130073` → repo `newtonite-ops-2300970130073`.
