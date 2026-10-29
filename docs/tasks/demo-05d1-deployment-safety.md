# Demo-05D-1 — Safe Deployment Controls and Manual Web Activation

Authority: System Owner's bounded specification. PR #42 was confirmed merged;
baseline main `10baca84e3163daa681ba9d171243bcafaab2129`.
Branch `codex/demo-05d1-deployment-safety`. Await System Owner Review. No production
VPS, database, migration, seed, drain, cutover or public launch is operated here.
Only owned disposable fixtures exercise those explicit commands.

## Control boundary and prerequisites

Retain ADR-0013/0017/0018's single-instance/offline model. PostgreSQL and Backend
remain private; Caddy is the only expected public entry. DB retains unless-stopped;
Backend/Web use restart: no. Web is in the public-web profile. Default Compose
selects DB/Backend only. Daemon restart cannot resume a public entry or stateful
writer without explicit reviewed start/open. No rolling deployment, automatic
migration/down, seed/drain/cutover or persistent-volume deletion is introduced.

Keep the production host-wide cost-engine-demo-backend identity. Never override it
or run another project/Core/one-off writer against this DB. Exactly one Owner
deployment operation at a time remains an operational prerequisite, not a
distributed lock. These controls cannot fence arbitrary Docker administrators,
external writers, CDN or other proxies. No new infrastructure/architecture decision
or application state machine is needed beyond the bounded Owner specification.

Require absolute readable DEMO_DEPLOY_ENV; default Compose is this checkout's
deploy/compose.yaml. Reviewed alternatives use absolute DEMO_COMPOSE_FILE and
optional DEMO_COMPOSE_OVERRIDE (also used by the independent fixture). Effective
JSON is checked for image/version/profile, configured unique identity, public Demo
settings, private ports/networks, Backend security and the same mounted DB secret
for Backend/operator. Env files are never sourced as shell. No credential/config
dump is printed. Protect Docker/host access and reviewed immutable image tags;
this is not an artifact-signature/attestation system.
Keep configuration/secret files immutable while Backend is running; repointing a
target requires a reviewed offline deployment, not editing a live mounted secret.

Structured observations use JSON.parse, never status grep. Existing host Node
can parse JSON; without it, the same Node 24 image runs an unprivileged read-only
network-none parser with one source file mounted. No host Node installation or
Docker socket mount is required. Git Bash/native Docker paths support Windows tests.

## Separate operations

- deploy.sh closes Web first, builds images, explicitly disables old Backend
  restart and stops it, checks offline state, then starts only PostgreSQL.
- start.sh closes Web, starts/checks DB, then starts the unique Backend only when
  stopped. Ready verification checks Docker health, configured Image Tag, container
  DEPLOYMENT_VERSION and live loopback readiness/version. A ready same-version
  process is preserved on repeated Start. Wrong/unhealthy/foreign/multiple Backend
  identities fail; there is no replacement, second instance, Web or operator mutation.
- open-web.sh first closes existing project Web and requires the exact
  --confirm-owner-acceptance-05d2-05d3 flag plus explicit --database-url-file
  /run/secrets/database_url. Check DB, unique healthy Backend and expected version,
  then call the existing Cutover Status Operator. Only complete JSON
  {state,updatedAt,configuration}, valid timestamp, WORKFLOW_OPEN and WORKFLOW
  permits Web startup. Exit zero, matching words, partial/noisy data or UNKNOWN
  markers do not authorize it. The existing Operator validates actual complete
  Workflow configuration; no financial/dependency validator is duplicated.
- close-web.sh disables automatic restart, stops project Web containers and
  confirms they are stopped. It is idempotent. Backend/DB/data/Session/Gate/
  configuration/volumes are retained. External ingress is outside its control.

The approval flag means System Owner has explicitly authorized potential public
traffic and completed necessary Demo-05D-2 / 05D-3 acceptance: reviewed artifacts/
configuration/security, host/DNS/firewall/private secrets, restore-tested backup,
offline/quiescence/cutover evidence, readiness/version and immediate closure plan.
This task does not perform or claim those future production acceptance activities.
Caddy may accept public traffic immediately. Verify public HTTPS/ACME/flows only
after authorized opening; on any failure run close-web.sh immediately.

## Operator safety and failure handling

operate.sh supports migrate-up, seed, seed-six-domain, admission-status,
admission-drain, cutover-status and cutover through unchanged deploy/operator.ts.
Every modifying operation requires Backend AND Web stopped with restart disabled.
Status is read-only and may run online. --no-deps prevents implicit service starts.
No automatic retry, next command, down/reverse/wipe or Cutover pipeline exists.

Admission/Cutover require an explicit --database-url-file /run/secrets/database_url
argument. No DATABASE_URL fallback or other DB inference exists. The accepted
mounted target is shared with Backend, preventing another database's Workflow
status from authorizing this Web. Existing CLI locks/transactions/Unknown COMMIT
recovery are unchanged. Nonzero failure does not imply rollback or success. Keep
Web closed, independently confirm durable state and follow ADR-0018 before any
explicit retry. Unresolved Cutover outcomes cannot open Web; a later fully verified
durable status can resolve uncertainty for a new explicit Owner-approved opening.

Backend readiness/version failure, LEGACY_OPEN, DRAINING, configuration conflict,
unavailable DB and invalid/unknown status all refuse Web. Failed Web startup is
followed by closure verification; no database/configuration rebuild or rollback.
If Docker cannot confirm a stop or target configuration cannot be resolved,
report closure unconfirmed and use the Owner's reviewed external ingress plan;
do not claim every public entrypoint is closed.

First installation retains ADR-0017 restrictions: never restart an old live
Backend merely to install Gate/controls. Suspend new admission at a replay-aware
entry, retain cookie validation/old work, prove quiescence, then update offline.
Backend restart still invalidates Sessions because Fake state is process-local.
SQL counts do not prove process/writer quiescence. WORKFLOW_OPEN remains irreversible;
no old binary, Legacy seed, auto-down or volume deletion is a rollback. Keep ingress
closed and use a reviewed compatible forward fix or restore.

## Verification

The independent suite executes actual scripts against a random demo05d1_test_*
Compose project, private test-only secrets, loopback HTTPS/internal CA and
disposable PostgreSQL 18. It covers startup/replay/failures, all operators, explicit
approval/target, closed Gate states, configuration/version checks, manual opening,
offline requirements, retained real Session/Dataset data and second-writer denial.
Malformed/incomplete/noisy/UNKNOWN status is rejected and parser fallback is tested.

A separate privileged **test-only** docker:28-dind container and its own disposable
volume test a real independent daemon restart using tiny inert containers for
restart-policy observations. Database resumes; Backend/Web/unapproved Web remain
off. No host socket, published daemon port, host-engine restart or production data
is involved. Real PostgreSQL/Backend behavior is verified by the main fixture and
Demo-04 regression. Cleanup uses only validated owned projects/volumes/temp paths.

Executed locally on 2026-10-30 (Node 24, PostgreSQL 18, Docker Linux containers):

| Verification | Result |
| --- | --- |
| Backend / Frontend production builds | PASS |
| Frontend, Demo-04, Demo-05D-1 and Demo-05C-3C strict typechecks | PASS |
| Deployment safety integration | 19 PASS |
| Demo-04 containers / production images / security | 15 PASS |
| Demo-05C-3A Cutover regression | 29 PASS |
| Demo-05C-3B six-domain regression | 12 PASS |
| Legacy Chromium / Workflow Chromium recovery | 10 / 8 PASS |
| Isolated Core Milestone (all 13 suites) | 259 PASS |
| Shell / JSON helper syntax, effective configuration rejection, diff checks | PASS |

352 integration/regression tests passed. Existing Legacy browser setup needed an
explicit completed-restore/navigation barrier: Session identity renders before the
asynchronous final navigation. The helper now waits for durable-state readiness
before clicking another route; no UI, assertions, recovery or timeout was removed.
Demo-04 teardown explicitly selects both inactive profiles so owned Caddy volumes
are cleaned. Production source, financial rules and existing Operators are unchanged.

Actual disposable run `demo05d1_test_494ea3fc1323` reported:

```json
{"health":"healthy","version":"demo05d1_test_494ea3fc1323","webRunning":false,"sameStartedAt":true}
{"ownerFlag":true,"state":"WORKFLOW_OPEN","configuration":"WORKFLOW","webRunning":true}
{"isolated":true,"databaseResumes":true,"backendRunning":false,"webRunning":false,"unapprovedWebRunning":false,"hostDaemonRestarted":false}
```

The ready Backend identity was
`b227575092dddd9c74d05885546f72e1718db6b553de8fe61d7f44c33fb471ea`.
Its process start time stayed unchanged across repeated Start. The approved HTTPS
fixture created a real Session and FAB_COST draft; repeated Close retained those
rows, Gate state and running DB identity. All modifying operators refused a live
Backend and also refused a live Web with Backend stopped. Disposable fixture
databases, projects, secrets and volumes were removed after testing.

GitHub verification includes the new strict typecheck and actual Docker safety
suite alongside every existing check; final run links are recorded in the PR.
All twelve acceptance criteria are implemented and locally verified. Production
deployment/cutover and Demo-05D-2/05D-3 Owner acceptance remain unperformed.
