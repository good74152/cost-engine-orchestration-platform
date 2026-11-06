# Cost Engine Orchestration Platform

A backend that keeps versioned financial report builds in sync with external jobs, so lost responses, failed jobs and conflicting requests don't corrupt what gets published.

**Live demo: [cost-engine.ichiaho.dev](https://cost-engine.ichiaho.dev)** (no sign-up; hosted on one 2 GiB DigitalOcean Droplet)

This is a portfolio implementation, not a copy of a former employer's system. **Tracking, database state and recovery are real. The jobs are simulated:** there is no real Airflow integration and no financial calculation.

![The demo page in manual mode, showing dataset versions, calculation jobs and execution attempts](docs/images/demo-ui/manual-mode.png)

## The problem

| What can go wrong | What the system does |
|---|---|
| Two requests create the same report at once | A row lock orders them. One creates the version; the other gets `409`. |
| Upstream data changes during a build | The first Run freezes inputs. Every job and retry in that version uses them. |
| A job starts, but its response is lost | The try stays open and keeps its saved run ID, so recovery checks the same run. |
| A job fails | A retry adds a new try on the same inputs. The failure stays on record. |
| Publish and Reject race | Exactly one wins. Terminal history is never rewritten. |

Avoiding a duplicate run also needs the job system to honor the run ID. The simulator does; a real one must too.

The data model has four levels:

```text
dataset_series → dataset_version → calculation_job → execution_attempt
```

## System architecture

![Browser to Caddy to a Fastify backend to PostgreSQL, with a simulated job system](docs/diagrams/architecture.svg)

## System flow

![Create, first run, dispatch, reconcile and submit, ending in published or rejected](docs/diagrams/system-flow.svg)

A DRAFT or BUILDING version can also be abandoned when it has no open try.

## Engineering flows

![Two requests lock one series row. One creates the version; the other gets 409](docs/diagrams/flows/task-002-dataset-creation.svg)

![First Run freezes upstream versions for every job and retry in that version](docs/diagrams/flows/task-003-immutable-snapshot.svg)

![When a response is lost, the try stays open and recovery reuses the same run ID](docs/diagrams/flows/task-004-execution-dispatch.svg)

![Reconcile asks the job system outside a transaction, then saves the result or changes nothing](docs/diagrams/flows/task-005-executor-reconciliation.svg)

![Draft to building to validating, ending in published or rejected, or abandoned earlier](docs/diagrams/flows/task-006-dataset-lifecycle.svg)

Implementation details are in [Engineering Flows](docs/ENGINEERING_FLOWS.md).

## Limits

- Only a simulated executor exists. Its memory is lost on restart, so a restart ends demo sessions.
- One backend instance. No queue, background reconciliation, automatic publication or downstream triggers.
- Abandon does not cancel external work.
- No production authentication. The demo uses anonymous session cookies and basic rate limits.

## Run locally

Requires Node.js 24+, npm and Docker Compose. Create `.env` from [.env.example](.env.example) and replace the example credentials.

```bash
npm ci && npm --prefix frontend ci
docker compose up -d postgres_db

# Use your .env values.
export DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/DATABASE
export DEMO_SEED_DATABASE_URL=$DATABASE_URL
export APP_MODE=demo NODE_ENV=development EXECUTOR_TYPE=fake

npm run migrate -- up
npm run seed:demo-six-domain
npm run dev
```

In a second terminal, run `npm run ui:dev` and open http://127.0.0.1:5173.

## Tests

Point `TEST_DATABASE_URL` at a disposable PostgreSQL service that can create databases. Never use production.

```bash
npm run build && npm run test:milestone   # Core lifecycle, locks and concurrency on real PostgreSQL
npm run ui:test                           # Frontend unit tests
npm run ui:smoke                          # Real Chromium, production bundle, CSP and PostgreSQL
```

## More

Start with the [documentation guide](docs/README.md). Stack: TypeScript, Node.js 24, Fastify, PostgreSQL 18, React, PrimeReact, Caddy, Docker Compose and GitHub Actions.
