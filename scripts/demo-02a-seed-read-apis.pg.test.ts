import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Client, type Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { seedDemoGuidedConfiguration, DemoConfigurationConflict } from './seed-demo-guided-configuration.js';
import { DemoRuntime } from '../src/modules/demo-session/demo-runtime.js';
import type { ResetOptions } from '../src/modules/demo-session/demo-session-reset.service.js';
import { DemoReadRepository } from '../src/modules/demo-session/demo-read.repository.js';
import { LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE, type AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';
import { FakeExecutor } from '../src/executors/fake-executor.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-02A requires a safe disposable PostgreSQL service');
function connection(name: string) { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); }
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Session { cookie: string; context: AuthenticatedDemoSession }
function error(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status); assert.equal(response.json().code, code);
  assert.deepEqual(Object.keys(response.json()).sort(), ['code', 'message']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.doesNotMatch(response.body, /token_hash|constraint|SELECT |INSERT |postgresql:\/\//i);
}

test('Demo-02A: explicit seed and session-scoped durable reads', { timeout: 240_000 }, async (t) => {
  const name = `demo_02a_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert.match(name, /^demo_02a_test_[a-z0-9_]+$/); assert.ok(name.length <= 63);
  const prior = { DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV,
    APP_MODE: process.env.APP_MODE, EXECUTOR_TYPE: process.env.EXECUTOR_TYPE,
    DEMO_SEED_DATABASE_URL: process.env.DEMO_SEED_DATABASE_URL };
  const admin = new Client({ connectionString: connection('postgres') });
  const apps: FastifyInstance[] = []; const ends: Promise<void>[] = [];
  let db: Pool | undefined; let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await runner({ databaseUrl: connection(name), dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
      migrationsTable: 'pgmigrations', direction: 'up', singleTransaction: true, checkOrder: true,
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    process.env.DATABASE_URL = connection(name); process.env.NODE_ENV = 'test';
    process.env.APP_MODE = 'demo'; process.env.EXECUTOR_TYPE = 'fake';
    process.env.DEMO_SEED_DATABASE_URL = connection(name);
    const [{ pool }, { buildApp }] = await Promise.all([import('../src/db/pool.js'), import('../src/app.js')]);
    db = pool;
    pool.on('connect', (client) => { ends.push(new Promise<void>((done) => client.once('end', done))); });
    const resetHooks: ResetOptions = { log() {} };
    const runtime = new DemoRuntime(pool, 'test', {}, resetHooks);
    const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false,
      nodeEnvironment: 'test', demoSession: { origin: 'https://demo.test' } }); apps.push(app);
    const post = (url: string, session?: Session, payload: unknown = {}) => app.inject({ method: 'POST', url,
      payload: JSON.stringify(payload), headers: { 'content-type': 'application/json', 'x-demo-session': '1',
        origin: 'https://demo.test', ...(session ? { cookie: session.cookie } : {}) } });
    const get = (url: string, session?: Session, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url,
      headers: { ...(session ? { cookie: session.cookie } : {}), ...extra } });
    const newSession = async (): Promise<Session> => {
      const response = await post('/demo/sessions'); assert.equal(response.statusCode, 201);
      const header = response.headers['set-cookie']; assert.ok(typeof header === 'string');
      const cookie = header.split(';', 1)[0]!;
      return { cookie, context: await runtime.sessions.authenticate(cookie, LOCAL_SESSION_COOKIE) };
    };
    const create = async (s: Session, year = 2026) => {
      const response = await post('/demo/dataset-versions', s, { domain: 'CAPEX', fiscalYear: year, period: 'Q3' });
      assert.equal(response.statusCode, 201);
      return response.json() as { datasetVersionId: string; datasetSeriesId: string; calculationJobs: { jobId: string }[] };
    };
    const run = (s: Session, id: string) => post(`/demo/calculation-jobs/${id}/run`, s);
    const allTables = ['calculation_types', 'execution_dependency_definition_versions',
      'execution_dependency_definition_dependencies', 'dataset_series', 'dataset_versions', 'calculation_jobs',
      'dataset_build_snapshots', 'dataset_build_snapshot_dependencies', 'execution_attempts', 'pgmigrations'];
    const dump = async () => {
      const result: Record<string, unknown> = {};
      for (const table of allTables) result[table] = (await pool.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      result.sessions = (await pool.query('SELECT id,company_code,created_at,expires_at,revoked_at FROM demo_sessions ORDER BY id')).rows;
      return result;
    };
    const seedCli = (overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
      ['--import', 'tsx', 'scripts/seed-demo-guided-configuration.ts'], {
        env: { ...process.env, ...overrides }, encoding: 'utf8', timeout: 20_000,
      });
    console.log('DEMO_02A_RUNTIME', JSON.stringify({ node: process.version, database: name,
      postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
      migrations: (await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n }));

    await t.test('startup/buildApp/session creation never seed; fresh CLI seed creates exact minimal configuration', async () => {
      await newSession();
      assert.equal((await pool.query('SELECT id FROM calculation_types')).rowCount, 0);
      const child = seedCli(); assert.equal(child.status, 0); assert.equal(child.signal, null);
      assert.equal(child.stderr, ''); assert.match(child.stdout, /configuration ready/);
      const type = (await pool.query('SELECT domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version FROM calculation_types')).rows;
      assert.deepEqual(type, [{ domain: 'CAPEX', code: 'DEMO_GUIDED_SUMMARY', airflow_dag_id: 'demo_capex_guided',
        is_active: true, last_allocated_dependency_definition_version: 1 }]);
      const def = (await pool.query('SELECT version,status,published_at FROM execution_dependency_definition_versions')).rows;
      assert.equal(def.length, 1); assert.equal(def[0].version, 1); assert.equal(def[0].status, 'PUBLISHED'); assert.ok(def[0].published_at);
      assert.equal((await pool.query('SELECT definition_version_id FROM execution_dependency_definition_dependencies')).rowCount, 0);
    });

    await t.test('CLI repeat and concurrent seed preserve IDs, counters, published values and all existing data', async () => {
      const before = await dump(); const child = seedCli(); assert.equal(child.status, 0);
      const [a, b] = await Promise.all([seedDemoGuidedConfiguration(pool), seedDemoGuidedConfiguration(pool)]);
      assert.deepEqual(a, b); assert.deepEqual(await dump(), before);
    });

    await t.test('seed safety rejects production/core/unset environment and missing explicit target without fallback or credentials', async () => {
      const before = await dump();
      for (const overrides of [{ NODE_ENV: 'production' }, { NODE_ENV: '' }, { APP_MODE: 'core' },
        { APP_MODE: '' }, { DEMO_SEED_DATABASE_URL: '' }]) {
        const child = seedCli(overrides); assert.equal(child.status, 1); assert.equal(child.signal, null);
        assert.doesNotMatch(child.stderr + child.stdout, /postgres(?:ql)?:\/\/|password|token_hash|SELECT |INSERT /i);
      }
      assert.deepEqual(await dump(), before);
    });

    await t.test('other active CAPEX fails closed, including rollback of newly inserted guided type; other domains preserved', async () => {
      // No Domain data exists yet. Remove only this suite's seed fixture to
      // exercise creation rollback against the real migrated public tables.
      await pool.query('DELETE FROM execution_dependency_definition_versions; DELETE FROM calculation_types');
      const other = (await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES
        ('CAPEX','OTHER','other') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active) VALUES ('DPR','KEEP','keep',false)`);
      const before = await dump();
      try {
        await assert.rejects(seedDemoGuidedConfiguration(pool), DemoConfigurationConflict);
        assert.deepEqual(await dump(), before);
      } finally { await pool.query('DELETE FROM calculation_types WHERE id=$1', [other]); }
      await seedDemoGuidedConfiguration(pool);
    });

    await t.test('every incompatible existing guided configuration rolls back without rewriting published history', async () => {
      const mutations = [
        ["UPDATE calculation_types SET airflow_dag_id='wrong' WHERE domain='CAPEX'", "UPDATE calculation_types SET airflow_dag_id='demo_capex_guided' WHERE domain='CAPEX'"],
        ["UPDATE calculation_types SET is_active=false WHERE domain='CAPEX'", "UPDATE calculation_types SET is_active=true WHERE domain='CAPEX'"],
        ["UPDATE calculation_types SET last_allocated_dependency_definition_version=2 WHERE domain='CAPEX'", "UPDATE calculation_types SET last_allocated_dependency_definition_version=1 WHERE domain='CAPEX'"],
        ["INSERT INTO execution_dependency_definition_dependencies SELECT id,'DPR' FROM execution_dependency_definition_versions", "DELETE FROM execution_dependency_definition_dependencies WHERE required_domain='DPR'"],
        ["UPDATE execution_dependency_definition_versions SET status='DRAFT'", "UPDATE execution_dependency_definition_versions SET status='PUBLISHED'"],
        ["INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status) SELECT id,2,'DRAFT' FROM calculation_types WHERE domain='CAPEX'", "DELETE FROM execution_dependency_definition_versions WHERE version=2"],
        ["INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES ('CAPEX','CONFLICT','conflict')", "DELETE FROM calculation_types WHERE code='CONFLICT'"],
      ];
      for (const [mutation, restore] of mutations) {
        await pool.query(mutation!);
        try {
          const before = await dump();
          await assert.rejects(seedDemoGuidedConfiguration(pool), DemoConfigurationConflict);
          assert.deepEqual(await dump(), before);
        } finally { await pool.query(restore!); }
      }
    });

    await t.test('unexpected real PostgreSQL insert failure is sanitized and rolls back the newly inserted type', async () => {
      await pool.query("DELETE FROM execution_dependency_definition_versions; DELETE FROM calculation_types WHERE domain='CAPEX'");
      await pool.query(`CREATE FUNCTION demo_02a_seed_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'private SQL credential detail'; END $$;
        CREATE TRIGGER demo_02a_seed_failure BEFORE INSERT ON execution_dependency_definition_versions
        FOR EACH ROW EXECUTE FUNCTION demo_02a_seed_failure()`);
      const before = await dump();
      try {
        await assert.rejects(seedDemoGuidedConfiguration(pool), { message: 'Demo configuration seed persistence failed' });
        const child = seedCli(); assert.equal(child.status, 1); assert.doesNotMatch(child.stderr, /private SQL|credential detail/);
        assert.deepEqual(await dump(), before);
      } finally { await pool.query('DROP TRIGGER demo_02a_seed_failure ON execution_dependency_definition_versions; DROP FUNCTION demo_02a_seed_failure()'); }
      await seedDemoGuidedConfiguration(pool);
    });

    await t.test('missing definition and missing publication timestamp fail closed, never silently repaired', async () => {
      const d = (await pool.query('SELECT id,calculation_type_id,version,status,created_at,published_at FROM execution_dependency_definition_versions')).rows[0];
      for (const mutation of ['DELETE FROM execution_dependency_definition_versions', 'UPDATE execution_dependency_definition_versions SET published_at=NULL']) {
        await pool.query(mutation);
        try {
          const before = await dump(); await assert.rejects(seedDemoGuidedConfiguration(pool), DemoConfigurationConflict);
          assert.deepEqual(await dump(), before);
        } finally {
          if (mutation.startsWith('DELETE')) await pool.query(`INSERT INTO execution_dependency_definition_versions
            (id,calculation_type_id,version,status,created_at,published_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [d.id,d.calculation_type_id,d.version,d.status,d.created_at,d.published_at]);
          else await pool.query('UPDATE execution_dependency_definition_versions SET published_at=$1 WHERE id=$2', [d.published_at,d.id]);
        }
      }
    });

    const a = await newSession(); const b = await newSession();
    const dataA = await create(a); const dataB = await create(b);
    const jobA = dataA.calculationJobs[0]!.jobId; const jobB = dataB.calculationJobs[0]!.jobId;
    let attemptA = ''; let attemptB = '';
    await t.test('seeded HTTP happy path runs, reconciles, submits and publishes; read status is durable not fake memory', async () => {
      for (const [s, data, job] of [[a, dataA, jobA], [b, dataB, jobB]] as const) {
        const running = await run(s, job); assert.equal(running.statusCode, 200);
        const id = running.json().executionAttemptId as string;
        if (s === a) attemptA = id; else attemptB = id;
        assert.equal((await post(`/demo/execution-attempts/${id}/fake-state`, s, { state: 'SUCCEEDED' })).statusCode, 200);
        assert.equal((await get(`/demo/calculation-jobs/${job}`, s)).json().jobStatus, 'RUNNING');
        assert.equal((await get(`/demo/calculation-jobs/${job}/execution-attempts`, s)).json().items[0].attemptStatus, 'ACCEPTED');
        assert.equal((await post(`/demo/calculation-jobs/${job}/reconcile`, s)).statusCode, 200);
        for (const command of ['submit-validation', 'publish']) assert.equal((await post(`/demo/dataset-versions/${data.datasetVersionId}/${command}`, s)).statusCode, 200);
        const response = await get(`/demo/dataset-versions/${data.datasetVersionId}`, s);
        assert.equal(response.statusCode, 200); assert.equal(response.json().datasetStatus, 'PUBLISHED'); assert.ok(response.json().publishedAt);
      }
    });

    const paths = (dataset: string, job: string) => ['/demo/dataset-versions', `/demo/dataset-versions/${dataset}`,
      `/demo/dataset-versions/${dataset}/calculation-jobs`, `/demo/calculation-jobs/${job}`,
      `/demo/calculation-jobs/${job}/execution-attempts`];
    await t.test('both sessions read only own lists/details with explicit DTO fields; no mutation header needed', async () => {
      for (const [s, own, other, job, attempt] of [[a, dataA, dataB, jobA, attemptA], [b, dataB, dataA, jobB, attemptB]] as const) {
        for (const path of paths(own.datasetVersionId, job)) {
          const response = await get(path, s); assert.equal(response.statusCode, 200);
          assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['access-control-allow-credentials'], undefined);
          assert.doesNotMatch(response.body, /companyCode|token|hash|airflow|last_dispatch_error|scripted|upstream/i);
          assert.ok(!response.body.includes(other.datasetVersionId));
        }
        assert.deepEqual((await get('/demo/dataset-versions', s)).json().items.map((r: { datasetVersionId: string }) => r.datasetVersionId), [own.datasetVersionId]);
        const dataset = (await get(`/demo/dataset-versions/${own.datasetVersionId}`, s)).json();
        assert.deepEqual(Object.keys(dataset).sort(), ['datasetVersionId','datasetSeriesId','domain','fiscalYear','period','version','datasetStatus','createdAt',
          'buildingStartedAt','validatingAt','publishedAt','rejectedAt','abandonedAt'].sort());
        const jobs = (await get(`/demo/dataset-versions/${own.datasetVersionId}/calculation-jobs`, s)).json();
        assert.deepEqual(jobs.items.map((r: { jobId: string }) => r.jobId), [job]);
        assert.deepEqual(Object.keys(jobs.items[0]).sort(), ['jobId','datasetVersionId','calculationTypeCode','jobStatus','createdAt','startedAt','finishedAt'].sort());
        const attempts = (await get(`/demo/calculation-jobs/${job}/execution-attempts`, s)).json();
        assert.equal(attempts.items[0].executionAttemptId, attempt);
        assert.deepEqual(Object.keys(attempts.items[0]).sort(), ['executionAttemptId','attemptNumber','attemptStatus','createdAt','dispatchStartedAt','acceptedAt','finishedAt'].sort());
      }
    });

    await t.test('foreign/missing/invalid UUIDs have identical generic 404 on every resource read in both directions', async () => {
      for (const [s, foreign, foreignJob] of [[a, dataB, jobB], [b, dataA, jobA]] as const) {
        for (const template of ['/demo/dataset-versions/ID','/demo/dataset-versions/ID/calculation-jobs',
          '/demo/calculation-jobs/ID','/demo/calculation-jobs/ID/execution-attempts']) {
          const bodies = [];
          for (const id of [template.includes('dataset-versions') ? foreign.datasetVersionId : foreignJob, randomUUID(), 'invalid', "' OR true--"]) {
            const response = await get(template.replace('ID', encodeURIComponent(id)), s);
            error(response, 404, 'DEMO_RESOURCE_UNAVAILABLE'); bodies.push(response.json());
          }
          for (const body of bodies) assert.deepEqual(body, bodies[0]);
        }
      }
    });

    await t.test('missing/invalid/expired/revoked sessions clear cookie and deny every read without domain data', async () => {
      const expired = await newSession(); const revoked = await newSession();
      await pool.query("UPDATE demo_sessions SET created_at=now()-interval '5 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [expired.context.sessionId]);
      await runtime.sessions.revoke(revoked.context.sessionId);
      for (const path of paths(dataA.datasetVersionId, jobA)) {
        for (const s of [undefined, expired, revoked, { ...a, cookie: `${LOCAL_SESSION_COOKIE}=invalid` }]) {
          const response = await get(path, s); error(response, 401, 'DEMO_SESSION_UNAVAILABLE');
          assert.match(String(response.headers['set-cookie']), /Max-Age=0/); assert.ok(!response.body.includes(jobA));
        }
      }
      const secure = await buildApp({ appMode: 'demo', demoRuntime: runtime, logger: false, nodeEnvironment: 'test',
        demoSession: { secureCookies: true, origin: 'https://demo.test' } }); apps.push(secure);
      for (const path of paths(dataA.datasetVersionId, jobA)) {
        const response = await secure.inject({ method: 'GET', url: path,
          headers: { cookie: expired.cookie.replace(LOCAL_SESSION_COOKIE, SECURE_SESSION_COOKIE) } });
        error(response, 401, 'DEMO_SESSION_UNAVAILABLE');
        const clearing = String(response.headers['set-cookie']);
        assert.ok(clearing.startsWith(`${SECURE_SESSION_COOKIE}=;`));
        assert.match(clearing, /Max-Age=0/); assert.match(clearing, /; Secure/);
        assert.match(clearing, /HttpOnly/); assert.match(clearing, /SameSite=Strict/);
      }
    });

    await t.test('unexpected PostgreSQL read failures return sanitized 500 and preserve all durable/fake state', async () => {
      const before = await dump(); const fakeCount = runtime.executors.size;
      await pool.query('ALTER TABLE dataset_versions RENAME TO demo_02a_unavailable_versions');
      try {
        for (const path of paths(dataA.datasetVersionId, jobA)) {
          const response = await get(path, a); error(response, 500, 'INTERNAL_SERVER_ERROR');
          assert.doesNotMatch(response.body, /demo_02a_unavailable|dataset_versions|42P01|relation/i);
        }
      } finally { await pool.query('ALTER TABLE demo_02a_unavailable_versions RENAME TO dataset_versions'); }
      assert.deepEqual(await dump(), before); assert.equal(runtime.executors.size, fakeCount);
    });

    await t.test('GET keeps same-origin restrictions without opening CORS; core mode does not register protected reads', async () => {
      for (const path of paths(dataA.datasetVersionId, jobA)) {
        error(await get(path, a, { origin: 'https://evil.test' }), 403, 'DEMO_SESSION_CSRF_REJECTED');
        error(await get(path, a, { 'sec-fetch-site': 'cross-site' }), 403, 'DEMO_SESSION_CSRF_REJECTED');
        assert.equal((await get(path, a, { origin: 'https://demo.test' })).statusCode, 200);
      }
      delete process.env.APP_MODE;
      try {
        const core = await buildApp({ appMode: 'core', logger: false, nodeEnvironment: 'test' }); apps.push(core);
        for (const path of paths(dataA.datasetVersionId, jobA)) assert.equal((await core.inject({ method: 'GET', url: path })).statusCode, 404);
      } finally { process.env.APP_MODE = 'demo'; }
    });

    await t.test('running and queued GETs reserve coordinator: Reset conflicts; other session reads proceed independently', async () => {
      const entered = barrier(); const finish = barrier(); const original = DemoReadRepository.prototype.dataset;
      DemoReadRepository.prototype.dataset = async function (s, id) {
        const result = await original.call(this, s, id);
        if (s.sessionId === a.context.sessionId) { entered.release(); await finish.promise; }
        return result;
      };
      let reading: Promise<Response> | undefined;
      try {
        reading = Promise.resolve(get(`/demo/dataset-versions/${dataA.datasetVersionId}`, a));
        await entered.promise;
        const queued = Promise.resolve(get('/demo/dataset-versions', a));
        error(await post('/demo/sessions/reset', a), 409, 'RESET_CONFLICT');
        assert.equal((await get(`/demo/dataset-versions/${dataB.datasetVersionId}`, b)).statusCode, 200);
        finish.release(); assert.equal((await reading).statusCode, 200); assert.equal((await queued).statusCode, 200);
      } finally { finish.release(); await reading; DemoReadRepository.prototype.dataset = original; }
    });

    await t.test('Reset reservation prevents partial-cleanup GET, preserves B independence, then returns unavailable after commit', async () => {
      const s = await newSession(); const data = await create(s); await run(s, data.calculationJobs[0]!.jobId);
      const entered = barrier(); const finish = barrier();
      resetHooks.beforeCommit = async () => { entered.release(); await finish.promise; };
      const resetting = Promise.resolve(post('/demo/sessions/reset', s));
      try {
        await entered.promise;
        for (const path of paths(data.datasetVersionId, data.calculationJobs[0]!.jobId)) {
          error(await get(path, s), 409, 'RESET_CONFLICT');
        }
        assert.equal((await get('/demo/dataset-versions', b)).statusCode, 200);
      } finally { finish.release(); delete resetHooks.beforeCommit; }
      assert.equal((await resetting).statusCode, 204);
      error(await get('/demo/dataset-versions', s), 401, 'DEMO_SESSION_UNAVAILABLE');
    });

    await t.test('queue-full and unknown-reset error contracts apply to all GETs', async () => {
      const gate = barrier(); const entered = barrier();
      const operations = Array.from({ length: 32 }, (_, i) => runtime.coordinator.run(a.context, async () => {
        if (i === 0) { entered.release(); await gate.promise; }
      }));
      try {
        await entered.promise;
        for (const path of paths(dataA.datasetVersionId, jobA)) error(await get(path, a), 429, 'DEMO_SESSION_QUEUE_FULL');
      } finally { gate.release(); await Promise.all(operations); }
      const lease = runtime.coordinator.tryBeginReset(a.context); lease.unknown = true;
      try {
        for (const path of paths(dataA.datasetVersionId, jobA)) error(await get(path, a), 503, 'DEMO_RESET_OUTCOME_UNKNOWN');
      } finally { runtime.coordinator.finishReset(lease); }
    });

    await t.test('queued read revalidates session before executing SQL after expiry/revocation', async () => {
      const s = await newSession(); const gate = barrier(); const entered = barrier(); const admitted = barrier();
      const hold = runtime.coordinator.run(s.context, async () => { entered.release(); await gate.promise; });
      await entered.promise;
      // Observe actual route admission, not a timing sleep.
      const original = runtime.coordinator.run.bind(runtime.coordinator);
      runtime.coordinator.run = (session, body) => {
        const result = original(session, body); if (session.sessionId === s.context.sessionId) admitted.release(); return result;
      };
      let reading: Promise<Response> | undefined;
      try {
        reading = Promise.resolve(get('/demo/dataset-versions', s)); await admitted.promise;
        await runtime.sessions.revoke(s.context.sessionId); gate.release();
        error(await reading, 401, 'DEMO_SESSION_UNAVAILABLE');
      } finally { gate.release(); await hold; await reading; runtime.coordinator.run = original; }
    });

    const p = await newSession(); const paged = await create(p, 2040); const pagedJob = paged.calculationJobs[0]!.jobId;
    await t.test('pagination fixtures use real persisted datasets/jobs/attempts, including more than the maximum page size', async () => {
      const seed = await seedDemoGuidedConfiguration(pool);
      // Terminal history: one real job per version; monotonic counter retained.
      await pool.query(`INSERT INTO dataset_versions(id,dataset_series_id,version,status,abandoned_at)
        SELECT gen_random_uuid(),$1,n,'ABANDONED',now() FROM generate_series(2,116) n`, [paged.datasetSeriesId]);
      await pool.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,status)
        SELECT gen_random_uuid(),id,$2,'PENDING' FROM dataset_versions WHERE dataset_series_id=$1 AND version>1`, [paged.datasetSeriesId, seed.calculationTypeId]);
      await pool.query('UPDATE dataset_series SET last_allocated_version=116 WHERE id=$1', [paged.datasetSeriesId]);
      for (let n = 0; n < 105; n++) {
        const type = (await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active,last_allocated_dependency_definition_version)
          VALUES ('CAPEX',$1,'fixture_capex',false,1) RETURNING id`, [`READ_FIXTURE_${n}`])).rows[0].id;
        await pool.query(`INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status,published_at)
          VALUES ($1,1,'PUBLISHED',now())`, [type]);
        await pool.query(`INSERT INTO calculation_jobs(id,output_dataset_version_id,calculation_type_id,status)
          VALUES (gen_random_uuid(),$1,$2,'PENDING')`, [paged.datasetVersionId, type]);
      }
      const accepted = await run(p, pagedJob); assert.equal(accepted.statusCode, 200);
      await post(`/demo/execution-attempts/${accepted.json().executionAttemptId}/fake-state`, p, { state: 'FAILED' });
      assert.equal((await post(`/demo/calculation-jobs/${pagedJob}/reconcile`, p)).statusCode, 200);
      await pool.query(`INSERT INTO execution_attempts(calculation_job_id,attempt_number,status,airflow_dag_id,airflow_dag_run_id,dispatch_started_at,finished_at)
        SELECT $1,n,'DISPATCH_FAILED','fixture_capex',gen_random_uuid()::text,now(),now() FROM generate_series(2,136) n`, [pagedJob]);
    });

    await t.test('all lists paginate deterministically without duplicates/missing rows, enforce maximum and parent/session scope', async () => {
      const cases = [
        { path: '/demo/dataset-versions', key: 'datasetVersionId', expected: (await pool.query(`SELECT v.id FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1 ORDER BY v.id`, [p.context.companyCode])).rows.map((r) => r.id) },
        { path: `/demo/dataset-versions/${paged.datasetVersionId}/calculation-jobs`, key: 'jobId', expected: (await pool.query('SELECT id FROM calculation_jobs WHERE output_dataset_version_id=$1 ORDER BY id', [paged.datasetVersionId])).rows.map((r) => r.id) },
        { path: `/demo/calculation-jobs/${pagedJob}/execution-attempts`, key: 'executionAttemptId', expected: (await pool.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 ORDER BY attempt_number', [pagedJob])).rows.map((r) => r.id) },
      ];
      for (const c of cases) {
        const ids: string[] = []; let cursor: string | null = null; let pages = 0;
        do {
          const response = await get(`${c.path}?limit=7${cursor ? `&cursor=${cursor}` : ''}`, p);
          assert.equal(response.statusCode, 200); const page = response.json(); assert.ok(page.items.length <= 7);
          ids.push(...page.items.map((r: Record<string, string>) => r[c.key]));
          cursor = page.nextCursor; assert.ok(++pages < 50);
          if (cursor) error(await get(`${c.path}?cursor=${cursor}`, b), 400, 'INVALID_REQUEST');
        } while (cursor);
        assert.deepEqual(ids, c.expected); assert.equal(new Set(ids).size, ids.length);
        const max = (await get(`${c.path}?limit=100`, p)).json(); assert.equal(max.items.length, 100); assert.ok(max.nextCursor);
        for (const query of ['limit=0','limit=101','limit=-1','limit=1.5','limit=01','limit=1&limit=2','limit=abc',
          'cursor=bad','cursor=','cursor=eyJ2IjoxfQ','companyCode=other','cursor=' + 'A'.repeat(513)]) {
          error(await get(`${c.path}?${query}`, p), 400, 'INVALID_REQUEST');
        }
      }
      const cursor = (await get(`/demo/dataset-versions/${paged.datasetVersionId}/calculation-jobs?limit=1`, p)).json().nextCursor;
      error(await get(`/demo/dataset-versions/${dataA.datasetVersionId}/calculation-jobs?cursor=${cursor}`, p), 400, 'INVALID_REQUEST');
      for (const path of [`/demo/dataset-versions/${dataA.datasetVersionId}`, `/demo/calculation-jobs/${jobA}`]) {
        error(await get(`${path}?limit=1`, a), 400, 'INVALID_REQUEST');
      }
    });

    await t.test('empty owned pages remain 200; arbitrary well-shaped cursors cannot bypass parent ownership', async () => {
      const registry = runtime.executors.size;
      const empty = await newSession(); const draft = await create(empty);
      assert.deepEqual((await get('/demo/dataset-versions', await newSession())).json(), { items: [], nextCursor: null });
      assert.deepEqual((await get(`/demo/calculation-jobs/${draft.calculationJobs[0]!.jobId}/execution-attempts`, empty)).json(), { items: [], nextCursor: null });
      const forged = Buffer.from(JSON.stringify({ v: 1, kind: 'jobs', scope: `${a.context.sessionId}:${dataB.datasetVersionId}`, after: randomUUID() })).toString('base64url');
      error(await get(`/demo/dataset-versions/${dataB.datasetVersionId}/calculation-jobs?cursor=${forged}`, a), 404, 'DEMO_RESOURCE_UNAVAILABLE');
      assert.equal(runtime.executors.size, registry, 'GET must not allocate a FakeExecutor');
    });

    await t.test('GET is read-only across entire PostgreSQL graph, shared config, sessions and every FakeExecutor memory field', async () => {
      const before = await dump();
      await seedDemoGuidedConfiguration(pool);
      assert.deepEqual(await dump(), before, 'Seed also preserves existing datasets/jobs/attempts and inactive types');
      const fakes: FakeExecutor[] = [];
      for (const s of [a, b, p]) fakes.push(await runtime.executors.forSession(s.context));
      const fakeMemory = () => JSON.stringify(fakes, (_key, value: unknown) =>
        value instanceof Map ? [...value.entries()] : value instanceof Set ? [...value.values()] : value);
      const fakeBefore = fakeMemory(); const registry = runtime.executors.size;
      for (const [s, data] of [[a, dataA], [b, dataB], [p, paged]] as const) {
        for (const path of paths(data.datasetVersionId, data.calculationJobs[0]!.jobId)) assert.equal((await get(path, s)).statusCode, 200);
      }
      assert.deepEqual(await dump(), before); assert.equal(fakeMemory(), fakeBefore); assert.equal(runtime.executors.size, registry);
    });

    await t.test('existing PostgreSQL indexes cover bounded parent lookups; query plans are recorded without schema changes', async () => {
      const indexes = (await pool.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
        AND tablename IN ('dataset_series','dataset_versions','calculation_jobs','execution_attempts') ORDER BY tablename,indexname`)).rows;
      console.log('DEMO_02A_INDEX_REVIEW', JSON.stringify(indexes));
      for (const [sql, args] of [
        ['SELECT id FROM dataset_series WHERE company_code=$1', [p.context.companyCode]],
        ['SELECT id FROM calculation_jobs WHERE output_dataset_version_id=$1 ORDER BY id LIMIT 101', [paged.datasetVersionId]],
        ['SELECT id FROM execution_attempts WHERE calculation_job_id=$1 AND attempt_number>20 ORDER BY attempt_number LIMIT 21', [pagedJob]],
      ] as const) {
        const plan = await pool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`, [...args]);
        console.log('DEMO_02A_QUERY_PLAN', JSON.stringify(plan.rows));
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n, 7);
    });
  } finally {
    try { await Promise.all(apps.map((app) => app.close())); if (db) { await db.end(); await Promise.all(ends); } }
    finally {
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      try {
        if (created) {
          const deadline = Date.now() + 5000;
          let sessions = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
          while (sessions.rowCount && Date.now() < deadline) {
            await setImmediate(); sessions = await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1', [name]);
          }
          assert.equal(sessions.rowCount, 0, 'All owned PostgreSQL backends must exit before DROP');
          assert.match(name, /^demo_02a_test_[a-z0-9_]+$/); await admin.query(`DROP DATABASE "${name}"`);
          console.log('DEMO_02A_TEARDOWN', JSON.stringify({ database: name, sessions: 0, dropped: true, forced: false }));
        }
      } finally { await admin.end(); }
    }
  }
});
