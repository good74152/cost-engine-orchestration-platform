import 'dotenv/config';
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {request as httpRequest,createServer as createHttpServer,type Server} from 'node:http';
import {extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {Client,type Pool} from 'pg';
import {runner} from 'node-pg-migrate';
import {chromium,type Browser,type Page} from 'playwright';
import {build} from 'vite';
import type {FastifyInstance} from 'fastify';
import {DemoAdmissionOperator} from '../../src/modules/demo-admission/demo-admission.operator.js';
import {DemoCutoverOperator} from '../../src/modules/demo-cutover/demo-cutover.operator.js';
import {DEFAULT_LINKS} from '../src/scenarios/labels.js';

const source=process.env.TEST_DATABASE_URL;
if(!source)throw new Error('The one-page browser test requires an explicit disposable TEST_DATABASE_URL');
const connection=(name:string)=>{const u=new URL(source);u.pathname='/'+name;return u.toString();};
const root=fileURLToPath(new URL('../',import.meta.url));
const shots=process.env.SMOKE_SCREENSHOT_DIR;
/** The exact policy Caddy sends in production. A bundle change that breaks it fails here. */
const policy=/Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(root,'../deploy/Caddyfile'),'utf8'))?.[1];
assert.ok(policy,'Caddyfile must declare a Content-Security-Policy');
const TYPES:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};

/** Production bundle plus same-origin /demo proxy, with Caddy's CSP. Host and Origin are preserved. */
function serve(dist:string,backend:string):Server{
 const target=new URL(backend);
 return createHttpServer((req,res)=>{
  const path=(req.url??'/').split('?')[0]!;
  if(path.startsWith('/demo/')){
   const upstream=httpRequest({host:target.hostname,port:target.port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);});
   upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
  }
  const file=join(dist,path);const found=path!=='/'&&existsSync(file)?file:join(dist,'index.html');
  res.writeHead(200,{'content-type':TYPES[extname(found)]??'application/octet-stream','content-security-policy':policy!});
  createReadStream(found).pipe(res);
 });
}

test('One-page demo: real Chromium, production bundle, CSP and PostgreSQL',{timeout:300_000},async t=>{
 const name=`demo_06_browser_${process.pid}_${randomUUID().replaceAll('-','').slice(0,12)}`;
 assert.match(name,/^demo_06_browser_[a-z0-9_]+$/);assert.ok(name.length<=63);
 const admin=new Client({connectionString:connection('postgres')});await admin.connect();
 const dist=join(root,'dist-smoke-'+process.pid);
 let created=false;let db:Pool|undefined;let app:FastifyInstance|undefined;let web:Server|undefined;let browser:Browser|undefined;
 const ends:Promise<void>[]=[];const prior={...process.env};
 try{
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
  await runner({databaseUrl:connection(name),dir:fileURLToPath(new URL('../../migrations/',import.meta.url)),migrationsTable:'pgmigrations',direction:'up',singleTransaction:true,checkOrder:true,logger:{debug(){},info(){},warn(){},error(){}}});
  process.env.DATABASE_URL=connection(name);process.env.NODE_ENV='test';process.env.APP_MODE='demo';process.env.EXECUTOR_TYPE='fake';
  const [{pool},{buildApp},{DemoRuntime},{seedDemoSixDomainConfiguration}]=await Promise.all([
   import('../../src/db/pool.js'),import('../../src/app.js'),import('../../src/modules/demo-session/demo-runtime.js'),import('../../scripts/seed-demo-six-domain-configuration.js')]);
  db=pool;pool.on('connect',c=>ends.push(new Promise<void>(done=>c.once('end',done))));
  await seedDemoSixDomainConfiguration(pool);await new DemoAdmissionOperator(pool).drain();await new DemoCutoverOperator(pool).cutover();
  const runtime=new DemoRuntime(pool,'test',{},{log(){}});await runtime.reset.startServer();
  app=await buildApp({appMode:'demo',demoRuntime:runtime,nodeEnvironment:'test',logger:false});
  const posts:string[]=[];app.addHook('onRequest',async req=>{if(req.method==='POST')posts.push(req.url);});
  const backend=await app.listen({host:'127.0.0.1',port:0});
  await build({root,configFile:join(root,'vite.config.ts'),logLevel:'error',build:{outDir:dist,emptyOutDir:true}});
  web=serve(dist,backend);await new Promise<void>(done=>web!.listen(0,'127.0.0.1',done));
  const address=web.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
  if(shots)mkdirSync(shots,{recursive:true});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',timezoneId:'Asia/Taipei',reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(20_000);
  const problems:string[]=[];
  const watch=(p:Page)=>{p.on('pageerror',e=>problems.push('pageerror: '+e.message));
   p.on('console',m=>{if(m.type()!=='error')return;const text=m.text();
    // A first visit asks for a session and correctly gets 401; 409s are scenario results.
    if(/Failed to load resource.*(401|409)/.test(text))return;problems.push('console: '+text);});};
  watch(page);
  const shot=async(label:string,target=page)=>{if(shots)await target.screenshot({path:join(shots,label+'.png'),fullPage:true});};
  const dialog=(title:string)=>page.getByRole('dialog',{name:title});
  const closeDialog=async(title:string)=>{await dialog(title).getByRole('button',{name:'Close'}).last().click();await dialog(title).waitFor({state:'detached'});};
  const session=async()=>{const r=await context.request.get(origin+'/demo/sessions/current');assert.equal(r.status(),200);return r.json() as Promise<{sessionId:string;companyCode:string}>;};
  const attempts=async(company:string,domain:string,period:string)=>(await pool.query(`SELECT a.attempt_number,a.status,a.airflow_dag_run_id,j.id AS job FROM execution_attempts a
    JOIN calculation_jobs j ON j.id=a.calculation_job_id JOIN dataset_versions v ON v.id=j.output_dataset_version_id JOIN dataset_series s ON s.id=v.dataset_series_id
    WHERE s.company_code=$1 AND s.domain=$2 AND s.period=$3 ORDER BY j.id,a.attempt_number`,[company,domain,period])).rows as {attempt_number:number;status:string;airflow_dag_run_id:string;job:string}[];
  const versions=async(company:string,domain:string,period:string)=>(await pool.query(`SELECT v.version,v.status FROM dataset_versions v JOIN dataset_series s ON s.id=v.dataset_series_id
    WHERE s.company_code=$1 AND s.domain=$2 AND s.period=$3 ORDER BY v.version`,[company,domain,period])).rows as {version:number;status:string}[];

  await t.test('a first-time visitor sees the point at once, with no error and no command',async()=>{
   await page.goto(origin);
   await page.getByRole('heading',{level:1,name:/Async Workflow for Financial Report Calculation/}).waitFor();
   await page.getByRole('group',{name:'Example of saved records'}).waitFor();
   await page.waitForLoadState('networkidle');
   assert.equal(await page.getByRole('dialog').count(),0);assert.equal(posts.length,0);
   assert.deepEqual(problems,[]);await shot('01-first-visit');
  });
  let company='';
  await t.test('Happy path publishes all six reports, and the map matches the backend template',async()=>{
   await page.getByRole('button',{name:'Run Happy path'}).click();
   const done=dialog('All six reports published');await done.waitFor({timeout:40_000});
   const text=await done.innerText();assert.match(text,/6 reports published/);assert.match(text,/10 jobs succeeded/);assert.match(text,/5 reports locked the input/);
   company=(await session()).companyCode;
   const rows=(await pool.query(`SELECT s.domain,v.status FROM dataset_versions v JOIN dataset_series s ON s.id=v.dataset_series_id WHERE s.company_code=$1 AND s.period='Q1'`,[company])).rows as {domain:string;status:string}[];
   assert.equal(rows.length,6);assert.ok(rows.every(r=>r.status==='PUBLISHED'));
   await shot('01b-normal-close');await closeDialog('All six reports published');await shot('01c-normal-close-map');
   const map=page.getByRole('group',{name:'Report dependency map'});
   for(const label of ['Fab cost','Capital expenditure','Depreciation','Insurance','Standard cost','End-to-end cost'])await map.getByRole('button',{name:'Show '+label+', Published'}).waitFor();
   const template=await (await context.request.get(origin+'/demo/workflow-templates/SIX_DOMAIN_WORKFLOW')).json() as {steps:{id:string;domain:string;operation:string;prerequisites:string[]}[]};
   const domainOf=new Map(template.steps.map(s=>[s.id,s.domain]));
   const links=Object.fromEntries(template.steps.filter(s=>s.operation==='CREATE_DATASET').map(s=>[s.domain,domainOf.get(s.prerequisites[0]??'')??null]));
   assert.deepEqual(links,DEFAULT_LINKS,'the map shown before a session must match the backend template');
  });
  await t.test('Lost reply pauses on the unknown outcome, then recovers without a second attempt or run',async()=>{
   await page.setViewportSize({width:1440,height:600});await page.evaluate(()=>window.scrollTo(0,180));
   await page.getByRole('button',{name:'Run Lost reply'}).click();
   const paused=dialog('The reply never arrived');await paused.waitFor();await shot('02-lost-reply-dialog');
   const before=await attempts(company,'CAPEX','Q2');assert.equal(before.length,1);assert.equal(before[0]!.status,'DISPATCHING');
   const job=before[0]!.job;const runId=before[0]!.airflow_dag_run_id;
   await page.keyboard.press('Escape');await paused.waitFor();// The viewer has to decide; Escape doesn't skip it.
   await paused.getByRole('button',{name:'Check the same run'}).click();
   const done=dialog('No duplicate run');await done.waitFor();
   const after=await attempts(company,'CAPEX','Q2');const same=after.filter(a=>a.job===job);
   assert.equal(same.length,1);assert.equal(same[0]!.airflow_dag_run_id,runId);assert.equal(same[0]!.status,'SUCCEEDED');
   assert.equal(new Set(after.map(a=>a.job)).size,2);assert.deepEqual(await versions(company,'CAPEX','Q2'),[{version:1,status:'PUBLISHED'}]);
   assert.match(await done.innerText(),new RegExp(runId));assert.match(await done.innerText(),/1 try\./);
   await shot('03-lost-reply-recovered');await closeDialog('No duplicate run');
   assert.ok((await page.evaluate(()=>window.scrollY))>0,'the page must not jump back to the top after a run');await page.setViewportSize({width:1440,height:1000});
   await page.getByRole('button',{name:/^Show Capital expenditure/}).waitFor();
   await page.getByRole('group',{name:/Saved records for Capital expenditure/}).getByText('Input locked: Fab cost v1').waitFor();
   await shot('04-lost-reply-tree');
  });
  await t.test('blocks open their explanation without sending a command',async()=>{
   const count=posts.length;
   await page.getByRole('button',{name:/^Try execution_attempt/}).click();
   await dialog('Try (execution_attempt)').waitFor();await shot('04b-concept-dialog');await closeDialog('Try (execution_attempt)');
   await page.getByRole('button',{name:/^A step failed/}).click();
   await dialog('A step failed in a long workflow').getByText('Someone reran it by hand in Airflow.').waitFor();await shot('04c-then-now');await closeDialog('A step failed in a long workflow');
   assert.equal(posts.length,count);
  });
  await t.test('the language switch changes the page, not the data, and survives a reload',async()=>{
   const count=posts.length;
   await page.getByRole('button',{name:'繁體中文'}).click();
   await page.getByRole('heading',{level:1,name:/財務報表計算的 Async Workflow/}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh-TW');await shot('04d-zh');
   await page.reload();await page.getByRole('heading',{name:'選擇 Scenario'}).waitFor();
   await page.getByRole('button',{name:'English'}).click();await page.getByRole('heading',{name:'Pick a scenario'}).waitFor();
   assert.equal(posts.length,count);
  });
  await t.test('reloading the page restores saved state and sends no command',async()=>{
   const count=posts.length;await page.reload();
   await page.getByRole('group',{name:/Saved records for/}).waitFor();await page.waitForLoadState('networkidle');
   assert.equal(posts.length,count);assert.equal(await page.getByRole('dialog').count(),0);
  });
  await t.test('Failed job and retry, stepped by hand, keeps history and frozen inputs when upstream moves on',async()=>{
   await page.getByRole('button',{name:'Step through Failed job and retry'}).click();
   for(let clicks=0;clicks<6;clicks++){const next=page.getByRole('button',{name:/^Next: /});await next.waitFor();if(clicks===3)await shot('05-step-through');await next.click();}
   const done=dialog('Retried, with the failure on record');await done.waitFor();
   assert.match(await done.innerText(),/try 1 FAILED, try 2 SUCCEEDED/);assert.match(await done.innerText(),/version 1\. The newest is version 2/);
   const rows=await attempts(company,'CAPEX','Q3');const failed=rows.filter(a=>a.status==='FAILED');
   assert.equal(failed.length,1);assert.equal(rows.filter(a=>a.job===failed[0]!.job).length,2);
   assert.equal(new Set(rows.map(a=>a.airflow_dag_run_id)).size,rows.length,'a retry must use a new run ID');
   assert.deepEqual(await versions(company,'FAB_COST','Q3'),[{version:1,status:'PUBLISHED'},{version:2,status:'PUBLISHED'}]);
   await closeDialog('Retried, with the failure on record');await shot('06-retry-tree');
   await page.getByRole('button',{name:'Details for Try 1, Failed'}).first().click();
   const details=dialog('Try 1 (execution_attempt)');await details.waitFor();assert.match(await details.innerText(),/A retry adds a new try/);
   await shot('07-details');await closeDialog('Try 1 (execution_attempt)');
  });
  await t.test('Conflicting requests shows the real replies: one winner, then the order rule',async()=>{
   await page.getByRole('button',{name:'Run Conflicting requests'}).click();
   const done=dialog('One winner, and the order held');await done.waitFor();
   const text=await done.innerText();assert.match(text,/1 created, 3 rejected with HTTP 409/);assert.match(text,/Starting too early created 0 tries/);assert.match(text,/can’t prove/);
   assert.deepEqual(await versions(company,'CAPEX','Q4'),[{version:1,status:'BUILDING'}]);await shot('08-conflict');
   await closeDialog('One winner, and the order held');
   await page.getByText('API commands sent').click();await page.getByText('ACTIVE_DATASET_VERSION_EXISTS').first().waitFor();await page.getByText('DEPENDENCY_NOT_READY').first().waitFor();
  });
  await t.test('a lost browser response is reported as unknown and never retried',async()=>{
   let lost=0;await page.route('**/demo/calculation-jobs/*/run',async route=>{lost++;await route.fetch();await route.abort('failed');});
   await page.getByRole('button',{name:'Run Lost reply'}).click();
   const stopped=dialog('The scenario stopped');await stopped.waitFor();assert.match(await stopped.innerText(),/the result is unknown/);
   await page.unroute('**/demo/calculation-jobs/*/run');assert.equal(lost,1);await closeDialog('The scenario stopped');
   problems.splice(0,problems.length,...problems.filter(p=>!/ERR_FAILED/.test(p)));
  });
  await t.test('the page fits a phone with no sideways page scroll, and the chart scrolls on its own',async()=>{
   const phoneContext=await browser!.newContext({viewport:{width:390,height:844},storageState:await context.storageState(),reducedMotion:'reduce'});
   const phone=await phoneContext.newPage();watch(phone);await phone.goto(origin);await phone.waitForLoadState('networkidle');
   await phone.getByRole('group',{name:/Saved records/}).waitFor();
   const widths=await phone.evaluate(()=>({page:document.documentElement.scrollWidth,view:window.innerWidth}));
   assert.ok(widths.page<=widths.view,`page ${widths.page} wider than ${widths.view}`);await shot('09-phone',phone);await phoneContext.close();
  });
  await t.test('sessions stay isolated, and clearing data removes only that session after confirmation',async()=>{
   const owner=await session();
   const other=await browser!.newContext();const otherPage=await other.newPage();await otherPage.goto(origin);
   await otherPage.getByRole('group',{name:'Example of saved records'}).waitFor();
   assert.equal((await other.request.get(origin+'/demo/dataset-versions')).status(),401);await other.close();
   await page.getByRole('button',{name:'Clear my demo data'}).click();
   await dialog('Clear your demo data?').getByRole('button',{name:'Keep my data'}).click();
   assert.notEqual((await pool.query('SELECT 1 FROM dataset_series WHERE company_code=$1',[owner.companyCode])).rowCount,0);
   await page.getByRole('button',{name:'Clear my demo data'}).click();
   await dialog('Clear your demo data?').getByRole('button',{name:'Clear data'}).click();
   await page.getByRole('group',{name:'Example of saved records'}).waitFor();
   assert.equal((await pool.query('SELECT 1 FROM dataset_series WHERE company_code=$1',[owner.companyCode])).rowCount,0);
   await page.reload();await page.getByRole('button',{name:'Run Lost reply'}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  });
  assert.deepEqual(problems,[],'no CSP violation, console error or uncaught error across the whole run');
  assert.deepEqual(await page.evaluate(()=>Object.keys(localStorage)),['ce-demo-language'],'the language is the only thing kept in the browser');
  console.info('ONE_PAGE_BROWSER_VERIFIED',JSON.stringify({chromium:browser.version(),csp:policy}));await context.close();
 }finally{
  try{await browser?.close();await new Promise<void>(done=>web?web.close(()=>done()):done());await app?.close();await db?.end();await Promise.all(ends);await rm(dist,{recursive:true,force:true});}
  finally{
   for(const key of ['DATABASE_URL','NODE_ENV','APP_MODE','EXECUTOR_TYPE']){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
   try{if(created){const deadline=Date.now()+5000;while((await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rowCount){assert.ok(Date.now()<deadline);await setImmediate();}
    await admin.query(`DROP DATABASE "${name}"`);}}
   finally{await admin.end();}
  }
 }
});
