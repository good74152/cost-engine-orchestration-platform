# Demo-02B — Scenario Persistence and APIs

## Goal and baseline

Provide durable Guided Scenario Create/Get, one Scenario per session, retry-safe
creation and Reset integration. Do not execute steps or advance progress.

Branch feature/demo-02b-scenario-persistence was created from freshly fetched
main 72f436997fb8dae3130f8a9b1651adca8cd3a46f (PR #26 merge). Task 007 acceptance,
Demo-01A/01B-1/01B-2, company collision protection and Demo-02A are on this baseline.
Authority: System Owner's Demo-02B specification, Architecture, ADR-0009/0010,
Demo-02A and the focused [ADR-0011](../adr/0011-demo-scenario-persistence-and-mode-isolation.md).

## Data model and ownership

New forward migration: 1792800000000_demo-scenario-instances.ts. It adds only
demo_scenario_instances; no applied migration or core dataset/job/attempt schema
changes. Fields: UUID id, session_id, scenario_type, status, completed_step,
created_at and updated_at. Defaults are generated UUID, READY, 0 and timestamps.
UNIQUE(session_id) enforces one Scenario for the session's entire lifetime, not
just an active-status slot. FK to demo_sessions(id) uses ON DELETE RESTRICT.

Checks allow HAPPY_PATH/FAILURE_RETRY/LOST_RESPONSE_RECOVERY,
READY/IN_PROGRESS/COMPLETED and integer completed_step >= 0. No future step count
is invented. Only HAPPY_PATH is accepted by Create, always READY/0. The other
types/statuses are reserved schema vocabulary, not implemented workflows.
completed_step is the last completed step; zero means no step has completed.

No public API changes a Scenario's progress, type or status. No Scenario-to-job
identity, Step ledger, expectedStep or requestId protocol is added. Reads require
both authenticated session ID and (for by-ID) Scenario ID in parameterized SQL.
The unique session index supports current lookup, admission and cleanup.

## API contracts

Explicit Demo mode only; core registration is unchanged:

| API | Contract |
|---|---|
| POST /demo/scenarios | Exact JSON {"scenarioType":"HAPPY_PATH"}; cookie and existing mutation CSRF policy |
| GET /demo/scenarios/current | Current owner's durable Scenario, or generic 404 |
| GET /demo/scenarios/:id | Durable owned Scenario; foreign/missing/invalid UUID share generic 404 |

DTO fields only: scenarioId, scenarioType, status, completedStep, createdAt,
updatedAt. Dates are ISO-8601 strings. No session/company selector, token/hash,
executor state or SQL details are exposed. No query fields are supported.
GET needs no mutation header, but keeps Origin/Fetch Metadata checks. All routes
authenticate, use the existing coordinator, revalidate at execution, return
no-store and use existing unavailable-cookie clearing/error envelope. No CORS
relaxation or public fake-control identity is introduced.

| HTTP | Code / result |
|---|---|
| 201 | New HAPPY_PATH READY/0 |
| 200 | Same-type Create retry or successful Get |
| 400 | INVALID_REQUEST: unsupported type, malformed body, extra identity/progress fields or query |
| 401 | DEMO_SESSION_UNAVAILABLE; clear the actual cookie |
| 403 | DEMO_SESSION_CSRF_REJECTED |
| 404 | DEMO_RESOURCE_UNAVAILABLE |
| 409 | DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE |
| 409 | DEMO_SCENARIO_SESSION_NOT_EMPTY |
| 409 | DEMO_SCENARIO_TYPE_CONFLICT: an existing different-type Scenario |
| 409 | DEMO_SCENARIO_MODE_CONFLICT: manual mutation in a guided session |
| 409 | RESET_CONFLICT |
| 429 | DEMO_SESSION_QUEUE_FULL |
| 503 | DEMO_RESET_OUTCOME_UNKNOWN |
| 503 | DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN: retry Create to resolve durable outcome |
| 500 | Sanitized INTERNAL_SERVER_ERROR; Reset retains DEMO_RESET_FAILED |

## Create transaction and idempotency

Inside the same session coordinator operation:

```text
BEGIN
lock demo_sessions row
fresh statement: validate active/unexpired session and company
read existing Scenario
  same type -> return its current stored DTO without refreshing timestamps
  other type -> conflict
  absent -> read-only configuration compatibility check
         -> require no company-owned dataset_series (all jobs/attempts reach it)
         -> insert HAPPY_PATH READY/0 ON CONFLICT(session_id) DO NOTHING
         -> if conflicted, reload durable Scenario and compare type
COMMIT
```

Existing Scenario lookup precedes initial configuration/empty-session checks.
That is necessary for response-loss retries after the Scenario has acquired
domain data or future persisted progress. It does not bypass request validation
or session eligibility. A repeated Create never allocates a replacement ID.

First creation requires exactly Demo-02A's compatible CAPEX guided configuration:
only active DEMO_GUIDED_SUMMARY, demo_capex_guided, counter 1 and exactly published
definition 1 with a publication timestamp and no required domains. Validation is
one read-only SQL statement. It never imports/calls the seed or writes shared
configuration. Other active CAPEX types fail closed. Existing exploration data
is retained with 409; the user must Reset and obtain a fresh session.

Same-backend queue order plus the durable session lock serialize requests.
UNIQUE(session_id) is still the DB backstop. The insert's conflict branch does
not turn an expected duplicate into a generic 500. No calculation-type/series/
job locks, dataset creation or executor wait occur in this transaction.

If COMMIT transport fails, do not infer rollback or return a made-up success.
Discard the suspect connection and return 503 CREATE_OUTCOME_UNKNOWN. A retry
obtains the same durable session lock (waiting for the prior outcome), then
reads the committed Scenario or inserts only after confirmed absence. A rollback
can therefore yield a later 201; committed response loss yields 200, same ID.
There is no automatic second Scenario or in-memory create truth.

## Guided/manual separation and locking

All existing manual Demo dataset creation/lifecycle, Run, Reconcile, dispatch
behavior and fake-state commands check guided mode INSIDE the existing queue.
Admission briefly locks/revalidates the session and reads Scenario in a fresh
statement, then commits and releases BEFORE calling unchanged Domain services.
This fresh locked read also waits out ambiguous Scenario creation; a stale MVCC
subquery in a waiting SELECT is not used as admission truth.

No SQL transaction/lock is held during executor dispatch. Core financial lock
hierarchies are not changed. Queue ordering prevents Create from overtaking an
already admitted manual command: manual-first leaves data and first Create
conflicts; Scenario-first blocks later manual mutation. Other sessions remain
free to explore. Dataset/Job/Attempt reads, Scenario reads and Reset stay usable.
Future trusted Scenario Runner work can call Domain services under its accepted
session protocol, not the public manual HTTP path. No Runner is implemented here.

## Reset, unknown outcomes and maintenance

Reset reserves the idle session as before. With its durable row locked, one
transaction deletes that session's Scenario, deletes the existing company-owned
domain graph in FK order, revokes the session, and commits. Only confirmed
commit releases its fake and clears the cookie. Failure after Scenario deletion
rolls back Scenario/domain/revocation; fake memory is retained.

Unknown COMMIT recovery still uses a separate connection and waits for the same
session row lock. A fresh statement now checks remaining dataset_series OR
Scenario rows. A revoked active-reset owner with any remaining Scenario cannot
be classified as committed success; retain its reservation/fake and 503 until
controlled durable recovery. No automatic partial-data repair is added.

Both bounded inactive-candidate selection and pending-work count include
Scenario-only owners, even without datasets or registered fakes. They reuse
the same reservation, transaction and owner cleanup, including prior confirmed
rollback/unknown handling. No worker is added. Startup invalidates old cookies
before listening; retained progress does not restore an old fake or session.
Scenario-only inactive data is then eligible for normal bounded maintenance.

## Rollback and testing

Migration down locks the Scenario table and explicitly refuses any retained
Scenario data. Empty down drops only that table. It does not silently discard
history or use CASCADE. The new suite tests clean up, empty down, representative
pre-02B Session/series forward preservation and populated down atomic rejection.

The existing A1 rollback fixture now requests two downs so it still tests the
Session migration after the new empty child table is removed; the retained
session rejection/atomicity assertions remain. Existing B2 FK inventory gains
the one Scenario ownership edge; 02A/B2 migration count is exactly eight. No
existing behavioral test or milestone gate is removed or weakened.

The new real PostgreSQL suite covers specification A–N: initial DTO/row, replay,
20 HTTP creates and 10 direct concurrent service calls, unique/FK/check rejected
writes and the insert-conflict branch, both-direction ownership/generic 404,
strict inputs/security/unavailable-cookie clearing, read-only configuration
preconditions, exploration data refusal, every manual mutation guard, both
mode-admission orders, session-lock revocation race, Create COMMIT loss/rollback,
Reset owner/shared preservation, real failure after Scenario delete, ambiguous
Reset committed/rolled-back outcomes and retained-Scenario fault injection,
Scenario-only expiration/revocation maintenance, Reset/read/queue contracts,
full durable/fake-memory read-only equality, and restart invalidation.
A blocking FakeExecutor plus a separate FOR UPDATE NOWAIT connection proves
session/job/attempt locks are released during the manual executor wait.

Tests own a fresh named template0 DB, migrate all eight files, close actual
clients, verify zero backends and normally DROP only that disposable DB.
No tests destroy a persistent developer DB. Fault-injection progress/graph rows
are fixtures only, not application step execution.

## Verification

Privately configure TEST_DATABASE_URL (fallback DATABASE_URL) for a safe local
PostgreSQL service with CREATE DATABASE and owned DDL/drop rights. Do not print
connection credentials. Start the repository service with docker compose up -d
postgres_db. On Windows use npm.cmd for these commands:

```bash
npm run build
npm run test:demo-02b
npm run test:demo-02a
npm run test:demo-session-infrastructure
npm run test:demo-session-ownership-executor-isolation
npm run test:demo-session-reset-recovery
npm run test:milestone
git diff --check
```

Exact tested commit/tree, per-suite results, runtime versions, warnings and
owned teardown evidence will be recorded after the final clean-revision gate.
This command inventory is not a PASS claim.

## Limits and Demo-02C boundary

Single Demo backend with no concurrent core/external writer or independent
configuration administration. No public deployment guarantee. Fake state is
still process-local; durable Scenario progress does not change restart policy.
No Next API, step requestId/expectedStep, execution ledger, progress advancement,
automatic dispatch/reconciliation, Scenario Runner, frontend, queues or
distributed coordinator. Existing Demo-02A seed/read contracts, core state
machines/snapshots/locks/executor and token/company collision protections remain.
System Owner must review the PR; no automatic merge.
