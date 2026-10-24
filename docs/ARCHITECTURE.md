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
COWOS_S
```

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

`npm run test:milestone` runs build and twelve test suites sequentially, including runner-policy regressions, all PostgreSQL lifecycle/constraint/concurrency suites, API contracts, isolated raw ingestion and Task 007D E2E Flow A–F. It stops on the first failure and rejects invalid/missing TAP evidence, skips, cancellations or TODOs. Tests create/migrate/drop independently owned disposable databases; the source TEST_DATABASE_URL/DATABASE_URL must point at a safe test service with CREATE DATABASE and owned DDL/drop privileges. Raw ingestion must use the milestone's isolated launcher, not a persistent developer database. See README for setup and the verification reports for actual results.

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
