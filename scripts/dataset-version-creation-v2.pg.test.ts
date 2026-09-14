import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);
const V2_MIGRATION_NAME = '1788700000000_orchestration-schema-v2';
const ACCEPTED_DOMAINS = [
  'FAB_COST',
  'CAPEX',
  'DPR',
  'INSURANCE',
  'ONE_STD_COST',
  'COWOS_S',
] as const;

const sourceDatabaseUrl = (() => {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must point to the repository PostgreSQL service',
    );
  }
  return value;
})();

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
  assert.match(name, /^dataset_version_v2_test_[a-z0-9_]+$/);
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
  assertSafeDatabaseName(name);
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
  assertSafeDatabaseName(name);
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
  await pool.query(
    `TRUNCATE TABLE dataset_series, calculation_types CASCADE`,
  );
}

async function createCalculationType(
  pool: Pool,
  domain: string,
  code: string,
  isActive = true,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO calculation_types (
       domain,
       code,
       airflow_dag_id,
       is_active
     ) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [domain, code, `test_dag_${randomUUID()}`, isActive],
  );
  return result.rows[0]!.id;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'DPR',
    companyCode: 'TW01',
    fiscalYear: 2026,
    period: 'Q3',
    ...overrides,
  };
}

async function postDatasetVersion(
  app: FastifyInstance,
  payload: object | string,
) {
  return app.inject({
    method: 'POST',
    url: '/dataset-versions',
    headers: typeof payload === 'string'
      ? { 'content-type': 'application/json' }
      : undefined,
    payload,
  });
}

async function readCreationCounts(pool: Pool) {
  const result = await pool.query<{
    series_count: number;
    version_count: number;
    job_count: number;
    snapshot_count: number;
    attempt_count: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM dataset_series) AS series_count,
       (SELECT COUNT(*)::int FROM dataset_versions) AS version_count,
       (SELECT COUNT(*)::int FROM calculation_jobs) AS job_count,
       (SELECT COUNT(*)::int FROM dataset_build_snapshots) AS snapshot_count,
       (SELECT COUNT(*)::int FROM execution_attempts) AS attempt_count`,
  );
  return result.rows[0]!;
}

async function assertNoCreationMutation(pool: Pool): Promise<void> {
  assert.deepEqual(await readCreationCounts(pool), {
    series_count: 0,
    version_count: 0,
    job_count: 0,
    snapshot_count: 0,
    attempt_count: 0,
  });
}

async function seedTerminalDatasetVersion(
  pool: Pool,
  status: 'PUBLISHED' | 'REJECTED' | 'ABANDONED',
): Promise<void> {
  const seriesId = randomUUID();
  const datasetVersionId = randomUUID();
  const calculationTypeId = await createCalculationType(
    pool,
    'DPR',
    `TERMINAL_${status}`,
  );

  await pool.query(
    `INSERT INTO dataset_series (
       id,
       domain,
       company_code,
       fiscal_year,
       period,
       last_allocated_version
     ) VALUES ($1, 'DPR', 'TW01', 2026, 'Q3', 7)`,
    [seriesId],
  );
  await pool.query(
    `INSERT INTO dataset_versions (
       id,
       dataset_series_id,
       version,
       status
     ) VALUES ($1, $2, 7, $3)`,
    [datasetVersionId, seriesId, status],
  );
  await pool.query(
    `INSERT INTO calculation_jobs (
       id,
       output_dataset_version_id,
       calculation_type_id,
       status
     ) VALUES ($1, $2, $3, $4)`,
    [
      randomUUID(),
      datasetVersionId,
      calculationTypeId,
      status === 'ABANDONED' ? 'PENDING' : 'SUCCEEDED',
    ],
  );
}

test(
  'POST /dataset-versions v2 PostgreSQL integration and concurrency',
  { concurrency: false },
  async (t) => {
    const databaseName = [
      'dataset_version_v2_test',
      process.pid.toString(36),
      randomUUID().replaceAll('-', '').slice(0, 16),
    ].join('_');
    const temporaryDatabaseUrl = urlForDatabase(databaseName);
    const previousDatabaseUrl = process.env.DATABASE_URL;
    let app: FastifyInstance | undefined;
    let applicationPool: Pool | undefined;

    await createTemporaryDatabase(databaseName);
    try {
      await migrateFreshDatabase(temporaryDatabaseUrl);
      process.env.DATABASE_URL = temporaryDatabaseUrl;

      const appModule = await import('../src/app.js');
      const poolModule = await import('../src/db/pool.js');
      applicationPool = poolModule.pool;
      app = await appModule.buildApp({ logger: false });

      const migration = await applicationPool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM pgmigrations
         WHERE name = $1`,
        [V2_MIGRATION_NAME],
      );
      assert.equal(migration.rows[0]!.count, 1);

      await t.test('returns the happy-path route contract and freezes active types', async () => {
        await resetOrchestrationData(applicationPool!);
        const activeTypes = new Map([
          ['ASSET_SUMMARY', await createCalculationType(applicationPool!, 'DPR', 'ASSET_SUMMARY')],
          ['TABLE_X', await createCalculationType(applicationPool!, 'DPR', 'TABLE_X')],
          ['TABLE_Y', await createCalculationType(applicationPool!, 'DPR', 'TABLE_Y')],
        ]);
        const inactiveTypeId = await createCalculationType(
          applicationPool!,
          'DPR',
          'INACTIVE_TABLE',
          false,
        );

        const response = await postDatasetVersion(app!, validPayload());
        assert.equal(response.statusCode, 201);
        const body = response.json() as {
          datasetSeriesId: string;
          datasetVersionId: string;
          version: number;
          datasetStatus: string;
          calculationJobs: Array<{
            jobId: string;
            calculationTypeId: string;
            calculationTypeCode: string;
            jobStatus: string;
          }>;
        };
        assert.equal(typeof body.datasetSeriesId, 'string');
        assert.equal(typeof body.datasetVersionId, 'string');
        assert.equal(body.version, 1);
        assert.equal(body.datasetStatus, 'DRAFT');
        assert.deepEqual(
          body.calculationJobs.map((job) => ({
            calculationTypeId: job.calculationTypeId,
            calculationTypeCode: job.calculationTypeCode,
            jobStatus: job.jobStatus,
          })),
          [...activeTypes].map(([code, id]) => ({
            calculationTypeId: id,
            calculationTypeCode: code,
            jobStatus: 'PENDING',
          })),
        );
        assert.ok(body.calculationJobs.every((job) => typeof job.jobId === 'string'));

        const series = await applicationPool!.query(
          `SELECT * FROM dataset_series WHERE id = $1`,
          [body.datasetSeriesId],
        );
        assert.equal(series.rows.length, 1);
        assert.equal(series.rows[0].domain, 'DPR');
        assert.equal(series.rows[0].company_code, 'TW01');
        assert.equal(series.rows[0].fiscal_year, 2026);
        assert.equal(series.rows[0].period, 'Q3');
        assert.equal(series.rows[0].legacy_business_key, null);
        assert.equal(series.rows[0].last_allocated_version, 1);

        const versions = await applicationPool!.query(
          `SELECT id, version, status
           FROM dataset_versions
           WHERE dataset_series_id = $1`,
          [body.datasetSeriesId],
        );
        assert.deepEqual(versions.rows, [{
          id: body.datasetVersionId,
          version: 1,
          status: 'DRAFT',
        }]);

        const jobsBeforeConfigurationChange = await applicationPool!.query<{
          id: string;
          calculation_type_id: string;
          code: string;
          status: string;
        }>(
          `SELECT cj.id, cj.calculation_type_id, ct.code, cj.status
           FROM calculation_jobs cj
           JOIN calculation_types ct ON ct.id = cj.calculation_type_id
           WHERE cj.output_dataset_version_id = $1
           ORDER BY ct.code`,
          [body.datasetVersionId],
        );
        assert.deepEqual(
          jobsBeforeConfigurationChange.rows.map((row) => row.code),
          ['ASSET_SUMMARY', 'TABLE_X', 'TABLE_Y'],
        );
        assert.ok(jobsBeforeConfigurationChange.rows.every(
          (row) => row.status === 'PENDING',
        ));
        assert.ok(jobsBeforeConfigurationChange.rows.every(
          (row) => row.calculation_type_id !== inactiveTypeId,
        ));

        await applicationPool!.query(
          `UPDATE calculation_types
           SET is_active = CASE
             WHEN code = 'INACTIVE_TABLE' THEN TRUE
             WHEN code = 'TABLE_Y' THEN FALSE
             ELSE is_active
           END
           WHERE domain = 'DPR'`,
        );
        const frozenJobs = await applicationPool!.query(
          `SELECT id, calculation_type_id, status
           FROM calculation_jobs
           WHERE output_dataset_version_id = $1
           ORDER BY id`,
          [body.datasetVersionId],
        );
        assert.deepEqual(
          frozenJobs.rows,
          [...jobsBeforeConfigurationChange.rows]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((row) => ({
              id: row.id,
              calculation_type_id: row.calculation_type_id,
              status: row.status,
            })),
        );

        assert.deepEqual(await readCreationCounts(applicationPool!), {
          series_count: 1,
          version_count: 1,
          job_count: 3,
          snapshot_count: 0,
          attempt_count: 0,
        });
      });

      await t.test('returns INVALID_REQUEST for malformed requests', async () => {
        await resetOrchestrationData(applicationPool!);
        const malformedPayloads: Array<object | string> = [
          {},
          [],
          validPayload({ companyCode: '' }),
          validPayload({ companyCode: ' TW01' }),
          validPayload({ fiscalYear: 0 }),
          validPayload({ fiscalYear: '2026' }),
          validPayload({ version: 1 }),
          '{"domain":',
        ];

        for (const payload of malformedPayloads) {
          const response = await postDatasetVersion(app!, payload);
          assert.equal(response.statusCode, 400);
          assert.equal(response.json().code, 'INVALID_REQUEST');
        }
        await assertNoCreationMutation(applicationPool!);
      });

      await t.test('returns INVALID_PERIOD without database mutation', async () => {
        await resetOrchestrationData(applicationPool!);
        for (const period of ['Q5', 'q3']) {
          const response = await postDatasetVersion(
            app!,
            validPayload({ period }),
          );
          assert.equal(response.statusCode, 400);
          assert.equal(response.json().code, 'INVALID_PERIOD');
        }
        await assertNoCreationMutation(applicationPool!);
      });

      await t.test('accepts all six canonical domain identifiers', async () => {
        await resetOrchestrationData(applicationPool!);
        for (const [index, domain] of ACCEPTED_DOMAINS.entries()) {
          await createCalculationType(applicationPool!, domain, 'PRIMARY');
          const response = await postDatasetVersion(
            app!,
            validPayload({ domain, companyCode: `TW${index + 10}` }),
          );
          assert.equal(response.statusCode, 201, domain);
          assert.equal(response.json().calculationJobs.length, 1);
        }

        assert.deepEqual(await readCreationCounts(applicationPool!), {
          series_count: 6,
          version_count: 6,
          job_count: 6,
          snapshot_count: 0,
          attempt_count: 0,
        });
      });

      await t.test('returns INVALID_DOMAIN without database mutation', async () => {
        await resetOrchestrationData(applicationPool!);
        for (const domain of ['UNKNOWN', 'FAB COST', 'ONE STD COST', 'COWOS-S']) {
          const response = await postDatasetVersion(
            app!,
            validPayload({ domain }),
          );
          assert.equal(response.statusCode, 400);
          assert.equal(response.json().code, 'INVALID_DOMAIN');
        }
        await assertNoCreationMutation(applicationPool!);
      });

      await t.test('rolls back fully when no active calculation type exists', async () => {
        await resetOrchestrationData(applicationPool!);
        await createCalculationType(applicationPool!, 'DPR', 'INACTIVE_ONLY', false);

        const response = await postDatasetVersion(app!, validPayload());
        assert.equal(response.statusCode, 409);
        assert.equal(response.json().code, 'CALCULATION_TYPE_NOT_CONFIGURED');
        await assertNoCreationMutation(applicationPool!);

        const types = await applicationPool!.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM calculation_types`,
        );
        assert.equal(types.rows[0]!.count, 1);

        const existingSeriesId = randomUUID();
        await applicationPool!.query(
          `INSERT INTO dataset_series (
             id,
             domain,
             company_code,
             fiscal_year,
             period,
             last_allocated_version
           ) VALUES ($1, 'DPR', 'TW01', 2026, 'Q3', 5)`,
          [existingSeriesId],
        );

        const existingSeriesResponse = await postDatasetVersion(
          app!,
          validPayload(),
        );
        assert.equal(existingSeriesResponse.statusCode, 409);
        assert.equal(
          existingSeriesResponse.json().code,
          'CALCULATION_TYPE_NOT_CONFIGURED',
        );

        const existingSeries = await applicationPool!.query<{
          last_allocated_version: number;
        }>(
          `SELECT last_allocated_version
           FROM dataset_series
           WHERE id = $1`,
          [existingSeriesId],
        );
        assert.equal(existingSeries.rows[0]!.last_allocated_version, 5);
        const versionCount = await applicationPool!.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM dataset_versions`,
        );
        assert.equal(versionCount.rows[0]!.count, 0);
      });

      await t.test('returns ACTIVE_DATASET_VERSION_EXISTS without allocation', async () => {
        await resetOrchestrationData(applicationPool!);
        await createCalculationType(applicationPool!, 'DPR', 'PRIMARY');

        const created = await postDatasetVersion(app!, validPayload());
        assert.equal(created.statusCode, 201);
        const conflict = await postDatasetVersion(app!, validPayload());
        assert.equal(conflict.statusCode, 409);
        assert.equal(conflict.json().code, 'ACTIVE_DATASET_VERSION_EXISTS');

        const state = await applicationPool!.query<{
          last_allocated_version: number;
          version_count: number;
          job_count: number;
        }>(
          `SELECT
             ds.last_allocated_version,
             COUNT(DISTINCT dv.id)::int AS version_count,
             COUNT(DISTINCT cj.id)::int AS job_count
           FROM dataset_series ds
           LEFT JOIN dataset_versions dv ON dv.dataset_series_id = ds.id
           LEFT JOIN calculation_jobs cj ON cj.output_dataset_version_id = dv.id
           GROUP BY ds.id`,
        );
        assert.deepEqual(state.rows, [{
          last_allocated_version: 1,
          version_count: 1,
          job_count: 1,
        }]);
      });

      for (const terminalStatus of [
        'PUBLISHED',
        'REJECTED',
        'ABANDONED',
      ] as const) {
        await t.test(`allocates N+1 after ${terminalStatus}`, async () => {
          await resetOrchestrationData(applicationPool!);
          await seedTerminalDatasetVersion(applicationPool!, terminalStatus);

          const response = await postDatasetVersion(app!, validPayload());
          assert.equal(response.statusCode, 201);
          assert.equal(response.json().version, 8);

          const state = await applicationPool!.query<{
            last_allocated_version: number;
            versions: number[];
          }>(
            `SELECT
               ds.last_allocated_version,
               ARRAY_AGG(dv.version ORDER BY dv.version) AS versions
             FROM dataset_series ds
             JOIN dataset_versions dv ON dv.dataset_series_id = ds.id
             GROUP BY ds.id`,
          );
          assert.deepEqual(state.rows, [{
            last_allocated_version: 8,
            versions: [7, 8],
          }]);
        });
      }

      await t.test('serializes 20 same-series creates through the series row', async () => {
        await resetOrchestrationData(applicationPool!);
        for (const code of ['ASSET_SUMMARY', 'TABLE_X', 'TABLE_Y']) {
          await createCalculationType(applicationPool!, 'DPR', code);
        }
        await createCalculationType(applicationPool!, 'DPR', 'INACTIVE', false);

        const responses = await Promise.all(
          Array.from({ length: 20 }, () =>
            postDatasetVersion(app!, validPayload()),
          ),
        );
        const successes = responses.filter((response) => response.statusCode === 201);
        const conflicts = responses.filter((response) => response.statusCode === 409);
        assert.equal(successes.length, 1);
        assert.equal(conflicts.length, 19);
        assert.ok(conflicts.every(
          (response) => response.json().code === 'ACTIVE_DATASET_VERSION_EXISTS',
        ));
        assert.equal(successes[0]!.json().calculationJobs.length, 3);

        const state = await applicationPool!.query<{
          series_count: number;
          last_allocated_version: number;
          draft_count: number;
          job_count: number;
          pending_count: number;
        }>(
          `SELECT
             COUNT(DISTINCT ds.id)::int AS series_count,
             MAX(ds.last_allocated_version)::int AS last_allocated_version,
             COUNT(DISTINCT dv.id) FILTER (WHERE dv.status = 'DRAFT')::int
               AS draft_count,
             COUNT(DISTINCT cj.id)::int AS job_count,
             COUNT(DISTINCT cj.id) FILTER (WHERE cj.status = 'PENDING')::int
               AS pending_count
           FROM dataset_series ds
           LEFT JOIN dataset_versions dv ON dv.dataset_series_id = ds.id
           LEFT JOIN calculation_jobs cj ON cj.output_dataset_version_id = dv.id
           WHERE ds.domain = 'DPR'
             AND ds.company_code = 'TW01'
             AND ds.fiscal_year = 2026
             AND ds.period = 'Q3'`,
        );
        assert.deepEqual(state.rows[0], {
          series_count: 1,
          last_allocated_version: 1,
          draft_count: 1,
          job_count: 3,
          pending_count: 3,
        });
        const counts = await readCreationCounts(applicationPool!);
        assert.equal(counts.snapshot_count, 0);
        assert.equal(counts.attempt_count, 0);
      });

      await t.test('creates different series concurrently without a global lock', async () => {
        await resetOrchestrationData(applicationPool!);
        await createCalculationType(applicationPool!, 'DPR', 'TABLE_X');
        await createCalculationType(applicationPool!, 'DPR', 'TABLE_Y');

        const responses = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            postDatasetVersion(
              app!,
              validPayload({ companyCode: `COMPANY_${index + 1}` }),
            ),
          ),
        );
        assert.ok(responses.every((response) => response.statusCode === 201));
        assert.ok(responses.every((response) => response.json().version === 1));

        const counters = await applicationPool!.query<{
          count: number;
          min_version: number;
          max_version: number;
        }>(
          `SELECT
             COUNT(*)::int AS count,
             MIN(last_allocated_version)::int AS min_version,
             MAX(last_allocated_version)::int AS max_version
           FROM dataset_series`,
        );
        assert.deepEqual(counters.rows[0], {
          count: 20,
          min_version: 1,
          max_version: 1,
        });
        assert.deepEqual(await readCreationCounts(applicationPool!), {
          series_count: 20,
          version_count: 20,
          job_count: 40,
          snapshot_count: 0,
          attempt_count: 0,
        });
      });

      await t.test('does not register superseded calculation-job mutation routes', async () => {
        await resetOrchestrationData(applicationPool!);
        await createCalculationType(applicationPool!, 'DPR', 'PRIMARY');

        const creation = await postDatasetVersion(app!, validPayload());
        assert.equal(creation.statusCode, 201);
        const { datasetVersionId, calculationJobs } = creation.json() as {
          datasetVersionId: string;
          calculationJobs: Array<{ jobId: string }>;
        };
        assert.equal(calculationJobs.length, 1);
        const jobId = calculationJobs[0]!.jobId;

        const legacyCreateResponse = await app!.inject({
          method: 'POST',
          url: '/calculation-jobs',
          payload: {
            domain: 'DPR',
            businessKey: 'legacy',
            dependencies: [],
          },
        });
        assert.equal(legacyCreateResponse.statusCode, 404);

        for (const action of [
          'start',
          'submit-validation',
          'publish',
          'reject',
          'fail',
        ]) {
          const response = await app!.inject({
            method: 'POST',
            url: `/calculation-jobs/${jobId}/${action}`,
          });
          assert.equal(response.statusCode, 404, action);
        }

        const persistedState = await applicationPool!.query<{
          dataset_status: string;
          job_status: string;
          snapshot_count: number;
          attempt_count: number;
        }>(
          `SELECT
             dv.status AS dataset_status,
             cj.status AS job_status,
             (SELECT COUNT(*)::int FROM dataset_build_snapshots)
               AS snapshot_count,
             (SELECT COUNT(*)::int FROM execution_attempts)
               AS attempt_count
           FROM dataset_versions dv
           JOIN calculation_jobs cj
             ON cj.output_dataset_version_id = dv.id
           WHERE dv.id = $1`,
          [datasetVersionId],
        );
        assert.deepEqual(persistedState.rows, [{
          dataset_status: 'DRAFT',
          job_status: 'PENDING',
          snapshot_count: 0,
          attempt_count: 0,
        }]);
      });
    } finally {
      if (app) {
        await app.close();
      }
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
