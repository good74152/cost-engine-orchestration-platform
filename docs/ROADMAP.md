# Roadmap

This file tracks implementation order for the accepted Cost Engine Orchestration Platform architecture.

Architecture decisions belong in `docs/adr/`; current architecture belongs in `docs/ARCHITECTURE.md`; bounded implementation work belongs in `docs/tasks/`.

## Now

### Task 002 — Dataset Version Creation v2

Status: merged to `main`.

Implemented baseline:

```text
POST /dataset-versions
→ canonical series identity
→ atomic version allocation
→ DRAFT dataset version
→ snapshot active calculation types into PENDING jobs
```

### Task 003 — First Run + Immutable Dataset Build Snapshot

Status: merged to `main`.

Implemented baseline:

```text
first preparation for DRAFT dataset
→ freeze one dependency-definition version per job
→ freeze one concrete upstream version per required series
→ create exactly one immutable dataset_build_snapshot
→ DRAFT → BUILDING
→ selected job remains PENDING
→ selected job gets PREPARED execution_attempt
```

Preparing later jobs in the same `BUILDING` dataset reuses the existing snapshot and does not refresh definitions or upstream versions.

### Task 004 — Execution Attempt Dispatch + FakeExecutor

Status: merged to `main`.

Implemented baseline:

```text
POST /calculation-jobs/:jobId/run
→ prepare/reuse durable execution_attempt
→ PREPARED → DISPATCHING
→ commit
→ dispatch through FakeExecutor outside DB transaction
→ ACCEPTED/ALREADY_EXISTS:
     attempt → ACCEPTED
     job PENDING/FAILED → RUNNING
→ REJECTED:
     attempt → DISPATCH_FAILED
     job state unchanged
→ UNKNOWN:
     attempt remains DISPATCHING
     same stable run identity is reused
```

Task 004 also owns retry-attempt preparation for a `FAILED` job while preserving the immutable dataset build snapshot.

### Task 005 — Executor Reconciliation

Status: implementation/code review accepted after stale-observation fix; merge to `main` still required before Task 006 implementation begins.

Task spec:

- `docs/tasks/005-executor-reconciliation.md`

Relevant decision:

- `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`

Goal:

```text
manual Check Status / callback signal
→ resolve exact durable execution_attempt
→ executor status lookup outside DB transaction
→ RUNNING:
     recover/keep ACCEPTED + RUNNING
→ SUCCEEDED:
     attempt + job atomically SUCCEEDED
→ FAILED:
     attempt + job atomically FAILED
→ NOT_FOUND/UNAVAILABLE:
     preserve local state
```

Task 005 must also protect against stale callbacks from older attempts and terminal-state contradictions.

Task 005 does not implement dataset validation/publication decisions or real Airflow integration.

### Incremental Legacy Cleanup

Legacy application code should be removed incrementally as each v2 replacement slice becomes authoritative.

Rules:

- delete only code that is fully superseded and has no remaining supported caller,
- preserve code temporarily when a later, not-yet-migrated lifecycle still depends on it,
- require replacement-path tests before deletion,
- do not turn cleanup into an unrelated repository-wide refactor,
- never treat application dead-code cleanup as permission to discard historical/audit database data.

Cleanup work belongs in the bounded task that replaces the old behavior, not in a standalone architecture ADR unless a new architectural trade-off is discovered.

## Next

### Task 006 — Validation and Dataset Terminal Decisions

Status: architecture accepted; ADR and bounded implementation spec ready. Implementation is blocked until Task 005 is merged to `main`.

Task spec:

- `docs/tasks/006-validation-and-dataset-terminal-decisions.md`

Relevant decision:

- `docs/adr/0007-dataset-terminal-decisions-and-publication-serialization.md`

Goal:

```text
BUILDING + all jobs SUCCEEDED
→ explicit VALIDATING

VALIDATING → PUBLISHED / REJECTED

DRAFT / safe BUILDING
→ ABANDONED
```

Key correctness boundaries:

- Submit Validation locks dataset_version then all jobs before checking readiness.
- Publish/Reject/Abandon serialize through dataset_series → dataset_version.
- PREPARED/DISPATCHING/ACCEPTED attempts block abandonment.
- same-target repeated lifecycle commands are idempotent 200.
- no executor cancellation is introduced.
- Task-005 terminal reconciliation remains idempotent after dataset lifecycle advancement.

### Task 007 — End-to-End Hardening and Legacy Cleanup

Planned scope:

- full public error-contract coverage,
- end-to-end happy/failure/retry scenarios,
- concurrency regression suite,
- final removal of fully superseded legacy application code,
- README/architecture implementation-status synchronization.

## Later

Only introduce these when a concrete requirement justifies them:

- automatic dependency-ready scheduling,
- periodic reconciliation worker,
- Airflow cancellation,
- job-to-job dependency graph inside one dataset version,
- RabbitMQ/Kafka/Redis,
- Kubernetes deployment,
- additional reporting grains beyond the current quarterly identity model.

Do not add technologies solely for portfolio breadth.

## Completion Gate for the Orchestration Milestone

The milestone is complete only when the implementation demonstrates:

- canonical dataset identity,
- monotonic version allocation,
- one active dataset version per series,
- multi-job dataset versions,
- versioned dependency definitions,
- one immutable dataset-wide input snapshot,
- retry through immutable execution attempts,
- Airflow dispatch idempotency/recovery semantics,
- reconciliation-based executor state updates,
- validation/publication/rejection/abandonment lifecycle,
- documented public error contracts,
- real PostgreSQL failure-path and concurrency tests.
