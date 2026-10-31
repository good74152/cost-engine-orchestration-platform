# Demo-05D-4 — Fresh Installation Deployment Rehearsal

Authority: System Owner's bounded specification, including **commit only, no Push**.
Baseline: main `a56e63b3ffef2d6bd921c0117d36bf6b3e2eaf01` (PR #47 merged).
Branch: `codex/demo-05d4-deployment-rehearsal`.
Status: implemented; available local verification recorded below. GitHub execution
awaits System Owner's manual Push and decision whether to open a PR.

## Test architecture and isolation

`.github/workflows/deployment-rehearsal.yaml` adds contract tests, four matrix
jobs on **separate fresh GitHub-hosted Ubuntu 24.04 VMs**, and aggregate acceptance.
Matrix fail-fast is disabled so every independent scenario is observed. Existing
deployment/recovery/core/browser regression workflows remain enabled and unchanged.
Checkout tests the explicit PR head or push SHA; all artifacts must match the
actual clean checked-out commit and all four scenarios have distinct IDs.

`scripts/demo-05d4-rehearsal.ts` coordinates tests, not a second deployment or
recovery engine. It accepts only a fixed scenario and private summary directory.
It refuses non-Linux/non-hosted execution before Docker access and pins Docker to
the local default Unix daemon. Each fixture generates its own random Compose
project, Backend name override, Deployment Version/images, PostgreSQL volume,
secrets and off-repository 0700 workspace. No external DB URL, existing resource,
production environment secrets or restore destination is accepted. Production
Compose, scripts, authorization flags and Core protocols remain unchanged.

Before service operations and again before Web opening, parse the **complete
effective Compose JSON**, apply the existing production control validator and
fixture-only isolation checks. Backend/PostgreSQL/operator have no published
ports; PostgreSQL uses a fresh named volume. Internal database/proxy networks,
custom Backend identity, `tls internal`, exact localhost HTTPS origin and both
TCP/UDP Web loopback bindings are mandatory. Host networking, external volumes,
extra/unbound ports and production Backend identity are rejected. After startup,
Docker HostConfig and actual NetworkSettings bindings independently confirm both
protocols on 127.0.0.1 only. Caddy's private test CA is trusted explicitly; TLS
verification is never disabled, and no public ACME/DNS is used.

## Stages and acceptance

| Stage | Happy Path evidence |
| --- | --- |
| FRESH_INSTALLATION | Build real images, call `deploy.sh`, observe DB only and no public tables, explicitly migrate/seed, compare full migration filenames/inventory, verify LEGACY_OPEN/LEGACY through existing Status, Web closed. |
| CUTOVER_PREPARATION | Actual drain → empty-data preflight → first-deployment backup → actual isolated restore; original SHA/manifest and source hash preserved, restore resources cleaned. |
| CONFIGURATION_CUTOVER | Exactly one explicit existing Cutover call; WORKFLOW_OPEN and complete WORKFLOW Status; Backend/Web remain stopped. |
| BACKEND_START | Actual `start.sh`, internal health/ready/Deployment Version, full existing Configuration Status, no DB/Backend host ports, Web closed. |
| PRE_WEB_RECOVERY | Actual Operational Backup → DR Drill → Readiness; archive SHA and full Drill/Manifest/schema/config/data/count bindings, cleanup, Local READY, Disaster NOT_VERIFIED without Off-host evidence. Backend process/source state retained. |
| WEB_ACCEPTANCE | Only after earlier acceptance: unchanged `open-web.sh` approval and explicit DB-file parameters; local-CA HTTPS, actual TCP/UDP loopback, secure host Cookie/idempotent Session replay, Origin/CSRF, four AVAILABLE v2 templates and private-route denial. |
| WORKFLOW_ACCEPTANCE | Existing HTTP APIs create/publish six Domains, ten Jobs including two CAPEX Jobs. limit=1 pagination, dependency rejection before FAB publication, premature publish/validation refusal, Run/fake-success/Reconcile, terminal Attempt history, immutable first-Run snapshots and five direct published upstream bindings. |
| WEB_CLOSURE | Actual `close-web.sh`, stopped Web/restart=no, same healthy Backend and DB volume, exact graph/configuration/Gate/migration digest retained. |
| HISTORY_RECOVERY | Repeat actual online backup/drill/readiness with six published Datasets, ten succeeded Jobs/Attempts and six snapshots; complete data verification/cleanup and Local READY/Disaster NOT_VERIFIED, no Backend restart. |
| CLEANUP | Prove all project resources owned, remove exact resources, verify absence and restore-resource baseline, then remove proven-owned private workspace. |

Six-domain test expectations are extracted from existing Demo-05C-3B into a shared
test-only module; its original integration test uses the same values. No Core
dependency definition/catalog/runner is changed. SQL observes only hashes and
snapshot bindings inside READ ONLY transactions. Every Workflow write uses Demo
HTTP APIs; every migration/seed/drain/cutover uses existing deployment tools.

Fixture recovery policy explicitly sets one-hour RPO/drill/evidence limits; these
are not production defaults or achieved objectives. Existing 3B DTO/assessment and
3C validation are reused. Actual PostgreSQL 18 restore remains in the existing
engine with its unchanged ownership, isolation and cleanup rules.

## Failures and fail-stop

- Backend failure completes proper installation, first backup/restore and Cutover,
  then changes only the test Backend's existing executor-limit configuration to
  an invalid value. Actual `start.sh` must fail with an exited/unhealthy Backend;
  Web opening is refused, source/migration/configuration hashes unchanged. Later
  normal stages are NOT_TESTED; no seed, migration, recovery or restart is added.
- Cutover failure uses a freshly migrated/seeded LEGACY_OPEN fixture and calls the
  actual Cutover once without drain. Require expected refusal, unchanged complete
  source hash, LEGACY_OPEN and no Backend/Web. Preparation and later normal stages
  are NOT_TESTED.
- Restore failure creates a valid first-deployment backup and really restores it
  successfully, then corrupts only a new private copy with a new bundle identity.
  Existing verification must reject its archive header and emit no RESTORE_VERIFIED.
  Original backup/manifest/source stay unchanged and no restore resources remain.
  Cutover/Backend/Web/later recovery are NOT_TESTED. No production fault flag exists.

Expected rejection stages are PASS only after exact expected refusal, unchanged
source and absence of unintended services; the scenario additionally requires
successful Cleanup. Fixed codes are EXPECTED_BACKEND_STARTUP_REJECTION,
EXPECTED_CUTOVER_PRECONDITION_REJECTION and EXPECTED_RESTORE_INTEGRITY_REJECTION.
Unrelated build/transport/assertion/tool failures are FAIL (`<STAGE>_FAILED`), never
expected-negative success. Unknown ownership records CLEANUP_OWNERSHIP_UNCONFIRMED.
All normal work stops at the first unexpected failure; later stages stay NOT_TESTED.

## Cleanup and public evidence boundary

Every Compose resource carries both random project and rehearsal-owner labels.
Cleanup inventories and validates all Container/Volume/Network ownership before
deleting any, then rechecks immediately before exact-ID/name removal. Unknown
ownership withholds success; no guessing, blanket Compose Down or Docker Prune.
Restore/snapshot resources retain their existing engines' cleanup; the coordinator
checks absence/baseline rather than deleting unknown recovery resources. Workspace
deletion requires matching original device/inode, real path and random marker.
Cached image layers are left to disposable Runner teardown and are not pruned.

Commands have bounded time/output and only their own child process group may be
terminated. A timeout never permits continuation. GitHub's outer job deadline
cannot guarantee finally runs; missing/failed summary still prevents acceptance,
and disposable VM teardown is final containment. No production host cleanup occurs.

Backups, credentials, Cookies, raw observations, full Drill/Readiness reports and
private graph IDs stay inside the private test workspace and are never uploaded
or forwarded to Console. Secret mounts remain readable by existing unprivileged
container users; their host parent is 0700. Child output is bounded/captured;
public errors are fixed codes only.

Each scenario publishes only a strict allowlisted JSON DTO: format/result, random
Rehearsal ID, tested SHA, scenario, times, fixed stage status/code/duration, Cleanup
Verification, readiness states and unconditional productionDeploymentApproved=false,
serviceRecoveryTested=false, fakeExecutorMemoryRestored=false. No resource IDs,
source paths, Database URLs, token/hash/password, private Job/Attempt list or raw
business rows enter the artifact. Only the exact sanitized scenario file is
uploaded. Aggregate acceptance validates every field and requires exactly four
distinct matching-commit PASS scenarios and all successful cleanup. Missing,
extra, malformed, mismatched, failed or cancelled scenarios cannot produce PASS.

## Local verification and CI evidence

Contract tests cover stage/result rules, fail-stop, expected vs unexpected refusal,
cleanup/ownership failure, real-observation TCP/UDP checks, effective configuration,
artifact allowlisting and all-scenario gates. Strict Typecheck covers every new
script. Executed local/regression results are appended before commit.

**Codex performs no Push, PR creation or GitHub Actions execution for this task.**
There is no new-commit GitHub validation before Owner Push. After manual Push,
inspect both existing Build/isolated-verification and new Fresh-installation
workflows. Require all four matrix jobs, contracts and aggregate PASS; retain only
the sanitized acceptance artifact and exact tested SHA/run URL. An incomplete
stage or unconfirmed cleanup is not accepted. Owner decides PR/review separately.

Artifacts are scoped to the current `github.run_attempt`; repeated full workflow
runs do not overwrite or accidentally reuse earlier summaries. Re-run **all jobs**
when repeating acceptance, not only a failed leg: four summaries from the same
attempt are required. This is an explicit new isolated rehearsal, never an
automatic retry of Cutover or recovery against a failed fixture.

### Executed local checks

| Check | Result |
| --- | --- |
| New rehearsal contract/security tests | 20 PASS, 0 FAIL |
| Existing six-domain Workflow PostgreSQL regression (shared test expectations) | 12 PASS, 0 FAIL |
| Demo-05D-2 PostgreSQL | 58 PASS, 0 FAIL |
| Demo-05D-3A PostgreSQL | 19 PASS, 0 FAIL |
| Demo-05D-3B PostgreSQL | 12 PASS, 0 FAIL |
| Demo-05D-3C offline regression | 44 PASS, 0 FAIL |
| Core milestone, independent rerun | 259 PASS, 0 FAIL |
| Build, new/05C-3B strict Typecheck, workflow YAML syntax, diff whitespace | PASS |
| Existing 05D-1 Docker deployment regression | NOT PASSED: image pull/build blocked by local Docker Desktop HTTPS proxy connection refusal; subsequent fixture stages failed. Stopped its stalled owned worker: 4 PASS / 10 FAIL in partial run. |
| New four-scenario hosted-Linux rehearsal / new-commit GitHub evidence | NOT RUN: awaits Owner Push; never inferred from unit tests or prior CI. |

The first Core run failed its existing teardown assertion because one connection
was still observed after client shutdown; the complete independent rerun passed
all 259 tests without changing Core or weakening the test. Both results are
retained in local ignored logs. Local regression databases used an owned disposable
PostgreSQL 18 fixture (separate from the four rehearsal environments); its loopback
test connection is not a rehearsal port publication. All owned regression
Containers/Volumes/Networks, private secrets and temporary connection files were
removed after confirming identities. Existing unrelated Docker resources were
left untouched. The local proxy failure is not treated as expected-negative
acceptance, and no Docker/GitHub success is claimed for this new implementation.

## Production limitations

After CI runs this verifies only disposable Linux fixtures. It is not production
VPS deployment, public DNS/TLS/ACME, host hardening, real data migration, Airflow,
off-host storage provenance, real recovery or production RPO/RTO acceptance.
Database restoration does not restore FakeExecutor memory or users' execution
ability. No automatic retry/redispatch/rollback/runtime activation or production
recovery approval is introduced. Existing Owner runbooks and approvals remain.
