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

This is now the creation path Task 003 builds on.

### Task 003 — First Run + Immutable Dataset Build Snapshot

Status: architecture accepted; bounded implementation spec ready.

Task spec:

- `docs/tasks/003-first-run-immutable-build-snapshot.md`

Relevant decisions:

- `docs/adr/0002-dataset-version-publication-unit.md`
- `docs/adr/0003-versioned-dependencies-and-build-snapshot.md`
- `docs/adr/0004-series-serialization-and-lock-ordering.md`
- `docs/adr/0005-execution-attempts-and-airflow-reconciliation.md`
- `docs/adr/0006-first-run-lock-hierarchy.md`

Goal:

```text
first prepared job for DRAFT dataset
→ freeze one dependency-definition version per job
→ freeze one concrete upstream version per required series
→ create exactly one immutable dataset_build_snapshot
→ DRAFT → BUILDING
→ selected job remains PENDING
→ selected job gets PREPARED execution_attempt
```

Preparing later jobs in the same `BUILDING` dataset must reuse the existing snapshot and must not refresh definitions or upstream versions.

Task 003 must include real PostgreSQL concurrency coverage for:

- same-job concurrent first preparation,
- different-job concurrent first preparation,
- upstream Publish-vs-freeze ordering,
- dependency-definition Publish-vs-freeze ordering.

Task 003 does not dispatch to Airflow/FakeExecutor.

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

### Task 004 — Execution Attempt Lifecycle and FakeExecutor

Planned scope:

- expose the final calculation-job Run/dispatch boundary,
- consume/reuse the durable `PREPARED` attempt created by Task 003,
- `PREPARED → DISPATCHING → ACCEPTED`,
- definite `DISPATCH_FAILED`,
- ambiguous dispatch outcome recovery,
- stable Airflow `dag_run_id`,
- one active attempt per calculation job,
- FakeExecutor for deterministic tests/demo,
- atomically record executor acceptance with job `PENDING/FAILED → RUNNING`.

### Task 005 — Executor Reconciliation

Planned scope:

- manual Check Status,
- callback-triggered reconciliation,
- executor status as source of truth,
- atomic attempt/job terminal transitions,
- duplicate/stale reconciliation idempotency,
- executor-unavailable behavior,
- retry after a confirmed failed execution while preserving the frozen dataset snapshot.

### Task 006 — Validation and Dataset Terminal Decisions

Planned scope:

- Submit Validation only when all required jobs are `SUCCEEDED`,
- `VALIDATING → PUBLISHED`,
- `VALIDATING → REJECTED`,
- safe `DRAFT/BUILDING → ABANDONED`,
- Publish-vs-Reject concurrency tests,
- active-execution guard for abandonment.

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
