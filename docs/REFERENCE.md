# Backend Reference

This reference keeps the detailed model, API and local-development guidance linked from the [project overview](../README.md). For a visual introduction, start with the [Engineering Flows](ENGINEERING_FLOWS.md).

## Accepted milestone baseline

The Orchestration Core v2 milestone is **completed and accepted**: Task 007 COMPLETE; Orchestration Core v2 ACCEPTED. The implemented orchestration scope for Tasks 002–007 is complete, and Tasks 007A–007E are merged. System Owner final acceptance is recorded on 2026-10-16 (Asia/Taipei) in the [final acceptance record](verification/task-007-final-acceptance.md).

The broader platform remains an evolving portfolio project. This milestone does not include production Airflow integration or claim production deployment readiness. The final acceptance record distinguishes the tested source from the implementation merge and the separate documentation closure; historical verification reports remain unchanged.

See [Roadmap](ROADMAP.md), [Task 007 master scope](tasks/007-end-to-end-hardening-and-legacy-cleanup.md), [Task 007E](tasks/007e-legacy-and-documentation-cleanup.md), [historical Task 007D verification](verification/task-007d-milestone.md) and [Task 007E audit/verification](verification/task-007e-cleanup.md).

## Implemented model

```text
Dataset Series (domain, company_code, fiscal_year, period)
└── Dataset Versions
    ├── Immutable Dataset Build Snapshot (after first Run)
    │   └── Frozen upstream published dataset versions
    └── Calculation Jobs (one per snapshotted active calculation type)
        ├── Frozen dependency-definition version (after first Run)
        └── Execution Attempts
            └── FakeExecutor external execution identity
```

Canonical domains are exactly:

```text
FAB_COST  CAPEX  DPR  INSURANCE  ONE_STD_COST  E2E_COST
```

The retired `COWOS_S` and aliases such as `FAB COST`, `COWOS-S` or `E2E-COST` are rejected with HTTP 400 `INVALID_DOMAIN`; no normalization or compatibility alias is provided. See [Naming-01 rollout and migration safety](tasks/naming-01-e2e-cost.md#rollout). Period is Q1–Q4; fiscal year is a positive integer.

### Creation and frozen inputs

`POST /dataset-versions` accepts only this identity:

```json
{
  "domain": "DPR",
  "companyCode": "TW01",
  "fiscalYear": 2026,
  "period": "Q3"
}
```

One transaction safely finds/creates and locks the canonical series, checks for an active version, increments `last_allocated_version`, inserts a DRAFT version, and creates a PENDING job for every active calculation type in the domain. The 201 response contains `datasetSeriesId`, `datasetVersionId`, `version`, `datasetStatus` and `calculationJobs` (job/type identities and job status).

A series can have only one DRAFT/BUILDING/VALIDATING version. Version numbers are monotonic and never reused after rejection or abandonment. The counter is not a latest-published or active-version pointer. No active calculation types means 409 CALCULATION_TYPE_NOT_CONFIGURED and complete rollback, including a newly created series.

Creation does not resolve dependencies. First Run freezes the latest PUBLISHED dependency-definition version for every job, derives required direct upstream domains using the same company/year/period, and selects their latest PUBLISHED dataset versions under the accepted locks. It atomically creates one dataset-wide snapshot, pins all job definitions, moves DRAFT to BUILDING and prepares the selected attempt. A published zero-dependency definition is valid; missing configuration is not.

All jobs and retries reuse this frozen build contract. Later publications or configuration changes do not refresh it. Each dispatched job receives only its required dependency subset, not the union for every job.

### Run, retry and reconciliation

`POST /calculation-jobs/:jobId/run` routes from durable job/attempt state. The platform generates each attempt's stable `(airflow_dag_id, airflow_dag_run_id)`; HTTP callers do not choose execution or data identity.

Durability boundaries are separate:

```text
A: prepare/reuse PREPARED attempt; commit
B: mark/reuse DISPATCHING and read frozen command; commit
   executor.dispatch — no open orchestration transaction/locks
C: record outcome atomically; commit
```

- ACCEPTED or ALREADY_EXISTS confirms the same external identity: attempt ACCEPTED and job RUNNING.
- REJECTED is an irrevocable, identity-wide guarantee that this execution never existed and cannot later be created (ADR-0008). Record DISPATCH_FAILED, leave job PENDING/FAILED, return 502 EXECUTOR_DISPATCH_FAILED.
- UNKNOWN remains DISPATCHING and normally returns 202 with the same attempt/run identity. Recovery redispatches that identity or reconciles it, rather than allocating a new attempt. Already-confirmed/terminal durable state is not regressed by late responses.
- An already ACCEPTED/RUNNING job returns durable state without redispatch. A definite dispatch failure or reconciled calculation failure can be retried with a new attempt number and identity, against the same snapshot.

`POST /calculation-jobs/:jobId/reconcile` queries executor truth outside DB transactions, then locks/revalidates job and attempt in canonical order before applying atomic updates. Confirmed terminal executor results produce SUCCEEDED/FAILED job and attempt states. NOT_FOUND/unavailability does not infer failure. Stale terminal observations cannot overwrite a newer retry.

`POST /executor-callbacks/airflow` accepts only `airflowDagId` and `airflowDagRunId`. It triggers the same reconciliation path; callback-reported terminal state is not authoritative. Periodic/background reconciliation is not implemented.

### Validation and terminal decisions

Dataset states are DRAFT → BUILDING → VALIDATING → PUBLISHED or REJECTED; DRAFT/BUILDING may instead become ABANDONED. There is no dataset-level FAILED.

All required jobs must succeed before explicit Submit Validation. Job completion does not automatically validate or publish. Publish/Reject require VALIDATING. Abandon rejects any PREPARED/DISPATCHING/ACCEPTED attempt and does not cancel external executions. Same-target lifecycle commands are idempotent; conflicting terminal decisions return STATE_CONFLICT and never rewrite history.

### Supported raw ingestion

Raw ingestion is a separate supported bounded feature, not obsolete calculation-job creation. `POST /raw-ingestion-batches` accepts exactly `domain` and `businessKey`, for FAB_COST_RAW, CAPEX_RAW or DPR_RAW. It atomically allocates a LOADING batch and returns 201 with `batchId`, `ingestionSeriesId`, `batchSequence` and `status`. An active batch returns 409 ACTIVE_RAW_INGESTION_BATCH_EXISTS. Its identity/model and historical data are retained; this businessKey is not canonical orchestration dataset identity.

## Registered API surface

This table describes core mode. Protected Demo registration is documented below.

| Method | Route | Purpose |
|---|---|---|
| GET | /health | Database connectivity/time (Fastify also generates HEAD) |
| POST | /demo/sessions | Create a four-hour session (201), or reuse a valid cookie (200) |
| GET | /demo/sessions/current | Restore a valid session from its HttpOnly cookie (200) |
| POST | /dataset-versions | Atomic dataset/job creation (201) |
| POST | /dataset-versions/:datasetVersionId/submit-validation | Explicit readiness transition |
| POST | /dataset-versions/:datasetVersionId/publish | Publish validated dataset |
| POST | /dataset-versions/:datasetVersionId/reject | Reject validated dataset |
| POST | /dataset-versions/:datasetVersionId/abandon | Safely abandon DRAFT/BUILDING |
| POST | /calculation-jobs/:jobId/run | Dispatch or retry (200; unresolved DISPATCHING is 202) |
| POST | /calculation-jobs/:jobId/reconcile | Reconcile selected durable attempt |
| POST | /executor-callbacks/airflow | Reconciliation trigger by stored external identity |
| POST | /raw-ingestion-batches | Raw batch allocation (201) |

Executor-backed routes require executor injection into `buildApp`; `src/server.ts` supplies the explicitly configured executor.

### Demo Session foundation (Demo 01A)

Session creation accepts an empty JSON object with `X-Demo-Session: 1`; browser
Origin must match the configured/direct origin. Sessions have a fixed four-hour
lifetime, no sliding extension, and hash-only credential persistence. Invalid,
expired or revoked cookies return 401 DEMO_SESSION_UNAVAILABLE. Successful JSON
contains only sessionId, companyCode, expiresAt and status. HTTPS cookies are
Secure/HttpOnly/SameSite=Strict/Path=/; plain HTTP is development/test only.
See [the bounded specification](tasks/demo-01a-session-infrastructure.md)
for cookie names, CSRF, internal revocation, ownership and queue policies.

Demo-01A supplied the foundations; Demo-01B-1 adds the explicit protected mode
below. **Default core Domain APIs remain unchanged and unauthenticated**. Do not
expose a core runtime against Demo data to untrusted users. No public-deployment
readiness or scenario runner is implied.
Focused verification: `npm run test:demo-session-infrastructure`, against its
own disposable migrated PostgreSQL database, alongside the unchanged milestone.

### Protected Demo runtime

Demo-01B-1 (PR #20) is merged. Explicitly set APP_MODE=demo, NODE_ENV=development
or test and EXECUTOR_TYPE=fake for local use. Unknown/conflicting mode fails closed.
Production requires the separately restricted [Demo-04 profile](DEPLOYMENT.md);
the flag alone cannot bypass mode, origin, secret or executor checks.
Demo registers only health, sessions and protected /demo dataset/job/fake commands;
anonymous Domain/raw/callback/internal controls are absent. All mutations require
the cookie and shared CSRF policy. Ownership and unchanged Domain commands run in
one per-session coordinator operation; different sessions have independent fakes/gates.
Demo-05B-1 admits up to four Parallel Dataset mutations/reads. Scenario Create,
Guided Next, Job Run/Reconcile and Fake controls remain Exclusive FIFO. Parallel
slots include waiting/revalidation; the fifth returns 429 DEMO_SESSION_QUEUE_FULL.
Exclusive admission waits for earlier operations and blocks later ones. Reset
requires idle state and retains its 409/unknown-503 reservation and recovery.
See [ADR-0015](adr/0015-demo-session-concurrency-gate.md) and
[the bounded concurrency tests](tasks/demo-05b1-session-concurrency-gate.md).
See [the complete route inventory](tasks/demo-01b1-session-ownership-executor-isolation.md).

Demo-01B-2 adds POST /demo/sessions/reset: valid cookie, X-Demo-Session: 1,
matching supplied Origin and exactly {}. It reserves only an idle session;
active/queued requests or another reset return 409 RESET_CONFLICT. Idle persisted
RUNNING jobs do not block reset. One transaction deletes that owner's full v2/DPR
graph and revokes the session. Only after commit release its fake, clear the
HttpOnly cookie and return 204. No shared configuration/assets/raw/history or
other owner's graph is deleted. Cross-owner references fail closed.

Confirmed rollback: 500 DEMO_RESET_FAILED, all data/fake retained, retry allowed.
Unresolved commit: 503 DEMO_RESET_OUTCOME_UNKNOWN, commands remain blocked until
fresh-connection durable recovery. All unavailable-session 401 responses clear
the correct host-only cookie; invalid-cookie creation stays 401, never silently
allocates a replacement. After clearing, POST without a cookie creates a new user.
Other reset errors: 400 INVALID_REQUEST and 403 DEMO_SESSION_CSRF_REJECTED.

Real Demo server startup invalidates old sessions before listening because fake
runs are not restart-durable; failure prevents listening. buildApp never does
invalidation. Bounded service-only maintenance reclaims inactive graphs/fakes,
logs pending work and can be retried; no admin HTTP API or worker. Single instance
only, no production/public deployment claim. See [B2 design/maintenance/evidence](tasks/demo-01b2-session-reset-recovery.md)
and [ADR-0010](adr/0010-demo-session-reset-and-recovery.md). Verify with:

```bash
npm run test:demo-session-infrastructure
npm run test:demo-session-ownership-executor-isolation
npm run test:demo-session-reset-recovery
npm run test:milestone
```

The following internal routes apply to core mode only.

Only with an injected FakeExecutor and an explicitly approved development/test environment:

| Method | Internal route | Purpose |
|---|---|---|
| POST | /internal/fake-executor/executions/:dagRunId/succeed | Set in-memory fake execution to SUCCEEDED |
| POST | /internal/fake-executor/executions/:dagRunId/fail | Set in-memory fake execution to FAILED |

These controls do not reconcile DB state automatically and are not production APIs. No core dataset/job read/list API is implemented; Demo-only reads are documented below. Legacy POST /calculation-jobs and job-level start/submit-validation/publish/reject/fail routes are not registered.

### Demo-02A shared seed and reads

Run `npm run seed:demo-guided` explicitly with APP_MODE=demo,
NODE_ENV=development/test and a privately supplied DEMO_SEED_DATABASE_URL.
No DATABASE_URL fallback or automatic startup/session/reset seed exists.
One transaction creates or verifies active CAPEX/DEMO_GUIDED_SUMMARY with DAG
demo_capex_guided and PUBLISHED zero-dependency definition 1/counter 1. Other
active CAPEX types or incompatible existing configuration fail closed, without
overwriting published history or changing session-owned data.

Protected GET routes in Demo mode only:

| Route | Content |
|---|---|
| /demo/dataset-versions | Owned Dataset page |
| /demo/dataset-versions/:id | Owned Dataset detail |
| /demo/dataset-versions/:id/calculation-jobs | Owned parent's Job page |
| /demo/calculation-jobs/:id | Owned Job detail |
| /demo/calculation-jobs/:id/execution-attempts | Owned parent's Attempt page |

Use the session cookie, no mutation header. Supplied Origin must match; no
credentialed CORS. All responses are no-store. Public statuses come only from
PostgreSQL; GET never dispatches or queries fake state. Missing/foreign/invalid
IDs share 404 DEMO_RESOURCE_UNAVAILABLE. Unavailable sessions return 401 and
clear the cookie. Coordinator admission preserves 409 RESET_CONFLICT,
429 DEMO_SESSION_QUEUE_FULL and 503 DEMO_RESET_OUTCOME_UNKNOWN.

Lists return `{ items, nextCursor }`, with limit 20 by default, maximum 100.
Dataset/Job sort by UUID ascending; Attempts by attemptNumber ascending.
Pass returned cursors unchanged. Invalid/unsupported query fields return
400 INVALID_REQUEST; detail endpoints accept no query fields. Parent ownership
and a bounded page use one SQL statement, not separate inconsistent reads.
Read admission shares Reset's existing coordinator; no second session lock.
Full DTOs, pagination limits, seed compatibility, index review, environment
instructions and PostgreSQL evidence: [Demo-02A](tasks/demo-02a-shared-seed-read-apis.md).
Focused suite: `npm run test:demo-02a`; existing regression commands remain.

### Demo-05A optional six-domain configuration

`npm run seed:demo-six-domain` explicitly creates or verifies nine active Demo
types across CAPEX, FAB_COST, DPR, INSURANCE, ONE_STD_COST and E2E_COST.
It uses the same approved Demo environment and mandatory separate
DEMO_SEED_DATABASE_URL, with no DATABASE_URL fallback. One transaction covers
the complete seed, including the unchanged guided CAPEX contract. There is no
startup seed or user Dataset creation. Existing compatible rows are only read;
incompatible configuration fails with DEMO_CONFIGURATION_CONFLICT and rolls back.

The original seed and Guided Scenarios remain supported. New dependencies are
data in the existing definition tables, not a global pipeline in Core code.
Only published direct inputs for the authenticated company/year/period satisfy
Run. The existing snapshot, all-jobs validation and Retry rules apply unchanged.
See [type codes, commands, safety and tests](tasks/demo-05a-six-domain-configuration.md).
Focused PostgreSQL suite: `npm run test:demo-05a`.

### Demo-02B Scenario APIs

Demo-only POST /demo/scenarios accepts exactly {"scenarioType":"HAPPY_PATH"}
with the existing cookie/CSRF policy. New creation returns 201 READY/0; same-type
retry returns 200 and the unchanged original ID/progress/timestamps. Initial
creation requires compatible Demo-02A config and no owner domain data. No auto
seed or cleanup occurs on conflict. PostgreSQL UNIQUE(session_id) enforces one
Scenario for the session lifetime. GET /demo/scenarios/current and
GET /demo/scenarios/:id return only owned durable Scenario DTOs. Invalid/missing/
foreign IDs share generic 404. DTO: scenarioId, scenarioType, status,
completedStep, createdAt, updatedAt. No query fields or mutation header for GET.

Create/Get use the existing coordinator. Guided sessions cannot use any manual
Demo domain/fake mutation (409 DEMO_SCENARIO_MODE_CONFLICT); reads and Reset are
still available, and other sessions/core behavior are unchanged. Reset includes
Scenario deletion in its domain cleanup/revocation transaction. Unknown recovery
checks Scenario presence as well as domain graph; inactive maintenance discovers
Scenario-only owners. Old cookies still expire/revoke on restart, not recover
fake execution from persisted progress.

New conflicts: 409 DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE,
DEMO_SCENARIO_SESSION_NOT_EMPTY and DEMO_SCENARIO_TYPE_CONFLICT.
503 DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN means retry Create; durable locking and
lookup resolve same-row success or confirmed absence. Existing session/CSRF/
resource/reset/queue errors and sanitized internal errors remain.
Demo-02B alone adds no step execution; Demo-02C below supplies Next. Full transaction/error/model
contracts and PostgreSQL evidence: [Demo-02B](tasks/demo-02b-scenario-persistence.md).
Focused command: `npm run test:demo-02b`, alongside all Demo/milestone regressions.

### Demo-02C Happy Path Next

Demo-only POST /demo/scenarios/:id/next accepts exactly expectedStep (integer
1–6) and requestId (UUID), using the same cookie/CSRF/Origin/coordinator. It runs
one explicit HAPPY_PATH step. 200 returns the original stored COMPLETED response;
unconfirmed dispatch is 202 PENDING with the same attempt. No caller resource or
executor selectors. GET /demo/scenarios/:id/pending-step returns only the pending
stepNumber/requestId or null, from PostgreSQL without writes/fake access. Existing
Scenario GET DTOs and guided manual-write blocking are unchanged.

Same request replays its original result even after later steps. Different request
or wrong order: 409 DEMO_SCENARIO_STEP_CONFLICT. Inconsistent resources/progress:
409 DEMO_SCENARIO_STATE_CONFLICT. Unconfirmed commit/executor truth:
503 DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN, retry the same request. Existing 400/401/
403/404/reset/queue contracts remain, including cookie clearing and no-store.
Reset removes ledger/Scenario/domain and revokes atomically. Startup still
invalidates old cookies; fake memory is not recreated. A populated ledger down
is deliberately unsupported. Focused command: npm run test:demo-02c. Full DTO,
six-step recovery, failure evidence and limits: [Demo-02C](tasks/demo-02c-happy-path-step-execution.md).

### Demo-02D Failure Retry

POST /demo/scenarios now accepts FAILURE_RETRY as well as HAPPY_PATH. Same-type
creation is idempotent; cross-type is 409 DEMO_SCENARIO_TYPE_CONFLICT. Demo-02E below
also enables Lost Response Recovery. Next keeps exactly
expectedStep/requestId; type-specific bounds are 1–6 and 1–9 respectively.

Failure Retry explicitly simulates/reconciles Attempt 1 FAILED, then uses core
Run to create only Attempt 2 against the same Job and frozen inputs. Steps 3–9
can recover progress independently of committed Domain facts. Failure result
DTOs identify the actual attemptNumber/UUID; historical responses never change.
UNKNOWN Retry is PENDING/202 with the same Attempt 2 and FAILED logical Job.
Definite dispatch rejection is 409 DEMO_SCENARIO_STATE_CONFLICT and requires Reset
in this bounded flow, never Attempt 3. Existing auth/CSRF/ownership/queue/Reset,
503 unknown-outcome and PostgreSQL-only pending-read contracts remain unchanged.
No client execution selector or new public fake-control API is added.

New forward migration validates both flow bounds/bindings and preserves original
Happy Path safety. Its down explicitly refuses retained FAILURE_RETRY Scenarios;
supported down preserves Happy Path data and restores the original validator.
Focused suite: npm run test:demo-02d. Full nine steps, private Retry intent,
history protection, migration and test evidence: [Demo-02D](tasks/demo-02d-failure-retry-scenario.md).

### Demo-02E Lost Response Recovery

POST /demo/scenarios also accepts LOST_RESPONSE_RECOVERY. It uses six steps and
only Attempt 1. First Step 2 really creates one session-owned fake execution,
then a Demo-only stateless decorator converts ACCEPTED to UNKNOWN. HTTP 202
returns PENDING with progress 1, Job PENDING and Attempt DISPATCHING. Same-request
retry preserves the full stable DAG/run identity; ALREADY_EXISTS passes through
to Core, which confirms ACCEPTED/RUNNING. Only then is Step 2 COMPLETED/200.
Steps 3–6 reuse fake success, reconciliation, validation and publication.

Ledger request ownership/replay, pending reads, A/B unknown-COMMIT confirmation,
security, per-session fakes and Reset are unchanged. No public behavior control,
new identity store or Core Run/executor contract change. A forward migration
enforces E's six-step/one-attempt bindings without relaxing Happy/Failure rules;
down refuses retained E Scenarios and otherwise restores the exact 02D validator.
Focused command: npm run test:demo-02e. Full contracts, identity persistence,
recovery boundaries and executed evidence: [Demo-02E](tasks/demo-02e-lost-response-recovery.md).

First Guided Scenario creation also requires an unallocated session FakeExecutor.
Prior manual fake behavior (even without Dataset rows) returns 409
DEMO_SCENARIO_SESSION_NOT_EMPTY with a reset instruction. Use Reset and a new
Session; Create never clears fake execution/rejection/script history. This
conservative check applies to all three types only on first insertion. Existing
same-type Scenario Create remains 200 at any progress, retaining the same fake
and executions; different-type remains 409 DEMO_SCENARIO_TYPE_CONFLICT.

Handled API errors use the flat envelope:

```json
{ "message": "...", "code": "..." }
```

Representative contracts: 400 INVALID_REQUEST/INVALID_DOMAIN/INVALID_PERIOD; 404 CALCULATION_JOB_NOT_FOUND/DATASET_VERSION_NOT_FOUND/EXECUTION_ATTEMPT_NOT_FOUND; 409 lifecycle/readiness/active-version conflicts; 502 EXECUTOR_DISPATCH_FAILED; 503 EXECUTOR_STATUS_UNAVAILABLE. Parser body-size/media errors use 413/415 with INVALID_REQUEST. Unexpected failures are logged and return 500 INTERNAL_SERVER_ERROR without PostgreSQL details. Unregistered routes retain Fastify's normal 404 response. See [API coverage inventory](tasks/007c-api-error-contract-coverage.md) and the executed verification reports for the full contracts.

## Local development

### Interactive frontend (Demo-03)

frontend/ provides React routes for Dashboard, Guided Demo, Free Exploration,
Dataset detail/history and About. Root scripts ui:dev, ui:typecheck, ui:test and
ui:build delegate to that package; install both root and frontend lockfiles.
Start the existing Demo backend on 3000 and Vite on 5173 after explicit migration
and the local guided seed. See [the complete setup](tasks/demo-03-frontend-ui.md#reproducible-local-development).

All requests are relative /demo with credentials: include; POST also supplies
X-Demo-Session: 1 and JSON. Vite changeOrigin: false retains the browser's Host
and Origin. No Cookie/token storage, CORS bypass or backend contract change.
Only a user starts a session. Backend 401 invalidates UI scope; only confirmed
Reset 204 clears it as successful Reset. Error/unknown Reset retains state.

Guided request mappings are saved before POST under session/scenario/step scope.
Reload GETs Session, Scenario and Pending Step; server progress/pending identity
wins over browser storage. 202/503/network retry reuses the same request UUID,
never auto-advances and never infers a financial status. Resource reads follow
all nextCursor pages; fake status acknowledgements are not live executor reads.

ui:smoke uses actual Chromium, a Vite proxy and an unchanged Demo backend on an
owned template0 PostgreSQL fixture with normal DROP/zero-backend verification.
It never uses a persistent DB as its data target. Configure the safe test service
privately and install Playwright Chromium first. No deployment is implemented.

Requirements: Node.js 24+, npm, Docker/Compose and PostgreSQL (repository Compose uses PostgreSQL 18).

1. Install dependencies with `npm ci`.
2. Create a private `.env` from `.env.example` only if one does not already exist. Configure a local DATABASE_URL and the matching Compose POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB. Replace example credentials; never commit secrets.
3. Explicitly select dev-only execution:

   ```dotenv
   NODE_ENV=development
   EXECUTOR_TYPE=fake
   PORT=3000
   ```

4. Start PostgreSQL and apply the existing migrations:

   ```bash
   docker compose up -d postgres_db
   npm run migrate -- up
   npm run dev
   ```

The local server binds port 3000 on 0.0.0.0; use this setup only in trusted local
development. Core's factory rejects production fake and requires explicit dev/test
selection. The separate [Demo-04 profile](DEPLOYMENT.md) requires production Demo,
exact HTTPS origin, secrets and bounded limits, with only protected Demo APIs.
There is no real Airflow adapter. Public launch requires System Owner operation.

Calculation types and published dependency definitions must be configured in PostgreSQL before their corresponding workflows can succeed. There is no management API or general-purpose financial seed. The explicit Demo-02A command above prepares only its minimal CAPEX configuration; integration suites install their own fixtures. A fresh migrated database alone is not a preconfigured financial pipeline.

All six historical core migrations are retained, alongside Demo session, Scenario
and Step ledger migrations. Scenario/ledger down refuses retained data; only empty
tables are reversible. The v2 migration rejects unsafe/ambiguous legacy data and
unsupported down conversions instead of discarding history. Do not edit applied
migrations or delete/truncate a persistent developer database to bypass a guard.

## Verification

Against a dedicated local PostgreSQL test service:

```bash
npm run build
npm run test:milestone
```

On Windows the equivalent commands are `npm.cmd run build` and `npm.cmd run test:milestone`.

Configure TEST_DATABASE_URL, falling back to DATABASE_URL, privately. This is a connection source for the test service, not permission to destroy a persistent application database. The role needs CREATE DATABASE and ownership/DDL/drop privileges for independently owned disposable databases, plus access to the maintenance database `postgres`. Do not use production.

The unchanged milestone runner executes sequentially: build; runner regression tests; schema/migrations; dataset creation; first-run snapshot; dispatch; reconciliation; dataset terminal lifecycle; CON-01/CON-02; focused Task 007B-1; Task 007C contracts; isolated raw ingestion; Task 007D integrated E2E Flow A–F.

Every PostgreSQL suite migrates its own disposable database. The raw-ingestion test is launched through the milestone's isolated wrapper with child-scoped DB URLs and owned teardown. **Do not run the standalone raw-ingestion command against a persistent developer database.**

The gate stops after the first failure, reports remaining commands NOT RUN, and rejects missing/invalid TAP evidence, failures, skips, cancellations or TODOs. A successful exit alone is insufficient for a test suite without valid nonzero passing counters. See the [historical Task 007D report](verification/task-007d-milestone.md) and [Task 007E rerun](verification/task-007e-cleanup.md) for exact revisions, counts and teardown evidence.

## Scope and future work

FakeExecutor is the only implemented adapter: deterministic, in-process, development/test only. External fake runs and identity-rejection tombstones last only for that instance; they are not durable or shared across processes/restarts. It models dispatch acceptance/rejection/response loss and executor status for tests, not real financial computation.

Real Airflow HTTP integration, cancellation, queues, background workers, periodic reconciliation, dependency-management APIs and automatic publication are not implemented. Historical DPR/raw-ingestion schema and the legacy_business_key rollback bridge remain intact.

Accepted decisions: [Architecture](ARCHITECTURE.md), [ADRs](adr/README.md). Engineering/change policy: [AGENTS.md](../AGENTS.md).
