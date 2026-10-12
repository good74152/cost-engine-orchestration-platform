# Task 007C — API Contract Hardening

- Status: Ready after 007A/007B concurrency risk classification.
- One bounded HTTP boundary / error-contract PR.
- Do not change accepted lifecycle transitions or successful response schemas.

## Goal

Reject malformed public input at HTTP boundaries before PostgreSQL, keep stable HTTP/business error codes, and ensure test/development-only FakeExecutor controls are not exposed in unintended environments.

## Existing surfaces

- POST /dataset-versions
- POST /dataset-versions/:datasetVersionId/submit-validation
- POST /dataset-versions/:datasetVersionId/publish
- POST /dataset-versions/:datasetVersionId/reject
- POST /dataset-versions/:datasetVersionId/abandon
- POST /calculation-jobs/:jobId/run
- POST /calculation-jobs/:jobId/reconcile
- POST /executor-callbacks/airflow
- POST /raw-ingestion-batches (retain)
- development/test-only POST /internal/fake-executor/executions/:dagRunId/{succeed,fail}

## Required changes

1. Add UUID shape validation for jobId on both Run and Reconcile routes. Invalid path input returns HTTP 400 with code INVALID_REQUEST. Unknown syntactically valid UUID continues to return 404 CALCULATION_JOB_NOT_FOUND. Validate before database use.

2. Reuse or align UUID parsing policy with the dataset lifecycle route where practical, but avoid an unrelated route framework/refactor. Add malformed UUID route tests including not-a-uuid and oversized identifiers.

3. Ensure callback request contains exactly airflowDagId and airflowDagRunId, both non-empty strings with explicit lengths compatible with stored VARCHAR(250) identity columns. Reject malformed, oversized, missing, extra-key, and wrong-type inputs as 400 INVALID_REQUEST. Do not permit callback-supplied status to bypass executor lookup.

4. Validate the currently supported raw-ingestion request body at runtime. Require known RAW domain identifier (FAB_COST_RAW/CAPEX_RAW/DPR_RAW) and nonempty businessKey within the VARCHAR(255) database boundary. Reject null, arrays, missing/extra keys, invalid types, invalid domain, empty/oversized businessKey before SQL. Preserve valid request semantics, domain values, response DTO, and concurrency behavior. Do not retire route/module.

5. Review internal FakeExecutor control route registration. Limit to explicitly designated development/test environment with an actual FakeExecutor, rather than relying only on not-production. Keep control routes absent under production or unknown/unapproved environment. Update .env.example/development documentation if explicit NODE_ENV=development is needed. Keep FakeExecutor unavailable in production. Preserve existing test-mode controls.

6. Maintain the actual shared public error envelope:
~~~json
{ "message": "Invalid request", "code": "INVALID_REQUEST" }
~~~
Do not change it globally to a nested error object or leak PostgreSQL constraint text. Any proposed breaking response change requires separate compatibility review.

7. Produce a route/error code coverage matrix from existing tests; add missing tests for actual documented codes. Distinguish normal validation errors (400), syntactically valid unknown resources (404), lifecycle conflicts (409), definite dispatch rejection (502), inconclusive executor status (503), and true invariant failure (500). Do not make an internal corruption case appear as a normal business conflict.

## Likely files

- src/modules/calculation-job.route.ts
- src/modules/dataset-version/dataset-version.route.ts (small shared validation extraction only if beneficial)
- src/modules/executor-callback.route.ts
- src/modules/raw-ingestion/raw-ingestion.route.ts
- src/app.ts and src/executors/executor-factory.ts if environment hardening is necessary
- .env.example
- scripts/* existing relevant route/PG test files

No schema migration or new production dependency.

## Required tests

- Run and Reconcile malformed UUID both return 400, never generic 500.
- Valid but unknown UUID both return 404 without mutation.
- Dataset lifecycle UUID validation remains green for all four routes.
- Callback invalid/oversized body returns 400 before DB lookup.
- Callback status cannot force local terminal state without executor confirmation.
- Raw ingestion malformed body 400; existing 20-request concurrency test stays green.
- Fake control routes: allowed explicit test/dev mode only, absent otherwise.
- Public error code matrix tests keep stable {message, code} envelope.
- Existing lifecycle PostgreSQL suites stay green.

## Non-goals

No execution-state refactor, cancellation, new read API, global framework swap, migration, dependency upgrades, or removal of raw ingestion.

## Acceptance

Every supported route handles ordinary malformed input without a PostgreSQL UUID/length/constraint error becoming a generic 500. No public successful DTO or state-machine behavior is changed. All added route-level contracts and existing PostgreSQL regression tests pass.
