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
DB transaction: prepare/fetch durable attempt and mark DISPATCHING
→ commit
→ external Airflow HTTP call
→ DB transaction: record accepted/rejected result
```

### Dispatch Outcomes

Definite rejection, with certainty that no executor run was created:

```text
attempt → DISPATCH_FAILED
job remains PENDING or FAILED
```

Unknown outcome, such as timeout/response loss:

```text
attempt remains DISPATCHING
reuse same attempt identity and dag_run_id
reconcile; do not create a fresh attempt
```

Duplicate `dag_run_id` is an idempotency/recovery signal, not automatically a dispatch failure.

### Reconciliation

Airflow callbacks are reconciliation triggers, not authoritative success/failure payloads.

The reconciliation service queries executor state using stored execution identity. Callback-triggered, manual, and future periodic reconciliation share the same state-mapping path.

Executor availability failures do not convert a running financial calculation into `FAILED`.

Only confirmed executor terminal state produces atomic terminal attempt/job transitions.

## 13. Validation and Publication

Current portfolio scope uses explicit Submit Validation:

```text
BUILDING
+ all required jobs SUCCEEDED
→ VALIDATING
```

If any job is `PENDING`, `RUNNING`, or `FAILED`, validation submission is rejected.

From `VALIDATING`:

```text
Publish → PUBLISHED
Reject  → REJECTED
```

Concurrent Publish/Reject requests use compare-and-set semantics. Exactly one can win.

`BUILDING → ABANDONED` is allowed only when no active executor attempt can still be running. Airflow cancellation is not part of the current milestone.

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
DATASET_NOT_READY_FOR_VALIDATION
DATASET_HAS_ACTIVE_EXECUTION
STATE_CONFLICT
EXECUTOR_DISPATCH_FAILED
EXECUTOR_STATUS_UNAVAILABLE
```

Every documented public error code should eventually have a route-level contract test when its public route exists.

## 15. Testing Strategy

Critical transaction and concurrency behavior must run against real PostgreSQL.

Task 003 must prove snapshot consistency and lock ordering using real concurrent transactions; mocked repositories are insufficient for those guarantees.

Executor-facing tasks use an abstraction:

```text
CalculationExecutor
├── AirflowExecutor
└── FakeExecutor
```

`FakeExecutor` enables deterministic coverage for accepted/rejected dispatch, unknown dispatch outcome, duplicate run identity, execution success/failure, retry, reconciliation, and terminal dataset flows. Fake control routes must never be enabled in production.

## 16. Current Implementation Sequence

```text
1. Schema/migration and persistence invariants                         ✅
2. Dataset version creation + calculation-type job snapshotting       ✅
3. First Run + immutable build snapshot                               NOW
4. Execution attempts + FakeExecutor                                  NEXT
5. Reconciliation
6. Validation / Publish / Reject / Abandon
7. Full failure-path and concurrency acceptance suite
```

The active bounded task is:

```text
docs/tasks/003-first-run-immutable-build-snapshot.md
```

## 17. Decision Records

The rationale and alternatives behind the major decisions above are recorded in `docs/adr/`.
