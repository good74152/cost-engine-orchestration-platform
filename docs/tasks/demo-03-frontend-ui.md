# Demo-03 — Interactive Frontend Dashboard

## Goal and accepted baseline

Provide a professional, responsive interactive frontend for the unchanged Demo
orchestration backend. Users can run Happy Path, Failure Retry, Lost Response
Recovery and Free Exploration without Postman. This interface does not perform
financial calculations or implement a second backend state machine.

Branch feature/demo-03-frontend-ui starts from freshly fetched main
0c80b44348ef65ae73c21e73d8c23060b3247273, the confirmed merge of PR #30.
Demo-02A–02E and the prior manual-fake admission fix are present. Authority:
System Owner's Demo-03 specification, AGENTS.md, Architecture, Reference,
Roadmap and the accepted Demo task/ADR contracts. No backend contract changes,
new Scenario, migration, calculation logic or deployment are part of this task.

## Frontend architecture

frontend/ is an isolated React / TypeScript / Vite application, with React Router,
Tailwind CSS, Vitest and React Testing Library. Versions are pinned in its own
package-lock.json, compatible with the existing Node 24 environment. No SSR,
Redux, WebSocket, new service or UI component framework. Playwright is a test-only
dependency for actual Chromium/Backend smoke verification and real screenshots.

| Area | Responsibility |
|---|---|
| src/api | Public DTOs and one same-origin fetch client; expected error mapping |
| src/app | Thin UI coordination/store, session-scoped read cache, route layout |
| src/components | Shared badges, timeline support, resource cards, dialogs and empty/loading/error states |
| src/features/sessions | Explicit start and restored session presentation |
| src/features/scenarios | Fixed teaching labels and saved step request mapping |
| src/features/datasets | Owned dataset/job detail and complete attempt history |
| src/features/exploration | Explicit existing manual commands and form controls |
| src/test | Mock API fixture only, never imported by the production bundle |
| scripts/browser-smoke.ts | Real Chromium, Vite proxy, unchanged backend and an owned disposable PostgreSQL database |

The dark sidebar, light content panels and readable status text adapt to desktop,
tablet and mobile. Status is always written as text as well as color. Reduced
motion is respected; native confirmation dialogs support keyboard dismissal.
Dashboard counts are derived from all owned PostgreSQL read pages, not invented
financial values. There is no fake financial chart or live external monitoring.

Primary tooling references: [Vite](https://vite.dev/guide/),
[Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite),
[React Router declarative routing](https://reactrouter.com/start/declarative/installation),
[Vitest](https://vitest.dev/guide/). Installed release metadata and engine ranges
were also checked directly against npm before installation.

## Routes and API integration

| UI route | Content |
|---|---|
| / | Overview, real resource counts, three Scenario cards and current session |
| /guided | Scenario selection, existing-scenario continuation and Reset guidance |
| /guided/:id | Timeline, current explicit action, last acknowledgement, latest durable resources |
| /exploration | Dataset form, dispatch behavior, Run/Retry, fake state, Reconcile and dataset lifecycle commands |
| /datasets | Owned dataset list, all backend cursor pages, local display continuation |
| /datasets/:id | Owned dataset/job detail DTOs and preserved attempt history |
| /about | Engineering model and explicit Demo limits |

The client uses same-origin relative /demo URLs, credentials: include, and no-store.
Every POST uses Content-Type: application/json and X-Demo-Session: 1. It parses
JSON, accepts 202 as pending and handles empty 204. Flat API codes are preserved;
friendly messages distinguish conflicts, unavailable truth, queue limits and
network errors. Unknown error text/SQL is not rendered as the UI contract.
No mutation automatically retries, and all mutation buttons disable in flight.

Public DTO shapes were read from demo-session.service.ts, demo-scenario.repository.ts,
demo-step.repository.ts and demo-read.repository.ts. No token, hash, DAG/run command
or private intent is presented. Read APIs provide no live FakeExecutor state;
the UI labels fake results as past acknowledgements and refreshes PostgreSQL.
No backend API gap blocks this slice, and no backend source or migration changes.

## Session handling and Reset

Initial load GETs Current Session. It never creates one automatically. A user
explicitly starts a session; a valid existing cookie is reused by the backend.
Authentication stays exclusively in browser-managed HttpOnly cookies. The UI
does not read/store token values, create session IDs or use Authorization headers.

401 DEMO_SESSION_UNAVAILABLE clears session/resource/request UI state and shows
"Your demo session has expired. Start a new session to continue."
Fixed expiry is displayed from the backend DTO; no sliding TTL is invented.

Reset requires a confirmation dialog. Only a confirmed 204 clears session,
Scenario request mappings and cached domain data, and returns to the start view.
Failure/unknown outcome retains the current session/cache/mappings and shows the
appropriate error; it never claims reset success or silently starts a new user.
Existing backend ownership, coordinator, busy-reset and unknown-reset rules remain.

## Guided execution, request identity and recovery

Scenario Create accepts the three existing exact types. A session owns only one;
different-type selection requires Reset, with no silent switch or automatic reset.
The six/nine-step catalog contains presentation copy only. Server completedStep,
Scenario status and pending-step response determine the action. Domain statuses
always come from read APIs. An old COMPLETED replay cannot overwrite newer GET
Scenario progress.

Before the first Step POST, save exactly sessionId, scenarioId, stepNumber and
crypto.randomUUID() requestId under fcp.step.v1:<session>:<scenario>:<step>.
These are non-sensitive workflow identifiers, never credentials. Storage access
failure prevents dispatch of an unpersisted request. Malformed or wrong-scope
stored mappings are ignored. A server pending request supersedes conflicting
local data; localStorage is not progress authority.

Restore sequence is Current Session, Current Scenario, Pending Step, then owned
resources. A reload never invents an ID to take over a pending step. Same-step
202, 503, network failure and explicit retry reuse the saved/server original ID.
409 refreshes durable progress and pending ownership rather than clearing the
mapping and creating a new request. No response automatically sends the next step.
The active page also retains its original non-sensitive request in memory if
browser storage is later cleared; storage must still succeed before sending.
Only the four allowed mapping fields are serialized, even if input has extras.
Confirmed GET progress after a lost browser HTTP response can expose the next
explicit action without guessing rollback or repeating the successful operation.

E Step 2 highlights DISPATCHING/PENDING and offers Recover original execution.
The same request recovers ACCEPTED/RUNNING; the success message describes the
acknowledged recovery, not executor completion. Failure Retry displays the same
Job ID, immutable FAILED Attempt 1 and distinct Attempt 2. Step 4 remains
IN_PROGRESS; a 202 on Retry Step 5 preserves that attempt and request identity.

## Resource explorer and Free Exploration

Read Dataset/Job/Attempt pages using every opaque nextCursor unchanged. Repeated
cursors fail closed rather than loop forever. Dashboard totals include all pages;
dataset presentation can reveal more locally. Detail screens also use owned
Dataset/Job detail contracts. Timestamps and unset lifecycle times are explicit.

Free Exploration creates only domain/fiscalYear/period, default CAPEX / 2026 / Q4.
No company selector. All six accepted machine domains are offered; the current
explicit Demo seed only configures CAPEX/DEMO_GUIDED_SUMMARY. Missing configuration
is a displayed expected backend error, not a frontend calculation.

Run/Retry/Reconcile use owned Job IDs. Fake success/failure uses owned Attempt IDs
and never client DAG/run identity. Queued dispatch behavior is explicitly a test
setting for the next new dispatch decision, not a change to an existing run.
Setting fake success alone leaves DB RUNNING/ACCEPTED until Reconcile. Validation,
Publish, Reject and Abandon remain separate backend-validated commands. UI gating
only disables obviously unavailable actions; it does not replace backend rules.

Guided sessions cannot use manual mutation controls. Prior manual data/configuration
can prevent Scenario Create; explain SESSION_NOT_EMPTY and provide Reset guidance.
Reads remain available in either mode. Nothing automatically resets or changes mode.

## Reproducible local development

Use a private local Demo database and existing Node 24+ / Docker Compose setup.
Do not overwrite an existing .env or publish credentials. From repository root:

```powershell
npm.cmd ci
npm.cmd --prefix frontend ci
docker compose up -d postgres_db
# Privately configure DATABASE_URL and matching local PostgreSQL credentials.
npm.cmd run migrate -- up
$env:APP_MODE='demo'
$env:NODE_ENV='development'
$env:EXECUTOR_TYPE='fake'
# Privately set DEMO_SEED_DATABASE_URL explicitly to the same migrated Demo DB.
npm.cmd run seed:demo-guided
npm.cmd run dev
```

In a second terminal at the repository root:

```powershell
npm.cmd run ui:dev
```

Open http://localhost:5173. Backend defaults to localhost:3000. The Vite /demo
proxy targets http://127.0.0.1:3000 by default, retaining the browser Host/Origin
(changeOrigin: false); optional DEMO_BACKEND_TARGET is server-side development
configuration, not a browser API base or a credential. Keep same-origin relative
requests. No CORS/security bypass or Cookie rewriting is needed. Development is
loopback-only; these settings are not safe public deployment instructions.

## Verification and screenshots

Required root commands: ui:typecheck, ui:test, ui:build, build, test:demo-02e,
test:demo-02d, test:demo-02c, test:milestone and git diff --check. Frontend scripts
delegate to frontend/. Test:milestone retains its existing isolated raw launcher.
The mock tests verify UI behavior; they are not substitutes for real PostgreSQL
or Browser/Backend evidence.

For a real isolated Browser smoke run, configure TEST_DATABASE_URL (fallback
DATABASE_URL) privately for a safe local service with CREATE DATABASE and owned
DDL/drop rights. Never target production. Then:

```powershell
npm.cmd --prefix frontend exec -- playwright install chromium
npm.cmd run ui:smoke
```

The smoke script creates/migrates its own template0 DB, asserts current_database
before fixture writes, explicitly seeds it, starts the unchanged Demo backend
and a real Vite proxy on loopback ephemeral ports, and drives real Chromium.
It verifies Cookie/Origin/headers, all scenarios, lost browser HTTP response,
pending reload, full execution identity, independent owner denial, fake/DB
separation, Reset, prior manual configuration refusal and 1440/834/390px layouts.
All actual clients close before zero-backend verification and normal owned DROP.
If browser setup/start fails, the command fails; no mocked smoke PASS fallback.

Normal smoke screenshots go to a temporary directory and leave tracked files
unchanged. To refresh the genuine README screenshots explicitly, set
UI_SMOKE_SCREENSHOTS=1 for that run, then remove the flag. Images in
docs/images/demo-03/ are real Chromium captures against the owned PostgreSQL
fixture, never generated mockups. They contain public disposable resource IDs,
no credentials. Screenshot capture locale is en-US, time zone Asia/Taipei.

## Known limitations and review boundary

Single local Demo backend, no external/core/config writer, in-process fake state,
old-session invalidation on backend restart and fixed four-hour lifetime remain.
Read pages are sequential snapshots, not one cross-endpoint transaction. The UI
loads every page for small Demo totals; this is not large-workload optimization.
Refresh and every operation are explicit; no background polling or execution.
No live external-state API, financial calculation, real Airflow, new Scenario,
new backend state machine, queue, distributed lock or infrastructure is added.
Built frontend assets are produced, but serving/deployment/security hardening
belongs to Demo-04 and is not implemented here. System Owner review is required;
do not automatically merge or start deployment work.

Executed source revisions, exact commands/counters, warnings, screenshots and
owned-database teardown evidence are recorded below after final verification.
