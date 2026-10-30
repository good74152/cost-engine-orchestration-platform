# Recovery Readiness Runbook

Demo-05D-3C evaluates existing private local files. It performs no backup, restore,
database/network connection, Docker command, sync, scheduler, cleanup of sources,
Backend start or public activation. READY is not Production Recovery Approval.

## Prepare explicit policy and private stores

Use Node 24 and installed locked dependencies. Provide separate existing absolute
directories outside every Git repository for backup bundles, 3B reports, optional
off-host evidence and readiness reports. On POSIX directories must be owned by the
current user and exactly 0700; source JSON/archives must be owner-private regular
files (no group/other bits). On Windows, as in 3B, the System Owner must provision
equivalent restrictive ACLs; POSIX mode bits do not establish Windows privacy.
Do not use shared, mutable or untrusted locations. No source/output overlap is
allowed for the inventory directories. The read-only policy file may live in
their private parent; it does not require a separate directory. Keep sources
unchanged during assessment. No remote URL is accepted.

Backup layout: `BACKUPS/cost-engine-live-backup-…/{manifest.json,backup.dump}`.
Drill layout: `DRILLS/drill-<32 lowercase hex>/report.json`. Copy only completed
evidence into these inventories; incomplete workspaces produce rejection records.
Only OPERATIONAL manifests are accepted; first-deployment backups are not candidates.

The Owner-provided private policy file must contain exactly:

```json
{
  "formatVersion": 1,
  "targetRpoMs": 3600000,
  "maxDrillAgeMs": 604800000,
  "maxOffHostEvidenceAgeMs": 604800000,
  "trustedOffHostReviewers": []
}
```

These are examples, **not defaults or achieved objectives**. All three durations
must be explicitly set as safe nonnegative integer milliseconds. An empty reviewer
array disables trusted off-host review; it cannot produce Disaster READY. An
approved reviewer entry has exactly `keyId`, `reviewerId` (opaque ASCII aliases,
1–64 letters/digits/underscore/hyphen) and `publicKeyPem` (Ed25519 SPKI public PEM).
No private signing key goes into policy, evidence, repository, CLI arguments or
report. Owner verifies key provenance separately and protects the policy store.

## Establish trustworthy off-host evidence

The Owner retrieves the selected archive from separately managed off-host storage,
checks its full SHA against the original, and runs the existing **actual 3B Drill
on that retrieved copy**. Keep the Operational bundle and resulting private Drill
report in the assessment inventories. Preserve original backup identity and bytes.
Retrieval must be after backup completion and before the bound Drill begins.

An optional evidence directory contains `offhost-<32 lowercase hex>.json` envelopes
with exactly these fields (placeholder strings must be replaced):

```json
{
  "formatVersion": 1,
  "evidenceId": "offhost-<32 hex>",
  "backupId": "cost-engine-live-backup-<identity>",
  "originalSha256": "<64 lowercase hex>",
  "retrievedSha256": "<same archive SHA>",
  "retrievedAt": "2026-10-30T00:00:00.000Z",
  "storageReference": "owner-vault/media-001",
  "drillId": "drill-<32 hex>",
  "drillReportSha256": "<SHA-256 of exact report.json bytes>",
  "verifiedBy": "system-owner",
  "verifiedAt": "2026-10-30T00:03:00.000Z",
  "ownerReview": {
    "reviewId": "owner-review-<32 hex>",
    "keyId": "owner-2026",
    "reviewedAt": "2026-10-30T00:04:00.000Z",
    "purpose": "OFF_HOST_RETRIEVAL_AND_DRILL_REVIEW",
    "signature": "<canonical base64 Ed25519 signature, 64 bytes>"
  }
}
```

`verifiedBy` must match the trusted policy reviewer's ID for `keyId`. The Owner's
separate signing/review process signs UTF-8 recursively sorted-key compact JSON
of the entire envelope, omitting only `ownerReview.signature`. Array order is
preserved. The exported `offHostSigningPayload()` implements this serialization;
the CLI performs verification only. No key supplied inside evidence is accepted.
Review purpose attests physical off-host retrieval and the retrieved copy's use
in the hash-bound actual Drill. Review timestamp follows verification; verification
follows Drill completion. All times are canonical UTC ISO with milliseconds.

The storage reference is a non-secret opaque alias (1–128 ASCII letters, digits,
underscore, dot, slash or hyphen, beginning with a letter/digit/underscore/hyphen).
Do not use URLs, host credentials, access tokens, passwords or raw business data.
Only its SHA is included in the readiness report. Owner aliases and review IDs
are private metadata. Do not publish evidence or private reports in CI logs.

The tool independently verifies local bytes, hashes, contracts, chronology, policy
and authorized signature. **It cannot prove physical off-host location, retrieval
source, or historical Drill execution from local JSON.** These remain explicit
Owner-attested facts in trusted stores. Untrusted, self-signed, tampered, expired
or merely boolean approval evidence is never sufficient for Disaster READY.

## Execute assessment

```sh
sh deploy/scripts/recovery-readiness.sh \
  --backup-dir /private/backups \
  --drill-dir /private/drills \
  --policy-file /private/policy/recovery.json \
  --report-dir /private/readiness \
  --off-host-evidence-dir /private/offhost
```

Equivalent: `npm run demo:recovery-readiness -- <same flags>`. The off-host flag is
optional; the others are mandatory. Unknown/repeated flags, Database URLs and
restore targets are rejected. Environment database URLs are never consumed.

The only Console success is a bounded `READINESS_ASSESSED` summary with readiness
states/counts and approval/service flags. Exit zero means assessment publication,
**not necessarily READY**. Inspect the private JSON before making an operational
decision. A nonzero exit publishes no final report; diagnostics are fixed codes,
not source paths, identifiers or underlying filesystem errors.

Report: `REPORTS/readiness-<secure random 32 hex>/report.json`. A newly exclusive
0700 directory and synced 0600 temporary file precede atomic rename. Reports never
overwrite previous IDs. No absolute source path, manual Job/Attempt list, token,
Session token hash, password or Database URL is copied. Archive/data **digests**
are evidence references, not Session token hashes. Report metadata is private.

## Interpret the three inventories

- `latestSuccessfulBackup`: full archive SHA/size/header and valid OPERATIONAL
  metadata. This alone is not a verified recovery point.
- `latestLocalRestoreVerifiedBackup`: newest backup with its own valid current
  3B Drill and matching archive, version, migrations, fingerprints and counts.
- `latestOffHostRestoreVerifiedBackup`: newest backup with trusted current signed
  retrieval/review and a matching current actual Drill. It can be older than the
  local point; its age is calculated independently from its own `startedAt`.

Both states use READY / AT_RISK / NOT_VERIFIED. No current trusted point means
NOT_VERIFIED. Valid current evidence but backup age over target means AT_RISK.
Within target means READY within the explicitly stated database-point scope.
Latest selection orders backup `startedAt`, then completion/ID deterministically;
a newly created undrilled backup cannot replace an older drilled point. The
reported `assessedAt` is the UTC reference after inventory I/O; freshness/RPO
therefore include time spent hashing archives. Monotonic/wall
clock anomalies abort publication. Use a trusted synchronized host clock; offline
code cannot independently authenticate UTC against a time authority.

Drill freshness uses completion time. Off-host freshness checks both retrieval
and verification age, so new review cannot refresh an old retrieval. No future,
invalid, reversed time or negative/unsafe policy duration is accepted. Reuse of
3B's `assessRpo()` preserves conservative `startedAt` snapshot age. Actual data
loss remains UNKNOWN; achieved production RPO/RTO are not asserted. Pending/
unknown work in a trusted Drill remains human recovery work, never redispatched.

Fixed state reason codes: `VERIFIED_RECOVERY_POINT_WITHIN_RPO`,
`RECOVERY_POINT_EXCEEDS_RPO`, `NO_VALID_OPERATIONAL_BACKUP`,
`NO_CURRENT_RESTORE_DRILL`, `RESTORE_DRILL_EXPIRED`,
`LATEST_SUCCESSFUL_BACKUP_NOT_RESTORE_VERIFIED`,
`OFF_HOST_EVIDENCE_NOT_PROVIDED`, `NO_TRUSTED_OFF_HOST_EVIDENCE`,
`OFF_HOST_EVIDENCE_EXPIRED`. All invalid/expired candidates have individual
`evidenceIssues` with fixed codes and bounded references. `evidenceReferences`
lists the exact hashes of every valid backup, Drill and Owner-reviewed envelope,
including stale history, rather than retaining only the selected point. Rejected arbitrary
filenames are represented by a name SHA, never echoed. Retained invalid history
does not invalidate an independently sound selected point; it is always disclosed.

## Failure, limits and recovery boundary

Missing/malformed candidate files, bad SHA/bindings, invalid times or untrusted
signatures exclude that candidate and are reported. Missing/unsafe required roots
or policy, unreadable required I/O, resource exhaustion, clock anomaly or output
failure abort the entire assessment and publish no final report. Inspect private
stores, resolve the cause and explicitly rerun; there is no automatic retry.
Known partial output from this invocation alone is removed; replaced/unknown
resources are left for Owner inspection. Source backups/reports are untouched.

One invocation has fixed safety limits: 1,000 total inventory entries, 32 MiB
total JSON, 64 KiB manifest/policy, 8 MiB Drill report, 32 KiB off-host envelope,
16 trusted reviewer keys, 64 GiB per archive, 256 GiB total archives. Archives
are streamed in 64 KiB chunks. 3B's 10,000-item complete manual-review parser
remains in use; identifiers are discarded after validation. Limits fail explicitly
rather than truncate. Curate a smaller **separately prepared complete assessment
inventory** under Owner policy when necessary; do not weaken checks or delete
history automatically. File SHA/header proves file integrity, not a fresh restore;
only bound trusted actual 3B evidence establishes historical restore validation.

Database restoration and user execution recovery remain separate. This CLI cannot
approve a production restore, recover FakeExecutor memory, bypass Session
invalidation, resolve Unknown Outcome, rerun Jobs, restart Backend or activate Web.
Keep [the 3B recovery runbook](RECOVERY_DRILL.md) and explicit Owner recovery
authorization as separate requirements.
