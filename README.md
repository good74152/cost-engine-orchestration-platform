# Financial Calculation Platform

A production-style backend project for orchestrating long-running, versioned financial data calculations.

The platform focuses on backend concerns around financial data processing: reproducibility, concurrency correctness, versioned datasets, asynchronous execution, failure recovery, auditability, and PostgreSQL reliability.

> Status: In Progress

## Problem

Financial data workflows are rarely one synchronous request. A quarterly dataset may require multiple calculation tasks, each task may depend on published upstream datasets, external execution can fail or time out, and the final dataset may still require manual validation before downstream consumers are allowed to use it.

This project models those concerns explicitly instead of treating a calculation as a single API call.

## Tech Stack

- TypeScript
- Node.js / Fastify
- PostgreSQL
- Docker / Docker Compose
- Airflow-compatible executor boundary (implementation in progress)

## Architecture Baseline

The accepted orchestration model is:

```text
Dataset Series
(domain, company_code, fiscal_year, period)
        │
        ▼
Dataset Version
        │
        ├── Immutable Dataset Build Snapshot
        │       └── Frozen upstream Dataset Versions
        │
        └── Calculation Jobs
                └── Execution Attempts
                        └── External executor / Airflow DAG Run
```

The backend owns orchestration. It does not own the financial calculation implementation itself. Airflow may execute Python, SQL, or other data-processing tasks; this service coordinates inputs, lifecycle, identity, retries, and publication state.

## Canonical Dataset Identity

All calculation domains use the same quarterly reporting coordinates:

```text
(domain, company_code, fiscal_year, period)
```

Example:

```text
(CAPEX, TW01, 2026, Q3)
(DPR,   TW01, 2026, Q3)
```

`company_code`, `fiscal_year`, and `period` are immutable business identity dimensions. `business_key` is being retired from the orchestration model.

A `dataset_series` stores the logical identity and a monotonic `last_allocated_version`. Dataset version numbers are never reused, including after rejection or abandonment.

## Dataset Build Flow

### 1. Create Dataset Version

Creating a new dataset version is one database transaction:

```text
lock dataset_series
→ allocate next version
→ create dataset_version = DRAFT
→ snapshot all active calculation_types into calculation_jobs = PENDING
→ commit
```

A domain can have multiple calculation types. One dataset version therefore owns one or more calculation jobs.

### 2. First Run Freezes the Dataset Build Snapshot

Creating a dataset version does **not** resolve upstream data immediately.

When the first calculation job is run:

```text
resolve latest published dependency-definition versions
→ union required upstream domains
→ deterministically lock upstream dataset_series rows
→ resolve latest PUBLISHED upstream dataset versions
→ persist one immutable dataset_build_snapshot
→ dataset DRAFT → BUILDING
→ create the selected job execution_attempt
```

The transaction commit is the dataset version's build-consistency boundary.

After the snapshot is frozen, every calculation job in that dataset version must use the same concrete upstream version for the same upstream series. A retry creates a new execution attempt but does not change the dataset build snapshot.

If newer upstream data must be used, the existing dataset version is abandoned and a new version is created.

### 3. Dispatch Calculation Jobs

A `calculation_job` represents one logical calculation task inside a dataset version.

An `execution_attempt` represents one concrete external execution / Airflow DAG run.

```text
calculation_job
PENDING → RUNNING → SUCCEEDED
                  └→ FAILED → retry with a new execution_attempt
```

Execution attempts preserve immutable execution history:

```text
PREPARED
  → DISPATCHING
      → ACCEPTED
          → SUCCEEDED
          └→ FAILED
      └→ DISPATCH_FAILED
```

Airflow calls are never performed while holding a long PostgreSQL transaction.

A stable caller-supplied DAG run identity is used for idempotent dispatch and response-loss recovery. Duplicate DAG run identity is treated as a reconciliation signal, not automatically as a failed dispatch.

### 4. Reconcile Executor Status

Airflow execution state is reconciled through one service path. Reconciliation may be triggered by:

- an Airflow callback signal,
- a user-triggered "Check Status" action,
- a future periodic reconciliation worker.

The callback is a signal; the executor status API is the execution-state source of truth.

Executor/API availability failures do not change a financial calculation to `FAILED`. A job becomes `FAILED` only when the executor explicitly reports execution failure.

### 5. Validate and Publish the Dataset

A dataset remains `BUILDING` while any required calculation job is not successful.

For the current portfolio scope, validation submission is manual:

```text
all calculation_jobs = SUCCEEDED
→ Submit Validation
→ dataset BUILDING → VALIDATING
```

Dataset lifecycle:

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

`PUBLISHED`, `REJECTED`, and `ABANDONED` are immutable terminal dataset states.

`REJECTED` means the full build completed but validation/publication was rejected. `ABANDONED` means the build was intentionally stopped before publication readiness.

## Dependency Definitions

Each calculation type has versioned execution dependency definitions.

Example:

```text
DPR / TABLE_X

Definition v1:
- CAPEX

Definition v2:
- CAPEX
- DOMAIN_X
```

Definitions answer **what upstream domains are required**.

The dataset build snapshot answers **which concrete upstream dataset versions this dataset build uses**.

Historical jobs pin the dependency-definition version used by that dataset build, so dependency configuration changes are auditable instead of overwriting history.

## Concurrency Invariants

Critical invariants are enforced by PostgreSQL constraints in addition to service-level locking:

- One dataset series per `(domain, company_code, fiscal_year, period)`.
- Dataset version numbers are monotonic and never reused.
- A dataset series has at most one active `DRAFT`, `BUILDING`, or `VALIDATING` version.
- A dataset version has at most one build snapshot.
- A dataset version has at most one job for each calculation type.
- A calculation job has at most one non-terminal execution attempt.
- A build snapshot pins at most one version of each upstream dataset series.
- Publish/reject transitions use compare-and-set semantics.

`dataset_series` is the coordination row for version allocation, publication visibility, abandonment/rejection ordering, and downstream dependency resolution.

When multiple series rows must be locked, they are acquired in deterministic order:

```text
(domain, company_code, fiscal_year, period)
```

Calculation type rows used during first-run definition resolution are likewise locked deterministically by `(domain, code)`.

## Error and Failure Model

The API distinguishes business, concurrency, and executor failures. Expected lifecycle failures are not generic `500` errors.

Examples include:

- `ACTIVE_DATASET_VERSION_EXISTS`
- `CALCULATION_TYPE_NOT_CONFIGURED`
- `DEPENDENCY_DEFINITION_NOT_READY`
- `DEPENDENCY_NOT_READY`
- `JOB_NOT_RUNNABLE`
- `DATASET_NOT_READY_FOR_VALIDATION`
- `DATASET_HAS_ACTIVE_EXECUTION`
- `STATE_CONFLICT`
- `EXECUTOR_DISPATCH_FAILED`
- `EXECUTOR_STATUS_UNAVAILABLE`

Every public error code in the orchestration API is expected to have a route-level contract test.

## Testing Strategy

Critical transaction and concurrency behavior must be tested against real PostgreSQL, not a mocked database.

The orchestration implementation will use an executor abstraction:

```text
CalculationExecutor
├── AirflowExecutor
└── FakeExecutor
```

`FakeExecutor` allows deterministic portfolio/demo tests for:

- dispatch accepted/rejected,
- response loss / unknown dispatch outcome,
- duplicate stable DAG run identity,
- execution success/failure,
- job retry,
- status reconciliation,
- publish/reject/abandon flows.

Fake executor control endpoints must only be registered in development/test environments.

## Current Implementation

The repository currently contains the earlier orchestration implementation, including:

- Dataset Series and Dataset Versions
- one calculation job per output dataset version
- application-level calculation dependencies
- transactional job/dataset state transitions
- concurrency experiments and partial unique indexes
- DPR performance/materialization experiments
- versioned raw-ingestion allocation work

The accepted orchestration architecture above intentionally changes several of those assumptions. In particular:

- `business_key` is replaced by structured reporting identity columns,
- one dataset version owns multiple calculation jobs,
- dependency configuration becomes versioned,
- upstream inputs are frozen once per dataset version,
- Airflow executions are modeled as immutable execution attempts,
- dataset execution failure is no longer a dataset-level `FAILED` state.

## Current Milestone

The current milestone is **Orchestration Schema v2 and execution lifecycle migration**.

Implementation sequence:

1. Schema/migration and database constraints.
2. Dataset creation and calculation-type snapshotting.
3. First-run immutable build snapshot.
4. Execution-attempt lifecycle and FakeExecutor.
5. Executor reconciliation.
6. Validation / publish / reject / abandon APIs.
7. Required failure-path and concurrency integration tests.

The migration is implemented as a forward migration rather than editing previously applied migration history. `legacy_business_key` is retained temporarily as a rollback bridge; new orchestration code must not use it.

## Existing Performance Lab

The repository also contains a PostgreSQL performance lab built around synthetic DPR data:

- 4M raw financial rows
- 250K assets
- quarterly partitions
- `EXPLAIN (ANALYZE, BUFFERS)` investigations
- partition pruning
- sequential/bitmap scans
- hash joins
- aggregation spill
- calculation-ready materialization experiments

This performance work is separate from the orchestration architecture and remains useful as a data-processing/backend performance exercise.

## Non-Goals for This Milestone

The current milestone does not implement:

- Airflow itself or financial calculation code,
- Python/SQL calculation internals,
- job-to-job dependency DAGs inside one dataset version,
- automatic dependency-ready scheduling,
- Airflow cancellation,
- RabbitMQ, Kafka, Redis, or Kubernetes solely for architecture complexity.

## Local Development

### Requirements

- Node.js 24+
- Docker
- Docker Compose

### Setup

```bash
cp .env.example .env
npm install
docker compose up -d
npm run migrate up
npm run dev
```

The orchestration v2 migration changes the schema ahead of the existing v1 service implementation. Apply it only together with the corresponding application migration work, or use a disposable development database while this milestone is in progress.
