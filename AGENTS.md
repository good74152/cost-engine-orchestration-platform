# AGENTS.md

## Purpose

This repository is the **Cost Engine Orchestration Platform**, a portfolio implementation of a production-style backend that coordinates versioned cost/financial datasets and external Airflow/ETL executions.

This file is intentionally concise. Detailed architecture belongs in `docs/` and accepted decisions belong in `docs/adr/`.

## Source of Truth

Before making a substantial change, read in this order:

1. `README.md` — project scope and current milestone.
2. `docs/ARCHITECTURE.md` — current accepted architecture and invariants.
3. `docs/adr/README.md` — accepted architecture decisions.
4. Relevant files in `docs/adr/`.
5. Relevant bounded task in `docs/tasks/`.

Chat history is not the system of record.

## Engineering Workflow

For substantial changes:

```text
Requirement
→ Architecture / trade-off review
→ Accepted ADR/spec
→ Bounded implementation task
→ Implementation
→ Human review
→ Senior review/challenge
→ Fix
→ PostgreSQL/integration verification
→ Merge
```

Do not silently make architecture decisions while implementing a bounded task. If a task conflicts with an accepted ADR or requires a new architectural decision, stop and return the issue for architecture review.

## Architecture Boundaries

Do not reintroduce these retired assumptions:

- opaque `business_key` as canonical dataset identity,
- one calculation job per dataset version,
- caller-selected upstream dataset versions,
- dependency resolution during dataset creation,
- dataset-level `FAILED` for calculation execution failure,
- direct callback payload as authoritative executor state,
- long PostgreSQL transactions held open during Airflow HTTP calls.

Current canonical domain identifiers are:

```text
FAB_COST
CAPEX
DPR
INSURANCE
ONE_STD_COST
COWOS_S
```

The platform must remain generic across domains. Do not hard-code a global `FAB_COST → CAPEX → DPR` pipeline.

## Persistence and Concurrency Rules

- PostgreSQL constraints are correctness backstops, not optional validation.
- Critical lifecycle changes use transactions and explicit row locking/CAS where specified.
- `dataset_series` is the coordination root for one logical dataset series.
- Multi-series locks use deterministic order `(domain, company_code, fiscal_year, period)`.
- Version numbers are monotonic and never reused.
- One dataset version has one immutable build snapshot after first Run.
- Retries create new `execution_attempt` rows; they do not change the dataset build snapshot.

See `docs/ARCHITECTURE.md` and ADRs for the full rules.

## Database Migrations

- Never edit an already-applied migration to change history; add a forward migration.
- Do not silently discard legacy/audit data during migration.
- Migration `up` and `down` behavior must be explicit about irreversible cases.
- Schema changes that enforce architecture invariants require PostgreSQL integration verification.

## Testing Standard

Critical behavior must be tested against real PostgreSQL, especially:

- transaction rollback,
- uniqueness/foreign-key constraints,
- concurrent dataset creation,
- concurrent first Run/snapshot freeze,
- publish/reject races,
- executor response-loss/idempotency recovery.

Every documented public API error code should have a route-level contract test.

## External Executor Boundary

The Node.js backend owns orchestration, not financial calculation implementation.

Airflow/ETL owns calculation execution. The backend owns:

- dataset/job/attempt lifecycle,
- dependency definition/versioning,
- frozen dataset input snapshots,
- dispatch identity,
- reconciliation,
- validation/publication state.

Do not put employer-specific Airflow DAG code, SQL, proprietary schemas, or confidential configuration in this repository.

## Current Implementation Task

The current bounded task is documented in:

`docs/tasks/002-dataset-version-creation-v2.md`

Its non-goals are binding. Do not implement later lifecycle slices as part of Task 002.
