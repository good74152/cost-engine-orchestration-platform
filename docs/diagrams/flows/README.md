# Core engineering flow assets

For the reader-friendly gallery and implementation tables, open [Engineering Flows](../../ENGINEERING_FLOWS.md). This page documents editable sources, regeneration and technical review notes.

| Flow | Generator | Static SVG | Animation |
|---|---|---|---|
| Task 002 — Dataset Creation | [Source](generate-task-002.cjs) | [SVG](task-002-dataset-creation.svg) | [GIF](task-002-dataset-creation.gif) |
| Task 003 — Immutable Snapshot | [Source](generate-task-003.cjs) | [SVG](task-003-immutable-snapshot.svg) | [GIF](task-003-immutable-snapshot.gif) |
| Task 004 — Execution Dispatch | [Source](generate-task-004.cjs) | [SVG](task-004-execution-dispatch.svg) | [GIF](task-004-execution-dispatch.gif) |
| Task 005 — Executor Reconciliation | [Source](generate-task-005.cjs) | [SVG](task-005-executor-reconciliation.svg) | [GIF](task-005-executor-reconciliation.gif) |
| Task 006 — Dataset Lifecycle | [Source](generate-task-006.cjs) | [SVG](task-006-dataset-lifecycle.svg) | [GIF](task-006-dataset-lifecycle.gif) |

The Task 002–006 flows use the same SVG scene and Sharp GIF rendering approach. Each generator is an independent, editable source for its two final assets; generating one task does not modify the other tasks' outputs.

## Task 003 — Immutable snapshot

`generate-task-003.cjs` is the editable source for both the complete static SVG and the six-step GIF. Change the shared scene, text, palette or `STEPS` timing there, then regenerate both outputs. The layout and colors follow the README system architecture diagram.

The 25.2-second loop holds each step for reading, without flashing or decorative transitions. The static SVG shows all six steps and the final frozen relationship. Both jobs in this illustrative scenario require CAPEX for the same company/year/period; this is configurable dependency behavior, not a built-in DPR/CAPEX pipeline.

## Regenerate

Requires Node.js 24+ and Sharp 0.35.5 as an **isolated documentation tool**. Run from the repository root. The commands below install outside the repository and leave production dependencies and lockfiles unchanged.

PowerShell:

```powershell
$flowTools = Join-Path $env:TEMP 'cost-engine-flow-tools'
npm.cmd install --prefix $flowTools --no-save --package-lock=false sharp@0.35.5
node docs/diagrams/flows/generate-task-003.cjs --sharp-module (Join-Path $flowTools 'node_modules/sharp')
```

macOS/Linux:

```bash
flow_tools="${TMPDIR:-/tmp}/cost-engine-flow-tools"
npm install --prefix "$flow_tools" --no-save --package-lock=false sharp@0.35.5
node docs/diagrams/flows/generate-task-003.cjs --sharp-module "$flow_tools/node_modules/sharp"
```

The SVG uses the system sans-serif stack Arial/Helvetica/sans-serif, with no external fonts or images. Sharp uses locally available fonts when rendering the GIF, so rasterization can vary slightly by host. Inspect the regenerated images before committing.

Optional: append `--frames-dir <directory-outside-the-repository>` to export each step as SVG and PNG for inspection. The generator verifies GIF dimensions, six frames, infinite looping, frame timing and a file size below 1 MiB. Only the two final assets and this source need committing.

After generation, view all six frames and the SVG at full size and at README width. Check text, arrows and the CAPEX v1 pin after v2 appears, then run `git diff --check`.

## Technical boundary

First Run takes the ADR-0006 row-lock hierarchy, resolves published definitions for every job, selects matching published upstream versions and freezes one dataset-wide snapshot in one transaction. Job definition pins are stored on the jobs as part of this frozen build contract. Later preparation reuses both the snapshot and those pins without selecting newer definitions or upstream versions. Retries also preserve that contract; retry dispatch is outside this Task 003 animation.

Task 003 leaves the selected job `PENDING` and creates or reuses only its `PREPARED` attempt. The diagram does not show executor acceptance or financial calculation execution. Dispatch belongs to Task 004; the only implemented adapter on main is FakeExecutor for development/test.

Source references:

- [ADR-0003](../../adr/0003-versioned-dependencies-and-build-snapshot.md)
- [ADR-0006](../../adr/0006-first-run-lock-hierarchy.md)
- [Task 003 specification](../../tasks/003-first-run-immutable-build-snapshot.md)
- [Preparation service](../../../src/modules/calculation-job-preparation.service.ts)
- [PostgreSQL integration/concurrency tests](../../../scripts/first-run-immutable-build-snapshot.pg.test.ts)

## Task 002 Dataset Creation

`generate-task-002.cjs` creates `task-002-dataset-creation.svg` and `task-002-dataset-creation.gif` in this directory, using the same Node.js 24+ and isolated Sharp 0.35.5 setup described above. The six-step loop takes 26.9 seconds. Change this generator's scene or `STEPS` timings, then regenerate both outputs:

```powershell
node docs/diagrams/flows/generate-task-002.cjs --sharp-module (Join-Path $flowTools 'node_modules/sharp')
```

```bash
node docs/diagrams/flows/generate-task-002.cjs --sharp-module "$flow_tools/node_modules/sharp"
```

Append `--frames-dir <directory-outside-the-repository>` to export all step SVGs and PNGs. As in Task 003, generation validates dimensions, six frames, timing, infinite looping and a GIF size under 1 MiB. Preview all steps, the complete static SVG and the README image, then run `git diff --check`.

### Concurrency semantics and evidence

The illustrated winner is A; either request can win. Requests share the canonical identity `(domain, companyCode, fiscalYear, period)`. Inside each transaction the repository first executes `INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE` on that series. With a new series, the losing insertion may wait for the unique-identity conflict to resolve before it reaches the row-lock query. With an existing series, contention can wait at `FOR UPDATE`. The animation's blocked path represents this series coordination; it does not claim every waiter is already holding or querying a visible row.

Under the per-series lock, the winner checks for active DRAFT/BUILDING/VALIDATING versions, increments `dataset_series.last_allocated_version`, inserts a DRAFT version and a PENDING job for every active calculation type, then commits before returning 201. The waiting request resumes, takes the same row lock and rechecks active state. It rolls back and returns `409 ACTIVE_DATASET_VERSION_EXISTS` before another counter increment. Database uniqueness constraints are correctness backstops alongside transactions and explicit locking. Distinct series need no shared global application lock.

The last frame reproduces assertions from the existing real-PostgreSQL regression `serializes 20 same-series creates through the series row`: 1 HTTP 201, 19 HTTP 409, 1 series, 1 DRAFT version, 3 PENDING jobs and `last_allocated_version = 1`. Its configured active types are ASSET_SUMMARY, TABLE_X and TABLE_Y; three jobs is a fixture result, not a platform-wide fixed count. The same test asserts zero snapshots and attempts. The illustration is documentation of that test contract, not evidence of a new PostgreSQL run for this documentation change.

No active calculation types causes complete rollback, including a newly inserted series, counter allocation, version and jobs. Creation does not resolve dependencies or create snapshots/execution attempts. Committed version numbers increase monotonically and are not reused after rejected or abandoned history; a rolled-back allocation is not a committed historical version.

Sources:

- [Task 002 specification](../../tasks/002-dataset-version-creation-v2.md)
- [ADR-0001](../../adr/0001-canonical-dataset-identity.md)
- [ADR-0004](../../adr/0004-series-serialization-and-lock-ordering.md)
- [Dataset creation service](../../../src/modules/dataset-version/dataset-version.service.ts)
- [Dataset creation repository](../../../src/modules/dataset-version/dataset-version.repository.ts)
- [PostgreSQL creation/concurrency tests](../../../scripts/dataset-version-creation-v2.pg.test.ts)

## Task 004 Execution Dispatch

`generate-task-004.cjs` creates `task-004-execution-dispatch.svg` and `task-004-execution-dispatch.gif`. Edit its shared scene or `STEPS` text/timing, then regenerate both files. The six-step loop takes 27 seconds. It uses the same Node.js 24+ and isolated Sharp 0.35.5 setup above, with no production dependency changes:

```powershell
node docs/diagrams/flows/generate-task-004.cjs --sharp-module (Join-Path $flowTools 'node_modules/sharp')
```

```bash
node docs/diagrams/flows/generate-task-004.cjs --sharp-module "$flow_tools/node_modules/sharp"
```

Append `--frames-dir <directory-outside-the-repository>` to export step SVGs and PNGs. The generator checks dimensions, six frames, exact timing, infinite looping and a GIF size under 1 MiB. Inspect every frame, the complete static SVG and gallery playback, then run `git diff --check`. Public labels use short English; fuller details stay in the Engineering Flows tables and notes below.

### Dispatch and recovery

The animation starts after Task 003 has saved a `PREPARED` attempt, its backend-generated identity and a frozen snapshot. The initial job is `PENDING`. Task 004 locks job then attempt, saves `DISPATCHING`, reads the command from frozen data and commits. It then calls the executor outside database transactions and locks. A new transaction records the response. ACCEPTED or ALREADY_EXISTS saves attempt `ACCEPTED` and job `RUNNING` together. REJECTED records `DISPATCH_FAILED`; UNKNOWN keeps `DISPATCHING`. Both leave the job's prior state unchanged.

The three outcomes in Step 4 are alternatives, not three events in one run. Steps 5–6 follow the existing `ACCEPT_THEN_UNKNOWN` test case: the fake has created a run, its response is lost, and the backend keeps the same attempt. Another `/run` reuses DISPATCHING in a short transaction, commits, then sends the same identity. The fake returns ALREADY_EXISTS; a new transaction saves ACCEPTED and RUNNING. The test asserts one stored attempt and one fake run. This documents existing tests; it does not report a new PostgreSQL run for this docs change.

The full identity is `(airflowDagId, airflowDagRunId)`, not the run ID alone. The image uses the shortened template `cost-engine-<uuid>`; the same UUID and DAG ID are preserved on recovery. Duplicate prevention depends on that stable identity and the executor's ID checks. An HTTP retry by itself is not a general duplicate-prevention guarantee. UNKNOWN may also mean no run was created and can remain unresolved; it is a result, not an attempt status.

ADR-0008 defines REJECTED as a permanent no-run guarantee for the whole identity: the run never existed and cannot be created later by a repeated or overlapping dispatch. An adapter that cannot enforce this must return UNKNOWN. FakeExecutor enforces this with instance-local, in-memory run records and rejection markers. It is development/test only, with no durability across restarts or processes and no real Airflow adapter.

The displayed result mappings assume the selected attempt is still DISPATCHING. Current main also preserves already-confirmed or terminal state if late dispatch responses arrive; it does not rewrite history. Once ACCEPTED is stored, another `/run` returns that saved state without calling the executor again.

A permitted retry after a definite dispatch failure or confirmed execution failure creates a new attempt and a new identity, while keeping the frozen snapshot and job definition pins. That is different from UNKNOWN recovery, which keeps the same attempt. Task 005 owns terminal success/failure reconciliation. This animation ends at dispatch confirmation; it adds no terminal transitions or new backend behavior.

Sources:

- [Task 004 specification](../../tasks/004-execution-attempt-dispatch-fake-executor.md)
- [ADR-0005](../../adr/0005-execution-attempts-and-airflow-reconciliation.md)
- [ADR-0008](../../adr/0008-identity-scoped-definite-dispatch-rejection.md)
- [Run service](../../../src/modules/calculation-job-run.service.ts)
- [FakeExecutor](../../../src/executors/fake-executor.ts)
- [PostgreSQL dispatch tests](../../../scripts/execution-attempt-dispatch-fake-executor.pg.test.ts)

## Task 005 Executor Reconciliation

`generate-task-005.cjs` creates `task-005-executor-reconciliation.svg` and `task-005-executor-reconciliation.gif`. Edit its shared scene, labels or `STEPS` timing, then regenerate both files. The six-step loop takes 27.8 seconds. Use the same Node.js 24+ and isolated Sharp 0.35.5 setup above. No production dependency changes are needed.

```powershell
node docs/diagrams/flows/generate-task-005.cjs --sharp-module (Join-Path $flowTools 'node_modules/sharp')
```

```bash
node docs/diagrams/flows/generate-task-005.cjs --sharp-module "$flow_tools/node_modules/sharp"
```

Append `--frames-dir <directory-outside-the-repository>` for step SVGs and PNGs. Generation checks dimensions, six frames, exact timing, infinite looping and size below 1 MiB. Inspect every frame, the complete static SVG and README playback. Check the executor/DB gap, Job → Attempt lock order and matching duplicate result. Then run `git diff --check`.

### Check first, then save

The scene starts with Job RUNNING and Attempt ACCEPTED after dispatch. Changing the fake execution to SUCCEEDED changes no PostgreSQL rows. Manual `POST /calculation-jobs/:jobId/reconcile` and `POST /executor-callbacks/airflow` both reach `reconcileExecutionAttemptService`. A callback supplies only `airflowDagId` and `airflowDagRunId`; extra status fields are rejected. It asks for a check, not a direct state change.

The service reads saved execution identity and asks `getExecutionStatus` without holding a database transaction or row locks. After the reply it starts a transaction, locks the Calculation Job, then Execution Attempt, and rechecks identity, dataset state, attempt state and any newer retry. It saves confirmed job/attempt changes together and commits. A failed write rolls back both changes. The example keeps the dataset BUILDING after job success.

The last frame checks the same SUCCEEDED result again. It keeps the confirmed state, including completion timestamps. It creates no new attempt and makes no dispatch call. This is the matching duplicate case, not a claim that every old or conflicting observation is ignored.

### Missing results and UNKNOWN recovery

For a current ACCEPTED attempt, RUNNING keeps ACCEPTED/RUNNING; SUCCEEDED or FAILED updates both rows to the matching final state. NOT_FOUND and UNAVAILABLE leave local state unchanged and return `503 EXECUTOR_STATUS_UNAVAILABLE`. Neither proves execution failure or permits a new attempt. A thrown lookup error uses the same unavailable response.

For a DISPATCHING attempt left by Task 004, a confirmed RUNNING result saves ACCEPTED/RUNNING. A confirmed SUCCEEDED/FAILED result can finish both rows directly, without first committing RUNNING. All these paths keep the same attempt and execution identity. UNKNOWN is a dispatch result, not an attempt state.

### Older results and retries

- An old terminal attempt with the same confirmed result is checked and returned. A newer attempt and its job state are preserved.
- If a check starts from a non-terminal attempt, another check may finish it while the first waits for the executor. A late RUNNING observation then returns the saved final result without moving it back to RUNNING.
- If the attempt was already terminal when the check started, a new RUNNING observation is an invariant error. Conflicting terminal results are also invariant errors. History stays unchanged; the public response is `500 INTERNAL_SERVER_ERROR`.
- A non-terminal older attempt with a newer retry is an invariant error. It is not silently ignored.

Only manual and callback-triggered checks exist. No background worker or periodic repair is implemented. FakeExecutor is development/test only, and its in-memory execution records do not survive restart or transfer between processes. No real Airflow adapter is shown. Job completion does not automatically validate or publish a dataset. This task changes no Demo implementation.

### Source checks

The existing PostgreSQL tests cover the fake/DB state gap, direct DISPATCHING recovery, missing/unavailable results, matching repeats, stale RUNNING observations, terminal errors, old callbacks after retry, callback input validation, lookup with no held job/attempt locks, concurrent duplicates and atomic rollback. These are sources for the diagram; this documentation change does not claim a new database test run.

- [Task 005 specification](../../tasks/005-executor-reconciliation.md)
- [ADR-0005](../../adr/0005-execution-attempts-and-airflow-reconciliation.md)
- [Reconciliation service](../../../src/modules/calculation-job-reconciliation.service.ts)
- [Reconciliation repository](../../../src/modules/calculation-job-reconciliation.repository.ts)
- [Callback route](../../../src/modules/executor-callback.route.ts)
- [FakeExecutor](../../../src/executors/fake-executor.ts)
- [PostgreSQL reconciliation tests](../../../scripts/executor-reconciliation.pg.test.ts)

## Task 006 Dataset Lifecycle

`generate-task-006.cjs` creates `task-006-dataset-lifecycle.svg` and `task-006-dataset-lifecycle.gif`. The static SVG includes all six states and all six allowed paths. The GIF highlights the six-step example and shows Publish/Reject waiting on the same series. Edit the shared scene, state definitions or `STEPS` timing, then regenerate both files.

The loop takes 27.2 seconds. Use the existing Node.js 24+ and isolated Sharp 0.35.5 setup above. No production dependency changes are needed.

```powershell
node docs/diagrams/flows/generate-task-006.cjs --sharp-module (Join-Path $flowTools 'node_modules/sharp')
```

```bash
node docs/diagrams/flows/generate-task-006.cjs --sharp-module "$flow_tools/node_modules/sharp"
```

Append `--frames-dir <directory-outside-the-repository>` to inspect step SVGs and PNGs. The generator checks dimensions, six frames, exact timing, infinite looping and size below 1 MiB. Inspect the complete state machine, every GIF frame and README playback. Check both Abandon paths, explicit validation and the blocked Reject request. Then run `git diff --check`.

### Explicit state changes

Creation starts DRAFT (Task 002). First Run freezes a snapshot and moves to BUILDING (Task 003). BUILDING can include jobs that are preparing, running, failed or complete. All jobs succeeding does not validate or publish the dataset. Submit Validation checks readiness and moves to VALIDATING only on an explicit command. Publish or Reject then makes the final decision.

PUBLISHED means released; REJECTED means rejected during validation; ABANDONED means safely stopped before validation. These are final, or terminal, states. No dataset-level FAILED exists. Repeating a command whose target is already reached returns 200 with saved state and timestamps. An opposing or invalid target returns STATE_CONFLICT; it never replaces the old final state.

### PostgreSQL lock order

| Command | Lock Order |
|---|---|
| Submit Validation | dataset_version → calculation_jobs → execution_attempts |
| Publish / Reject | dataset_series → dataset_version |
| Abandon | dataset_series → dataset_version → calculation_jobs → execution_attempts |

Jobs are locked in ID order. Attempts are locked in `(calculation_job_id, attempt_number)` order. State is checked after the required locks are held. All state changes commit inside PostgreSQL transactions.

For a normal incomplete job, Submit Validation returns `409 DATASET_NOT_READY_FOR_VALIDATION` with no change. The code also checks invalid stored combinations, such as a SUCCEEDED job with an active attempt, as internal invariant errors. Publish/Reject require VALIDATING; they do not rerun the full job-readiness check.

### Two final requests

Either Publish or Reject can win. The GIF shows Publish holding the series lock while Reject waits. Publish then locks the version, confirms VALIDATING, saves PUBLISHED and commits. Reject acquires the series and version locks, sees PUBLISHED and returns `409 STATE_CONFLICT`. If Reject commits first, Publish conflicts instead. No global/distributed lock or new backend technology is involved.

This is the existing Task 006 Publish-vs-Reject regression. It is separate from Task 007 CON-01 late-dispatch recording and CON-02 identity-scoped rejection races. The diagram does not rename those executor races as publication races.

### Safe Abandon

Only DRAFT or BUILDING may become ABANDONED. Any PREPARED, DISPATCHING or ACCEPTED attempt blocks Abandon with `409 DATASET_HAS_ACTIVE_EXECUTION`. A PREPARED attempt can still be dispatched, so it is included. The guard checks all attempts after taking the ordered job/attempt locks. Terminal attempts do not block it.

Abandon does not cancel external work. It does not delete attempts or change job/attempt state, frozen snapshots or definition pins. An invalid RUNNING job without an ACCEPTED attempt is an internal error. Dataset Abandon and Demo Session Reset are separate operations; this task changes no Demo code.

### Source checks

The lifecycle PostgreSQL tests cover readiness, same-target repeats, both Publish/Reject winners, ordered waiting, active-attempt Abandon guards, atomic rollback and unchanged build history. These tests were read to check the animation. This documentation change does not claim a fresh PostgreSQL run.

- [Task 006 specification](../../tasks/006-validation-and-dataset-terminal-decisions.md)
- [Task 007 specification](../../tasks/007-end-to-end-hardening-and-legacy-cleanup.md)
- [ADR-0007](../../adr/0007-dataset-terminal-decisions-and-publication-serialization.md)
- [Lifecycle service](../../../src/modules/dataset-version/dataset-version-lifecycle.service.ts)
- [Lifecycle repository](../../../src/modules/dataset-version/dataset-version-lifecycle.repository.ts)
- [PostgreSQL lifecycle tests](../../../scripts/dataset-version-terminal-lifecycle.pg.test.ts)
