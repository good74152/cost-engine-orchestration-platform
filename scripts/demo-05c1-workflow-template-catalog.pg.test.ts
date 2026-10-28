import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import type { AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { getWorkflowTemplate, listWorkflowTemplates } from '../src/modules/workflow-template/workflow-template.catalog.js';
import type { WorkflowTemplateSummary } from '../src/modules/workflow-template/workflow-template.types.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-05C-1 HTTP tests require a disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
function barrier() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Barrier timeout')), 8000); })]); }
  finally { clearTimeout(timer); }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'message']);
  assert.equal(response.json().code, code);
  assert.equal(response.headers['cache-control'], 'no-store');
}
const paths = ['/demo/workflow-templates', '/demo/workflow-templates/HAPPY_PATH'];

test('Demo-05C-1: protected read-only catalog and existing session barriers', { timeout: 120_000 }, async t => {
  const name = `demo_05c1_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_05c1_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const prior = { ...process.env }; const ends: Promise<void>[] = [];
  let created = false; let db: Pool | undefined; let app: FastifyInstance | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await runner({ databaseUrl: connection(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = connection(name); process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool }, { buildApp }, { DemoRuntime }, { seedDemoSixDomainConfiguration }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'), import('./seed-demo-six-domain-configuration.js'),
    ]);
    db = pool; pool.on('connect', client => ends.push(new Promise<void>(done => client.once('end', done))));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, name);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 13);
    const runtime = new DemoRuntime(pool, 'test', {}, { log() {} });
    app = await buildApp({ appMode: 'demo', demoRuntime: runtime, nodeEnvironment: 'test', logger: false, demoSession: { origin: 'https://demo.test' } });
    const post = (url: string, s?: Session, payload: unknown = {}) => app!.inject({ method: 'POST', url, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', origin: 'https://demo.test', 'x-demo-session': '1', ...(s ? { cookie: s.cookie } : {}) } });
    const get = (url: string, s?: Session, headers: Record<string, string | undefined> = {}) => app!.inject({ method: 'GET', url, headers: { ...(s ? { cookie: s.cookie } : {}), ...headers } });
    const session = async (): Promise<Session> => {
      const r = await post('/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      return { cookie, context: await runtime.sessions.authenticate(cookie, 'ce_demo_session') };
    };
    const dump = async () => {
      const tables = (await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const state: Record<string, unknown> = {};
      for (const { tablename } of tables) {
        assert.match(tablename, /^[a-z_][a-z0-9_]*$/);
        state[tablename] = (await pool.query(`SELECT to_jsonb(r) AS row FROM "${tablename}" r ORDER BY to_jsonb(r)::text`)).rows;
      }
      return state;
    };

    await t.test('all four templates and consistent exact list/detail contracts without seeded Domain configuration', async () => {
      const s = await session();
      assert.equal((await pool.query('SELECT id FROM calculation_types')).rowCount, 0);
      const list = await get(paths[0]!, s);
      assert.equal(list.statusCode, 200, list.body); assert.equal(list.headers['cache-control'], 'no-store');
      assert.deepEqual(list.json(), { templates: listWorkflowTemplates() });
      for (const summary of list.json<{ templates: WorkflowTemplateSummary[] }>().templates) {
        const response = await get(`/demo/workflow-templates/${summary.id}`, s);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['set-cookie'], undefined);
        assert.deepEqual(response.json(), getWorkflowTemplate(summary.id));
        const { steps, ...detailSummary } = response.json(); assert.deepEqual(detailSummary, summary); assert.ok(steps.length);
      }
      assert.equal(runtime.executors.size, 0);
    });

    await t.test('401 missing, malformed, unknown, expired and revoked sessions on both routes', async () => {
      const revoked = await session(); await runtime.sessions.revoke(revoked.context.sessionId);
      const expired = await session(); await pool.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '1 day', expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [expired.context.sessionId]);
      for (const path of paths) for (const cookie of [undefined, 'ce_demo_session=bad', `ce_demo_session=${Buffer.alloc(32, 7).toString('base64url')}`, expired.cookie, revoked.cookie]) {
        const r = await get(path, undefined, cookie ? { cookie } : {});
        error(r, 401, 'DEMO_SESSION_UNAVAILABLE'); assert.match(String(r.headers['set-cookie']), /Max-Age=0/);
      }
    });

    await t.test('GET enforces Same-Origin and cross-site policy without a mutation CSRF header', async () => {
      const s = await session();
      for (const path of paths) {
        for (const headers of [{}, { origin: 'https://demo.test', 'sec-fetch-site': 'same-origin' }, { 'x-demo-session': 'irrelevant-for-GET' }]) {
          assert.equal((await get(path, s, headers)).statusCode, 200);
        }
        for (const headers of [{ origin: 'https://foreign.invalid' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
          error(await get(path, s, headers), 403, 'DEMO_SESSION_CSRF_REJECTED');
        }
      }
    });

    await t.test('reject extra queries and unknown case-sensitive template IDs with flat errors', async () => {
      const s = await session();
      for (const path of paths) for (const query of ['?limit=4', '?id=HAPPY_PATH', '?extra=', '?a=1&a=2', '?__proto__=x']) {
        error(await get(path + query, s), 400, 'INVALID_REQUEST');
      }
      for (const id of ['missing', 'happy_path', '__proto__', 'constructor', '%20']) error(await get(`/demo/workflow-templates/${id}`, s), 404, 'DEMO_RESOURCE_UNAVAILABLE');
    });

    await t.test('Demo-only registration and no start/next mutation endpoints', async () => {
      process.env.APP_MODE = 'core';
      let core: FastifyInstance;
      try { core = await buildApp({ appMode: 'core', nodeEnvironment: 'test', logger: false }); }
      finally { process.env.APP_MODE = 'demo'; }
      try { for (const path of paths) assert.equal((await core.inject({ method: 'GET', url: path })).statusCode, 404); }
      finally { await core.close(); }
      for (const path of ['/demo/workflow-templates/start', '/demo/workflow-templates/next', '/demo/workflow-templates/HAPPY_PATH/start']) {
        assert.equal((await post(path)).statusCode, 404);
      }
    });

    await t.test('catalog is identical for empty, Free Exploration and active Guided sessions; all persisted state and Fake registry stay unchanged', async st => {
      await seedDemoSixDomainConfiguration(pool);
      const empty = await session(); const free = await session(); const guided = await session();
      const dataset = await post('/demo/dataset-versions', free, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' }); assert.equal(dataset.statusCode, 201, dataset.body);
      const run = await post(`/demo/calculation-jobs/${dataset.json().calculationJobs[0].jobId}/run`, free); assert.equal(run.statusCode, 200, run.body);
      const scenario = await post('/demo/scenarios', guided, { scenarioType: 'HAPPY_PATH' }); assert.equal(scenario.statusCode, 201, scenario.body);
      const next = await post(`/demo/scenarios/${scenario.json().scenarioId}/next`, guided, { expectedStep: 1, requestId: randomUUID() }); assert.equal(next.statusCode, 200, next.body);
      const before = await dump(); const fakeSize = runtime.executors.size;
      const originalQuery = pool.query;
      const query = st.mock.method(pool, 'query', function (...args: unknown[]) {
        // Authentication and gate revalidation may read only Demo sessions.
        assert.equal(typeof args[0], 'string');
        assert.match(args[0] as string, /^\s*SELECT (?:id, company_code, expires_at|id) FROM demo_sessions\s+WHERE/);
        return Reflect.apply(originalQuery, pool, args);
      });
      try {
        for (const s of [empty, free, guided]) {
          assert.deepEqual((await get(paths[0]!, s)).json(), { templates: listWorkflowTemplates() });
          for (const summary of listWorkflowTemplates()) assert.deepEqual((await get(`/demo/workflow-templates/${summary.id}`, s)).json(), getWorkflowTemplate(summary.id));
        }
      } finally { query.mock.restore(); }
      assert.deepEqual(await dump(), before);
      assert.equal(runtime.executors.size, fakeSize);
      assert.equal(runtime.executors.hasSession(empty.context.sessionId), false);
      assert.equal(runtime.executors.hasSession(guided.context.sessionId), false);
      assert.equal((await post('/demo/sessions/reset', guided)).statusCode, 204);
      assert.equal((await post('/demo/sessions/reset', free)).statusCode, 204);
    });

    await t.test('four real catalog requests share Parallel slots; fifth is 429, busy Reset is 409, another session progresses', async st => {
      const s = await session(); const other = await session(); const entered = barrier(); const finish = barrier(); let count = 0;
      const original = runtime.sessions.revalidate.bind(runtime.sessions);
      const spy = st.mock.method(runtime.sessions, 'revalidate', async (context: AuthenticatedDemoSession) => {
        await original(context);
        if (context.sessionId === s.context.sessionId) { if (++count === 4) entered.release(); await finish.promise; }
      });
      const requests = Array.from({ length: 4 }, (_, i) => Promise.resolve(get(paths[i % 2]!, s)));
      try {
        await bounded(entered.promise);
        error(await get(paths[0]!, s), 429, 'DEMO_SESSION_QUEUE_FULL');
        error(await post('/demo/sessions/reset', s), 409, 'RESET_CONFLICT');
        assert.equal((await get(paths[1]!, other)).statusCode, 200);
      } finally { finish.release(); await Promise.all(requests); spy.mock.restore(); }
      for (const response of await Promise.all(requests)) assert.equal(response.statusCode, 200, response.body);
      assert.equal(runtime.coordinator.activeSessionCount, 0);
      assert.equal((await post('/demo/sessions/reset', s)).statusCode, 204);
      error(await get(paths[0]!, s), 401, 'DEMO_SESSION_UNAVAILABLE');
    });

    await t.test('Exclusive barrier queues catalog reads, keeps Reset busy and revalidates revoked sessions on admission', async st => {
      const s = await session(); const entered = barrier(); const finish = barrier(); const queued = barrier();
      const exclusive = runtime.coordinator.run(s.context, async () => { entered.release(); await finish.promise; });
      await bounded(entered.promise);
      const original = runtime.coordinator.runParallel.bind(runtime.coordinator);
      const spy = st.mock.method(runtime.coordinator, 'runParallel', (context: AuthenticatedDemoSession, body: () => Promise<unknown>) => { const result = original(context, body); queued.release(); return result; });
      const request = Promise.resolve(get(paths[1]!, s));
      try {
        await bounded(queued.promise);
        error(await post('/demo/sessions/reset', s), 409, 'RESET_CONFLICT');
        await runtime.sessions.revoke(s.context.sessionId);
      } finally { finish.release(); await exclusive; spy.mock.restore(); }
      error(await request, 401, 'DEMO_SESSION_UNAVAILABLE'); assert.equal(runtime.coordinator.activeSessionCount, 0);
    });

    await t.test('Reset reservations and unknown-outcome blocks cover both new GETs and release safely', async () => {
      const s = await session(); const reservation = runtime.coordinator.tryBeginReset(s.context);
      try {
        for (const path of paths) error(await get(path, s), 409, 'RESET_CONFLICT');
        reservation.unknown = true;
        for (const path of paths) error(await get(path, s), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
      } finally { runtime.coordinator.finishReset(reservation); }
      for (const path of paths) assert.equal((await get(path, s)).statusCode, 200);
      assert.equal(runtime.coordinator.activeSessionCount, 0);
    });
    console.info('DEMO_05C1_EVIDENCE', JSON.stringify({ database: name, migrations: 13, domainStateUnchanged: true, parallelLimit: 4 }));
  } finally {
    try { await app?.close(); if (db) { await db.end(); await Promise.all(ends); } }
    finally {
      for (const key of ['DATABASE_URL', 'APP_MODE', 'NODE_ENV', 'EXECUTOR_TYPE']) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
      try {
        if (created) {
          const deadline = Date.now() + 5000; let rows = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
          while (rows.rowCount && Date.now() < deadline) { await setImmediate(); rows = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]); }
          assert.equal(rows.rowCount, 0); assert.match(name, /^demo_05c1_test_[a-z0-9_]+$/);
          await admin.query(`DROP DATABASE "${name}"`);
          console.info('DEMO_05C1_TEARDOWN', JSON.stringify({ database: name, backends: 0, dropped: true, forced: false }));
        }
      } finally { await admin.end(); }
    }
  }
});
