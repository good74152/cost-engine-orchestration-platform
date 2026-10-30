# Demo-05D-3B — Disaster Recovery Drill and Recovery Assessment

Authority: System Owner's bounded DR Drill specification. Baseline latest main
`410b7855b72f9920282ef1cde5dfdb555f891d60`, PR #45 confirmed formally merged.
Branch `codex/demo-05d3b-dr-drill`. Await System Owner Review; no merge or actual
production VPS/database/recovery/deployment/public activation operation.

## Accepted boundaries and implementation

Use one explicit internal drill mode in the existing Demo-05D-2/3A restore harness.
Preserve default first-deployment and verify-backup-live CLI/JSON/success behavior.
No second restore engine, caller-selected target, Database URL, production Volume
or Container exists. Existing Manifest integrity, actual pg_restore, Schema/full
WORKFLOW Configuration/data verification, Docker ownership and cleanup are reused.

Before deleting the isolated target, run the current trusted assessment source
in the retained backup operator image with read-only source mounts. Only the
random owned restore namespace is shared; no deployed secrets/volume/socket or
Backend/FakeExecutor is loaded. The assessment uses REPEATABLE READ READ ONLY,
queries all Job/Attempt status counts and complete bounded manual work, and
changes no state. SQL is not another state machine or recovery protocol.

The manual DTO permits only Job ID, optional Attempt ID, stored statuses, a fixed
reason code and category. No-attempt/PREPARED/recorded rejected work differs from
DISPATCHING unknown outcome and ACCEPTED external-state confirmation. Terminal
history stays untouched. More than 10,000 manual items fails, never silently
truncates. Arbitrary extra/secret columns are rejected at the report boundary.

RPO uses manifest.startedAt and host assessment time. An explicit nonnegative
integer target or null is required; missing targets are NOT_CONFIGURED. A target
may be EXCEEDED while technical restore succeeds. Actual Data Loss is UNKNOWN,
and production RPO is not claimed. Invalid/future/reversed times or wall/monotonic
clock inconsistency reject the report. One-second drift tolerance is explicit;
no UTC accuracy beyond trusted Owner clock synchronization is implied.

Ordered Integrity Check/Restore/Validation/Assessment/Cleanup stage markers are
observed using host process.hrtime.bigint. Reporting includes all five PASS
durations, drillDurationMs, serviceRecoveryTested=false, achievedRtoMs=null and
productionRecoveryApproved=false. It measures database drill work, not service
recovery. No automatic Retry/Redispatch/Backend restart or approval exists.

Private output requires an existing current-owner 0700 absolute off-Git directory
(equivalent Windows ACL policy). A cryptographic 128-bit random identity reserves
new temporary/report directories exclusively. Manual IDs never enter the phase
or Console channel. After all validation and Docker/owned-workspace cleanup,
write a 0600 temporary JSON, sync, then atomic rename within the new private
directory. Old reports and the source backup are not overwritten/deleted.
On failure there is no successful report or DRILL_VERIFIED; unconfirmed resources
are left for verified private manual inspection, not guessed deletion.

Core, Dataset versioning, Job/Attempt statuses, Immutable Snapshot, Unknown Outcome
Recovery, Session Security/invalidation, Gate/Cutover, migrations and public APIs
remain unchanged. This supplements accepted ADR-0010/0017/0018 without changing
their runtime or recovery decisions. See [recovery runbook](../RECOVERY_DRILL.md).

## Verification and evidence boundary

Real PostgreSQL covers mixed RUNNING/ACCEPTED, PREPARED, DISPATCHING, no-attempt
and recorded failed-dispatch work; SUCCEEDED/FAILED history and complete stored
data fingerprints remain unchanged. An actual write probe inside the assessment
transaction must fail with PostgreSQL 25006. More than 10,000 rows and secret/
incomplete DTOs fail rather than producing a success list. Clock/RPO tests cover
unset/normal/exceeded targets, malformed/future/reversed times and clock jumps.

Real Docker creates an owned populated source and Operational Backup, runs real
PostgreSQL 18 restore and reads the complete private report, comparing data and
schema hashes. It covers no report on Assessment/Cleanup/ownership failures,
original backup/database safety, private permissions/no secrets or public IDs,
repeated reports without overwrite, source-offline drill and unchanged existing
verify-backup-live output. Fault injection is private test PATH wrappers, with
no production test hook, external target, real disk exhaustion or blanket cleanup.
Tests rescue only verified owned resources after simulated observation failures.

Existing Demo-05D-3A/05D-2 PostgreSQL and real Docker suites remain in CI, with a
separate isolated DR job. Final exact-head test counts and CI links are recorded
in the PR delivery after validation. Actual off-host restore/service recovery,
production RPO/RTO, data-loss confirmation and recovery approval remain Owner work.
