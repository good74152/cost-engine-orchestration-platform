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
- [ADR-0006 — First-Run Lock Hierarchy Across Configuration, Series, and Build State](0006-first-run-lock-hierarchy.md)
- [ADR-0007 — Dataset Terminal Decisions and Publication Serialization](0007-dataset-terminal-decisions-and-publication-serialization.md)
- [ADR-0008 — Identity-Scoped Definite Dispatch Rejection](0008-identity-scoped-definite-dispatch-rejection.md)
- [ADR-0009 — Demo Session API and Executor Boundary](0009-demo-session-api-and-executor-boundary.md)
- [ADR-0010 — Demo Session Reset and Recovery](0010-demo-session-reset-and-recovery.md)
- [ADR-0011 — Demo Scenario Persistence and Mode Isolation](0011-demo-scenario-persistence-and-mode-isolation.md)

## Truth Boundary

These ADRs describe the new portfolio architecture. They may be inspired by prior enterprise orchestration experience, but they are not claims that these exact designs, schemas, APIs, or recovery mechanisms were implemented in a former employer's production systems.
