# Roadmap

The Cost Engine Orchestration Platform is a new portfolio backend. Accepted decisions live in docs/adr/, current implementation invariants in docs/ARCHITECTURE.md, and bounded execution specifications in docs/tasks/.

## Completed and merged on main

Verified baseline: 85479c723090de8dc96cdb0a13472f3156b5e8f9.

| Task | Implemented capability | Status |
|---|---|---|
| 002 | Canonical dataset identity; atomic DRAFT version allocation and snapshot of active types into jobs | Merged |
| 003 | First Run freezes dataset-wide definitions/upstream versions; selected PREPARED attempt | Merged |
| 004 | Run/Retry, stable dispatch identity, FakeExecutor, ambiguous dispatch handling | Merged |
| 005 | Executor status reconciliation, stale callback protection, terminal attempt/job updates | Merged |
| 006 | Explicit Submit Validation; Publish/Reject/Abandon with series coordination and active-attempt guard | Merged |

These merges are implementation status, not evidence that the final combined milestone has passed its full end-to-end verification gate.

## Current milestone: Task 007 — End-to-End Hardening and Legacy Cleanup

**Status: design priorities accepted; implementation and independent PostgreSQL verification pending.**

Master scope: docs/tasks/007-end-to-end-hardening-and-legacy-cleanup.md

Agreed order and independent review packages:

1. **007A — Cross-workflow concurrency investigation (NEXT).**
   Deterministically test dispatch-result-vs-terminal-reconciliation (CON-01), and same-identity conflicting dispatch results (CON-02). Classify valid executor behavior vs adapter contract violation vs local bug. No production fix yet.
2. **007B — Evidence-grounded concurrency remediation (ARCHITECTURE APPROVED; IMPLEMENTATION PENDING).**
   007A confirmed CON-01 as a valid late-response HTTP 500 and CON-02 as the current FakeExecutor external/local identity split. 007B-1 has a bounded late-response fix spec. The system owner accepted Option A for CON-02; ADR-0008 now requires irrevocable identity-wide REJECTED and 007B-2 has a bounded FakeExecutor/contract regression spec. Both slices need independent owner reviews and green real-PostgreSQL verification before closure.
3. **007C — API contract hardening.**
   Validate job UUIDs, bound callback identity fields, validate supported raw ingestion at runtime, ensure dev/test-only FakeExecutor controls, verify actual public error codes/shape.
4. **007D — Complete E2E and reproducible PostgreSQL test gate.**
   Cover successful publication, failure/retry, response loss/recovery, rejection, safe abandonment and late callbacks. Run all existing v2 suites and raw ingestion via one documented command; record real test evidence.
5. **007E — Safe dead-code cleanup and documentation sync.**
   Remove only proven-unused application artifacts; update README, AGENTS, ARCHITECTURE and ROADMAP. Do not change historical migration/data.

Task definitions are available under docs/tasks/007a through 007e. Specific Task 007B follow-ups are docs/tasks/007b1-late-dispatch-terminal-reconciliation.md and docs/tasks/007b2-definite-rejection-semantics-review.md. Accepted identity guarantee: docs/adr/0008-identity-scoped-definite-dispatch-rejection.md. The 007A red evidence suite and investigation artifacts currently exist only on feature/task-007a-concurrency-investigation, not main.

### Retained scope

The raw-ingestion endpoint and module remain **supported** in this milestone. They are not dead code. Preserve their test, schema, applied migrations, and any historical data.

Legacy cleanup rules:
- verify zero remaining supported callers before application code deletion;
- keep v1/v2 migration files immutable and retain historical/audit data;
- no broad refactor or dependency upgrade sweep;
- no new technology just for portfolio breadth.

## Completion gate

Do not mark Task 007 or the Orchestration Core v2 milestone COMPLETE until:

- CON-01/CON-02 are proven or ruled out with deterministic PostgreSQL/executor evidence, and verified fixes for real regressions;
- all documented public error contracts and malformed input paths are covered;
- cross-service lifecycle E2E scenarios pass with immutable snapshot/attempt history;
- a single reproducible PostgreSQL test command runs build and all existing six v2 suites plus supported raw-ingestion and new E2E tests;
- captured environment/command/exit-code and test results prove green on a real PostgreSQL instance;
- zero known critical lifecycle/concurrency regressions remain;
- historical migration/data are preserved and developer docs accurately represent current code;
- system owner independently reviews and approves the evidence.

Test files existing on disk do not alone satisfy this gate.

## Deferred until a concrete requirement

- actual Airflow HTTP integration and cancellation,
- automatic/periodic reconciliation workers,
- downstream job scheduling or job-to-job graphs,
- RabbitMQ, Redis, Kafka, Kubernetes,
- retirement of raw-ingestion or historical DPR tables,
- a new reporting identity grain beyond current quarterly model.
