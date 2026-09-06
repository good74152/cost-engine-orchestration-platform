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

The row also acts as the primary concurrency coordination root for that logical series.

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

Once created, it is immutable.

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

A partial index should support this lookup.

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
- `BUILDING`: the build snapshot is frozen and jobs may be running, failed, retried, or completed.
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
  │ accepted executor run
  ▼
RUNNING
  ├────────→ SUCCEEDED
  └────────→ FAILED
                │ retry
                ▼
              RUNNING
```

A job failure does not make the dataset version terminal. A failed job may be retried within the same dataset version.

`SUCCEEDED` means the required logical calculation task for that dataset version is complete.

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

A stable Airflow `dag_run_id` is generated by the orchestration platform for each attempt.

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

Dataset creation does not:

- resolve dependency definitions,
- select upstream dataset versions,
- create a build snapshot,
- create execution attempts,
- contact Airflow.

## 8. First Run and Build Snapshot Freeze

The first Run request for any job in a `DRAFT` dataset version initializes the entire dataset build.

Within one PostgreSQL transaction:

```text
lock output dataset/version coordination state
→ load all jobs in the dataset version
→ lock relevant calculation_type rows in deterministic order
→ resolve latest PUBLISHED dependency-definition version per job
→ compute union of required upstream domains
→ identify matching upstream dataset_series using the same company/year/period
→ lock upstream dataset_series rows in deterministic order
→ resolve latest PUBLISHED upstream dataset version for every required series
→ persist one immutable dataset_build_snapshot and dependency rows
→ persist each job's resolved definition version
→ DRAFT → BUILDING
→ create selected job execution_attempt PREPARED
→ commit
```

If any required definition or upstream dataset is unavailable, the transaction rolls back. The dataset remains `DRAFT`, no snapshot exists, and no attempt exists.

The commit of this transaction is the dataset-version consistency boundary.

## 9. Dataset-Wide Input Consistency

A dataset version uses one concrete version per upstream dataset series across all jobs.

Example:

```text
DPR v5 snapshot:
CAPEX     → v7
INSURANCE → v3
```

Every DPR v5 calculation job requiring CAPEX uses CAPEX v7. If CAPEX v8 publishes later, retries within DPR v5 still use v7.

Using new upstream data requires a new dataset version, not a retry.

This separates:

```text
retry = execution recovery
new dataset version = new business/data recomputation identity
```

## 10. Versioned Dependency Definitions

Dependencies are platform-owned configuration per calculation type, not caller-provided data.

A dependency definition answers:

> What direct upstream domains does this calculation type require?

Example:

```text
DPR / TABLE_X

Definition v1:
- CAPEX

Definition v2:
- CAPEX
- INSURANCE
```

Definition history is immutable and versioned. Existing dataset builds remain auditable after configuration changes.

A pending job does not pin a definition version at dataset creation time. Definition versions are frozen together at the first Run boundary.

## 11. Concurrency and Locking

### Dataset Series Coordination

`dataset_series` is the serialization point for operations involving the lifecycle or published visibility of one logical dataset series, including:

- version allocation,
- publication/rejection/abandonment ordering,
- downstream latest-published resolution.

This provides deterministic ordering between upstream publish and downstream snapshot freeze.

### Multi-Series Lock Ordering

When multiple `dataset_series` rows are required, acquire locks in this total order:

```text
(domain, company_code, fiscal_year, period)
```

The order exists for deadlock prevention. It is not a business dependency order.

When multiple `calculation_type` rows are locked, use:

```text
(domain, code)
```

Always determine the lock set, sort it, then acquire locks. Do not discover and lock dependencies incrementally in arbitrary order.

### Constraints as Backstops

Important invariants must also be protected by database constraints, including:

- unique dataset series identity,
- unique `(dataset_series_id, version)`,
- one active dataset version per series,
- one build snapshot per dataset version,
- one job per `(dataset_version, calculation_type)`,
- one frozen version per upstream series per snapshot,
- one active attempt per job,
- stable unique Airflow run identity.

## 12. Airflow / ETL Boundary

Do not call Airflow while holding a long PostgreSQL transaction.

Dispatch flow:

```text
DB transaction: create/fetch durable attempt and mark dispatching
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

The reconciliation service queries executor state using stored execution identity. The same service path is used by callback-triggered and manual status checks.

Executor availability failures do not convert a running financial calculation into `FAILED`.

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

`BUILDING → ABANDONED` is only allowed when no active executor attempt can still be running. Airflow cancellation is not part of the current milestone.

## 14. API Error Model

Expected business/concurrency failures use stable error codes rather than generic `500` responses.

Representative codes:

```text
INVALID_REQUEST
INVALID_DOMAIN
INVALID_PERIOD
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

Every documented public error code should have a route-level contract test.

## 15. Testing Strategy

Critical transaction and concurrency behavior must run against real PostgreSQL.

Use an executor abstraction:

```text
CalculationExecutor
├── AirflowExecutor
└── FakeExecutor
```

`FakeExecutor` enables deterministic automated/demo coverage for:

- accepted/rejected dispatch,
- unknown dispatch outcome,
- duplicate run identity,
- execution success/failure,
- retry,
- reconciliation,
- validation/publication/abandonment.

Fake control routes must never be enabled in production.

## 16. Current Implementation Sequence

```text
1. Schema/migration and persistence invariants
2. Dataset version creation + calculation-type job snapshotting
3. First Run + immutable build snapshot
4. Execution attempts + FakeExecutor
5. Reconciliation
6. Validation / Publish / Reject / Abandon
7. Full failure-path and concurrency acceptance suite
```

The active bounded task is `docs/tasks/002-dataset-version-creation-v2.md`.

## 17. Decision Records

The rationale and alternatives behind the major decisions above are recorded in `docs/adr/`.
