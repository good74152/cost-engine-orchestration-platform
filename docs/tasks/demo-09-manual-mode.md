# Demo-09: Manual mode

Lets a viewer drive the lifecycle by hand and see the backend refuse out-of-order actions. The scenarios
show the mechanism; this shows that the rules are real. It amends [ADR-0020](../adr/0020-one-page-demo-ui.md).

## Scope

- A fifth card, `Manual mode`, swaps the charts for one panel.
- Dropdowns for report and year/period, and `Create version`.
- Three tables: `dataset_version`, `calculation_job` and `execution_attempt`. Selecting a row filters the next table.
- Version actions: Submit, Publish, Reject, Abandon. Job actions: Run, Check result.
- Run opens a dialog with Success, Failed or Unknown.

Out of scope: backend changes, login, list pages, a "job system rejected" outcome and automatic triggers.

## Rules

**The page holds no lifecycle rule.** A button is disabled only while a request is in flight. Every refusal comes
from the backend and appears in a dialog with its HTTP status and code.

**Upstream is checked at a job's first Run, not at Create.** `ADR-0003` and `AGENTS.md` keep dependency resolution out
of dataset creation, so a viewer can create Capital expenditure first and then gets `409 DEPENDENCY_NOT_READY` on Run. The
line under the dropdowns states what the report needs, read from the workflow template. It informs and blocks nothing.

**Check result stays a separate click.** After Success or Failed, the database still says running until the viewer
checks. That gap is what reconciliation exists to close.

## Outcomes

These are sent to the existing `/demo/*` routes. There is no new endpoint.

| Choice | Calls | Then |
|---|---|---|
| Success, Failed | `run` with `ACCEPT`, then `fake-state` | Job stays Running until Check result |
| Unknown | `run` with `ACCEPT_THEN_UNKNOWN` and `SUCCEEDED` | HTTP 202 and try Unknown |
| Check result on Unknown | `reconcile` | Same try, reads the job's real outcome |
| Run on Unknown | `run`, then `fake-state` | Same try and run ID. Unknown isn't offered again, because a run's simulation binds once |

## Refusals the browser test proves

| Action | Reply |
|---|---|
| Run before the upstream report is published | `409 DEPENDENCY_NOT_READY`, and no try is created |
| Publish or Reject before Submit | `409 STATE_CONFLICT` |
| Submit before every job succeeds | `409 DATASET_NOT_READY_FOR_VALIDATION` |
| Check result before any run | `409 EXECUTION_NOT_RECONCILABLE` |
| Run a job that already succeeded | `409 JOB_NOT_RUNNABLE` |

Running a job that is already Running is not refused. The backend returns the same try.

## Verification

- Unit tests with the API double: refusal dialog, then Unknown through recovery to publish.
- Real Chromium, production bundle, Caddyfile CSP and PostgreSQL: the refusals above, Unknown recovered both ways with the
  same try and run ID, retry keeping the failed try, reject, abandon, language switch and no sideways scroll at phone width.

## Limits

- Success messages use a status line rather than a dialog, because a viewer clicks many times here. Refusals use a dialog.
- A status line already on screen keeps its language until the next action.
- Run IDs appear only for runs started on this page load. The Attempt API doesn't return them, on purpose.
- A job recovered straight to its final state shows no Started time, because the backend records none for that path.
