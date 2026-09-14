# ADR-0005 — Execution Attempts, Airflow Idempotency, and Reconciliation

- Status: Accepted
- Date: 2026-09-06

## Context

A calculation job can be retried, external dispatch can fail before acceptance, and HTTP response loss can leave the backend uncertain whether Airflow created a DAG run.

The original style of tracking one high-level job state is insufficient for distinguishing:

- the logical calculation task,
- one concrete execution attempt,
- a definite dispatch failure,
- an ambiguous dispatch outcome,
- a later execution failure after Airflow accepted the run.

Airflow callbacks can also be duplicated or delayed, so directly trusting callback payloads as authoritative state creates consistency risk.

## Decision

Separate logical job identity from concrete execution identity.

A `calculation_job` represents the logical task for `(dataset_version, calculation_type)`.

An `execution_attempt` represents one concrete external execution attempt and preserves immutable execution history.

Attempt lifecycle:

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

A calculation job may have multiple historical attempts but at most one non-terminal attempt in:

```text
PREPARED / DISPATCHING / ACCEPTED
```

Each attempt owns a stable platform-generated Airflow identity:

```text
airflow_dag_id
airflow_dag_run_id
```

The same attempt identity is reused whenever dispatch outcome is ambiguous.

### Dispatch Boundary

Airflow HTTP calls are never performed while holding the transaction that freezes/configures the attempt.

The flow is:

```text
DB transaction: create/fetch durable attempt and mark dispatching
→ commit
→ call Airflow
→ DB transaction: record confirmed acceptance or definite rejection
```

A definite executor rejection, where the backend can establish that no execution was created, transitions the attempt to `DISPATCH_FAILED`.

A timeout, response loss, connection reset, or otherwise ambiguous response does **not** create a new attempt and does not mark the attempt failed. The attempt remains `DISPATCHING` and the backend reconciles using the same stable `dag_run_id`.

If Airflow reports that the same `dag_run_id` already exists, that is treated as an idempotency/recovery signal. The backend looks up/reconciles the existing run rather than treating the duplicate identity as a new failure.

### Reconciliation

Airflow callback payloads are triggers, not the authoritative success/failure record.

The backend uses stored `airflow_dag_id + airflow_dag_run_id` to query executor state through one reconciliation service. The same service is used by:

- callback-triggered reconciliation,
- manual UI `Check Status`,
- a possible future periodic reconciliation worker.

If the executor is unavailable or the status query is inconclusive, local execution remains non-terminal. An orchestration/status-query failure does not convert a calculation into `FAILED`.

Only an explicit terminal executor result maps to local execution outcome:

```text
Airflow success
→ attempt SUCCEEDED
→ job SUCCEEDED
```

```text
Airflow failure
→ attempt FAILED
→ job FAILED
```

The paired attempt/job state mutations representing the same confirmed fact occur atomically in PostgreSQL.

Retries after an execution failure create a new `execution_attempt` but continue to use the same immutable dataset build snapshot.

## Alternatives Considered

### Store only `calculation_job.status`

Rejected because one row cannot preserve multiple retry attempts or distinguish dispatch uncertainty from execution failure.

### Create a new attempt after any timeout

Rejected because the first request may already have created an Airflow run, producing duplicate calculation execution.

### Let Airflow generate an opaque execution ID and recover manually by time/name

Not selected for the portfolio target because caller-supplied stable run identity gives stronger idempotency and deterministic recovery without requiring a custom executor API.

### Trust callback success/failure directly

Rejected because callbacks can be duplicated, delayed, spoofed/malformed, or arrive after local state changes. Reconciliation against the executor state is a clearer source-of-truth boundary.

### Hold a DB transaction open during Airflow dispatch

Rejected because external latency/failure would extend database locks and transaction lifetime, damaging concurrency and still not provide true distributed atomicity.

## Consequences

Positive:

- Execution retries are fully auditable.
- Response-loss recovery can avoid duplicate Airflow runs.
- Logical job state is separated from transport/orchestration failure.
- Callback and manual status checks share one idempotent reconciliation path.
- External calls do not hold PostgreSQL lifecycle locks.

Trade-offs:

- The backend must maintain an explicit attempt state machine and recovery logic.
- `DISPATCHING` may remain unresolved until reconciliation succeeds.
- A stable Airflow run identity is part of the executor integration contract.
- Operational monitoring must surface stuck/ambiguous attempts instead of automatically treating them as calculation failures.
