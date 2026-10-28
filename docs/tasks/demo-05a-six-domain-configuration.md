# Demo-05A — Six-Domain Demo Configuration

## Baseline and scope

Branch `codex/demo-05a-six-domain-configuration` starts from latest main
`372f619fa8c3c144f18d49b63275805686d984c6`. GitHub confirmed Naming-01 PR #34
merged at that commit. E2E_COST is canonical; no retired-name alias is added.
An isolated worktree preserves the unrelated uncommitted Demo-04C files and
retained local acceptance environment in the original checkout.

Authority: the System Owner's Demo-05A request, AGENTS, Architecture, Reference,
Demo-02A and accepted ADRs. This only adds an explicit configuration seed,
PostgreSQL integration tests and usage documentation. Core creation, snapshot,
Run/Retry/Reconcile, Session ownership, Guided logic and all applied migrations
are unchanged. No new table, API, runtime technology or user Dataset is added.

## Stable Demo configuration

Every row is active, has definition allocation counter 1, and exactly definition
version 1 PUBLISHED with a non-null publication timestamp. The upstream column
lists the exact required direct domains of that type's definition.

| Domain | Type code | Fake DAG ID | Required direct domain |
|---|---|---|---|
| CAPEX | DEMO_GUIDED_SUMMARY | demo_capex_guided | none |
| FAB_COST | DEMO_FAB_COST_SUMMARY | demo_fab_cost_summary | none |
| DPR | DEMO_DPR_TABLE_X | demo_dpr_table_x | CAPEX |
| DPR | DEMO_DPR_TABLE_Y | demo_dpr_table_y | CAPEX |
| INSURANCE | DEMO_INSURANCE_SUMMARY | demo_insurance_summary | FAB_COST |
| ONE_STD_COST | DEMO_ONE_STD_COST_TABLE_X | demo_one_std_cost_table_x | FAB_COST |
| ONE_STD_COST | DEMO_ONE_STD_COST_TABLE_Y | demo_one_std_cost_table_y | FAB_COST |
| E2E_COST | DEMO_E2E_COST_TABLE_X | demo_e2e_cost_table_x | ONE_STD_COST |
| E2E_COST | DEMO_E2E_COST_TABLE_Y | demo_e2e_cost_table_y | ONE_STD_COST |

These are teaching fixtures, not financial calculations or employer-specific DAGs.
The backend remains generic; all dependency behavior comes from persisted data.

## Explicit seed usage

Stop admissions and independent configuration writers before changing shared
configuration. Use a dedicated migrated Demo database, including Naming-01
(12 migrations at this baseline). Set the target privately; do not print secrets.

```powershell
$env:APP_MODE='demo'
$env:NODE_ENV='development'
$env:EXECUTOR_TYPE='fake'
# Privately set DEMO_SEED_DATABASE_URL to the intended migrated Demo database.
npm.cmd run seed:demo-six-domain
```

The new command can initialize all six domains from empty configuration, or add
the five domains after `seed:demo-guided`. It does not call that command in a
separate transaction. Existing CAPEX UUIDs, timestamps and definition remain
unchanged. The original minimal seed can still run afterward unchanged.
There is no DATABASE_URL fallback or application/startup import of the new seed.
Existing Demo environment/executor safeguards apply; this task does not weaken
the restricted production profile. The existing Docker operator packages the
new script and offers the explicit `seed-six-domain` action with the same
mandatory seed target file. With the backend stopped, run
`sh deploy/scripts/operate.sh seed-six-domain` before starting admissions.
The original `seed` action continues to install only guided CAPEX. Nothing runs
automatically, and no public deployment is performed by this task.

One transaction processes types in deterministic `(domain,code)` order, with
INSERT ON CONFLICT DO NOTHING and a type row lock. Same-command concurrent runs
converge on the same IDs. Only newly inserted types receive new definition rows;
existing rows receive no UPDATE. Every selected type/definition must match the
entire contract, including the exact dependency membership. Other active types
in these six domains are conflicts because creation includes every active type.
Unrelated inactive type/history rows are preserved, not activated or deleted.

Missing/extra/unpublished definitions, wrong DAG/counter/activation/dependencies
or extra active types return DEMO_CONFIGURATION_CONFLICT. Rollback removes any
earlier inserts in the same invocation. Unexpected persistence errors are
sanitized. If COMMIT acknowledgement is lost, the socket is discarded and the
command reports failure without guessing rollback; rerun safely verifies durable
configuration. Stop and investigate conflicts rather than deleting history or
repairing published rows. This supports the accepted single Demo backend with
no concurrent Core/external/configuration writer, not arbitrary cross-table
writer serialization.

## Existing API usage

Create using POST /demo/dataset-versions with domain/fiscalYear/period and the
existing Session cookie/CSRF policy. The backend supplies companyCode. All six
domains work without new routes. No Dataset is created by the seed itself.

For one session/year/period, publish CAPEX before running DPR. Publish FAB_COST
before INSURANCE or ONE_STD_COST, then publish ONE_STD_COST before E2E_COST.
CAPEX and FAB_COST have explicit zero-dependency definitions and may run first.
Both jobs in each two-job domain need the same configured upstream. A missing,
unpublished, foreign-session or different-period input does not satisfy Run.

Use the existing Run → fake success → Reconcile sequence for every job, then
Submit Validation → Publish. A fake ACK alone does not change SQL execution
state. Every required job must be SUCCEEDED before validation. First Run freezes
one dataset-wide snapshot; later jobs and retries reuse its inputs even after a
newer upstream publication. Guided Scenarios continue using only the original
CAPEX type and their existing empty-session/mode/ledger rules.

## Verification

`test:demo-05a` owns a uniquely named template0 PostgreSQL database, applies all
12 migrations, and verifies current_database before fixture writes. It runs the
actual CLI and protected Demo HTTP routes with actual PostgreSQL and session
FakeExecutor instances. It closes clients, verifies zero backends and normally
drops only its owned database. No persistent developer/manual Demo target is used.

Coverage: fresh and concurrent/repeated seed; unchanged CAPEX; all environment
gates; late conflict and real SQL fault atomic rollback; wrong/missing/extra
configuration; inactive history; exact six-domain creation/job sets; required
published upstream checks and foreign-session denial; all-job validation;
actual payloads and snapshot reuse after v2 publication for DPR/ONE_STD_COST/
E2E_COST, including failed-job Retry; all three Guided Scenarios after full seed.
Existing Core and Demo suites are also required. CI runs the new strict type
check and PostgreSQL suite against its disposable service.

Commands (private TEST_DATABASE_URL points to a disposable PostgreSQL service):

```powershell
npm.cmd run build
npm.cmd run test:demo-05a:typecheck
npm.cmd run test:demo-05a
npm.cmd run test:demo-02a
npm.cmd run test:demo-02b
npm.cmd run test:demo-02c
npm.cmd run test:demo-02d
npm.cmd run test:demo-02e
npm.cmd run test:demo-session-infrastructure
npm.cmd run test:demo-session-ownership-executor-isolation
npm.cmd run test:demo-session-reset-recovery
npm.cmd run test:demo-04
npm.cmd run test:demo-04:typecheck
npm.cmd run test:demo-04-containers
npm.cmd run test:milestone
git diff --check
```

### Executed verification — 2026-10-28 (Asia/Taipei)

Windows PowerShell, Node 24.18.0, PostgreSQL 18.6. Final source/tests passed all
commands below; this evidence text was added afterward. Core and all existing
Demo PostgreSQL suites ran against a fresh task-owned PostgreSQL service.
The container suite built the images and exercised the explicit operator seed
under the complete production Demo profile on local HTTPS, without deploying
the feature to the retained manual Demo.

| Command | Exit | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| npm.cmd run build | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05a:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-04:typecheck | 0 | n/a | n/a | n/a |
| npm.cmd run test:demo-05a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-02a | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-02b | 0 | 26 | 0 | 0 |
| npm.cmd run test:demo-02c | 0 | 27 | 0 | 0 |
| npm.cmd run test:demo-02d | 0 | 25 | 0 | 0 |
| npm.cmd run test:demo-02e | 0 | 37 | 0 | 0 |
| npm.cmd run test:demo-session-infrastructure | 0 | 21 | 0 | 0 |
| npm.cmd run test:demo-session-ownership-executor-isolation | 0 | 19 | 0 | 0 |
| npm.cmd run test:demo-session-reset-recovery | 0 | 22 | 0 | 0 |
| npm.cmd run test:demo-04 | 0 | 23 | 0 | 0 |
| npm.cmd run test:demo-04-containers | 0 | 13 | 0 | 0 |
| npm.cmd run test:milestone | 0 | 259 | 0 | 0 |
| git diff --check | 0 | n/a | n/a | n/a |

Total **518 pass / 0 fail / 0 skip**, with zero cancellations/TODOs. The unchanged
Core milestone includes Naming-01 (13), CON-01/CON-02 (14), late-dispatch (32),
API contracts (12), isolated raw ingestion (1), and E2E Flow A–F (7).
The new seed/API suite contributes 23 entries; existing Demo PostgreSQL suites
contribute 223; the Docker/HTTPS suite contributes 13; Core contributes 259.
Counts include Node parent/nested entries. CI results are separate from these
actual local runs. Logs remain in the host temporary directory, not Git.

Both root and frontend npm ci exited 0 and reported zero vulnerabilities. Root
npm reported the existing esbuild install-script approval warning; no approval
or dependency permission was added. Final test logs contained 0 warning/deprecation
lines. The initial supplemental test typecheck exited 1 because the Fastify
injection helper accepted unknown payload without serialization. JSON encoding
and an explicit response type fixed that helper; the strict rerun exited 0.
The preliminary PostgreSQL suite also passed 23/23; no PostgreSQL test failure
is reported as PASS. All intentionally injected configuration/SQL faults are
asserted passing cases.

New fixture teardown closed actual clients, checked zero backends and used normal
owned DROP. The dedicated service audit found only postgres/template0/template1
and zero other client connections; its exact owned container and anonymous
volume were removed. Existing Core FORCE cleanup policies were not changed.
Docker project demo04_test_a2702873aca4 verified removal of its own disposable
volumes. Original developer resources, uncommitted Demo-04C work, retained manual
Demo and credentials were left intact; the manual containers were already stopped.
Git emitted normal LF/CRLF conversion notices during staging. No accepted architecture conflict was
found. System Owner review is required; no automatic merge or deployment.
