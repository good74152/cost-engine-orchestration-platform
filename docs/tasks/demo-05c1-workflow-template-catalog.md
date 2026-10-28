# Demo-05C-1 — Workflow Template Catalog + Read-only API

- Date: 2026-10-28 (Asia/Taipei).
- Authority: System Owner's bounded Demo-05C-1 request.
- Baseline: main `ed3f29a`; Demo-05B-2 merged as PR #37.
- Branch: `codex/demo-05c1-workflow-template-catalog`, independent worktree.
- Status: implementation and verification; awaiting System Owner Review. No merge.

## Scope and architecture review

Reviewed AGENTS.md, README, Architecture, ADR index and ADR-0011/0012/0015/0016,
Session/Scenario/Domain/read routes, Demo HTTP security/coordinator and the
six-domain seed. This is a static description layer within the existing Demo
boundary; it introduces no new execution/persistence architecture and requires
no new ADR. It does not extend the Guided ledger protocol or Core dependencies.

TypeScript definitions live under `src/modules/workflow-template/`. Templates have
stable IDs, a positive safe integer version, title, description, availability
and steps. Steps have stable local IDs, title/description, a supported operation,
optional canonical domain, prerequisite IDs and expected result. In-memory
validation rejects duplicate IDs, invalid versions/operations/domains, missing
prerequisites and cycles, including self-cycles. Definitions and nested arrays
are frozen after validation. No DB import/seed/configuration query is needed.

Initial definitions (all version 1, availability PREVIEW):

| ID | Steps | Teaching flow |
|---|---:|---|
| HAPPY_PATH | 6 | Create, Run, fake success, Reconcile, Validate, Publish |
| FAILURE_RETRY | 9 | Create, Run, fake failure, confirm failure, Retry, fake success, Reconcile, Validate, Publish |
| LOST_RESPONSE_RECOVERY | 7 | Create, lose executor ACK, explicitly recover original Run identity, fake success, Reconcile, Validate, Publish |
| SIX_DOMAIN_WORKFLOW | 36 | Six explicit operations per domain, publication-first prerequisites |

The lost-response description separates recovery as an explicit operation step;
this does not change the existing six-step Legacy Guided Scenario/ledger. Retry
uses the same Job and snapshot with a new Attempt after confirmed failure.
Lost-response recovery reuses the original Attempt and full DAG/run identity.
Fake terminal state alone never implies a durable Job/Attempt result.

All required Jobs are processed explicitly using returned identities and all
pages of read results. There is no fixed Job count or hard-coded Dataset version.
No Session ID, Company Code, user data, completedStep, execution status/history,
progress, mutable instance or executor belongs to a Template. PREVIEW says the
catalog is described but the new Workflow operation UI is not enabled.

## Six-domain prerequisite graph

| Upstream Step | Downstream Step |
|---|---|
| fab_cost.publish | capex.create |
| capex.publish | dpr.create |
| fab_cost.publish | insurance.create |
| fab_cost.publish | one_std_cost.create |
| one_std_cost.publish | e2e_cost.create |

Each domain also has create → run → fake-success → reconcile → validate → publish.
Use the same selected fiscal year and period throughout. These edges are only
operation guidance. CAPEX's preserved Demo configuration intentionally has no
Core upstream requirement; no Dependency Definition or seed is changed. Core
still resolves latest PUBLISHED inputs under its existing first-Run locks.

## HTTP contract

`GET /demo/workflow-templates` returns exactly `{ "templates": [...] }`; entries
contain exactly id/version/title/description/availability, in the table order
above. `GET /demo/workflow-templates/:id` returns that Template with `steps`.
There are no instance IDs, cursors, timestamps or dynamic progress fields.
See [Reference operation-to-route mapping](../REFERENCE.md#demo-05c-1-workflow-template-catalog).

Demo-only registration. Both routes use existing durable Cookie authentication,
Same-Origin (without Mutation CSRF Header), no-store error boundary and
`runParallel`. No free-mode assertion or Scenario lookup is needed: Guided and
Free Exploration sessions receive identical descriptions. Query rejection and
lookup run inside the gate, so Reset reservations and revalidation apply even
to invalid requests. Catalog GETs do not allocate a FakeExecutor or invoke Domain,
Scenario or Step services. Only authentication/revalidation reads Session rows;
there is no Session mutation or sliding expiry.

| HTTP | Code | Condition |
|---|---|---|
| 400 | INVALID_REQUEST | Any extra query parameter |
| 401 | DEMO_SESSION_UNAVAILABLE | Missing/invalid/unknown/expired/revoked cookie; clear cookie |
| 403 | DEMO_SESSION_CSRF_REJECTED | Foreign Origin or cross-site Fetch Metadata |
| 404 | DEMO_RESOURCE_UNAVAILABLE | Unknown case-sensitive Template ID |
| 409 | RESET_CONFLICT | Reset reservation or busy Reset |
| 429 | DEMO_SESSION_QUEUE_FULL | Existing admission limit, including fifth Parallel request |
| 503 | DEMO_RESET_OUTCOME_UNKNOWN | Existing uncertain Reset reservation |

Handled errors have exactly message/code. Core mode leaves these routes
unregistered. No POST start/next is added, no schema/migrations change, and
Frontend/Legacy Guided/Free Exploration execution behavior remains unchanged.

## Verification

New unit tests cover exact/stable IDs, versions and fields, list/detail equality,
immutability, graph validity via an independent topological check, exact
cross-domain edges, multi-Job descriptions and rejected invalid definitions.
They run with no PostgreSQL URL or server requirement.
The existing GitHub verification workflow also runs the new typecheck and full
unit/HTTP suite against its disposable PostgreSQL service.

New HTTP tests migrate their own `demo_05c1_test_*` database from template0.
They cover all four details without seeded configuration, security/errors,
Demo-only registration and absence of mutation routes. Full public-table JSON
snapshots compare before/after reads with an active Free Exploration execution
and a Guided Scenario/ledger. During reads a query guard permits only the existing
Session authentication/revalidation SELECTs; the Fake registry is unchanged.
Deterministic revalidation barriers prove four simultaneous catalog admissions,
fifth-request 429, busy Reset 409, another Session's independence, Exclusive FIFO
waiting, queued revocation revalidation, and known/unknown Reset blocking.
Teardown closes all backend connections, requires zero DB backends and normal
DROP without FORCE. Existing migrations are applied unchanged.

Executed commands/results will be recorded after final verification below.
