import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import Fastify, { type FastifyInstance } from 'fastify';
import { installPublicDemoHttp } from '../src/deployment/public-demo-http.js';
import { publicDemoConfig } from '../src/deployment/public-demo-config.js';
import { verifyDemoDatabase } from '../src/deployment/verify-database.js';
import { DemoMaintenance } from '../src/deployment/demo-maintenance.js';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import { SECURE_SESSION_COOKIE } from '../src/modules/demo-session/demo-session.service.js';
import { createConfiguredCalculationExecutor, isApprovedFakeExecutorEnvironment } from '../src/executors/executor-factory.js';
import { seedDemoGuidedConfiguration } from './seed-demo-guided-configuration.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-04 requires a dedicated disposable PostgreSQL test service');
const origin = 'https://demo.test';
const proxySecret = randomBytes(32).toString('hex');
const sample = { NODE_ENV: 'production', APP_MODE: 'demo', EXECUTOR_TYPE: 'fake', DEMO_PUBLIC_ENABLED: 'true',
  DEMO_PUBLIC_ORIGIN: origin, DEMO_PROXY_SECRET: proxySecret, DEPLOYMENT_VERSION: 'test-demo04',
  DATABASE_URL: 'postgres://demo_owner:disposable-password-only@localhost/disposable' };
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
function rejected(r: Response, status: number, code: string) {
  assert.equal(r.statusCode, status, r.body); assert.equal(r.json().code, code);
  assert.deepEqual(Object.keys(r.json()).sort(), ['code', 'message']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.body, /token_hash|postgres:|SELECT |constraint|password|secret/i);
}

test('Demo-04 rate budget accounting through HTTP admission', async t => {
  const fixture = (limits: { creates: number; mutations: number; global: number }) => {
    const app = Fastify({ logger: false }); let now = 60000; let admitted = 0;
    installPublicDemoHttp(app, { ...publicDemoConfig(sample)!, createsPerMinute: limits.creates,
      mutationsPerMinute: limits.mutations, globalMutationsPerMinute: limits.global }, () => now);
    for (const url of ['/demo/sessions', '/demo/operation']) app.post(url, async () => { admitted++; return { admitted: true }; });
    const post = (ip: string, url = '/demo/operation') => app.inject({ method: 'POST', url, payload: {}, headers: {
      origin, 'x-demo-session': '1', 'x-demo-proxy-key': proxySecret, 'x-demo-client-ip': ip,
    } });
    return { app, post, admitted: () => admitted, advanceWindow: () => { now += 60000; } };
  };
  await t.test('per-IP rejections do not spend other IPs global quota; global cap still rejects', async t => {
    const f = fixture({ creates: 100, mutations: 1, global: 3 }); t.after(() => f.app.close());
    assert.equal((await f.post('192.0.2.1')).statusCode, 200);
    for (let n = 0; n < 20; n++) rejected(await f.post('192.0.2.1'), 429, 'DEMO_RATE_LIMITED');
    for (const ip of ['192.0.2.2', '192.0.2.3']) assert.equal((await f.post(ip)).statusCode, 200);
    rejected(await f.post('192.0.2.4'), 429, 'DEMO_RATE_LIMITED'); assert.equal(f.admitted(), 3);
  });
  await t.test('creation-limit rejections spend neither mutation nor global quota', async t => {
    const f = fixture({ creates: 1, mutations: 5, global: 3 }); t.after(() => f.app.close());
    assert.equal((await f.post('192.0.2.1', '/demo/sessions')).statusCode, 200);
    for (let n = 0; n < 20; n++) rejected(await f.post('192.0.2.1', '/demo/sessions'), 429, 'DEMO_RATE_LIMITED');
    assert.equal((await f.post('192.0.2.1')).statusCode, 200);
    assert.equal((await f.post('192.0.2.2', '/demo/sessions')).statusCode, 200);
    rejected(await f.post('192.0.2.3', '/demo/sessions'), 429, 'DEMO_RATE_LIMITED'); assert.equal(f.admitted(), 3);
  });
  await t.test('concurrent same-IP excess cannot bypass local limits or drain remaining global quota', async t => {
    const f = fixture({ creates: 100, mutations: 2, global: 5 }); t.after(() => f.app.close());
    const same = await Promise.all(Array.from({ length: 40 }, () => f.post('192.0.2.1')));
    assert.equal(same.filter(r => r.statusCode === 200).length, 2);
    assert.equal(same.filter(r => r.statusCode === 429).length, 38);
    const other = await Promise.all(Array.from({ length: 10 }, (_, i) => f.post(`198.51.100.${i + 1}`)));
    assert.equal(other.filter(r => r.statusCode === 200).length, 3);
    assert.equal(other.filter(r => r.statusCode === 429).length, 7); assert.equal(f.admitted(), 5);
  });
  await t.test('concurrent session creates obey creation and aggregate limits', async t => {
    const f = fixture({ creates: 2, mutations: 50, global: 5 }); t.after(() => f.app.close());
    const same = await Promise.all(Array.from({ length: 20 }, () => f.post('192.0.2.1', '/demo/sessions')));
    assert.equal(same.filter(r => r.statusCode === 200).length, 2);
    assert.equal(same.filter(r => r.statusCode === 429).length, 18);
    const other = await Promise.all(Array.from({ length: 10 }, (_, i) => f.post(`198.51.100.${i + 1}`, '/demo/sessions')));
    assert.equal(other.filter(r => r.statusCode === 200).length, 3);
    assert.equal(other.filter(r => r.statusCode === 429).length, 7); assert.equal(f.admitted(), 5);
  });
  await t.test('all admission counters reset together on a new fixed window', async t => {
    const f = fixture({ creates: 1, mutations: 1, global: 1 }); t.after(() => f.app.close());
    assert.equal((await f.post('192.0.2.1', '/demo/sessions')).statusCode, 200);
    rejected(await f.post('192.0.2.2', '/demo/sessions'), 429, 'DEMO_RATE_LIMITED'); f.advanceWindow();
    assert.equal((await f.post('192.0.2.1', '/demo/sessions')).statusCode, 200);
    rejected(await f.post('192.0.2.2', '/demo/sessions'), 429, 'DEMO_RATE_LIMITED'); assert.equal(f.admitted(), 2);
  });
});

test('Demo-04 environment matrix fails closed without broadening Core fake policy', () => {
  assert.equal(publicDemoConfig({ NODE_ENV: 'test' }), undefined);
  assert.equal(publicDemoConfig(sample)!.origin, origin);
  const cases = [
    { DEMO_PUBLIC_ENABLED: undefined }, { DEMO_PUBLIC_ENABLED: 'false' }, { DEMO_PUBLIC_ENABLED: 'yes' },
    { NODE_ENV: 'development' }, { APP_MODE: 'core' }, { EXECUTOR_TYPE: 'airflow' },
    { DEMO_PUBLIC_ORIGIN: 'http://demo.test' }, { DEMO_PUBLIC_ORIGIN: 'https://demo.test/' },
    { DEMO_PUBLIC_ORIGIN: 'https://demo.test/path' }, { DEMO_PUBLIC_ORIGIN: 'https://user:pass@demo.test' },
    { DEMO_PROXY_SECRET: undefined }, { DEMO_PROXY_SECRET: 'short' }, { DATABASE_URL: undefined },
    { DATABASE_URL: 'postgres://admin:admin@localhost/demo' }, { DEPLOYMENT_VERSION: undefined },
    { DEMO_MAX_ACTIVE_SESSIONS: '0' }, { DEMO_MAX_ACTIVE_SESSIONS: '1001' },
    { DEMO_MAX_RETAINED_SESSIONS: '1' }, { DEMO_MAX_EXECUTORS: '101' }, { DEMO_BODY_BYTES: 'Infinity' },
  ];
  for (const changed of cases) assert.throws(() => publicDemoConfig({ ...sample, ...changed }));
  assert.equal(isApprovedFakeExecutorEnvironment('production', 'production'), false);
  assert.throws(() => createConfiguredCalculationExecutor({ executorType: 'fake', nodeEnvironment: 'production' }));
});

test('Demo-04 real PostgreSQL production profile and lifecycle', { timeout: 180000 }, async t => {
  const name = `demo04_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const role = `${name}_role`;
  assert.match(role, /^demo04_test_[a-z0-9_]+$/); assert.ok(role.length < 63);
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() }); await admin.connect();
  const target = new URL(source); target.pathname = '/' + name; target.username = role; target.password = randomBytes(24).toString('hex');
  const previous = { ...process.env }; const apps: FastifyInstance[] = []; const ends: Promise<void>[] = [];
  let db: Pool | undefined; let createdRole = false; let createdDb = false;
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${target.password}'`); createdRole = true;
    await admin.query(`CREATE DATABASE "${name}" OWNER "${role}" TEMPLATE template0`); createdDb = true;
    await runner({ databaseUrl: target.toString(), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      direction: 'up', migrationsTable: 'pgmigrations', singleTransaction: true, checkOrder: true,
      logger: { info() {}, debug() {}, warn() {}, error() {} } });
    Object.assign(process.env, sample, { DATABASE_URL: target.toString(), DEMO_CREATES_PER_MINUTE: '100',
      DEMO_MUTATIONS_PER_MINUTE: '1000', DEMO_GLOBAL_MUTATIONS_PER_MINUTE: '5000', DEMO_MAX_EXECUTORS: '100' });
    const [{ pool }, { buildApp }] = await Promise.all([import('../src/db/pool.js'), import('../src/app.js')]); db = pool;
    pool.on('connect', c => ends.push(new Promise<void>(done => c.once('end', done))));
    assert.equal((await pool.query('SELECT current_database() AS n')).rows[0].n, name);
    const make = async (ready = true) => {
      const runtime = new DemoRuntime(pool, 'production', {}, { log() {} });
      const app = await buildApp({ demoRuntime: runtime, logger: false, readiness: () => ready }); apps.push(app);
      return { runtime, app };
    };
    const headers = (cookie?: string, ip = '192.0.2.1') => ({ origin, 'x-demo-session': '1',
      'x-demo-proxy-key': proxySecret, 'x-demo-client-ip': ip, ...(cookie ? { cookie } : {}) });
    const post = async (app: FastifyInstance, url: string, cookie?: string, payload: unknown = {}, ip?: string): Promise<Response> =>
      app.inject({ method: 'POST', url, headers: { ...headers(cookie, ip), 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    const session = async (app: FastifyInstance) => {
      const r = await post(app, '/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, dto: r.json() };
    };
    await t.test('startup read-only migration and seed gate rejects incomplete configuration', async () => {
      await assert.rejects(verifyDemoDatabase(pool));
      await seedDemoGuidedConfiguration(pool); await seedDemoGuidedConfiguration(pool);
      await verifyDemoDatabase(pool);
      await pool.query("INSERT INTO pgmigrations(name,run_on) VALUES('unexpected_migration',now())");
      await assert.rejects(verifyDemoDatabase(pool), /inventory mismatch/);
      await pool.query("DELETE FROM pgmigrations WHERE name='unexpected_migration'");
    });
    await t.test('production profile cannot be weakened by injected mode/cookie/origin/environment', async () => {
      await assert.rejects(buildApp({ appMode: 'core', logger: false }));
      await assert.rejects(buildApp({ nodeEnvironment: 'test', logger: false }));
      await assert.rejects(buildApp({ demoSession: { secureCookies: false }, logger: false }));
      await assert.rejects(buildApp({ demoSession: { origin: 'https://other.test' }, logger: false }));
    });
    const { app, runtime } = await make();
    await t.test('Secure host cookie, restoration and no credential response', async () => {
      const r = await post(app, '/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
      const cookie = String(r.headers['set-cookie']);
      assert.match(cookie, /^__Host-ce_demo_session=/);
      for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.deepEqual(Object.keys(r.json()).sort(), ['companyCode', 'expiresAt', 'sessionId', 'status']);
      const restored = await post(app, '/demo/sessions', cookie.split(';')[0]);
      assert.equal(restored.statusCode, 200); assert.deepEqual(restored.json(), r.json());
      assert.equal(restored.headers['set-cookie'], undefined);
      const stored = (await pool.query('SELECT octet_length(token_hash) AS n FROM demo_sessions WHERE id=$1', [r.json().sessionId])).rows[0];
      assert.equal(stored.n, 32);
    });
    await t.test('proxy header spoofing, exact Origin and CSRF rejection', async () => {
      rejected(await app.inject({ method: 'POST', url: '/demo/sessions', payload: {}, headers: {
        'x-forwarded-for': '192.0.2.1', 'x-forwarded-proto': 'https', origin, 'x-demo-session': '1' } }), 403, 'DEMO_PROXY_REQUIRED');
      for (const changed of [{ origin: 'https://evil.test' }, { origin: undefined }, { 'x-demo-session': undefined },
        { 'sec-fetch-site': 'cross-site' }, { 'x-demo-proxy-key': 'é'.repeat(64) }]) {
        const requestHeaders = Object.fromEntries(Object.entries({ ...headers(), ...changed }).filter(([, value]) => value !== undefined)) as Record<string, string>;
        const r = await app.inject({ method: 'POST', url: '/demo/sessions', payload: {}, headers: requestHeaders });
        assert.equal(r.statusCode, 403, r.body);
      }
    });
    await t.test('bounded public body parser rejects oversized mutation safely', async () => {
      rejected(await post(app, '/demo/sessions', undefined, { oversized: 'x'.repeat(17000) }), 413, 'INVALID_REQUEST');
    });
    await t.test('unsupported core/raw/internal/admin/seed routes are absent', async () => {
      for (const url of ['/dataset-versions', '/calculation-jobs', '/raw-ingestion-batches', '/executor-callbacks/airflow',
        '/internal/fake-executor/executions/test/succeed', '/admin', '/seed', '/migrations', '/debug']) {
        assert.equal((await post(app, url)).statusCode, 404, url);
      }
    });
    await t.test('readiness distinguishes incomplete initialization and checks the database', async () => {
      const notReady = await make(false);
      assert.equal((await notReady.app.inject('/health/ready')).statusCode, 503);
      const r = await app.inject('/health/ready'); assert.equal(r.statusCode, 200); assert.equal(r.json().status, 'ready');
      assert.equal((await app.inject({ url: '/health', headers: headers() })).statusCode, 404);
      const old = pool.query.bind(pool);
      let queries = 0;
      pool.query = (() => { queries++; return Promise.reject(new Error('private database diagnostic')); }) as typeof pool.query;
      try {
        for (const url of ['/health', '/health/ready', '/health?probe=1', '/health/ready?probe=1']) {
          const external = await app.inject({ url, remoteAddress: '198.51.100.1', headers: {
            ...headers(), 'x-forwarded-for': '127.0.0.1', 'x-demo-client-ip': '127.0.0.1',
          } });
          assert.equal(external.statusCode, 404); assert.equal(external.headers['cache-control'], 'no-store');
        }
        assert.equal(queries, 0, 'Public health requests must not reach PostgreSQL');
        assert.equal((await notReady.app.inject('/health/ready')).statusCode, 503); assert.equal(queries, 0);
        assert.equal((await app.inject('/health/ready')).statusCode, 503); assert.equal(queries, 1);
      }
      finally { pool.query = old as typeof pool.query; }
    });
    await t.test('per-address session creation limit cannot be bypassed by X-Forwarded-For', async () => {
      process.env.DEMO_CREATES_PER_MINUTE = '2'; const limited = await make();
      for (let n = 0; n < 2; n++) assert.equal((await post(limited.app, '/demo/sessions')).statusCode, 201);
      const r = await limited.app.inject({ method: 'POST', url: '/demo/sessions', payload: {}, headers: {
        ...headers(), 'x-forwarded-for': '198.51.100.9' } }); rejected(r, 429, 'DEMO_RATE_LIMITED');
      assert.equal(r.headers['retry-after'], '60'); assert.equal(r.headers['set-cookie'], undefined);
      process.env.DEMO_CREATES_PER_MINUTE = '100';
    });
    await t.test('per-address and global mutation limits cover all protected commands', async () => {
      for (const global of [false, true]) {
        process.env.DEMO_MUTATIONS_PER_MINUTE = global ? '1000' : '1';
        process.env.DEMO_GLOBAL_MUTATIONS_PER_MINUTE = global ? '1' : '5000';
        const limited = await make();
        await post(limited.app, '/demo/sessions');
        rejected(await post(limited.app, '/demo/scenarios', undefined, {}, global ? '192.0.2.2' : undefined), 429, 'DEMO_RATE_LIMITED');
      }
      process.env.DEMO_MUTATIONS_PER_MINUTE = '1000'; process.env.DEMO_GLOBAL_MUTATIONS_PER_MINUTE = '5000';
    });
    await t.test('20 concurrent creates cannot exceed active capacity; no partial cookies or jobs', async () => {
      await runtime.reset.startServer();
      process.env.DEMO_MAX_ACTIVE_SESSIONS = '3'; process.env.DEMO_MAX_EXECUTORS = '2';
      const bounded = await make();
      const results = await Promise.all(Array.from({ length: 20 }, () => post(bounded.app, '/demo/sessions')));
      assert.equal(results.filter(r => r.statusCode === 201).length, 3);
      const unavailable = results.filter(r => r.statusCode !== 201); assert.equal(unavailable.length, 17);
      for (const r of unavailable) { rejected(r, 503, 'DEMO_SESSION_CAPACITY_REACHED'); assert.equal(r.headers['set-cookie'], undefined); }
      const accepted = results.filter(r => r.statusCode === 201); assert.equal(new Set(accepted.map(r => r.json().companyCode)).size, 3);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_sessions WHERE revoked_at IS NULL')).rows[0].n, 3);
      const contexts = await Promise.all(accepted.map(r => bounded.runtime.sessions.authenticate(String(r.headers['set-cookie']).split(';')[0], SECURE_SESSION_COOKIE)));
      await Promise.all(contexts.slice(0, 2).map(c => bounded.runtime.executors.forSession(c)));
      await assert.rejects(bounded.runtime.executors.forSession(contexts[2]!), { code: 'DEMO_EXECUTOR_CAPACITY_REACHED' });
      assert.equal(bounded.runtime.executors.size, 2);
      process.env.DEMO_MAX_ACTIVE_SESSIONS = '100'; process.env.DEMO_MAX_EXECUTORS = '100';
    });
    await t.test('retained-history ceiling rejects admission without deleting history', async () => {
      await runtime.reset.startServer();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_sessions WHERE revoked_at IS NULL')).rows[0].n, 0);
      const n = (await pool.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n;
      process.env.DEMO_MAX_ACTIVE_SESSIONS = '1'; process.env.DEMO_MAX_EXECUTORS = '1'; process.env.DEMO_MAX_RETAINED_SESSIONS = String(n);
      const bounded = await make(); rejected(await post(bounded.app, '/demo/sessions'), 503, 'DEMO_SESSION_CAPACITY_REACHED');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, n);
      process.env.DEMO_MAX_ACTIVE_SESSIONS = '100'; process.env.DEMO_MAX_EXECUTORS = '100'; process.env.DEMO_MAX_RETAINED_SESSIONS = '10000';
    });
    await runtime.reset.startServer();
    await t.test('all guided flows, ownership and Reset work unchanged under production profile', async () => {
      for (const type of ['HAPPY_PATH', 'FAILURE_RETRY', 'LOST_RESPONSE_RECOVERY']) {
        const s = await session(app); const other = await session(app);
        const sc = await post(app, '/demo/scenarios', s.cookie, { scenarioType: type }); assert.equal(sc.statusCode, 201, sc.body);
        for (let n = 1; n <= (type === 'FAILURE_RETRY' ? 9 : 6); n++) {
          const payload = { expectedStep: n, requestId: randomUUID() }; const path = `/demo/scenarios/${sc.json().scenarioId}/next`;
          let r = await post(app, path, s.cookie, payload);
          if (type === 'LOST_RESPONSE_RECOVERY' && n === 2) { assert.equal(r.statusCode, 202, r.body); r = await post(app, path, s.cookie, payload); }
          assert.equal(r.statusCode, 200, r.body);
        }
        const version = (await pool.query('SELECT v.id,v.status FROM dataset_versions v JOIN dataset_series s ON s.id=v.dataset_series_id WHERE s.company_code=$1', [s.dto.companyCode])).rows[0];
        assert.equal(version.status, 'PUBLISHED');
        rejected(await app.inject({ url: `/demo/dataset-versions/${version.id}`, headers: headers(other.cookie) }), 404, 'DEMO_RESOURCE_UNAVAILABLE');
        assert.equal((await post(app, '/demo/sessions/reset', s.cookie)).statusCode, 204);
        assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1', [s.dto.companyCode])).rowCount, 0);
      }
    });
    await t.test('bounded periodic cleanup releases inactive owner fake, preserves active owner and history', async () => {
      const expired = await session(app); const active = await session(app);
      for (const s of [expired, active]) {
        assert.equal((await post(app, '/demo/dataset-versions', s.cookie, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' })).statusCode, 201);
        await runtime.executors.forSession(await runtime.sessions.authenticate(s.cookie, SECURE_SESSION_COOKIE));
      }
      await pool.query("UPDATE demo_sessions SET created_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [expired.dto.sessionId]);
      const maintenance = new DemoMaintenance(runtime, 1, () => {});
      await maintenance.tick(); await maintenance.tick();
      assert.equal(runtime.executors.hasSession(expired.dto.sessionId), false);
      assert.equal(runtime.executors.hasSession(active.dto.sessionId), true);
      assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1', [expired.dto.companyCode])).rowCount, 0);
      assert.equal((await pool.query('SELECT id FROM demo_sessions WHERE id=$1', [expired.dto.sessionId])).rowCount, 1);
      assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1', [active.dto.companyCode])).rowCount, 1);
      await maintenance.stop();
    });
    await t.test('scheduler is non-overlapping, bounded, failure-isolated and stops on shutdown', async () => {
      let finish!: () => void; let calls = 0; const events: string[] = [];
      const original = runtime.reset.maintainInactiveSessions.bind(runtime.reset);
      runtime.reset.maintainInactiveSessions = async limit => { assert.equal(limit, 2); calls++; await new Promise<void>(r => { finish = r; }); throw new Error('private'); };
      const maintenance = new DemoMaintenance(runtime, 2, event => events.push(event));
      try {
        const first = maintenance.tick(); const second = maintenance.tick(); assert.equal(first, second); assert.equal(calls, 1);
        maintenance.start(5); await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1);
        const stopped = maintenance.stop(); finish(); await stopped; await first;
        await new Promise(r => setTimeout(r, 20)); assert.equal(calls, 1); assert.deepEqual(events, ['demo_maintenance_failed']);
      } finally { runtime.reset.maintainInactiveSessions = original; }
    });
    await t.test('restart invalidates old credentials before readiness without reviving fake executions', async () => {
      const s = await session(app); const restarted = await make(); await verifyDemoDatabase(pool); await restarted.runtime.reset.startServer();
      rejected(await restarted.app.inject({ url: '/demo/sessions/current', headers: headers(s.cookie) }), 401, 'DEMO_SESSION_UNAVAILABLE');
      assert.equal(restarted.runtime.executors.size, 0);
      await session(restarted.app);
    });
    console.info('DEMO04_PG_VERIFIED', JSON.stringify({ migrations: (await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, postgres: (await pool.query('SHOW server_version')).rows[0].server_version }));
  } finally {
    for (const app of apps) await app.close();
    await db?.end(); await Promise.all(ends);
    const backends = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]); assert.equal(backends.rowCount, 0);
    if (createdDb) await admin.query(`DROP DATABASE "${name}"`);
    if (createdRole) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
