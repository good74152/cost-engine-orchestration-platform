# ADR-0012 — Guided Scenario Step Idempotency and Recovery

- Status: Accepted
- Date: 2026-10-25
- Authority: System Owner's Demo-02C bounded specification. Implementation still
  requires review; this record does not approve or merge its PR.

## Decision

HAPPY_PATH has six explicit steps. Keep four separate facts: financial Domain
state, Scenario progress, the durable Step ledger, and external FakeExecutor
state. An external success is not a reconciled job success. A successful Domain
commit is not a committed Scenario step.

Inside the existing session coordinator, transaction A locks/revalidates the
session, locks the owned Scenario and its ledgers, checks the ledger BEFORE
progress, and reserves a PENDING intent. PostgreSQL uniqueness on Scenario/step
and Scenario/request is the backstop. Same-request completed replay returns the
original stored response, even after later steps. Another request cannot take
over a pending step or reuse its request ID on a different step.

Commit A before inspecting/performing Domain work. Use existing Domain services,
not manual HTTP routes or direct lifecycle SQL. Short recovery reads wait out
earlier Domain writes using existing series or version/job/attempt lock order,
then release all locks before any Domain/executor call. Never hold a Scenario
transaction across dispatch or reconciliation.

Transaction B locks/revalidates the session, Scenario and ledger, checks the
same exact resource binding and success condition, and atomically completes the
ledger and progress. Step 6 completes the Scenario in that same transaction.
Discard suspect COMMIT connections. A separate bounded connection takes the
same root locks before reading a fresh durable ledger/progress snapshot. An
unconfirmed reservation must not start Domain work. An unconfirmed completion
must not blindly repeat Domain work. Confirmed rollback leaves safe same-request
recovery available; unavailable truth returns explicit 503.

## Resource proof

Before creation, freeze CAPEX / authenticated company / 2026 / Q4 / version 1 /
DEMO_GUIDED_SUMMARY. Recover only that exact version and its complete one-job
set; an empty/partial series or other version is a conflict, not permission to
allocate version 2. The caller supplies no resource or execution identity.

Step 2 binds the sole attempt, snapshot and frozen definition. A persisted
RUNNING/ACCEPTED result completes progress without another dispatch. UNKNOWN
reuses the existing DISPATCHING identity; unconfirmed success stays PENDING/202.
Definite rejection cannot create a second Happy Path attempt on retry. Failure
scenarios are not implemented. Preserve ADR-0008 rejection guarantees.

Steps 3–6 freeze and verify the same dataset, job, attempt, snapshot, definition
and full DAG/run identity. Step 3 checks/sets the owning session's fake only;
PostgreSQL stays RUNNING/ACCEPTED. Step 4 recovers durable SUCCEEDED without an
unnecessary lookup. Steps 5/6 recover exact VALIDATING/PUBLISHED without another
lifecycle call. Contradictory/missing resources fail closed. PostgreSQL validates
ledger owner/parent chains, legal completion results and immutable intent/history.

## Reset and limits

Extend the existing Reset transaction: ledger, Scenario, domain graph, revocation.
Rollback restores all. Unknown-outcome checks include ledgers; fake release still
requires confirmed cleanup. Ledger FK RESTRICT also prevents an orphan ledger
from surviving Scenario deletion. Inactive maintenance uses this same path.

Pending-step GET is a coordinated owned PostgreSQL read, not fake inspection or
progress mutation. Existing Scenario DTOs and manual-mode separation remain.
Startup invalidates old sessions; persisted ledgers never recreate lost fake
executions. Single Demo backend only, no other core/external/config writer.
No distributed recovery, frontend, background runner, new core state machine,
new executor contract or financial calculation is added.
