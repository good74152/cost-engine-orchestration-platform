import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { Client, Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { DemoSessionService, type DemoSessionServiceOptions } from '../src/modules/demo-session/demo-session.service.js';
import { DemoAdmissionOperator, type AdmissionOperatorOptions } from '../src/modules/demo-admission/demo-admission.operator.js';
import type { ScenarioCreateOptions } from '../src/modules/demo-scenario/demo-scenario.service.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Admission tests require an owned disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Barrier timeout')), 8000); })]); }
  finally { clearTimeout(timer); }
}
const migrate = (url: string, direction: 'up' | 'down' = 'up', count?: number) => runner({ databaseUrl: url,
  dir: migrations, direction, count, migrationsTable: 'pgmigrations', singleTransaction: true, checkOrder: true,
  logger: { debug() {}, info() {}, warn() {}, error() {} } });
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
function error(r: Response, status: number, code: string) {
  assert.equal(r.statusCode, status, r.body); assert.equal(r.json().code, code);
  assert.deepEqual(Object.keys(r.json()).sort(), ['code', 'message']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.body, /postgres(?:ql)?:|password|token_hash|SELECT |INSERT |constraint|private-transport/);
}

test('Demo-05C-2: PostgreSQL admission drain, durable recovery and existing users', { timeout: 300_000 }, async t => {
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const prior = { ...process.env };
  const names: string[] = []; const pools: Pool[] = []; const apps: FastifyInstance[] = [];
  const createDatabase = async () => {
    const name = `demo_05c2_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    assert.match(name, /^demo_05c2_[a-z0-9_]+$/); assert.ok(name.length < 64);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); names.push(name);
    await migrate(connection(name)); return name;
  };
  try {
    const mainName = await createDatabase();
    process.env.DATABASE_URL = connection(mainName); process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ buildApp }, { DemoRuntime }, { pool: corePool }, { seedDemoGuidedConfiguration }] = await Promise.all([
      import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'), import('../src/db/pool.js'), import('./seed-demo-guided-configuration.js'),
    ]);
    pools.push(corePool);
    const fixture = async (options: { main?: boolean; scenario?: ScenarioCreateOptions; reset?: ResetOptions; lockTimeout?: string } = {}) => {
      const name = options.main ? mainName : await createDatabase();
      const db = options.main ? corePool : new Pool({ connectionString: connection(name), max: 12,
        options: options.lockTimeout ? `-c lock_timeout=${options.lockTimeout}` : undefined });
      if (!options.main) pools.push(db);
      await seedDemoGuidedConfiguration(db);
      const runtime = new DemoRuntime(db, 'test', {}, options.reset ?? { log() {} }, options.scenario ?? {});
      const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, nodeEnvironment: 'test', logger: false, demoSession: { origin: 'https://demo.test' } }); apps.push(app);
      const post = (url: string, cookie?: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', origin: 'https://demo.test', 'x-demo-session': '1', ...(cookie ? { cookie } : {}) } });
      const newSession = async () => {
        const r = await post('/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
        const cookie = String(r.headers['set-cookie']).split(';')[0]!;
        return { cookie, context: await runtime.sessions.authenticate(cookie, 'ce_demo_session') };
      };
      return { name, db, runtime, app, post, newSession, operator: new DemoAdmissionOperator(db) };
    };
    const waiters = async (name: string, pattern: string, count = 1) => bounded((async () => {
      for (;;) {
        const result = await admin.query<{ pid: number; blockers: number[] }>(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2`, [name, pattern]);
        if (result.rows.length >= count) { assert.ok(result.rows.every(r => r.blockers.length > 0)); return result.rows; }
        await setImmediate();
      }
    })());
    const rowLockHeld = async (name: string) => {
      const probe = new Client({ connectionString: connection(name) }); await probe.connect();
      try { await probe.query('BEGIN'); await assert.rejects(probe.query('SELECT id FROM demo_admission_control WHERE id=1 FOR UPDATE NOWAIT'), { code: '55P03' }); }
      finally { await probe.query('ROLLBACK'); await probe.end(); }
    };

    for (const originalTimeout of ['0', '750ms']) await t.test(`Scenario Gate timeout rolls back after 3s and restores lock policy (${originalTimeout})`, async () => {
      const observed: string[] = [];
      const f = await fixture({ lockTimeout: originalTimeout, scenario: { commit: async client => {
        observed.push((await client.query('SHOW lock_timeout')).rows[0].lock_timeout as string); await client.query('COMMIT');
      } } });
      const s = await f.newSession(); const unassigned = await f.newSession();
      const blocker = new Client({ connectionString: connection(f.name) }); await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM demo_admission_control WHERE id=1 FOR UPDATE');
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      const started = Date.now();
      const request = Promise.resolve(f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }));
      try {
        const [waiting] = await waiters(f.name, '%demo_admission_control%FOR SHARE%');
        assert.ok(waiting!.blockers.includes(blockerPid));
        error(await bounded(request), 503, 'DEMO_ADMISSION_UNAVAILABLE');
        assert.ok(Date.now() - started >= 2500, 'Gate must use 3s even with a shorter connection timeout');
        assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 0);
        assert.equal(f.runtime.coordinator.activeSessionCount, 0);
        const backend = (await admin.query('SELECT state,xact_start FROM pg_stat_activity WHERE pid=$1', [waiting!.pid])).rows[0];
        assert.equal(backend.state, 'idle'); assert.equal(backend.xact_start, null, 'Timed-out transaction must be rolled back before pool reuse');
        const reused = await f.db.connect();
        try { assert.equal((await reused.query('SHOW lock_timeout')).rows[0].lock_timeout, originalTimeout); }
        finally { reused.release(); }
      } finally { await blocker.query('ROLLBACK'); await blocker.end(); await request; }
      const created = await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }); assert.equal(created.statusCode, 201, created.body);
      const replay = await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }); assert.equal(replay.statusCode, 200); assert.deepEqual(replay.json(), created.json());
      await f.operator.drain();
      error(await f.post('/demo/scenarios', unassigned.cookie, { scenarioType: 'HAPPY_PATH' }), 503, 'DEMO_ADMISSION_DRAINING');
      assert.equal((await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' })).statusCode, 200);
      assert.deepEqual(observed, [originalTimeout, originalTimeout, originalTimeout]);
    });

    await t.test('successful Gate acquisition restores the original timeout before waiting on the Session row', async () => {
      const f = await fixture({ lockTimeout: '750ms' }); const s = await f.newSession();
      const blocker = new Client({ connectionString: connection(f.name) }); await blocker.connect(); await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [s.context.sessionId]);
      const started = Date.now(); const request = Promise.resolve(f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }));
      try {
        await waiters(f.name, '%FROM demo_sessions%FOR UPDATE%');
        // Preserve the pre-existing handling of later Session-lock failures.
        error(await bounded(request), 500, 'INTERNAL_SERVER_ERROR');
        assert.ok(Date.now() - started < 2500, 'Session lock must retain 750ms rather than the Gate-only 3s');
        assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 0);
      } finally { await blocker.query('ROLLBACK'); await blocker.end(); await request; }
      assert.equal((await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' })).statusCode, 201);
    });

    await t.test('singleton, state/timestamp constraints, irreversible transition and offline Down guards', async () => {
      const f = await fixture(); const open = await f.operator.status(); assert.equal(open.state, 'LEGACY_OPEN');
      for (const sql of ["INSERT INTO demo_admission_control(id) VALUES(2)", "INSERT INTO demo_admission_control(id) VALUES(1)",
        "UPDATE demo_admission_control SET state='invalid'", 'DELETE FROM demo_admission_control', 'TRUNCATE demo_admission_control']) await assert.rejects(f.db.query(sql));
      const s = await f.newSession();
      await assert.rejects(migrate(connection(f.name), 'down', 1));
      assert.equal((await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' })).statusCode, 201);
      await f.runtime.sessions.revoke(s.context.sessionId);
      await assert.rejects(migrate(connection(f.name), 'down', 1));
      await f.db.query('DELETE FROM demo_scenario_instances WHERE session_id=$1', [s.context.sessionId]);
      await migrate(connection(f.name), 'down', 1);
      assert.equal((await f.db.query("SELECT to_regclass('demo_admission_control') AS name")).rows[0].name, null);
      await migrate(connection(f.name));
      const drained = await f.operator.drain(); assert.equal(drained.state, 'DRAINING'); assert.ok(Date.parse(drained.updatedAt) >= Date.parse(open.updatedAt));
      await assert.rejects(f.db.query("UPDATE demo_admission_control SET state='LEGACY_OPEN'"));
      await assert.rejects(migrate(connection(f.name), 'down', 1));
      assert.equal((await f.operator.status()).state, 'DRAINING');
    });

    for (const capacity of [undefined, { active: 5, retained: 10 }]) await t.test(`Session admission wins race, including capacity=${Boolean(capacity)}; drain waits for COMMIT`, async () => {
      const f = await fixture(); const entered = barrier(); const finish = barrier();
      const service = new DemoSessionService(f.db, { capacity, beforeCommit: async () => { entered.release(); await finish.promise; } });
      const create = service.create(); await bounded(entered.promise); await rowLockHeld(f.name);
      const drain = f.operator.drain();
      try { await waiters(f.name, '%demo_admission_control%FOR UPDATE%'); }
      finally { finish.release(); }
      const s = await create; assert.equal((await drain).state, 'DRAINING');
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, 1);
      await assert.rejects(service.create(), { code: 'DEMO_ADMISSION_DRAINING' });
      const replay = await f.post('/demo/sessions', `ce_demo_session=${s.token}`); assert.equal(replay.statusCode, 200, replay.body);
    });

    await t.test('drain wins: waiting Session and Scenario observe DRAINING; no insert after drain COMMIT', async () => {
      const f = await fixture(); const s = await f.newSession(); const entered = barrier(); const finish = barrier();
      const drain = new DemoAdmissionOperator(f.db, { beforeCommit: async () => { entered.release(); await finish.promise; } }).drain();
      await bounded(entered.promise); await rowLockHeld(f.name);
      const session = Promise.resolve(f.post('/demo/sessions'));
      const scenario = Promise.resolve(f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }));
      try { await waiters(f.name, '%demo_admission_control%FOR SHARE%', 2); }
      finally { finish.release(); }
      await drain;
      error(await session, 503, 'DEMO_ADMISSION_DRAINING'); error(await scenario, 503, 'DEMO_ADMISSION_DRAINING');
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, 1);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 0);
      for (let i = 0; i < 3; i++) { error(await f.post('/demo/sessions'), 503, 'DEMO_ADMISSION_DRAINING'); error(await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }), 503, 'DEMO_ADMISSION_DRAINING'); }
    });

    await t.test('Scenario admission wins race; drain waits for Scenario COMMIT, replay/type conflict preserved', async () => {
      const entered = barrier(); const finish = barrier();
      const f = await fixture({ scenario: { beforeCommit: async () => { entered.release(); await finish.promise; } } });
      const s = await f.newSession(); const create = Promise.resolve(f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }));
      await bounded(entered.promise); await rowLockHeld(f.name); const drain = f.operator.drain();
      try { await waiters(f.name, '%demo_admission_control%FOR UPDATE%'); }
      finally { finish.release(); }
      const result = await create; assert.equal(result.statusCode, 201, result.body); await drain;
      const replay = await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }); assert.equal(replay.statusCode, 200, replay.body); assert.deepEqual(replay.json(), result.json());
      error(await f.post('/demo/scenarios', s.cookie, { scenarioType: 'FAILURE_RETRY' }), 409, 'DEMO_SCENARIO_TYPE_CONFLICT');
    });

    await t.test('gate lock is obtained before Session row and before capacity table lock', async () => {
      const f = await fixture(); const s = await f.newSession();
      const blocker = new Client({ connectionString: connection(f.name) }); await blocker.connect(); await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM demo_admission_control WHERE id=1 FOR UPDATE');
      const create = Promise.resolve(f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }));
      const service = new DemoSessionService(f.db, { capacity: { active: 9, retained: 10 } }); const session = service.create();
      try {
        await waiters(f.name, '%demo_admission_control%FOR SHARE%', 2);
        const probe = new Client({ connectionString: connection(f.name) }); await probe.connect();
        try { await probe.query('BEGIN'); await probe.query('LOCK TABLE demo_sessions IN ACCESS EXCLUSIVE MODE NOWAIT'); await probe.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE NOWAIT', [s.context.sessionId]); }
        finally { await probe.query('ROLLBACK'); await probe.end(); }
      } finally { await blocker.query('ROLLBACK'); await blocker.end(); }
      assert.equal((await create).statusCode, 201); await session;
    });

    await t.test('multiple drain commands serialize; repeated drain preserves timestamp and configuration', async () => {
      const f = await fixture();
      const before = (await f.db.query('SELECT to_jsonb(t) AS row FROM calculation_types t ORDER BY id')).rows;
      const entered = barrier(); const finish = barrier();
      const first = new DemoAdmissionOperator(f.db, { beforeCommit: async () => { entered.release(); await finish.promise; } }).drain();
      await bounded(entered.promise); const others = Array.from({ length: 3 }, () => f.operator.drain());
      try { await waiters(f.name, '%demo_admission_control%FOR UPDATE%', 3); }
      finally { finish.release(); }
      const states = await Promise.all([first, ...others]);
      assert.ok(states.every(s => s.state === 'DRAINING' && s.updatedAt === states[0]!.updatedAt));
      assert.equal((await f.operator.drain()).updatedAt, states[0]!.updatedAt);
      assert.deepEqual((await f.db.query('SELECT to_jsonb(t) AS row FROM calculation_types t ORDER BY id')).rows, before);
    });

    for (const commit of [true, false]) await t.test(`Scenario unknown COMMIT durable reload after drain: actually committed=${commit}`, async () => {
      const hooks: ScenarioCreateOptions = { commit: async client => { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); throw new Error('private-transport'); } };
      const f = await fixture({ scenario: hooks }); const s = await f.newSession();
      error(await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }), 503, 'DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN');
      delete hooks.commit; await f.operator.drain();
      const r = await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' });
      if (commit) { assert.equal(r.statusCode, 200, r.body); assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 1); }
      else { error(r, 503, 'DEMO_ADMISSION_DRAINING'); assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 0); }
    });

    for (const commit of [true, false]) await t.test(`Session unknown COMMIT never issues a Cookie: actually committed=${commit}`, async () => {
      const f = await fixture();
      const options: DemoSessionServiceOptions = { commit: async client => { await client.query(commit ? 'COMMIT' : 'ROLLBACK'); throw new Error('private-transport'); } };
      const service = new DemoSessionService(f.db, options);
      const { demoSessionRoutes } = await import('../src/modules/demo-session/demo-session.route.js');
      const { default: Fastify } = await import('fastify'); const app = Fastify({ logger: false }); apps.push(app);
      await app.register(demoSessionRoutes(service, { nodeEnvironment: 'test' }));
      const r = await app.inject({ method: 'POST', url: '/demo/sessions', payload: {}, headers: { 'x-demo-session': '1' } });
      error(r, 503, 'DEMO_SESSION_CREATE_OUTCOME_UNKNOWN'); assert.equal(r.headers['set-cookie'], undefined);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, commit ? 1 : 0);
    });

    for (const commit of [true, false]) await t.test(`drain unknown COMMIT uses a different backend and confirms durable state: committed=${commit}`, async () => {
      const f = await fixture(); let originalPid = 0; let recoveryPid = 0;
      const options: AdmissionOperatorOptions = {
        commit: async client => { originalPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await client.query(commit ? 'COMMIT' : 'ROLLBACK'); throw new Error('private-transport'); },
        recoveryClient: () => { const client = new Client({ connectionString: connection(f.name) }); client.on('connect', () => { recoveryPid = Number(Reflect.get(client, 'processID')); }); return client; },
      };
      const result = new DemoAdmissionOperator(f.db, options).drain();
      if (commit) { const state = await result; assert.equal(state.state, 'DRAINING'); assert.equal(state.confirmation, 'DURABLE_RELOAD'); }
      else await assert.rejects(result, { code: 'DEMO_ADMISSION_DRAIN_NOT_APPLIED' });
      assert.ok(originalPid && recoveryPid && originalPid !== recoveryPid);
    });

    await t.test('drain confirmation waits for a transaction owning the gate; unavailable fresh connection remains UNKNOWN', async () => {
      const f = await fixture(); const entered = barrier(); const finish = barrier(); let blocker: Client | undefined;
      const drain = new DemoAdmissionOperator(f.db, {
        commit: async client => { await client.query('ROLLBACK'); blocker = new Client({ connectionString: connection(f.name) }); await blocker.connect(); await blocker.query('BEGIN');
          await blocker.query("UPDATE demo_admission_control SET state='DRAINING' WHERE id=1"); entered.release(); throw new Error('private-transport'); },
      }).drain();
      await bounded(entered.promise);
      try { await waiters(f.name, '%demo_admission_control%FOR UPDATE%'); }
      finally { await blocker!.query('COMMIT'); await blocker!.end(); finish.release(); }
      assert.equal((await drain).confirmation, 'DURABLE_RELOAD');
      await assert.rejects(new DemoAdmissionOperator(f.db, { commit: async client => { await client.query('COMMIT'); throw new Error('private-transport'); },
        recoveryClient: () => { throw new Error('private-transport'); } }).drain(), { code: 'DEMO_ADMISSION_DRAIN_OUTCOME_UNKNOWN' });
      assert.equal((await f.operator.status()).state, 'DRAINING');
    });

    for (const missing of [true, false]) await t.test(`missing/unreadable gate fails closed and is sanitized: missing=${missing}`, async () => {
      const f = await fixture(); const s = await f.newSession();
      if (missing) { await f.db.query('ALTER TABLE demo_admission_control DISABLE TRIGGER USER'); await f.db.query('DELETE FROM demo_admission_control'); }
      else await f.db.query('ALTER TABLE demo_admission_control RENAME TO inaccessible_gate');
      error(await f.post('/demo/sessions'), 503, 'DEMO_ADMISSION_UNAVAILABLE');
      error(await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }), 503, 'DEMO_ADMISSION_UNAVAILABLE');
      await assert.rejects(f.operator.status(), { code: 'DEMO_ADMISSION_UNAVAILABLE' });
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_sessions')).rows[0].n, 1);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_instances')).rows[0].n, 0);
    });

    await t.test('operator CLI requires explicit target, rejects reverse/extra arguments and never logs credentials', async () => {
      const f = await fixture();
      const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/demo-admission.ts', ...args], {
        env: { ...process.env, DEMO_ADMISSION_DATABASE_URL: '', DEMO_ADMISSION_DATABASE_URL_FILE: '', ...env }, encoding: 'utf8', timeout: 15000,
      });
      for (const [args, env] of [[['status'], {}], [['open'], { DEMO_ADMISSION_DATABASE_URL: connection(f.name) }], [['drain', 'extra'], {}],
        [['status'], { DEMO_ADMISSION_DATABASE_URL: connection(f.name), DEMO_ADMISSION_DATABASE_URL_FILE: 'ambiguous-target' }],
        [['status'], { DEMO_ADMISSION_DATABASE_URL: 'postgres://sensitive:private-transport@127.0.0.1:1/missing' }]] as [string[], NodeJS.ProcessEnv][]) {
        const r = cli(args, env); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr + r.stdout, /postgres(?:ql)?:|sensitive|private-transport|password|token_hash/);
      }
      const status = cli(['status'], { DEMO_ADMISSION_DATABASE_URL: connection(f.name) }); assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'LEGACY_OPEN');
      assert.equal((await f.post('/demo/admission/drain')).statusCode, 404);
      for (let i = 0; i < 2; i++) { const r = cli(['drain'], { DEMO_ADMISSION_DATABASE_URL: connection(f.name) }); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).state, 'DRAINING'); }
    });

    await t.test('existing Guided, Free Exploration, expiration/revocation and unknown Reset recovery continue under DRAINING', async () => {
      const resetHooks: ResetOptions = { log() {} }; const f = await fixture({ main: true, reset: resetHooks });
      const free = await f.newSession(); const expired = await f.newSession(); const revoked = await f.newSession();
      const guides = [];
      for (const [type, total] of [['HAPPY_PATH', 6], ['FAILURE_RETRY', 9], ['LOST_RESPONSE_RECOVERY', 6]] as const) {
        const s = await f.newSession(); const scenario = await f.post('/demo/scenarios', s.cookie, { scenarioType: type }); assert.equal(scenario.statusCode, 201, scenario.body);
        guides.push({ ...s, type, total, scenarioId: scenario.json().scenarioId as string });
      }
      const before = (await f.db.query('SELECT id,revoked_at,expires_at FROM demo_sessions ORDER BY id')).rows;
      await f.operator.drain(); assert.deepEqual((await f.db.query('SELECT id,revoked_at,expires_at FROM demo_sessions ORDER BY id')).rows, before);
      for (const guided of guides) {
        assert.equal((await f.post('/demo/sessions', guided.cookie)).statusCode, 200);
        for (let expectedStep = 1; expectedStep <= guided.total; expectedStep++) {
          const payload = { expectedStep, requestId: randomUUID() };
          let r = await f.post(`/demo/scenarios/${guided.scenarioId}/next`, guided.cookie, payload);
          if (r.statusCode === 202) r = await f.post(`/demo/scenarios/${guided.scenarioId}/next`, guided.cookie, payload);
          assert.equal(r.statusCode, 200, r.body);
        }
        const replay = await f.post('/demo/scenarios', guided.cookie, { scenarioType: guided.type });
        assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().status, 'COMPLETED'); assert.equal(replay.json().completedStep, guided.total);
      }
      const data = await f.post('/demo/dataset-versions', free.cookie, { domain: 'CAPEX', fiscalYear: 2026, period: 'Q4' }); assert.equal(data.statusCode, 201, data.body);
      const jobId = data.json().calculationJobs[0].jobId;
      const run = await f.post(`/demo/calculation-jobs/${jobId}/run`, free.cookie, { simulation: { dispatch: 'ACCEPT', completion: 'SUCCEEDED' } }); assert.equal(run.statusCode, 200, run.body);
      assert.equal((await f.post(`/demo/calculation-jobs/${jobId}/reconcile`, free.cookie)).statusCode, 200);
      for (const action of ['submit-validation', 'publish']) assert.equal((await f.post(`/demo/dataset-versions/${data.json().datasetVersionId}/${action}`, free.cookie)).statusCode, 200);
      await f.runtime.sessions.revoke(revoked.context.sessionId);
      await f.db.query("UPDATE demo_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [expired.context.sessionId]);
      for (const s of [expired, revoked]) error(await f.post('/demo/sessions', s.cookie), 401, 'DEMO_SESSION_UNAVAILABLE');
      resetHooks.commit = async client => { await client.query('ROLLBACK'); throw new Error('private-transport'); };
      resetHooks.recoveryClient = () => { throw new Error('private-transport'); };
      error(await f.post('/demo/sessions/reset', free.cookie), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
      delete resetHooks.commit; delete resetHooks.recoveryClient;
      assert.equal(await f.runtime.reset.recoverPendingResets(), 0);
      assert.equal((await f.post('/demo/sessions/reset', free.cookie)).statusCode, 204);
      for (const guided of guides) assert.equal((await f.post('/demo/sessions/reset', guided.cookie)).statusCode, 204);
      error(await f.post('/demo/sessions'), 503, 'DEMO_ADMISSION_DRAINING');
    });
    console.info('DEMO_05C2_VERIFIED', JSON.stringify({ databases: names.length, migrations: 13, rowLockBarriers: true, noReopen: true }));
  } finally {
    for (const app of apps) await app.close();
    for (const db of pools) await db.end();
    for (const key of ['DATABASE_URL', 'APP_MODE', 'NODE_ENV', 'EXECUTOR_TYPE']) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    try {
      for (const name of names.reverse()) {
        const deadline = Date.now() + 5000;
        while ((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name])).rowCount) {
          assert.ok(Date.now() < deadline, 'Fixture backend remained connected'); await setImmediate();
        }
        assert.match(name, /^demo_05c2_[a-z0-9_]+$/); await admin.query(`DROP DATABASE "${name}"`);
      }
      console.info('DEMO_05C2_TEARDOWN', JSON.stringify({ databases: names.length, backends: 0, dropped: true, forced: false }));
    } finally { await admin.end(); }
  }
});
