# Architecture

## 1. Scope

The Cost Engine Orchestration Platform coordinates versioned cost/financial dataset builds across external Airflow/ETL workflows.

The backend owns orchestration state, reproducibility, concurrency control, dependency resolution, execution identity, reconciliation, and publication lifecycle. It does not implement the financial calculation logic itself.

Representative domains:

```text
FAB_COST
CAPEX
DPR
INSURANCE
ONE_STD_COST
E2E_COST
```

Naming-01 renames the same Domain from `COWOS_S` to `E2E_COST` without an API alias. The guarded forward migration preserves UUID relations, frozen inputs and execution history; see [ADR-0014](adr/0014-canonical-domain-e2e-cost.md).

All domains use the same quarterly reporting identity model, but each domain may define different calculation types, dependency definitions, and Airflow DAG mappings.

## 2. Core Model

```text
Dataset Series
(domain, company_code, fiscal_year, period)
        │
        └── Dataset Versions
              │
              ├── 0..1 Dataset Build Snapshot
              │       └── Frozen Upstream Dataset Versions
              │
              └── 1..N Calculation Jobs
                      │
                      ├── Calculation Type
                      │       └── Versioned Dependency Definitions
                      │
                      └── 0..N Execution Attempts
                              └── External Airflow DAG Runs
```

### Dataset Series

A `dataset_series` is the immutable logical identity:

```text
(domain, company_code, fiscal_year, period)
```

The row is also the publication-visibility/version-allocation coordination root for that logical series.

### Dataset Version

A `dataset_version` is one complete build/publication unit for one dataset series.

Versions are monotonically allocated and never reused. Historical terminal versions remain queryable.

### Calculation Type

A `calculation_type` is a domain-local task definition, for example `DPR / ASSET_SUMMARY`.

It provides stable identity for:

- one required calculation unit inside a dataset version,
- its Airflow DAG mapping,
- its versioned dependency-definition history.

### Calculation Job

A `calculation_job` is one logical calculation task for a specific `(dataset_version, calculation_type)`.

A dataset version snapshots the active calculation-type set at creation time by creating one `PENDING` job per active type.

### Dataset Build Snapshot

A `dataset_build_snapshot` freezes the input identity for the entire dataset version at first Run.

It records:

- the dependency-definition version selected for every calculation job,
- the concrete upstream published dataset version selected for every required upstream series.

Once created, it is immutable application state.

### Execution Attempt

An `execution_attempt` is one concrete dispatch/execution attempt for a calculation job.

A failed job may be retried through a new attempt, but all attempts for the same dataset version continue to consume the same immutable dataset build snapshot.

## 3. Canonical Identity and Versioning

Dataset identity:

```text
UNIQUE(domain, company_code, fiscal_year, period)
```

`dataset_series.last_allocated_version` is only a monotonic allocation counter. It is not a cached latest-published pointer.

Latest usable upstream data is derived from `dataset_versions`:

```sql
SELECT id, version
FROM dataset_versions
WHERE dataset_series_id = $1
  AND status = 'PUBLISHED'
ORDER BY version DESC
LIMIT 1;
```

Rejected or abandoned versions do not reuse version numbers.

## 4. Dataset Lifecycle

```text
DRAFT ─────────────────────→ ABANDONED
  │
  ▼
BUILDING ──────────────────→ ABANDONED
  │
  ▼
VALIDATING
  ├────────────────────────→ PUBLISHED
  └────────────────────────→ REJECTED
```

Meanings:

- `DRAFT`: version and required jobs exist, but the dataset build snapshot has not been frozen.
- `BUILDING`: the build snapshot is frozen and jobs may be pending, running, failed, retried, or completed.
- `VALIDATING`: all required jobs succeeded and the version awaits publication decision.
- `PUBLISHED`: immutable usable dataset version.
- `REJECTED`: complete build rejected during validation/publication review.
- `ABANDONED`: build intentionally stopped before publication readiness.

`PUBLISHED`, `REJECTED`, and `ABANDONED` are immutable terminal states.

A dataset series may have at most one active version:

```text
DRAFT / BUILDING / VALIDATING
```

This is enforced with a partial unique index on `dataset_versions(dataset_series_id)`.

## 5. Calculation Job Lifecycle

```text
PENDING
  │ executor accepted
  ▼
RUNNING
  ├────────→ SUCCEEDED
  └────────→ FAILED
                │ retry
                ▼
              RUNNING
```

A job failure does not make the dataset version terminal. A failed job may be retried within the same dataset version.

A `PREPARED` execution attempt does not change the logical job from `PENDING`; the job becomes `RUNNING` only after executor acceptance is durably recorded.

## 6. Execution Attempt Lifecycle

```text
PREPARED
  │
  ▼
DISPATCHING
  ├────────→ DISPATCH_FAILED
  │
  ▼
ACCEPTED
  ├────────→ SUCCEEDED
  └────────→ FAILED
```

At most one non-terminal attempt may exist for a calculation job:

```text
PREPARED / DISPATCHING / ACCEPTED
```

A stable Airflow `dag_run_id` is generated by the orchestration platform for each attempt before external dispatch.

## 7. Dataset Creation Transaction

Creating a dataset version is one atomic transaction:

```text
find/create dataset_series
→ lock dataset_series
→ verify no active dataset version
→ increment last_allocated_version
→ create dataset_version DRAFT
→ load active calculation_types for domain
→ create all calculation_jobs PENDING
→ commit
```

If no active calculation type exists, the entire transaction rolls back, including the version allocation.

Dataset creation does not resolve dependency definitions, select upstream versions, create snapshots/attempts, or contact Airflow.

## 8. First Run and Build Snapshot Freeze

The first preparation of any job in a `DRAFT` dataset version initializes the entire dataset build.

The first-run lock hierarchy is defined by ADR-0006:

```text
1. calculation_type rows
2. required upstream dataset_series rows
3. output dataset_version row
4. selected calculation_job row
```

Within lock classes:

```text
calculation_type:
(domain, code)

upstream dataset_series:
(domain, company_code, fiscal_year, period)
```

The output `dataset_series` is not locked merely for `DRAFT → BUILDING`; the output `dataset_version` serializes build initialization. Upstream `dataset_series` rows serialize publication visibility.

Within one PostgreSQL transaction:

```text
load immutable dataset/job context
→ lock relevant calculation_type rows in deterministic order
→ resolve latest PUBLISHED dependency-definition version per job
→ compute union of required direct upstream domains
→ derive matching upstream identities using same company/year/period
→ lock required upstream dataset_series rows in deterministic order
→ resolve latest PUBLISHED upstream dataset version for every required series
→ lock output dataset_version and revalidate state
→ if still DRAFT, persist one immutable build snapshot + frozen job definitions
→ DRAFT → BUILDING
→ lock selected calculation_job
→ create/fetch selected PREPARED execution_attempt
→ commit
```

If another transaction initialized the dataset first, the later transaction observes `BUILDING` and reuses the existing snapshot instead of creating a second snapshot or refreshing dependencies.

If any required definition or upstream dataset is unavailable, the transaction rolls back. The dataset remains `DRAFT`, no partial snapshot exists, no partial job-definition set is committed, and no attempt exists.

The commit of this transaction is the dataset-version consistency boundary.

## 9. Dataset-Wide Input Consistency

A dataset version uses one concrete version per upstream dataset series across all jobs.

Example:

```text
DPR v5 snapshot:
CAPEX     → v7
INSURANCE → v3
```

Every DPR v5 calculation job requiring CAPEX uses CAPEX v7. If CAPEX v8 publishes later, later jobs and retries within DPR v5 still use v7.

Using new upstream data requires a new dataset version, not a retry.

```text
retry = execution recovery
new dataset version = new business/data recomputation identity
```

## 10. Versioned Dependency Definitions

Dependencies are platform-owned configuration per calculation type, not caller-provided data.

A dependency definition answers:

> What direct upstream domains does this calculation type require?

Historical dependency-definition versions are immutable. A `PENDING` job does not pin a definition version at dataset creation time. Definition versions are frozen together at the first-run consistency boundary.

A published definition with zero dependency rows is a valid explicit configuration and is different from a missing published definition.

The platform validates only direct upstream requirements for the selected build. It does not recursively require transitive upstream datasets to be the latest.

## 11. Concurrency and Locking

### Dataset Series Coordination

`dataset_series` coordinates operations involving version allocation or publication visibility of one logical series, including:

- version allocation,
- publication/rejection/abandonment ordering where relevant,
- downstream latest-published resolution.

This provides deterministic ordering between upstream publication and downstream snapshot freeze.

### Multi-Series Lock Ordering

When several `dataset_series` rows are required, acquire them in:

```text
(domain, company_code, fiscal_year, period)
```

When several `calculation_type` rows are required, acquire them in:

```text
(domain, code)
```

Always determine the lock set, sort it, then acquire locks. Do not lock dependencies incrementally in arbitrary discovery order.

Cross-lock-class ordering for First Run is defined by ADR-0006 and must not be inverted.

### Execution-State Lock Ordering

When one transaction mutates both logical job state and one execution attempt, acquire locks in:

```text
calculation_job
→ execution_attempt
```

Task-004 dispatch-result recording and Task-005 reconciliation must use the same order. Callback paths that start from external attempt identity first resolve the owning job, then acquire mutation locks in this canonical order.

### Constraints as Backstops

Important invariants are also protected by database constraints, including:

- unique dataset series identity,
- unique `(dataset_series_id, version)`,
- one active dataset version per series,
- one build snapshot per dataset version,
- one job per `(dataset_version, calculation_type)`,
- one frozen version per upstream series per snapshot,
- one active execution attempt per job,
- stable unique Airflow run identity.

The platform does not use PostgreSQL `SERIALIZABLE` as the default concurrency strategy.

## 12. Airflow / ETL Boundary

Do not call Airflow while holding a PostgreSQL transaction that owns orchestration locks.

Dispatch flow:

```text
DB transaction A: prepare/fetch durable PREPARED attempt
→ commit
→ DB transaction B: mark/reuse DISPATCHING and read frozen dispatch command
→ commit
→ executor.dispatch (currently FakeExecutor, not a real Airflow HTTP adapter)
→ DB transaction C: record accepted/rejected/unknown result
→ commit
```

### Dispatch Outcomes

Definite rejection is **identity-scoped and irrevocable** under ADR-0008. For the exact `(airflow_dag_id, airflow_dag_run_id)`, REJECTED guarantees that no external execution exists **and none can be created later by another same-identity dispatch**. It is not merely a per-request no-run observation. An executor/adapter unable to enforce this guarantee must return UNKNOWN instead.

```text
definite identity-wide REJECTED
→ attempt DISPATCH_FAILED
→ job remains PENDING or FAILED
```

The FakeExecutor demonstrates this contract via a rejection tombstone keyed by full execution identity within one fake instance. It is **not** cross-process persistence or a real Airflow guarantee. The accepted executor semantics remain independent of whether a future adapter can implement definite rejection.

Unknown outcome, such as timeout/response loss:

```text
attempt remains DISPATCHING
reuse same attempt identity and dag_run_id
reconcile; do not create a fresh attempt
```

Duplicate `dag_run_id` is an idempotency/recovery signal, not automatically a dispatch failure.

Confirmed ACCEPTED or ALREADY_EXISTS atomically records ACCEPTED + RUNNING. PREPARED/DISPATCHING alone does not make a PENDING or FAILED job RUNNING. UNKNOWN normally returns 202 with the same DISPATCHING identity; a concurrent confirmation or terminal reconciliation is never regressed. Task 007B-1 preserves an already reconciled terminal attempt when a late non-rejection dispatch response arrives, including after dataset lifecycle advancement or a newer retry. Contradictory state remains an internal invariant failure, not a history rewrite.

### Reconciliation

Airflow callbacks are reconciliation triggers, not authoritative success/failure payloads.

The reconciliation service queries executor state using stored execution identity. Callback-triggered, manual, and future periodic reconciliation share the same state-mapping path.

Executor lookup occurs outside PostgreSQL transactions. After lookup, local job/attempt state is locked and revalidated before any mutation.

Executor availability or not-found responses do not convert a running financial calculation into `FAILED` and do not convert ambiguous `DISPATCHING` into `DISPATCH_FAILED`.

A `DISPATCHING` attempt may be recovered directly from executor truth: external RUNNING confirms local `ACCEPTED + RUNNING`; external terminal state may converge directly to local terminal state using the same attempt identity.

Only confirmed executor terminal state produces atomic terminal attempt/job transitions. Stale callbacks for older terminal attempts must not overwrite a newer attempt's logical job state, and contradictory terminal observations are treated as reconciliation anomalies rather than history rewrites.

## 13. Validation and Dataset Terminal Decisions

Job execution completion does not automatically advance dataset publication state.

Explicit Submit Validation is required:

```text
BUILDING
+ one or more calculation_jobs
+ every calculation_job SUCCEEDED
→ VALIDATING
```

Submit Validation serializes on:

```text
dataset_version
→ calculation_jobs ordered by id
```

Eligibility is checked only after those locks are held. This gives deterministic ordering against Task-005 reconciliation of the final job.

From `VALIDATING`:

```text
Publish → PUBLISHED
Reject  → REJECTED
```

Publish, Reject, and Abandon use the series terminal-decision protocol:

```text
dataset_series
→ dataset_version
```

Publish participates in this protocol because it changes which version downstream First Run operations can resolve as latest `PUBLISHED`. Reject and Abandon also use it because they release the one-active-version slot and must serialize with next-version creation.

Publish-vs-Reject has exactly one terminal winner.

Abandon allows only:

```text
DRAFT    → ABANDONED
BUILDING → ABANDONED
```

Before abandonment, lock:

```text
dataset_series
→ dataset_version
→ calculation_jobs ordered by id
→ execution_attempts ordered by (calculation_job_id, attempt_number)
```

Any attempt in:

```text
PREPARED
DISPATCHING
ACCEPTED
```

blocks abandonment. Terminal attempt states do not.

Task 006 does not cancel external execution. If an external run exists, local state must first converge to a terminal attempt through normal reconciliation.

Lifecycle commands use same-target idempotency:

```text
already VALIDATING + submit-validation → 200 current state
already PUBLISHED  + publish           → 200 current state
already REJECTED   + reject            → 200 current state
already ABANDONED  + abandon           → 200 current state
```

Conflicting terminal decisions return `STATE_CONFLICT` and never rewrite terminal history.

After dataset lifecycle advancement, duplicate reconciliation of an already-terminal attempt remains idempotent when executor truth matches the local terminal result. Non-terminal attempts under a non-`BUILDING` dataset are invariant violations.

## 14. API Error Model

Expected business/concurrency failures use stable error codes rather than generic `500` responses.

Representative codes:

```text
INVALID_REQUEST
INVALID_DOMAIN
INVALID_PERIOD
CALCULATION_JOB_NOT_FOUND
ACTIVE_DATASET_VERSION_EXISTS
CALCULATION_TYPE_NOT_CONFIGURED
DEPENDENCY_DEFINITION_NOT_READY
DEPENDENCY_NOT_READY
JOB_NOT_RUNNABLE
DATASET_VERSION_NOT_FOUND
DATASET_NOT_READY_FOR_VALIDATION
DATASET_HAS_ACTIVE_EXECUTION
STATE_CONFLICT
EXECUTOR_DISPATCH_FAILED
EXECUTION_ATTEMPT_NOT_FOUND
EXECUTION_NOT_RECONCILABLE
EXECUTOR_STATUS_UNAVAILABLE
```

Handled API errors use the flat response `{ "message": "...", "code": "..." }`. Expected codes have route-level coverage across the PostgreSQL suites; the Task 007C coverage inventory is in `docs/tasks/007c-api-error-contract-coverage.md`. Executed suite evidence, rather than that inventory alone, is recorded in the Task 007D/007E verification reports.

Request errors use 400 (INVALID_REQUEST/INVALID_DOMAIN/INVALID_PERIOD); framework body-size/media errors use 413/415 with INVALID_REQUEST. Missing resources use 404, readiness/state conflicts use 409, definite dispatch rejection uses 502, and unavailable executor truth uses 503. Unexpected/invariant failures are logged and return 500 INTERNAL_SERVER_ERROR without exposing PostgreSQL details. Supported raw ingestion additionally returns 409 ACTIVE_RAW_INGESTION_BATCH_EXISTS; dev/test fake controls return 404 FAKE_EXECUTION_NOT_FOUND when no unique fake run is found. Unregistered routes retain Fastify's normal 404 envelope.

## 15. Testing Strategy

Critical transaction and concurrency behavior must run against real PostgreSQL.

Task 003 must prove snapshot consistency and lock ordering using real concurrent transactions; mocked repositories are insufficient for those guarantees.

Executor-facing tasks use an abstraction:

```text
CalculationExecutor
├── FakeExecutor    implemented (development/test only)
└── Airflow adapter future work, not implemented
```

`FakeExecutor` enables deterministic coverage for accepted/rejected dispatch, unknown dispatch outcome, duplicate run identity, execution success/failure, retry, reconciliation, and terminal dataset flows. Fake control routes must never be enabled in production.

The factory requires explicit EXECUTOR_TYPE=fake and an approved development/test environment; production configuration fails fast. Fake executions and identity-rejection tombstones are in-process, instance-lifetime state, not cross-process/restart durability or proof of real Airflow behavior. Callback/manual reconciliation is implemented; a periodic worker is not.

`npm run test:milestone` runs build and thirteen test suites sequentially, including runner-policy regressions, all PostgreSQL lifecycle/constraint/concurrency suites, API contracts, isolated raw ingestion and Task 007D E2E Flow A–F. It stops on the first failure and rejects invalid/missing TAP evidence, skips, cancellations or TODOs. Tests create/migrate/drop independently owned disposable databases; the source TEST_DATABASE_URL/DATABASE_URL must point at a safe test service with CREATE DATABASE and owned DDL/drop privileges. Raw ingestion must use the milestone's isolated launcher, not a persistent developer database. See README for setup and the verification reports for actual results.

## 16. Current Implementation Sequence

```text
1. Schema/migration and persistence invariants                         MERGED
2. Dataset version creation + calculation-type job snapshotting       MERGED
3. First Run + immutable build snapshot                               MERGED
4. Execution attempts + FakeExecutor                                  MERGED
5. Reconciliation                                                     MERGED
6. Validation / Publish / Reject / Abandon                            MERGED
7. End-to-End Hardening and Legacy Cleanup                            COMPLETE; ACCEPTED; MERGED
```

The completed milestone specification is:

```text
docs/tasks/007-end-to-end-hardening-and-legacy-cleanup.md
```

Accepted main baseline: `1f441eb6e430ba2acd0078cf9ce48045cfeb6e67` (Task 007E merge, PR #12). Tasks 007A–007E, including B-1/B-2 remediation, API hardening, integrated verification and safe cleanup/documentation, are merged. Historical red investigation results describe the before-fix system, not the current regression expectation.

Task 007 is COMPLETE and Orchestration Core v2 is ACCEPTED by the System Owner; architecture defense PASSED. The [final acceptance record](verification/task-007-final-acceptance.md) records the 2026-10-16 approval, accepted limitations and precise verification boundary. The original D/E reports remain unchanged. This is implementation-status synchronization only: accepted state machines, transaction/lock protocols, identities and historical migrations are unchanged, and this documentation-only closure awaits its own review/merge.

## 17. Decision Records

The rationale and alternatives behind the major decisions above are recorded in `docs/adr/`.

## 18. Current Runtime/API Surface

The routes below describe the default `APP_MODE=core` surface. Explicit Demo
runtime registration is described in section 19; it does not change these
services or their accepted lifecycle/locking protocols.

The server explicitly configures its executor before building the app. Registered supported routes are GET /health; POST /dataset-versions; POST /dataset-versions/:datasetVersionId/submit-validation, /publish, /reject and /abandon; POST /calculation-jobs/:jobId/run and /reconcile; POST /executor-callbacks/airflow; and POST /raw-ingestion-batches. Run/reconcile/callback registration requires an injected executor. The full route table is in README; no read/list APIs are implemented.

With an injected FakeExecutor and explicitly approved development/test environment only, POST /internal/fake-executor/executions/:dagRunId/succeed and /fail set in-memory fake state. These controls neither reconcile local state automatically nor provide a production execution adapter. Legacy calculation-job creation/start/validation/publication/rejection/failure mutation routes are not registered.

Raw ingestion remains a separate supported transactional allocation workflow for FAB_COST_RAW, CAPEX_RAW and DPR_RAW. Its domain/businessKey request, 201 LOADING-batch response and 409 active-batch conflict are retained; its business key is not canonical dataset-series identity. No raw-ingestion architecture or historical data retirement is part of the orchestration cleanup.

## 19. Demo Session API and Executor Isolation

Demo-01A supplies durable four-hour cookie sessions and ownership/coordinator
foundations. Demo-01B-1 adds the explicit `APP_MODE=demo` boundary accepted in
[ADR-0009](adr/0009-demo-session-api-and-executor-boundary.md). Unset mode is
core; only exact core/demo values are accepted, and conflicting/unknown mode
configuration fails startup. Demo FakeExecutor remains development/test only:
production cannot be enabled through conflicting injected options.

Demo mode registers health, session APIs and protected `/demo` dataset creation,
dataset lifecycle, job Run/Reconcile and fake controls only. Original anonymous
Domain writes, raw ingestion, executor callbacks and internal fake controls
are not registered in that mode. Core registration remains supported unchanged.
Demo-02A adds protected, coordinated GET reads; see section 21. The existing
mutation route/body/response inventory lives in
[Demo-01B-1](tasks/demo-01b1-session-ownership-executor-isolation.md).

Every protected mutation authenticates a durable session and applies the shared
CSRF policy used by session creation. In one session coordinator operation it
revalidates eligibility, checks persisted resource ownership and calls the
existing Domain service. Missing/foreign resources share a generic 404; no
caller companyCode or execution identity grants ownership. Creation takes only
domain/year/period and injects the authenticated session's companyCode.

A runtime-owned registry gives each session a distinct FakeExecutor reused by
Run/Retry/Reconcile/controls. Its execution state, scripts, history and permanent
identity rejections are never shared across sessions. State controls accept an
owned attempt UUID, resolve its full external identity from PostgreSQL, and
mutate only the fake; reconciliation remains the DB execution-result authority.
No accepted transaction/lock order changes and no SQL transaction spans an
executor wait. Registry allocation is bounded, with no eviction that could lose
execution/rejection history.

Isolation applies to one correctly configured Demo runtime, not an anonymous
core app sharing that data. Expiry/revocation denies future/queued admissions
without cancelling admitted executor work. Demo remains **unsuitable for direct
public internet deployment**. Demo-01B-2 adds the bounded recovery below.

## 20. Demo Reset and Restart Recovery

[ADR-0010](adr/0010-demo-session-reset-and-recovery.md) extends only the Demo
data lifecycle, not financial state transitions. POST /demo/sessions/reset
authenticates, checks CSRF and accepts exactly {}. The coordinator synchronously
reserves an idle session without queuing; active/queued commands or another
reset conflict. New commands reject while reserved. An idle RUNNING calculation
does not prevent reset and is never falsely marked terminal.

One transaction locks/revalidates the session, deletes its complete company-owned
v2 and legacy DPR child graph in FK order, then revokes the session. Foreign
snapshot references cause rollback, not wider deletion. Shared types/definitions,
assets, raw ingestion, other owners and session/migration history remain intact.
Only after commit is the owner's fake released and its HttpOnly cookie cleared.
Confirmed rollback preserves the fake and permits retry. An unknown COMMIT holds
admission blocked: a separate connection locks the session before reading durable
revocation and, in a fresh SQL statement, remaining owned data. If unavailable,
return 503 and retain blocking for controlled recovery. No executor call or core
state-machine/lock protocol is changed.

Real Demo server startup invalidates previous sessions before listening and fails
closed on invalidation failure. buildApp has no startup side effect. This avoids
pretending lost in-memory fake runs survived restart. Bounded service-only
maintenance retries uncertain outcomes, cleans inactive owners with the same SQL
and reclaims inactive fakes; failures/pending work are logged without credentials.
Default batch is 50 (maximum 1000) recovery entries and inactive owners per call.
Retained session rows prevent identity reuse. Operators must repeat maintenance
while work remains; there is no background worker. See the
[B2 task and verification](tasks/demo-01b2-session-reset-recovery.md).
This remains single-instance, development/test only, with no distributed recovery,
frontend, scenario runner, real Airflow or production deployment guarantee.

## 21. Demo Shared Configuration and Durable Reads

Demo-02A supplies an explicit `seed:demo-guided` developer command, never startup
or session side effects. It requires Demo development/test mode and a separate
explicit DEMO_SEED_DATABASE_URL. One transaction creates or verifies only active
CAPEX/DEMO_GUIDED_SUMMARY, demo_capex_guided and published zero-dependency version
1 with counter 1. Existing incompatible configuration or other active CAPEX types
fail closed; published history and session-owned data are never rewritten.

Demo-only GET dataset list/detail, dataset Job list, Job detail and Attempt list
authenticate cookies and enter the same coordinator as mutations. Durable joins
enforce ownership; generic 404 hides missing/foreign IDs. Each response uses one
SQL snapshot, explicit public fields and bounded keyset pagination. GET requires
no mutation header, retains Origin/cookie restrictions and no-store, and never
consults FakeExecutor. Reset reservations block reads; admitted/queued reads
block Reset under existing busy rules. No core lifecycle/lock, executor, session
policy or historical migration changes. No Scenario Runner is implemented.
See [Demo-02A contracts, compatibility, index review and evidence](tasks/demo-02a-shared-seed-read-apis.md).

Demo-05A adds an optional explicit `seed:demo-six-domain` command. Its single
transaction preserves the CAPEX guided contract and adds the five requested
domain configurations with published direct dependencies. It creates no user
data and performs no startup work; existing incompatible configuration fails
closed. This is Demo fixture data, not a hard-coded Core domain pipeline.
See [the bounded configuration and verification task](tasks/demo-05a-six-domain-configuration.md).

## 22. Demo Scenario Persistence and Mode Isolation

Demo-02B adds one Scenario per durable session, enforced by UNIQUE(session_id),
restrictive session FK and type/status/nonnegative completed-step checks.
Only HAPPY_PATH is creatable, as READY/0. Create/Get share existing session
authentication, cookie/Origin/CSRF rules and coordinator. Create locks and
revalidates the session, returns an existing same-type Scenario idempotently,
or checks compatible read-only configuration and an empty owner graph before
inserting. It never seeds or changes progress. Unknown Create COMMIT is retried
through the same session lock and durable lookup, not assumed rollback.

Manual Demo domain/fake mutations reject guided sessions inside the existing
queue. Their short session-lock admission ends before Domain services/executor
work. Reads and Reset remain available. Reset deletes Scenario and domain data
and revokes in its existing transaction. Recovery checks BOTH remaining graph
and Scenario after the durable session lock; maintenance includes Scenario-only
inactive owners. Startup still invalidates old credentials without recreating
fake state. No core lifecycle/lock/executor or applied migration changes.
Demo-02B alone implements no steps; section 23 adds the bounded Demo-02C slice.
See [ADR-0011](adr/0011-demo-scenario-persistence-and-mode-isolation.md) and
[Demo-02B contracts and evidence](tasks/demo-02b-scenario-persistence.md).

## 23. Demo Happy Path Step Execution

Demo-02C extends section 22 with explicit Next and owned pending-step GET, not
automatic orchestration. Domain state, Scenario progress, Step ledger state and
external fake state remain distinct. Transaction A freezes a PENDING intent;
commit before calling existing Domain services. Transaction B atomically saves
the verified step result and progress. No Scenario transaction spans an executor
call. Durable ledger lookup precedes progress validation for original-result
replay. Unknown COMMIT discards the suspect socket and confirms on a fresh locked
connection; unknown truth fails closed. Recovery binds exact version 1, its one
guided job, immutable snapshot/definition and sole stable attempt, not latest data.
PostgreSQL checks/uniques and owner/parent validation protect ledger history.

Steps explicitly create, Run, set own fake success, reconcile, submit validation
and publish. Fake success alone does not change the DB. Already successful Domain
facts fill progress without repeating work. UNKNOWN dispatch stays PENDING/202
with the same attempt; definite rejection never creates a second Happy Path
attempt on retry. Existing financial state machines and lock protocols are reused.
Reset deletes ledger before Scenario and the domain graph in the same transaction;
unknown recovery/maintenance include retained ledgers. Startup invalidation and
single-instance/no-external-writer limits remain. No other Scenario/UI/background
runner is added. See [ADR-0012](adr/0012-demo-scenario-step-idempotency.md) and
[contracts, recovery and evidence](tasks/demo-02c-happy-path-step-execution.md).

## 24. Demo Failure and Retry

Demo-02D extends the same Step protocol with FAILURE_RETRY, not another ledger or
core Retry implementation. Six-step HAPPY_PATH remains intact. FAILURE_RETRY has
nine steps: create, Run, fake failure, reconcile failure, Retry, fake success,
reconcile success, validation and publication. A confirmed failed Job is an
expected IN_PROGRESS/4 result. Only final publication completes the Scenario/9.

Retry intent freezes the same dataset/job/snapshot/definition, failed Attempt 1
and its complete terminal history, and expected Attempt number 2. Existing core
Run creates the new identity. Accepted recovery only fills progress; ambiguous
dispatch reuses Attempt 2, while rejection never allocates Attempt 3. Later steps
bind only Attempt 2 and preserve Attempt 1 unchanged. No Domain status SQL or
executor call is added inside Scenario transactions. Existing Reset handles both
Attempts in its original atomic owner cleanup. A forward migration validates
type-specific step/result/binding rules in PostgreSQL and retains the exact 02C
validator for supported down; any retained Failure Retry Scenario blocks down.
No applied migration, core state machine, executor, lock or session policy change.
See [Demo-02D contracts and verification](tasks/demo-02d-failure-retry-scenario.md).

## 25. Demo Lost Dispatch Response Recovery

Demo-02E adds LOST_RESPONSE_RECOVERY within the same six-step/sole-Attempt-1
protocol as Happy Path. Only its Step 2 uses a stateless Demo executor decorator:
delegate to the session fake first, convert only actual ACCEPTED to UNKNOWN,
preserve ALREADY_EXISTS/REJECTED/UNKNOWN and delegate status lookup unchanged.
This simulates executor acknowledgement loss after real external creation, not
browser response loss. It enqueues no fake behavior and owns no mutable state.

Core persists the Attempt and full DAG/run identity before dispatch; PENDING
ledger intent binds its sole Job. Exact durable relational binding and the core
identity convention govern recovery. First UNKNOWN stays PENDING/202 at progress
1; same request reuses DISPATCHING, and ALREADY_EXISTS confirms ACCEPTED/RUNNING
before Step 2 completion. No second attempt, Job, snapshot or dataset version.
Subsequent steps bind the original UUIDs/full identity. Original-result replay,
fresh-connection A/B confirmation, separate Domain commits, session isolation and
Reset/restart rules are unchanged. No transaction spans an executor call.

Review admission hardening also requires no allocated session fake for FIRST
Scenario creation. Prior manual behavior can exist without a Dataset; reject it
with DEMO_SCENARIO_SESSION_NOT_EMPTY rather than clearing execution/rejection or
script history. Existing-Scenario lookup remains first, so Create replay never
resets an active or completed Scenario's fake. Reset/new Session is the supported
path from prior manual fake use to any new Guided Scenario.

A new forward migration adds E-specific six-step success/one-attempt validation
while preserving Happy/Failure rules. Supported down restores the exact prior
validator, preserving both histories; any retained E Scenario blocks rollback
atomically. Core Run, state machines, executor interface, applied migrations,
security and lock ordering are unchanged. Single instance, development/test and
no external writer limits remain. See [contracts and PostgreSQL evidence](tasks/demo-02e-lost-response-recovery.md).

## 26. Demo Frontend Presentation

Demo-03 adds a separate React/TypeScript/Vite application under frontend/ with
React Router, Tailwind CSS and Vitest/RTL. It is a view and explicit command
client for existing protected Demo APIs, not a second orchestration engine.
No backend source, migration, canonical identity, lifecycle, ledger, executor,
ownership, transaction, lock or Reset protocol changes.

The browser manages HttpOnly credentials; fetch uses include and every Demo POST
uses the existing CSRF header. The local Vite proxy preserves browser Host/Origin.
Session start and all mutations are explicit. Confirmed Reset clears only UI
state/request scope after 204; failure/unknown outcome is retained visibly.

Only non-sensitive session/scenario/step/request UUID mappings enter localStorage,
before Step POST. Same-step retries and reloads reuse the server's pending ID.
Latest Scenario GET progress is authoritative even after original-result replay
or lost HTTP responses. 202 is pending; 503 is unknown; neither implies failure,
rollback, a new attempt or permission to auto-advance. Domain cards use read DTOs,
including all opaque cursor pages. A fake acknowledgement is not live monitoring
or a reconciled DB result. Guided/manual isolation remains backend-enforced.

Mock UI tests and a real Chromium/Vite/Backend smoke against an independently
owned PostgreSQL database verify the interface. Genuine screenshots are retained.
Single-instance/development-only limits remain. No public deployment, background
polling, new calculation logic or Demo-04 work. See [Demo-03](tasks/demo-03-frontend-ui.md).

## 27. Restricted Public Demo Deployment

Demo-04 extends only the deployment boundary under [ADR-0013](adr/0013-restricted-public-demo-deployment.md).
Earlier development-only statements describe their original slices; Core's fake
factory remains development/test only. An explicit production Demo profile checks
mode, executor, exact HTTPS origin, secrets and bounded limits before DB/runtime.
Caddy alone exposes HTTPS/static React; private networks isolate Node/PostgreSQL 18.
Trusted proxy headers, host cookie, Origin/CSRF, no-store and bounded rate/body/
session/executor/queue controls protect the existing Demo-only surface.

Session admission serializes capacity check/insertion in a PostgreSQL transaction.
Core lifecycle/locks, immutable snapshot, executor contract and migrations do not
change. Periodic bounded non-overlapping cleanup reuses existing Reset/recovery,
preserves session history and never reconciles financial state. Retained-session
capacity fails closed before unlimited audit-row growth. Stop/start deployment
uses one fixed container identity and invalidates previous credentials before
readiness; no external writer or arbitrary multi-instance guarantee. Startup only
verifies migrations/seed; explicit offline tools perform authorized changes.
See [operations, backup/restore, rollback and limits](DEPLOYMENT.md). Capability
and local test evidence do not claim actual public VPS/DNS/TLS launch.

## 28. Demo Session Concurrency Gate

Demo-05B-1 supplements the earlier single-queue descriptions under
[ADR-0015](adr/0015-demo-session-concurrency-gate.md). The same session can execute
four Parallel operations: manual Dataset creation/lifecycle and protected reads.
Slots include waiting/revalidation and are reserved before any await; the fifth
is immediately rejected with 429 DEMO_SESSION_QUEUE_FULL. Scenario Create,
Guided Next, legacy Run and Fake controls use the existing bounded Exclusive
FIFO. An Exclusive waits for all earlier operations and prevents later Parallel
work from overtaking it. Guided request/ledger/retry semantics remain unchanged.

Reset still requires an entirely idle session, including queued operations, and
reserves admission synchronously. Its 409/unknown-503 blocking and fresh-connection
recovery are unchanged. All operations revalidate eligibility at execution and
retain ownership/security checks. No extra SQL lock spans a gate wait or executor
call. Same-series creates now contend directly through the unchanged Core
PostgreSQL series protocol. This remains single-instance local admission, not
distributed coordination. See [scope and executed tests](tasks/demo-05b1-session-concurrency-gate.md).

## 29. Per-Request Demo Fake Simulation

Demo-05B-2 adds an optional simulation to the protected manual Run route under
[ADR-0016](adr/0016-request-scoped-demo-simulation.md). Explicit simulated Runs
and Reconcile use Parallel admission; empty-body legacy Runs and Fake controls
remain Exclusive. Guided Scenario execution and Reset barriers are unchanged.

Each request adapter delegates to the single session fake without consuming its
shared behavior queue or changing its default. The first actual creation or
identity-wide rejection selects immutable simulation metadata. Existing runs
recover through ALREADY_EXISTS, retaining their live state and original settings.
Responses distinguish requested from applied settings; unknown prior settings
are reported as unknown, never guessed. UNKNOWN_WITHOUT_CREATION leaves the
identity unbound and recoverable. Rejection is deferred as UNKNOWN while earlier
no-run UNKNOWN outcomes are still recording, avoiding a late ambiguous write
after terminal DISPATCH_FAILED without changing Core invariants.

Completion controls only external Fake state. The unchanged Core Reconcile
service remains the sole authority for terminal PostgreSQL job/attempt changes.
No Core transaction/lock order, snapshots, identity contract, migration, Session
ownership/security, or Guided ledger changes. See [API and verification](tasks/demo-05b2-per-request-fake-executor.md).

## 30. Read-only Workflow Template Catalog

Demo-05C-1 adds developer-authored TypeScript descriptions for HAPPY_PATH,
FAILURE_RETRY, LOST_RESPONSE_RECOVERY and SIX_DOMAIN_WORKFLOW. Stable Template
and Step IDs, positive integer versions, valid local prerequisites and acyclic
graphs are validated in memory. Definitions and their nested arrays are frozen.
Static definitions remain PREVIEW. Demo-05C-3C projects response availability from
the PostgreSQL Gate and provides the explicit Workflow UI described in section 34.

Demo-only GET /demo/workflow-templates returns ordered summaries; GET
/demo/workflow-templates/:id returns the full definition. Both retain durable
cookie authentication, Same-Origin checks, no-store and Parallel admission under
ADR-0015. GET needs no mutation CSRF header. Unknown IDs use the existing generic
404; extra query parameters are rejected. Session authentication/revalidation
still reads PostgreSQL, but catalog contents are independent of database state
and require no seeded configuration. Reads do not allocate a FakeExecutor or
inspect/change Domain, Scenario, Guided ledger or Session state.

The current v2 six-domain guide describes publication-first order FAB_COST → CAPEX → DPR,
FAB_COST → INSURANCE and FAB_COST → ONE_STD_COST → E2E_COST. Upstream publication
is a prerequisite of downstream creation. These teaching prerequisites describe
the Workflow configuration after ADR-0018 cutover. The unchanged Legacy seed
retains CAPEX's zero-dependency v1 for Legacy Guided fixtures. Core resolves
published inputs at first Run; the guide selects no fixed Dataset version and
requires every Job in each Dataset to be processed before validation/publication.
There is no executor, progress store, operation history, second state machine,
new schema or start/next endpoint. No accepted architecture decision is replaced;
this bounded read API follows ADR-0011/0012/0015/0016 without extending their
execution protocols. See [contract and verification](tasks/demo-05c1-workflow-template-catalog.md).

## 31. PostgreSQL Legacy Admission Drain

Demo-05C-2 adds one durable admission-control row under
[ADR-0017](adr/0017-demo-admission-drain.md). LEGACY_OPEN → DRAINING is irreversible;
database constraints/triggers protect the singleton, legal states and transition
timestamp. Missing or unreadable Gate state fails new admission closed.

New Session creation always uses a transaction, including without capacity limits:
Gate FOR SHARE → optional capacity table lock/check → allocation → confirmed
COMMIT → Cookie. Ambiguous COMMIT discards the socket and issues no Cookie.
Existing valid-cookie bootstrap replay only authenticates, retaining its original
identity/lifetime. Scenario Create uses Gate FOR SHARE before the Session row lock,
then reloads durable Scenario state: same-type replay works in DRAINING, another
type still conflicts, and only an absent Scenario needs LEGACY_OPEN. Existing
unknown-COMMIT retry/reload rules and Step ledger are unchanged.

The trusted status/drain CLI requires an explicit Demo DB target. Drain locks that
same row FOR UPDATE through COMMIT; it waits for earlier admissions and prevents
later inserts. Concurrent/repeated drain preserves the first timestamp. Unknown
COMMIT is resolved on a genuinely separate connection using the conflicting row
lock and a fresh durable read, or remains explicitly unknown. No public admin API
or reopening command exists. Guided/manual work, Reset, expiry/revocation and the
Parallel/Exclusive coordinator rules do not acquire or change this Gate.

First installation must preserve the old running Backend while new admission is
stopped at a verified replay-aware entrypoint. Backend authentication, not mere
Cookie presence, decides whether bootstrap is a valid replay. Startup revocation
means updating/restarting while existing Sessions remain is unsafe. Keep ingress
closed across update, migration and confirmed drain. An unaware rollback binary
cannot safely reopen traffic. No active-count query alone proves quiescence or
authorizes CAPEX cutover; Demo-05C-3 remains separate. See the
[deployment runbook and verification](tasks/demo-05c2-legacy-admission-drain.md).

## 32. Atomic Demo Workflow Configuration Cutover

Demo-05C-3A adds an offline trusted status/cutover CLI under
[ADR-0018](adr/0018-demo-workflow-configuration-cutover.md). A forward migration
extends the same singleton to LEGACY_OPEN → DRAINING → WORKFLOW_OPEN without
resetting it. New Sessions accept either open state; new Legacy Scenarios accept
only LEGACY_OPEN. Existing Scenario replay and Guided recovery remain unchanged.
Old drain rejects WORKFLOW_OPEN. The 3A slice kept Templates PREVIEW; section 34
adds Gate-derived UI availability. No Workflow runner is activated.

One transaction locks Gate, configuration and owned-data tables in explicit order,
verifies quiescence predicates and the exact nine-Type legacy catalog, preserves
CAPEX/DEMO_GUIDED_SUMMARY published v1, inserts its FAB_COST-dependent published v2,
and adds DEMO_CAPEX_TABLE_Y with published FAB_COST-dependent v1. Only after exact
ten-Type target verification does it set WORKFLOW_OPEN and COMMIT. Other Domains
are untouched. Startup validates the target in WORKFLOW_OPEN and retains legacy
compatibility checks otherwise. Core creation/snapshots/Run/Retry/Reconcile do not change.

WORKFLOW_OPEN+exact target is read-only ALREADY_APPLIED; inconsistent states fail
closed without repair. Ambiguous COMMIT destroys the suspect socket and acquires
the same locks on an independent connection before checking all durable settings.
Only target+WORKFLOW_OPEN confirms success, legacy+DRAINING confirms NOT_APPLIED;
unavailable truth remains UNKNOWN. Down refuses completed/partial target changes.
Backend shutdown, finished requests, no external writers and reviewed backup/
rollback are operator-proven prerequisites; SQL counts cannot establish them.
No automatic cleanup or production cutover is performed. See
[operator/runbook/verification](tasks/demo-05c3a-configuration-cutover.md).

## 33. Six-Domain Workflow Verification and Template v2

Demo-05C-3B verifies existing Demo APIs against a disposable PostgreSQL database:
all latest migrations → six-domain Legacy seed → Admission Operator drain →
Cutover Operator → WORKFLOW_OPEN → HTTP Session creation. No SQL state edits
simulate a cutover or execution. Six published Datasets contain ten Jobs:
FAB_COST 1, CAPEX 2, INSURANCE 1, ONE_STD_COST 2, DPR 2, E2E_COST 2. Each input
uses the same Session/company/year/period and the configured published upstream.
Missing or mismatched upstreams retain the existing DEPENDENCY_NOT_READY contract
and roll back all snapshot/definition/attempt initialization.

CAPEX's summary uses published Definition v2 and TABLE_Y uses v1, both requiring
FAB_COST. Its two Jobs and Retry share one immutable snapshot even after a newer
FAB_COST publication; a new CAPEX version can select the newer input. Lost ACK
recovery confirms the original execution identity/attempt. PostgreSQL row-lock
barriers and observed blocking PID chains prove competing first Runs and both
Publish/First Run orderings without changing Core locks or using timing guesses.

All four static Templates are now version 2 and remain PREVIEW. The first three
publish FAB_COST first and require the complete paginated CAPEX Job set; failure
retries only the selected Job, recovery reuses its original Attempt. Existing
Step IDs are retained with additive prerequisite/other-Job steps. No historical
catalog store, progress, runner, UI activation, new API or schema is introduced.
Legacy Guided regressions retain separate Legacy fixtures. See
[scope and test evidence](tasks/demo-05c3b-six-domain-workflow-verification.md).

## 34. Workflow Explorer and Browser Recovery

Demo-05C-3C adds `admissionState` to the existing authenticated catalog list.
Each list/detail response reads Gate from PostgreSQL: LEGACY_OPEN/DRAINING means
PREVIEW and WORKFLOW_OPEN means AVAILABLE. Missing/unreadable Gate fails closed
with sanitized 503. Static v2 definitions, Gate transitions and mutation admission
transactions are unchanged. These GETs retain Cookie/Same-Origin/Parallel/Reset
security and allocate no business state or Fake. Separate reads are observations,
not a single cross-request snapshot.

The browser starts neutrally without a Session. After authentication it chooses
Guided in LEGACY_OPEN, existing Guided only in DRAINING, or Workflow Explorer in
WORKFLOW_OPEN. Old Guided URLs redirect safely in Workflow mode without Create.
Availability failures disable mode operations. Free Exploration and Workflow share
the existing owner-scoped resource graph and add no mode lock. Existing Guided
ledger and recovery remain on their supported Legacy configuration.

Template/Step/Operation/Domain/prerequisite/expected-result data comes from Backend.
The UI renders explicit individual Job actions; users select Dataset versions,
not an assumed first/latest version. URL bindings are non-secret navigation hints
validated against the freshly read current Session/domain/year/period. Complete
paginated Dataset/Job/Attempt reads drive current evidence; the UI explicitly
disclaims cross-page atomicity and never persists completed Workflow steps.
Fake success is not durable completion, DISPATCHING is unknown and only Dataset
PUBLISHED means publication. Retry targets one failed Job; lost ACK Recovery calls
existing Run for the original Job. Network errors refresh by GET without retrying
POST. Reload and returns from Free Exploration reconstruct verified state. Reset/
401 clear caches/selections; Cookie/token/Fake internals are never stored by UI.
Browser recovery does not claim Fake durability across Backend restart. See
[contracts, deployment boundaries and evidence](tasks/demo-05c3c-workflow-ui.md).
