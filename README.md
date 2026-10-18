# Newtonite Ops

Internal ops work-item tracker (Newtonite Software Engineering Challenge): an
Express + PostgreSQL API with a React SPA under `web/`. Every state change is a
single guarded UPDATE in one transaction together with its activity event and
outbox job; a separate worker turns outbox jobs into notifications. All
permission and workflow rules live on the server (`src/authz/can.ts`,
`src/items/workflow.ts`) and reach the UI only as the `allowedActions` array.

## Architecture

```mermaid
flowchart LR
  Browser["Browser SPA (React)"] -->|"HTTP + Bearer token"| API["Express API"]
  API -->|"writes: item + activity + outbox in one tx"| DB[("PostgreSQL")]
  Worker["Outbox worker"] -->|"polls outbox_jobs, writes notifications"| DB
```

## Run it

Docker (the easy path; builds the API and serves the SPA):

```
docker compose up --build
```

- UI + API: http://localhost:3000
- Health:  http://localhost:3000/health

Compose runs migrations, seeds demo data (skips if already seeded), serves the
built frontend from the API and starts the outbox worker.

Local development:

```
cp .env.example .env                 # DATABASE_URL=postgres://newtonite:newtonite@localhost:5432/newtonite_ops
npm install
npm run migrate && npm run seed
npm run build && npm start           # API + built UI on :3000
cd web && npm install && npm run dev # SPA dev server on :5173 (proxies the API)
```

## Demo logins

Password for every demo account: `demo-password-123`.

| Email | Role |
| --- | --- |
| ada.admin@demo.newtonite.dev | admin in all four teams |
| liam.lead@demo.newtonite.dev | lead in Platform, member in Payments |
| luna.lead@demo.newtonite.dev | lead in Payments |
| nora.lead@demo.newtonite.dev | lead in Support |
| leo.lead@demo.newtonite.dev | lead in Compliance |
| maria.member@demo.newtonite.dev | member in Platform |
| marco.member@demo.newtonite.dev | member in Payments |
| mia.member@demo.newtonite.dev | member in Support |
| victor.viewer@demo.newtonite.dev | viewer in Platform |
| vera.viewer@demo.newtonite.dev | viewer in Compliance, member in Support |

## Tests

The suite runs against a real PostgreSQL server -- concurrency behaviour is
database behaviour, so nothing is mocked. Each test file resets the schema and
re-applies the migrations, and files run sequentially (`fileParallelism: false`).

```
docker compose up -d db   # just the database
cp .env.example .env      # DATABASE_URL -> localhost:5432 (compose credentials)
npm install
npm test
```

- By default the suite derives `newtonite_ops_test` from `DATABASE_URL` on the
  same server and creates it when missing (the compose user is a superuser).
- Override with `TEST_DATABASE_URL=postgres://newtonite:newtonite@localhost:5432/my_test npm test`
  (used as-is; created when possible).
- Your development database is never touched: only the `_test` database's
  schema is dropped and recreated.
- `npm run build` type-checks the app (`tsconfig.json`) and the tests
  (`tsconfig.test.json`).

## Known limitations

Short version; rationale and trade-offs in
[ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md): notifications are
database rows (no email provider), no refresh tokens (8h JWT), single API and
worker processes in compose, no automated frontend tests, search is simple
pattern matching, and idempotency keys never expire.
