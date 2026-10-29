import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { Client, Pool, type PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import type { FastifyInstance } from 'fastify';
import { DemoCutoverOperator, type CutoverOptions } from '../src/modules/demo-cutover/demo-cutover.operator.js';
import { DemoAdmissionOperator } from '../src/modules/demo-admission/demo-admission.operator.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Cutover tests require a disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrate = (url: string, direction: 'up' | 'down' = 'up', count?: number) => runner({ databaseUrl: url,
  dir: migrations, direction, count, migrationsTable: 'pgmigrations', singleTransaction: true, checkOrder: true,
  logger: { debug() {}, info() {}, warn() {}, error() {} } });
function barrier() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Barrier timeout')), 8000); })]); }
  finally { clearTimeout(timer); }
}
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
function error(r: Response, code: string, status = 503) {
  assert.equal(r.statusCode, status, r.body); assert.equal(r.json().code, code);
  assert.deepEqual(Object.keys(r.json()).sort(), ['code', 'message']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.doesNotMatch(r.body, /postgres(?:ql)?:|private-transport|password|token_hash|SELECT |INSERT /);
}

test('Demo-05C-3A: atomic CAPEX cutover, exact history and durable confirmation', { timeout: 600_000 }, async t => {
  const admin = new Client({ connectionString: connection('postgres') }); await admin.connect();
  const names: string[] = []; const pools: Pool[] = []; const apps: FastifyInstance[] = []; const prior = { ...process.env };
  const createDatabase = async (count?: number) => {
    const name = `demo_05c3a_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    assert.match(name, /^demo_05c3a_[a-z0-9_]+$/); assert.ok(name.length < 64);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); names.push(name); await migrate(connection(name), 'up', count); return name;
  };
  try {
    const mainName = await createDatabase();
    process.env.DATABASE_URL = connection(mainName); process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'test'; process.env.EXECUTOR_TYPE = 'fake';
    const [{ pool: corePool }, { buildApp }, { DemoRuntime }, { seedDemoSixDomainConfiguration }, { verifyDemoDatabase }] = await Promise.all([
      import('../src/db/pool.js'), import('../src/app.js'), import('../src/modules/demo-session/demo-runtime.js'),
      import('./seed-demo-six-domain-configuration.js'), import('../src/deployment/verify-database.js'),
    ]); pools.push(corePool);
    const fixture = async (main = false, seeded = true) => {
      const name = main ? mainName : await createDatabase();
      const db = main ? corePool : new Pool({ connectionString: connection(name), max: 12 }); if (!main) pools.push(db);
      if (seeded) await seedDemoSixDomainConfiguration(db);
      const runtime = new DemoRuntime(db, 'test', {}, { log() {} });
      const app = await buildApp({ appMode: 'demo', demoRuntime: runtime, nodeEnvironment: 'test', logger: false, demoSession: { origin: 'https://demo.test' } }); apps.push(app);
      const post = (url: string, cookie?: string, payload: unknown = {}) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', origin: 'https://demo.test', 'x-demo-session': '1', ...(cookie ? { cookie } : {}) } });
      const session = async () => {
        const r = await post('/demo/sessions'); assert.equal(r.statusCode, 201, r.body);
        const cookie = String(r.headers['set-cookie']).split(';')[0]!;
        return { cookie, context: await runtime.sessions.authenticate(cookie, 'ce_demo_session') };
      };
      return { name, db, runtime, app, post, session, operator: new DemoCutoverOperator(db) };
    };
    const snapshot = async (db: Pool, otherDomains = false) => {
      const tables = ['calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies','demo_admission_control'];
      const result: Record<string, unknown> = {};
      for (const table of tables) {
        const where = !otherDomains ? '' : table === 'calculation_types' ? "WHERE r.domain<>'CAPEX'"
          : table === 'demo_admission_control' ? 'WHERE false' : table === 'execution_dependency_definition_versions'
            ? "WHERE r.calculation_type_id IN (SELECT id FROM calculation_types WHERE domain<>'CAPEX')"
            : "WHERE r.definition_version_id IN (SELECT d.id FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.domain<>'CAPEX')";
        result[table] = (await db.query(`SELECT to_jsonb(r) AS row FROM ${table} r ${where} ORDER BY to_jsonb(r)::text`)).rows;
      }
      return result;
    };
    const v1 = async (db: Pool) => (await db.query(`SELECT to_jsonb(d) AS row FROM execution_dependency_definition_versions d
      JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.domain='CAPEX' AND t.code='DEMO_GUIDED_SUMMARY' AND d.version=1`)).rows;
    const drain = async (f: Awaited<ReturnType<typeof fixture>>) => { assert.equal((await new DemoAdmissionOperator(f.db).drain()).state, 'DRAINING'); };
    const waitGate = async (name: string, pattern: string) => bounded((async () => {
      for (;;) {
        const r = await admin.query<{ pid: number; blockers: number[] }>(`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE $2`, [name, pattern]);
        if (r.rows.length) { assert.ok(r.rows[0]!.blockers.length); return r.rows[0]!; } await setImmediate();
      }
    })());

    await t.test('forward migration preserves the control row; legal one-way transitions and guarded Down', async () => {
      const name = await createDatabase(13); const db = new Pool({ connectionString: connection(name) }); pools.push(db);
      const original = (await db.query('SELECT to_jsonb(g) AS row FROM demo_admission_control g')).rows;
      await migrate(connection(name)); assert.deepEqual((await db.query('SELECT to_jsonb(g) AS row FROM demo_admission_control g')).rows, original);
      await assert.rejects(db.query("UPDATE demo_admission_control SET state='WORKFLOW_OPEN'"));
      await db.query("UPDATE demo_admission_control SET state='DRAINING'");
      const drained = (await db.query('SELECT to_jsonb(g) AS row FROM demo_admission_control g')).rows;
      await migrate(connection(name), 'down', 1); assert.deepEqual((await db.query('SELECT to_jsonb(g) AS row FROM demo_admission_control g')).rows, drained);
      await migrate(connection(name)); assert.deepEqual((await db.query('SELECT to_jsonb(g) AS row FROM demo_admission_control g')).rows, drained);
      await db.query("UPDATE demo_admission_control SET state='WORKFLOW_OPEN'");
      for (const sql of ["UPDATE demo_admission_control SET state='DRAINING'", "UPDATE demo_admission_control SET state='LEGACY_OPEN'", 'DELETE FROM demo_admission_control', 'TRUNCATE demo_admission_control']) await assert.rejects(db.query(sql));
      await assert.rejects(migrate(connection(name), 'down', 1));
    });

    await t.test('exact target, v1/other-domain history preserved; replay is read-only with active Workflow Sessions', async () => {
      const f = await fixture(); await drain(f); const old = await v1(f.db); const other = await snapshot(f.db, true);
      const applied = await f.operator.cutover(); assert.equal(applied.outcome, 'APPLIED'); assert.equal(applied.state, 'WORKFLOW_OPEN');
      assert.deepEqual(await v1(f.db), old); assert.deepEqual(await snapshot(f.db, true), other);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM calculation_types WHERE is_active')).rows[0].n, 10);
      const capex = (await f.db.query(`SELECT t.code,d.version,d.status,d.published_at,ARRAY(SELECT required_domain
        FROM execution_dependency_definition_dependencies e WHERE e.definition_version_id=d.id ORDER BY required_domain) AS deps
        FROM calculation_types t JOIN execution_dependency_definition_versions d ON d.calculation_type_id=t.id
        WHERE t.domain='CAPEX' ORDER BY t.code,d.version`)).rows;
      assert.deepEqual(capex.map(r => [r.code,r.version,r.status,r.deps]), [
        ['DEMO_CAPEX_TABLE_Y',1,'PUBLISHED',['FAB_COST']], ['DEMO_GUIDED_SUMMARY',1,'PUBLISHED',[]], ['DEMO_GUIDED_SUMMARY',2,'PUBLISHED',['FAB_COST']],
      ]); assert.ok(capex.every(r => r.published_at));
      await f.session();
      await f.db.query(`CREATE FUNCTION forbid_cutover_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Unexpected configuration rewrite'; END $$`);
      for (const table of ['calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies','demo_admission_control'])
        await f.db.query(`CREATE TRIGGER forbid_cutover_rewrite BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION forbid_cutover_rewrite()`);
      const before = await snapshot(f.db); assert.equal((await f.operator.cutover()).outcome, 'ALREADY_APPLIED');
      assert.deepEqual(await snapshot(f.db), before); assert.equal((await f.operator.status()).configuration, 'WORKFLOW');
      const admission = new (await import('../src/modules/demo-admission/demo-admission.operator.js')).DemoAdmissionOperator(f.db);
      assert.equal((await admission.status()).state, 'WORKFLOW_OPEN');
      await assert.rejects(admission.drain(), { code: 'DEMO_LEGACY_DRAIN_CLOSED' });
      assert.deepEqual(await snapshot(f.db), before); await assert.rejects(migrate(connection(f.name), 'down', 1));
    });

    await t.test('LEGACY_OPEN is refused without changing configuration or Gate', async () => {
      const f = await fixture(); const before = await snapshot(f.db);
      await assert.rejects(f.operator.cutover(), { code: 'DEMO_CUTOVER_REQUIRES_DRAIN' }); assert.deepEqual(await snapshot(f.db), before);
    });

    for (const retained of ['active-session','scenario','ledger','dataset-graph']) await t.test(`${retained} blocks cutover with no deletion`, async () => {
      const f = await fixture(); const s = await f.session();
      if (retained === 'scenario' || retained === 'ledger') {
        const r = await f.post('/demo/scenarios', s.cookie, { scenarioType: 'HAPPY_PATH' }); assert.equal(r.statusCode, 201, r.body);
        if (retained === 'ledger') {
          // A completed durable intent can exist even when no Domain operation was required.
          // Use the supported Step service on the main Core DB only in the end-to-end test;
          // here reserve a valid pending first-step ledger fixture through the repository.
          const intent = { domain: 'CAPEX', companyCode: s.context.companyCode, fiscalYear: 2026, period: 'Q4', expectedVersion: 1, calculationTypeCode: 'DEMO_GUIDED_SUMMARY' };
          await f.db.query('INSERT INTO demo_scenario_step_executions(scenario_id,step_number,request_id,intent) VALUES($1,1,$2,$3)', [r.json().scenarioId,randomUUID(),intent]);
          assert.equal((await f.db.query('SELECT count(*)::int AS n FROM demo_scenario_step_executions')).rows[0].n, 1);
        }
      }
      if (retained === 'dataset-graph') {
        const series = (await f.db.query(`INSERT INTO dataset_series(id,domain,company_code,fiscal_year,period) VALUES(gen_random_uuid(),'CAPEX',$1,2026,'Q4') RETURNING id`, [s.context.companyCode])).rows[0].id;
        await f.db.query("INSERT INTO dataset_versions(id,dataset_series_id,version,status) VALUES(gen_random_uuid(),$1,1,'DRAFT')", [series]);
      }
      if (retained !== 'active-session') await f.runtime.sessions.revoke(s.context.sessionId);
      await drain(f); const before = await snapshot(f.db);
      const counts = (await f.db.query(`SELECT (SELECT count(*) FROM demo_sessions) AS sessions,(SELECT count(*) FROM demo_scenario_instances) AS scenarios,
        (SELECT count(*) FROM demo_scenario_step_executions) AS ledgers,(SELECT count(*) FROM dataset_series) AS series`)).rows;
      await assert.rejects(f.operator.cutover(), { code: 'DEMO_CUTOVER_PRECONDITION_FAILED' }); assert.deepEqual(await snapshot(f.db), before);
      assert.deepEqual((await f.db.query(`SELECT (SELECT count(*) FROM demo_sessions) AS sessions,(SELECT count(*) FROM demo_scenario_instances) AS scenarios,
        (SELECT count(*) FROM demo_scenario_step_executions) AS ledgers,(SELECT count(*) FROM dataset_series) AS series`)).rows, counts);
    });

    const corruptions = [
      "UPDATE calculation_types SET airflow_dag_id='wrong' WHERE domain='CAPEX'",
      "UPDATE calculation_types SET is_active=false WHERE domain='DPR'",
      "INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES('CAPEX','EXTRA','extra')",
      "INSERT INTO calculation_types(domain,code,airflow_dag_id,is_active) VALUES('CAPEX','EXTRA_HISTORY','extra',false)",
      "INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status) SELECT id,2,'DRAFT' FROM calculation_types WHERE domain='CAPEX'",
      "UPDATE execution_dependency_definition_versions SET published_at=NULL WHERE calculation_type_id IN (SELECT id FROM calculation_types WHERE domain='INSURANCE')",
      "INSERT INTO execution_dependency_definition_dependencies SELECT d.id,'DPR' FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.domain='CAPEX'",
      "INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES('CAPEX','DEMO_CAPEX_TABLE_Y','demo_capex_table_y')",
    ];
    for (const [index, sql] of corruptions.entries()) await t.test(`legacy configuration conflict ${index + 1} fails closed without repair`, async () => {
      const f = await fixture(); await drain(f); await f.db.query(sql); const before = await snapshot(f.db);
      await assert.rejects(f.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' }); assert.deepEqual(await snapshot(f.db), before);
    });

    await t.test('unseeded, DRAINING+target and WORKFLOW_OPEN+legacy are inconsistent and never repaired', async () => {
      const missing = await fixture(false, false); await drain(missing);
      await assert.rejects(missing.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' });
      const f = await fixture(); await drain(f); await f.operator.cutover();
      await f.db.query("UPDATE calculation_types SET airflow_dag_id='unexpected' WHERE domain='CAPEX'"); const before = await snapshot(f.db);
      await assert.rejects(f.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' }); await assert.rejects(f.operator.status(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' }); assert.deepEqual(await snapshot(f.db), before);
      const other = await fixture(); await drain(other); await other.db.query("UPDATE demo_admission_control SET state='WORKFLOW_OPEN'");
      await assert.rejects(other.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' });
      const partial = await fixture(); await drain(partial);
      const { applyCapexCutover } = await import('../src/modules/demo-cutover/demo-cutover.configuration.js');
      const client = await partial.db.connect(); try { await client.query('BEGIN'); await applyCapexCutover(client); await client.query('COMMIT'); } finally { client.release(); }
      const target = await snapshot(partial.db); await assert.rejects(partial.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' }); assert.deepEqual(await snapshot(partial.db), target);
    });

    await t.test('failure after all writes but before COMMIT rolls back the complete cutover', async () => {
      const f = await fixture(); await drain(f); const before = await snapshot(f.db);
      await assert.rejects(new DemoCutoverOperator(f.db, { beforeCommit: async () => { throw new Error('private-transport'); } }).cutover(), { code: 'DEMO_CUTOVER_UNAVAILABLE' });
      assert.deepEqual(await snapshot(f.db), before); assert.equal((await f.operator.cutover()).outcome, 'APPLIED');
    });

    for (const committed of [true, false]) await t.test(`lost COMMIT ACK reloads complete durable state: committed=${committed}`, async () => {
      const f = await fixture(); await drain(f); const before = await snapshot(f.db); let original = 0; let recovered = 0;
      const operator = new DemoCutoverOperator(f.db, {
        commit: async client => { original = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid; await client.query(committed ? 'COMMIT' : 'ROLLBACK'); throw new Error('private-transport'); },
        recoveryClient: () => { const client = new Client({ connectionString: connection(f.name) }); client.on('connect', () => { recovered = Number(Reflect.get(client, 'processID')); }); return client; },
      });
      if (committed) { const r = await operator.cutover(); assert.equal(r.confirmation, 'DURABLE_RELOAD'); assert.equal(r.state, 'WORKFLOW_OPEN'); }
      else { await assert.rejects(operator.cutover(), { code: 'DEMO_CUTOVER_NOT_APPLIED' }); assert.deepEqual(await snapshot(f.db), before); assert.equal((await f.operator.cutover()).outcome, 'APPLIED'); }
      assert.ok(original && recovered && original !== recovered);
    });

    for (const outcome of ['COMMIT','ROLLBACK','TIMEOUT'] as const) await t.test(`fresh confirmation waits for the original unended transaction: ${outcome}`, async () => {
      const f = await fixture(); await drain(f); const discarded = barrier(); let retained: PoolClient | undefined; let release: ((destroy?: boolean) => void) | undefined; let originalPid = 0;
      const pending = new DemoCutoverOperator(f.db, { commit: async client => {
        retained = client; originalPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        release = client.release.bind(client);
        // Transport seam models the server transaction not having ended when the
        // application discards its socket. Only this owned fixture delays close.
        client.release = destroy => { assert.equal(destroy, true); discarded.release(); };
        throw new Error('private-transport');
      } }).cutover();
      try {
        await bounded(discarded.promise); const waiting = await waitGate(f.name, '%demo_admission_control%FOR UPDATE%'); assert.ok(waiting.blockers.includes(originalPid));
        if (outcome === 'TIMEOUT') await assert.rejects(pending, { code: 'DEMO_CUTOVER_OUTCOME_UNKNOWN' });
        await retained!.query(outcome === 'ROLLBACK' ? 'ROLLBACK' : 'COMMIT');
        retained!.release = release!; release!(true); retained = undefined;
        if (outcome === 'COMMIT') assert.equal((await pending).confirmation, 'DURABLE_RELOAD');
        if (outcome === 'ROLLBACK') await assert.rejects(pending, { code: 'DEMO_CUTOVER_NOT_APPLIED' });
        if (outcome === 'TIMEOUT') assert.equal((await f.operator.status()).state, 'WORKFLOW_OPEN');
      } finally {
        if (retained) { await retained.query('ROLLBACK'); retained.release = release!; release!(true); }
        await pending.catch(() => {});
      }
    });

    await t.test('read-only ALREADY_APPLIED replay also confirms a lost COMMIT ACK independently', async () => {
      const f = await fixture(); await drain(f); await f.operator.cutover(); await f.session(); const before = await snapshot(f.db);
      const result = await new DemoCutoverOperator(f.db, { commit: async client => { await client.query('COMMIT'); throw new Error('private-transport'); } }).cutover();
      assert.equal(result.outcome, 'ALREADY_APPLIED'); assert.equal(result.confirmation, 'DURABLE_RELOAD'); assert.deepEqual(await snapshot(f.db), before);
    });

    await t.test('unavailable or inconsistent recovery remains UNKNOWN, never automatic repair', async () => {
      const f = await fixture(); await drain(f);
      await assert.rejects(new DemoCutoverOperator(f.db, { commit: async client => { await client.query('COMMIT'); throw new Error('private-transport'); },
        recoveryClient: () => { throw new Error('private-transport'); } }).cutover(), { code: 'DEMO_CUTOVER_OUTCOME_UNKNOWN' });
      assert.equal((await f.operator.status()).state, 'WORKFLOW_OPEN');
      const other = await fixture(); await drain(other);
      await assert.rejects(new DemoCutoverOperator(other.db, { commit: async client => { await client.query('COMMIT'); await other.db.query("UPDATE calculation_types SET airflow_dag_id='wrong' WHERE domain='CAPEX'"); throw new Error('private-transport'); } }).cutover(), { code: 'DEMO_CUTOVER_OUTCOME_UNKNOWN' });
      const before = await snapshot(other.db); await assert.rejects(other.operator.cutover(), { code: 'DEMO_CUTOVER_CONFIGURATION_CONFLICT' }); assert.deepEqual(await snapshot(other.db), before);
    });

    await t.test('two cutover operators serialize; Session admission opens only after atomic COMMIT', async () => {
      const f = await fixture(); await drain(f); const entered = barrier(); const finish = barrier();
      const first = new DemoCutoverOperator(f.db, { beforeCommit: async () => { entered.release(); await finish.promise; } }).cutover(); await bounded(entered.promise);
      const second = f.operator.cutover(); const session = Promise.resolve(f.post('/demo/sessions'));
      try { await waitGate(f.name, '%demo_admission_control%FOR UPDATE%'); await waitGate(f.name, '%demo_admission_control%FOR SHARE%'); }
      finally { finish.release(); }
      assert.equal((await first).outcome, 'APPLIED'); assert.equal((await second).outcome, 'ALREADY_APPLIED'); assert.equal((await session).statusCode, 201);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM calculation_types WHERE is_active')).rows[0].n, 10);
    });

    await t.test('legacy drain unknown-COMMIT confirmation rejects a subsequently completed Workflow cutover', async () => {
      const f = await fixture();
      await assert.rejects(new DemoAdmissionOperator(f.db, { commit: async client => {
        await client.query('COMMIT'); await f.operator.cutover(); throw new Error('private-transport');
      } }).drain(), { code: 'DEMO_LEGACY_DRAIN_CLOSED' });
      assert.equal((await f.operator.status()).state, 'WORKFLOW_OPEN');
    });

    await t.test('CLI requires a dedicated explicit target; status/cutover replay, no public management API', async () => {
      const f = await fixture(); await drain(f);
      const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import','tsx','scripts/demo-cutover.ts',...args], {
        env: { ...process.env, DEMO_CUTOVER_DATABASE_URL: '', DEMO_CUTOVER_DATABASE_URL_FILE: '', ...env }, encoding: 'utf8', timeout: 15000,
      });
      for (const [args, env] of [[['status'],{}], [['reopen'],{}], [['cutover','extra'],{}],
        [['status'],{ DEMO_CUTOVER_DATABASE_URL: 'postgres://private-user:private-transport@127.0.0.1:1/missing' }],
        [['status'],{ DEMO_CUTOVER_DATABASE_URL: connection(f.name), DEMO_CUTOVER_DATABASE_URL_FILE: 'ambiguous' }]] as [string[],NodeJS.ProcessEnv][]) {
        const r = cli(args,env); assert.equal(r.status,1); assert.doesNotMatch(r.stdout+r.stderr,/postgres(?:ql)?:|private-user|private-transport|password|token_hash/);
      }
      for (const operation of ['status','cutover','cutover']) { const r = cli([operation],{ DEMO_CUTOVER_DATABASE_URL: connection(f.name) }); assert.equal(r.status,0,r.stderr); const result = JSON.parse(r.stdout); if (operation === 'cutover') assert.equal(result.state,'WORKFLOW_OPEN'); }
      assert.equal((await f.post('/demo/configuration-cutover')).statusCode,404);
    });

    await t.test('new Workflow Session uses two CAPEX Jobs through unchanged Core APIs and startup validation', async () => {
      const f = await fixture(true); await drain(f); await f.operator.cutover(); await verifyDemoDatabase(f.db);
      const s = await f.session(); error(await f.post('/demo/scenarios',s.cookie,{scenarioType:'HAPPY_PATH'}),'DEMO_LEGACY_ADMISSION_CLOSED');
      const finish = async (domain: string) => {
        const created = await f.post('/demo/dataset-versions',s.cookie,{domain,fiscalYear:2026,period:'Q4'}); assert.equal(created.statusCode,201,created.body);
        for (const job of created.json().calculationJobs) {
          const run = await f.post(`/demo/calculation-jobs/${job.jobId}/run`,s.cookie,{simulation:{dispatch:'ACCEPT',completion:'SUCCEEDED'}}); assert.equal(run.statusCode,200,run.body);
          assert.equal((await f.post(`/demo/calculation-jobs/${job.jobId}/reconcile`,s.cookie)).statusCode,200);
        }
        for (const action of ['submit-validation','publish']) assert.equal((await f.post(`/demo/dataset-versions/${created.json().datasetVersionId}/${action}`,s.cookie)).statusCode,200);
        return created.json();
      };
      await finish('FAB_COST'); const capex = await finish('CAPEX'); assert.equal(capex.calculationJobs.length,2);
      const frozen = (await f.db.query(`SELECT t.code,d.version,dep.required_domain FROM calculation_jobs j JOIN calculation_types t ON t.id=j.calculation_type_id
        JOIN execution_dependency_definition_versions d ON d.id=j.resolved_dependency_definition_version_id JOIN execution_dependency_definition_dependencies dep ON dep.definition_version_id=d.id
        WHERE j.output_dataset_version_id=$1 ORDER BY t.code`,[capex.datasetVersionId])).rows;
      assert.deepEqual(frozen.map(r=>[r.code,r.version,r.required_domain]),[['DEMO_CAPEX_TABLE_Y',1,'FAB_COST'],['DEMO_GUIDED_SUMMARY',2,'FAB_COST']]);
      // Replay policy is separate from first-insert admission. A retained fixture
      // exercises that branch without permitting it through the cutover precheck.
      const replaySession = await f.session();
      await f.db.query("INSERT INTO demo_scenario_instances(session_id,scenario_type) VALUES($1,'HAPPY_PATH')",[replaySession.context.sessionId]);
      const replay = await f.post('/demo/scenarios',replaySession.cookie,{scenarioType:'HAPPY_PATH'}); assert.equal(replay.statusCode,200,replay.body);
      error(await f.post('/demo/scenarios',replaySession.cookie,{scenarioType:'FAILURE_RETRY'}),'DEMO_SCENARIO_TYPE_CONFLICT',409);
      await f.db.query("UPDATE calculation_types SET airflow_dag_id='bad' WHERE domain='CAPEX'"); await assert.rejects(verifyDemoDatabase(f.db));
    });
    console.info('DEMO_05C3A_VERIFIED',JSON.stringify({databases:names.length,migrations:14,atomicCutover:true,independentRecovery:true}));
  } finally {
    for (const app of apps) await app.close(); for (const db of pools) await db.end();
    for (const key of ['DATABASE_URL','APP_MODE','NODE_ENV','EXECUTOR_TYPE']) { if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key]; }
    try {
      for (const name of names.reverse()) {
        const deadline=Date.now()+5000;
        while((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rowCount){assert.ok(Date.now()<deadline);await setImmediate();}
        assert.match(name,/^demo_05c3a_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
      }
      console.info('DEMO_05C3A_TEARDOWN',JSON.stringify({databases:names.length,backends:0,dropped:true,forced:false}));
    } finally { await admin.end(); }
  }
});
