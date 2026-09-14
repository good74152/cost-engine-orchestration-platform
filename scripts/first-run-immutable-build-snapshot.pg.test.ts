import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Client, type Pool, type PoolClient } from 'pg';
import type { PreparedCalculationRun } from '../src/modules/calculation-job.types.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);
const V2_MIGRATION_NAME = '1788700000000_orchestration-schema-v2';

const sourceDatabaseUrl = (() => {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must point to the repository PostgreSQL service',
    );
  }
  return value;
})();

type DatasetStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'ABANDONED';
type DefinitionStatus = 'DRAFT' | 'PUBLISHED' | 'ABANDONED';

interface CreatedOutput {
  datasetVersionId: string;
  jobsByCode: Map<string, string>;
}

interface CreatedSeries {
  seriesId: string;
  versionsByNumber: Map<number, string>;
}

function parseDatabaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error('PostgreSQL integration tests require a database URL', {
      cause: error,
    });
  }
}

function assertSafeDatabaseName(name: string): void {
  assert.match(name, /^first_run_snapshot_test_[a-z0-9_]+$/);
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
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(name)} TEMPLATE template0`,
    );
  } finally {
    await client.end();
  }
}

async function dropTemporaryDatabase(name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceDatabaseUrl() });
  try {
    await client.connect();
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
    );
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
  airflowDagId = `test_dag_${randomUUID()}`,
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
    version: number;
    status: DefinitionStatus;
    requiredDomains?: string[];
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `UPDATE calculation_types
     SET last_allocated_dependency_definition_version = GREATEST(
       last_allocated_dependency_definition_version,
       $2
     )
     WHERE id = $1`,
    [params.calculationTypeId, params.version],
  );
  await pool.query(
    `INSERT INTO execution_dependency_definition_versions (
       id,
       calculation_type_id,
       version,
       status,
       published_at
     ) VALUES (
       $1,
       $2,
       $3,
       $4::varchar(20),
       CASE WHEN $4::varchar(20) = 'PUBLISHED' THEN NOW() END
     )`,
    [id, params.calculationTypeId, params.version, params.status],
  );
  for (const requiredDomain of params.requiredDomains ?? []) {
    await pool.query(
      `INSERT INTO execution_dependency_definition_dependencies (
         definition_version_id,
         required_domain
       ) VALUES ($1, $2)`,
      [id, requiredDomain],
    );
  }
  return id;
}

async function createDatasetSeries(
  pool: Pool,
  params: {
    domain: string;
    companyCode?: string;
    fiscalYear?: number;
    period?: string;
    versions: Array<{ version: number; status: DatasetStatus }>;
  },
): Promise<CreatedSeries> {
  const seriesId = randomUUID();
  const maximumVersion = Math.max(...params.versions.map(({ version }) => version));
  await pool.query(
    `INSERT INTO dataset_series (
       id,
       domain,
       company_code,
       fiscal_year,
       period,
       last_allocated_version
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      seriesId,
      params.domain,
      params.companyCode ?? 'TW01',
      params.fiscalYear ?? 2026,
      params.period ?? 'Q3',
      maximumVersion,
    ],
  );

  const versionsByNumber = new Map<number, string>();
  for (const version of params.versions) {
    const datasetVersionId = randomUUID();
    await pool.query(
      `INSERT INTO dataset_versions (
         id,
         dataset_series_id,
         version,
         status,
         published_at
       ) VALUES (
         $1,
         $2,
         $3,
         $4::varchar(20),
         CASE WHEN $4::varchar(20) = 'PUBLISHED' THEN NOW() END
       )`,
      [datasetVersionId, seriesId, version.version, version.status],
    );
    versionsByNumber.set(version.version, datasetVersionId);
  }
  return { seriesId, versionsByNumber };
}

async function createOutputDataset(
  createDatasetVersion: (input: {
    domain: 'DPR';
    companyCode: string;
    fiscalYear: number;
    period: 'Q3';
  }) => Promise<{
    datasetVersionId: string;
    calculationJobs: Array<{ jobId: string; calculationTypeCode: string }>;
  }>,
): Promise<CreatedOutput> {
  const result = await createDatasetVersion({
    domain: 'DPR',
    companyCode: 'TW01',
    fiscalYear: 2026,
    period: 'Q3',
  });
  return {
    datasetVersionId: result.datasetVersionId,
    jobsByCode: new Map(
      result.calculationJobs.map((job) => [job.calculationTypeCode, job.jobId]),
    ),
  };
}

async function assertPreparationError(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => (
    error instanceof Error
    && 'code' in error
    && error.code === code
  ));
}

async function readOutputState(pool: Pool, datasetVersionId: string) {
  const dataset = await pool.query<{
    status: string;
    building_started_at: Date | null;
  }>(
    `SELECT status, building_started_at
     FROM dataset_versions
     WHERE id = $1`,
    [datasetVersionId],
  );
  const jobs = await pool.query<{
    id: string;
    status: string;
    resolved_dependency_definition_version_id: string | null;
  }>(
    `SELECT id, status, resolved_dependency_definition_version_id
     FROM calculation_jobs
     WHERE output_dataset_version_id = $1
     ORDER BY id`,
    [datasetVersionId],
  );
  const snapshots = await pool.query<{ id: string }>(
    `SELECT id
     FROM dataset_build_snapshots
     WHERE dataset_version_id = $1`,
    [datasetVersionId],
  );
  const attempts = await pool.query<{
    id: string;
    calculation_job_id: string;
    attempt_number: number;
    status: string;
    airflow_dag_id: string;
    airflow_dag_run_id: string;
  }>(
    `SELECT
       ea.id,
       ea.calculation_job_id,
       ea.attempt_number,
       ea.status,
       ea.airflow_dag_id,
       ea.airflow_dag_run_id
     FROM execution_attempts ea
     JOIN calculation_jobs cj ON cj.id = ea.calculation_job_id
     WHERE cj.output_dataset_version_id = $1
     ORDER BY ea.calculation_job_id, ea.attempt_number`,
    [datasetVersionId],
  );
  return {
    dataset: dataset.rows[0]!,
    jobs: jobs.rows,
    snapshots: snapshots.rows,
    attempts: attempts.rows,
  };
}

async function assertDraftRollback(pool: Pool, datasetVersionId: string): Promise<void> {
  const state = await readOutputState(pool, datasetVersionId);
  assert.equal(state.dataset.status, 'DRAFT');
  assert.equal(state.dataset.building_started_at, null);
  assert.ok(state.jobs.every(
    (job) => job.resolved_dependency_definition_version_id === null,
  ));
  assert.equal(state.snapshots.length, 0);
  assert.equal(state.attempts.length, 0);
}

async function readSnapshotDependencies(pool: Pool, snapshotId: string) {
  const result = await pool.query<{
    upstream_dataset_series_id: string;
    upstream_dataset_version_id: string;
    domain: string;
    company_code: string;
    fiscal_year: number;
    period: string;
    version: number;
    status: string;
  }>(
    `SELECT
       d.upstream_dataset_series_id,
       d.upstream_dataset_version_id,
       ds.domain,
       ds.company_code,
       ds.fiscal_year,
       ds.period,
       dv.version,
       dv.status
     FROM dataset_build_snapshot_dependencies d
     JOIN dataset_series ds
       ON ds.id = d.upstream_dataset_series_id
     JOIN dataset_versions dv
       ON dv.id = d.upstream_dataset_version_id
      AND dv.dataset_series_id = d.upstream_dataset_series_id
     WHERE d.snapshot_id = $1
     ORDER BY ds.domain`,
    [snapshotId],
  );
  return result.rows;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForBlockedLockQuery(
  pool: Pool,
  tableName: 'dataset_series' | 'calculation_types',
): Promise<void> {
  const pattern = `%FROM ${tableName}%FOR UPDATE%`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND query LIKE $1
       ) AS blocked`,
      [pattern],
    );
    if (result.rows[0]!.blocked) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${tableName} row-lock contention`);
}

test(
  'first Run immutable build snapshot PostgreSQL integration and concurrency',
  { concurrency: false },
  async (t) => {
    const databaseName = [
      'first_run_snapshot_test',
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

      const poolModule = await import('../src/db/pool.js');
      const datasetVersionModule = await import(
        '../src/modules/dataset-version/dataset-version.service.js'
      );
      const preparationModule = await import(
        '../src/modules/calculation-job.service.js'
      );
      applicationPool = poolModule.pool;
      const createDatasetVersion = datasetVersionModule.createDatasetVersionService;
      const prepare = preparationModule.prepareCalculationJobRunService;

      const migration = await applicationPool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM pgmigrations
         WHERE name = $1`,
        [V2_MIGRATION_NAME],
      );
      assert.equal(migration.rows[0]!.count, 1);

      await t.test('returns CALCULATION_JOB_NOT_FOUND without mutation', async () => {
        await resetOrchestrationData(applicationPool!);
        await assertPreparationError(
          () => prepare(randomUUID()),
          'CALCULATION_JOB_NOT_FOUND',
        );
        const counts = await applicationPool!.query<{
          snapshot_count: number;
          attempt_count: number;
        }>(
          `SELECT
             (SELECT COUNT(*)::int FROM dataset_build_snapshots) AS snapshot_count,
             (SELECT COUNT(*)::int FROM execution_attempts) AS attempt_count`,
        );
        assert.deepEqual(counts.rows[0], { snapshot_count: 0, attempt_count: 0 });
      });

      await t.test('freezes every job definition and the union of upstream inputs', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeA = await createCalculationType(
          applicationPool!, 'DPR', 'ASSET_SUMMARY', 'dag_asset_summary',
        );
        const typeB = await createCalculationType(
          applicationPool!, 'DPR', 'TABLE_X', 'dag_table_x',
        );
        const typeC = await createCalculationType(
          applicationPool!, 'DPR', 'TABLE_Y', 'dag_table_y',
        );
        const definitionA = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeA,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const definitionB = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeB,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX', 'INSURANCE'],
        });
        const definitionC = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeC,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: [],
        });
        const capex = await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX',
          versions: [{ version: 4, status: 'PUBLISHED' }],
        });
        const insurance = await createDatasetSeries(applicationPool!, {
          domain: 'INSURANCE',
          versions: [{ version: 2, status: 'PUBLISHED' }],
        });
        const output = await createOutputDataset(createDatasetVersion);
        const selectedJobId = output.jobsByCode.get('ASSET_SUMMARY')!;

        const result = await prepare(selectedJobId);
        assert.deepEqual(result, {
          datasetVersionId: output.datasetVersionId,
          datasetStatus: 'BUILDING',
          datasetBuildSnapshotId: result.datasetBuildSnapshotId,
          jobId: selectedJobId,
          jobStatus: 'PENDING',
          executionAttemptId: result.executionAttemptId,
          attemptNumber: 1,
          attemptStatus: 'PREPARED',
          airflowDagId: 'dag_asset_summary',
          airflowDagRunId: `cost-engine-${result.executionAttemptId}`,
        });

        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.dataset.status, 'BUILDING');
        assert.ok(state.dataset.building_started_at instanceof Date);
        assert.equal(state.snapshots.length, 1);
        assert.ok(state.jobs.every((job) => job.status === 'PENDING'));
        assert.deepEqual(
          new Set(state.jobs.map(
            (job) => job.resolved_dependency_definition_version_id,
          )),
          new Set([definitionA, definitionB, definitionC]),
        );
        assert.equal(state.attempts.length, 1);
        assert.equal(state.attempts[0]!.status, 'PREPARED');

        const dependencies = await readSnapshotDependencies(
          applicationPool!, result.datasetBuildSnapshotId,
        );
        assert.deepEqual(
          dependencies.map((dependency) => ({
            seriesId: dependency.upstream_dataset_series_id,
            versionId: dependency.upstream_dataset_version_id,
            domain: dependency.domain,
            companyCode: dependency.company_code,
            fiscalYear: dependency.fiscal_year,
            period: dependency.period,
            version: dependency.version,
            status: dependency.status,
          })),
          [
            {
              seriesId: capex.seriesId,
              versionId: capex.versionsByNumber.get(4),
              domain: 'CAPEX',
              companyCode: 'TW01',
              fiscalYear: 2026,
              period: 'Q3',
              version: 4,
              status: 'PUBLISHED',
            },
            {
              seriesId: insurance.seriesId,
              versionId: insurance.versionsByNumber.get(2),
              domain: 'INSURANCE',
              companyCode: 'TW01',
              fiscalYear: 2026,
              period: 'Q3',
              version: 2,
              status: 'PUBLISHED',
            },
          ],
        );
      });

      await t.test('ignores higher DRAFT and ABANDONED definitions', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        const published = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 2,
          status: 'PUBLISHED',
        });
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 3,
          status: 'DRAFT',
          requiredDomains: ['MISSING_DRAFT_INPUT'],
        });
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 4,
          status: 'ABANDONED',
          requiredDomains: ['MISSING_ABANDONED_INPUT'],
        });
        const output = await createOutputDataset(createDatasetVersion);

        await prepare(output.jobsByCode.get('TABLE_X')!);
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(
          state.jobs[0]!.resolved_dependency_definition_version_id,
          published,
        );
        assert.deepEqual(
          await readSnapshotDependencies(applicationPool!, state.snapshots[0]!.id),
          [],
        );
      });

      await t.test('missing published definition rolls back the complete freeze', async () => {
        await resetOrchestrationData(applicationPool!);
        const configured = await createCalculationType(applicationPool!, 'DPR', 'CONFIGURED');
        await createCalculationType(applicationPool!, 'DPR', 'MISSING');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: configured,
          version: 1,
          status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);

        await assertPreparationError(
          () => prepare(output.jobsByCode.get('CONFIGURED')!),
          'DEPENDENCY_DEFINITION_NOT_READY',
        );
        await assertDraftRollback(applicationPool!, output.datasetVersionId);
      });

      await t.test('missing upstream canonical series rolls back completely', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const output = await createOutputDataset(createDatasetVersion);

        await assertPreparationError(
          () => prepare(output.jobsByCode.get('TABLE_X')!),
          'DEPENDENCY_NOT_READY',
        );
        await assertDraftRollback(applicationPool!, output.datasetVersionId);
        const seriesCount = await applicationPool!.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM dataset_series
           WHERE domain = 'CAPEX'`,
        );
        assert.equal(seriesCount.rows[0]!.count, 0);
      });

      await t.test('uses only exact company, year, and period coordinates', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', companyCode: 'US01', versions: [{ version: 9, status: 'PUBLISHED' }],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', fiscalYear: 2025, versions: [{ version: 8, status: 'PUBLISHED' }],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', period: 'Q2', versions: [{ version: 7, status: 'PUBLISHED' }],
        });
        const exact = await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', versions: [{ version: 2, status: 'PUBLISHED' }],
        });
        const output = await createOutputDataset(createDatasetVersion);

        const prepared = await prepare(output.jobsByCode.get('TABLE_X')!);
        const dependencies = await readSnapshotDependencies(
          applicationPool!, prepared.datasetBuildSnapshotId,
        );
        assert.equal(dependencies.length, 1);
        assert.equal(dependencies[0]!.upstream_dataset_series_id, exact.seriesId);
        assert.equal(
          dependencies[0]!.upstream_dataset_version_id,
          exact.versionsByNumber.get(2),
        );
      });

      await t.test('upstream series without a published version rolls back', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', versions: [{ version: 1, status: 'DRAFT' }],
        });
        const output = await createOutputDataset(createDatasetVersion);

        await assertPreparationError(
          () => prepare(output.jobsByCode.get('TABLE_X')!),
          'DEPENDENCY_NOT_READY',
        );
        await assertDraftRollback(applicationPool!, output.datasetVersionId);
      });

      await t.test('ignores every higher non-PUBLISHED upstream status', async () => {
        for (const higherStatus of [
          'DRAFT',
          'BUILDING',
          'VALIDATING',
          'REJECTED',
          'ABANDONED',
        ] as const) {
          await resetOrchestrationData(applicationPool!);
          const typeId = await createCalculationType(
            applicationPool!, 'DPR', 'TABLE_X',
          );
          await createDependencyDefinition(applicationPool!, {
            calculationTypeId: typeId,
            version: 1,
            status: 'PUBLISHED',
            requiredDomains: ['CAPEX'],
          });
          const upstream = await createDatasetSeries(applicationPool!, {
            domain: 'CAPEX',
            versions: [
              { version: 1, status: 'PUBLISHED' },
              { version: 2, status: higherStatus },
            ],
          });
          const output = await createOutputDataset(createDatasetVersion);

          const prepared = await prepare(output.jobsByCode.get('TABLE_X')!);
          const dependencies = await readSnapshotDependencies(
            applicationPool!, prepared.datasetBuildSnapshotId,
          );
          assert.equal(
            dependencies[0]!.upstream_dataset_version_id,
            upstream.versionsByNumber.get(1),
            higherStatus,
          );
        }
      });

      await t.test('repeated preparation returns the same PREPARED attempt', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);
        const jobId = output.jobsByCode.get('TABLE_X')!;

        const first = await prepare(jobId);
        const second = await prepare(jobId);
        assert.deepEqual(second, first);
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.snapshots.length, 1);
        assert.equal(state.attempts.length, 1);
        assert.equal(state.jobs[0]!.status, 'PENDING');
      });

      await t.test('later BUILDING job reuses definitions and upstream versions', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeA = await createCalculationType(applicationPool!, 'DPR', 'TABLE_A');
        const typeB = await createCalculationType(applicationPool!, 'DPR', 'TABLE_B');
        const definitionA = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeA,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const definitionB = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeB,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const upstream = await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', versions: [{ version: 1, status: 'PUBLISHED' }],
        });
        const output = await createOutputDataset(createDatasetVersion);

        const first = await prepare(output.jobsByCode.get('TABLE_A')!);
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeB,
          version: 2,
          status: 'PUBLISHED',
          requiredDomains: ['INSURANCE'],
        });
        const newerVersionId = randomUUID();
        await applicationPool!.query(
          `INSERT INTO dataset_versions (
             id, dataset_series_id, version, status, published_at
           ) VALUES ($1, $2, 2, 'PUBLISHED', NOW())`,
          [newerVersionId, upstream.seriesId],
        );
        await applicationPool!.query(
          `UPDATE dataset_series SET last_allocated_version = 2 WHERE id = $1`,
          [upstream.seriesId],
        );

        const second = await prepare(output.jobsByCode.get('TABLE_B')!);
        assert.equal(second.datasetBuildSnapshotId, first.datasetBuildSnapshotId);
        const dependencies = await readSnapshotDependencies(
          applicationPool!, first.datasetBuildSnapshotId,
        );
        assert.equal(
          dependencies[0]!.upstream_dataset_version_id,
          upstream.versionsByNumber.get(1),
        );
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.snapshots.length, 1);
        assert.equal(state.attempts.length, 2);
        assert.deepEqual(
          new Set(state.jobs.map(
            (job) => job.resolved_dependency_definition_version_id,
          )),
          new Set([definitionA, definitionB]),
        );
      });

      await t.test('concurrent same-job preparation converges on one attempt', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId, version: 1, status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);
        const jobId = output.jobsByCode.get('TABLE_X')!;

        const [left, right] = await Promise.all([prepare(jobId), prepare(jobId)]);
        assert.deepEqual(right, left);
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.snapshots.length, 1);
        assert.equal(state.attempts.length, 1);
      });

      await t.test('concurrent different jobs converge on one frozen snapshot', async () => {
        await resetOrchestrationData(applicationPool!);
        for (const [code, requiredDomain] of [
          ['TABLE_A', 'CAPEX'],
          ['TABLE_B', 'INSURANCE'],
        ] as const) {
          const typeId = await createCalculationType(applicationPool!, 'DPR', code);
          await createDependencyDefinition(applicationPool!, {
            calculationTypeId: typeId,
            version: 1,
            status: 'PUBLISHED',
            requiredDomains: [requiredDomain],
          });
        }
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', versions: [{ version: 1, status: 'PUBLISHED' }],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'INSURANCE', versions: [{ version: 1, status: 'PUBLISHED' }],
        });
        const output = await createOutputDataset(createDatasetVersion);

        const [left, right] = await Promise.all([
          prepare(output.jobsByCode.get('TABLE_A')!),
          prepare(output.jobsByCode.get('TABLE_B')!),
        ]);
        assert.equal(right.datasetBuildSnapshotId, left.datasetBuildSnapshotId);
        assert.notEqual(right.executionAttemptId, left.executionAttemptId);
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.snapshots.length, 1);
        assert.equal(state.attempts.length, 2);
        assert.ok(state.jobs.every(
          (job) => job.resolved_dependency_definition_version_id !== null,
        ));
        assert.equal(
          (await readSnapshotDependencies(
            applicationPool!, left.datasetBuildSnapshotId,
          )).length,
          2,
        );
      });

      await t.test('upstream Publish and freeze serialize through dataset_series', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const upstream = await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX',
          versions: [
            { version: 1, status: 'PUBLISHED' },
            { version: 2, status: 'DRAFT' },
          ],
        });
        const output = await createOutputDataset(createDatasetVersion);
        const publisher = await applicationPool!.connect();
        let publisherOpen = false;
        try {
          await publisher.query('BEGIN');
          publisherOpen = true;
          await publisher.query(
            `SELECT id FROM dataset_series WHERE id = $1 FOR UPDATE`,
            [upstream.seriesId],
          );
          await publisher.query(
            `UPDATE dataset_versions
             SET status = 'PUBLISHED', published_at = NOW()
             WHERE id = $1`,
            [upstream.versionsByNumber.get(2)],
          );

          let settled = false;
          const preparation = prepare(output.jobsByCode.get('TABLE_X')!);
          void preparation.then(
            () => { settled = true; },
            () => { settled = true; },
          );
          await waitForBlockedLockQuery(applicationPool!, 'dataset_series');
          assert.equal(settled, false);
          await publisher.query('COMMIT');
          publisherOpen = false;

          const prepared = await preparation;
          const dependencies = await readSnapshotDependencies(
            applicationPool!, prepared.datasetBuildSnapshotId,
          );
          assert.equal(
            dependencies[0]!.upstream_dataset_version_id,
            upstream.versionsByNumber.get(2),
          );
        } finally {
          if (publisherOpen) {
            await publisher.query('ROLLBACK');
          }
          publisher.release();
        }
      });

      await t.test('definition Publish and freeze serialize through calculation_type', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 1,
          status: 'PUBLISHED',
          requiredDomains: ['CAPEX'],
        });
        const draftDefinition = await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId,
          version: 2,
          status: 'DRAFT',
          requiredDomains: ['INSURANCE'],
        });
        await createDatasetSeries(applicationPool!, {
          domain: 'CAPEX', versions: [{ version: 1, status: 'PUBLISHED' }],
        });
        const insurance = await createDatasetSeries(applicationPool!, {
          domain: 'INSURANCE', versions: [{ version: 3, status: 'PUBLISHED' }],
        });
        const output = await createOutputDataset(createDatasetVersion);
        const publisher = await applicationPool!.connect();
        let publisherOpen = false;
        try {
          await publisher.query('BEGIN');
          publisherOpen = true;
          await publisher.query(
            `SELECT id FROM calculation_types WHERE id = $1 FOR UPDATE`,
            [typeId],
          );
          await publisher.query(
            `UPDATE execution_dependency_definition_versions
             SET status = 'PUBLISHED', published_at = NOW()
             WHERE id = $1`,
            [draftDefinition],
          );

          let settled = false;
          const preparation = prepare(output.jobsByCode.get('TABLE_X')!);
          void preparation.then(
            () => { settled = true; },
            () => { settled = true; },
          );
          await waitForBlockedLockQuery(applicationPool!, 'calculation_types');
          assert.equal(settled, false);
          await publisher.query('COMMIT');
          publisherOpen = false;

          const prepared = await preparation;
          const state = await readOutputState(applicationPool!, output.datasetVersionId);
          assert.equal(
            state.jobs[0]!.resolved_dependency_definition_version_id,
            draftDefinition,
          );
          const dependencies = await readSnapshotDependencies(
            applicationPool!, prepared.datasetBuildSnapshotId,
          );
          assert.equal(dependencies.length, 1);
          assert.equal(dependencies[0]!.upstream_dataset_series_id, insurance.seriesId);
        } finally {
          if (publisherOpen) {
            await publisher.query('ROLLBACK');
          }
          publisher.release();
        }
      });

      await t.test('unexpected attempt persistence failure rolls back initialization', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId, version: 1, status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);
        await applicationPool!.query(
          `CREATE FUNCTION reject_prepared_attempt_for_test()
           RETURNS trigger
           LANGUAGE plpgsql
           AS $$
           BEGIN
             RAISE EXCEPTION 'forced execution-attempt persistence failure';
           END
           $$;

           CREATE TRIGGER reject_prepared_attempt_for_test
           BEFORE INSERT ON execution_attempts
           FOR EACH ROW
           EXECUTE FUNCTION reject_prepared_attempt_for_test();`,
        );
        try {
          await assert.rejects(
            () => prepare(output.jobsByCode.get('TABLE_X')!),
            /forced execution-attempt persistence failure/,
          );
          await assertDraftRollback(applicationPool!, output.datasetVersionId);
        } finally {
          await applicationPool!.query(
            `DROP TRIGGER reject_prepared_attempt_for_test ON execution_attempts;
             DROP FUNCTION reject_prepared_attempt_for_test();`,
          );
        }
      });

      await t.test('non-PENDING selected job is not runnable', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId, version: 1, status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);
        const jobId = output.jobsByCode.get('TABLE_X')!;
        const initial = await prepare(jobId);
        await applicationPool!.query(
          `UPDATE execution_attempts
           SET status = 'DISPATCH_FAILED'
           WHERE id = $1`,
          [initial.executionAttemptId],
        );
        await applicationPool!.query(
          `UPDATE calculation_jobs
           SET status = 'RUNNING', started_at = NOW()
           WHERE id = $1`,
          [jobId],
        );

        await assertPreparationError(
          () => prepare(jobId),
          'JOB_NOT_RUNNABLE',
        );
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.dataset.status, 'BUILDING');
        assert.equal(state.snapshots.length, 1);
        assert.equal(state.attempts.length, 1);
        assert.equal(state.jobs[0]!.status, 'RUNNING');
      });

      await t.test('terminal dataset states are not runnable and do not mutate', async () => {
        for (const status of [
          'VALIDATING', 'PUBLISHED', 'REJECTED', 'ABANDONED',
        ] as const) {
          await resetOrchestrationData(applicationPool!);
          const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
          await createDependencyDefinition(applicationPool!, {
            calculationTypeId: typeId, version: 1, status: 'PUBLISHED',
          });
          const output = await createOutputDataset(createDatasetVersion);
          await applicationPool!.query(
            `UPDATE dataset_versions SET status = $2 WHERE id = $1`,
            [output.datasetVersionId, status],
          );

          await assertPreparationError(
            () => prepare(output.jobsByCode.get('TABLE_X')!),
            'JOB_NOT_RUNNABLE',
          );
          const state = await readOutputState(applicationPool!, output.datasetVersionId);
          assert.equal(state.dataset.status, status);
          assert.equal(state.snapshots.length, 0);
          assert.equal(state.attempts.length, 0);
          assert.equal(state.jobs[0]!.status, 'PENDING');
          assert.equal(
            state.jobs[0]!.resolved_dependency_definition_version_id,
            null,
          );
        }
      });

      await t.test('BUILDING without one complete snapshot is an invariant failure', async () => {
        await resetOrchestrationData(applicationPool!);
        const typeId = await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createDependencyDefinition(applicationPool!, {
          calculationTypeId: typeId, version: 1, status: 'PUBLISHED',
        });
        const output = await createOutputDataset(createDatasetVersion);
        await applicationPool!.query(
          `UPDATE dataset_versions
           SET status = 'BUILDING', building_started_at = NOW()
           WHERE id = $1`,
          [output.datasetVersionId],
        );

        await assertPreparationError(
          () => prepare(output.jobsByCode.get('TABLE_X')!),
          'CALCULATION_STATE_INVARIANT_VIOLATION',
        );
        const state = await readOutputState(applicationPool!, output.datasetVersionId);
        assert.equal(state.snapshots.length, 0);
        assert.equal(state.attempts.length, 0);
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
