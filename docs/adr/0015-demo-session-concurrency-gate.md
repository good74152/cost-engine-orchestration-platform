# ADR-0015 — Demo Session Parallel and Exclusive Admission

- Status: Accepted specification; implementation requires System Owner review.
- Date: 2026-10-28
- Authority: System Owner's Demo-05B-1 bounded task.
- Supplements: ADR-0010/0011/0012; their Reset recovery, mode isolation and Step
  idempotency rules remain. Core locking and financial rules are unchanged.

## Decision

Replace the Demo coordinator's universal serialization with a per-session gate
inside the same single backend. Admit up to four Parallel operations. Reserve a
slot synchronously before awaiting eligibility revalidation or a predecessor.
The fifth Parallel admission immediately returns 429 DEMO_SESSION_QUEUE_FULL.
Failed revalidation or body execution releases its slot in finally.

| Operation | Admission |
|---|---|
| Manual Dataset Create and dataset lifecycle commands | Parallel |
| Protected Dataset/Job/Attempt and Scenario GETs, including pending-step | Parallel |
| Scenario Create and Guided Next | Exclusive FIFO |
| Manual Job Run/Reconcile and both Fake controls | Exclusive FIFO until Demo-05B-2 |
| Reset / inactive-owner cleanup | Synchronous idle-only reservation, never queued |

Session bootstrap/current-cookie authentication and health retain their existing
behavior; this gate governs protected domain/scenario operations. HTTP parsing,
authentication, Origin/CSRF and ownership checks are not bypassed by a slot.

An Exclusive operation waits for every earlier Parallel and Exclusive operation.
Later Parallel operations wait for that Exclusive completion. Consecutive
Parallel operations can start together; no per-session promise tail serializes
that batch. Each Exclusive captures only earlier Parallel completions, preventing
circular waits. This ordering covers the whole admitted body, including Domain
commits and executor calls, without holding a PostgreSQL Session row lock.

Waiting Parallel operations occupy their four slots too. The existing overall
bound of 32 admitted/queued operations and 1024 tracked session/reservation entries
remains; no unbounded queue, eviction or application-wide mutex is introduced.
Guided Next and executor-sensitive commands retain their bounded FIFO semantics.
All operations revalidate durable Session eligibility when their turn begins.
Failures do not poison later work. Sessions remain independent.

Scenario Create cannot overlap an admitted Manual mutation. Manual-first completes
before Create checks the empty owner graph; Create-first completes before Manual
mode admission checks for a Scenario. Unknown Create COMMIT still resolves through
the existing PostgreSQL Session lock and fresh Scenario read. No SQL lock is held
while waiting in this gate or across executor work.

Reset reserves only when no operation is running, waiting or revalidating. Busy
Reset returns 409 RESET_CONFLICT immediately. Its reservation denies both admission
classes with 409; unknown Reset outcomes retain 503 DEMO_RESET_OUTCOME_UNKNOWN
until the unchanged fresh-connection recovery resolves durable truth. Reset SQL,
cleanup order, fake release-after-commit, ownership and cookie clearing remain.

## Limits

This gate protects Demo admission/mode/Reset only. PostgreSQL remains the
allocation and lifecycle authority: simultaneous same-series creates reach Core
and contend on the existing canonical series lock/constraints. There is no new
Core transaction, Session SQL lock across an executor call, distributed lock,
FakeExecutor change, request-specific fake, workflow template or UI redesign.
Single Demo backend and no concurrent Core/external writer remain required.
