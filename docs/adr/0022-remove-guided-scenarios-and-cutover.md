# ADR-0022 — Remove Guided Scenarios and Cutover

- Status: Accepted. Supersedes ADR-0011, ADR-0012, ADR-0017 and ADR-0018.
- Scope: Demo mode only. Dataset, job and attempt lifecycle, locking and recovery are unchanged.

## Context

Guided scenarios were a backend-driven tutorial with a durable step ledger. [ADR-0020](0020-one-page-demo-ui.md) replaced them: the page now plays its scenarios through the same `/demo/*` APIs a viewer uses by hand. Nothing called the Guided APIs anymore, but they still shaped the code. Every Demo mutation had to check for a running scenario.

The admission gate and cutover existed to move a live database from the Guided configuration to the workflow configuration without losing work. No such database exists. The demo has never been deployed, and its data is disposable. So every install paid for a one-way migration protecting nothing: seed the old configuration, drain, then cut over.

## Decision

- Delete the Guided APIs, the admission gate and the cutover operators.
- The seed writes the final configuration directly: ten types in six domains, each with one published definition.
- `DEMO_GUIDED_SUMMARY` becomes `DEMO_CAPEX_SUMMARY`, and it now requires `FAB_COST` from its first definition.
- Backend startup checks that the database holds exactly that configuration. A ready Backend therefore implies a valid configuration, so `open-web.sh` no longer needs its own status check or approval flag.
- A forward migration drops the tables and functions. It is irreversible by design: the rows are disposable, and the code that used them is gone. Applied migrations stay untouched.
- Keep one workflow template, because the page reads the upstream map from it.

## Consequences

- A database from before this change needs a fresh install, because its CAPEX definition history no longer matches. No deployed database exists, and local data is disposable.
- Definition versioning is still real and tested, as dependency definitions pin to jobs. It's just no longer exercised by a cutover.
- Changing the demo's configuration later means a new install or a reviewed migration. There's no live reconfiguration path.
- The history remains in Git and in the applied migrations.
