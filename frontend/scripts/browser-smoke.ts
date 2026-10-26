import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import dotenv from 'dotenv';
import {Client,type Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import {chromium,type Browser} from 'playwright';
import {createServer,type ViteDevServer} from 'vite';
import type {FastifyInstance} from 'fastify';
import {catalog} from '../src/features/scenarios/scenario-catalog.ts';
import type {ScenarioType} from '../src/api/types.ts';

dotenv.config({path:fileURLToPath(new URL('../../.env',import.meta.url)),quiet:true});
const source=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
if(!source)throw new Error('UI smoke requires a safe PostgreSQL test service with owned disposable databases');
const connection=(name:string)=>{const url=new URL(source!);url.pathname='/'+name;return url.toString();};

test('Demo-03: real Chromium, Vite proxy and unchanged PostgreSQL backend',{timeout:240_000},async t=>{
 const name='demo03_browser_'+process.pid+'_'+randomUUID().replaceAll('-','').slice(0,12);
 assert.match(name,/^demo03_browser_[a-z0-9_]+$/);assert.ok(name.length<=63);
 const admin=new Client({connectionString:connection('postgres')});await admin.connect();
 let created=false;let db:Pool|undefined;let app:FastifyInstance|undefined;let vite:ViteDevServer|undefined;let browser:Browser|undefined;
 const ends:Promise<void>[]=[];let origin='';const mutations:{host:string|undefined;origin:string|undefined;header:string|undefined;json:boolean}[]=[];
 try{
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
  await runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../../migrations/',import.meta.url)),migrationsTable:'pgmigrations',direction:'up',singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
  // Configure the owned DB BEFORE importing app/core modules that initialize the global pool.
  process.env.DATABASE_URL=connection(name);process.env.NODE_ENV='test';process.env.APP_MODE='demo';process.env.EXECUTOR_TYPE='fake';
  const [{pool},{buildApp},{DemoRuntime},{seedDemoGuidedConfiguration}]=await Promise.all([
   import('../../src/db/pool.js'),import('../../src/app.js'),import('../../src/modules/demo-session/demo-runtime.js'),import('../../scripts/seed-demo-guided-configuration.js')]);
  db=pool;pool.on('connect',c=>ends.push(new Promise<void>(r=>c.once('end',r))));
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,name);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pgmigrations')).rows[0].n,11);
  await seedDemoGuidedConfiguration(pool);
  const runtime=new DemoRuntime(pool,'test',{}, {log(){}});await runtime.reset.startServer();
  app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false});
  app.addHook('onRequest',async req=>{if(req.method==='POST')mutations.push({host:req.headers.host,origin:req.headers.origin,header:req.headers['x-demo-session'] as string|undefined,json:!!req.headers['content-type']?.startsWith('application/json')});});
  const backend=await app.listen({host:'127.0.0.1',port:0});process.env.DEMO_BACKEND_TARGET=backend;
  vite=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),configFile:fileURLToPath(new URL('../vite.config.ts',import.meta.url)),server:{port:0,strictPort:false,host:'127.0.0.1'},logLevel:'warn'});await vite.listen();
  const address=vite.httpServer!.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port;
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1080},locale:'en-US',timezoneId:'Asia/Taipei',reducedMotion:'reduce'});const page=await context.newPage();
  page.setDefaultTimeout(12_000);const pageErrors:unknown[]=[];page.on('pageerror',e=>pageErrors.push(e));
  const steps:{scenario:string;step:number;requestId:string}[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/next')&&request.method()==='POST'){const data=request.postDataJSON();steps.push({scenario:new URL(request.url()).pathname.split('/')[3]!,step:data.expectedStep,requestId:data.requestId});}});
  // Normal verification must leave tracked evidence untouched. Capture reviewed
  // README screenshots only with an explicit, non-secret opt-in.
  const screenshots=process.env.UI_SMOKE_SCREENSHOTS==='1'?fileURLToPath(new URL('../../docs/images/demo-03/',import.meta.url)):join(tmpdir(),name+'-screenshots');await mkdir(screenshots,{recursive:true});
  const shot=(file:string)=>page.screenshot({path:screenshots+'/'+file+'.png',fullPage:true,animations:'disabled'});
  const publicSession=async()=>{const r=await context.request.get(origin+'/demo/sessions/current');assert.equal(r.status(),200);return r.json();};
  const start=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/demo/sessions'&&r.request().method()==='POST');
   await page.getByRole('button',{name:'Start demo session',exact:true}).click();const result=await response;assert.ok([200,201].includes(result.status()));
   await page.locator('.session-card').getByText((await result.json()).companyCode,{exact:true}).waitFor();};
  const reset=async()=>{await page.getByRole('button',{name:'Reset session',exact:true}).click();await page.getByRole('button',{name:'Confirm reset',exact:true}).click();await page.getByRole('button',{name:'Start demo session',exact:true}).waitFor();
   assert.equal((await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('fcp.step.v1:')))).length,0);};
  const choose=async(type:ScenarioType)=>{await page.getByRole('link',{name:'Guided Demo',exact:true}).click();await page.getByRole('button',{name:'Start '+catalog[type].title,exact:true}).click();await page.waitForURL(/\/guided\/[0-9a-f-]+$/);};
  const clickStep=async(type:ScenarioType,n:number,nextName?:string)=>{await page.getByRole('button',{name:catalog[type].steps[n-1]!.action,exact:true}).click();if(nextName)await page.getByRole('button',{name:nextName,exact:true}).waitFor();else await page.getByText('Dataset published.',{exact:true}).waitFor();};
  const graph=async(company:string)=>(await pool.query(`SELECT v.id,v.status AS dataset_status,j.id AS job_id,j.status AS job_status,
   (SELECT jsonb_agg(to_jsonb(a) ORDER BY attempt_number) FROM execution_attempts a WHERE a.calculation_job_id=j.id) AS attempts
   FROM dataset_series ds JOIN dataset_versions v ON v.dataset_series_id=ds.id JOIN calculation_jobs j ON j.output_dataset_version_id=v.id WHERE ds.company_code=$1`,[company])).rows;

  await t.test('explicit session start, real HttpOnly cookie, credentials and Host/Origin-preserving proxy',async()=>{
   await page.goto(origin);await page.getByRole('button',{name:'Start demo session',exact:true}).waitFor();assert.equal(mutations.length,0);await start();
   const cookies=await context.cookies();const cookie=cookies.find(c=>c.name==='ce_demo_session');assert.ok(cookie&&cookie.httpOnly&&cookie.sameSite==='Strict'&&cookie.path==='/');
   assert.ok(!(await page.evaluate(()=>document.cookie)).includes('ce_demo_session='),'Session token must not be readable by JavaScript');
   assert.equal((await page.evaluate(()=>localStorage.length)),0);await shot('dashboard');
  });
  await t.test('Happy Path through UI, including actual lost browser HTTP response and authoritative GET recovery',async()=>{
   await choose('HAPPY_PATH');let lost=false;
   await page.route('**/demo/scenarios/*/next',async route=>{if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
   await clickStep('HAPPY_PATH',1,'Run calculation');await page.unroute('**/demo/scenarios/*/next');
   assert.equal(steps.filter(s=>s.step===1).length,1);await page.getByRole('button',{name:'Refresh durable state'}).click();
   for(let n=2;n<=6;n++)await clickStep('HAPPY_PATH',n,n<6?catalog.HAPPY_PATH.steps[n]!.action:undefined);
   const rows=await graph((await publicSession()).companyCode);assert.equal(rows.length,1);assert.equal(rows[0].dataset_status,'PUBLISHED');assert.equal(rows[0].attempts.length,1);await shot('happy-path');
  });
  await t.test('confirmed Reset clears UI/request scope and Failure Retry preserves failed Attempt 1 across Attempt 2',async()=>{
   await reset();await start();await choose('FAILURE_RETRY');let failed:unknown;
   for(let n=1;n<=9;n++){await clickStep('FAILURE_RETRY',n,n<9?catalog.FAILURE_RETRY.steps[n]!.action:undefined);
    if(n===4){const g=await graph((await publicSession()).companyCode);failed=g[0].attempts[0];assert.equal(g[0].job_status,'FAILED');}
   }
   const rows=await graph((await publicSession()).companyCode);assert.equal(rows.length,1);assert.equal(rows[0].attempts.length,2);assert.deepEqual(rows[0].attempts[0],failed);assert.equal(rows[0].attempts[1].status,'SUCCEEDED');
   assert.equal(await page.getByTestId('attempt-card').count(),2);await shot('failure-retry');
  });
  await t.test('Lost ACK 202, refresh/reload Pending Step, same request/attempt/full identity and original execution recovery',async()=>{
   await reset();await start();await choose('LOST_RESPONSE_RECOVERY');await clickStep('LOST_RESPONSE_RECOVERY',1,'Run calculation');
   await page.getByRole('button',{name:'Run calculation',exact:true}).click();await page.getByRole('button',{name:'Recover original execution',exact:true}).waitFor();
   const owner=await publicSession();const before=(await graph(owner.companyCode))[0];assert.equal(before.job_status,'PENDING');assert.equal(before.attempts[0].status,'DISPATCHING');
   const pendingRequest=steps.at(-1)!;const cookie=(await context.cookies()).find(c=>c.name==='ce_demo_session')!;
   const trusted=await runtime.sessions.authenticate(cookie.name+'='+cookie.value,'ce_demo_session');const fake=await runtime.executors.forSession(trusted);assert.equal(fake.getExternalExecutions().length,1);
   await shot('lost-response-pending');await page.reload();await page.getByRole('button',{name:'Recover original execution',exact:true}).waitFor();
   await page.getByRole('button',{name:'Recover original execution',exact:true}).click();await page.getByRole('button',{name:'Simulate success',exact:true}).waitFor();
   assert.deepEqual(steps.at(-1),pendingRequest);const after=(await graph(owner.companyCode))[0];assert.equal(after.attempts.length,1);assert.equal(after.job_status,'RUNNING');
   for(const field of ['id','airflow_dag_id','airflow_dag_run_id','attempt_number'])assert.equal(after.attempts[0][field],before.attempts[0][field]);assert.equal(fake.getExternalExecutions().length,1);
   await page.getByText('Original execution recovered without creating a duplicate attempt.',{exact:true}).waitFor();await shot('lost-response-recovered');
   for(let n=3;n<=6;n++)await clickStep('LOST_RESPONSE_RECOVERY',n,n<6?catalog.LOST_RESPONSE_RECOVERY.steps[n]!.action:undefined);
  });
  await t.test('Guided/manual isolation, owned detail reads, foreign resource denial and unchanged CSRF rejection',async()=>{
   const owner=await publicSession();const row=(await graph(owner.companyCode))[0];await page.getByRole('link',{name:'Free Exploration',exact:true}).click();
   await page.getByText('Guided Scenario is active. Reset your session to use Free Exploration.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Queue behavior',exact:true}).count(),0);
   await page.goto(origin+'/datasets/'+row.id);await page.getByRole('heading',{name:'Calculation jobs',exact:true}).waitFor();
   const foreign=await browser!.newContext();const foreignPage=await foreign.newPage();await foreignPage.goto(origin);await foreignPage.getByRole('button',{name:'Start demo session',exact:true}).click();
   await foreignPage.getByRole('button',{name:'Reset session',exact:true}).waitFor();await foreignPage.goto(origin+'/datasets/'+row.id);await foreignPage.getByText('Dataset unavailable',{exact:true}).waitFor();assert.equal(await foreignPage.getByText(row.id,{exact:true}).count(),0);await foreign.close();
   const denied=await context.request.post(origin+'/demo/scenarios',{headers:{Origin:'http://foreign.invalid','X-Demo-Session':'1'},data:{scenarioType:'HAPPY_PATH'}});assert.equal(denied.status(),403);assert.equal((await denied.json()).code,'DEMO_SESSION_CSRF_REJECTED');
  });
  await t.test('Free Exploration create / Run / fake state / Reconcile / validation / Publish without inferred executor state',async()=>{
   await reset();await start();await page.getByRole('link',{name:'Free Exploration',exact:true}).click();await page.getByRole('button',{name:'Create dataset',exact:true}).click();
   await page.getByRole('button',{name:'Run calculation',exact:true}).click();await page.getByRole('button',{name:'Set fake success',exact:true}).click();
   await page.getByText('Fake success acknowledged. PostgreSQL changes only after reconciliation.',{exact:true}).waitFor();assert.equal((await graph((await publicSession()).companyCode))[0].job_status,'RUNNING');
   await page.getByRole('button',{name:'Reconcile',exact:true}).click();await page.getByRole('button',{name:'Submit validation',exact:true}).click();await page.getByRole('button',{name:'Publish',exact:true}).click();
   await page.getByText('PUBLISHED',{exact:true}).waitFor();assert.equal((await graph((await publicSession()).companyCode))[0].dataset_status,'PUBLISHED');await shot('free-exploration');
  });
  await t.test('prior manual fake configuration gets explicit Reset guidance instead of an unusable Guided Scenario',async()=>{
   await reset();await start();await page.getByRole('link',{name:'Free Exploration',exact:true}).click();await page.getByLabel('Dispatch behavior',{exact:true}).selectOption('REJECT');
   await page.getByRole('button',{name:'Queue behavior',exact:true}).click();await page.getByText('Behavior queued for the next new dispatch decision. Existing executions were not modified.',{exact:true}).waitFor();
   await page.getByRole('link',{name:'Guided Demo',exact:true}).click();await page.getByRole('button',{name:'Start Lost Response Recovery',exact:true}).click();await page.getByText('DEMO_SCENARIO_SESSION_NOT_EMPTY',{exact:true}).waitFor();
   const owner=await publicSession();assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_scenario_instances WHERE session_id=$1',[owner.sessionId])).rows[0].n,0);
   await reset();await start();
  });
  await t.test('desktop/tablet/mobile have no horizontal overflow; mobile navigation and Reset confirmation remain usable',async()=>{
   await page.goto(origin);for(const width of [1440,834,390]){await page.setViewportSize({width,height:width===390?844:1080});
    await page.getByRole('heading',{name:'Financial Calculation Platform',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Responsive layout must fit the viewport');}
   await shot('dashboard-mobile');await page.getByRole('link',{name:'Guided Demo',exact:true}).click();await page.getByRole('heading',{name:'Explore the orchestration journey',exact:true}).waitFor();
   await page.getByRole('button',{name:'Reset session',exact:true}).click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
   await page.getByRole('button',{name:'Start Happy Path',exact:true}).click();await page.waitForURL(/\/guided\/[0-9a-f-]+$/);
   for(let n=1;n<=6;n++){await clickStep('HAPPY_PATH',n,n<6?catalog.HAPPY_PATH.steps[n]!.action:undefined);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile runner must fit the viewport');}
   await page.getByRole('link',{name:'Resources',exact:true}).click();await page.getByText('Inspect dataset →',{exact:true}).click();await page.getByRole('heading',{name:'Calculation jobs',exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile detail/history must fit the viewport');
   await reset();await start();await page.getByRole('link',{name:'Free Exploration',exact:true}).click();await page.getByRole('button',{name:'Create dataset',exact:true}).click();await page.getByRole('button',{name:'Run calculation',exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile exploration form/resources must fit the viewport');
  });
  await t.test('browser requests preserve credentials boundary, no token/commands in storage and no uncaught JS errors',async()=>{
   assert.ok(mutations.length>20);const normal=mutations.filter(m=>m.origin!=='http://foreign.invalid');
   assert.ok(normal.every(m=>m.host===new URL(origin).host&&m.origin===origin&&m.header==='1'&&m.json),'Proxy must preserve normal browser Host/Origin/CSRF headers');
   assert.equal(pageErrors.length,0);assert.ok(await page.evaluate(()=>Object.entries(localStorage).every(([key,value])=>key.startsWith('fcp.step.v1:')&&!/token|cookie|airflowDag|upstreamDatasetVersions/i.test(value))));
  });
  await context.close();console.log('UI_SMOKE_RUNTIME',JSON.stringify({node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version,browser:browser.version(),database:name,migrations:11,screenshots}));
 }finally{
  try{await browser?.close();await vite?.close();await app?.close();if(db){await db.end();await Promise.all(ends);}}
  finally{try{if(created){const deadline=Date.now()+5000;let rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);
   while(rows.rowCount&&Date.now()<deadline){await setImmediate();rows=await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name]);}assert.equal(rows.rowCount,0);
   assert.match(name,/^demo03_browser_[a-z0-9_]+$/);await admin.query(`DROP DATABASE "${name}"`);console.log('UI_SMOKE_TEARDOWN',JSON.stringify({database:name,sessions:0,dropped:true,forced:false}));}}
  finally{await admin.end();}}
 }
});
