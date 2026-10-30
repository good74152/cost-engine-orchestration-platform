# Private Disaster Recovery Drill

This operator tool verifies a disposable database restore and evaluates retained
execution risks. It cannot perform production recovery or approve reopening.
Use one trusted System Owner, reviewed source, Docker and Node 24 with repository
dependencies installed by npm ci. No production VPS/database operation is implied.

## Inputs and prerequisites

- An intact Demo-05D-3A OPERATIONAL custom backup and its trusted manifest.
- The matching retained `cost-engine-demo-operator:<Deployment Version>` image
  and PostgreSQL 18 image available locally. Retain reviewed images/source with
  off-host backups. The original image need not contain the new assessment file:
  only current trusted assessment TypeScript sources are mounted read-only into
  that image. No production volume, secrets, network or Docker socket is mounted.
- An existing private, writable absolute report directory outside every Git
  worktree. POSIX requires current-owner mode 0700; provision equivalent private
  Windows ACLs. Symlink roots and repository aliases are rejected.
- Sufficient disk/temp/Docker capacity for restore and report. Keep the archive,
  manifest, source checkout, images and private directories immutable to other
  operator activity for the duration. Arbitrary privileged administrators are not
  fenced by this tool. SHA-256 is corruption detection, not artifact authenticity.

```sh
# From the reviewed checkout. No Database URL or restore target argument exists.
sh deploy/scripts/dr-drill.sh \
  --backup-file /var/backups/cost-engine-demo/cost-engine-live-backup-IDENTITY/backup.dump \
  --report-dir /var/private/cost-engine-drills

# Only when the Owner has actually selected a target: example, not a default/SLA.
sh deploy/scripts/dr-drill.sh \
  --backup-file /var/backups/cost-engine-demo/cost-engine-live-backup-IDENTITY/backup.dump \
  --report-dir /var/private/cost-engine-drills \
  --target-rpo-ms 86400000
```

On Windows, run `npm.cmd run demo:dr-drill --` with the same options using native
absolute paths. Node 24 / tsx, Git Bash and GNU timeout are needed; normal existing
backup verification remains unchanged. Do not put a database URL or secret in
arguments/environment for this drill. Supplied deployment/runtime database env
variables are ignored: the existing harness generates its own isolated target.

## Observed phases and private output

The same restore engine verifies complete archive/manifest integrity, creates
fresh owner-labelled PostgreSQL 18/Volume identities, uses network none and zero
published ports, runs actual pg_restore, and repeats the shared migration,
WORKFLOW_OPEN + full WORKFLOW, Schema/Configuration/data-hash checks. No Backend
is started. The original database may be offline and is never a restore target.

Before deleting that target, a separate temporary read-only assessment process
shares only the target namespace. PostgreSQL enforces READ ONLY, with one
REPEATABLE READ view for status counts/manual review. No DML/DDL, executor calls,
Session invalidation, Retry, Redispatch, reconciliation or runtime startup occurs.
No execution status is inferred from FakeExecutor memory because none is loaded.

Integrity Check, Restore (including target creation/readiness), Validation,
Assessment and Cleanup have ordered START/PASS markers timestamped at emission
using host Node process.hrtime.bigint. The coordinator validates their monotonic
clock compatibility/order; buffered stdout cannot collapse stage time. Durations
include command/marker-process overhead, not just SQL time. drillDurationMs ends after verification
and owned workspace cleanup, before report serialization/publication. It is not
service recovery duration. Docker drill operations are bounded at ten minutes
per call; cleanup calls at eight seconds plus two-second kill grace. SQL uses
the existing verification bound and a 60-second assessment statement bound.
The coordinator requests abort at 45 minutes; resource cleanup may still require
bounded command completion and private manual investigation on daemon failure.

Only after all five phases succeed and Docker cleanup is confirmed does the
coordinator publish `<report-dir>/drill-<128-bit-random-id>/report.json`:

- A fresh exclusive directory prevents reuse/overwriting another report.
- A 0600 temporary file is synced and atomically renamed inside that new 0700
  directory. Prior reports and backups are never removed or overwritten.
- The report contains backup identity/checksum/size/version/time, verified
  fingerprints/migration inventory/counts, read-only assessment, RPO evidence,
  stage outcomes/durations and the explicit recovery limitations.
- Manual Job/Attempt IDs and reasons appear only in the private JSON. Console
  contains a bounded summary with result, RPO risk, review count and duration.
  Do not cat/upload reports or their manual lists to public CI logs, tickets or
  telemetry. Reports still contain sensitive operational identifiers; restrict
  retention/access, encrypt off-host copies and review before sharing.
- Tokens, Session token hashes, passwords, database URLs, source business values,
  executor identities/error text and arbitrary subprocess columns are excluded.
  Whole-database/archive fingerprints are integrity evidence, not Session hashes.

## Interpreting manual review

The complete set covers nonterminal Jobs or nonterminal Attempts; terminal Job
history remains counted and unmodified. When no active Attempt exists, the latest
recorded one is supplied when available. At more than 10,000 items or an unsafe
assessment payload, the drill fails instead of truncating a successful report.

| Reason | Interpretation / Owner boundary |
| --- | --- |
| NO_ATTEMPT_NOT_STARTED | PENDING with no recorded Attempt. This says nothing about current Session/Dataset eligibility to run. |
| PREPARED_NOT_DISPATCHED | Persisted preparation, before dispatch; do not dispatch from the drill. |
| DISPATCH_OUTCOME_UNKNOWN | DISPATCHING may have crossed the external boundary. Preserve identity and use a separately approved supported recovery procedure. |
| ACCEPTED_EXECUTOR_STATE_UNAVAILABLE | Acceptance is persisted; current external execution/outcome cannot be recovered from the database alone. |
| DISPATCH_REJECTED_NOT_STARTED | Latest dispatch is recorded DISPATCH_FAILED; no automatic retry or reconstruction of lost identity-wide rejection memory. |
| NONTERMINAL_JOB_REQUIRES_REVIEW | Nonterminal Job without an active Attempt; preserve recorded history and investigate the combination. |

Reason codes are report classifications, not new Job/Attempt statuses, lifecycle
transitions, Run eligibility or executor truth. The tool never changes unknown
or nonterminal work to FAILED and never replays external side effects.

## RPO, RTO and recovery approval

Backup Age = host assessment time minus manifest.startedAt. startedAt is a
conservative earlier bound on the exported snapshot. It does not measure actual
lost production writes. Without an explicit target, targetRpoMs=null and result
NOT_CONFIGURED. WITHIN_TARGET compares age only; EXCEEDS_TARGET is an explicit
risk even when the technical drill is DRILL_VERIFIED. Actual Data Loss always
stays UNKNOWN; productionRpoAchieved=false.

Canonical ISO timestamps must be valid/ordered and not future-dated at drill
start/assessment. A reversed wall clock, reversed monotonic clock or more than
one second divergence from monotonic elapsed time invalidates the report, even
during report I/O. This detects clock inconsistency, not absolute UTC accuracy:
the Owner must maintain trusted clock synchronization. Do not edit a manifest or
silently clamp a negative age to obtain a passing RPO result.

serviceRecoveryTested=false, achievedRtoMs=null and productionRecoveryApproved=false
are unconditional. The measured drill duration is database validation evidence,
not achieved production RTO. Retrieval, host restoration, runtime/executor safety,
Session invalidation, data-loss decisions and authorized reopening need a
separate approved recovery plan and independently measured service recovery.

FakeExecutor's process memory is absent from the backup. A restored ACCEPTED or
DISPATCHING row does not recreate a fake run or rejection guarantee. Backend
startup still invalidates old Sessions; do not bypass it. Database Restore and
restoring users' calculation execution capability are different operations.
Core Unknown Outcome Recovery remains unchanged and is not invoked by this tool.

## Failed drills

Any integrity, restore, verification, assessment, clock, filesystem or cleanup
failure exits nonzero without DRILL_VERIFIED or a final successful report.
Incomplete owned workspace/report files are removed when safely possible.
Only exact-owned Docker resources are removed. Unconfirmed ownership, failed
Docker calls or failed cleanup require private manual investigation, not guessed
deletion, automatic restore, retry, redispatch, Backend restart or Web activation.
Preserve the original archive and last trusted report. Confirm image/source/
clock/storage health before a separately requested new drill.

If resource cleanup is unconfirmed, privately inspect Docker resources with
`cost-engine.restore.purpose=demo05d2`. A missing report is not proof of absence.
Match exact immutable IDs, nonce owner labels, network and the fresh Volume before
any separately approved manual cleanup. Never delete solely by a label/name,
prune shared Docker storage or infer production recovery approval from the drill.
