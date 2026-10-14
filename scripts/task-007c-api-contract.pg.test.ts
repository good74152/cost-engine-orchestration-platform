import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runner } from 'node-pg-migrate';
import { Client, type Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { CalculationExecutor } from '../src/executors/calculation-executor.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';
import { createConfiguredCalculationExecutor } from '../src/executors/executor-factory.js';

const sourceUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('Task 007C needs TEST_DATABASE_URL or DATABASE_URL');
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

function connection(database: string): string {
  const url = new URL(sourceUrl!);
  url.pathname = '/' + database;
  return url.toString();
}

function expectError(response: Response, status: number, code: string): void {
  assert.equal(response.statusCode, status, response.body);
  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['code', 'message']);
  assert.equal(body.code, code);
  assert.equal(typeof body.message, 'string');
  assert.doesNotMatch(body.message as string, /SQLSTATE|constraint|uq_|ck_|postgresql:\/\/|SELECT |INSERT /i);
}

test('Task 007C API contract: real migrated PostgreSQL', { concurrency: false }, async (t) => {
  const dbName = `task_007c_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(dbName, /^task_007c_test_[a-z0-9_]+$/);
  assert.ok(dbName.length <= 63);
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  const admin = new Client({ connectionString: connection('postgres') });
  let databaseCreated = false;
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE template0`);
    databaseCreated = true;
    await runner({
      databaseUrl: connection(dbName),
      dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations',
      direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    process.env.DATABASE_URL = connection(dbName);
    process.env.NODE_ENV = 'test';
    const [{ pool: applicationPool }, { buildApp }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'),
    ]);
    pool = applicationPool;
    const fake = new FakeExecutor();
    app = await buildApp({ logger: false, calculationExecutor: fake, nodeEnvironment: 'test' });
    const version = await pool.query<{ version: string }>('SELECT version() AS version');
    console.log('TASK007C_RUNTIME', JSON.stringify({
      node: process.version, postgres: version.rows[0]!.version,
      database: 'Owned task_007c_test_* database, template0, migrated and dropped in finally',
    }));

    async function jsonPost(url: string, body: unknown): Promise<Response> {
      return app!.inject({
        method: 'POST', url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });
    }
    async function countRows() {
      const query = `SELECT
        (SELECT COUNT(*)::int FROM dataset_versions) AS datasets,
        (SELECT COUNT(*)::int FROM calculation_jobs) AS jobs,
        (SELECT COUNT(*)::int FROM execution_attempts) AS attempts,
        (SELECT COUNT(*)::int FROM raw_ingestion_series) AS raw_series,
        (SELECT COUNT(*)::int FROM raw_ingestion_batches) AS raw_batches`;
      return (await pool!.query(query)).rows[0];
    }

    await t.test('Fastify parser client errors remain 400/413/415, not generic 500', async () => {
      const before = await countRows();
      const cases = [
        { name: 'malformed JSON', contentType: 'application/json',
          body: '{"domain":"DPR_RAW","businessKey":', expected: 400 },
        { name: 'body exceeds Fastify 1 MiB limit', contentType: 'application/json',
          body: JSON.stringify({ domain: 'DPR_RAW', businessKey: 'x'.repeat(1_100_000) }), expected: 413 },
        { name: 'unsupported media type', contentType: 'application/xml',
          body: '<raw-ingestion/>', expected: 415 },
      ] as const;
      for (const scenario of cases) {
        const response = await app!.inject({
          method: 'POST', url: '/raw-ingestion-batches',
          headers: { 'content-type': scenario.contentType },
          payload: scenario.body,
        });
        expectError(response, scenario.expected, 'INVALID_REQUEST');
      }
      assert.deepEqual(await countRows(), before, 'Framework parser must reject before persistence');
      assert.equal(fake.getDispatchHistory().length, 0);
      assert.equal(fake.getStatusLookupHistory().length, 0);
    });

    await t.test('NUL in either callback identity is rejected without lookup or mutation', async () => {
      const before = await countRows();
      const lookupsBefore = fake.getStatusLookupHistory().length;
      for (const identity of [
        { airflowDagId: 'dag\u0000invalid', airflowDagRunId: 'run-123' },
        { airflowDagId: 'dag-valid', airflowDagRunId: 'run\u0000invalid' },
      ]) {
        expectError(await jsonPost('/executor-callbacks/airflow', identity), 400, 'INVALID_REQUEST');
      }
      assert.equal(fake.getStatusLookupHistory().length, lookupsBefore);
      assert.deepEqual(await countRows(), before);
    });

    await t.test('NUL in raw-ingestion businessKey is rejected without persistence', async () => {
      const before = await countRows();
      expectError(await jsonPost('/raw-ingestion-batches', {
        domain: 'DPR_RAW', businessKey: 'ABC\u0000DEF',
      }), 400, 'INVALID_REQUEST');
      assert.deepEqual(await countRows(), before);
    });

    await t.test('Run and Reconcile malformed job UUID 400; valid unknown UUID 404', async () => {
      const before = await countRows();
      const malformed = [
        'not-a-uuid', 'undefined', 'null', '123',
        '00000000-0000-0000-0000-00000000000',
        'z0000000-0000-0000-0000-000000000000', 'x'.repeat(300),
      ];
      for (const command of ['run', 'reconcile']) {
        for (const value of malformed) {
          const response = await app!.inject({
            method: 'POST', url: `/calculation-jobs/${value}/${command}`,
          });
          expectError(response, 400, 'INVALID_REQUEST');
          assert.match(response.json().message, /jobId.*path parameter.*UUID/i);
        }
        expectError(await app!.inject({
          method: 'POST', url: `/calculation-jobs/${randomUUID()}/${command}`,
        }), 404, 'CALCULATION_JOB_NOT_FOUND');
      }
      assert.deepEqual(await countRows(), before);
      assert.equal(fake.getDispatchHistory().length, 0);
      assert.equal(fake.getStatusLookupHistory().length, 0);
    });

    await t.test('four dataset lifecycle paths retain UUID validation and unknown-ID contract', async () => {
      const before = await countRows();
      for (const command of ['submit-validation', 'publish', 'reject', 'abandon']) {
        for (const value of ['not-a-uuid', 'undefined', '00000000000000000000000000000000']) {
          expectError(await app!.inject({
            method: 'POST', url: `/dataset-versions/${value}/${command}`,
          }), 400, 'INVALID_REQUEST');
        }
        expectError(await app!.inject({
          method: 'POST', url: `/dataset-versions/${randomUUID()}/${command}`,
        }), 404, 'DATASET_VERSION_NOT_FOUND');
      }
      assert.deepEqual(await countRows(), before);
    });

    await t.test('callback body contract, 250/251 length boundary and forged status', async () => {
      const before = await countRows();
      const invalid: unknown[] = [
        null, [], {}, { airflowDagId: 'dag' }, { airflowDagRunId: 'run' },
        { airflowDagId: 'dag', airflowDagRunId: 'run', status: 'SUCCEEDED' },
        { airflowDagId: 1, airflowDagRunId: 'run' },
        { airflowDagId: 'dag', airflowDagRunId: 2 },
        { airflowDagId: '', airflowDagRunId: 'run' },
        { airflowDagId: 'dag', airflowDagRunId: '' },
        { airflowDagId: 'a'.repeat(251), airflowDagRunId: 'run' },
        { airflowDagId: 'dag', airflowDagRunId: 'r'.repeat(251) },
      ];
      for (const body of invalid) {
        expectError(await jsonPost('/executor-callbacks/airflow', body), 400, 'INVALID_REQUEST');
      }
      expectError(await jsonPost('/executor-callbacks/airflow', {
        airflowDagId: 'a'.repeat(250), airflowDagRunId: 'r'.repeat(250),
      }), 404, 'EXECUTION_ATTEMPT_NOT_FOUND');
      assert.equal(fake.getStatusLookupHistory().length, 0);
      assert.deepEqual(await countRows(), before);
    });

    await t.test('raw-ingestion request validation, valid DTO and 255 boundary', async () => {
      const before = await countRows();
      const malformed: unknown[] = [
        null, [], {}, { domain: 'DPR_RAW' }, { businessKey: 'batch' },
        { domain: 'DPR_RAW', businessKey: 'batch', extra: true },
        { domain: 42, businessKey: 'batch' },
        { domain: 'UNKNOWN_RAW', businessKey: 'batch' },
        { domain: 'DPR_RAW', businessKey: null },
        { domain: 'DPR_RAW', businessKey: '' },
        { domain: 'DPR_RAW', businessKey: 'x'.repeat(256) },
      ];
      for (const body of malformed) expectError(await jsonPost('/raw-ingestion-batches', body), 400, 'INVALID_REQUEST');
      assert.deepEqual(await countRows(), before);
      for (const domain of ['FAB_COST_RAW', 'CAPEX_RAW', 'DPR_RAW']) {
        const response = await jsonPost('/raw-ingestion-batches', { domain, businessKey: randomUUID() });
        assert.equal(response.statusCode, 201, response.body);
        assert.deepEqual(Object.keys(response.json()).sort(), ['batchId', 'batchSequence', 'ingestionSeriesId', 'status']);
        assert.equal(response.json().status, 'LOADING');
        assert.equal(response.json().batchSequence, 1);
      }
      const atLimit = await jsonPost('/raw-ingestion-batches', {
        domain: 'DPR_RAW', businessKey: 'k'.repeat(255),
      });
      assert.equal(atLimit.statusCode, 201, atLimit.body);
      const afterValid = await countRows();
      expectError(await jsonPost('/raw-ingestion-batches', {
        domain: 'DPR_RAW', businessKey: 'x'.repeat(256),
      }), 400, 'INVALID_REQUEST');
      assert.deepEqual(await countRows(), afterValid);
    });

    await t.test('raw-ingestion 20-way contention retains one 201 and nineteen 409', async () => {
      const body = { domain: 'DPR_RAW', businessKey: `007C:${randomUUID()}` };
      const responses = await Promise.all(Array.from({ length: 20 },
        () => jsonPost('/raw-ingestion-batches', body)));
      const successes = responses.filter((r) => r.statusCode === 201);
      const conflicts = responses.filter((r) => r.statusCode === 409);
      assert.equal(successes.length, 1);
      assert.equal(conflicts.length, 19);
      for (const response of conflicts) expectError(response, 409, 'ACTIVE_RAW_INGESTION_BATCH_EXISTS');
      const batchId = successes[0]!.json().ingestionSeriesId;
      const count = await pool!.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM raw_ingestion_batches WHERE ingestion_series_id = $1', [batchId]);
      assert.equal(count.rows[0]!.count, 1);
    });

    await t.test('Fake control routes fail closed; factory cannot override runtime production/staging', async () => {
      const prior = process.env.NODE_ENV;
      const control = '/internal/fake-executor/executions/unknown/succeed';
      const nonFake: CalculationExecutor = {
        async dispatch() { return { kind: 'UNKNOWN', message: 'unused' }; },
        async getExecutionStatus() { return { kind: 'NOT_FOUND' }; },
      };
      try {
        const scenarios: Array<{ runtime?: string; option?: string; actualFake: boolean; enabled: boolean }> = [
          { runtime: 'test', option: 'test', actualFake: true, enabled: true },
          { runtime: 'development', option: 'development', actualFake: true, enabled: true },
          { runtime: undefined, option: 'test', actualFake: true, enabled: true },
          { runtime: 'production', option: 'test', actualFake: true, enabled: false },
          { runtime: 'staging', option: 'test', actualFake: true, enabled: false },
          { runtime: 'test', option: 'production', actualFake: true, enabled: false },
          { runtime: undefined, option: undefined, actualFake: true, enabled: false },
          { runtime: 'unknown', option: undefined, actualFake: true, enabled: false },
          { runtime: 'test', option: 'test', actualFake: false, enabled: false },
        ];
        for (const scenario of scenarios) {
          if (scenario.runtime === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = scenario.runtime;
          const instance = await buildApp({
            logger: false,
            calculationExecutor: scenario.actualFake ? new FakeExecutor() : nonFake,
            ...(scenario.option !== undefined ? { nodeEnvironment: scenario.option } : {}),
          });
          try {
            const response = await instance.inject({ method: 'POST', url: control });
            assert.equal(response.statusCode, 404);
            if (scenario.enabled) expectError(response, 404, 'FAKE_EXECUTION_NOT_FOUND');
            else {
              assert.notEqual(response.json().code, 'FAKE_EXECUTION_NOT_FOUND');
              assert.match(response.json().message, /Route POST:.*not found/i);
            }
          } finally { await instance.close(); }
        }
        for (const runtime of ['production', 'staging', 'unknown'] as const) {
          process.env.NODE_ENV = runtime;
          assert.throws(() => createConfiguredCalculationExecutor({ executorType: 'fake' }),
            /production|development or test/);
          assert.throws(() => createConfiguredCalculationExecutor({
            executorType: 'fake', nodeEnvironment: 'test',
          }), /production|development or test/);
        }
        delete process.env.NODE_ENV;
        assert.throws(() => createConfiguredCalculationExecutor({ executorType: 'fake' }),
          /development or test/);
        assert.ok(createConfiguredCalculationExecutor({
          executorType: 'fake', nodeEnvironment: 'test',
        }) instanceof FakeExecutor);
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });
  } finally {
    try { if (app) await app.close(); }
    finally {
      try { if (pool) await pool.end(); }
      finally {
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        try { if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
        finally { await admin.end(); }
      }
    }
  }
});
