# Demo-02A — Shared Configuration Seed and Read APIs

## Goal and baseline

Provide an explicit minimal shared Demo configuration and protected PostgreSQL
Dataset, Job and Attempt reads. This is not a Scenario Runner.

Branch: `feature/demo-02a-seed-read-apis`, created from freshly fetched main
`2c44809a14d18559e7154c51c34e30acf8bebca3`. Its history contains Task 007 acceptance,
Demo-01A (PR #15), Demo-01B-1 (#20), Demo-01B-2 (#24) and the company collision
fix (#25). Do not use the old B2 feature branch as the baseline.

Authority: the System Owner's Demo-02A specification, AGENTS.md, the Architecture,
Roadmap, Reference, ADR-0009 and ADR-0010. Accepted core lifecycle, snapshot,
allocation, executor and lock protocols remain unchanged.

## Shared seed

Run `npm run seed:demo-guided` explicitly, after migrating a dedicated Demo DB.
It requires `APP_MODE=demo`, an approved development/test `NODE_ENV`, and an
explicit `DEMO_SEED_DATABASE_URL`. There is no fallback to `DATABASE_URL`.
Production and conflicting executor configuration fail closed. No connection
credentials are printed. No new dependencies or seeder framework are used.

For PowerShell, configure credentials privately, without pasting them into logs:

```powershell
$env:APP_MODE = 'demo'
$env:NODE_ENV = 'development'
$env:EXECUTOR_TYPE = 'fake'
# Privately set DEMO_SEED_DATABASE_URL to the migrated local Demo database.
npm.cmd run seed:demo-guided
```

One transaction inserts or verifies:

| Field | Required value |
|---|---|
| Domain | CAPEX |
| Type code | DEMO_GUIDED_SUMMARY |
| DAG | demo_capex_guided |
| Active | true |
| Definition allocation counter | 1 |
| Definition history | Exactly version 1, PUBLISHED, non-null published timestamp |
| Required direct domains | None |
| Other active CAPEX types | None |

An absent type is inserted with its counter and published definition in the
same transaction. A concurrent invocation uses the type uniqueness constraint
and row lock to converge on the same committed IDs. A repeated compatible seed
only verifies; it never updates rows or timestamps. Inactive CAPEX types and
other domains are left alone.

An existing guided type must match the complete contract. Missing/extra
definitions, different DAG, inactive type, wrong counter, unpublished definition,
missing publication timestamp or required upstream domains are conflicts, not
instructions to repair history. Another active CAPEX type also conflicts because
dataset creation snapshots every active type, not just the seeded one.

Conflict returns a clear `DEMO_CONFIGURATION_CONFLICT` command error and rolls
back, including a type inserted earlier in that transaction. Unexpected SQL
errors are sanitized. A transport failure during commit does not prove rollback;
rerunning the idempotent command checks durable configuration safely.

The seed never changes sessions, company codes, datasets, jobs, attempts or
published definitions. It is not invoked by startup, buildApp, session creation,
dataset creation or Reset. Shared configuration remains outside owner cleanup.
Use the accepted single Demo instance/no concurrent core or external writer
boundary. Quiesce independent configuration administration while seeding; this
is not arbitrary cross-table/configuration-writer serialization.

## Protected read contracts

These GET routes exist only in explicit Demo mode:

| Route | Response |
|---|---|
| `/demo/dataset-versions` | Dataset page |
| `/demo/dataset-versions/:id` | Dataset detail |
| `/demo/dataset-versions/:id/calculation-jobs` | Owned parent's Job page |
| `/demo/calculation-jobs/:id` | Job detail |
| `/demo/calculation-jobs/:id/execution-attempts` | Owned parent's Attempt page |

Dataset list fields: `datasetVersionId`, `datasetSeriesId`, `domain`,
`fiscalYear`, `period`, `version`, `datasetStatus`, `createdAt`.
Detail adds nullable `buildingStartedAt`, `validatingAt`, `publishedAt`,
`rejectedAt`, `abandonedAt`.

Job list fields: `jobId`, `datasetVersionId`, `calculationTypeCode`, `jobStatus`,
`createdAt`, `startedAt`, `finishedAt`. Detail adds `datasetStatus`.

Attempt fields: `executionAttemptId`, `attemptNumber`, `attemptStatus`,
`createdAt`, `dispatchStartedAt`, `acceptedAt`, `finishedAt`.
Timestamps are ISO-8601 strings; unset lifecycle timestamps are null.

Every field is explicitly projected into the public DTO. No raw SELECT * rows,
credentials/hashes, company selectors, SQL diagnostics, dispatch error text,
DAG/run internals or fake memory are exposed. All statuses come from PostgreSQL.
A fake marked SUCCEEDED still reads as RUNNING/ACCEPTED until reconciliation.

## Security and ownership

Authenticate the existing HttpOnly cookie before parsing/handling the route.
Enter the existing coordinator and revalidate eligibility at execution time.
Each parameterized data statement joins its resource through canonical series
ownership to the authenticated session ID. No caller-supplied company code is
trusted. Missing, foreign and malformed resource IDs share generic 404.

GET requires no `X-Demo-Session` mutation header. Supplied Origin must still
match, and cross-site Fetch Metadata is rejected under the shared policy.
Cookies retain their existing HttpOnly/SameSite/Secure policy; no credentialed
CORS is enabled. Success and errors use `Cache-Control: no-store`.

| HTTP | Code |
|---|---|
| 400 | INVALID_REQUEST (unsupported or malformed query) |
| 401 | DEMO_SESSION_UNAVAILABLE (clear the actual session cookie) |
| 403 | DEMO_SESSION_CSRF_REJECTED (cross-origin policy) |
| 404 | DEMO_RESOURCE_UNAVAILABLE |
| 409 | RESET_CONFLICT |
| 429 | DEMO_SESSION_QUEUE_FULL |
| 503 | DEMO_RESET_OUTCOME_UNKNOWN |
| 500 | INTERNAL_SERVER_ERROR (sanitized unexpected failure) |

## Consistency and Reset

Reads use the same runtime-owned per-session Promise queue as mutations, not a
second lock. Running or queued reads make Reset busy. A reset reservation blocks
new reads with 409, or 503 while its commit outcome remains unknown. Different
sessions proceed independently. Queued expiry/revocation rejects before the
operation body, as before; already admitted work may finish.

One data SQL statement creates each response. Child lists use a bounded lateral
query inside the same statement as the parent ownership check. An empty owned
page is 200, not a false missing parent; an unavailable parent is 404. No response
combines multiple domain queries with inconsistent lifecycle observations.
No executor or explicit orchestration transaction is used for GET.

## Pagination and index review

Lists return `{ items, nextCursor }`. Default limit is 20; allowed limits are
canonical decimal integers 1–100. Values above 100 are rejected, not silently
clamped. Unknown query fields, duplicate limit/cursor values, invalid types,
invalid cursors and pagination on detail endpoints return 400.

Dataset and Job pages sort by UUID ascending. Attempt pages sort by immutable
`attemptNumber` ascending. Queries fetch at most limit+1, not whole histories.
Cursors are bounded (512 characters), canonical base64url JSON with exact
version/kind/session-and-parent scope/key validation. They are not credentials
or authorization: even a forged well-formed cursor still executes ownership SQL.
Use returned cursors unchanged. Pagination across requests is not a long-lived
database snapshot; concurrent insertions before the cursor require a refresh.

The suite records catalog definitions and EXPLAIN ANALYZE plans. Existing
version/series and job/version uniqueness indexes support joins; job history
uses `(calculation_job_id, attempt_number)` for bounded ordered range scans.
The Job list may sort that parent's job set. Company filtering may scan the
small Demo series table; no company-first index or large-scale latency guarantee
is claimed. No new index is justified by the small local Demo workload, so no
historical or new migration is changed. Reassess measured plans before scaling.

## PostgreSQL tests and verification

`scripts/demo-02a-seed-read-apis.pg.test.ts` creates a uniquely named template0
database, applies all seven migrations, runs real HTTP/SQL tests, closes actual
clients, verifies zero remaining backends and normally drops only its owned DB.
No FORCE, TRUNCATE, CASCADE or persistent developer-data cleanup is used.

Coverage includes fresh CLI seed, concurrent/repeated idempotency, incompatible
configuration and SQL-failure rollback, safety gates, full CAPEX HTTP publication
flow, both-direction owner isolation, DTOs, generic missing/foreign/invalid IDs,
unavailable-cookie clearing, Origin/core-mode boundaries, controlled read/reset
barriers, queued revocation, queue/unknown-reset contracts, multi-page datasets,
jobs and 136 attempts, cursor validation, and whole-graph/fake-memory read-only
checks. No mocked repository substitutes for PostgreSQL.

Privately configure TEST_DATABASE_URL (fallback DATABASE_URL) for a safe local
test service with CREATE DATABASE and owned DDL/drop privileges. Commands:

```bash
npm run build
npm run test:demo-02a
npm run test:demo-session-infrastructure
npm run test:demo-session-ownership-executor-isolation
npm run test:demo-session-reset-recovery
npm run test:milestone
git diff --check
```

Executed revision, results and earlier development failures will be recorded
after final verification. Do not treat this command inventory as execution proof.

## Limits and review

Development/test, single backend, no concurrent core/external writer, no public
production deployment guarantee. Fake execution state is still process-local.
No Scenario Runner/state/instance/API, expectedStep, requestId idempotency,
frontend, queues, real Airflow, distributed coordination or later Demo-02 work.
System Owner review is required; do not automatically merge.
