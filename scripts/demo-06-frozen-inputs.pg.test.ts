import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';

const source = process.env.TEST_DATABASE_URL;
if (!source) throw new Error('Demo-06 requires an explicit disposable TEST_DATABASE_URL');
const connection = (name: string) => { const url = new URL(source); url.pathname = '/' + name; return url.toString(); };

interface FrozenInput { domain: string; fiscalYear: number; period: string; version: number }
interface DatasetRead { datasetVersionId: string; domain: string; version: number; frozenInputs: FrozenInput[] }
interface Created { datasetVersionId: string; calculationJobs: { jobId: string }[] }

test('Demo-06: read APIs expose frozen input versions and nothing else', { timeout: 120_000 }, async t => {
  const name = `demo_06_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_06_[a-z0-9_]+$/);
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const prior = { ...process.env }; let created = false; let db: Pool | undefined; let app: FastifyInstance | undefined;
  const ends: Promise<void>[] = [];
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await runner({ databaseUrl: connection(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = connection(name); process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }, { DemoRuntime }, { seedDemoSixDomainConfiguration }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'),
      import('./seed-demo-six-domain-configuration.js'),
    ]);
    db = pool; pool.on('connect', c => ends.push(new Promise<void>(done => c.once('end', done))));
    await seedDemoSixDomainConfiguration(pool);
    const runtime = new DemoRuntime(pool, 'test', {}, { log() {} }); await runtime.reset.startServer();
    app = await buildApp({ appMode: 'demo', demoRuntime: runtime, nodeEnvironment: 'test', logger: false, demoSession: { origin: 'https://demo.test' } });
    const server = app;

    const post = (url: string, cookie?: string, payload: unknown = {}) => server.inject({ method: 'POST', url, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-demo-session': '1', origin: 'https://demo.test', ...(cookie ? { cookie } : {}) } });
    const get = (url: string, cookie: string) => server.inject({ method: 'GET', url, headers: { cookie } });
    const session = async () => {
      const response = await post('/demo/sessions'); assert.equal(response.statusCode, 201, response.body);
      const header = response.headers['set-cookie']; assert.ok(typeof header === 'string');
      return header.split(';', 1)[0]!;
    };
    const ok = async (url: string, cookie: string, payload: unknown = {}) => {
      const response = await post(url, cookie, payload);
      assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${url}: ${response.body}`);
      return response.json();
    };
    const finishedRun = { simulation: { dispatch: 'ACCEPT', completion: 'SUCCEEDED' } };
    const publish = async (domain: string, cookie: string) => {
      const dataset = await ok('/demo/dataset-versions', cookie, { domain, fiscalYear: 2026, period: 'Q4' }) as Created;
      for (const job of dataset.calculationJobs) {
        await ok(`/demo/calculation-jobs/${job.jobId}/run`, cookie, finishedRun);
        await ok(`/demo/calculation-jobs/${job.jobId}/reconcile`, cookie);
      }
      await ok(`/demo/dataset-versions/${dataset.datasetVersionId}/submit-validation`, cookie);
      await ok(`/demo/dataset-versions/${dataset.datasetVersionId}/publish`, cookie);
      return dataset;
    };
    const read = async (id: string, cookie: string) => {
      const response = await get(`/demo/dataset-versions/${id}`, cookie); assert.equal(response.statusCode, 200, response.body);
      return response.json<DatasetRead>();
    };
    const listed = async (id: string, cookie: string) => {
      const response = await get('/demo/dataset-versions', cookie); assert.equal(response.statusCode, 200, response.body);
      const item = (response.json<{ items: DatasetRead[] }>()).items.find(d => d.datasetVersionId === id); assert.ok(item);
      return item;
    };

    const owner = await session();
    const upstream = await publish('FAB_COST', owner);
    const frozenV1: FrozenInput[] = [{ domain: 'FAB_COST', fiscalYear: 2026, period: 'Q4', version: 1 }];

    await t.test('a dataset with no upstream and a dataset before first Run both report an empty list', async () => {
      assert.deepEqual((await read(upstream.datasetVersionId, owner)).frozenInputs, []);
      const capex = await ok('/demo/dataset-versions', owner, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' }) as Created;
      assert.deepEqual((await read(capex.datasetVersionId, owner)).frozenInputs, []);
      await ok(`/demo/dataset-versions/${capex.datasetVersionId}/abandon`, owner);
    });

    const capex = await ok('/demo/dataset-versions', owner, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' }) as Created;
    const first = capex.calculationJobs[0]!; const second = capex.calculationJobs[1]!;
    assert.ok(first && second, 'CAPEX has two jobs in Workflow configuration');

    await t.test('first Run freezes the published upstream version on list and detail reads', async () => {
      await ok(`/demo/calculation-jobs/${first.jobId}/run`, owner, { simulation: { dispatch: 'ACCEPT', completion: 'FAILED' } });
      assert.deepEqual((await read(capex.datasetVersionId, owner)).frozenInputs, frozenV1);
      assert.deepEqual((await listed(capex.datasetVersionId, owner)).frozenInputs, frozenV1);
    });

    await t.test('a newer upstream version and a retry do not change what was frozen', async () => {
      await publish('FAB_COST', owner);
      await ok(`/demo/calculation-jobs/${first.jobId}/reconcile`, owner);
      await ok(`/demo/calculation-jobs/${first.jobId}/run`, owner, { simulation: { dispatch: 'ACCEPT', completion: 'RUNNING' } });
      await ok(`/demo/calculation-jobs/${second.jobId}/run`, owner, { simulation: { dispatch: 'ACCEPT', completion: 'RUNNING' } });
      const attempts = await get(`/demo/calculation-jobs/${first.jobId}/execution-attempts`, owner);
      assert.equal(attempts.json<{ items: unknown[] }>().items.length, 2);
      assert.deepEqual((await read(capex.datasetVersionId, owner)).frozenInputs, frozenV1);
    });

    await t.test('the projection leaks no internal identifiers and stays owner-scoped', async () => {
      const response = await get(`/demo/dataset-versions/${capex.datasetVersionId}`, owner);
      assert.deepEqual(Object.keys(response.json<DatasetRead>().frozenInputs[0]!).sort(), ['domain', 'fiscalYear', 'period', 'version']);
      assert.doesNotMatch(response.body, /companyCode|company_code|token|hash|airflow|snapshot/i);
      const other = await session();
      assert.equal((await get(`/demo/dataset-versions/${capex.datasetVersionId}`, other)).statusCode, 404);
      assert.deepEqual((await get('/demo/dataset-versions', other)).json<{ items: unknown[] }>().items, []);
    });
  } finally {
    try { await app?.close(); await db?.end(); await Promise.all(ends); } finally {
      for (const key of ['DATABASE_URL', 'APP_MODE', 'NODE_ENV', 'EXECUTOR_TYPE']) {
        if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
      }
      try {
        if (created) {
          const deadline = Date.now() + 5000;
          while ((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name])).rowCount) {
            assert.ok(Date.now() < deadline); await setImmediate();
          }
          await admin.query(`DROP DATABASE "${name}"`);
        }
      } finally { await admin.end(); }
    }
  }
});
