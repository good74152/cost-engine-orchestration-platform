# Task 007B — Evidence-Grounded Cross-Workflow Remediation

- Status: IN PROGRESS (design/spec); production implementation not started.
- Investigated baseline: main 85479c723090de8dc96cdb0a13472f3156b5e8f9.
- Evidence source: feature/task-007a-concurrency-investigation, docs/tasks/007a-investigation-results.md and docs/tasks/007a-investigation-evidence.json.
- Verification harness: scripts/cross-workflow-concurrency-investigation.pg.test.ts on the Task 007A branch.
- User authorized Task 007B on actual 007A evidence and explicitly accepted Option A for CON-02: the identity-wide permanent REJECTED contract in ADR-0008. Bounded implementation specs are ready; no production code has been changed.

## 007A confirmed facts

### CON-01 — legitimate dispatch response overtaken by terminal reconciliation

Sequence:
1. /run commits PREPARED → DISPATCHING; external FakeExecutor processes and creates one run; response ACCEPTED is blocked.
2. /reconcile observes external SUCCEEDED and commits attempt/job SUCCEEDED/SUCCEEDED.
3. Original /run receives its delayed ACCEPTED response.
4. Observed original /run: HTTP 500 INTERNAL_SERVER_ERROR; reconciliation: 200; local terminal history correct, one attempt/external run/snapshot.

Cause: recordDispatchOutcome() rejects the already-terminal locked attempt because it expects DISPATCHING plus PENDING/FAILED for an ACCEPTED response.

Classification: **confirmed backend API/concurrency defect under contract-conforming FakeExecutor behavior**.

### CON-02 — overlapping same-identity REJECTED/ACCEPTED

Valid **current FakeExecutor** sequence:
1. A dispatch of identity X returns REJECTED when zero external X runs exist.
2. Overlapping B dispatch of X subsequently creates the run and returns ACCEPTED.
3. If A records DISPATCH_FAILED before B records acceptance: A 502, B 500; attempt 1 DISPATCH_FAILED; job PENDING; external X RUNNING.
4. Manual/callback reconciliation of X returns 409 EXECUTION_NOT_RECONCILABLE.
5. Another /run creates attempt 2 with different identity Y; a second external run may start, while X remains orphaned.

Reversing local recording order is safe: B writes ACCEPTED/RUNNING first; A later observes the accepted state. Actual FakeExecutor checking a previously existing identity also returns ALREADY_EXISTS and is safe. An intentionally lying executor fixture is a separate contract violation; it is not evidence of an additional legal backend race.

Classification: **confirmed split under pre-ADR-0008 FakeExecutor per-call semantics; identity-wide permanent rejection is now accepted by ADR-0008**.

CON-02 demonstrates a critical milestone blocker. Do not merge a claimed Task 007B completion that leaves this supported sequence unresolved.

## Work split and status

- **007B-1 (READY for owner-reviewed bounded implementation):** Fix CON-01 late dispatch response handling without modifying history or lock protocols. Spec: docs/tasks/007b1-late-dispatch-terminal-reconciliation.md.
- **007B-2 (ARCHITECTURE ACCEPTED; BOUNDED IMPLEMENTATION SPEC READY):** Implement ADR-0008 contract enforcement in FakeExecutor and deterministic real PostgreSQL regressions. Spec: docs/tasks/007b2-definite-rejection-semantics-review.md.

These are separate PRs; the first does not pretend to fix CON-02. Do not delegate 007B-2 until the system owner approves its contract choice.

## Grounded runtime evidence

007A report states Node v24.18.0, PostgreSQL 18.6, owned disposable PostgreSQL database migrated with all six checked-in migrations. Investigation command exited 1 with 7 pass / 3 fail / 0 skip (two intentionally red scenario regressions plus parent). Existing separate Task 004 and Task 005 suites passed; Task 006 suite passed on independent rerun after an initial parallel teardown failure. No tests have been rerun in Task 007B at this point.

Never label red investigation tests as green. No production fixes or migrations were delivered by 007A.

## Non-negotiable boundaries

- Preserve ADR-0005 attempt identity, state machine and terminal attempt immutability.
- Preserve Task 004/005 job → attempt locking and all existing dataset-series protocols.
- Executor calls remain outside DB transactions.
- No new attempt on response loss; no snapshot/definition pin refresh.
- Do not 'repair' CON-02 by rewriting DISPATCH_FAILED into ACCEPTED or SUCCEEDED. ADR-0008 resolves the contract through identity-wide permanent rejection, not a history rewrite.
- No speculative multi-process in-memory mutex as the sole safety guarantee.
- No introduction of messaging systems, real Airflow, cancellation, or schema changes during 007B-1.

## Merge and completion gates

007B-1 may be reviewed and merged independently only after its deterministic regression and all relevant real PostgreSQL suites are green. When importing the 007A investigation test harness, do not blindly merge its red evidence commit into main; retain the historical evidence report, convert assertions to accepted behavior, and ensure the integrated test suite is green before merge.

Task 007B overall cannot be marked complete until both 007B-1 and 007B-2 are implemented and independently reviewed, and real PostgreSQL tests prove that the accepted identity-wide guarantee eliminates the previously observed external/local split. A green CON-01 suite alone is insufficient.

System owner reviews Codex output first; then architecture challenge, fixes, verification, merge. Document final commands, exit codes and runtime versions.
