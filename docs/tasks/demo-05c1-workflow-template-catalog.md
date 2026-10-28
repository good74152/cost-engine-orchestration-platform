# Demo-05C-1 — Workflow Template Catalog + Read-only API

- Date: 2026-10-28 (Asia/Taipei).
- Authority: System Owner's bounded Demo-05C-1 request.
- Baseline: main `ed3f29a`; Demo-05B-2 merged as PR #37.
- Branch: `codex/demo-05c1-workflow-template-catalog`, independent worktree.
- Source tested: implementation commit `be2f99a9221ce3c7b7341d5575a773ca1986bd45`;
  subsequent changes record verification only.
- Status: implemented; local verification passed; awaiting System Owner Review. No merge.

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

Executed on Windows with Node v24.18.0 and real PostgreSQL 18.6, against a newly
created local-only Docker test service. Every final command below exited 0.

| Command (`npm.cmd run ...`) | Passing tests |
|---|---:|
| test:demo-05c1 | 18 (8 unit + 10 HTTP, including parent) |
| test:milestone | 259, including CON-01/CON-02 and isolated raw ingestion |
| test:demo-05b2 | 29 |
| test:demo-05b1 | 12 |
| test:demo-05a | 23 |
| test:demo-session-infrastructure | 21 |
| test:demo-session-reset-recovery | 22 |
| test:demo-session-ownership-executor-isolation | 19 |
| test:demo-02a | 23 |
| test:demo-02b | 26 |
| test:demo-02c | 27 |
| test:demo-02d | 25 |
| test:demo-02e | 37 |
| test:demo-04 | 23 |
| test:demo-04-containers | 13 (actual Docker/locally trusted HTTPS/production UI) |
| ui:test | 41 |
| ui:smoke | 10 (actual Chromium and PostgreSQL) |

Total: **628 passed, 0 failed/skipped/cancelled/TODO**, counting each suite once.
The standalone new unit run (8) and additional naming run (13, already included
in milestone) also passed and are not added again. Build, ui:typecheck, ui:build,
test:demo-05c1:typecheck, test:demo-05b2:typecheck, test:demo-05b1:typecheck,
test:demo-05a:typecheck and test:demo-04:typecheck passed. Root and frontend
`npm audit --audit-level=high` both reported zero vulnerabilities. `git diff --check`
and the staged diff check passed. A protected-path diff audit confirmed no changes
to Core services, FakeExecutor, Session/Scenario, migrations or Frontend source.

New HTTP evidence: `demo_05c1_test_2704_e7c13d75a043`, all 12 unchanged migrations,
full-state equality, Parallel limit 4, zero backend connections before normal
DROP, no FORCE. Chromium fixture `demo03_browser_15328_b35d78454f4f` also recorded
zero connections and normal DROP. The disposable Compose project
`demo04_test_2fbc3af2d2e0` verified TLS, startup/restart, all Guided flows,
publication/Reset, volume recreation and backup/restore, then confirmed all its
volumes removed. The source test service contained only the maintenance database
after all suites; its container/anonymous volume and temporary private URL file
were removed. No persistent developer database was used or cleaned.

These are local executed results. Remote GitHub CI is separate and must be read
from the PR checks; this record does not claim its result. No known implementation
blocker remains. PREVIEW and deferred Workflow UI/progress/execution work are
intentional scope boundaries. Await System Owner Review; do not merge or deploy.
