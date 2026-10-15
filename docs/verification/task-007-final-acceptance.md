# Task 007 — Orchestration Core v2 Final Acceptance

## Acceptance record

| Item | Accepted record |
|---|---|
| Milestone | Task 007 — End-to-End Hardening and Legacy Cleanup |
| Milestone status | Task 007 COMPLETE; Orchestration Core v2 ACCEPTED |
| Acceptance status | APPROVED BY SYSTEM OWNER |
| Senior Architecture Review | APPROVED |
| Architecture Defense | PASSED |
| Implementation | Tasks 007A–007E MERGED |
| Final implementation merge | [PR #12](https://github.com/good74152/cost-engine-orchestration-platform/pull/12) |
| Accepted main commit | 1f441eb6e430ba2acd0078cf9ce48045cfeb6e67 |
| Approval authority | System Owner |
| Approval date recorded | 2026-10-16 (Asia/Taipei), date of the explicit final-acceptance authorization supplied with this closure request |
| Approval basis | Explicit final acceptance in the project review conversation following technical review and architecture defense |

This records the System Owner's explicit authorization, not an approval inferred by the implementation agent. No separate earlier review timestamp, GitHub approval event, cryptographic signature or external attestation is asserted.

Implementation acceptance and this documentation merge are distinct. PR #12 is merged; this documentation-only closure is prepared on docs/task-007-final-milestone-closure from the accepted main commit and awaits its own owner review/merge. Approval of Task 007 does not mean this closure branch has already been merged. No automatic merge is authorized.

Git first-parent history confirms Task 007A (#7), 007B-1 (#8), 007B-2 (#9), 007C (#10), 007D (#11) and 007E (#12) on main. PR #12's merged state and merge SHA were also confirmed through GitHub metadata. The accepted implementation scope for Tasks 002–007 is complete; the broader portfolio project continues to evolve.

## Accepted implemented capabilities

- Canonical Dataset Series identity (domain, company_code, fiscal_year, period), monotonic Dataset Version allocation, and multiple Calculation Jobs per Dataset Version.
- One immutable dataset-wide Build Snapshot at First Run, frozen upstream published Dataset Versions, and versioned dependency-definition pins reused by later jobs and retries.
- Durable Execution Attempts with stable platform-generated external identities; Run/Retry; FakeExecutor dispatch; ambiguous response-loss recovery; executor-truth reconciliation and callback-triggered reconciliation.
- Explicit Submit Validation, Publish/Reject/Abandon, dataset terminal-state immutability and historical attempt immutability.
- CON-01 late-response remediation, CON-02 identity-scoped definite rejection, API contract hardening, supported raw ingestion, and real PostgreSQL integration/concurrency verification.

The backend orchestrates financial calculation execution; it does not implement the financial calculation logic or reproduce proprietary employer systems.

## Accepted architecture guarantees

The binding rationale remains in [Architecture](../ARCHITECTURE.md) and [accepted ADRs](../adr/README.md); no decision is changed by this acceptance record.

- Dataset Series is the coordination root for logical-series allocation/publication visibility. Public lifecycle operations retain their accepted transaction boundaries and deterministic lock protocols, including the distinct First Run hierarchy.
- First Run freezes exactly one immutable dataset-wide snapshot. Retries preserve frozen upstream versions and dependency-definition pins; they do not resolve newer inputs.
- A new Execution Attempt is allocated only in an eligible retry state with no conflicting active attempt. PREPARED/DISPATCHING attempts are reused; ambiguous dispatch preserves the same attempt and external execution identity.
- UNKNOWN is a dispatch outcome, **not** an attempt status. An unresolved ambiguous result leaves the attempt DISPATCHING, not DISPATCH_FAILED.
- Reconciliation uses executor truth. Callback payloads are triggers, not authoritative execution outcomes. External executor calls do not hold orchestration transactions/row locks.
- Late dispatch responses cannot rewrite committed terminal history. A newer retry's logical state cannot be overwritten by an older attempt.
- REJECTED is the irrevocable identity-wide no-run guarantee defined by [ADR-0008](../adr/0008-identity-scoped-definite-dispatch-rejection.md), not a per-request observation.
- Supported raw ingestion remains intact. Historical migrations, compatibility structures and data are preserved; acceptance does not authorize their retirement.

## Recorded verification evidence

The preserved reports are the execution evidence:

- [Task 007D milestone verification](task-007d-milestone.md): earlier integrated gate and its own tested revision.
- [Task 007E cleanup and corrected verification](task-007e-cleanup.md): final accepted execution, diagnostic attempts, failed runs, fixture corrections and successful rerun.

Final Task 007E execution recorded there:

| Observation | Recorded result |
|---|---|
| Executed source commit | c0f09b290d1c729760637837410951d33a680333 |
| Executed source tree | 095375e8f1a02db44f68e846c0dabec59a954b06 |
| Execution date | 2026-10-15 (Asia/Taipei) |
| Node.js | 24.18.0 |
| PostgreSQL | 18.6 |
| Command | npm.cmd run test:milestone |
| Overall process exit | 0 |
| Test entries | 246 PASS; 0 FAIL; 0 SKIP; 0 CANCELLED; 0 TODO |
| Milestone commands | All 13 PASS |
| Database teardown | Reported successful; no disposable databases or fixture sessions remained |

The complete gate covers TypeScript build, runner regressions, PostgreSQL schema/migration checks, dataset creation, immutable snapshot, dispatch, reconciliation, terminal lifecycle, CON-01/CON-02, focused 007B-1, 007C contracts, isolated raw ingestion, and E2E Flow A–F. Counts include Node parent/nested entries; full per-command evidence and earlier failures remain in the reports rather than being duplicated here.

The accepted main merge contains the tested implementation plus later documentation updates. Git comparison confirms its source/tests/migrations/package files match the recorded tested source. This does **not** claim that merge commit 1f441eb6e430ba2acd0078cf9ce48045cfeb6e67, or the later documentation-closure commit, independently executed PostgreSQL verification.

No new build, integration test or PostgreSQL run is claimed by this documentation-only closure. No GitHub CI check was established for this milestone; this record does not claim GitHub CI passed. Historical reports' earlier review/pending language remains untouched as evidence of their actual review-time state. This acceptance record supersedes that historical language only for current milestone closure status.

## Accepted limitations and deferred engineering

FakeExecutor is the only implemented executor adapter and is explicitly development/test only. Its external execution and rejection-tombstone state is instance-local and in-memory. No cross-process or restart durability is claimed. A future Airflow adapter must independently establish its identity-based execution guarantees.

The accepted milestone does not implement:

- A real Airflow HTTP adapter or production Airflow integration.
- Executor cancellation, periodic reconciliation workers, automatic publication or distributed dispatch coordination.
- Message queues or new background infrastructure.
- Production authentication/authorization or complete production observability.
- A CI/CD pipeline.

These are future engineering concerns, not delivered capabilities. Milestone acceptance is **not production deployment readiness**.

## System Owner safety principle for future integration

For financial calculation workflows, correctness takes priority over automatic recovery when external execution outcome cannot be established.

For a hypothetical future executor without reliable identity deduplication, an ambiguous result must not trigger blind redispatch. Prefer safe investigation and controlled recovery over risking duplicate financial computation or writes.

This is an architectural safety preference for future integration design, not a newly implemented manual-approval workflow. It does not change current supported FakeExecutor Run/Reconcile or same-identity recovery behavior. Any weaker-executor integration requires separate architecture review and, if warranted, a new ADR.

## Closure boundary

Task 007 is COMPLETE, Orchestration Core v2 is ACCEPTED, and Tasks 007A–007E are MERGED under the explicit System Owner approval recorded above. This document does not open Task 008 or define another milestone. Future substantial work requires its own architecture review and bounded task.
