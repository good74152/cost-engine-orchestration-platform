# Demo-04 executed local verification

Date: 2026-10-27 (Asia/Taipei). Branch: feature/demo-04-secure-deployment.
The latest bounded review result is in "Final review fix" below. Earlier delivery
counts and public-health descriptions are retained as historical evidence.
Fetched base: c1c2a883cc9f63fea701286ba95b0c639c5e4603, merged Demo-03 PR #31,
including Demo-02A–02E. Implementation source committed as
0baa42d69679cdb76509ebfc08e580730ac2fe63, tree
7f99a933137e95e41c51eb435f71424f018e10d5. Later sections record the bounded CI
fixture and dependency-security follow-ups. The final command table was rerun
after those corrections on the final implementation working tree. Public launch
and System Owner acceptance are not claimed.

## Final commands and results

Commands were executed from the repository root in PowerShell using npm.cmd.
Build/typecheck/whitespace commands have no test-count semantics (shown as —).
Node test totals include parent entries; each final suite is counted once.

| Command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | — | — | — |
| npm.cmd run ui:typecheck | 0 | — | — | — |
| npm.cmd run ui:test | 0 | 40 | 0 | 0 |
| npm.cmd run ui:build | 0 | — | — | — |
| npm.cmd run test:demo-04:typecheck | 0 | — | — | — |
| npm.cmd run test:demo-04 | 0 | 17 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| npm.cmd run test:demo-04-containers | 0 | 11 | 0 | 0 |
| npm.cmd run ui:smoke | 0 | 10 | 0 | 0 |
| npm.cmd audit --omit=dev --audit-level=high | 0 | — | — | — |
| npm.cmd audit --audit-level=high | 0 | — | — | — |
| npm.cmd --prefix frontend audit --audit-level=high | 0 | — | — | — |
| git diff --check | 0 | — | — | — |
| git diff --cached --check | 0 | — | — | — |

Total: 524 passing entries, zero failures/skips/cancellations/TODOs in final test
runs. Final captured test logs contain no deprecation/npm warnings. Git emitted
local LF-to-CRLF staging notices for source/docs; deployment files are explicitly
LF through .gitattributes. This is local execution, not GitHub CI success.

The milestone ran its own build and these commands sequentially, all exit 0 and
zero fail/skip/cancel/TODO:

| Internal command (npm run) | Pass |
|---|---:|
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
| test:raw-ingestion (runner-owned isolated DB launcher) | 1 |
| test:task-007d-end-to-end | 7 |

CON-01/CON-02 are green in the integrated concurrency suite. No standalone raw
test was pointed at a persistent developer database.

## Deployment acceptance coverage

| Requirement | Executed evidence |
|---|---|
| Environment, production Core fake prohibition | Environment matrix; unchanged Core factory rejection; actual container startup failures |
| Explicit production profile | Migrated/seeded container starts and becomes ready |
| Host cookie, Origin/CSRF, no-store | PostgreSQL route tests, Node CA-validated HTTPS and Chromium |
| Rate/body/capacity limits | Real POST rejection writes; per-address/global limits; 20 concurrent creates allow exactly three at configured capacity; registry third allocation rejects at two |
| Ownership and sanitized failures | Foreign reads generic 404; proxy/CSRF/body/rate/capacity contracts; existing ownership/reset/step regressions |
| Periodic maintenance | Real inactive graph/fake cleanup retains active owner/session history; bounded/non-overlapping timer and failure/shutdown tests |
| Restart invalidation | Service/real-server regressions and actual container restart returns 401 to old cookie |
| Route exposure | Core/raw/callback/internal/admin/seed/debug absent in backend and Caddy |
| Health/readiness | False until initialization; DB failure returns 503; actual Docker health gate and version |
| Compose/secrets/single backend | Real config parsing, no DB/Node port publication, private networks, failed missing env/secret/origin, rejected scaling and overlapping project |
| Static assets / SPA / CSP | Actual Caddy responses, immutable assets/no-cache HTML, route refresh, production Chromium Happy Path and Reset |
| Persistence | Force-recreate PostgreSQL container preserves rows in named PG18 volume |
| Backup/restore | Binary pg_dump -Fc restored with pg_restore --exit-on-error into a separate owned DB; migration/config/graph/session counts match |
| Guided regressions | All three flows over actual local HTTPS; Lost Response Step 2 returns 202 then 200; original E/D/C suites and full browser smoke |
| Core regression | Entire unchanged 246-entry milestone |

The container suite executes real Docker builds for backend/operator/web, real
Compose config validation, shell syntax checks, explicit migrations and repeated
seed, startup/health, browser/API traffic, DB recreation, backup/restore, restart
and teardown. It supplies generated project/env/override paths, never deployment
credentials. The final project was demo04_test_d0571ab2d96f; its secondary collision
project was demo04_test_d0571ab2d96f_other. Both owned projects have zero remaining
volumes after teardown. A separate host PostgreSQL audit found zero demo04_test_*
databases/roles. The original developer test_postgres container remains intact.

Host runtime: Node v24.18.0; PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2);
Chromium 156.0.8078.4; Docker Engine 29.8.0 / Compose v5.5.1. Production images
were also queried directly: Node v24.22.1 and Caddy v2.11.7.

HTTPS used Caddy's isolated internal CA on a loopback-only published test port.
Node HTTPS requests explicitly validated that CA. Chromium used a disposable
ignoreHTTPSErrors context for this local CA; this is not public certificate-chain
validation. No host-wide CA trust change or public DNS/ACME operation was made.

## Earlier failures and corrections

Earlier results are not included as final passes:

- First Demo-04 PG run: exit 1, 15 pass / 2 fail / 0 skip (one child plus parent).
  The test supplied an undefined Origin header rejected by the injection library.
  Remove absent headers. That run also exposed Fastify FSTDEP023; use its current
  LogController API. Corrected/final run: 17/0/0, exit 0.
- First container run: exit 1, 8 pass / 2 fail / 0 skip (browser child plus parent).
  Browser harness clicked before Session completion. Wait for POST/visible Session,
  use existing action/Reset labels. Corrected expanded final run: 11/0/0, exit 0.
- Initial regression gate stopped at Reset: exit 1, 20 pass / 2 fail / 0 skip.
  New sanitized startup logging omitted the existing fixed "invalidation failed"
  diagnostic. Restore that safe text within structured output; Reset is now
  22/0/0. E/D/C/milestone were not run by that stopped gate; later complete runs
  passed as separately recorded above.
- Supplemental script typecheck first rejected CLI file arguments without TS7's
  --ignoreConfig (exit 1); corrected invocation then exposed test payload/browser
  typing errors (exit 1). Explicit serialized payloads and Playwright types fix
  them. Added test:demo-04:typecheck now exits 0.
- Teardown audit found three empty secondary-project volumes from the rejected
  overlap tests. Validate their exact disposable-project labels, remove only those
  owned volumes, add secondary down --volumes and zero-volume assertions. Final
  container rerun passes with no owned volumes left. No live/developer volume was
  removed. An initial read-only audit command had a PowerShell quoting error;
  corrected literal-stdin audit exits 0 with zero test DBs/roles.

Final local logs are in the executing machine's temporary directory:
demo04-gate-ui-{typecheck,test,build}.log; demo04-gate-test-demo-session-
{infrastructure,ownership-executor-isolation}.log; demo04-gate2-test-demo-02[a-e].log;
demo04-final-pg.log; demo04-final-ui-smoke.log; demo04-verified-containers.log;
demo04-verified-test-demo-session-reset-recovery.log; and
demo04-verified-test-milestone.log. Earlier development/stopped-gate logs retain
their separate names. No credentials, raw DB dumps or logs are committed.

## Files and boundary review

Runtime: src/app.ts, src/server.ts; src/deployment/{public-demo-config,
public-demo-http,verify-database,demo-maintenance}.ts; demo-session/{demo-runtime,
demo-http-security,demo-session.service}.ts. Session admission alone adds a capacity
transaction; financial Domain/executor/snapshot/ledger/Reset SQL is unchanged.

Infrastructure: Dockerfile, .dockerignore, .gitattributes, .gitignore;
deploy/{compose.yaml,Caddyfile,caddy-entrypoint.sh,operator.ts,env.example,README.md};
deploy/scripts/{deploy,start,operate,backup}.sh; .github/workflows/verify.yaml.

Tests/scripts: scripts/demo-04-deployment.pg.test.ts,
scripts/demo-04-containers.test.ts, the two bounded teardown fixture fixes below,
package.json and package-lock.json. Documentation: README.md,
docs/{ARCHITECTURE,REFERENCE,ROADMAP,DEPLOYMENT}.md, ADR index/0013, bounded Task
Demo-04 and this evidence file. Complete staged diff was inspected; no migration,
frontend source, Core executor contract/state machine or historical data changed.

## Not executed / operating limits

Public VPS provisioning, DNS, firewall validation on that VPS, public ACME issuance,
public browser/certificate-chain E2E, production migration/seed, off-host backup
transfer, live disaster restore and actual public launch were NOT EXECUTED.
They are manual System Owner checklist items, not skipped test-suite passes.
GitHub Actions is configured but its remote result is not substituted for local
evidence. No automatic deployment or merge.

One VPS/backend and no concurrent Core/external/config writer remain mandatory.
Fixed container identity is not arbitrary external-writer protection. Fake state
is process-local; restart revokes credentials. Retained history has a hard ceiling
and needs monitored, reviewed archival policy before exhaustion. No automatic
history deletion or unsafe schema down. No accepted Core architecture conflict
was found; ADR-0013 explicitly bounds the authorized deployment extension.

## First remote CI run and bounded fixture correction

After creating PR #32, [run 40471315409](https://github.com/good74152/cost-engine-orchestration-platform/actions/runs/40471315409)
failed on head 7f3670eac2143ce63764260fd428e22d7f60dd80. Build/UI/typecheck and
Demo-04 tests passed. Milestone stopped at the integrated concurrency suite:
exit 1, 13 pass / 1 fail / 0 skip. All thirteen scenario children, including
CON-01/CON-02 and lock-order proofs, passed; the parent received an uncaught
"terminating connection due to administrator command" during forced DB teardown.
Later milestone suites and container/browser-install steps were NOT RUN.

The pre-existing fixture awaited pool.end(), then force-dropped the DB before all
client end events had finished. The minimal test-only correction follows existing
Task 007C/terminal-lifecycle fixtures: track each client end, await them after
pool.end(), assert zero PostgreSQL backends, then normally DROP only the owned DB.
No scenario assertion, scheduler barrier, production code or migration is changed.
The focused local concurrency rerun passes 14/0/0, exit 0.

The run also warned that checkout@v4/setup-node@v4 target deprecated Node 20, and
noted ubuntu-latest's moving image. The workflow now uses the official Node-24
checkout@v6/setup-node@v6 actions and explicit ubuntu-24.04. This does not mask the
test failure or skip a gate. A new CI run must confirm the complete workflow.

The PR-triggered [run 40471904018](https://github.com/good74152/cost-engine-orchestration-platform/actions/runs/40471904018)
on ff7e976c7561de3386ce9fb5f5652c2ed4848f9f then passed integrated concurrency
14/0/0 and all preceding milestone suites, but exposed the same forced-drop race
in the final Task 007D E2E fixture: exit 1, 6 pass / 1 fail / 0 skip. All six Flow
A–F children passed; its parent failed during teardown. Apply the same client-end
drain / zero-backend assertion / normal owned DROP to that fixture only. No Flow
A–F assertion or application behavior changes. This failed run is not a PASS;
container/browser-install steps were not run in that attempt.

## Successful remote CI and dependency-security follow-up

Both [PR run 40472226366](https://github.com/good74152/cost-engine-orchestration-platform/actions/runs/40472226366)
and [push run 40472219514](https://github.com/good74152/cost-engine-orchestration-platform/actions/runs/40472219514)
passed on ef616b3c4b4d4fac0023ab585f587336f624c178. Build, frontend typecheck/build,
script typecheck, UI 40, Demo-04 17, milestone 246 and container 11 all succeeded:
314 passing CI test entries, zero failures/skips/cancellations/TODOs. Both checks
had zero annotations. The full logs confirm normal zero-backend CON/E2E teardown.
The focused local E2E rerun also passed 7/0/0, exit 0, and the full local milestone
rerun passed 246/0/0, exit 0 (demo04-ci-fix-{e2e,milestone}.log).

Successful CI did not mean a clean dependency audit. Its npm ci output reported
three high-severity affected packages. Separate read-only audits initially exited
1: production had two affected packages; the full tree had three. The findings
were Fastify, fast-uri (two installed major lines) and dev-only brace-expansion.
Relevant official advisories include
[malformed-URL authentication bypass](https://github.com/advisories/GHSA-p68q-wchp-6fh7),
[async validation/body replacement](https://github.com/advisories/GHSA-667r-xxjv-c9mm)
and [URI host normalization](https://github.com/advisories/GHSA-wjr9-j795-jxcr).

Apply only same-major fixes: Fastify 5.11.3 → 5.12.7, fast-uri 3.1.5 → 3.1.9
and 4.1.2 → 4.2.3, brace-expansion 5.0.9 → 5.0.12. The command was
`npm.cmd update fastify fast-uri brace-expansion --ignore-scripts`; raise the
declared Fastify minimum and synchronize its lock metadata with
`npm.cmd install --package-lock-only --ignore-scripts`. Exactly four installed
packages changed; no unrelated dependency sweep or install-script approval.

All three final audits in the table exit 0 with zero vulnerabilities. The full
524-entry local gate, builds, browser and Docker tests were rerun with the patched
lockfile; final logs are demo04-secure-{build,ui-typecheck,ui-test,ui-build,
test-demo-04,typecheck,test-demo-session-*,test-demo-02[a-e],test-milestone,
ui-smoke,containers}.log (the script typecheck log is
demo04-secure-test-demo-04-typecheck.log). CI also gates the full root and frontend
audit at high severity. The final patch's remote results are available on
[PR #32 checks](https://github.com/good74152/cost-engine-orchestration-platform/pull/32/checks),
separate from the earlier successful runs above.

The CI npm 11.19.0 install output also warns that esbuild@0.28.2 has a postinstall
script not yet covered by allowScripts. It is not hidden or auto-approved; the
builds/tests succeed with the existing platform binary dependency. This warning
is separate from npm audit; the final audit checks exit 0 with zero findings.
The earlier Node-20 Action deprecation and moving-runner notice were removed by
the v6 actions / explicit Ubuntu runner configuration.

## Final review fix — budget accounting and internal health

Baseline: PR #32 at aebd56336610196dd2acc9449692336b2425ed45.
The old hook charged global quota before checking local limits. Repeated requests
from an already limited address could therefore exhaust other users' quota.

Check the creation limit and per-address mutation limit before the global limit.
Consume all applicable counters only after every check passes, without an await
between checking and charging. Capture one window timestamp for the whole
admission. Rejected local requests spend no global quota; concurrent requests
still obey the exact global cap. Admitted requests count even if a later route
returns an error. A private clock seam makes the HTTP window tests deterministic.

The existing Docker healthcheck directly probes loopback GET /health/ready, so
public DB health endpoints are unnecessary. Caddy now answers /health and /health/*
with 404/no-store without proxying. The public backend independently rejects
non-loopback health requests before PostgreSQL access; proxy/IP headers do not
grant loopback access. Core health routes and behavior are unchanged.

New HTTP tests cover local rejection fairness, creation/mutation budget isolation,
strict aggregate limits, concurrent per-IP/creation/global limits and window reset.
The PostgreSQL suite asserts zero DB calls for external health requests including
query strings/spoofed IP headers, internal not-ready 503, ready 200 and DB-down 503.
The container suite verifies public health 404 with the backend stopped and a
working internal probe after restart, alongside all existing HTTPS/Scenario tests.

Before the fix, the expanded Demo-04 suite exited 1: 17 pass, 6 fail, 0 skip
(five new children and their parent; this includes the new deterministic clock
seam). After the fix all required commands below exited 0:

| Command executed in PowerShell | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | — | — | — |
| npm.cmd run test:demo-04 | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-04-containers | 0 | 12 | 0 | 0 |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 246 | 0 | 0 |
| npm.cmd run ui:test | 0 | 40 | 0 | 0 |
| git diff --check | 0 | — | — | — |
| npm.cmd run test:demo-04:typecheck (supplemental) | 0 | — | — | — |

Total: 358 passing entries in the requested test suites, zero failures/skips/
cancellations/TODOs. Milestone includes green CON-01/CON-02, raw ingestion in its
owned disposable DB and Flow A–F. The existing milestone breakdown above still
applies. Captured local test logs contain no runtime/deprecation/npm warnings;
Git emits the existing LF-to-CRLF notices. No tests were skipped to obtain a pass.

Logs are demo04-review-before.log (deliberately red), demo04-review-after.log,
demo04-review-containers.log, demo04-review-test-demo-02e.log,
demo04-review-test-milestone.log and demo04-review-ui-test.log in the executing
machine's temporary directory. Container project demo04_test_5bbcad397e30 and its
secondary collision project were removed with zero owned volumes remaining.

Changed files for this review: public-demo-http.ts, deploy/Caddyfile, both Demo-04
test files, docs/DEPLOYMENT.md, ADR-0013, the Demo-04 task and this evidence file.
No Core orchestration, Session identity, Scenario semantics, migration or dependency
changes. No Redis, distributed limiter or new service. Local disposable container
verification is not a public deployment; no merge or production deployment.
