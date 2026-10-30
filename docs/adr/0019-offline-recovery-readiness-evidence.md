# ADR-0019 — Offline Recovery Readiness and Owner-attested Evidence

- Status: Accepted bounded System Owner specification; implementation awaits review.
- Baseline: PR #46 merged at `cdfa5670352d4feff268db25911739307f188bda`.
- Scope: Demo-05D-3C only; supplements 3A/3B without changing their success predicates.

## Decision

Assess local offline files without contacting PostgreSQL, Docker, storage services,
or a restore engine. Reuse 3A's exact Operational Manifest assertion and 3B's DTO,
RecoveryAssessment parser, clock and `assessRpo()`. Validate complete historical
Drill contracts, archive hashes and identity/version/fingerprint bindings. These
files must live in trusted Owner-controlled private stores. Local JSON does not
cryptographically attest the historical execution of an unsigned 3B report.

There is no trusted physical off-host fact derivable from an arbitrary JSON file.
Off-host READY therefore additionally requires an Owner review signed by an
Ed25519 key explicitly trusted in the policy. Evidence cannot nominate its own
key. The signature covers every envelope field except the signature itself,
including the original/retrieved archive SHA, exact Drill report SHA, opaque
storage reference, retrieval and review chronology, reviewer and review purpose.
The CLI verifies signatures only; signing, custody and approval of trusted public
keys remain separate Owner activities. No boolean assertion can grant trust.

This separates independently checked file bytes/contracts/signatures from the
Owner-attested physical location, retrieval provenance and use of that retrieved
copy in the bound actual Drill. The report explicitly discloses both scopes.
Protect the policy as carefully as the evidence: replacing an authorized key or
the whole trusted store defeats this offline trust boundary. This is an
operational review mechanism, not proof against a malicious System Owner.

## Evaluation and failure boundary

Three policy durations are mandatory, safe nonnegative integers with no defaults.
Each candidate recovery point must have its own current complete Drill evidence.
Local and off-host candidates are selected separately by conservative backup
`startedAt`; an undrilled new backup cannot refresh either verified point. An
off-host retrieval must precede its bound Drill and Owner review must follow the
completed Drill. Both retrieval and verification age must fit the off-host policy.
Re-signing old retrieval evidence does not refresh its retrieval age.

No verified point means NOT_VERIFIED. A verified point within target RPO means
READY; an old verified point means AT_RISK. Expired/invalid candidates are excluded
and recorded with fixed codes. RPO uses existing `assessRpo()`; actual data loss
is UNKNOWN. Readiness is about a database recovery point; production recovery
approval and service recovery tested remain false. No achieved production RTO
or automatic recovery is implied.

Unsafe/unreadable required roots/policy, I/O failures or global resource limits
abort publication. Individual missing/invalid candidates are recorded, never
silently trusted or truncated. Read-only source descriptors reject symlinks and
detect replacement/change during reads. File integrity uses a streamed full SHA
and custom archive header/size; actual restore validity comes from trusted bound
3B evidence, not a new restore. Owner must keep evidence stores stable during use.

Only an existing explicit private output root is writable. Random exclusive
0700 report directories, 0600 synced temporary files and atomic rename prevent
partial success and overwriting existing reports. Sources, backups and historical
reports are never modified or deleted. Limits and private-directory semantics
are documented in the runbook; Windows retains 3B's Owner-provisioned ACL trust.

## Alternatives

Accepting `ownerApproved=true` or a key embedded in evidence is self-attestation,
not trusted review. Accepting only an archive checksum cannot demonstrate restore
success. Restoring during assessment would duplicate 3B's engine and violate this
offline tool's scope. External PKI, remote storage verification and automatic
backup/restore scheduling remain outside this bounded requirement.
