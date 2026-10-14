# Task 007C — Public API Error Contract Coverage

Baseline: `main` 273eac6bf1931cbccc53a5eacc1595bc41df08ed.
Status: **Coverage inventory and test additions; runtime verification pending.**

## Scope and response envelope

All application-handled errors use the existing flat `{ "message": string, "code": string }` envelope. Ordinary malformed input must not expose SQLSTATE, PostgreSQL constraints, query text, or credentials. An impossible persistence invariant remains `500 INTERNAL_SERVER_ERROR`, not a business conflict. Unregistered routes use Fastify's default 404 and are verified as **absent**, not reclassified as a domain error.

Routes: `POST /dataset-versions`, four `POST /dataset-versions/:datasetVersionId/{submit-validation,publish,reject,abandon}`, `POST /calculation-jobs/:jobId/{run,reconcile}`, `POST /executor-callbacks/airflow`, `POST /raw-ingestion-batches`, and the development/test-only fake executor controls.

## Actual error codes, source, and route test coverage

| Route/source | Trigger | HTTP / public code | Existing route-level tests | Task 007C added tests |
|---|---|---|---|---|
| Dataset create | Invalid JSON shape/type/keys | 400 `INVALID_REQUEST` | `dataset-version-creation-v2` | — |
| Dataset create | Unsupported domain | 400 `INVALID_DOMAIN` | `dataset-version-creation-v2` | — |
| Dataset create | Unsupported reporting period | 400 `INVALID_PERIOD` | `dataset-version-creation-v2` | — |
| Dataset lifecycle | Malformed datasetVersionId | 400 `INVALID_REQUEST` | `dataset-version-terminal-lifecycle` | All four routes retain 400 |
| Dataset lifecycle | Well-formed unknown version | 404 `DATASET_VERSION_NOT_FOUND` | `dataset-version-terminal-lifecycle` | All four routes retain 404 |
| Dataset create | Active version already exists | 409 `ACTIVE_DATASET_VERSION_EXISTS` | `dataset-version-creation-v2`, `dataset-version-terminal-lifecycle` | — |
| Dataset create | Domain lacks active calculation types | 409 `CALCULATION_TYPE_NOT_CONFIGURED` | `dataset-version-creation-v2` | — |
| Submit Validation | Jobs not all SUCCEEDED | 409 `DATASET_NOT_READY_FOR_VALIDATION` | `dataset-version-terminal-lifecycle` | — |
| Abandon | PREPARED / DISPATCHING / ACCEPTED attempt | 409 `DATASET_HAS_ACTIVE_EXECUTION` | `dataset-version-terminal-lifecycle` | — |
| Publish/Reject/Abandon | Invalid source or competing terminal decision | 409 `STATE_CONFLICT` | `dataset-version-terminal-lifecycle` | — |
| Job Run/Reconcile | Malformed jobId | 400 `INVALID_REQUEST` | **Gap** | Both paths; short, invalid, oversized identifiers |
| Job Run/Reconcile | Well-formed unknown jobId | 404 `CALCULATION_JOB_NOT_FOUND` | `execution-attempt-dispatch-fake-executor`, `executor-reconciliation` | Both paths |
| Job Run | Frozen definition not published/ready | 409 `DEPENDENCY_DEFINITION_NOT_READY` | `execution-attempt-dispatch-fake-executor` | — |
| Job Run | Required published upstream unavailable | 409 `DEPENDENCY_NOT_READY` | `execution-attempt-dispatch-fake-executor` | — |
| Job Run | Dataset/job not runnable | 409 `JOB_NOT_RUNNABLE` | `execution-attempt-dispatch-fake-executor`, `dataset-version-terminal-lifecycle` | — |
| Job Reconcile / Callback | Attempt identity does not exist | 404 `EXECUTION_ATTEMPT_NOT_FOUND` | `executor-reconciliation` | Callback exact 250-char unknown identities |
| Job Reconcile / Callback | No reconcilable execution | 409 `EXECUTION_NOT_RECONCILABLE` | `executor-reconciliation` | — |
| Job Run | Executor confirms permanent rejection | 502 `EXECUTOR_DISPATCH_FAILED` | `execution-attempt-dispatch-fake-executor` | — |
| Job Reconcile / Callback | Executor status unavailable | 503 `EXECUTOR_STATUS_UNAVAILABLE` | `executor-reconciliation` | — |
| Executor callback | Invalid body, keys, types, empty or oversized identity | 400 `INVALID_REQUEST` | `executor-reconciliation` (partial) | Null, array, missing/extra fields, invalid types, 251-char boundary, forged status |
| Fake controls (test/development only) | Valid route; unknown dag run identity | 404 `FAKE_EXECUTION_NOT_FOUND` | `executor-reconciliation` | Environment registration matrix |
| Raw ingestion | Invalid body/domain/businessKey length | 400 `INVALID_REQUEST` | **Gap** | Body shape, 255/256-char boundary, no mutation |
| Raw ingestion | Concurrent active batch | 409 `ACTIVE_RAW_INGESTION_BATCH_EXISTS` | `raw-ingestion` | Rechecked on isolated migrated PG with 20 requests |
| App error handler | Impossible internal lifecycle/invariant corruption | 500 `INTERNAL_SERVER_ERROR` | `executor-reconciliation`, `dataset-version-terminal-lifecycle`, `task-007b1-late-dispatch-reconciliation` | — |

**Suite shorthand:** Values above are npm script suffixes after `test:`, except `dataset-version-creation-v2` etc. Source-coverage assessment is from checked-in assertions, **not a claim that suites were executed in Task 007C**.

## Boundary/compatibility notes

- Job UUID validation matches the dataset lifecycle 8-4-4-4-12 hexadecimal UUID-shape policy. The existing distinct `404` domain error is unchanged.
- Callback body must contain exactly `airflowDagId` and `airflowDagRunId`, with 1–250 characters each. Callback-supplied executor status is never treated as authoritative.
- Raw-ingestion accepted domains: `FAB_COST_RAW`, `CAPEX_RAW`, `DPR_RAW`. The existing successful `201` DTO and allocation transaction are unchanged.
- Fake controls require an actual `FakeExecutor` **and** explicitly approved `development` or `test` environment. Conflicting runtime `NODE_ENV` wins fail-closed over injected options. Production also retains its existing explicit factory rejection error.
- No Task 007D end-to-end runner, Task 007E cleanup, schema migration, dependency upgrade, or state-machine/locking change was introduced.

## Verification gate

Run `npm run build`, `npm run test:task-007c-api-contract`, all required Task 002–007B PostgreSQL suites, `npm run test:raw-ingestion` against an isolated **disposable** database, and `git diff --check`. Record exact exit codes, Node/PostgreSQL versions and pass/fail/skip counts before human approval. `test:raw-ingestion` itself does not create/drop a test database; set `DATABASE_URL` to an explicitly owned disposable migrated database before running it.
