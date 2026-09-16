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
} from '../src/executors/calculation-executor.js';
import { createConfiguredCalculationExecutor } from '../src/executors/executor-factory.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const V2_MIGRATION_NAME = '1788700000000_orchestration-schema-v2';
const sourceDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL must point to PostgreSQL');
}

type DefinitionStatus = 'DRAFT' | 'PUBLISHED' | 'ABANDONED';
type DatasetStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'ABANDONED';

interface Scenario {
  datasetVersionId: string;
  jobsByCode: Map<string, string>;
  definitionsByCode: Map<string, string>;
  capexSeriesId: string;
  capexVersionId: string;
  insuranceVersionId: string;
}

function parseDatabaseUrl(value: string): URL {
  return new URL(value);
}

function assertSafeDatabaseName(name: string): void {
  assert.match(name, /^execution_dispatch_test_[a-z0-9_]+$/);
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

async function createCalculationType(
  pool: Pool,
  domain: string,
  code: string,
  airflowDagId: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO calculation_types (domain, code, airflow_dag_id, is_active)
     VALUES ($1, $2, $3, TRUE)
     RETURNING id`,
    [domain, code, airflowDagId],
  );
  return result.rows[0]!.id;
}

async function createDependencyDefinition(
  pool: Pool,
  params: {
    calculationTypeId: string;
    version?: number;
    status?: DefinitionStatus;
    requiredDomains?: string[];
  },
): Promise<string> {
  const id = randomUUID();
  const version = params.version ?? 1;
  const status = params.status ?? 'PUBLISHED';
  await pool.query(
    `UPDATE calculation_types
     SET last_allocated_dependency_definition_version = GREATEST(
       last_allocated_dependency_definition_version,
       $2
     )
     WHERE id = $1`,
    [params.calculationTypeId, version],
  );
  await pool.query(
    `INSERT INTO execution_dependency_definition_versions (
       id, calculation_type_id, version, status, published_at
     ) VALUES (
       $1, $2, $3, $4::varchar(20),
       CASE WHEN $4::varchar(20) = 'PUBLISHED' THEN NOW() END
     )`,
    [id, params.calculationTypeId, version, status],
  );
  for (const domain of params.requiredDomains ?? []) {
    await pool.query(
      `INSERT INTO execution_dependency_definition_dependencies (
         definition_version_id, required_domain
       ) VALUES ($1, $2)`,
      [id, domain],
    );
  }
  return id;
}

async function createSeriesWithVersion(
  pool: Pool,
  params: {
    domain: string;
    version: number;
    status: DatasetStatus;
  },
): Promise<{ seriesId: string; versionId: string }> {
  const seriesId = randomUUID();
  const versionId = randomUUID();
  await pool.query(
    `INSERT INTO dataset_series (
       id, domain, company_code, fiscal_year, period, last_allocated_version
     ) VALUES ($1, $2, 'TW01', 2026, 'Q3', $3)`,
    [seriesId, params.domain, params.version],
  );
  await pool.query(
    `INSERT INTO dataset_versions (
       id, dataset_series_id, version, status, published_at
     ) VALUES (
       $1, $2, $3, $4::varchar(20),
       CASE WHEN $4::varchar(20) = 'PUBLISHED' THEN NOW() END
     )`,
    [versionId, seriesId, params.version, params.status],
  );
  return { seriesId, versionId };
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
    calculationJobs: Array<{ jobId: string; calculationTypeCode: string }>;
  }>,
): Promise<Scenario> {
  const typeA = await createCalculationType(pool, 'DPR', 'ASSET_SUMMARY', 'dag_asset');
  const typeB = await createCalculationType(pool, 'DPR', 'TABLE_X', 'dag_table_x');
  const typeC = await createCalculationType(pool, 'DPR', 'TABLE_Y', 'dag_table_y');
  const definitionA = await createDependencyDefinition(pool, {
    calculationTypeId: typeA,
    requiredDomains: ['CAPEX'],
  });
  const definitionB = await createDependencyDefinition(pool, {
    calculationTypeId: typeB,
    requiredDomains: ['CAPEX', 'INSURANCE'],
  });
  const definitionC = await createDependencyDefinition(pool, {
    calculationTypeId: typeC,
    requiredDomains: [],
  });
  const capex = await createSeriesWithVersion(pool, {
    domain: 'CAPEX', version: 11, status: 'PUBLISHED',
  });
  const insurance = await createSeriesWithVersion(pool, {
    domain: 'INSURANCE', version: 3, status: 'PUBLISHED',
  });
  const output = await createDatasetVersion({
    domain: 'DPR', companyCode: 'TW01', fiscalYear: 2026, period: 'Q3',
  });
  return {
    datasetVersionId: output.datasetVersionId,
    jobsByCode: new Map(output.calculationJobs.map((job) => [
      job.calculationTypeCode,
      job.jobId,
    ])),
    definitionsByCode: new Map([
      ['ASSET_SUMMARY', definitionA],
      ['TABLE_X', definitionB],
      ['TABLE_Y', definitionC],
    ]),
    capexSeriesId: capex.seriesId,
    capexVersionId: capex.versionId,
    insuranceVersionId: insurance.versionId,
  };
}

async function postRun(app: FastifyInstance, jobId: string) {
  return app.inject({ method: 'POST', url: `/calculation-jobs/${jobId}/run` });
}

async function withApp<T>(
  buildApp: (options: {
    logger: boolean;
    calculationExecutor: CalculationExecutor;
  }) => Promise<FastifyInstance>,
  executor: CalculationExecutor,
  action: (app: FastifyInstance) => Promise<T>,
): Promise<T> {
  const app = await buildApp({ logger: false, calculationExecutor: executor });
  try {
    return await action(app);
  } finally {
    await app.close();
  }
}

async function readAttempts(pool: Pool, jobId: string) {
  const result = await pool.query<{
    id: string;
    attempt_number: number;
    status: string;
    airflow_dag_run_id: string;
    last_dispatch_error: string | null;
  }>(
    `SELECT id, attempt_number, status, airflow_dag_run_id, last_dispatch_error
     FROM execution_attempts
     WHERE calculation_job_id = $1
     ORDER BY attempt_number`,
    [jobId],
  );
  return result.rows;
}

async function readJobStatus(pool: Pool, jobId: string): Promise<string> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM calculation_jobs WHERE id = $1',
    [jobId],
  );
  return result.rows[0]!.status;
}

class BlockingExecutor implements CalculationExecutor {
  command: DispatchCalculationCommand | undefined;
  private enter!: () => void;
  private release!: (result: DispatchResult) => void;
  readonly entered = new Promise<void>((resolve) => {
    this.enter = resolve;
  });
  private readonly released = new Promise<DispatchResult>((resolve) => {
    this.release = resolve;
  });

  async dispatch(command: DispatchCalculationCommand): Promise<DispatchResult> {
    this.command = command;
    this.enter();
    return this.released;
  }

  accept(): void {
    this.release({ kind: 'ACCEPTED' });
  }
}

test(
  'execution attempt dispatch and FakeExecutor PostgreSQL acceptance suite',
  { concurrency: false },
  async (t) => {
    const databaseName = [
      'execution_dispatch_test',
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
      const buildApp = appModule.buildApp;
      const createDatasetVersion = datasetVersionModule.createDatasetVersionService;
      const prepare = preparationModule.prepareCalculationJobRunService;

      const migration = await pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM pgmigrations WHERE name = $1',
        [V2_MIGRATION_NAME],
      );
      assert.equal(migration.rows[0]!.count, 1);

      await t.test('explicit executor selection rejects fake production configuration', () => {
        assert.throws(
          () => createConfiguredCalculationExecutor({
            executorType: 'fake',
            nodeEnvironment: 'production',
          }),
          /cannot be enabled in production/,
        );
        assert.throws(
          () => createConfiguredCalculationExecutor({
            executorType: '',
            nodeEnvironment: 'test',
          }),
          /must explicitly select/,
        );
      });

      await t.test('accepted dispatch uses frozen job-specific inputs and later jobs reuse them', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const first = await postRun(app, scenario.jobsByCode.get('ASSET_SUMMARY')!);
          assert.equal(first.statusCode, 200);
          assert.equal(first.json().attemptStatus, 'ACCEPTED');
          assert.equal(first.json().jobStatus, 'RUNNING');
          assert.equal(first.json().dispatchOutcome, 'ACCEPTED');

          await pool.query(
            `UPDATE dataset_series SET last_allocated_version = 12 WHERE id = $1`,
            [scenario.capexSeriesId],
          );
          await pool.query(
            `INSERT INTO dataset_versions (
               id, dataset_series_id, version, status, published_at
             ) VALUES ($1, $2, 12, 'PUBLISHED', NOW())`,
            [randomUUID(), scenario.capexSeriesId],
          );

          const second = await postRun(app, scenario.jobsByCode.get('TABLE_X')!);
          const zeroDependency = await postRun(app, scenario.jobsByCode.get('TABLE_Y')!);
          assert.equal(second.statusCode, 200);
          assert.equal(zeroDependency.statusCode, 200);
          assert.equal(first.json().datasetBuildSnapshotId, second.json().datasetBuildSnapshotId);
          assert.equal(second.json().datasetBuildSnapshotId, zeroDependency.json().datasetBuildSnapshotId);
        });

        const history = fake.getDispatchHistory();
        assert.equal(history.length, 3);
        assert.deepEqual(
          history[0]!.upstreamDatasetVersions.map((dependency) => [
            dependency.domain,
            dependency.version,
            dependency.datasetVersionId,
          ]),
          [['CAPEX', 11, scenario.capexVersionId]],
        );
        assert.deepEqual(
          history[1]!.upstreamDatasetVersions.map((dependency) => [
            dependency.domain,
            dependency.version,
          ]),
          [['CAPEX', 11], ['INSURANCE', 3]],
        );
        assert.deepEqual(history[2]!.upstreamDatasetVersions, []);
        assert.equal(fake.getExternalExecutions().length, 3);
        assert.equal(new Set(history.map((command) => command.executionAttemptId)).size, 3);

        const state = await pool.query<{
          dataset_status: string;
          snapshot_count: number;
          accepted_count: number;
        }>(
          `SELECT
             dv.status AS dataset_status,
             (SELECT COUNT(*)::int FROM dataset_build_snapshots dbs
              WHERE dbs.dataset_version_id = dv.id) AS snapshot_count,
             (SELECT COUNT(*)::int FROM execution_attempts ea
              JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
              WHERE cj.output_dataset_version_id = dv.id
                AND ea.status = 'ACCEPTED') AS accepted_count
           FROM dataset_versions dv
           WHERE dv.id = $1`,
          [scenario.datasetVersionId],
        );
        assert.deepEqual(state.rows[0], {
          dataset_status: 'BUILDING', snapshot_count: 1, accepted_count: 3,
        });
      });

      await t.test('definite rejection persists before 502 and a later Run creates attempt 2', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('ASSET_SUMMARY')!;
        const fake = new FakeExecutor({ scriptedBehaviors: ['REJECT', 'ACCEPT'] });
        await withApp(buildApp, fake, async (app) => {
          const rejected = await postRun(app, jobId);
          assert.equal(rejected.statusCode, 502);
          assert.equal(rejected.json().code, 'EXECUTOR_DISPATCH_FAILED');
          assert.equal(await readJobStatus(pool, jobId), 'PENDING');
          const afterReject = await readAttempts(pool, jobId);
          assert.equal(afterReject.length, 1);
          assert.equal(afterReject[0]!.status, 'DISPATCH_FAILED');
          assert.match(afterReject[0]!.last_dispatch_error!, /rejected/i);

          const retry = await postRun(app, jobId);
          assert.equal(retry.statusCode, 200);
          assert.equal(retry.json().attemptNumber, 2);
          assert.equal(retry.json().attemptStatus, 'ACCEPTED');
        });
        const attempts = await readAttempts(pool, jobId);
        assert.deepEqual(attempts.map((attempt) => attempt.status), [
          'DISPATCH_FAILED', 'ACCEPTED',
        ]);
        assert.notEqual(attempts[0]!.id, attempts[1]!.id);
        assert.equal(fake.getExternalExecutions().length, 1);
      });

      await t.test('ACCEPT_THEN_UNKNOWN recovers the same attempt and stable run identity', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('ASSET_SUMMARY')!;
        const fake = new FakeExecutor({ defaultBehavior: 'ACCEPT_THEN_UNKNOWN' });
        await withApp(buildApp, fake, async (app) => {
          const ambiguous = await postRun(app, jobId);
          assert.equal(ambiguous.statusCode, 202);
          assert.equal(ambiguous.json().attemptStatus, 'DISPATCHING');
          assert.equal(ambiguous.json().jobStatus, 'PENDING');
          assert.equal(ambiguous.json().dispatchOutcome, 'UNKNOWN');

          const recovered = await postRun(app, jobId);
          assert.equal(recovered.statusCode, 200);
          assert.equal(recovered.json().attemptStatus, 'ACCEPTED');
          assert.equal(recovered.json().dispatchOutcome, 'ALREADY_EXISTS');
          assert.equal(recovered.json().executionAttemptId, ambiguous.json().executionAttemptId);
          assert.equal(recovered.json().attemptNumber, ambiguous.json().attemptNumber);
          assert.equal(recovered.json().airflowDagRunId, ambiguous.json().airflowDagRunId);

          const dispatchCount = fake.getDispatchHistory().length;
          const repeated = await postRun(app, jobId);
          assert.equal(repeated.statusCode, 200);
          assert.equal(repeated.json().executionAttemptId, ambiguous.json().executionAttemptId);
          assert.equal(fake.getDispatchHistory().length, dispatchCount);
        });
        assert.equal(fake.getExternalExecutions().length, 1);
        assert.equal((await readAttempts(pool, jobId)).length, 1);
      });

      await t.test('twenty concurrent same-job Run requests converge', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('ASSET_SUMMARY')!;
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const responses = await Promise.all(
            Array.from({ length: 20 }, () => postRun(app, jobId)),
          );
          assert.ok(responses.every((response) => response.statusCode === 200));
          assert.equal(
            new Set(responses.map((response) => response.json().executionAttemptId)).size,
            1,
          );
          assert.equal(
            new Set(responses.map((response) => response.json().airflowDagRunId)).size,
            1,
          );
        });
        assert.equal(fake.getExternalExecutions().length, 1);
        const attempts = await readAttempts(pool, jobId);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]!.status, 'ACCEPTED');
        assert.equal(await readJobStatus(pool, jobId), 'RUNNING');
        const snapshots = await pool.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM dataset_build_snapshots WHERE dataset_version_id = $1',
          [scenario.datasetVersionId],
        );
        assert.equal(snapshots.rows[0]!.count, 1);
      });

      await t.test('different jobs dispatch independently with distinct identities', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const [first, second] = await Promise.all([
            postRun(app, scenario.jobsByCode.get('ASSET_SUMMARY')!),
            postRun(app, scenario.jobsByCode.get('TABLE_X')!),
          ]);
          assert.equal(first.statusCode, 200);
          assert.equal(second.statusCode, 200);
          assert.equal(first.json().datasetBuildSnapshotId, second.json().datasetBuildSnapshotId);
          assert.notEqual(first.json().executionAttemptId, second.json().executionAttemptId);
          assert.notEqual(first.json().airflowDagRunId, second.json().airflowDagRunId);
        });
        assert.equal(fake.getExternalExecutions().length, 2);
        const dependencySets = fake.getDispatchHistory()
          .map((command) => command.upstreamDatasetVersions.map(({ domain }) => domain));
        assert.ok(dependencySets.some((domains) => domains.join(',') === 'CAPEX'));
        assert.ok(dependencySets.some((domains) => domains.join(',') === 'CAPEX,INSURANCE'));
      });

      await t.test('FAILED retry uses the same frozen contract and acceptance restores RUNNING', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('TABLE_X')!;
        const prepared = await prepare(jobId);
        await pool.query(
          `UPDATE execution_attempts
           SET status = 'FAILED', finished_at = NOW()
           WHERE id = $1`,
          [prepared.executionAttemptId],
        );
        await pool.query("UPDATE calculation_jobs SET status = 'FAILED' WHERE id = $1", [jobId]);

        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const retry = await postRun(app, jobId);
          assert.equal(retry.statusCode, 200);
          assert.equal(retry.json().attemptNumber, 2);
          assert.equal(retry.json().datasetBuildSnapshotId, prepared.datasetBuildSnapshotId);
          assert.equal(retry.json().jobStatus, 'RUNNING');
        });
        const attempts = await readAttempts(pool, jobId);
        assert.deepEqual(attempts.map(({ status }) => status), ['FAILED', 'ACCEPTED']);
        assert.equal(
          fake.getDispatchHistory()[0]!.resolvedDependencyDefinitionVersionId,
          scenario.definitionsByCode.get('TABLE_X'),
        );
      });

      await t.test('FAILED retry rejection leaves logical job FAILED', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('ASSET_SUMMARY')!;
        const prepared = await prepare(jobId);
        await pool.query(
          `UPDATE execution_attempts SET status = 'FAILED', finished_at = NOW() WHERE id = $1`,
          [prepared.executionAttemptId],
        );
        await pool.query("UPDATE calculation_jobs SET status = 'FAILED' WHERE id = $1", [jobId]);
        const fake = new FakeExecutor({ defaultBehavior: 'REJECT' });
        await withApp(buildApp, fake, async (app) => {
          const response = await postRun(app, jobId);
          assert.equal(response.statusCode, 502);
          assert.equal(response.json().code, 'EXECUTOR_DISPATCH_FAILED');
        });
        assert.equal(await readJobStatus(pool, jobId), 'FAILED');
        assert.deepEqual(
          (await readAttempts(pool, jobId)).map(({ status }) => status),
          ['FAILED', 'DISPATCH_FAILED'],
        );
      });

      await t.test('public error contracts are stable and do not leak PostgreSQL details', async () => {
        await resetOrchestrationData(pool);
        const fake = new FakeExecutor();
        await withApp(buildApp, fake, async (app) => {
          const missing = await postRun(app, randomUUID());
          assert.equal(missing.statusCode, 404);
          assert.equal(missing.json().code, 'CALCULATION_JOB_NOT_FOUND');

          const typeWithoutDefinition = await createCalculationType(
            pool, 'DPR', 'NO_DEFINITION', 'dag_no_definition',
          );
          assert.ok(typeWithoutDefinition);
          const outputWithoutDefinition = await createDatasetVersion({
            domain: 'DPR', companyCode: 'TW01', fiscalYear: 2026, period: 'Q3',
          });
          const noDefinition = await postRun(
            app,
            outputWithoutDefinition.calculationJobs[0]!.jobId,
          );
          assert.equal(noDefinition.statusCode, 409);
          assert.equal(noDefinition.json().code, 'DEPENDENCY_DEFINITION_NOT_READY');
        });

        await resetOrchestrationData(pool);
        await withApp(buildApp, fake, async (app) => {
          const type = await createCalculationType(pool, 'DPR', 'NEEDS_CAPEX', 'dag_needs_capex');
          await createDependencyDefinition(pool, {
            calculationTypeId: type,
            requiredDomains: ['CAPEX'],
          });
          const output = await createDatasetVersion({
            domain: 'DPR', companyCode: 'TW01', fiscalYear: 2026, period: 'Q3',
          });
          const notReady = await postRun(app, output.calculationJobs[0]!.jobId);
          assert.equal(notReady.statusCode, 409);
          assert.equal(notReady.json().code, 'DEPENDENCY_NOT_READY');
        });

        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const succeededJobId = scenario.jobsByCode.get('TABLE_Y')!;
        await pool.query("UPDATE calculation_jobs SET status = 'SUCCEEDED' WHERE id = $1", [
          succeededJobId,
        ]);
        await withApp(buildApp, fake, async (app) => {
          const notRunnable = await postRun(app, succeededJobId);
          assert.equal(notRunnable.statusCode, 409);
          assert.equal(notRunnable.json().code, 'JOB_NOT_RUNNABLE');
        });
      });

      await t.test('executor dispatch waits with no phase-2 PostgreSQL row locks held', async () => {
        await resetOrchestrationData(pool);
        const scenario = await createScenario(pool, createDatasetVersion);
        const jobId = scenario.jobsByCode.get('ASSET_SUMMARY')!;
        const blocker = new BlockingExecutor();
        await withApp(buildApp, blocker, async (app) => {
          const pendingResponse = postRun(app, jobId);
          await blocker.entered;
          assert.ok(blocker.command);

          const observer = await pool.connect();
          try {
            await observer.query('BEGIN');
            await observer.query(
              'SELECT id FROM calculation_jobs WHERE id = $1 FOR UPDATE NOWAIT',
              [jobId],
            );
            await observer.query(
              'SELECT id FROM execution_attempts WHERE id = $1 FOR UPDATE NOWAIT',
              [blocker.command!.executionAttemptId],
            );
            await observer.query('ROLLBACK');
          } finally {
            observer.release();
          }

          const dispatching = await readAttempts(pool, jobId);
          assert.equal(dispatching[0]!.status, 'DISPATCHING');
          blocker.accept();
          const response = await pendingResponse;
          assert.equal(response.statusCode, 200);
          assert.equal(response.json().attemptStatus, 'ACCEPTED');
        });
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
