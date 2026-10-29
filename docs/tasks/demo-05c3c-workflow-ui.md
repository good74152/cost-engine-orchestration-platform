# Demo-05C-3C — Workflow UI, Legacy entry retirement and Browser Recovery

Authority: System Owner's bounded specification. PR #41 was confirmed merged
before implementation. Baseline main: `4c0db75c4d10f3bccd7bc1c29b6ac04b72274af0`.
Branch: `codex/demo-05c3c-workflow-ui`. Await System Owner Review; no merge,
deployment or production configuration cutover is performed.
Existing ADR-0017/0018 and Core lock/recovery decisions apply. No new
architecture decision, state machine or persistence is introduced.

## Backend availability projection

Authenticated Demo-only GET `/demo/workflow-templates` retains `templates` and
adds `admissionState` from PostgreSQL's singleton. LEGACY_OPEN/DRAINING project
PREVIEW; WORKFLOW_OPEN projects AVAILABLE. Detail GET applies the same projection
to its existing availability field. Static v2 definitions remain frozen PREVIEW
objects and are not edited. Each response uses one committed Gate observation;
separate list/detail reads can observe different times. The UI rejects a mismatched
projection and asks for a refresh instead of guessing activation.

Reads retain Same-Origin, no-store, Cookie authentication and Parallel admission
with Reset barriers. Unknown IDs/query/security contracts remain. A missing,
invalid or unreadable Gate returns sanitized 503 DEMO_ADMISSION_UNAVAILABLE;
no PostgreSQL error reaches JSON. The GET reads only Session and Gate, does not
lock/write Gate, allocate FakeExecutor, inspect configuration or mutate resources.
This projection is not authorization for a configuration cutover. The existing
mutation transactions and owner checks remain authoritative.

## Frontend data flow and modes

DemoProvider owns the UI Controller. The App route effect restores Session,
availability, selected Template and every Dataset/Job/Attempt page on initial
load. Returning to Workflow or Free Exploration refreshes those observations.
Explicit operations also refresh via GET; no effect sends POST. Generation/epoch
guards discard stale reads; 401 clears resource/template/request caches. Successful
Reset clears Controller state and navigates away from old selection URLs.

- No Session: neutral explicit Start; no Template request or inferred mode.
- LEGACY_OPEN: existing Guided UI and Free Exploration remain.
- DRAINING: no new Scenario Create UI/controller call; existing Guided runner
  and explicit Next remain available. No Workflow operation entry is enabled.
- WORKFLOW_OPEN: Workflow Explorer replaces the Guided navigation/creation entry;
  both old `/guided` routes safely redirect to `/workflows` without Create POST.
  Free Exploration remains available against the same Session-owned graph.
- Availability/read failure: mode actions fail closed, resources are not considered
  ready for mutation, and a readable error plus explicit Refresh remains available.

`/workflows` displays Backend summaries; `/workflows/:id` reads the detail. Four
v2 Templates supply all titles, Step IDs, Operations, Domains, prerequisites and
expected results. The browser contains no duplicate Step Catalog and never parses
description text to dispatch an API. Operation renderers support only existing
Create/Run/fake-state/Reconcile/Validate/Publish. Users choose the active timeline
Step and individually operate its Jobs. No batch Run, automatic step advance or
new workflow endpoint exists. Legacy Guided source/ledger/recovery stays intact.

## Dataset binding and durable observations

Fiscal year/period and `dataset.<Domain>` UUID selections are URL navigation
hints scoped by non-secret Session UUID. Candidate versions must be present in
the freshly read current Session's Dataset list and match the chosen Domain/year/
period. No candidate (even the only one or newest one) is selected automatically.
Multiple versions require a choice; stale/foreign hints display unavailable and
provide no operation resource. Create is explicit and users then select its
returned version from the reloaded list. No Dataset/Job/Attempt identity is invented
by the UI. Job and Attempt IDs always come from Backend, across every cursor page.
No Cookie, token, Fake internal state or business success is stored in navigation
or browser storage. Existing Legacy request-ID persistence remains unchanged.

Timeline evidence is a pure function of selected Dataset status, required Job
statuses and Attempt history. It presents observations instead of permanently
completed steps: fake state cannot be confirmed from PostgreSQL; DISPATCHING is
unknown; FAILED permits explicit Retry; SUCCEEDED Jobs do not imply publication;
only PUBLISHED displays published. Validation is suggested after all required
Jobs succeed, with Backend final checks. Multiple pages are explicitly described
as separate observations, not one atomic snapshot. No Workflow progress ledger,
history table, mode lock or second state machine exists.

Each required CAPEX/DPR/ONE_STD_COST/E2E_COST Job is independently rendered and
operable. Current and historical Attempt cards remain visible. Failure simulation
is an explicit completion/fake-state choice; Retry posts only the selected Job.
Lost response is an explicit ACCEPT_THEN_UNKNOWN choice. HTTP 202 uses an amber
Unknown message; Recover explicitly calls Run for the original Job and lets
Backend retain its Attempt/DAG/run identity. Network errors remain Outcome Unknown;
the Controller reads durable state, never retries POST. The header's Refresh and
explicit recovery controls let the user choose the next action. A reload uses GET
only and reconstructs visible state from verified resources, never a click log.

## Offline deployment boundary

This UI does not perform cutover. Follow ADR-0018 and the 3A runbook: confirm drain,
stop Backend/ingress/requests/queued work and external writers, resolve retained
work and uncertain outcomes, and review tested backup/restore before using the
explicit target operator. SQL counts alone do not establish quiescence. Startup
still invalidates old sessions because Fake state is process-local. Browser
refresh recovery assumes the same running Backend; it is not restart durability.
Deploy compatible Backend and Frontend artifacts together; a missing/mismatched
availability contract disables modes. Keep traffic closed after failed cutover;
do not run old binaries/Legacy seeds, reverse WORKFLOW_OPEN or auto-down. No live
cutover, production launch or background execution is authorized by this task.

## Verification and evidence

Executed 2026-10-29 (Asia/Taipei), Node.js 24.18.0, PostgreSQL 18.6 and Chromium
156.0.8078.4. Browser Workflow tests own a random
`demo_05c3c_browser_*` database with all 14 migrations, real six-domain Seed,
Admission drain and Cutover Operators. Legacy Browser tests own their separate
Legacy fixture. Neither uses retained developer/production data. Owned databases
are dropped normally only after all sockets close and no backend remains.

| Verification | PASS count |
|---|---:|
| ui:test | 62 (41 retained + 21 Workflow cases) |
| ui:smoke (separate Legacy fixture) | 10 |
| ui:smoke:workflow | 8 (7 cases plus parent) |
| test:demo-05c1 (static unit + protected API/security/immutability) | 21 |
| test:demo-05c3a | 29 |
| test:demo-05c3b | 12 |
| test:demo-02b / 02c / 02d / 02e | 26 / 27 / 25 / 37 |
| test:demo-session-infrastructure | 21 |
| test:demo-session-reset-recovery | 22 |
| test:demo-session-ownership-executor-isolation | 19 |
| test:demo-05c2 (additional admission regression) | 22 |
| test:milestone | 259 |
| **Total (reruns counted once)** | **600** |

Also PASS: Build, Frontend Typecheck/production build, strict 05C-3C Browser
fixture typecheck, strict 05C-1/05C-3B typechecks and git diff checks. CI adds the
separate Legacy and Workflow Chromium suites plus Browser strict typecheck.
No failed/skipped/cancelled/TODO remains in the final runs. Raw ingestion runs
only through the milestone's isolated launcher. Core and legacy suites retain
their own independent owned databases.

Real Workflow Browser evidence:

- Six UI-published Datasets contain exactly ten SUCCEEDED Jobs/Attempts. Every
  Create, Run, fake-state, Reconcile, validation and publication is clicked
  explicitly. No Legacy Scenario POST is observed throughout the Workflow suite.
- Actual HTTP reads are reduced to page size 1 while preserving opaque cursors;
  the final run follows **320 cursor requests**. The UI never assumes one CAPEX
  Job or one page of Dataset/Job/Attempt data.
- Reload retains verified URL selections and sends **zero POST**. Returning from
  Free Exploration observes an explicitly created second FAB_COST candidate,
  while preserving the existing verified CAPEX selection. Desktop/tablet/mobile
  fit their viewport without horizontal overflow.
- Failure Retry preserves the complete FAILED Attempt 1 SQL row; only the selected
  CAPEX Job obtains Attempt 2 SUCCEEDED. The other Job retains a single Attempt.
- Lost ACK returns real 202/DISPATCHING with an actual Fake execution. Reload sends
  no mutation. Explicit Recover keeps Attempt
  `b8fb7b98-0ddb-42c3-a389-000fc2a01a83`, number, DAG and run identity; it ends
  SUCCEEDED with one Attempt for that Job. Two CAPEX Jobs have exactly two external
  executions in total. No third external execution is created by Recovery.
- Aborting a real Run HTTP response after Backend acceptance produces NETWORK_ERROR
  / Outcome Unknown. Durable GET observes the original ACCEPTED Attempt, no second
  POST is sent, and reload still leaves a single Attempt.
- Reset removes only the owned graph and clears selections; a new company/browser
  scope cannot read the old Dataset. Missing Cookie is 401; foreign resource is
  404; expiration/revocation clears rendered resources. No credential/Fake state
  enters localStorage; the HttpOnly Cookie is not readable by JavaScript.
- Final owned fixture `demo_05c3c_browser_32008_131c56f8d140` reports zero backends
  and normal DROP without FORCE. Legacy fixture also reports normal cleanup.

Final cleanup confirmed that the task's PostgreSQL service contained only the
maintenance database `postgres`; its container/anonymous volume and private test
target file were removed. No retained developer or production database was used.

Development findings resolved: static v2 PREVIEW is now explicitly separated from
the HTTP availability projection; mode reads fail closed instead of guessing;
Workflow unknown responses use pending presentation; Dataset detail checks current
Session resource membership before rendering cached detail. Browser simulation
selectors now have explicit accessible names and readiness checks await the
expected page. Test fixture HMR is disabled to prevent source edits from replacing
React Context during a run. An overloaded development run exceeded an old UI test's
5s timeout; final normal-load suites pass without increasing that limit.

Acceptance Criteria 1–13 are covered by these final local gates. No Core business
logic, state machines, immutable snapshots, dependency definitions, Gate/cutover,
Guided ledger, Fake semantics, ownership/reset protocol or historical migration is
changed. No known implementation blocker remains. Review/remote CI and actual
offline deployment remain separate Owner gates; this task performs no production
cutover or automatic merge.
