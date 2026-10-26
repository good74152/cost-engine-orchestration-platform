# Roadmap

The Cost Engine Orchestration Platform is a portfolio backend. Accepted decisions live in docs/adr/, implementation invariants in docs/ARCHITECTURE.md, and bounded specifications in docs/tasks/. It is not a previous employer's production implementation.

## Verified main baseline

Accepted main baseline: **1f441eb6e430ba2acd0078cf9ce48045cfeb6e67**, fetched and verified on 2026-10-16. Task 007E PR #12 is merged, with all Task 007A–007E implementation and recorded acceptance evidence on main. The [final acceptance record](verification/task-007-final-acceptance.md) distinguishes the tested source, implementation merge, System Owner approval and pending documentation-closure merge.

## Completed implementation slices on main

| Task | Implemented capability | Merge status |
|---|---|---|
| 001 | Schema/migrations and PostgreSQL persistence invariants | Merged |
| 002 | Canonical series identity; atomic DRAFT allocation and active-type job set | Merged |
| 003 | First Run freezes dataset-wide definitions/upstream versions; selected PREPARED attempt | Merged |
| 004 | Run/Retry, stable dispatch identity, FakeExecutor, ambiguous dispatch handling | Merged |
| 005 | Executor reconciliation, stale callback protection, terminal attempt/job updates | Merged |
| 006 | Explicit Submit Validation; Publish/Reject/Abandon with coordination and guards | Merged |
| 007A | Deterministic CON-01/CON-02 investigation and before-fix evidence | Merged — PR #7, e4d531c |
| 007B-1 | Late dispatch response preserves terminal reconciliation/history | Merged — PR #8, d1465d7 |
| 007B-2 | ADR-0008 irrevocable identity-wide rejection; FakeExecutor compliance | Merged — PR #9, 273eac6 |
| 007C | Public error/input contracts, supported raw validation, dev/test fake-control gating | Merged — PR #10, 58dd1b7 |
| 007D | Sequential fail-closed milestone runner, integrated Flow A–F and PostgreSQL evidence | Merged — PR #11, 74f0882 |
| 007E | Supported-caller/dependency audit, documentation synchronization and verified teardown corrections | Merged — PR #12, 1f441eb |

PR references: [#7](https://github.com/good74152/cost-engine-orchestration-platform/pull/7), [#8](https://github.com/good74152/cost-engine-orchestration-platform/pull/8), [#9](https://github.com/good74152/cost-engine-orchestration-platform/pull/9), [#10](https://github.com/good74152/cost-engine-orchestration-platform/pull/10), [#11](https://github.com/good74152/cost-engine-orchestration-platform/pull/11), [#12](https://github.com/good74152/cost-engine-orchestration-platform/pull/12).

Task 007A's historical red evidence is retained as investigation history. It does not mean current supported CON-01/CON-02 regressions should fail: accepted fixes and green regressions are merged.

## Accepted milestone: Task 007 — End-to-End Hardening and Legacy Cleanup

**Task 007 Milestone — COMPLETE. Orchestration Core v2 — ACCEPTED. System Owner — APPROVED.** Senior Architecture Review APPROVED; Architecture Defense PASSED. Approval is recorded on 2026-10-16 (Asia/Taipei); Tasks 007A–007E are MERGED. This does not claim production deployment readiness.

The authorized teardown investigation confirmed a pool-accounting/client-close race before forced database removal. Bounded test-fixture corrections cover Task 007C and the same defect subsequently observed in terminal-lifecycle verification. Three independent C runs and the complete gate now pass, including isolated raw ingestion and E2E Flow A–F. The E note preserves both earlier failed gates and all diagnostic attempts; no failure was hidden and no production behavior was changed.

- [Final acceptance record](verification/task-007-final-acceptance.md)
- [Original master scope/acceptance gates](tasks/007-end-to-end-hardening-and-legacy-cleanup.md)
- [Task 007E specification](tasks/007e-legacy-and-documentation-cleanup.md)
- [Historical Task 007D executed verification](verification/task-007d-milestone.md)
- [Task 007E audit and new PostgreSQL rerun](verification/task-007e-cleanup.md)
- [API error contract coverage inventory](tasks/007c-api-error-contract-coverage.md)

The historical D/E reports record their own tested revisions and review-time states. They are preserved unchanged; the final acceptance record supersedes their pending-review language for current closure status, without claiming new execution or GitHub CI results.

Task 007E preserves accepted state machines, locking/transaction boundaries, public DTOs/errors and executor semantics. The service barrel still has a supported Task 003 test caller and is retained. No speculative deletion or test-import rewrite is required merely to increase cleanup volume.

### Retained supported scope

Raw ingestion remains supported: src/modules/raw-ingestion/, POST /raw-ingestion-batches, its 20-request regression, raw domain identifiers, migrations and data. It is not obsolete orchestration creation.

All six applied migrations, historical DPR performance/input snapshots, raw tables and legacy_business_key compatibility bridge remain unchanged. Dependencies and package/milestone scripts are retained unless positive supported-workflow evidence proves removal safe. No upgrade sweep.

## Verification and satisfied acceptance gate

Reproducible command: npm run test:milestone (also runs the build); separately run npm run build. Node.js 24+ and a real PostgreSQL test service are required. See README for configuration, owned disposable database permissions and raw-ingestion isolation. Do not run the standalone raw test against a persistent developer database.

Task 007D has recorded its historical real PostgreSQL PASS. Task 007E now separately records a new complete PASS at c0f09b290d1c729760637837410951d33a680333 (246 passing entries), after its own fixture corrections. A static inventory or historical D result is not substituted for this execution evidence.

The final acceptance record confirms the milestone gates were satisfied:

- CON-01/CON-02 and focused B-1 regressions pass with accepted executor behavior;
- public error contracts, malformed inputs, immutable snapshot/attempt history and E2E flows pass;
- the full sequential build/runner/schema/lifecycle/concurrency/API/raw/E2E gate passes on real PostgreSQL, without failures/skips/cancellations/TODOs, with successful owned teardown;
- Task 007E cleanup and documentation are verified and reviewed;
- historical migration/data and supported routes are preserved;
- System Owner explicitly approved final acceptance;
- Task 007E is merged via PR #12.

Implementation acceptance and merge are complete. This separately authorized documentation-only closure still awaits its own review/merge; it does not begin another task or define Task 008 requirements. The preserved execution evidence is not a new PostgreSQL run on the merge or closure commit.

## Backlog

### Demo runtime extensions

Demo-01A (PR #15), Demo-01B-1 (PR #20), Demo-01B-2 (PR #24) and the company-code
collision fix (PR #25) are merged at Demo-02A's fetched main baseline 2c44809.
B2 provides owner-scoped Reset, cookie clearing, startup invalidation and bounded
inactive-owner cleanup; see the [bounded task and evidence](tasks/demo-01b2-session-reset-recovery.md)
and [ADR-0010](adr/0010-demo-session-reset-and-recovery.md). Task 007 financial
lifecycles and applied migrations are unchanged. No UI/scenarios, distributed
coordination or public deployment readiness is implied.

Demo-02A (PR #26) is merged at 72f4369. It adds an explicit transactional
minimal CAPEX seed and protected PostgreSQL Dataset/Job/Attempt read APIs.
Reads use existing ownership/coordinator security and bounded pagination.
See the
[bounded contract and verification](tasks/demo-02a-shared-seed-read-apis.md).
No Scenario Runner, frontend, later Demo-02 work or accepted core redesign.

Demo-02B is merged via PR #27 at 876d030. It adds durable one-Scenario-per-session
Create/Get, Create idempotency, manual-mode isolation and same-transaction
Reset/recovery/maintenance integration. See [the bounded task/evidence](tasks/demo-02b-scenario-persistence.md)
and [ADR-0011](adr/0011-demo-scenario-persistence-and-mode-isolation.md).
Demo-02C is merged via PR #28 at 6427346. It adds six explicit
HAPPY_PATH steps, durable request/intent/result ledger, safe Domain-progress
recovery, pending-step read and same-transaction Reset integration.
See [bounded contracts/evidence](tasks/demo-02c-happy-path-step-execution.md)
and [ADR-0012](adr/0012-demo-scenario-step-idempotency.md).

Demo-02D is merged via PR #29 at 13a8907.
It adds only the nine-step FAILURE_RETRY flow, binding new Attempt 2 to the same
Job/frozen inputs while preserving failed Attempt 1. It reuses the existing ledger,
idempotency, transaction and Reset protocols; a forward migration enforces type
bounds/bindings without changing applied migrations or core Retry.
See [bounded contracts/evidence](tasks/demo-02d-failure-retry-scenario.md).
Demo-02E is merged via PR #30 at 0c80b44, including manual-fake admission hardening.
It adds only the six-step LOST_RESPONSE_RECOVERY flow: a Demo-only executor
decorator loses an actual acceptance ACK, then existing Core dispatch recovery
confirms the same Attempt 1 and full external identity. It retains ledger A/B,
security/Reset and Happy/Failure rules; only a forward validator migration is
added. See [bounded contracts/evidence](tasks/demo-02e-lost-response-recovery.md).
Demo-03 starts from freshly fetched 0c80b44 on feature/demo-03-frontend-ui.
It adds a React/Vite/Tailwind dashboard, three explicit Guided flows, Free
Exploration, session management and paged resource/history views. Browser request
IDs persist by session/scenario/step; PostgreSQL progress stays authoritative.
The UI does not implement backend state transitions or fake execution results.
Vitest/RTL and actual Chromium/Backend/PostgreSQL smoke evidence accompany real
screenshots. See [bounded contracts and verification](tasks/demo-03-frontend-ui.md).
System Owner review is required; no automatic merge. Demo-04 deployment,
background execution and distributed Demo remain deferred.

### Naming-01 — Rename COWOS_S to E2E_COST

**Status: BACKLOG — Architecture Review Required**

Goal: rename the canonical dataset domain identifier from `COWOS_S` to `E2E_COST`.

Before implementation, investigate:

1. TypeScript domain definitions and validation.
2. REST API compatibility.
3. PostgreSQL persisted domain values.
4. Calculation types and dependency definitions.
5. Existing migrations and historical data.
6. Tests and documentation.
7. Rollout and backward compatibility.

Constraints:

- Do not modify applied migrations.
- Do not delete historical data.
- Do not change dataset identity semantics beyond the approved rename.
- Do not implement aliases without an approved decision.
- Do not perform the rename in Docs-03B; `COWOS_S` remains the current canonical identifier.

Naming-01 requires a separate architecture review and bounded implementation task.

## Deferred until a concrete requirement

- Real Airflow HTTP adapter and external cancellation.
- Automatic/periodic reconciliation or background dispatch workers.
- Queues, Redis, RabbitMQ, Kafka or Kubernetes.
- Automatic publication, dependency-definition management APIs, downstream scheduling/job-to-job graphs.
- Retirement of supported raw ingestion or historical DPR/schema/data.
- A reporting identity grain beyond the accepted quarterly model.

FakeExecutor is the only implemented adapter and is limited to explicit development/test use. Its in-memory execution/tombstone state is not cross-process or restart durability.
