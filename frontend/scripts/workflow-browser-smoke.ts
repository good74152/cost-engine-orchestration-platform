import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate} from 'node:timers/promises';
import {Client,type Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import {chromium,type Browser,type APIResponse} from 'playwright';
import {createServer,type ViteDevServer} from 'vite';
import type {FastifyInstance} from 'fastify';
import {DemoAdmissionOperator} from '../../src/modules/demo-admission/demo-admission.operator.js';
import {DemoCutoverOperator} from '../../src/modules/demo-cutover/demo-cutover.operator.js';

const source=process.env.TEST_DATABASE_URL;
if(!source)throw new Error('Workflow Chromium tests require explicit disposable TEST_DATABASE_URL');
const connection=(name:string)=>{const u=new URL(source);u.pathname='/'+name;return u.toString();};

test('Demo-05C-3C: Chromium Workflow and Browser Recovery on real Cutover fixture',{timeout:360_000},async t=>{
 const name=`demo_05c3c_browser_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;
 assert.match(name,/^demo_05c3c_browser_[a-z0-9_]+$/);assert.ok(name.length<=63);
 const admin=new Client({connectionString:connection('postgres')});await admin.connect();
 let created=false;let db:Pool|undefined;let app:FastifyInstance|undefined;let vite:ViteDevServer|undefined;let browser:Browser|undefined;
 const ends:Promise<void>[]=[];const prior={...process.env};
 try{
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
  await runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../../migrations/',import.meta.url)),migrationsTable:'pgmigrations',direction:'up',singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
  process.env.DATABASE_URL=connection(name);process.env.NODE_ENV='test';process.env.APP_MODE='demo';process.env.EXECUTOR_TYPE='fake';
  const [{pool},{buildApp},{DemoRuntime},{seedDemoSixDomainConfiguration}]=await Promise.all([
   import('../../src/db/pool.js'),import('../../src/app.js'),import('../../src/modules/demo-session/demo-runtime.js'),import('../../scripts/seed-demo-six-domain-configuration.js')]);
  db=pool;pool.on('connect',c=>ends.push(new Promise<void>(done=>c.once('end',done))));
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,14);
  await seedDemoSixDomainConfiguration(pool);await new DemoAdmissionOperator(pool).drain();await new DemoCutoverOperator(pool).cutover();
  assert.equal((await new DemoCutoverOperator(pool).status()).state,'WORKFLOW_OPEN');
  const runtime=new DemoRuntime(pool,'test',{}, {log(){}});await runtime.reset.startServer();
  app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false});
  const posts:{url:string;body:unknown}[]=[];
  app.addHook('onRequest',async req=>{if(req.method==='POST')posts.push({url:req.url,body:req.body});});
  process.env.DEMO_BACKEND_TARGET=await app.listen({host:'127.0.0.1',port:0});
  vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),server:{port:0,strictPort:false,host:'127.0.0.1',hmr:false},logLevel:'warn'});await vite.listen();
  const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1080},locale:'en-US',timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(15_000);const pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
  let cursorRequests=0;
  // Exercise real multi-page HTTP reads even with only two Jobs. Preserve the
  // opaque cursor and all backend security; only reduce the requested page size.
  await page.route('**/demo/**',async route=>{
   const u=new URL(route.request().url());if(route.request().method()==='GET'&&u.searchParams.has('limit')){
    if(u.searchParams.has('cursor'))cursorRequests++;u.searchParams.set('limit','1');await route.continue({url:u.toString()});
   }else await route.continue();
  });
  const ready=async()=>{await page.waitForFunction(()=>document.querySelector('button[aria-label="Refresh durable state"]')?.matches(':enabled'));};
  const session=async()=>{const r=await context.request.get(origin+'/demo/sessions/current');assert.equal(r.status(),200);return r.json() as Promise<{sessionId:string;companyCode:string}>;};
  const start=async()=>{await page.getByRole('button',{name:'Start demo session',exact:true}).click();await ready();return session();};
  const reset=async()=>{await page.getByRole('button',{name:'Reset session',exact:true}).click();await page.getByRole('button',{name:'Confirm reset',exact:true}).click();await page.getByRole('button',{name:'Start demo session',exact:true}).waitFor();await ready();};
  const template=async(id:string)=>{await page.goto(origin+'/workflows/'+id);await ready();await page.getByRole('heading',{name:'Choose Dataset versions',exact:true}).waitFor();};
  const step=(id:string)=>page.getByRole('button',{name:'Select step '+id,exact:true}).click();
  const operation=(code:string)=>page.getByRole('region',{name:'Operate '+code,exact:true});
  const mutate=async(click:()=>Promise<unknown>,path:string,status=200)=>{
   const response=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST');await click();const r=await response;
   assert.equal(r.status(),status,await r.text());await ready();return r.json();
  };
  const list=async<T>(path:string):Promise<T[]>=>{const all:T[]=[];let cursor:string|null=null;do{
   const r:APIResponse=await context.request.get(origin+path+'?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status(),200);
   const body=await r.json() as {items:T[];nextCursor:string|null};all.push(...body.items);cursor=body.nextCursor;
  }while(cursor);return all;};
  const create=async(domain:string)=>{
   const data=await mutate(()=>page.getByRole('button',{name:'Create '+domain+' Dataset',exact:true}).click(),'/demo/dataset-versions',201) as {datasetVersionId:string;version:number};
   assert.equal(await page.getByLabel(domain+' Dataset version',{exact:true}).inputValue(),'');
   await page.getByLabel(domain+' Dataset version',{exact:true}).selectOption(data.datasetVersionId);
   const jobs=await list<{jobId:string;calculationTypeCode:string}>('/demo/dataset-versions/'+data.datasetVersionId+'/calculation-jobs');
   return {...data,jobs};
  };
  const complete=async(domain:string,data:Awaited<ReturnType<typeof create>>)=>{
   const prefix=domain.toLowerCase();await step(prefix+'.run');
   for(const job of data.jobs)await mutate(()=>operation(job.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click(),'/demo/calculation-jobs/'+job.jobId+'/run');
   await finish(domain,data);
  };
  const finish=async(domain:string,data:Awaited<ReturnType<typeof create>>)=>{
   const prefix=domain.toLowerCase();await step(prefix+'.fake-success');
   for(const job of data.jobs){const a=(await pool.query('SELECT id FROM execution_attempts WHERE calculation_job_id=$1 ORDER BY attempt_number DESC LIMIT 1',[job.jobId])).rows[0];
    await mutate(()=>operation(job.calculationTypeCode).getByRole('button',{name:'Set fake success',exact:true}).click(),'/demo/execution-attempts/'+a.id+'/fake-state');
    assert.notEqual((await pool.query('SELECT status FROM calculation_jobs WHERE id=$1',[job.jobId])).rows[0].status,'SUCCEEDED');
   }
   await step(prefix+'.reconcile');for(const job of data.jobs)await mutate(()=>operation(job.calculationTypeCode).getByRole('button',{name:'Reconcile Job',exact:true}).click(),'/demo/calculation-jobs/'+job.jobId+'/reconcile');
   await step(prefix+'.validate');await mutate(()=>page.getByRole('button',{name:'Submit validation',exact:true}).click(),'/demo/dataset-versions/'+data.datasetVersionId+'/submit-validation');
   await step(prefix+'.publish');await mutate(()=>page.getByRole('button',{name:'Publish Dataset',exact:true}).click(),'/demo/dataset-versions/'+data.datasetVersionId+'/publish');
  };
  const attempts=async(job:string)=>(await pool.query('SELECT to_jsonb(a) AS row FROM execution_attempts a WHERE calculation_job_id=$1 ORDER BY attempt_number',[job])).rows.map(r=>r.row);

  await t.test('neutral start, backend availability, four v2 templates and safe old Guided URL without Legacy Create',async()=>{
   await page.goto(origin+'/guided');await ready();assert.equal(posts.length,0);assert.equal(await page.getByRole('link',{name:'Workflow Explorer',exact:true}).count(),0);
   await start();await page.goto(origin+'/guided');await page.waitForURL('**/workflows');await ready();
   await page.getByRole('heading',{name:'Workflow Explorer',exact:true}).waitFor();await page.getByText('Version 2',{exact:true}).first().waitFor();
   assert.equal(await page.getByText('Version 2',{exact:true}).count(),4);assert.equal(posts.filter(p=>p.url==='/demo/scenarios').length,0);
   const cookies=await context.cookies();assert.ok(cookies.some(c=>c.name==='ce_demo_session'&&c.httpOnly));
  });
  await t.test('all six Domains and ten Jobs publish through explicit individual browser operations',async()=>{
   await template('SIX_DOMAIN_WORKFLOW');
   for(const domain of ['FAB_COST','CAPEX','INSURANCE','ONE_STD_COST','DPR','E2E_COST']){const d=await create(domain);assert.equal(d.jobs.length,['FAB_COST','INSURANCE'].includes(domain)?1:2);await complete(domain,d);}
   const owner=await session();const graph=(await pool.query(`SELECT v.status,count(j.id)::int AS jobs FROM dataset_series ds JOIN dataset_versions v ON v.dataset_series_id=ds.id
    JOIN calculation_jobs j ON j.output_dataset_version_id=v.id WHERE ds.company_code=$1 GROUP BY v.id,v.status`,[owner.companyCode])).rows;
   assert.equal(graph.length,6);assert.equal(graph.reduce((n,r)=>n+r.jobs,0),10);assert.ok(graph.every(r=>r.status==='PUBLISHED'));
   assert.equal((await pool.query(`SELECT count(*)::int AS n FROM execution_attempts a JOIN calculation_jobs j ON j.id=a.calculation_job_id JOIN dataset_versions v ON v.id=j.output_dataset_version_id
    JOIN dataset_series ds ON ds.id=v.dataset_series_id WHERE ds.company_code=$1 AND a.status='SUCCEEDED'`,[owner.companyCode])).rows[0].n,10);
  });
  await t.test('Browser refresh revalidates bound resources with GET only; Free Exploration return sees fresh data',async()=>{
   const url=page.url();const before=posts.length;await page.reload();await ready();assert.equal(posts.length,before);
   assert.ok(await page.getByLabel('CAPEX Dataset version',{exact:true}).inputValue());
   await page.getByRole('link',{name:'Open Free Exploration',exact:true}).click();await ready();
   await page.getByLabel('Domain',{exact:true}).selectOption('FAB_COST');await mutate(()=>page.getByRole('button',{name:'Create dataset',exact:true}).click(),'/demo/dataset-versions',201);
   await page.goto(url);await ready();assert.equal(await page.getByLabel('FAB_COST Dataset version',{exact:true}).locator('option').count(),3);
   const screenshot=join(tmpdir(),name+'-workflow.png');await page.screenshot({path:screenshot,fullPage:true,animations:'disabled'});console.info('WORKFLOW_SCREENSHOT',screenshot);
   for(const width of [834,390]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));}
   await page.setViewportSize({width:1440,height:1080});
  });
  await t.test('Failure Retry preserves failed history and only retries the selected CAPEX Job',async()=>{
   await reset();await start();await template('FAILURE_RETRY');await complete('FAB_COST',await create('FAB_COST'));const d=await create('CAPEX');const [a,b]=d.jobs;assert.ok(a&&b);
   await step('capex.run');await page.getByLabel('Completion simulation',{exact:true}).selectOption('FAILED');
   await mutate(()=>operation(a.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click(),'/demo/calculation-jobs/'+a.jobId+'/run');
   await page.getByLabel('Completion simulation',{exact:true}).selectOption('RUNNING');
   await mutate(()=>operation(b.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click(),'/demo/calculation-jobs/'+b.jobId+'/run');
   await step('capex.reconcile-failure');await mutate(()=>operation(a.calculationTypeCode).getByRole('button',{name:'Reconcile Job',exact:true}).click(),'/demo/calculation-jobs/'+a.jobId+'/reconcile');
   const failed=(await attempts(a.jobId))[0];assert.equal(failed.status,'FAILED');await step('capex.retry');
   await mutate(()=>operation(a.calculationTypeCode).getByRole('button',{name:'Retry Job',exact:true}).click(),'/demo/calculation-jobs/'+a.jobId+'/run');await finish('CAPEX',d);
   const history=await attempts(a.jobId);assert.deepEqual(history[0],failed);assert.deepEqual(history.map(a=>a.status),['FAILED','SUCCEEDED']);assert.equal((await attempts(b.jobId)).length,1);
  });
  await t.test('Lost ACK 202 + reload + explicit Recover preserves Attempt/DAG/run identity and external execution count',async()=>{
   await reset();await start();await template('LOST_RESPONSE_RECOVERY');await complete('FAB_COST',await create('FAB_COST'));const d=await create('CAPEX');const [a,b]=d.jobs;assert.ok(a&&b);
   await step('capex.run-lost-response');await page.getByLabel('Dispatch simulation',{exact:true}).selectOption('ACCEPT_THEN_UNKNOWN');
   await mutate(()=>operation(a.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click(),'/demo/calculation-jobs/'+a.jobId+'/run',202);
   await page.getByText(/HTTP 202 · Outcome unknown/).waitFor();const original=(await attempts(a.jobId))[0];assert.equal(original.status,'DISPATCHING');
   const owner=await session();const cookie=(await context.cookies()).find(c=>c.name==='ce_demo_session')!;
   const fake=await runtime.executors.forSession(await runtime.sessions.authenticate(cookie.name+'='+cookie.value,'ce_demo_session'));
   const capexRuns=()=>fake.getExternalExecutions().filter(e=>e.command.datasetVersionId===d.datasetVersionId);assert.equal(capexRuns().length,1);
   const count=posts.length;await page.reload();await ready();assert.equal(posts.length,count);await step('capex.recover');
   await mutate(()=>operation(a.calculationTypeCode).getByRole('button',{name:'Recover original Job',exact:true}).click(),'/demo/calculation-jobs/'+a.jobId+'/run');
   const recovered=await attempts(a.jobId);assert.equal(recovered.length,1);for(const k of ['id','attempt_number','airflow_dag_id','airflow_dag_run_id'])assert.equal(recovered[0][k],original[k]);
   await step('capex.run-other-jobs');await mutate(()=>operation(b.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click(),'/demo/calculation-jobs/'+b.jobId+'/run');await finish('CAPEX',d);
   assert.equal(capexRuns().length,2);t.diagnostic('BROWSER_RECOVERY '+JSON.stringify({sessionId:owner.sessionId,attempt:original.id,before:'DISPATCHING',after:'SUCCEEDED',attemptCount:1,externalCapexRuns:2,reloadPosts:0}));
  });
  await t.test('real lost browser HTTP response does not retry POST or infer failure; reload reads original durable Attempt',async()=>{
   await reset();await start();await template('HAPPY_PATH');await complete('FAB_COST',await create('FAB_COST'));const d=await create('CAPEX');const a=d.jobs[0]!;
   await step('capex.run');let lost=false;await page.route('**/demo/calculation-jobs/*/run',async route=>{if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
   const count=posts.filter(p=>p.url.endsWith('/run')).length;await operation(a.calculationTypeCode).getByRole('button',{name:'Run Job',exact:true}).click();
   await page.getByText('NETWORK_ERROR',{exact:true}).waitFor();await ready();await page.unroute('**/demo/calculation-jobs/*/run');
   assert.equal(posts.filter(p=>p.url.endsWith('/run')).length,count+1);const original=(await attempts(a.jobId))[0];assert.equal(original.status,'ACCEPTED');
   await page.reload();await ready();assert.equal(posts.filter(p=>p.url.endsWith('/run')).length,count+1);assert.equal((await attempts(a.jobId)).length,1);
  });
  await t.test('Reset, new Session and separate browser enforce resource isolation and clear old selections',async()=>{
   const owner=await session();const d=(await list<{datasetVersionId:string}>('/demo/dataset-versions'))[0]!;await reset();
   assert.equal((await pool.query('SELECT id FROM dataset_series WHERE company_code=$1',[owner.companyCode])).rowCount,0);
   const next=await start();assert.notEqual(next.companyCode,owner.companyCode);await template('HAPPY_PATH');assert.equal(await page.getByLabel('CAPEX Dataset version',{exact:true}).inputValue(),'');
   assert.equal((await context.request.get(origin+'/demo/dataset-versions/'+d.datasetVersionId)).status(),404);
   const other=await browser!.newContext();const otherPage=await other.newPage();await otherPage.goto(origin+'/workflows/HAPPY_PATH');await otherPage.getByRole('button',{name:'Start demo session',exact:true}).waitFor();
   assert.equal((await other.request.get(origin+'/demo/dataset-versions/'+d.datasetVersionId)).status(),401);await other.close();
   await runtime.sessions.revoke(next.sessionId);await page.getByRole('button',{name:'Refresh durable state',exact:true}).click();await page.getByRole('button',{name:'Start demo session',exact:true}).waitFor();
   assert.equal(await page.getByRole('region',{name:'CAPEX resources',exact:true}).count(),0);
  });
  assert.equal(posts.filter(p=>p.url.startsWith('/demo/scenarios')).length,0);assert.ok(cursorRequests>0);assert.deepEqual(pageErrors,[]);
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.ok(!(await page.evaluate(()=>document.cookie)).includes('ce_demo_session'));
  console.info('WORKFLOW_BROWSER_VERIFIED',JSON.stringify({migrations:14,domains:6,jobs:10,legacyScenarioPosts:0,cursorRequests,chromium:browser.version(),refreshPosts:0}));await context.close();
 }finally{
  try{await browser?.close();await vite?.close();await app?.close();await db?.end();await Promise.all(ends);}
  finally{
   for(const key of ['DATABASE_URL','NODE_ENV','APP_MODE','EXECUTOR_TYPE','DEMO_BACKEND_TARGET']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
   try{if(created){const deadline=Date.now()+5000;while((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rowCount){assert.ok(Date.now()<deadline);await setImmediate();}
    assert.match(name,/^demo_05c3c_browser_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);console.info('WORKFLOW_BROWSER_TEARDOWN',JSON.stringify({backends:0,dropped:true,forced:false}));}}
   finally{await admin.end();}
  }
 }
});
