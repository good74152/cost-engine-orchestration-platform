# Architecture

The current rules of the system. [ADRs](adr/README.md) explain why they exist, and [task specifications](tasks/) hold the detailed contracts.

## 1. Scope

The platform coordinates versioned cost and financial dataset builds across external Airflow/ETL workflows. The backend owns orchestration state, reproducibility, concurrency control, dependency resolution, execution identity, reconciliation and publication lifecycle. It does not implement financial calculations.

Domains: `FAB_COST`, `CAPEX`, `DPR`, `INSURANCE`, `ONE_STD_COST`, `E2E_COST`. All use the same quarterly reporting identity. Each may define its own calculation types, dependency definitions and DAG mappings. The platform stays generic: no domain pipeline is hard-coded. `E2E_COST` replaced `COWOS_S` by a guarded forward migration ([ADR-0014](adr/0014-canonical-domain-e2e-cost.md)).

## 2. Core model

```text
Dataset Series (domain, company_code, fiscal_year, period)
  └── Dataset Versions
        ├── 0..1 Dataset Build Snapshot
        │     └── Frozen Upstream Dataset Versions
        └── 1..N Calculation Jobs
              ├── Calculation Type
              │     └── Versioned Dependency Definitions
              └── 0..N Execution Attempts
                    └── External DAG Runs
```

| Entity | Meaning |
|---|---|
| `dataset_series` | Immutable logical identity, and the coordination root for version allocation and publication visibility. |
| `dataset_version` | One complete build and publication unit. Numbers are allocated monotonically and never reused. |
| `calculation_type` | A domain-local task with a DAG mapping and versioned dependency definitions. |
| `calculation_job` | One task for a `(dataset_version, calculation_type)`. Creation makes one `PENDING` job per active type. |
| `dataset_build_snapshot` | The inputs frozen for a whole version at first Run. Immutable once created. |
| `execution_attempt` | One concrete dispatch of a job. Retries add attempts on the same snapshot. |

`UNIQUE(domain, company_code, fiscal_year, period)` protects series identity. `last_allocated_version` is only an allocation counter, not a latest-published pointer. The latest usable upstream is derived as the highest `PUBLISHED` version of a series.

## 3. Lifecycles

**Dataset version**

```text
DRAFT ──────────→ ABANDONED
  │
  ▼
BUILDING ───────→ ABANDONED
  │
  ▼
VALIDATING ─────→ PUBLISHED
  └─────────────→ REJECTED
```

| State | Meaning |
|---|---|
| `DRAFT` | The version and jobs exist. Inputs are not frozen. |
| `BUILDING` | Inputs are frozen. Jobs may be pending, running, failed, retried or complete. |
| `VALIDATING` | Every required job succeeded. Awaiting a decision. |
| `PUBLISHED` | Immutable and usable by downstream builds. |
| `REJECTED`, `ABANDONED` | Immutable terminal states. |

A series has at most one active (`DRAFT`, `BUILDING`, `VALIDATING`) version, enforced by a partial unique index.

**Calculation job:** `PENDING → RUNNING → SUCCEEDED | FAILED`, and `FAILED → RUNNING` on retry. A job failure doesn't end the version. A `PREPARED` attempt doesn't change the job; it becomes `RUNNING` only after acceptance is durably recorded.

**Execution attempt:** `PREPARED → DISPATCHING → ACCEPTED → SUCCEEDED | FAILED`, and `DISPATCHING → DISPATCH_FAILED`. At most one non-terminal attempt exists per job. The platform generates a stable `dag_run_id` for each attempt before dispatch.

## 4. Dataset creation

One atomic transaction:

```text
find or create series → lock series → verify no active version → increment counter
→ create DRAFT version → load active types → create PENDING jobs → commit
```

With no active type, the whole transaction rolls back, including the allocation. Creation does not resolve dependencies, select upstream versions, create a snapshot or attempt, or contact the executor.

## 5. First Run and the build snapshot

The first preparation of any job in a `DRAFT` version initializes the whole build, in one transaction:

```text
load immutable context
→ lock calculation types in order
→ resolve the latest PUBLISHED dependency definition per job
→ derive required upstream series for the same company, year and period
→ lock upstream series in order
→ resolve the latest PUBLISHED upstream version per series
→ lock the output version and revalidate
→ if still DRAFT, persist one snapshot and frozen job definitions; DRAFT → BUILDING
→ lock the selected job → create or fetch its PREPARED attempt → commit
```

- If another transaction initialized first, the later one sees `BUILDING` and reuses the snapshot.
- If any definition or upstream is unavailable, everything rolls back: the version stays `DRAFT`, with no partial snapshot and no attempt.
- This commit is the version's consistency boundary. The output series is not locked for `DRAFT → BUILDING`; the output version serializes it, and upstream series rows serialize publication visibility.

**Input consistency.** A version uses one concrete version per upstream series across all jobs and retries. If upstream publishes later, the running version keeps its inputs. New data requires a new dataset version:

```text
retry = execution recovery
new dataset version = new data recomputation
```

**Dependency definitions** are platform configuration, not caller input. Published versions are immutable. A published definition with no rows is a valid "no dependencies", different from a missing definition. Only direct upstream requirements are validated, not transitive freshness.

## 6. Concurrency and locking

| Situation | Lock order |
|---|---|
| Several series | `(domain, company_code, fiscal_year, period)` |
| Several calculation types | `(domain, code)` |
| First Run ([ADR-0006](adr/0006-first-run-lock-hierarchy.md)) | calculation types → upstream series → output version → selected job |
| Job and attempt state | job → attempt. Callback paths resolve the owning job first. |
| Submit Validation | version → jobs by id. Eligibility is checked after the locks are held. |
| Publish, Reject | series → version |
| Abandon | series → version → jobs by id → attempts by `(job, attempt_number)` |

Always determine the lock set, sort it, then acquire it. Never lock in discovery order, and never invert a hierarchy. `SERIALIZABLE` is not the default strategy.

Database constraints back up these rules: unique series identity, unique `(series, version)`, one active version per series, one snapshot per version, one job per `(version, type)`, one frozen version per upstream series per snapshot, one active attempt per job and unique run identity.

## 7. Executor boundary

Never call the executor while a transaction holds orchestration locks:

```text
Transaction A: prepare or fetch a durable PREPARED attempt → commit
Transaction B: mark or reuse DISPATCHING, read the frozen command → commit
executor.dispatch
Transaction C: record the result → commit
```

| Dispatch result | Effect |
|---|---|
| `ACCEPTED`, `ALREADY_EXISTS` | Atomically records `ACCEPTED` and `RUNNING`. |
| `REJECTED` | `DISPATCH_FAILED`. The job stays `PENDING` or `FAILED`. |
| `UNKNOWN` | Stays `DISPATCHING` with the same identity, normally `202`. Reuse it; never create a fresh attempt. |

`REJECTED` is identity-wide and irrevocable ([ADR-0008](adr/0008-identity-scoped-definite-dispatch-rejection.md)): no run exists for that identity and none can be created later. An adapter that can't guarantee this must return `UNKNOWN`. A duplicate run ID is a recovery signal, not a failure. A late response never regresses a concurrent confirmation or terminal state.

**Reconciliation.** Callbacks only trigger it; their payloads aren't authoritative. Callback and manual paths share one state mapping:

- Executor lookup happens outside transactions. Local state is then locked and revalidated before any change.
- Unavailable or not-found responses never turn `RUNNING` into `FAILED` or `DISPATCHING` into `DISPATCH_FAILED`.
- A `DISPATCHING` attempt recovers from executor truth: running gives `ACCEPTED` and `RUNNING`; a terminal state converges directly on the same attempt.
- Stale callbacks can't overwrite a newer attempt. Contradictions are anomalies, not history rewrites.

Only `FakeExecutor` is implemented, for development, tests and the demo. Its state is in-process, so it provides no durability across restarts and no proof of real Airflow behavior. There is no periodic worker.

## 8. Validation and terminal decisions

Job completion doesn't advance a version. Each step is an explicit command:

- **Submit Validation:** `BUILDING` with one or more jobs, all `SUCCEEDED`, moves to `VALIDATING`.
- **Publish, Reject:** from `VALIDATING`. Publish changes what downstream First Runs resolve. Exactly one decision wins.
- **Abandon:** from `DRAFT` or `BUILDING`. Any `PREPARED`, `DISPATCHING` or `ACCEPTED` attempt blocks it. It doesn't cancel external work.

Repeating a command that already reached its target returns `200` with the current state. Conflicting decisions return `STATE_CONFLICT` and never rewrite history. After a version advances, repeating reconciliation of a terminal attempt stays idempotent when executor truth matches.

## 9. API errors

Handled errors use `{ "message": "...", "code": "..." }` with stable codes and route-level contract tests.

| Status | Use |
|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_DOMAIN`, `INVALID_PERIOD` |
| 404 | Missing resources |
| 409 | Readiness and state conflicts, such as `ACTIVE_DATASET_VERSION_EXISTS`, `DEPENDENCY_NOT_READY`, `JOB_NOT_RUNNABLE`, `DATASET_NOT_READY_FOR_VALIDATION`, `DATASET_HAS_ACTIVE_EXECUTION`, `EXECUTION_NOT_RECONCILABLE`, `STATE_CONFLICT` |
| 413, 415 | Framework body-size and media errors, with `INVALID_REQUEST` |
| 502 | `EXECUTOR_DISPATCH_FAILED`, a definite rejection |
| 503 | `EXECUTOR_STATUS_UNAVAILABLE` |
| 500 | Unexpected failures, logged without exposing PostgreSQL details |

## 10. Testing

Critical transaction and concurrency behavior runs against real PostgreSQL; mocked repositories can't prove it. `npm run test:milestone` runs the build and all core suites sequentially on disposable databases, and rejects skips, cancellations or missing evidence. See the [verification gates](REFERENCE.md#verification).

## 11. Core API

`APP_MODE=core`, the default, registers: `GET /health`; `POST /dataset-versions` and its `submit-validation`, `publish`, `reject` and `abandon` commands; `POST /calculation-jobs/:jobId/run` and `reconcile`; `POST /executor-callbacks/airflow`; and `POST /raw-ingestion-batches`. Core has no authentication and no read APIs. It isn't for public exposure.

Raw ingestion remains a separate supported workflow. Its business key isn't series identity. Details are in the [Backend Reference](REFERENCE.md#registered-api-surface).

## 12. Demo runtime

`APP_MODE=demo` is an explicit boundary around the same core services. It changes no core state machine, lock order or snapshot rule. Core write routes, raw ingestion, callbacks and internal controls aren't registered in this mode.

| Concern | Rule | Details |
|---|---|---|
| Sessions | Durable four-hour cookie sessions. Each owns a company code, and foreign or missing resources share a generic `404`. | [ADR-0009](adr/0009-demo-session-api-and-executor-boundary.md) |
| Executor isolation | Each session gets its own bounded FakeExecutor. Fake state controls never touch the database; reconciliation stays the authority. | [Demo-01B-1](tasks/demo-01b1-session-ownership-executor-isolation.md) |
| Concurrency gate | Four parallel operations per session; the fifth gets `429`. Exclusive operations wait in FIFO order. Local to one instance. | [ADR-0015](adr/0015-demo-session-concurrency-gate.md) |
| Reset and restart | Reset deletes the owner's graph in one transaction when the session is idle. Startup invalidates old sessions, because fake memory didn't survive. | [ADR-0010](adr/0010-demo-session-reset-and-recovery.md) |
| Run simulation | A Run can choose its simulated outcome. It binds once per identity; existing runs keep theirs. | [ADR-0016](adr/0016-request-scoped-demo-simulation.md) |
| Admission and cutover | `LEGACY_OPEN → DRAINING → WORKFLOW_OPEN`, irreversible and enforced in PostgreSQL. Cutover is an offline, atomic operator action. | [ADR-0017](adr/0017-demo-admission-drain.md), [ADR-0018](adr/0018-demo-workflow-configuration-cutover.md) |
| Workflow catalog | A static read-only description of the six-domain order. It starts nothing and stores no progress. | [Demo-05C-1](tasks/demo-05c1-workflow-template-catalog.md) |
| Guided scenarios | Backend APIs with a durable step ledger remain and are tested. The page no longer uses them. | [ADR-0011](adr/0011-demo-scenario-persistence-and-mode-isolation.md), [ADR-0012](adr/0012-demo-scenario-step-idempotency.md) |
| Page | One page plays scripted scenarios and offers a manual mode through the same `/demo/*` APIs. It holds no lifecycle rule. Requires `WORKFLOW_OPEN`. | [ADR-0020](adr/0020-one-page-demo-ui.md), [Demo-09](tasks/demo-09-manual-mode.md) |
| Public deployment | Caddy is the only public entry; Node and PostgreSQL stay on private networks. An explicit profile validates origin, secrets and limits. Web opens only by explicit command. | [ADR-0013](adr/0013-restricted-public-demo-deployment.md), [Deployment](DEPLOYMENT.md) |
| Backup and recovery | Offline and online backups, restore into disposable targets only, read-only drills and offline readiness reports. No production restore command, and no RPO or RTO claim. | [Drill](RECOVERY_DRILL.md), [Readiness](RECOVERY_READINESS.md), [ADR-0019](adr/0019-offline-recovery-readiness-evidence.md) |

A restored database doesn't restore FakeExecutor memory or a session's ability to run work.

## 13. Status

Orchestration Core v2 (Task 007) is complete and accepted; see the [acceptance record](verification/task-007-final-acceptance.md). Real Airflow integration, cancellation, queues, background workers, automatic publication, downstream triggers and production authentication aren't implemented.
