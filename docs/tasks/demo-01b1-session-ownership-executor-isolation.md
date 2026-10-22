# Demo-01B-1 — Session Ownership & FakeExecutor Isolation

Status: verification passed; awaiting System Owner Code Review. Not merged or
accepted as a completed implementation by this report.
Specification authority: System Owner's Demo-01B-1 request, 2026-10-23.

## Goal and baseline

Provide end-to-end ownership enforcement within an explicitly selected Demo
runtime, with one independent FakeExecutor per authenticated session. Task 007's
canonical identity, state machines, snapshots, executor contract, SQL transaction
boundaries and lock ordering remain unchanged. No Reset or restart recovery.

Started from latest fetched main `50e88c2` on
`feature/demo-01b1-session-ownership-executor-isolation`. Task 007 final acceptance
is recorded in docs/verification/task-007-final-acceptance.md; Demo-01A merge
`5ed9e40` (PR #15) is an ancestor. Baseline Demo-01A real PostgreSQL suite was
rerun: exit 0, 18 pass, zero failures/skips/cancellations/TODOs.

## Approved scope and API boundary

- `APP_MODE=demo` explicitly selects the isolated route surface. Unset mode
  defaults to existing `core`; only exact `core` and `demo` are accepted.
  Unknown, empty or conflicting configuration fails startup. Demo requires
  an explicit development/test environment; production cannot be overridden by
  injected test options. A global executor cannot be injected into demo mode.
- Demo mode exposes only health, existing session create/current APIs and the
  protected routes below. It does not register original Domain write routes,
  internal fake controls, callback or raw-ingestion routes. Core mode retains
  all existing behavior, including supported raw ingestion.
- Each protected POST authenticates before body processing, applies the same
  CSRF policy as session creation, then enters the shared per-session coordinator.
  Durable session revalidation, ownership validation and the Domain command
  execute within that operation. Different sessions are independent.
- Reuse Demo-01A cookie, lifetime, no-store, logging and revocation policies.
  Every POST requires `X-Demo-Session: 1`; supplied Origin must match configured
  or direct origin; cross-site Fetch Metadata is rejected. No credentialed CORS.
  Supply `{}` for commands without other fields. GET/current remains read-only.

| Route | Request | Success |
|---|---|---|
| POST /demo/dataset-versions | exactly domain, fiscalYear, period | existing creation DTO, 201 |
| POST /demo/dataset-versions/:id/submit-validation | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/publish | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/reject | {} | existing lifecycle DTO, 200 |
| POST /demo/dataset-versions/:id/abandon | {} | existing lifecycle DTO, 200 |
| POST /demo/calculation-jobs/:id/run | {} | existing Run DTO, 200/202 |
| POST /demo/calculation-jobs/:id/reconcile | {} | existing reconcile DTO, 200 |
| POST /demo/fake-executor/dispatch-behavior | {behavior} | {behavior}, 200 |
| POST /demo/execution-attempts/:id/fake-state | {state} | {executionAttemptId, state}, 200 |

Creation rejects any client companyCode, session ID, calculation type/version or
upstream selector. The validated session supplies companyCode to the unchanged
creation service. Foreign/missing/malformed resource identifiers uniformly
return 404 DEMO_RESOURCE_UNAVAILABLE; no session is 401 DEMO_SESSION_UNAVAILABLE.
Invalid input uses 400 INVALID_REQUEST; valid owned Domain commands retain their
existing readiness/state/dispatch errors. CSRF uses 403
DEMO_SESSION_CSRF_REJECTED and the inherited coordinator capacity uses 429
DEMO_SESSION_QUEUE_FULL. Internal/invariant failures stay sanitized 500 errors.

## Executor isolation

The registry is owned by one application runtime, keyed only by authenticated
session ID. A session reuses its instance for Run, Retry, Reconcile and controls.
Each new session receives a distinct FakeExecutor object; no executions, scripts,
history, unavailable state or ADR-0008 rejection tombstones cross instances.
Registry allocation is bounded to 1024 sessions by default; exhaustion returns
503 DEMO_EXECUTOR_CAPACITY_REACHED before preparing/dispatching a Run. Do not
evict instances on expiry: doing so could discard execution/rejection history.
No automatic cleanup or background infrastructure is added.

The behavior control appends one of ACCEPT, REJECT, ACCEPT_THEN_UNKNOWN or
UNKNOWN_WITHOUT_CREATION to the current session's script. The state control
accepts only SUCCEEDED or FAILED, validates attempt ownership, and reads the
full DAG/run identity from PostgreSQL. It never trusts a client execution ID,
updates DB job/attempt status, or reconciles automatically. Reconcile still
queries executor truth and atomically records the existing transitions.

Ownership links are immutable in supported application code. Validator reads do
not introduce orchestration locks; the coordinator holds no SQL transaction
while waiting or spanning executor calls. Existing services retain their locks
and transaction A/B/external-call/C boundaries. Expiry/revocation denies queued
operations at admission but does not cancel admitted work.

## Verification and delivery

Use fully migrated owned disposable PostgreSQL databases, Node test runner and
Fastify.inject. Cover two-session same-coordinate creation, foreign dataset/job/
attempt denial without DB/executor effects, companyCode rejection, independent
scripts/state/tombstones/history, all four dispatch behaviors, failure/retry and
reconcile, lifecycle wrappers, blocked anonymous bypass routes, CSRF/auth/expiry/
revocation, deterministic same/different-session barriers, queued expiry and
failure release, config/production rejection and unchanged core behavior.

Run build, Demo-01A suite, the dedicated Demo-01B-1 suite and unchanged milestone.
Record exact revision/tree, environment, exit codes, counters, warnings and
owned teardown. Commit/push/open PR to main; do not merge automatically.

## Limits

Isolation applies to this one explicitly configured Demo runtime. Do not expose
an anonymous core runtime against the same database. Shared calculation-type
configuration is platform-owned, not client-editable. The registry and queue
are process-local; persisted sessions do not imply fake execution restart
recovery. No Reset, data cleanup, cookie clearing, scenario/UI, real Airflow,
distributed coordination, general idempotency or cloud deployment. **This
milestone is still not safe for direct public deployment.**

## Executed verification — 2026-10-23 (Asia/Taipei)

### Source and environment

- Final runtime-tested source: `dd0b9400bd59ca587375aeabb20ea663762c143e`.
- Exact tested tree: `86ff8cc2a6b320187ebe776958851a4e90a61c5d`.
- Working tree was clean during the final commands below. The later report-only
  commit is not a separately runtime-tested source revision.
- Initial baseline was latest main `50e88c2160a0ea1cfd7e4a95f11567f6d2f00e32`.
  During work main gained only PR #18's Task 004 animation/README documentation.
  The unpublished feature commit was rebased cleanly onto
  `f39dddc0c9ee25b57b02e31db564a8239864ff00` before final verification. No PR was
  merged by the implementation agent. Existing drawings were preserved.
- Windows; Node.js v24.18.0; npm 11.16.0; PostgreSQL 18.6
  (Debian 18.6-1.pgdg13+2). Existing Compose postgres_db/test_postgres was running;
  `docker compose up -d postgres_db` succeeded. No new infrastructure/dependency.
- Private TEST_DATABASE_URL/DATABASE_URL supplies the test service connection,
  never a target for destructive developer-database tests. All suites use owned
  migrated disposable databases; new suite reports all seven applied migrations.
  Local role observed CREATEDB=true/SUPERUSER=true: safety relies on owned target
  names, not least-privilege sandboxing. Do not use a production service.

### Exact final commands and outcomes

| Command | Exit | Pass | Fail | Skip | Cancelled | TODO |
|---|---:|---:|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a | n/a | n/a |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 18 | 0 | 0 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 | 0 | 0 |
| git diff --check f39dddc0c9ee25b57b02e31db564a8239864ff00 | 0 | n/a | n/a | n/a | n/a | n/a |

Supplemental strict script check, exit 0, no diagnostics:

```powershell
npm.cmd exec -- tsc --ignoreConfig --noEmit --strict --skipLibCheck --esModuleInterop --module NodeNext --target ES2022 scripts/demo-session-ownership-executor-isolation.pg.test.ts
```

Milestone runner/scripts/assertions are unchanged. All thirteen child commands
exited 0, status PASS, signal/spawnError null, issues empty. Each test child's
fail/skip/cancelled/TODO count was zero:

| Child npm run command | Pass |
|---|---:|
| build | n/a (build policy) |
| test:milestone-runner | 20 |
| test:orchestration-schema-v2 | 30 |
| test:dataset-version-creation-v2 | 14 |
| test:first-run-immutable-build-snapshot | 19 |
| test:execution-attempt-dispatch-fake-executor | 11 |
| test:executor-reconciliation | 22 |
| test:dataset-version-terminal-lifecycle | 64 |
| test:cross-workflow-concurrency-investigation | 14 |
| test:task-007b1-late-dispatch-reconciliation | 32 |
| test:task-007c-api-contract | 12 |
| test:raw-ingestion (owned isolated launcher) | 1 |
| test:task-007d-end-to-end | 7 |

Node parent/nested entries count: new suite 18 subtests + parent = 19; Demo-01A
17 + parent = 18; E2E six flows + parent = 7. CON-01/CON-02 remain green. The new
suite is run separately, not silently added to or substituted for the milestone.

### Acceptance results

All eight acceptance criteria are satisfied within the specified single-instance
Demo runtime boundary:

1. Real HTTP requests from both sessions create DPR/2026/Q3 under distinct
   server-generated company codes; cross-session dataset/job/attempt commands
   return identical generic 404 responses to unknown IDs, without DB/executor
   mutation. Another session's published CAPEX cannot satisfy upstream readiness.
2. Creation rejects companyCode/company_code/sessionId/version/type/dependency
   selectors; only the authenticated context supplies companyCode.
3. B dispatches first after A scripts REJECT and B scripts ACCEPT, proving no
   shared script queue. Distinct instances/history/state, response-loss recovery,
   same-identity rejection tombstones and lookup outage isolation are verified.
4. Both authenticated and anonymous calls to original Domain, raw, callback and
   internal-control paths cannot reach handlers in demo mode. Unknown/empty/
   conflicting mode configuration and production fail closed, including actual
   server-entrypoint subprocess tests. Default core behavior remains available.
5. Wrappers reuse unchanged creation, First Run, Run/Retry, reconciliation and
   lifecycle services. Fake controls leave DB status/history untouched until
   reconciliation. Terminal history and frozen snapshot identity survive retry.
6. Missing/expired/revoked cookies, ID impersonation and every Demo route's CSRF
   denial have no unauthorized mutation. Explicit HTTP barriers prove same-session
   ordering, failure release, independent sessions, queued expiry/revocation,
   queue overflow and registry capacity rejection before preparation. During
   executor waits, separate real connections acquire dataset/job/attempt
   FOR UPDATE NOWAIT locks; idle-in-transaction count is zero.
7. The complete unchanged real-PostgreSQL milestone passes, including isolated
   raw ingestion and integrated E2E flows. Demo-01A remains green after shared
   security extraction; its original assertions were not changed.
8. No migration, state machine, executor contract, transaction/lock ordering,
   Domain service or new infrastructure change. No Reset or recovery/cleanup
   implementation. Security policies are centralized, not copied per route.

### Data safety and teardown

Final new-suite database: `demo_01b1_test_36900_04ce4d830f95`;
Demo-01A: `demo_01a_test_10664_e1cee135b78d`. Both migrated owned template0
databases, awaited real client end events, checked zero remaining connections
and performed normal DROP (forced=false). New fixtures never use sleeps for
concurrency ordering or mocked repositories.

Final milestone also reported successful teardown:

- Terminal lifecycle: dataset_lifecycle_test_34896_6ad9a89a5efd,
  ten closed clients, sessions=[], normal DROP.
- API contracts: task_007c_test_4800_3ce426d458d4, sessions=[], normal DROP.
- Isolated raw: raw_milestone_test_5644_0c4f3020f026 dropped by its existing launcher.
- E2E: task_007d_e2e_13840_1350a9fd5246 dropped.

Read-only pre/post inventory matched exactly: postgres, template0, template1,
testdb. No disposable databases or matching fixture sessions remained. No
persistent developer schema/history/data was migrated, truncated or dropped.

Protected-path check (exit 0; empty diff):

```powershell
git diff --exit-code f39dddc0c9ee25b57b02e31db564a8239864ff00 -- migrations src/db src/executors src/modules/dataset-version src/modules/calculation-job* src/modules/raw-ingestion scripts ':!scripts/demo-session-ownership-executor-isolation.pg.test.ts' package-lock.json 'docs/adr/000[1-8]*'
```

The complete diff was reviewed. Only app/server registration, new Demo modules,
shared Demo-01A HTTP security extraction, one ownership comment, dedicated tests,
test script/config example and the bounded documentation/ADR are changed.

### Earlier execution, warnings and limitations

- Baseline Demo-01A passed 18/0/0/0/0 before implementation.
- The initial new-suite subset passed 17 entries. Expanded coverage then exposed
  a test-only SQL typo: d.dataset_build_snapshot_id instead of the existing
  d.snapshot_id. That execution exited 1 (17 pass / 2 fail, including the parent;
  zero skips/cancellations/TODOs). Teardown succeeded. Only the test lookup was
  corrected; no schema/application workaround or assertion weakening.
- Expanded reruns and the final clean rebased source pass 19/0/0/0/0.
- Git emitted informational LF-to-CRLF guidance; whitespace checks pass. The
  remote's old repository alias may emit a moved-repository notice on push.
  No unexpected final compiler/runtime warning, spawn error or teardown failure.
- Coverage is Windows/Node 24/PostgreSQL 18.6 and Fastify.inject, not deployed TLS
  or a browser/cloud environment. Fake state/scripts/history remain in memory;
  registry capacity is finite and there is no automatic eviction or restart
  recovery. No per-session data cleanup, Reset, public-deployment hardening or
  multi-instance guarantee is claimed. Core mode is intentionally unauthenticated
  and must not be exposed against demo data to untrusted callers.
- No conflict with accepted architecture was discovered. System Owner review
  and any merge remain separate manual decisions.
