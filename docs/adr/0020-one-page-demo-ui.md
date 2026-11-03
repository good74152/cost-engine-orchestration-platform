# ADR-0020 — One-Page Demo UI and Scenario Playback

- Status: Accepted specification; implementation requires System Owner review.
- Date: 2026-11-02
- Authority: System Owner's Demo-06 decisions.
- Supplements: ADR-0013 (static CSP), ADR-0015 (session gate), ADR-0016 (request-scoped simulation),
  ADR-0018 (Workflow cutover). Core locking, lifecycle and recovery rules are unchanged.

## Context

The public interview acceptance found the backend evidence ready and the first-time experience not ready.
A visitor saw a false "session expired" error, a successful first publish took 30 actions across five pages,
and frozen inputs and run identity were not visible. A recruiter will not get that far.

## Decision

1. **One page.** Replace the Dashboard, Workflow Explorer, Guided, Free Exploration, Resources and About
   pages with one page and no client routing. [ADR-0022](0022-remove-guided-scenarios-and-cutover.md) later removed the backend Guided APIs.
2. **Scenario playback in the browser.** Four scenarios play explicit calls to the existing `/demo/*` APIs,
   one click at a time or all at once. There is no new endpoint, worker or server-side state.
   This replaces the Demo-05C-3C rule that the UI never sends more than one command per click.
   A page load still sends GETs only, and commands never retry automatically.
3. **Report what the backend returned.** Every summary is computed from real replies. A reply that differs
   from what a scenario expects stops playback and is shown as-is.
4. **Frozen inputs on Demo dataset reads.** List and detail reads add `frozenInputs`, each item naming only
   `domain`, `fiscalYear`, `period` and `version`. This narrows the Demo-02A rule that dataset reads expose
   nothing about upstream data. IDs, company code and execution identity stay out. Run ID is shown from the
   existing Run reply, so read DTOs still expose no DAG or run identity.
5. **PrimeReact 10 in unstyled mode, version pinned.** DataView lists the scenarios. One OrganizationChart maps
   the six reports, and a second shows `series → version → job → attempt` for the selected report. Dialog handles
   messages. One static stylesheet supplies all visuals.
6. **CSP stays without `unsafe-inline`.** PrimeReact injects a fixed `<style>` block and empty ones even when
   unstyled. `style-src` allows exactly those two SHA-256 hashes. The browser test runs the production bundle
   under the policy read from `deploy/Caddyfile`, so a version that changes them fails CI.

## The workflow map

The map comes from the prerequisites in the existing `SIX_DOMAIN_WORKFLOW` template, so the frontend doesn't define
the pipeline. Before a session exists that API can't be read, so the page shows the same shape from a constant.
The browser test fails if the two differ. This stays a demo view: the platform remains generic across domains.

## Dialog scope

A Dialog appears for a finished scenario, an unexpected error, the Lost Response decision, box details and the
explanations behind the page's blocks. Limits stay one click away, and the first screen still says the jobs are simulated.
Step success changes the chart and the status line instead, because a scenario sends up to about 40 commands.
HTTP 409 in the conflict scenario is the expected result, so it is reported as a result, not an error.

## Alternatives

| Alternative | Why not |
|---|---|
| PrimeReact 11 | Not MIT. Needs a license key, and a missing key can show a notice on a public page. |
| PrimeReact 10 with a bundled theme | Its injected styles need `unsafe-inline`, and it looks like an admin back office. |
| `style-src 'unsafe-inline'` | Weakens ADR-0013 to save three hashes. |
| Hand-written chart and dialog | Workable, but the System Owner prefers PrimeReact and this costs little. |
| A backend scenario endpoint | Adds server state to demonstrate behavior the existing APIs already have. |
| Automatic downstream triggers | A new subsystem (workers, duplicate triggers, retries). Listed as future work. |

## Consequences

- The bundle is about 212 KB of gzipped JavaScript, after Demo-09 added DataTable and Dropdown.
- A browser cannot prove requests overlapped. The conflict scenario says so and links to the PostgreSQL test.
- The session gate admits four Parallel requests, so that scenario sends four, not the test's twenty.
- Reloading during playback keeps saved data but ends the run. An open attempt stays visible as DISPATCHING.
- Scenarios stay scripted. [Demo-09](../tasks/demo-09-manual-mode.md) adds a manual mode for sending commands by hand, using the same APIs and holding no lifecycle rule in the page.
- Updating PrimeReact means re-checking the CSP hashes. The browser test reports any mismatch.

## Truth boundary

The page separates past production work ("Then") from this implementation ("Now") and uses generic wording.
Locking inputs is labeled as a design added for this project. Playback is a UI convenience, not backend
automation, and must not be described as a workflow engine.
