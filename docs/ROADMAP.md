# Roadmap

The Cost Engine Orchestration Platform is a portfolio backend. Accepted decisions live in docs/adr/, implementation invariants in docs/ARCHITECTURE.md, and bounded specifications in docs/tasks/. It is not a previous employer's production implementation.

## Verified main baseline

Task 007E starts from **74f08823e8be099ef4eef5b6fa8d3c43cf019b09**, fetched origin/main on 2026-10-15. Task 007D reviewed commit 54dac9e3fa0c3dfcb5d1f151dfcddd6205f8c5de is an ancestor of this baseline; its runner, E2E tests and historical verification report are on main. This is a verified merge prerequisite, not an assumption based on code review.

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
| 007E | Supported-caller/dependency audit and developer documentation synchronization | Feature branch; awaiting review, **not merged** |

PR references: [#7](https://github.com/good74152/cost-engine-orchestration-platform/pull/7), [#8](https://github.com/good74152/cost-engine-orchestration-platform/pull/8), [#9](https://github.com/good74152/cost-engine-orchestration-platform/pull/9), [#10](https://github.com/good74152/cost-engine-orchestration-platform/pull/10), [#11](https://github.com/good74152/cost-engine-orchestration-platform/pull/11).

Task 007A's historical red evidence is retained as investigation history. It does not mean current supported CON-01/CON-02 regressions should fail: accepted fixes and green regressions are merged.

## Current milestone: Task 007 — End-to-End Hardening and Legacy Cleanup

**Status: Task 007E awaiting review; overall milestone NOT COMPLETE.**

- [Master scope/acceptance gates](tasks/007-end-to-end-hardening-and-legacy-cleanup.md)
- [Current Task 007E specification](tasks/007e-legacy-and-documentation-cleanup.md)
- [Historical Task 007D executed verification](verification/task-007d-milestone.md)
- [Task 007E audit and new PostgreSQL rerun](verification/task-007e-cleanup.md)
- [API error contract coverage inventory](tasks/007c-api-error-contract-coverage.md)

The historical D report records its own tested revision and review-time status; its original evidence is not rewritten to claim the later merge or the E branch was tested. The E note records its own source revision and results separately.

Task 007E preserves accepted state machines, locking/transaction boundaries, public DTOs/errors and executor semantics. The service barrel still has a supported Task 003 test caller and is retained. No speculative deletion or test-import rewrite is required merely to increase cleanup volume.

### Retained supported scope

Raw ingestion remains supported: src/modules/raw-ingestion/, POST /raw-ingestion-batches, its 20-request regression, raw domain identifiers, migrations and data. It is not obsolete orchestration creation.

All six applied migrations, historical DPR performance/input snapshots, raw tables and legacy_business_key compatibility bridge remain unchanged. Dependencies and package/milestone scripts are retained unless positive supported-workflow evidence proves removal safe. No upgrade sweep.

## Verification and completion gate

Reproducible command: npm run test:milestone (also runs the build); separately run npm run build. Node.js 24+ and a real PostgreSQL test service are required. See README for configuration, owned disposable database permissions and raw-ingestion isolation. Do not run the standalone raw test against a persistent developer database.

Task 007D has recorded a full real PostgreSQL PASS; Task 007E must also rerun the unchanged complete gate after its own changes. A static test inventory is not execution evidence.

Do not mark Task 007 or Orchestration Core v2 COMPLETE until:

- CON-01/CON-02 and focused B-1 regressions pass with accepted executor behavior;
- public error contracts, malformed inputs, immutable snapshot/attempt history and E2E flows pass;
- the full sequential build/runner/schema/lifecycle/concurrency/API/raw/E2E gate passes on real PostgreSQL, without failures/skips/cancellations/TODOs, with successful owned teardown;
- Task 007E cleanup and documentation are verified and reviewed;
- historical migration/data and supported routes are preserved;
- System Owner gives final acceptance;
- Task 007E is merged.

The E feature branch does not pre-approve those last acceptance/merge steps. Any later milestone-completion status update is a separate owner-authorized change.

## Deferred until a concrete requirement

- Real Airflow HTTP adapter and external cancellation.
- Automatic/periodic reconciliation or background dispatch workers.
- Queues, Redis, RabbitMQ, Kafka or Kubernetes.
- Automatic publication, dependency-definition management APIs, downstream scheduling/job-to-job graphs.
- Retirement of supported raw ingestion or historical DPR/schema/data.
- A reporting identity grain beyond the accepted quarterly model.

FakeExecutor is the only implemented adapter and is limited to explicit development/test use. Its in-memory execution/tombstone state is not cross-process or restart durability.
