# Roadmap

This file tracks implementation order for the accepted Cost Engine Orchestration Platform architecture.

Architecture decisions belong in `docs/adr/`; current architecture belongs in `docs/ARCHITECTURE.md`; bounded implementation work belongs in `docs/tasks/`.

## Now

### Orchestration Schema v2

Status: architecture accepted, migration drafted, PostgreSQL execution verification still required.

Relevant files:

- `migrations/1788700000000_orchestration-schema-v2.ts`
- `docs/ARCHITECTURE.md`
- `docs/adr/`

Required before merge:

- run migration `up` against a disposable PostgreSQL database,
- verify expected tables/constraints/indexes,
- verify migration failure behavior for incompatible legacy data,
- verify `down` behavior or document guarded irreversible cases,
- run TypeScript build after application code catches up with schema changes.

### Task 002 — Dataset Version Creation v2

Status: ready for implementation.

Task spec:

- `docs/tasks/002-dataset-version-creation-v2.md`

Goal:

```text
POST /dataset-versions
→ canonical series identity
→ atomic version allocation
→ DRAFT dataset version
→ snapshot active calculation types into PENDING jobs
```

Must include real PostgreSQL concurrency tests.

## Next

### Task 003 — First Run and Immutable Dataset Build Snapshot

Planned scope:

- freeze latest published dependency-definition version for every job,
- union direct upstream domain requirements,
- lock upstream dataset series in deterministic order,
- resolve latest published upstream dataset versions,
- create exactly one immutable dataset build snapshot,
- transition `DRAFT → BUILDING`,
- create the selected job's `PREPARED` execution attempt,
- cover concurrent first-Run and upstream Publish-vs-freeze races.

### Task 004 — Execution Attempt Lifecycle and FakeExecutor

Planned scope:

- `PREPARED → DISPATCHING → ACCEPTED`,
- definite `DISPATCH_FAILED`,
- ambiguous dispatch outcome recovery,
- stable Airflow `dag_run_id`,
- one active attempt per calculation job,
- FakeExecutor for deterministic tests/demo.

### Task 005 — Executor Reconciliation

Planned scope:

- manual Check Status,
- callback-triggered reconciliation,
- executor status as source of truth,
- atomic attempt/job terminal transitions,
- duplicate/stale reconciliation idempotency,
- executor-unavailable behavior.

### Task 006 — Validation and Dataset Terminal Decisions

Planned scope:

- Submit Validation only when all required jobs are `SUCCEEDED`,
- `VALIDATING → PUBLISHED`,
- `VALIDATING → REJECTED`,
- safe `DRAFT/BUILDING → ABANDONED`,
- Publish-vs-Reject concurrency tests,
- active-execution guard for abandonment.

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
