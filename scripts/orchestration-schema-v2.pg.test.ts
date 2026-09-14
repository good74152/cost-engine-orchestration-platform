import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';

const LEGACY_LAST_MIGRATION = 1787755224449;
const V2_MIGRATION_TIMESTAMP = 1788700000000;
const V2_MIGRATION_NAME = '1788700000000_orchestration-schema-v2';
const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

const databaseUrl = (() => {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must point to the repository PostgreSQL service',
    );
  }
  return value;
})();

const migrationLogger = {
  debug: (_message: string) => undefined,
  info: (_message: string) => undefined,
  warn: (_message: string) => undefined,
  error: (_message: string) => undefined,
};

type MigrationDirection = 'up' | 'down';

type LegacyDatasetStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'REJECTED';

type LegacyJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'VALIDATING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REJECTED';

type V2DatasetStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'ABANDONED';

interface LegacySeriesInput {
  domain: string;
  businessKey: string;
  lastVersion: number;
}

interface CanonicalSeriesInput {
  domain: string;
  companyCode: string;
  fiscalYear: number;
  period: string;
  lastAllocatedVersion?: number;
  legacyBusinessKey?: string | null;
}

function parseDatabaseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    throw new Error(
      'PostgreSQL integration tests require DATABASE_URL in URL form',
      { cause: error },
    );
  }
}

function assertSafeTestDatabaseName(name: string): void {
  assert.match(
    name,
    /^orchestration_v2_test_[a-z0-9_]+$/,
    'temporary database name must stay inside the generated test namespace',
  );
  assert.ok(name.length <= 63, 'temporary database name exceeds PostgreSQL limit');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function urlForDatabase(name: string): string {
  assertSafeTestDatabaseName(name);
  const url = parseDatabaseUrl(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function maintenanceDatabaseUrl(): string {
  const url = parseDatabaseUrl(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

async function createTemporaryDatabase(name: string): Promise<void> {
  assertSafeTestDatabaseName(name);
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
  assertSafeTestDatabaseName(name);
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

async function withTemporaryDatabase<T>(
  run: (temporaryDatabaseUrl: string) => Promise<T>,
): Promise<T> {
  const name = [
    'orchestration_v2_test',
    process.pid.toString(36),
    randomUUID().replaceAll('-', '').slice(0, 16),
  ].join('_');

  await createTemporaryDatabase(name);

  try {
    return await run(urlForDatabase(name));
  } finally {
    await dropTemporaryDatabase(name);
  }
}

async function withClient<T>(
  temporaryDatabaseUrl: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: temporaryDatabaseUrl });

  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.end();
  }
}

async function runMigrations(
  temporaryDatabaseUrl: string,
  direction: MigrationDirection,
  options: { count?: number; timestamp?: boolean } = {},
): Promise<void> {
  await runner({
    databaseUrl: temporaryDatabaseUrl,
    dir: MIGRATIONS_DIRECTORY,
    migrationsTable: 'pgmigrations',
    direction,
    singleTransaction: true,
    checkOrder: true,
    logger: migrationLogger,
    ...options,
  });
}

async function migrateLegacyBaseline(temporaryDatabaseUrl: string): Promise<void> {
  await runMigrations(temporaryDatabaseUrl, 'up', {
    count: LEGACY_LAST_MIGRATION,
    timestamp: true,
  });
}

async function migrateV2Up(temporaryDatabaseUrl: string): Promise<void> {
  await runMigrations(temporaryDatabaseUrl, 'up', { count: 1 });
}

async function migrateV2Down(temporaryDatabaseUrl: string): Promise<void> {
  await runMigrations(temporaryDatabaseUrl, 'down', { count: 1 });
}

async function migrateThroughV2(temporaryDatabaseUrl: string): Promise<void> {
  await runMigrations(temporaryDatabaseUrl, 'up', {
    count: V2_MIGRATION_TIMESTAMP,
    timestamp: true,
  });
}

async function expectPgError(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      expectedCode,
      `expected PostgreSQL SQLSTATE ${expectedCode}`,
    );
    return true;
  });
}

async function expectMigrationFailure(
  operation: Promise<unknown>,
  expectedMessage: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.match(
      error instanceof Error ? error.message : String(error),
      expectedMessage,
    );
    return true;
  });
}

async function createLegacySeries(
  client: Client,
  input: LegacySeriesInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO dataset_series (id, domain, business_key, last_version)
     VALUES ($1, $2, $3, $4)`,
    [id, input.domain, input.businessKey, input.lastVersion],
  );
  return id;
}

async function createLegacyDatasetVersion(
  client: Client,
  datasetSeriesId: string,
  version: number,
  status: LegacyDatasetStatus,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO dataset_versions (
       id,
       dataset_series_id,
       version,
       status
     ) VALUES ($1, $2, $3, $4)`,
    [id, datasetSeriesId, version, status],
  );
  return id;
}

async function createLegacyJob(
  client: Client,
  datasetSeriesId: string,
  outputDatasetVersionId: string,
  status: LegacyJobStatus,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO calculation_jobs (
       id,
       dataset_series_id,
       output_dataset_version_id,
       status
     ) VALUES ($1, $2, $3, $4)`,
    [id, datasetSeriesId, outputDatasetVersionId, status],
  );
  return id;
}

async function createCanonicalSeries(
  client: Client,
  input: CanonicalSeriesInput,
): Promise<string> {
  const id = randomUUID();
  const columns = [
    'id',
    'domain',
    'company_code',
    'fiscal_year',
    'period',
    'last_allocated_version',
  ];
  const values: Array<string | number | null> = [
    id,
    input.domain,
    input.companyCode,
    input.fiscalYear,
    input.period,
    input.lastAllocatedVersion ?? 0,
  ];

  if (input.legacyBusinessKey !== undefined) {
    columns.push('legacy_business_key');
    values.push(input.legacyBusinessKey);
  }

  await client.query(
    `INSERT INTO dataset_series (${columns.join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  );
  return id;
}

async function createV2DatasetVersion(
  client: Client,
  datasetSeriesId: string,
  version: number,
  status: V2DatasetStatus,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO dataset_versions (
       id,
       dataset_series_id,
       version,
       status
     ) VALUES ($1, $2, $3, $4)`,
    [id, datasetSeriesId, version, status],
  );
  return id;
}

async function createCalculationType(
  client: Client,
  domain: string,
  code: string,
  isActive = true,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO calculation_types (
       domain,
       code,
       airflow_dag_id,
       is_active
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [domain, code, `dag_${domain.toLowerCase()}_${code.toLowerCase()}`, isActive],
  );
  return result.rows[0]!.id;
}

async function createV2Job(
  client: Client,
  outputDatasetVersionId: string,
  calculationTypeId: string,
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' = 'PENDING',
  resolvedDefinitionId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO calculation_jobs (
       id,
       output_dataset_version_id,
       calculation_type_id,
       resolved_dependency_definition_version_id,
       status
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      outputDatasetVersionId,
      calculationTypeId,
      resolvedDefinitionId,
      status,
    ],
  );
  return id;
}

async function createDependencyDefinition(
  client: Client,
  calculationTypeId: string,
  version: number,
  status: 'DRAFT' | 'PUBLISHED' | 'ABANDONED' = 'PUBLISHED',
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO execution_dependency_definition_versions (
       id,
       calculation_type_id,
       version,
       status
     ) VALUES ($1, $2, $3, $4)`,
    [id, calculationTypeId, version, status],
  );
  return id;
}

async function readPublicSchemaState(client: Client): Promise<unknown> {
  const tables = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name`,
  );
  const columns = await client.query(
    `SELECT
       table_name,
       column_name,
       ordinal_position,
       data_type,
       udt_name,
       is_nullable,
       column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY table_name, ordinal_position`,
  );
  const constraints = await client.query(
    `SELECT
       constraint_record.conrelid::regclass::text AS table_name,
       constraint_record.conname AS constraint_name,
       constraint_record.contype AS constraint_type,
       pg_get_constraintdef(constraint_record.oid, TRUE) AS definition
     FROM pg_constraint constraint_record
     JOIN pg_namespace namespace_record
       ON namespace_record.oid = constraint_record.connamespace
     WHERE namespace_record.nspname = 'public'
     ORDER BY table_name, constraint_name`,
  );
  const indexes = await client.query(
    `SELECT tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
     ORDER BY tablename, indexname`,
  );

  return {
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

async function readLegacyOrchestrationData(client: Client): Promise<unknown> {
  const series = await client.query(`SELECT * FROM dataset_series ORDER BY id`);
  const versions = await client.query(`SELECT * FROM dataset_versions ORDER BY id`);
  const jobs = await client.query(`SELECT * FROM calculation_jobs ORDER BY id`);
  const dependencies = await client.query(
    `SELECT * FROM calculation_dependencies ORDER BY id`,
  );
  const migrations = await client.query(`SELECT * FROM pgmigrations ORDER BY id`);

  return {
    series: series.rows,
    versions: versions.rows,
    jobs: jobs.rows,
    dependencies: dependencies.rows,
    migrations: migrations.rows,
  };
}

async function assertLegacySchemaRemains(
  client: Client,
  expectedSeriesCount: number,
): Promise<void> {
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dataset_series'`,
  );
  const columnNames = new Set(columns.rows.map((row) => row.column_name));

  assert.ok(columnNames.has('business_key'));
  assert.ok(columnNames.has('last_version'));
  assert.ok(!columnNames.has('legacy_business_key'));
  assert.ok(!columnNames.has('company_code'));

  const dependencyTable = await client.query<{ name: string | null }>(
    `SELECT to_regclass('public.calculation_dependencies')::text AS name`,
  );
  assert.notEqual(dependencyTable.rows[0]!.name, null);

  const marker = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM pgmigrations
     WHERE name = $1`,
    [V2_MIGRATION_NAME],
  );
  assert.equal(marker.rows[0]!.count, 0);

  const series = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM dataset_series`,
  );
  assert.equal(series.rows[0]!.count, expectedSeriesCount);
}

async function readLegacyRoundTripState(client: Client): Promise<unknown[]> {
  const result = await client.query(
    `SELECT
       ds.id AS series_id,
       ds.domain,
       ds.business_key,
       ds.last_version,
       dv.id AS dataset_version_id,
       dv.version,
       dv.status AS dataset_status,
       dv.created_at::text AS dataset_created_at,
       dv.published_at::text AS published_at,
       cj.id AS calculation_job_id,
       cj.dataset_series_id AS job_series_id,
       cj.output_dataset_version_id,
       cj.status AS job_status,
       cj.created_at::text AS job_created_at,
       cj.started_at::text AS started_at,
       cj.finished_at::text AS finished_at
     FROM dataset_series ds
     JOIN dataset_versions dv
       ON dv.dataset_series_id = ds.id
     JOIN calculation_jobs cj
       ON cj.output_dataset_version_id = dv.id
     ORDER BY ds.domain, ds.business_key, dv.version, cj.id`,
  );
  return result.rows;
}

async function assertV2SchemaRemains(client: Client): Promise<void> {
  const marker = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
     FROM pgmigrations
     WHERE name = $1`,
    [V2_MIGRATION_NAME],
  );
  assert.equal(marker.rows[0]!.count, 1);

  const relations = await client.query<{
    execution_attempts: string | null;
    legacy_type_bridges: string | null;
  }>(
    `SELECT
       to_regclass('public.execution_attempts')::text AS execution_attempts,
       to_regclass(
         'public.orchestration_v2_legacy_calculation_type_bridges'
       )::text AS legacy_type_bridges`,
  );
  assert.notEqual(relations.rows[0]!.execution_attempts, null);
  assert.notEqual(relations.rows[0]!.legacy_type_bridges, null);

  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'dataset_series'`,
  );
  const columnNames = new Set(columns.rows.map((row) => row.column_name));
  assert.ok(columnNames.has('company_code'));
  assert.ok(columnNames.has('last_allocated_version'));
  assert.ok(!columnNames.has('business_key'));
}

test(
  'orchestration schema v2 PostgreSQL migration and persistence invariants',
  { concurrency: false },
  async (t) => {
    await t.test('migrates a clean database fully forward', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateThroughV2(temporaryDatabaseUrl);

        await withClient(temporaryDatabaseUrl, async (client) => {
          const migrations = await client.query<{ name: string }>(
            `SELECT name FROM pgmigrations ORDER BY id`,
          );
          assert.deepEqual(
            migrations.rows.map((row) => row.name),
            [
              '1786634529143_init-core-schema',
              '1787236891082_add-dpr-performance-tables',
              '1787645607729_add-dpr-calculation-input-snapshots',
              '1787645607730_add-dpr-calculation-inputs',
              '1787755224449_raw-ingestion-batches',
              V2_MIGRATION_NAME,
            ],
          );

          const tables = await client.query<{ table_name: string }>(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public'`,
          );
          const tableNames = new Set(tables.rows.map((row) => row.table_name));
          for (const tableName of [
            'dataset_series',
            'dataset_versions',
            'calculation_types',
            'orchestration_v2_legacy_calculation_type_bridges',
            'execution_dependency_definition_versions',
            'execution_dependency_definition_dependencies',
            'calculation_jobs',
            'dataset_build_snapshots',
            'dataset_build_snapshot_dependencies',
            'execution_attempts',
          ]) {
            assert.ok(tableNames.has(tableName), `${tableName} was not created`);
          }
        });
      });
    });

    await t.test('migrates representative legacy rows without data loss', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);

        await withClient(temporaryDatabaseUrl, async (client) => {
          const draftSeries = await createLegacySeries(client, {
            domain: 'FAB_COST',
            businessKey: 'TW01:2026:Q1:draft-history',
            lastVersion: 1,
          });
          const draftVersion = await createLegacyDatasetVersion(
            client,
            draftSeries,
            1,
            'DRAFT',
          );
          await createLegacyJob(client, draftSeries, draftVersion, 'PENDING');

          const buildingSeries = await createLegacySeries(client, {
            domain: 'CAPEX',
            businessKey: 'TW02:2026:Q2:building-history',
            lastVersion: 2,
          });
          const buildingVersion = await createLegacyDatasetVersion(
            client,
            buildingSeries,
            2,
            'BUILDING',
          );
          await createLegacyJob(client, buildingSeries, buildingVersion, 'RUNNING');

          const publishedSeries = await createLegacySeries(client, {
            domain: 'DPR',
            businessKey: 'TW03:2025:Q4:published-history',
            lastVersion: 5,
          });
          const publishedVersion = await createLegacyDatasetVersion(
            client,
            publishedSeries,
            4,
            'PUBLISHED',
          );
          await createLegacyJob(
            client,
            publishedSeries,
            publishedVersion,
            'SUCCEEDED',
          );
        });

        await migrateV2Up(temporaryDatabaseUrl);

        await withClient(temporaryDatabaseUrl, async (client) => {
          const rows = await client.query<{
            domain: string;
            company_code: string;
            fiscal_year: number;
            period: string;
            legacy_business_key: string;
            last_allocated_version: number;
            dataset_status: string;
            job_status: string;
            type_code: string;
            is_active: boolean;
          }>(
            `SELECT
               ds.domain,
               ds.company_code,
               ds.fiscal_year,
               ds.period,
               ds.legacy_business_key,
               ds.last_allocated_version,
               dv.status AS dataset_status,
               cj.status AS job_status,
               ct.code AS type_code,
               ct.is_active
             FROM dataset_series ds
             JOIN dataset_versions dv ON dv.dataset_series_id = ds.id
             JOIN calculation_jobs cj ON cj.output_dataset_version_id = dv.id
             JOIN calculation_types ct ON ct.id = cj.calculation_type_id
             ORDER BY ds.domain`,
          );

          assert.deepEqual(rows.rows, [
            {
              domain: 'CAPEX',
              company_code: 'TW02',
              fiscal_year: 2026,
              period: 'Q2',
              legacy_business_key: 'TW02:2026:Q2:building-history',
              last_allocated_version: 2,
              dataset_status: 'BUILDING',
              job_status: 'RUNNING',
              type_code: 'LEGACY_DEFAULT',
              is_active: false,
            },
            {
              domain: 'DPR',
              company_code: 'TW03',
              fiscal_year: 2025,
              period: 'Q4',
              legacy_business_key: 'TW03:2025:Q4:published-history',
              last_allocated_version: 5,
              dataset_status: 'PUBLISHED',
              job_status: 'SUCCEEDED',
              type_code: 'LEGACY_DEFAULT',
              is_active: false,
            },
            {
              domain: 'FAB_COST',
              company_code: 'TW01',
              fiscal_year: 2026,
              period: 'Q1',
              legacy_business_key: 'TW01:2026:Q1:draft-history',
              last_allocated_version: 1,
              dataset_status: 'DRAFT',
              job_status: 'PENDING',
              type_code: 'LEGACY_DEFAULT',
              is_active: false,
            },
          ]);

          const legacyColumn = await client.query<{ is_nullable: string }>(
            `SELECT is_nullable
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name = 'dataset_series'
               AND column_name = 'legacy_business_key'`,
          );
          assert.equal(legacyColumn.rows[0]!.is_nullable, 'YES');

          const oldDependencies = await client.query<{ name: string | null }>(
            `SELECT to_regclass('public.calculation_dependencies')::text AS name`,
          );
          assert.equal(oldDependencies.rows[0]!.name, null);
        });
      });
    });

    await t.test(
      'round-trips representative legacy lifecycle pairs down and forward again',
      async () => {
        await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
          await migrateLegacyBaseline(temporaryDatabaseUrl);

          const seededJobs: Array<{
            id: string;
            legacyStatus: string;
            v2Status: string;
          }> = [];
          let legacyStateBefore: unknown[] = [];

          await withClient(temporaryDatabaseUrl, async (client) => {
            for (const fixture of [
              {
                domain: 'FAB_COST',
                businessKey: 'TW01:2026:Q1:draft-pair',
                datasetStatus: 'DRAFT' as const,
                jobStatus: 'PENDING' as const,
                v2JobStatus: 'PENDING',
              },
              {
                domain: 'CAPEX',
                businessKey: 'TW02:2026:Q2:building-pair',
                datasetStatus: 'BUILDING' as const,
                jobStatus: 'RUNNING' as const,
                v2JobStatus: 'RUNNING',
              },
              {
                domain: 'DPR',
                businessKey: 'TW01:2026:Q3:validating-pair',
                datasetStatus: 'VALIDATING' as const,
                jobStatus: 'VALIDATING' as const,
                v2JobStatus: 'SUCCEEDED',
              },
              {
                domain: 'INSURANCE',
                businessKey: 'TW03:2025:Q4:published-pair',
                datasetStatus: 'PUBLISHED' as const,
                jobStatus: 'SUCCEEDED' as const,
                v2JobStatus: 'SUCCEEDED',
              },
              {
                domain: 'ONE_STD_COST',
                businessKey: 'TW04:2026:Q4:rejected-pair',
                datasetStatus: 'REJECTED' as const,
                jobStatus: 'REJECTED' as const,
                v2JobStatus: 'SUCCEEDED',
              },
              {
                domain: 'COWOS_S',
                businessKey: 'TW05:2026:Q1:failed-job-pair',
                datasetStatus: 'BUILDING' as const,
                jobStatus: 'FAILED' as const,
                v2JobStatus: 'FAILED',
              },
            ]) {
              const seriesId = await createLegacySeries(client, {
                domain: fixture.domain,
                businessKey: fixture.businessKey,
                lastVersion: 1,
              });
              const versionId = await createLegacyDatasetVersion(
                client,
                seriesId,
                1,
                fixture.datasetStatus,
              );
              const jobId = await createLegacyJob(
                client,
                seriesId,
                versionId,
                fixture.jobStatus,
              );
              seededJobs.push({
                id: jobId,
                legacyStatus: fixture.jobStatus,
                v2Status: fixture.v2JobStatus,
              });
            }

            legacyStateBefore = await readLegacyRoundTripState(client);
          });

          await migrateV2Up(temporaryDatabaseUrl);

          await withClient(temporaryDatabaseUrl, async (client) => {
            const mapped = await client.query<{ id: string; status: string }>(
              `SELECT id, status
               FROM calculation_jobs
               WHERE id = ANY($1::uuid[])
               ORDER BY id`,
              [seededJobs.map((job) => job.id)],
            );
            const mappedById = new Map(
              mapped.rows.map((row) => [row.id, row.status]),
            );
            for (const job of seededJobs) {
              assert.equal(mappedById.get(job.id), job.v2Status);
            }
          });

          await migrateV2Down(temporaryDatabaseUrl);

          await withClient(temporaryDatabaseUrl, async (client) => {
            const restored = await client.query<{ id: string; status: string }>(
              `SELECT id, status
               FROM calculation_jobs
               WHERE id = ANY($1::uuid[])`,
              [seededJobs.map((job) => job.id)],
            );
            const restoredById = new Map(
              restored.rows.map((row) => [row.id, row.status]),
            );
            for (const job of seededJobs) {
              assert.equal(restoredById.get(job.id), job.legacyStatus);
            }

            assert.deepEqual(
              await readLegacyRoundTripState(client),
              legacyStateBefore,
            );

            await assertLegacySchemaRemains(client, 6);

            const legacyConstraint = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM pg_constraint
               WHERE conrelid = 'dataset_series'::regclass
                 AND conname = 'uq_dataset_series_domain_business_key'`,
            );
            assert.equal(legacyConstraint.rows[0]!.count, 1);
          });

          await migrateV2Up(temporaryDatabaseUrl);

          await withClient(temporaryDatabaseUrl, async (client) => {
            const remapped = await client.query<{ id: string; status: string }>(
              `SELECT id, status
               FROM calculation_jobs
               WHERE id = ANY($1::uuid[])`,
              [seededJobs.map((job) => job.id)],
            );
            const remappedById = new Map(
              remapped.rows.map((row) => [row.id, row.status]),
            );
            for (const job of seededJobs) {
              assert.equal(remappedById.get(job.id), job.v2Status);
            }

            const marker = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM pgmigrations
               WHERE name = $1`,
              [V2_MIGRATION_NAME],
            );
            assert.equal(marker.rows[0]!.count, 1);
          });
        });
      },
    );

    await t.test('fails malformed legacy identity atomically', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);
        await withClient(temporaryDatabaseUrl, async (client) => {
          await createLegacySeries(client, {
            domain: 'FAB_COST',
            businessKey: 'TW01:2026Q3:not-canonical',
            lastVersion: 0,
          });
        });

        await expectMigrationFailure(
          migrateV2Up(temporaryDatabaseUrl),
          /Cannot derive canonical identity/,
        );

        await withClient(temporaryDatabaseUrl, async (client) => {
          await assertLegacySchemaRemains(client, 1);
          const result = await client.query<{ business_key: string }>(
            `SELECT business_key FROM dataset_series`,
          );
          assert.equal(result.rows[0]!.business_key, 'TW01:2026Q3:not-canonical');
        });
      });
    });

    await t.test(
      'fails a zero-job legacy dataset version atomically',
      async () => {
        await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
          await migrateLegacyBaseline(temporaryDatabaseUrl);

          let schemaBefore: unknown;
          let dataBefore: unknown;
          await withClient(temporaryDatabaseUrl, async (client) => {
            const seriesId = await createLegacySeries(client, {
              domain: 'DPR',
              businessKey: 'TW01:2026:Q3:orphan-version',
              lastVersion: 1,
            });
            await createLegacyDatasetVersion(client, seriesId, 1, 'DRAFT');

            schemaBefore = await readPublicSchemaState(client);
            dataBefore = await readLegacyOrchestrationData(client);
          });

          await expectMigrationFailure(
            migrateV2Up(temporaryDatabaseUrl),
            /every dataset version must have exactly one calculation job/,
          );

          await withClient(temporaryDatabaseUrl, async (client) => {
            assert.deepEqual(await readPublicSchemaState(client), schemaBefore);
            assert.deepEqual(await readLegacyOrchestrationData(client), dataBefore);
            await assertLegacySchemaRemains(client, 1);

            const v2Relations = await client.query<{
              calculation_types: string | null;
              execution_attempts: string | null;
            }>(
              `SELECT
                 to_regclass('public.calculation_types')::text
                   AS calculation_types,
                 to_regclass('public.execution_attempts')::text
                   AS execution_attempts`,
            );
            assert.equal(v2Relations.rows[0]!.calculation_types, null);
            assert.equal(v2Relations.rows[0]!.execution_attempts, null);
          });
        });
      },
    );

    await t.test('fails canonical identity collision atomically', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);
        await withClient(temporaryDatabaseUrl, async (client) => {
          await createLegacySeries(client, {
            domain: 'DPR',
            businessKey: 'TW01:2026:Q3:source-a',
            lastVersion: 0,
          });
          await createLegacySeries(client, {
            domain: 'DPR',
            businessKey: 'TW01:2026:Q3:source-b',
            lastVersion: 0,
          });
        });

        await expectMigrationFailure(
          migrateV2Up(temporaryDatabaseUrl),
          /multiple business_key values resolve to the same canonical identity/,
        );

        await withClient(temporaryDatabaseUrl, async (client) => {
          await assertLegacySchemaRemains(client, 2);
        });
      });
    });

    await t.test(
      'fails non-empty legacy dependency migration atomically',
      async () => {
        await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
          await migrateLegacyBaseline(temporaryDatabaseUrl);
          await withClient(temporaryDatabaseUrl, async (client) => {
            const seriesId = await createLegacySeries(client, {
              domain: 'CAPEX',
              businessKey: 'TW01:2026:Q2:dependency-history',
              lastVersion: 1,
            });
            const versionId = await createLegacyDatasetVersion(
              client,
              seriesId,
              1,
              'DRAFT',
            );
            const jobId = await createLegacyJob(
              client,
              seriesId,
              versionId,
              'PENDING',
            );
            await client.query(
              `INSERT INTO calculation_dependencies (
                 id,
                 calculation_job_id,
                 dataset_version_id,
                 dependency_type,
                 policy
               ) VALUES ($1, $2, $3, 'FAB_COST_INPUT', 'STRICT')`,
              [randomUUID(), jobId, versionId],
            );
          });

          await expectMigrationFailure(
            migrateV2Up(temporaryDatabaseUrl),
            /cannot safely migrate non-empty calculation_dependencies/i,
          );

          await withClient(temporaryDatabaseUrl, async (client) => {
            await assertLegacySchemaRemains(client, 1);
            const dependencies = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM calculation_dependencies`,
            );
            assert.equal(dependencies.rows[0]!.count, 1);
          });
        });
      },
    );

    await t.test('fails legacy dataset-level FAILED migration atomically', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);
        await withClient(temporaryDatabaseUrl, async (client) => {
          const seriesId = await createLegacySeries(client, {
            domain: 'FAB_COST',
            businessKey: 'TW01:2026:Q1:failed-history',
            lastVersion: 1,
          });
          const versionId = await createLegacyDatasetVersion(
            client,
            seriesId,
            1,
            'FAILED',
          );
          await createLegacyJob(client, seriesId, versionId, 'FAILED');
        });

        await expectMigrationFailure(
          migrateV2Up(temporaryDatabaseUrl),
          /accepted architecture does not define a semantics-preserving dataset-level mapping/,
        );

        await withClient(temporaryDatabaseUrl, async (client) => {
          await assertLegacySchemaRemains(client, 1);
          const result = await client.query<{ status: string }>(
            `SELECT status FROM dataset_versions`,
          );
          assert.equal(result.rows[0]!.status, 'FAILED');
        });
      });
    });

    await t.test(
      'fails mismatched legacy VALIDATING and REJECTED pairs atomically',
      async () => {
        await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
          await migrateLegacyBaseline(temporaryDatabaseUrl);
          await withClient(temporaryDatabaseUrl, async (client) => {
            for (const fixture of [
              {
                domain: 'DPR',
                businessKey: 'TW01:2026:Q2:mismatched-validating',
                datasetStatus: 'VALIDATING' as const,
              },
              {
                domain: 'CAPEX',
                businessKey: 'TW02:2026:Q2:mismatched-rejected',
                datasetStatus: 'REJECTED' as const,
              },
            ]) {
              const seriesId = await createLegacySeries(client, {
                domain: fixture.domain,
                businessKey: fixture.businessKey,
                lastVersion: 1,
              });
              const versionId = await createLegacyDatasetVersion(
                client,
                seriesId,
                1,
                fixture.datasetStatus,
              );
              await createLegacyJob(client, seriesId, versionId, 'SUCCEEDED');
            }
          });

          await expectMigrationFailure(
            migrateV2Up(temporaryDatabaseUrl),
            /Cannot migrate inconsistent legacy validation\/rejection job and dataset statuses/,
          );

          await withClient(temporaryDatabaseUrl, async (client) => {
            await assertLegacySchemaRemains(client, 2);
            const jobs = await client.query<{ status: string }>(
              `SELECT status FROM calculation_jobs`,
            );
            assert.ok(jobs.rows.every((row) => row.status === 'SUCCEEDED'));
          });
        });
      },
    );

    await t.test('rolls back a late up-migration constraint failure atomically', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);

        await withClient(temporaryDatabaseUrl, async (client) => {
          const seriesId = await createLegacySeries(client, {
            domain: 'DPR',
            businessKey: 'TW01:2026:Q3:late-failure',
            lastVersion: 2,
          });
          const draftVersion = await createLegacyDatasetVersion(
            client,
            seriesId,
            1,
            'DRAFT',
          );
          const buildingVersion = await createLegacyDatasetVersion(
            client,
            seriesId,
            2,
            'BUILDING',
          );
          await createLegacyJob(client, seriesId, draftVersion, 'PENDING');
          await createLegacyJob(client, seriesId, buildingVersion, 'SUCCEEDED');
        });

        await expectMigrationFailure(
          migrateV2Up(temporaryDatabaseUrl),
          /uq_dataset_versions_active_series/,
        );

        await withClient(temporaryDatabaseUrl, async (client) => {
          await assertLegacySchemaRemains(client, 1);
          const statuses = await client.query<{ status: string }>(
            `SELECT status FROM dataset_versions ORDER BY version`,
          );
          assert.deepEqual(
            statuses.rows.map((row) => row.status),
            ['DRAFT', 'BUILDING'],
          );
          const v2Table = await client.query<{ name: string | null }>(
            `SELECT to_regclass('public.calculation_types')::text AS name`,
          );
          assert.equal(v2Table.rows[0]!.name, null);
        });
      });
    });

    await t.test('rejects a legacy allocation counter below existing history', async () => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateLegacyBaseline(temporaryDatabaseUrl);
        await withClient(temporaryDatabaseUrl, async (client) => {
          const seriesId = await createLegacySeries(client, {
            domain: 'CAPEX',
            businessKey: 'TW01:2026:Q2:bad-counter',
            lastVersion: 1,
          });
          await createLegacyDatasetVersion(client, seriesId, 2, 'PUBLISHED');
        });

        await expectMigrationFailure(
          migrateV2Up(temporaryDatabaseUrl),
          /last_version is below an existing dataset version/,
        );

        await withClient(temporaryDatabaseUrl, async (client) => {
          await assertLegacySchemaRemains(client, 1);
        });
      });
    });

    await t.test(
      'fails an unsafe multi-job down migration without changing v2 history',
      async () => {
        await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
          await migrateThroughV2(temporaryDatabaseUrl);

          await withClient(temporaryDatabaseUrl, async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'DPR',
              companyCode: 'TW01',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 1,
            });
            const versionId = await createV2DatasetVersion(
              client,
              seriesId,
              1,
              'DRAFT',
            );
            const typeA = await createCalculationType(client, 'DPR', 'TABLE_A');
            const typeB = await createCalculationType(client, 'DPR', 'TABLE_B');
            await createV2Job(client, versionId, typeA);
            await createV2Job(client, versionId, typeB);
          });

          await expectMigrationFailure(
            migrateV2Down(temporaryDatabaseUrl),
            /one or more dataset versions have multiple calculation jobs/,
          );

          await withClient(temporaryDatabaseUrl, async (client) => {
            const marker = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM pgmigrations
               WHERE name = $1`,
              [V2_MIGRATION_NAME],
            );
            assert.equal(marker.rows[0]!.count, 1);

            const jobs = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM calculation_jobs`,
            );
            assert.equal(jobs.rows[0]!.count, 2);

            const v2Table = await client.query<{ name: string | null }>(
              `SELECT to_regclass('public.execution_attempts')::text AS name`,
            );
            assert.notEqual(v2Table.rows[0]!.name, null);
          });
        });
      },
    );

    await t.test(
      'rejects other unrepresentable v2 rollback classes before destructive DDL',
      async (t) => {
        const assertUnsafeDown = async (
          name: string,
          expectedMessage: RegExp,
          seed: (client: Client) => Promise<void>,
          verify: (client: Client) => Promise<void>,
        ): Promise<void> => {
          await t.test(name, async () => {
            await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
              await migrateThroughV2(temporaryDatabaseUrl);
              await withClient(temporaryDatabaseUrl, seed);

              await expectMigrationFailure(
                migrateV2Down(temporaryDatabaseUrl),
                expectedMessage,
              );

              await withClient(temporaryDatabaseUrl, async (client) => {
                await assertV2SchemaRemains(client);
                await verify(client);
              });
            });
          });
        };

        await assertUnsafeDown(
          'execution-attempt history',
          /execution attempt history is not representable/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'DPR',
              companyCode: 'TW31',
              fiscalYear: 2026,
              period: 'Q1',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW31:2026:Q1:attempt-history',
            });
            const versionId = await createV2DatasetVersion(
              client,
              seriesId,
              1,
              'DRAFT',
            );
            const typeId = await createCalculationType(client, 'DPR', 'ATTEMPT');
            const jobId = await createV2Job(client, versionId, typeId);
            await client.query(
              `INSERT INTO execution_attempts (
                 calculation_job_id,
                 attempt_number,
                 status,
                 airflow_dag_id,
                 airflow_dag_run_id
               ) VALUES ($1, 1, 'SUCCEEDED', 'dag_attempt', 'run_attempt')`,
              [jobId],
            );
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM execution_attempts`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'dataset build snapshot',
          /dataset build snapshots are not representable/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'FAB_COST',
              companyCode: 'TW32',
              fiscalYear: 2026,
              period: 'Q2',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW32:2026:Q2:snapshot-history',
            });
            const versionId = await createV2DatasetVersion(
              client,
              seriesId,
              1,
              'PUBLISHED',
            );
            await client.query(
              `INSERT INTO dataset_build_snapshots (dataset_version_id)
               VALUES ($1)`,
              [versionId],
            );
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM dataset_build_snapshots`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'dependency-definition history',
          /dependency definition history is not representable/,
          async (client) => {
            const typeId = await createCalculationType(client, 'DPR', 'DEFINITION');
            await createDependencyDefinition(client, typeId, 1);
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM execution_dependency_definition_versions`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'configured calculation type',
          /calculation type configuration is not representable/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'CAPEX',
              companyCode: 'TW37',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW37:2026:Q3:type-provenance',
            });
            const versionId = await createV2DatasetVersion(
              client,
              seriesId,
              1,
              'DRAFT',
            );
            const type = await client.query<{ id: string }>(
              `INSERT INTO calculation_types (
                 domain,
                 code,
                 airflow_dag_id,
                 is_active
               ) VALUES ('CAPEX', 'LEGACY_DEFAULT', 'legacy_capex', FALSE)
               RETURNING id`,
            );
            await createV2Job(client, versionId, type.rows[0]!.id);
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM calculation_types`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'ABANDONED dataset lifecycle',
          /dataset status ABANDONED has no semantics-preserving legacy status/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'INSURANCE',
              companyCode: 'TW33',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW33:2026:Q3:abandoned-history',
            });
            await createV2DatasetVersion(client, seriesId, 1, 'ABANDONED');
          },
          async (client) => {
            const result = await client.query<{ status: string }>(
              `SELECT status FROM dataset_versions`,
            );
            assert.equal(result.rows[0]!.status, 'ABANDONED');
          },
        );

        await assertUnsafeDown(
          'v2-only lifecycle timestamps',
          /v2 dataset lifecycle timestamps are not representable/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'CAPEX',
              companyCode: 'TW34',
              fiscalYear: 2026,
              period: 'Q4',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW34:2026:Q4:lifecycle-time',
            });
            await client.query(
              `INSERT INTO dataset_versions (
                 id,
                 dataset_series_id,
                 version,
                 status,
                 building_started_at
               ) VALUES ($1, $2, 1, 'BUILDING', NOW())`,
              [randomUUID(), seriesId],
            );
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM dataset_versions
               WHERE building_started_at IS NOT NULL`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'canonical-only series without a legacy bridge',
          /canonical-only dataset series have no legacy business_key bridge/,
          async (client) => {
            await createCanonicalSeries(client, {
              domain: 'COWOS_S',
              companyCode: 'TW35',
              fiscalYear: 2026,
              period: 'Q1',
            });
          },
          async (client) => {
            const result = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM dataset_series
               WHERE legacy_business_key IS NULL`,
            );
            assert.equal(result.rows[0]!.count, 1);
          },
        );

        await assertUnsafeDown(
          'lowered allocation high-water mark',
          /last_allocated_version is below an existing dataset version/,
          async (client) => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'ONE_STD_COST',
              companyCode: 'TW36',
              fiscalYear: 2026,
              period: 'Q2',
              lastAllocatedVersion: 1,
              legacyBusinessKey: 'TW36:2026:Q2:counter-history',
            });
            await createV2DatasetVersion(client, seriesId, 1, 'PUBLISHED');
            await client.query(
              `UPDATE dataset_series
               SET last_allocated_version = 0
               WHERE id = $1`,
              [seriesId],
            );
          },
          async (client) => {
            const result = await client.query<{ value: number }>(
              `SELECT last_allocated_version AS value FROM dataset_series`,
            );
            assert.equal(result.rows[0]!.value, 0);
          },
        );
      },
    );

    await t.test('enforces all v2 invariants with real writes', async (t) => {
      await withTemporaryDatabase(async (temporaryDatabaseUrl) => {
        await migrateThroughV2(temporaryDatabaseUrl);

        await withClient(temporaryDatabaseUrl, async (client) => {
          let versionForJobs = '';
          let typeA = '';
          let typeB = '';
          let jobA = '';
          let jobB = '';

          await t.test('canonical dataset-series identity and checks', async () => {
            await createCanonicalSeries(client, {
              domain: 'FAB_COST',
              companyCode: 'TW01',
              fiscalYear: 2026,
              period: 'Q1',
            });

            await expectPgError(
              createCanonicalSeries(client, {
                domain: 'FAB_COST',
                companyCode: 'TW01',
                fiscalYear: 2026,
                period: 'Q1',
              }),
              '23505',
            );

            await expectPgError(
              createCanonicalSeries(client, {
                domain: 'FAB_COST',
                companyCode: 'TW01',
                fiscalYear: 2026,
                period: 'Q5',
              }),
              '23514',
            );

            await expectPgError(
              createCanonicalSeries(client, {
                domain: 'FAB_COST',
                companyCode: 'TW02',
                fiscalYear: 0,
                period: 'Q1',
              }),
              '23514',
            );

            await expectPgError(
              createCanonicalSeries(client, {
                domain: 'FAB_COST',
                companyCode: 'TW03',
                fiscalYear: 2026,
                period: 'Q1',
                lastAllocatedVersion: -1,
              }),
              '23514',
            );

            await createCanonicalSeries(client, {
              domain: 'FUTURE_DOMAIN',
              companyCode: 'TW99',
              fiscalYear: 2026,
              period: 'Q4',
            });
          });

          await t.test('dataset-version identity, lifecycle, and active uniqueness', async () => {
            const seriesId = await createCanonicalSeries(client, {
              domain: 'DPR',
              companyCode: 'TW10',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 10,
            });

            await createV2DatasetVersion(client, seriesId, 1, 'PUBLISHED');
            await createV2DatasetVersion(client, seriesId, 2, 'REJECTED');
            await createV2DatasetVersion(client, seriesId, 3, 'ABANDONED');

            const terminalCount = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM dataset_versions
               WHERE dataset_series_id = $1
                 AND status IN ('PUBLISHED', 'REJECTED', 'ABANDONED')`,
              [seriesId],
            );
            assert.equal(terminalCount.rows[0]!.count, 3);

            await expectPgError(
              createV2DatasetVersion(client, seriesId, 1, 'PUBLISHED'),
              '23505',
            );

            versionForJobs = await createV2DatasetVersion(
              client,
              seriesId,
              4,
              'DRAFT',
            );

            await expectPgError(
              createV2DatasetVersion(client, seriesId, 5, 'BUILDING'),
              '23505',
            );
            await expectPgError(
              createV2DatasetVersion(client, seriesId, 6, 'VALIDATING'),
              '23505',
            );

            await expectPgError(
              client.query(
                `INSERT INTO dataset_versions (
                   id,
                   dataset_series_id,
                   version,
                   status
                 ) VALUES ($1, $2, 7, 'FAILED')`,
                [randomUUID(), seriesId],
              ),
              '23514',
            );

            await expectPgError(
              client.query(
                `INSERT INTO dataset_versions (
                   id,
                   dataset_series_id,
                   version,
                   status
                 ) VALUES ($1, $2, 0, 'PUBLISHED')`,
                [randomUUID(), seriesId],
              ),
              '23514',
            );
          });

          await t.test('calculation types, definitions, jobs, and their FKs', async () => {
            typeA = await createCalculationType(client, 'DPR', 'TABLE_A');
            typeB = await createCalculationType(client, 'DPR', 'TABLE_B');

            await expectPgError(
              createCalculationType(client, 'DPR', 'TABLE_A'),
              '23505',
            );

            await expectPgError(
              client.query(
                `INSERT INTO calculation_types (
                   domain,
                   code,
                   airflow_dag_id,
                   last_allocated_dependency_definition_version
                 ) VALUES ('DPR', 'INVALID_COUNTER', 'dag_invalid_counter', -1)`,
              ),
              '23514',
            );

            jobA = await createV2Job(client, versionForJobs, typeA);
            jobB = await createV2Job(client, versionForJobs, typeB);

            const jobCount = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM calculation_jobs
               WHERE output_dataset_version_id = $1`,
              [versionForJobs],
            );
            assert.equal(jobCount.rows[0]!.count, 2);

            await expectPgError(
              createV2Job(client, versionForJobs, typeA),
              '23505',
            );

            await expectPgError(
              createV2Job(client, randomUUID(), typeA),
              '23503',
            );
            await expectPgError(
              createV2Job(client, versionForJobs, randomUUID()),
              '23503',
            );

            const definitionA = await createDependencyDefinition(
              client,
              typeA,
              1,
            );
            await expectPgError(
              createDependencyDefinition(client, typeA, 1),
              '23505',
            );
            await expectPgError(
              createDependencyDefinition(client, typeA, 0),
              '23514',
            );
            await expectPgError(
              createDependencyDefinition(client, randomUUID(), 1),
              '23503',
            );

            await client.query(
              `INSERT INTO execution_dependency_definition_dependencies (
                 definition_version_id,
                 required_domain
               ) VALUES ($1, 'FUTURE_UPSTREAM')`,
              [definitionA],
            );
            await expectPgError(
              client.query(
                `INSERT INTO execution_dependency_definition_dependencies (
                   definition_version_id,
                   required_domain
                 ) VALUES ($1, 'FUTURE_UPSTREAM')`,
                [definitionA],
              ),
              '23505',
            );
            await expectPgError(
              client.query(
                `INSERT INTO execution_dependency_definition_dependencies (
                   definition_version_id,
                   required_domain
                 ) VALUES ($1, 'MISSING_DEFINITION')`,
                [randomUUID()],
              ),
              '23503',
            );

            await client.query(
              `UPDATE calculation_jobs
               SET resolved_dependency_definition_version_id = $1
               WHERE id = $2`,
              [definitionA, jobA],
            );

            const otherVersion = await client.query<{ id: string }>(
              `INSERT INTO dataset_versions (
                 id,
                 dataset_series_id,
                 version,
                 status
               )
               SELECT $1, dataset_series_id, 8, 'REJECTED'
               FROM dataset_versions
               WHERE id = $2
               RETURNING id`,
              [randomUUID(), versionForJobs],
            );
            await expectPgError(
              createV2Job(client, otherVersion.rows[0]!.id, typeB, 'PENDING', definitionA),
              '23503',
            );

            for (const legacyStatus of ['VALIDATING', 'REJECTED']) {
              await expectPgError(
                client.query(
                  `UPDATE calculation_jobs SET status = $1 WHERE id = $2`,
                  [legacyStatus, jobB],
                ),
                '23514',
              );
            }
          });

          await t.test('dataset build-snapshot cardinality and series/version pairing', async () => {
            await expectPgError(
              client.query(
                `INSERT INTO dataset_build_snapshots (dataset_version_id)
                 VALUES ($1)`,
                [randomUUID()],
              ),
              '23503',
            );

            const snapshot = await client.query<{ id: string }>(
              `INSERT INTO dataset_build_snapshots (dataset_version_id)
               VALUES ($1)
               RETURNING id`,
              [versionForJobs],
            );

            await expectPgError(
              client.query(
                `INSERT INTO dataset_build_snapshots (dataset_version_id)
                 VALUES ($1)`,
                [versionForJobs],
              ),
              '23505',
            );

            const upstreamSeries = await createCanonicalSeries(client, {
              domain: 'CAPEX',
              companyCode: 'TW10',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 2,
            });
            const upstreamV1 = await createV2DatasetVersion(
              client,
              upstreamSeries,
              1,
              'PUBLISHED',
            );
            const upstreamV2 = await createV2DatasetVersion(
              client,
              upstreamSeries,
              2,
              'PUBLISHED',
            );

            await client.query(
              `INSERT INTO dataset_build_snapshot_dependencies (
                 snapshot_id,
                 upstream_dataset_series_id,
                 upstream_dataset_version_id
               ) VALUES ($1, $2, $3)`,
              [snapshot.rows[0]!.id, upstreamSeries, upstreamV1],
            );

            await expectPgError(
              client.query(
                `INSERT INTO dataset_build_snapshot_dependencies (
                   snapshot_id,
                   upstream_dataset_series_id,
                   upstream_dataset_version_id
                 ) VALUES ($1, $2, $3)`,
                [snapshot.rows[0]!.id, upstreamSeries, upstreamV2],
              ),
              '23505',
            );

            const otherSeries = await createCanonicalSeries(client, {
              domain: 'INSURANCE',
              companyCode: 'TW10',
              fiscalYear: 2026,
              period: 'Q3',
              lastAllocatedVersion: 1,
            });
            const otherUpstreamVersion = await createV2DatasetVersion(
              client,
              otherSeries,
              1,
              'PUBLISHED',
            );
            const secondSnapshot = await client.query<{ id: string }>(
              `INSERT INTO dataset_build_snapshots (dataset_version_id)
               SELECT $1
               FROM dataset_versions
               WHERE id = $2
               RETURNING id`,
              [upstreamV1, versionForJobs],
            );

            await expectPgError(
              client.query(
                `INSERT INTO dataset_build_snapshot_dependencies (
                   snapshot_id,
                   upstream_dataset_series_id,
                   upstream_dataset_version_id
                 ) VALUES ($1, $2, $3)`,
                [secondSnapshot.rows[0]!.id, upstreamSeries, otherUpstreamVersion],
              ),
              '23503',
            );
          });

          await t.test('execution-attempt history, active uniqueness, and Airflow identity', async () => {
            await client.query(
              `INSERT INTO execution_attempts (
                 calculation_job_id,
                 attempt_number,
                 status,
                 airflow_dag_id,
                 airflow_dag_run_id
               ) VALUES ($1, 1, 'SUCCEEDED', 'dag_a', 'run_1')`,
              [jobA],
            );

            await expectPgError(
              client.query(
                `INSERT INTO execution_attempts (
                   calculation_job_id,
                   attempt_number,
                   status,
                   airflow_dag_id,
                   airflow_dag_run_id
                 ) VALUES ($1, 1, 'FAILED', 'dag_a', 'run_duplicate_number')`,
                [jobA],
              ),
              '23505',
            );

            await client.query(
              `INSERT INTO execution_attempts (
                 calculation_job_id,
                 attempt_number,
                 status,
                 airflow_dag_id,
                 airflow_dag_run_id
               ) VALUES
                 ($1, 2, 'FAILED', 'dag_a', 'run_2'),
                 ($1, 3, 'DISPATCH_FAILED', 'dag_a', 'run_3')`,
              [jobA],
            );

            const terminalAttempts = await client.query<{ count: number }>(
              `SELECT COUNT(*)::int AS count
               FROM execution_attempts
               WHERE calculation_job_id = $1
                 AND status IN ('SUCCEEDED', 'FAILED', 'DISPATCH_FAILED')`,
              [jobA],
            );
            assert.equal(terminalAttempts.rows[0]!.count, 3);

            await client.query(
              `INSERT INTO execution_attempts (
                 calculation_job_id,
                 attempt_number,
                 status,
                 airflow_dag_id,
                 airflow_dag_run_id
               ) VALUES ($1, 4, 'PREPARED', 'dag_a', 'run_4')`,
              [jobA],
            );

            for (const [attemptNumber, status] of [
              [5, 'DISPATCHING'],
              [6, 'ACCEPTED'],
            ] as const) {
              await expectPgError(
                client.query(
                  `INSERT INTO execution_attempts (
                     calculation_job_id,
                     attempt_number,
                     status,
                     airflow_dag_id,
                     airflow_dag_run_id
                   ) VALUES ($1, $2, $3, 'dag_a', $4)`,
                  [jobA, attemptNumber, status, `run_${attemptNumber}`],
                ),
                '23505',
              );
            }

            await expectPgError(
              client.query(
                `INSERT INTO execution_attempts (
                   calculation_job_id,
                   attempt_number,
                   status,
                   airflow_dag_id,
                   airflow_dag_run_id
                 ) VALUES ($1, 1, 'SUCCEEDED', 'dag_a', 'run_1')`,
                [jobB],
              ),
              '23505',
            );

            await expectPgError(
              client.query(
                `INSERT INTO execution_attempts (
                   calculation_job_id,
                   attempt_number,
                   status,
                   airflow_dag_id,
                   airflow_dag_run_id
                 ) VALUES ($1, 1, 'SUCCEEDED', 'dag_missing', 'run_missing')`,
                [randomUUID()],
              ),
              '23503',
            );

            await expectPgError(
              client.query(
                `INSERT INTO execution_attempts (
                   calculation_job_id,
                   attempt_number,
                   status,
                   airflow_dag_id,
                   airflow_dag_run_id
                 ) VALUES ($1, 0, 'SUCCEEDED', 'dag_b', 'run_zero')`,
                [jobB],
              ),
              '23514',
            );
          });

          await t.test('rejects every invalid persisted v2 lifecycle value', async () => {
            const statusSeries = await createCanonicalSeries(client, {
              domain: 'STATUS_TEST',
              companyCode: 'TW20',
              fiscalYear: 2026,
              period: 'Q2',
              lastAllocatedVersion: 1,
            });

            await expectPgError(
              client.query(
                `INSERT INTO dataset_versions (
                   id,
                   dataset_series_id,
                   version,
                   status
                 ) VALUES ($1, $2, 1, 'NOT_A_STATUS')`,
                [randomUUID(), statusSeries],
              ),
              '23514',
            );

            await expectPgError(
              client.query(
                `UPDATE calculation_jobs
                 SET status = 'NOT_A_STATUS'
                 WHERE id = $1`,
                [jobB],
              ),
              '23514',
            );

            await expectPgError(
              client.query(
                `INSERT INTO execution_dependency_definition_versions (
                   calculation_type_id,
                   version,
                   status
                 ) VALUES ($1, 1, 'NOT_A_STATUS')`,
                [typeB],
              ),
              '23514',
            );

            await expectPgError(
              client.query(
                `INSERT INTO execution_attempts (
                   calculation_job_id,
                   attempt_number,
                   status,
                   airflow_dag_id,
                   airflow_dag_run_id
                 ) VALUES ($1, 1, 'NOT_A_STATUS', 'dag_b', 'run_invalid')`,
                [jobB],
              ),
              '23514',
            );
          });

          await t.test('creates all partial and lookup indexes required by v2', async () => {
            const expectedIndexFragments = new Map<string, string[]>([
              [
                'idx_calculation_types_active_domain_code',
                ['using btree (domain, code)', 'where is_active'],
              ],
              [
                'idx_dataset_versions_latest_published',
                [
                  'using btree (dataset_series_id, version desc)',
                  'where',
                  "'published'",
                ],
              ],
              [
                'idx_dependency_definition_latest_published',
                [
                  'using btree (calculation_type_id, version desc)',
                  'where',
                  "'published'",
                ],
              ],
              [
                'idx_snapshot_dependencies_upstream_version',
                ['using btree (upstream_dataset_version_id)'],
              ],
              [
                'uq_dataset_versions_active_series',
                [
                  'create unique index',
                  'using btree (dataset_series_id)',
                  'where',
                  "'draft'",
                  "'building'",
                  "'validating'",
                ],
              ],
              [
                'uq_execution_attempt_active_job',
                [
                  'create unique index',
                  'using btree (calculation_job_id)',
                  'where',
                  "'prepared'",
                  "'dispatching'",
                  "'accepted'",
                ],
              ],
            ]);
            const indexes = await client.query<{
              indexname: string;
              indexdef: string;
            }>(
              `SELECT indexname, indexdef
               FROM pg_indexes
               WHERE schemaname = 'public'
                 AND indexname = ANY($1::text[])`,
              [[...expectedIndexFragments.keys()]],
            );
            const definitions = new Map(
              indexes.rows.map((row) => [
                row.indexname,
                row.indexdef.replaceAll('"', '').replace(/\s+/g, ' ').toLowerCase(),
              ]),
            );

            for (const [indexName, fragments] of expectedIndexFragments) {
              const definition = definitions.get(indexName);
              assert.ok(definition, `${indexName} was not created`);
              for (const fragment of fragments) {
                assert.ok(
                  definition.includes(fragment),
                  `${indexName} does not contain ${fragment}: ${definition}`,
                );
              }
            }
          });
        });
      });
    });
  },
);
