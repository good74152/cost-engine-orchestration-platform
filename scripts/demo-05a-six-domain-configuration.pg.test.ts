import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { Client, type Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { runner } from 'node-pg-migrate';
import type { CreateDatasetVersionResult, DatasetDomain } from '../src/modules/dataset-version/dataset-version.types.js';
import type { AuthenticatedDemoSession } from '../src/modules/demo-session/demo-session.service.js';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error('Demo-05A requires a safe disposable PostgreSQL test service');
const connection = (name: string) => { const url = new URL(source!); url.pathname = '/' + name; return url.toString(); };
interface Session { cookie: string; context: AuthenticatedDemoSession }
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const expected = [
  ['CAPEX','DEMO_GUIDED_SUMMARY','demo_capex_guided',[]],
  ['DPR','DEMO_DPR_TABLE_X','demo_dpr_table_x',['CAPEX']],
  ['DPR','DEMO_DPR_TABLE_Y','demo_dpr_table_y',['CAPEX']],
  ['E2E_COST','DEMO_E2E_COST_TABLE_X','demo_e2e_cost_table_x',['ONE_STD_COST']],
  ['E2E_COST','DEMO_E2E_COST_TABLE_Y','demo_e2e_cost_table_y',['ONE_STD_COST']],
  ['FAB_COST','DEMO_FAB_COST_SUMMARY','demo_fab_cost_summary',[]],
  ['INSURANCE','DEMO_INSURANCE_SUMMARY','demo_insurance_summary',['FAB_COST']],
  ['ONE_STD_COST','DEMO_ONE_STD_COST_TABLE_X','demo_one_std_cost_table_x',['FAB_COST']],
  ['ONE_STD_COST','DEMO_ONE_STD_COST_TABLE_Y','demo_one_std_cost_table_y',['FAB_COST']],
] as const;
function error(r: Response, status: number, code: string) {
  assert.equal(r.statusCode,status,r.body); assert.equal(r.json().code,code);
  assert.deepEqual(Object.keys(r.json()).sort(),['code','message']);
  assert.doesNotMatch(r.body,/token_hash|postgres(?:ql)?:|SELECT |constraint|password/i);
}

test('Demo-05A: explicit six-domain configuration and unchanged Demo/Core workflows', {timeout:300_000}, async t => {
  const name = `demo_05a_test_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;
  assert.match(name,/^demo_05a_test_[a-z0-9_]+$/); assert.ok(name.length<=63);
  const admin = new Client({connectionString:connection('postgres')}); await admin.connect();
  const prior = {...process.env}; const ends: Promise<void>[]=[];
  let created=false; let db: Pool|undefined; let app: FastifyInstance|undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created=true;
    await runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../migrations/',import.meta.url)),
      migrationsTable:'pgmigrations',direction:'up',singleTransaction:true,checkOrder:true,
      logger:{debug(){},info(){},warn(){},error(){}}});
    process.env.DATABASE_URL=connection(name); process.env.DEMO_SEED_DATABASE_URL=connection(name);
    process.env.APP_MODE='demo'; process.env.NODE_ENV='test'; process.env.EXECUTOR_TYPE='fake';
    const [{pool},{buildApp},{DemoRuntime},{seedDemoSixDomainConfiguration,DemoSixDomainConfigurationConflict},{seedDemoGuidedConfiguration}] = await Promise.all([
      import('../src/db/pool.js'),import('../src/app.js'),import('../src/modules/demo-session/demo-runtime.js'),
      import('./seed-demo-six-domain-configuration.js'),import('./seed-demo-guided-configuration.js')]);
    db=pool; pool.on('connect',c=>ends.push(new Promise<void>(done=>c.once('end',done))));
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,14);
    const runtime = new DemoRuntime(pool,'test',{}, {log(){}});
    app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false,demoSession:{origin:'https://demo.test'}});
    const post=async(url:string,s?:Session,payload:unknown={}):Promise<Response>=>app!.inject({method:'POST',url,payload:JSON.stringify(payload),
      headers:{'content-type':'application/json',origin:'https://demo.test','x-demo-session':'1',...(s?{cookie:s.cookie}:{})}});
    const session=async():Promise<Session>=>{
      const r=await post('/demo/sessions'); assert.equal(r.statusCode,201,r.body);
      const cookie=String(r.headers['set-cookie']).split(';')[0]!;
      return {cookie,context:await runtime.sessions.authenticate(cookie,'ce_demo_session')};
    };
    const seedCli=(overrides:NodeJS.ProcessEnv={})=>spawnSync(process.execPath,['--import','tsx','scripts/seed-demo-six-domain-configuration.ts'],{
      env:{...process.env,...overrides},encoding:'utf8',timeout:20_000});
    const configTables=['calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies'];
    const dump=async(tables=configTables)=>{
      const rows:Record<string,unknown>={};
      for(const table of tables) rows[table]=(await pool.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
      return rows;
    };
    // Only owned fixture configuration is deleted, before creating any Domain data.
    const clearConfig=async()=>{
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM calculation_jobs')).rows[0].n,0);
      for(const table of [...configTables].reverse()) await pool.query(`DELETE FROM ${table}`);
    };
    const create=async(s:Session,domain:DatasetDomain,year=2026):Promise<CreateDatasetVersionResult>=>{
      const r=await post('/demo/dataset-versions',s,{domain,fiscalYear:year,period:'Q4'}); assert.equal(r.statusCode,201,r.body); return r.json();
    };
    const graph=async(data:CreateDatasetVersionResult)=>({
      version:(await pool.query('SELECT to_jsonb(v) AS row FROM dataset_versions v WHERE id=$1',[data.datasetVersionId])).rows,
      jobs:(await pool.query('SELECT to_jsonb(j) AS row FROM calculation_jobs j WHERE output_dataset_version_id=$1 ORDER BY id',[data.datasetVersionId])).rows,
      snapshots:(await pool.query('SELECT to_jsonb(b) AS row FROM dataset_build_snapshots b WHERE dataset_version_id=$1',[data.datasetVersionId])).rows,
      dependencies:(await pool.query(`SELECT to_jsonb(d) AS row FROM dataset_build_snapshot_dependencies d
        JOIN dataset_build_snapshots b ON b.id=d.snapshot_id WHERE b.dataset_version_id=$1 ORDER BY d.upstream_dataset_series_id`,[data.datasetVersionId])).rows,
      attempts:(await pool.query(`SELECT to_jsonb(a) AS row FROM execution_attempts a JOIN calculation_jobs j ON j.id=a.calculation_job_id
        WHERE j.output_dataset_version_id=$1 ORDER BY a.calculation_job_id,a.attempt_number`,[data.datasetVersionId])).rows,
    });
    const run=(s:Session,job:string)=>post(`/demo/calculation-jobs/${job}/run`,s);
    const succeed=async(s:Session,job:string,attempt:string)=>{
      const before=await dump(['dataset_versions','calculation_jobs','execution_attempts','dataset_build_snapshots','dataset_build_snapshot_dependencies']);
      assert.equal((await post(`/demo/execution-attempts/${attempt}/fake-state`,s,{state:'SUCCEEDED'})).statusCode,200);
      assert.deepEqual(await dump(Object.keys(before)),before,'Fake ACK must not change PostgreSQL');
      const r=await post(`/demo/calculation-jobs/${job}/reconcile`,s); assert.equal(r.statusCode,200,r.body); assert.equal(r.json().jobStatus,'SUCCEEDED');
    };
    const publish=async(s:Session,data:CreateDatasetVersionResult)=>{
      for(const command of ['submit-validation','publish']) { const r=await post(`/demo/dataset-versions/${data.datasetVersionId}/${command}`,s); assert.equal(r.statusCode,200,r.body); }
    };
    const finish=async(s:Session,data:CreateDatasetVersionResult)=>{
      for(const job of data.calculationJobs) { const r=await run(s,job.jobId); assert.equal(r.statusCode,200,r.body); await succeed(s,job.jobId,r.json().executionAttemptId); }
      await publish(s,data);
    };

    await t.test('startup, session and dataset creation do not automatically seed',async()=>{
      const s=await session(); assert.equal((await pool.query('SELECT id FROM calculation_types')).rowCount,0);
      error(await post('/demo/dataset-versions',s,{domain:'FAB_COST',fiscalYear:2026,period:'Q4'}),409,'CALCULATION_TYPE_NOT_CONFIGURED');
      assert.equal((await pool.query('SELECT id FROM dataset_series')).rowCount,0);
    });
    await t.test('explicit target and existing environment gates fail closed without leaking credentials',async()=>{
      const before=await dump();
      for(const overrides of [{APP_MODE:'core'},{APP_MODE:''},{NODE_ENV:'production'},{NODE_ENV:''},{EXECUTOR_TYPE:'airflow'},{DEMO_SEED_DATABASE_URL:''}]) {
        const r=seedCli(overrides); assert.equal(r.status,1); assert.equal(r.signal,null);
        assert.doesNotMatch(r.stderr+r.stdout,/postgres(?:ql)?:|token_hash|SELECT |INSERT |password|secret/i);
      }
      assert.deepEqual(await dump(),before);
    });
    await t.test('fresh CLI seed creates nine exact active types and published definitions for six domains, no user data',async()=>{
      const r=seedCli(); assert.equal(r.status,0,r.stderr); assert.equal(r.stderr,''); assert.match(r.stdout,/configuration ready/);
      const rows=(await pool.query(`SELECT t.domain,t.code,t.airflow_dag_id,t.is_active,t.last_allocated_dependency_definition_version,
        d.version,d.status,d.published_at,ARRAY(SELECT required_domain FROM execution_dependency_definition_dependencies e
        WHERE e.definition_version_id=d.id ORDER BY required_domain) AS required FROM calculation_types t
        JOIN execution_dependency_definition_versions d ON d.calculation_type_id=t.id ORDER BY t.domain,t.code`)).rows;
      assert.deepEqual(rows.map(r=>[r.domain,r.code,r.airflow_dag_id,r.required]),expected);
      for(const row of rows) {assert.equal(row.is_active,true);assert.equal(row.last_allocated_dependency_definition_version,1);assert.equal(row.version,1);assert.equal(row.status,'PUBLISHED');assert.ok(row.published_at);}
      for(const table of ['dataset_series','dataset_versions','calculation_jobs','dataset_build_snapshots','execution_attempts']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
    });
    await t.test('sequential and concurrent reruns preserve all configuration IDs, timestamps and published history',async()=>{
      const before=await dump(); await Promise.all(Array.from({length:5},()=>seedDemoSixDomainConfiguration(pool)));
      assert.equal(seedCli().status,0); assert.deepEqual(await dump(),before);
      await clearConfig(); await Promise.all(Array.from({length:5},()=>seedDemoSixDomainConfiguration(pool)));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM calculation_types')).rows[0].n,9);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM execution_dependency_definition_versions')).rows[0].n,9);
    });
    await t.test('existing CAPEX guided configuration is reused unchanged; original seed still works',async()=>{
      await clearConfig(); const capex=await seedDemoGuidedConfiguration(pool); const before=await dump();
      await seedDemoSixDomainConfiguration(pool); assert.deepEqual(await seedDemoGuidedConfiguration(pool),capex);
      const after=await dump();
      for(const table of configTables) for(const row of before[table] as unknown[]) assert.ok((after[table] as unknown[]).some(r=>JSON.stringify(r)===JSON.stringify(row)));
    });
    await t.test('late conflict rolls back all earlier inserted domains and preserves incompatible rows',async()=>{
      await clearConfig();
      await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES ('ONE_STD_COST','DEMO_ONE_STD_COST_TABLE_Y','incompatible')`);
      const before=await dump(); await assert.rejects(seedDemoSixDomainConfiguration(pool),DemoSixDomainConfigurationConflict);
      assert.deepEqual(await dump(),before); const r=seedCli(); assert.equal(r.status,1); assert.match(r.stderr,/DEMO_CONFIGURATION_CONFLICT/); assert.deepEqual(await dump(),before);
      await clearConfig(); await seedDemoSixDomainConfiguration(pool);
    });
    await t.test('wrong DAG, activation, allocation, definition history and exact dependency membership all conflict',async()=>{
      const conflicts=[
        "UPDATE calculation_types SET airflow_dag_id='wrong' WHERE code='DEMO_FAB_COST_SUMMARY'",
        "UPDATE calculation_types SET is_active=false WHERE code='DEMO_DPR_TABLE_X'",
        "UPDATE calculation_types SET last_allocated_dependency_definition_version=2 WHERE code='DEMO_E2E_COST_TABLE_Y'",
        "UPDATE execution_dependency_definition_versions SET status='DRAFT' WHERE calculation_type_id=(SELECT id FROM calculation_types WHERE code='DEMO_INSURANCE_SUMMARY')",
        "UPDATE execution_dependency_definition_versions SET published_at=NULL WHERE calculation_type_id=(SELECT id FROM calculation_types WHERE code='DEMO_ONE_STD_COST_TABLE_X')",
        "INSERT INTO execution_dependency_definition_versions(calculation_type_id,version,status) SELECT id,2,'DRAFT' FROM calculation_types WHERE code='DEMO_DPR_TABLE_Y'",
        "DELETE FROM execution_dependency_definition_dependencies WHERE definition_version_id=(SELECT d.id FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.code='DEMO_E2E_COST_TABLE_X')",
        "UPDATE execution_dependency_definition_dependencies SET required_domain='INSURANCE' WHERE definition_version_id=(SELECT d.id FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.code='DEMO_DPR_TABLE_Y')",
        "INSERT INTO execution_dependency_definition_dependencies SELECT d.id,'DPR' FROM execution_dependency_definition_versions d JOIN calculation_types t ON t.id=d.calculation_type_id WHERE t.code='DEMO_FAB_COST_SUMMARY'",
        "DELETE FROM execution_dependency_definition_versions WHERE calculation_type_id=(SELECT id FROM calculation_types WHERE code='DEMO_FAB_COST_SUMMARY')",
      ];
      for(const mutation of conflicts) {
        await pool.query(mutation); const before=await dump();
        await assert.rejects(seedDemoSixDomainConfiguration(pool),DemoSixDomainConfigurationConflict); assert.deepEqual(await dump(),before);
        await clearConfig(); await seedDemoSixDomainConfiguration(pool);
      }
    });
    await t.test('extra active type in every configured domain is refused; inactive unrelated history is preserved',async()=>{
      for(const domain of ['CAPEX','DPR','E2E_COST','FAB_COST','INSURANCE','ONE_STD_COST']) {
        const id=(await pool.query(`INSERT INTO calculation_types(domain,code,airflow_dag_id) VALUES ($1,'EXTRA','extra') RETURNING id`,[domain])).rows[0].id;
        const before=await dump(); await assert.rejects(seedDemoSixDomainConfiguration(pool),DemoSixDomainConfigurationConflict); assert.deepEqual(await dump(),before);
        await pool.query('UPDATE calculation_types SET is_active=false WHERE id=$1',[id]);
        const inactive=await dump(); await seedDemoSixDomainConfiguration(pool); assert.deepEqual(await dump(),inactive);
      }
    });
    await t.test('unexpected PostgreSQL failure rolls back complete seed and returns sanitized errors',async()=>{
      await clearConfig(); await pool.query(`CREATE FUNCTION demo05a_fault() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'private SQL password detail'; END $$;
        CREATE TRIGGER demo05a_fault BEFORE INSERT ON execution_dependency_definition_dependencies
        FOR EACH ROW WHEN (NEW.required_domain='FAB_COST') EXECUTE FUNCTION demo05a_fault()`);
      const before=await dump();
      try {
        await assert.rejects(seedDemoSixDomainConfiguration(pool),{message:'Demo six-domain seed persistence failed; rerun to verify durable configuration'});
        const r=seedCli(); assert.equal(r.status,1); assert.doesNotMatch(r.stdout+r.stderr,/private SQL|password detail|postgres(?:ql)?:/i);
        assert.deepEqual(await dump(),before);
      } finally {await pool.query('DROP TRIGGER demo05a_fault ON execution_dependency_definition_dependencies; DROP FUNCTION demo05a_fault()');}
      await seedDemoSixDomainConfiguration(pool);
    });

    const owner=await session(); const datasets={} as Record<DatasetDomain,CreateDatasetVersionResult>;
    await t.test('protected Demo API creates all six canonical datasets with the exact one/two-job sets',async()=>{
      for(const domain of ['CAPEX','FAB_COST','DPR','INSURANCE','ONE_STD_COST','E2E_COST'] as const) {
        const data=await create(owner,domain); datasets[domain]=data;
        assert.equal(data.calculationJobs.length,expected.filter(e=>e[0]===domain).length); assert.ok(data.calculationJobs.every(j=>j.jobStatus==='PENDING'));
        assert.deepEqual(data.calculationJobs.map(j=>j.calculationTypeCode).sort(),expected.filter(e=>e[0]===domain).map(e=>e[1]));
        const identity=(await pool.query('SELECT domain,company_code,fiscal_year,period FROM dataset_series WHERE id=$1',[data.datasetSeriesId])).rows[0];
        assert.deepEqual(identity,{domain,company_code:owner.context.companyCode,fiscal_year:2026,period:'Q4'});
        assert.equal((await graph(data)).snapshots.length,0);assert.equal((await graph(data)).attempts.length,0);
      }
    });
    for(const domain of ['DPR','INSURANCE','ONE_STD_COST','E2E_COST'] as const) await t.test(`${domain}: unpublished required upstream rejects Run atomically for every job`,async()=>{
      const data=datasets[domain]; const before=await graph(data);
      for(const job of data.calculationJobs) error(await run(owner,job.jobId),409,'DEPENDENCY_NOT_READY');
      assert.deepEqual(await graph(data),before); assert.equal((await runtime.executors.forSession(owner.context)).getDispatchHistory().length,0);
    });
    await t.test('missing or another Session published upstream cannot satisfy dependency ownership',async()=>{
      const other=await session(); const foreignCapex=await create(other,'CAPEX'); await finish(other,foreignCapex);
      const missing=await session(); const dpr=await create(missing,'DPR'); const before=await graph(dpr);
      error(await run(missing,dpr.calculationJobs[0]!.jobId),409,'DEPENDENCY_NOT_READY');assert.deepEqual(await graph(dpr),before);
    });
    await t.test('zero-dependency CAPEX/FAB_COST run and publish; dependent domains reuse existing workflows',async()=>{
      await finish(owner,datasets.CAPEX); await finish(owner,datasets.FAB_COST);
      await finish(owner,datasets.INSURANCE);
      for(const domain of ['DPR','ONE_STD_COST','E2E_COST'] as const) {
        const data=datasets[domain]; const first=await run(owner,data.calculationJobs[0]!.jobId); assert.equal(first.statusCode,200,first.body);
        await succeed(owner,data.calculationJobs[0]!.jobId,first.json().executionAttemptId);
        error(await post(`/demo/dataset-versions/${data.datasetVersionId}/submit-validation`,owner),409,'DATASET_NOT_READY_FOR_VALIDATION');
        assert.equal((await graph(data)).version[0].row.status,'BUILDING');
        const second=await run(owner,data.calculationJobs[1]!.jobId); assert.equal(second.statusCode,200,second.body);
        error(await post(`/demo/dataset-versions/${data.datasetVersionId}/submit-validation`,owner),409,'DATASET_NOT_READY_FOR_VALIDATION');
        await succeed(owner,data.calculationJobs[1]!.jobId,second.json().executionAttemptId); await publish(owner,data);
        assert.equal((await graph(data)).version[0].row.status,'PUBLISHED');
      }
      const history=(await runtime.executors.forSession(owner.context)).getDispatchHistory();
      for(const command of history) {
        const spec=expected.find(e=>e[1]===command.calculationTypeCode)!;
        assert.equal(command.airflowDagId,spec[2]);assert.deepEqual(command.upstreamDatasetVersions.map(d=>d.domain),spec[3]);
        for(const dependency of command.upstreamDatasetVersions) assert.equal(dependency.companyCode,owner.context.companyCode);
      }
    });
    for(const domain of ['DPR','ONE_STD_COST','E2E_COST'] as const) await t.test(`${domain}: later job and failed-job retry keep frozen upstream v1 after v2 publication`,async()=>{
      const s=await session();
      // Publish the prerequisite chain solely through existing protected APIs.
      const root=domain==='DPR'?'CAPEX':'FAB_COST'; const rootData=await create(s,root);await finish(s,rootData);
      let upstream=rootData; let upstreamDomain:DatasetDomain=root;
      if(domain==='E2E_COST'){upstreamDomain='ONE_STD_COST';upstream=await create(s,upstreamDomain);await finish(s,upstream);}
      const downstream=await create(s,domain);const [a,b]=downstream.calculationJobs;
      const first=await run(s,a!.jobId);assert.equal(first.statusCode,200,first.body);
      const frozen=await graph(downstream);assert.equal(frozen.snapshots.length,1);assert.equal(frozen.dependencies.length,1);
      assert.equal(frozen.dependencies[0].row.upstream_dataset_version_id,upstream.datasetVersionId);
      assert.equal((await post(`/demo/execution-attempts/${first.json().executionAttemptId}/fake-state`,s,{state:'FAILED'})).statusCode,200);
      assert.equal((await post(`/demo/calculation-jobs/${a!.jobId}/reconcile`,s)).statusCode,200);
      const failed=(await graph(downstream)).attempts[0];
      const newer=await create(s,upstreamDomain);assert.equal(newer.version,2);await finish(s,newer);
      const later=await run(s,b!.jobId);assert.equal(later.statusCode,200,later.body);
      const retry=await run(s,a!.jobId);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().attemptNumber,2);
      const after=await graph(downstream);assert.deepEqual(after.snapshots,frozen.snapshots);assert.deepEqual(after.dependencies,frozen.dependencies);
      assert.ok(after.attempts.some(a=>JSON.stringify(a)===JSON.stringify(failed)));
      for(const command of (await runtime.executors.forSession(s.context)).getDispatchHistory().filter(c=>c.datasetVersionId===downstream.datasetVersionId)) {
        assert.equal(command.upstreamDatasetVersions.length,1);assert.equal(command.upstreamDatasetVersions[0]!.datasetVersionId,upstream.datasetVersionId);assert.equal(command.upstreamDatasetVersions[0]!.version,1);
        assert.ok(frozen.jobs.every(j=>j.row.resolved_dependency_definition_version_id));
      }
      const beforeSeed=await dump([...configTables,'dataset_series','dataset_versions','calculation_jobs','dataset_build_snapshots','dataset_build_snapshot_dependencies','execution_attempts']);
      await seedDemoSixDomainConfiguration(pool);assert.deepEqual(await dump(Object.keys(beforeSeed)),beforeSeed);
    });
    for(const type of ['HAPPY_PATH','FAILURE_RETRY','LOST_RESPONSE_RECOVERY']) await t.test(`${type}: complete Guided Scenario remains compatible with six-domain seed`,async()=>{
      const s=await session();const created=await post('/demo/scenarios',s,{scenarioType:type});assert.equal(created.statusCode,201,created.body);
      const id=created.json().scenarioId;
      for(let step=1;step<=(type==='FAILURE_RETRY'?9:6);step++) {
        const body={expectedStep:step,requestId:randomUUID()};let r=await post(`/demo/scenarios/${id}/next`,s,body);
        if(type==='LOST_RESPONSE_RECOVERY'&&step===2) {assert.equal(r.statusCode,202,r.body);r=await post(`/demo/scenarios/${id}/next`,s,body);}
        assert.equal(r.statusCode,200,r.body);
      }
      const row=(await pool.query('SELECT status,completed_step FROM demo_scenario_instances WHERE id=$1',[id])).rows[0];
      assert.deepEqual(row,{status:'COMPLETED',completed_step:type==='FAILURE_RETRY'?9:6});
    });
    console.log('DEMO_05A_VERIFIED',JSON.stringify({database:name,migrations:14,domains:6,activeTypes:9,postgres:(await pool.query('SHOW server_version')).rows[0].server_version}));
  } finally {
    try {await app?.close();if(db){await db.end();await Promise.all(ends);}}
    finally {
      for(const key of ['DATABASE_URL','DEMO_SEED_DATABASE_URL','APP_MODE','NODE_ENV','EXECUTOR_TYPE']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
      try {
        if(created){const deadline=Date.now()+5000;let clients=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
          while(clients.rowCount&&Date.now()<deadline){await setImmediate();clients=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}
          assert.equal(clients.rowCount,0);assert.match(name,/^demo_05a_test_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);
          console.log('DEMO_05A_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));}
      } finally {await admin.end();}
    }
  }
});
