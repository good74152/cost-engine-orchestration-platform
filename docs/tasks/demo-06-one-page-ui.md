# Demo-06 — One-Page Demo UI

Authority: System Owner's decisions of 2026-11-02. Architecture: [ADR-0020](../adr/0020-one-page-demo-ui.md).
Baseline: main `6ddf3d0`. Status: awaiting System Owner review. No deployment or production cutover is performed.

## Scope

- One page: a short explanation, four scenarios, the live workflow map and records, then-and-now, and limits.
- `Normal close`, `Lost reply`, `Failed job and retry` and `Conflicting requests`, each with Run and Step through.
- DataView of scenarios. OrganizationChart of the six reports, and of `dataset_series → dataset_version → calculation_job → execution_attempt`.
- Read-only `frozenInputs` on Demo dataset list and detail reads.
- Removal of the old frontend pages, routing and Tailwind. Backend Guided APIs are untouched.

Out of scope: README and document cleanup, AWS deployment, automatic triggers, new Core behavior.

## Interview acceptance findings addressed

| # | Finding | Result |
|---|---|---|
| 1 | Test depended on database collation | Compares as sets; passes on a `C.UTF-8` server |
| 2 | First visit showed "session expired" | A first visit shows no error |
| 3 | Each action jumped to the top | Data is replaced only after a complete read |
| 4 | "Local demo" wording on a public site | Removed |
| 5, 6, 8 | No next step, 30 actions, manual version selection | One click, automatic selection, completion dialog |
| 7 | Text read like an internal spec | Plain words, with technical names as captions |
| 9 | Conflicting product names | One name: Cost Engine Orchestration Platform |
| 10 | `DEPENDENCY_NOT_READY` gave no fix | The message says what to publish, and a scenario shows it |
| 11 | Frozen inputs and run ID were invisible | Input on version boxes; run ID in dialogs |
| 12 | 404 noise and timestamps without seconds | The Guided read is gone; details show seconds |

## Scenarios

Each run takes a reporting period the session hasn't used, so scenarios can be replayed.

| Scenario | Demonstrates |
|---|---|
| Normal close | Six reports published in dependency order; 10 jobs; each report locks its input |
| Lost reply | HTTP 202 and DISPATCHING; a pause for the viewer's decision; recovery on the same attempt and run ID; reconcile; publish |
| Failed job and retry | Confirmed failure; a newer upstream version; retry as a new attempt on the frozen input; publish |
| Conflicting requests | Four creates (one 201, three 409); Run before upstream is published (409, no attempt); Run after it is |

## Verification

The commands below ran on PostgreSQL 18.6 from `@embedded-postgres/linux-x64`, Node 24 and Chromium 153 in a cloud
environment without Docker. Container tests and hosted rehearsal rely on GitHub Actions for this commit.

- `npm run test:demo-06`: frozen inputs on list and detail, empty before first Run, unchanged by a newer upstream
  and by a retry, no internal identifiers, owner-scoped.
- `npm run ui:test`: unit tests against an in-memory API double.
- `npm run ui:smoke`: real Chromium, production bundle, PostgreSQL and the CSP from `deploy/Caddyfile`. Checks
  every scenario against database rows, no command on load or reload, a lost browser response not retried,
  session isolation, phone width, and no CSP violation or uncaught error.

## System Owner acceptance still required

- Someone who hasn't seen the project completes a scenario unaided, in 3–5 minutes.
- `npm.cmd` commands on the Owner's Windows machine. Container tests run in CI on Linux, which is the deployment target.
- The local `fcp_demo_legacy` database can no longer be operated from the UI, and its data isn't touched.
  `fcp_demo_workflow` works with this page.
