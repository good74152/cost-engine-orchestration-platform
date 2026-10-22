# Core engineering flow assets

The Task 002 and Task 003 flows use the same SVG scene and Sharp GIF rendering approach. Each generator is an independent, editable source for its two final assets; generating one task does not modify the other task's outputs.

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
