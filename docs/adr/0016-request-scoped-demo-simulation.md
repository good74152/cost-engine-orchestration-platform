# ADR-0016 — Request-Scoped Demo Simulation on Shared Execution Identities

- Status: Accepted task specification; implementation requires System Owner review.
- Date: 2026-10-28
- Authority: System Owner's Demo-05B-2 bounded task.
- Supplements: ADR-0015 admission; ADR-0008 identity-wide rejection and
  ADR-0010/0012 Reset/Guided semantics remain unchanged.

## Decision

Explicit simulation Run uses a request adapter over the existing session fake.
It never creates another fake, changes its default, or consumes its shared script
queue. Core receives only the existing CalculationExecutor contract. Reconcile
reads that same session fake, not the request adapter. Completion changes only
the external fake state; PostgreSQL terminal state still requires Core Reconcile.

Fake execution creation and irrevocable rejection are synchronous decisions for
the full DAG/run identity on that instance. The first actual decision wins.
Existing execution returns ALREADY_EXISTS; an existing rejection stays REJECTED.
Later settings never change its original simulation, live state, or command.
The original explicit simulation is retained with that identity until Reset
releases the fake. This is a creation/rejection fact, not an operation log.
Manual fake state controls may still change the live external state afterward.

Explicit Run responses report requested and applied simulation separately.
APPLIED means this request made the recorded decision; EXISTING means another
request already made it. UNBOUND means no execution/rejection decision exists.
UNKNOWN means an execution/rejection exists without known explicit settings,
such as a legacy dispatch. Both unknown cases report applied=null; never infer
an original simulation from the current live external state.

The same report also accompanies 502 EXECUTOR_DISPATCH_FAILED for an explicit
Run when its adapter observed REJECTED for the exact full dispatch identity.
The route catches only ExecutorDispatchFailedError. The adapter copies DAG/run
identity from that actual command and reads the fake's recorded decision; never
look up a latest attempt by Job ID or assume requested settings were applied.
If that identity is unavailable, retain the original error without a report.
Legacy {} errors and all other errors retain their original contracts. The
global error boundary, Core service and Fake decision semantics are unchanged.

UNKNOWN_WITHOUT_CREATION does not select an immutable simulation. A later request
may create or reject that same identity. Keep only a transient count of explicit
no-run UNKNOWN calls until their Core outcome recording finishes (also release
on errors). While one is outstanding, a requested REJECT cannot establish an
irrevocable rejection safely: a late UNKNOWN write after DISPATCH_FAILED would
violate Core's existing invariant. Return UNKNOWN with no binding instead; the
response reports UNBOUND unless another request has since created the identity.
This does not claim the requested REJECT was applied. Once recording has drained,
rejection is allowed. Acceptance/recovery never waits for this transient count.
No permanent unknown binding, SQL lock, mutex or Core change is introduced.

| Operation | Admission |
|---|---|
| Manual Run with a valid explicit simulation | Parallel, maximum four slots |
| Manual Reconcile | Parallel, maximum four slots |
| Legacy Run with exactly {} | Existing Exclusive FIFO |
| Guided Scenario Create/Next and old Fake controls | Existing Exclusive FIFO |
| Reset | Existing synchronous idle-only reservation |

All commands still authenticate, enforce Origin/CSRF, revalidate eligibility,
check mode and ownership. Pure Run body validation chooses the gate after
authentication/CSRF. Exclusive barriers include the entire Core/executor call;
Reset cannot release a fake with an admitted call still using it. No PostgreSQL
transaction or Session row lock spans executor dispatch/status lookup.

## Limits

Single Demo backend, in-memory fake state, no concurrent external/Core writer.
No Core rules, transaction order, immutable snapshot, migrations or security
changes. No operation history, UI, terminal-state shortcut or distributed lock.
Process restart and ambiguous Reset retain the existing recovery semantics.
See [contracts and executed tests](../tasks/demo-05b2-per-request-fake-executor.md).
