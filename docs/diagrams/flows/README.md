# Task 003 flow assets

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
