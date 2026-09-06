# Architecture Decision Records

This directory is the durable record of accepted architecture decisions for the Cost Engine Orchestration Platform.

ADRs explain **why** an architectural rule exists, what alternatives were considered, and what consequences follow. The consolidated current architecture is documented in `../ARCHITECTURE.md`.

## Status Convention

Each ADR uses one of:

- `Accepted`
- `Superseded`
- `Deprecated`

If a decision changes materially, prefer a new ADR that supersedes the old one instead of rewriting history.

## Accepted ADRs

- [ADR-0001 — Canonical Dataset Identity and Monotonic Version Allocation](0001-canonical-dataset-identity.md)
- [ADR-0002 — Dataset Version as the Multi-Job Publication Unit](0002-dataset-version-publication-unit.md)
- [ADR-0003 — Versioned Dependency Definitions and Dataset-Wide Build Snapshot](0003-versioned-dependencies-and-build-snapshot.md)
- [ADR-0004 — Dataset-Series Serialization and Deterministic Lock Ordering](0004-series-serialization-and-lock-ordering.md)
- [ADR-0005 — Execution Attempts, Airflow Idempotency, and Reconciliation](0005-execution-attempts-and-airflow-reconciliation.md)

## Truth Boundary

These ADRs describe the new portfolio architecture. They may be inspired by prior enterprise orchestration experience, but they are not claims that these exact designs, schemas, APIs, or recovery mechanisms were implemented in a former employer's production systems.
