import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';
import type {
  CalculationExecutor,
  DispatchCalculationCommand,
  DispatchResult,
  ExecutionIdentity,
  ExecutorExecutionStatus,
} from '../src/executors/calculation-executor.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL must point to PostgreSQL');
}

interface Scenario {
  datasetVersionId: string;
  jobId: string;
}

interface LocalState {
  datasetStatus: string;
  jobStatus: string;
  snapshotId: string;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    airflowDagId: string;
    airflowDagRunId: string;
    acceptedAt: Date | null;
    finishedAt: Date | null;
  }>;
}

type BuildApp = (options: {
  logger: boolean;
  calculationExecutor: CalculationExecutor;
  nodeEnvironment?: string;
}) => Promise<FastifyInstance>;

function parseDatabaseUrl(value: string): URL {
  return new URL(value);
}

function assertSafeDatabaseName(name: string): void {
  assert.match(name, /^executor_reconciliation_test_[a-z0-9_]+$/);
  assert.ok(name.length <= 63);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function urlForDatabase(name: string): string {
  assertSafeDatabaseName(name);
  const url = parseDatabaseUrl(sourceDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function maintenanceDatabaseUrl(): string {
  const url = parseDatabaseUrl(sourceDatabaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function createTemporaryDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceDatabaseUrl() });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`);
  } finally {
    await client.end();
  }
}

async function dropTemporaryDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceDatabaseUrl() });
  try {
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

async function migrateFreshDatabase(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIRECTORY,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    singleTransaction: true,
    checkOrder: true,
    logger: {
      debug: (_message: string) => undefined,
      info: (_message: string) => undefined,
      warn: (_message: string) => undefined,
      error: (_message: string) => undefined,
    },
  });
}

async function resetOrchestrationData(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE TABLE dataset_series, calculation_types CASCADE');
}

async function createScenario(
  pool: Pool,
  createDatasetVersion: (input: {
    domain: 'DPR';
    companyCode: string;
    fiscalYear: number;
    period: 'Q3';
  }) => Promise<{
    datasetVersionId: string;
    calculationJobs: Array<{ jobId: string }>;
  }>,
): Promise<Scenario> {
  const calculationTypeId = randomUUID();
  await pool.query(
    `INSERT INTO calculation_types (
       id, domain, code, airflow_dag_id, is_active,
       last_allocated_dependency_definition_version
     ) VALUES ($1, 'DPR', 'RECONCILE_TEST', 'dag_reconcile_test', TRUE, 1)`,
    [calculationTypeId],
  );
  await pool.query(
    `INSERT INTO execution_dependency_definition_versions (
       id, calculation_type_id, version, status, published_at
     ) VALUES ($1, $2, 1, 'PUBLISHED', NOW())`,
    [randomUUID(), calculationTypeId],
  );
  const output = await createDatasetVersion({
    domain: 'DPR',
    companyCode: 'TW01',
    fiscalYear: 2026,
    period: 'Q3',
  });
  return {
    datasetVersionId: output.datasetVersionId,
    jobId: output.calculationJobs[0]!.jobId,
  };
}

async function withApp<T>(
  buildApp: BuildApp,
  executor: CalculationExecutor,
  action: (app: FastifyInstance) => Promise<T>,
  nodeEnvironment = 'test',
): Promise<T> {
  const app = await buildApp({
    logger: false,
    calculationExecutor: executor,
    nodeEnvironment,
  });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

async function postRun(app: FastifyInstance, jobId: string) {
  return app.inject({ method: 'POST', url: `/calculation-jobs/${jobId}/run` });
}

async function postReconcile(app: FastifyInstance, jobId: string) {
  return app.inject({
    method: 'POST',
    url: `/calculation-jobs/${jobId}/reconcile`,
  });
}

async function postCallback(
  app: FastifyInstance,
  identity: ExecutionIdentity & Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/executor-callbacks/airflow',
    payload: identity,
  });
}

async function readLocalState(pool: Pool, scenario: Scenario): Promise<LocalState> {
  const dataset = await pool.query<{ status: string }>(
    'SELECT status FROM dataset_versions WHERE id = $1',
    [scenario.datasetVersionId],
  );
  const job = await pool.query<{ status: string }>(
    'SELECT status FROM calculation_jobs WHERE id = $1',
    [scenario.jobId],
  );
  const snapshot = await pool.query<{ id: string }>(
    'SELECT id FROM dataset_build_snapshots WHERE dataset_version_id = $1',
    [scenario.datasetVersionId],
  );
  const attempts = await pool.query<{
    id: string;
    attempt_number: number;
    status: string;
    airflow_dag_id: string;
    airflow_dag_run_id: string;
    accepted_at: Date | null;
    finished_at: Date | null;
  }>(
    `SELECT
       id, attempt_number, status, airflow_dag_id, airflow_dag_run_id,
       accepted_at, finished_at
     FROM execution_attempts
     WHERE calculation_job_id = $1
     ORDER BY attempt_number`,
    [scenario.jobId],
  );
  return {
    datasetStatus: dataset.rows[0]!.status,
    jobStatus: job.rows[0]!.status,
    snapshotId: snapshot.rows[0]!.id,
    attempts: attempts.rows.map((attempt) => ({
      id: attempt.id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      airflowDagId: attempt.airflow_dag_id,
      airflowDagRunId: attempt.airflow_dag_run_id,
      acceptedAt: attempt.accepted_at,
      finishedAt: attempt.finished_at,
    })),
  };
}

function identityOf(attempt: LocalState['attempts'][number]): ExecutionIdentity {
  return {
    airflowDagId: attempt.airflowDagId,
    airflowDagRunId: attempt.airflowDagRunId,
  };
}

async function createAcceptedRun(
  buildApp: BuildApp,
  fake: FakeExecutor,
  scenario: Scenario,
): Promise<void> {
  await withApp(buildApp, fake, async (app) => {
    const response = await postRun(app, scenario.jobId);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().attemptStatus, 'ACCEPTED');
  });
}

class BlockingStatusExecutor implements CalculationExecutor {
  private enter!: () => void;
  private release!: (status: ExecutorExecutionStatus) => void;
  readonly entered = new Promise<void>((resolve) => {
    this.enter = resolve;
  });
  private readonly released = new Promise<ExecutorExecutionStatus>((resolve) => {
    this.release = resolve;
  });

  async dispatch(_command: DispatchCalculationCommand): Promise<DispatchResult> {
    return { kind: 'ACCEPTED' };
  }

  async getExecutionStatus(_identity: ExecutionIdentity): Promise<ExecutorExecutionStatus> {
    this.enter();
    return this.released;
  }

  returnStatus(status: ExecutorExecutionStatus): void {
    this.release(status);
  }
}

test(
  'executor reconciliation PostgreSQL integration and concurrency',
  { concurrency: false },
  async (t) => {
    const databaseName = [
      'executor_reconciliation_test',
      process.pid.toString(36),
      randomUUID().replaceAll('-', '').slice(0, 16),
    ].join('_');
    const databaseUrl = urlForDatabase(databaseName);
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let applicationPool: Pool | undefined;

    await createTemporaryDatabase(databaseName);
    try {
      await migrateFreshDatabase(databaseUrl);
      process.env.DATABASE_URL = databaseUrl;
      const [{ pool }, appModule, datasetVersionModule, preparationModule] = await Promise.all([
        import('../src/db/pool.js'),
        import('../src/app.js'),
        import('../src/modules/dataset-version/dataset-version.service.js'),
        import('../src/modules/calculation-job-preparation.service.js'),
      ]);
      applicationPool = pool;
      const buildApp = appModule.buildApp as BuildApp;
      const createDatasetVersion = datasetVersionModule.createDatasetVersionService;
      const prepare = preparationModule.prepareCalculationJobRunService;

      await t.test('ACCEPTED + RUNNING is an idempotent manual reconciliation', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const before = await readLocalState(pool, scenario);
        await withApp(buildApp, fake, async (app) => {
          const response = await postReconcile(app, scenario.jobId);
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().executorStatus, 'RUNNING');
          assert.equal(response.json().attemptStatus, 'ACCEPTED');
          assert.equal(response.json().jobStatus, 'RUNNING');
        });
        assert.deepEqual(await readLocalState(pool, scenario), before);
      });

      await t.test('fake SUCCEEDED control changes only external state until reconciliation', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const accepted = await readLocalState(pool, scenario);
        const attempt = accepted.attempts[0]!;
        await withApp(buildApp, fake, async (app) => {
          const controlled = await app.inject({
            method: 'POST',
            url: `/internal/fake-executor/executions/${attempt.airflowDagRunId}/succeed`,
          });
          assert.equal(controlled.statusCode, 200);
          assert.equal(controlled.json().state, 'SUCCEEDED');
          assert.deepEqual(await readLocalState(pool, scenario), accepted);

          const reconciled = await postReconcile(app, scenario.jobId);
          assert.equal(reconciled.statusCode, 200);
          assert.equal(reconciled.json().attemptStatus, 'SUCCEEDED');
          assert.equal(reconciled.json().jobStatus, 'SUCCEEDED');
          assert.equal(reconciled.json().datasetStatus, 'BUILDING');
        });
        const terminal = await readLocalState(pool, scenario);
        assert.equal(terminal.datasetStatus, 'BUILDING');
        assert.equal(terminal.jobStatus, 'SUCCEEDED');
        assert.equal(terminal.attempts[0]!.status, 'SUCCEEDED');
        assert.ok(terminal.attempts[0]!.finishedAt);
      });

      await t.test('fake FAILED control changes only external state until callback reconciliation', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const accepted = await readLocalState(pool, scenario);
        const attempt = accepted.attempts[0]!;
        await withApp(buildApp, fake, async (app) => {
          const controlled = await app.inject({
            method: 'POST',
            url: `/internal/fake-executor/executions/${attempt.airflowDagRunId}/fail`,
          });
          assert.equal(controlled.statusCode, 200);
          assert.equal(controlled.json().state, 'FAILED');
          assert.deepEqual(await readLocalState(pool, scenario), accepted);

          const reconciled = await postCallback(app, identityOf(attempt));
          assert.equal(reconciled.statusCode, 200);
          assert.equal(reconciled.json().attemptStatus, 'FAILED');
          assert.equal(reconciled.json().jobStatus, 'FAILED');
          assert.equal(reconciled.json().datasetStatus, 'BUILDING');
        });
      });

      await t.test('DISPATCHING recovers directly to RUNNING, SUCCEEDED, and FAILED', async () => {
        for (const target of ['RUNNING', 'SUCCEEDED', 'FAILED'] as const) {
          await resetOrchestrationData(pool);
          const scenario = await createScenario(pool, createDatasetVersion);
          const fake = new FakeExecutor({ defaultBehavior: 'ACCEPT_THEN_UNKNOWN' });
          await withApp(buildApp, fake, async (app) => {
            const ambiguous = await postRun(app, scenario.jobId);
            assert.equal(ambiguous.statusCode, 202);
            const identity = {
              airflowDagId: ambiguous.json().airflowDagId,
              airflowDagRunId: ambiguous.json().airflowDagRunId,
            };
            assert.equal(fake.setExecutionState(identity, target), true);

            const reconciled = await postReconcile(app, scenario.jobId);
            assert.equal(reconciled.statusCode, 200);
            assert.equal(reconciled.json().executorStatus, target);
            assert.equal(
              reconciled.json().attemptStatus,
              target === 'RUNNING' ? 'ACCEPTED' : target,
            );
            assert.equal(
              reconciled.json().jobStatus,
              target === 'RUNNING' ? 'RUNNING' : target,
            );
            assert.equal(reconciled.json().executionAttemptId, ambiguous.json().executionAttemptId);
          });
          const state = await readLocalState(pool, scenario);
          assert.equal(state.attempts.length, 1);
          assert.equal(state.datasetStatus, 'BUILDING');
          assert.ok(state.attempts[0]!.acceptedAt);
          if (target !== 'RUNNING') {
            assert.ok(state.attempts[0]!.finishedAt);
          }
        }
      });

      await t.test('executor UNAVAILABLE preserves ACCEPTED and DISPATCHING states', async () => {
        for (const dispatchBehavior of ['ACCEPT', 'ACCEPT_THEN_UNKNOWN'] as const) {
          await resetOrchestrationData(pool);
          const scenario = await createScenario(pool, createDatasetVersion);
          const fake = new FakeExecutor({ defaultBehavior: dispatchBehavior });
          await withApp(buildApp, fake, async (app) => {
            await postRun(app, scenario.jobId);
            const before = await readLocalState(pool, scenario);
            fake.setStatusLookupUnavailable('temporary fake outage');
            const response = await postReconcile(app, scenario.jobId);
            assert.equal(response.statusCode, 503);
            assert.equal(response.json().code, 'EXECUTOR_STATUS_UNAVAILABLE');
            assert.deepEqual(await readLocalState(pool, scenario), before);
            assert.equal(fake.getExternalExecutions().length, 1);
          });
        }
      });

      await t.test('executor NOT_FOUND preserves ACCEPTED and DISPATCHING without DISPATCH_FAILED', async () => {
        for (const localStatus of ['DISPATCHING', 'ACCEPTED'] as const) {
          await resetOrchestrationData(pool);
          const scenario = await createScenario(pool, createDatasetVersion);
          const fake = new FakeExecutor();
          const prepared = await prepare(scenario.jobId);
          await pool.query(
            `UPDATE execution_attempts
             SET status = $2::varchar,
                 dispatch_started_at = NOW(),
                 accepted_at = CASE WHEN $2::varchar = 'ACCEPTED' THEN NOW() END
             WHERE id = $1`,
            [prepared.executionAttemptId, localStatus],
          );
          if (localStatus === 'ACCEPTED') {
            await pool.query(
              "UPDATE calculation_jobs SET status = 'RUNNING', started_at = NOW() WHERE id = $1",
              [scenario.jobId],
            );
          }
          const before = await readLocalState(pool, scenario);
          await withApp(buildApp, fake, async (app) => {
            const response = await postReconcile(app, scenario.jobId);
            assert.equal(response.statusCode, 503);
            assert.equal(response.json().code, 'EXECUTOR_STATUS_UNAVAILABLE');
          });
          const after = await readLocalState(pool, scenario);
          assert.deepEqual(after, before);
          assert.notEqual(after.attempts[0]!.status, 'DISPATCH_FAILED');
        }
      });

      await t.test('duplicate terminal reconciliation is idempotent for success and failure', async () => {
        for (const terminal of ['SUCCEEDED', 'FAILED'] as const) {
          await resetOrchestrationData(pool);
          const scenario = await createScenario(pool, createDatasetVersion);
          const fake = new FakeExecutor();
          await createAcceptedRun(buildApp, fake, scenario);
          const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
          assert.equal(fake.setExecutionState(identityOf(attempt), terminal), true);
          await withApp(buildApp, fake, async (app) => {
            const first = await postReconcile(app, scenario.jobId);
            assert.equal(first.statusCode, 200);
            const afterFirst = await readLocalState(pool, scenario);
            const second = await postReconcile(app, scenario.jobId);
            assert.equal(second.statusCode, 200);
            assert.equal(second.json().attemptStatus, terminal);
            assert.deepEqual(await readLocalState(pool, scenario), afterFirst);
          });
        }
      });

      await t.test('terminal contradictions return internal error without overwriting history', async () => {
        for (const pair of [
          { local: 'SUCCEEDED', external: 'FAILED' },
          { local: 'FAILED', external: 'SUCCEEDED' },
        ] as const) {
          await resetOrchestrationData(pool);
          const scenario = await createScenario(pool, createDatasetVersion);
          const fake = new FakeExecutor();
          await createAcceptedRun(buildApp, fake, scenario);
          const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
          assert.equal(fake.setExecutionState(identityOf(attempt), pair.local), true);
          await withApp(buildApp, fake, async (app) => {
            assert.equal((await postReconcile(app, scenario.jobId)).statusCode, 200);
            const terminalState = await readLocalState(pool, scenario);
            assert.equal(fake.setExecutionState(identityOf(attempt), pair.external), true);
            const contradiction = await postReconcile(app, scenario.jobId);
            assert.equal(contradiction.statusCode, 500);
            assert.equal(contradiction.json().code, 'INTERNAL_SERVER_ERROR');
            assert.deepEqual(await readLocalState(pool, scenario), terminalState);
          });
        }
      });

      await t.test('late callback for attempt 1 cannot regress accepted retry attempt 2', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const initialState = await readLocalState(pool, scenario);
        const attempt1 = initialState.attempts[0]!;
        assert.equal(fake.setExecutionState(identityOf(attempt1), 'FAILED'), true);
        await withApp(buildApp, fake, async (app) => {
          assert.equal((await postReconcile(app, scenario.jobId)).statusCode, 200);
          const retry = await postRun(app, scenario.jobId);
          assert.equal(retry.statusCode, 200);
          assert.equal(retry.json().attemptNumber, 2);
          const beforeStale = await readLocalState(pool, scenario);
          assert.equal(beforeStale.jobStatus, 'RUNNING');
          assert.equal(beforeStale.attempts[1]!.status, 'ACCEPTED');
          assert.equal(beforeStale.snapshotId, retry.json().datasetBuildSnapshotId);

          const stale = await postCallback(app, identityOf(attempt1));
          assert.equal(stale.statusCode, 200);
          assert.equal(stale.json().executionAttemptId, attempt1.id);
          assert.equal(stale.json().attemptStatus, 'FAILED');
          assert.equal(stale.json().jobStatus, 'RUNNING');
          assert.deepEqual(await readLocalState(pool, scenario), beforeStale);
        });
      });

      await t.test('callback payload is a signal only and unknown identity is 404', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
        await withApp(buildApp, fake, async (app) => {
          const forced = await postCallback(app, {
            ...identityOf(attempt),
            status: 'FAILED',
          });
          assert.equal(forced.statusCode, 400);
          assert.equal(forced.json().code, 'INVALID_REQUEST');
          assert.equal((await readLocalState(pool, scenario)).jobStatus, 'RUNNING');

          const valid = await postCallback(app, identityOf(attempt));
          assert.equal(valid.statusCode, 200);
          assert.equal(valid.json().executorStatus, 'RUNNING');

          const unknown = await postCallback(app, {
            airflowDagId: 'unknown_dag',
            airflowDagRunId: `unknown-${randomUUID()}`,
          });
          assert.equal(unknown.statusCode, 404);
          assert.equal(unknown.json().code, 'EXECUTION_ATTEMPT_NOT_FOUND');
        });
      });

      await t.test('unknown job, PREPARED, and DISPATCH_FAILED manual errors avoid lookup', async () => {
        await resetOrchestrationData(pool);
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const missing = await postReconcile(app, randomUUID());
          assert.equal(missing.statusCode, 404);
          assert.equal(missing.json().code, 'CALCULATION_JOB_NOT_FOUND');
        });

        await resetOrchestrationData(pool);
        const preparedScenario = await createScenario(pool, createDatasetVersion);
        await prepare(preparedScenario.jobId);
        await withApp(buildApp, fake, async (app) => {
          const preparedResponse = await postReconcile(app, preparedScenario.jobId);
          assert.equal(preparedResponse.statusCode, 409);
          assert.equal(preparedResponse.json().code, 'EXECUTION_NOT_RECONCILABLE');
        });
        assert.equal(fake.getStatusLookupHistory().length, 0);

        await resetOrchestrationData(pool);
        const rejectedScenario = await createScenario(pool, createDatasetVersion);
        const rejectingFake = new FakeExecutor({ defaultBehavior: 'REJECT' });
        await withApp(buildApp, rejectingFake, async (app) => {
          assert.equal((await postRun(app, rejectedScenario.jobId)).statusCode, 502);
          const response = await postReconcile(app, rejectedScenario.jobId);
          assert.equal(response.statusCode, 409);
          assert.equal(response.json().code, 'EXECUTION_NOT_RECONCILABLE');
        });
        assert.equal(rejectingFake.getStatusLookupHistory().length, 0);
      });

      await t.test('status lookup waits with no PostgreSQL job/attempt locks held', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
        const blocker = new BlockingStatusExecutor();
        await withApp(buildApp, blocker, async (app) => {
          const pendingResponse = postReconcile(app, scenario.jobId);
          await blocker.entered;

          const observer = await pool.connect();
          try {
            await observer.query('BEGIN');
            await observer.query(
              'SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT',
              [scenario.jobId],
            );
            await observer.query(
              'SELECT id FROM execution_attempts WHERE id = $1 FOR UPDATE NOWAIT',
              [attempt.id],
            );
            await observer.query('ROLLBACK');
          } finally {
            observer.release();
          }

          blocker.returnStatus({ kind: 'RUNNING' });
          const response = await pendingResponse;
          assert.equal(response.statusCode, 200);
        });
      });

      await t.test('concurrent duplicate terminal reconciliation converges once', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
        assert.equal(fake.setExecutionState(identityOf(attempt), 'SUCCEEDED'), true);
        await withApp(buildApp, fake, async (app) => {
          const responses = await Promise.all(
            Array.from({ length: 20 }, () => postReconcile(app, scenario.jobId)),
          );
          assert.ok(responses.every((response) => response.statusCode === 200));
          assert.ok(responses.every(
            (response) => response.json().attemptStatus === 'SUCCEEDED',
          ));
        });
        const state = await readLocalState(pool, scenario);
        assert.equal(state.attempts.length, 1);
        assert.equal(state.attempts[0]!.status, 'SUCCEEDED');
        assert.equal(state.jobStatus, 'SUCCEEDED');
        assert.equal(state.datasetStatus, 'BUILDING');
      });

      await t.test('attempt/job terminal transition rolls back atomically on job failure', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const attempt = (await readLocalState(pool, scenario)).attempts[0]!;
        assert.equal(fake.setExecutionState(identityOf(attempt), 'SUCCEEDED'), true);
        await pool.query(
          `CREATE FUNCTION reject_reconciliation_job_update_for_test()
           RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.status = 'SUCCEEDED' THEN
               RAISE EXCEPTION 'test rejection';
             END IF;
             RETURN NEW;
           END
           $$`,
        );
        await pool.query(
          `CREATE TRIGGER reject_reconciliation_job_update_for_test
           BEFORE UPDATE ON calculation_jobs
           FOR EACH ROW
           EXECUTE FUNCTION reject_reconciliation_job_update_for_test()`,
        );
        try {
          await withApp(buildApp, fake, async (app) => {
            const response = await postReconcile(app, scenario.jobId);
            assert.equal(response.statusCode, 500);
          });
          const state = await readLocalState(pool, scenario);
          assert.equal(state.attempts[0]!.status, 'ACCEPTED');
          assert.equal(state.jobStatus, 'RUNNING');
        } finally {
          await pool.query('DROP TRIGGER reject_reconciliation_job_update_for_test ON calculation_jobs');
          await pool.query('DROP FUNCTION reject_reconciliation_job_update_for_test()');
        }
      });

      await t.test('ambiguous FAILED retry preserves the immutable snapshot', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await createAcceptedRun(buildApp, fake, scenario);
        const initialState = await readLocalState(pool, scenario);
        const attempt1 = initialState.attempts[0]!;
        assert.equal(fake.setExecutionState(identityOf(attempt1), 'FAILED'), true);
        await withApp(buildApp, fake, async (app) => {
          await postReconcile(app, scenario.jobId);
          const failedState = await readLocalState(pool, scenario);
          fake.setDefaultBehavior('ACCEPT_THEN_UNKNOWN');
          const retry = await postRun(app, scenario.jobId);
          assert.equal(retry.statusCode, 202);
          assert.equal(retry.json().attemptNumber, 2);
          assert.equal(retry.json().datasetBuildSnapshotId, failedState.snapshotId);
          assert.equal(retry.json().jobStatus, 'FAILED');
          assert.equal(fake.setExecutionState({
            airflowDagId: retry.json().airflowDagId,
            airflowDagRunId: retry.json().airflowDagRunId,
          }, 'FAILED'), true);
          const reconciled = await postReconcile(app, scenario.jobId);
          assert.equal(reconciled.statusCode, 200);
          assert.equal(reconciled.json().attemptStatus, 'FAILED');
          assert.equal(reconciled.json().jobStatus, 'FAILED');
        });
        const finalState = await readLocalState(pool, scenario);
        assert.equal(finalState.snapshotId, initialState.snapshotId);
        assert.deepEqual(finalState.attempts.map(({ status }) => status), ['FAILED', 'FAILED']);
      });

      await t.test('fake controls reject unknown runs and are absent in production', async () => {
        await resetOrchestrationData(pool);
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const unknown = await app.inject({
            method: 'POST',
            url: `/internal/fake-executor/executions/unknown-${randomUUID()}/succeed`,
          });
          assert.equal(unknown.statusCode, 404);
          assert.equal(unknown.json().code, 'FAKE_EXECUTION_NOT_FOUND');
        });
        await withApp(buildApp, fake, async (app) => {
          const absent = await app.inject({
            method: 'POST',
            url: `/internal/fake-executor/executions/unknown-${randomUUID()}/fail`,
          });
          assert.equal(absent.statusCode, 404);
        }, 'production');
      });
    } finally {
      if (applicationPool) {
        await applicationPool.end();
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      await dropTemporaryDatabase(databaseName);
    }
  },
);
