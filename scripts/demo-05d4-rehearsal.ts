import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {scenarios,check,assertRehearsalConfig,assertRuntimePorts,type Scenario} from './support/demo-05d4-contract.js';
import {workflowAcceptance,type DemoHttp,type HttpResult} from './support/demo-05d4-workflow.js';
import {upstream} from './support/six-domain-workflow-expectations.js';

interface Result {code:number;out:string;err:string}
async function command(exe:string,args:string[],env:NodeJS.ProcessEnv,timeout=180000):Promise<Result>{
 return new Promise((done,reject)=>{
  const p=spawn(exe,args,{env,stdio:['ignore','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Rehearsal command timed out'));},timeout);
  p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  p.once('error',()=>{clearTimeout(timer);reject(Error('Rehearsal command unavailable'));});
  p.once('close',code=>{clearTimeout(timer);done({code:code??-1,out,err});});
 });
}
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();check(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port;}

export function assertExpectedBackendStartupFailure(b:any,logs:string,web:unknown){
 check(web===null); // This fresh negative fixture must never have created Web.
 check(b&&b.Config.Env.filter((v:string)=>v.startsWith('DEMO_MAX_EXECUTORS=')).length===1
  &&b.Config.Env.includes('DEMO_MAX_EXECUTORS=invalid-fixture'));
 check(b.State.Status==='exited'&&!b.State.Running&&!b.State.Restarting&&!b.State.Paused&&!b.State.OOMKilled
  &&b.State.ExitCode===1&&b.State.Error===''&&b.State.Health?.Status!=='healthy'&&b.HostConfig.RestartPolicy.Name==='no');
 // Anchored diagnostic, never a substring in arbitrary container output.
 check(logs.split(/\r?\n/).some(line=>line==='application_environment_invalid: verify APP_MODE and production Demo configuration'));
 check(!logs.split(/\r?\n/).some(line=>/application_(?:startup_failed|database_connection_failed|ready|shutdown_failed)/.test(line)));
}

/** Runs the real deployment scripts on a fresh CI machine. The machine is discarded afterward, so nothing is cleaned up. */
export async function runRehearsal(scenario:Scenario){
 check(process.env.GITHUB_ACTIONS==='true'&&scenarios.includes(scenario));
 const env:NodeJS.ProcessEnv={...process.env};
 const project='demo05d4_'+randomBytes(12).toString('hex'),root=await mkdtemp(join(tmpdir(),'demo05d4-'));
 const port=await freePort(),password=randomBytes(24).toString('hex'),proxy=randomBytes(32).toString('hex');
 await mkdir(join(root,'secrets'),{mode:0o700});
 for(const [name,value]of Object.entries({postgres_password:password,proxy_secret:proxy,database_url:`postgres://demo_owner:${password}@database:5432/cost_engine_demo`}))
  await writeFile(join(root,'secrets',name),value,{mode:0o644}); // Private parent; the image's unprivileged user must read mounted secrets.
 const envFile=join(root,'compose.env'),override=join(root,'override.yaml');
 await writeFile(envFile,`COMPOSE_PROJECT_NAME=${project}\nDEPLOYMENT_VERSION=${project}\nDEMO_PUBLIC_ORIGIN=https://localhost:${port}\nACME_EMAIL=rehearsal@example.invalid\nDEMO_SECRETS_DIR=${join(root,'secrets')}\n`,{mode:0o600});
 const overrideText=`services:\n  backend:\n    container_name: ${project}-backend\n  web:\n    environment:\n      DEMO_TLS_DIRECTIVE: tls internal\n    ports: !override\n      - "127.0.0.1:${port}:${port}/tcp"\n      - "127.0.0.1:${port}:${port}/udp"\n`;
 await writeFile(override,overrideText,{mode:0o600});
 const base=['compose','--project-name',project,'--env-file',envFile,'-f',resolve('deploy/compose.yaml'),'-f',override];
 const scriptEnv:NodeJS.ProcessEnv={...env,COMPOSE_PROJECT_NAME:project,DEMO_DEPLOY_ENV:envFile,DEMO_COMPOSE_FILE:resolve('deploy/compose.yaml'),DEMO_COMPOSE_OVERRIDE:override};
 const target=['--database-url-file','/run/secrets/database_url'],approval=['--confirm-owner-acceptance-05d2-05d3',...target];
 const docker=async(args:string[],ok=true,timeout?:number)=>{const r=await command('docker',args,env,timeout);if(ok)check(r.code===0);return r;};
 const compose=(...args:string[])=>docker([...base,...args]);
 const script=async(name:string,args:string[]=[],ok=true)=>{
  const r=await command('sh',[resolve('deploy/scripts/'+name+'.sh'),...args],scriptEnv,name==='deploy'?900000:180000);
  if(ok)check(r.code===0);else check(r.code!==0);return r;
 };
 const sql=async(query:string)=>(await compose('exec','-T','database','psql','-U','demo_owner','-d','cost_engine_demo','-qAt','-v','ON_ERROR_STOP=1','-c','BEGIN READ ONLY;'+query+';ROLLBACK')).out.trim();
 const inspect=async(service:string)=>{
  const ids=(await compose('ps','--all','-q',service)).out.trim().split(/\s+/).filter(Boolean);check(ids.length<=1);
  return ids.length?JSON.parse((await docker(['inspect',ids[0]!])).out)[0]:null;
 };
 const closed=async()=>{const w=await inspect('web');check(!w||(!w.State.Running&&!w.State.Restarting&&w.HostConfig.RestartPolicy.Name==='no'));};
 const offline=async()=>{await closed();const b=await inspect('backend');check(!b||(!b.State.Running&&b.HostConfig.RestartPolicy.Name==='no'));};
 const config=async()=>{
  const r=await compose('--profile','operations','--profile','public-web','config','--format','json');
  assertRehearsalConfig(JSON.parse(r.out),project,port);
  const control=await new Promise<number>((done,reject)=>{const p=spawn(process.execPath,['deploy/scripts/control-json.cjs','config'],{stdio:['pipe','ignore','ignore']});p.once('error',reject);p.once('close',c=>done(c??-1));p.stdin.end(r.out);});
  check(control===0);
 };
 const status=async()=>JSON.parse((await script('operate',['cutover-status',...target])).out);
 const health=async()=>{
  const b=await inspect('backend');check(b?.State.Running&&b.State.Health?.Status==='healthy');assertRuntimePorts(b,'backend',port);
  const h=JSON.parse((await compose('exec','-T','backend','node','-e',"const r=await fetch('http://127.0.0.1:3000/health/ready');console.log(JSON.stringify({status:r.status,body:await r.json()}))")).out);
  check(h.status===200&&h.body.status==='ready'&&h.body.version===project);return b;
 };
 const stage=async(name:string,action:()=>Promise<void>)=>{
  try{await action();console.info('PASS',name);}catch(e){console.error('FAIL',name);throw e;}
 };

 await stage('FRESH_INSTALLATION',async()=>{
  await config();
  check((await docker(['ps','--all','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}'])).out.trim()==='');
  await docker([...base,'--profile','operations','--profile','public-web','build','backend','operator','web'],true,900000);await script('deploy');
  const db=await inspect('database');check(db.State.Running&&db.State.Health.Status==='healthy');assertRuntimePorts(db,'database',port);
  check(!await inspect('backend')&&!await inspect('web'));
  check(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'")==='0');
  await script('operate',['migrate-up']);await script('operate',['seed-six-domain']);
  const s=await status();check(s.state==='LEGACY_OPEN'&&s.configuration==='LEGACY');
  const files=(await readdir('migrations')).filter(n=>/^\d+_.*\.ts$/.test(n)).map(n=>n.replace(/\.ts$/,''));
  check(JSON.stringify(JSON.parse(await sql('SELECT json_agg(name ORDER BY name) FROM pgmigrations')))===JSON.stringify(files.sort()));await offline();
 });
 if(scenario==='cutover-precondition-failure'){
  await stage('CUTOVER_WITHOUT_DRAIN_REFUSED',async()=>{
   const r=await script('operate',['cutover',...target],false);check(r.err.includes('Operator cutover failed'));
   check((await status()).state==='LEGACY_OPEN');await offline();
  });
  return;
 }
 await stage('CONFIGURATION_CUTOVER',async()=>{
  await script('operate',['admission-drain',...target]);await script('operate',['cutover',...target]);
  const s=await status();check(s.state==='WORKFLOW_OPEN'&&s.configuration==='WORKFLOW');await offline();
 });
 if(scenario==='backend-startup-failure'){
  await stage('BACKEND_STARTUP_REFUSED',async()=>{
   // Override only the Backend's existing validated limit.
   await writeFile(override,overrideText.replace(`    container_name: ${project}-backend\n`,`    container_name: ${project}-backend\n    environment:\n      DEMO_MAX_EXECUTORS: invalid-fixture\n`),{mode:0o600});await config();
   const r=await script('start',[],false);check(r.err.includes('Backend not ready'));
   const b=await inspect('backend');check(b);
   const logs=await docker(['logs','--tail','20',b.Id]);assertExpectedBackendStartupFailure(b,logs.out+logs.err,await inspect('web'));
   await script('open-web',approval,false);await closed();check(!await inspect('web'));
  });
  return;
 }
 let backendId='';
 await stage('BACKEND_START',async()=>{await script('start');backendId=(await health()).Id;await closed();});
 let ca:Buffer|undefined,cookie='';const origin='https://localhost:'+port;
 const http:DemoHttp=(path,method='GET',body,extra={})=>new Promise<HttpResult>((done,reject)=>{
  const bytes=body===undefined?undefined:JSON.stringify(body),req=request(origin+path,{ca,family:4,method,timeout:10000,
   headers:{origin,...cookie?{cookie}:{},...bytes?{'content-type':'application/json','content-length':Buffer.byteLength(bytes),'x-demo-session':'1'}:{},...extra}},res=>{
    let text='';res.on('data',b=>{text+=b;if(text.length>1024*1024)req.destroy();});res.on('error',reject);res.on('end',()=>done({status:res.statusCode!,headers:res.headers,body:text}));});
  req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('Rehearsal HTTPS failed')));req.end(bytes);
 });
 await stage('WEB_ACCEPTANCE',async()=>{
  await config();await script('open-web',approval);const w=await inspect('web');check(w.State.Running);assertRuntimePorts(w,'web',port);
  assertRuntimePorts(await inspect('database'),'database',port);assertRuntimePorts(await health(),'backend',port);
  const caFile=join(root,'ca.crt');const until=Date.now()+20000;
  for(;;){const r=await docker(['cp',w.Id+':/data/caddy/pki/authorities/local/root.crt',caFile],false);if(r.code===0)break;check(Date.now()<until);await delay(200);}
  ca=await readFile(caFile);check((await http('/')).status===200);
  check((await http('/demo/workflow-templates')).status===401);
  check((await http('/demo/sessions','POST',{}, {'x-demo-session':''})).status===403);
  check((await http('/demo/sessions','POST',{}, {origin:'https://evil.invalid'})).status===403);
  const s=await http('/demo/sessions','POST',{});check(s.status===201);const value=s.headers['set-cookie']?.[0];
  check(value&&/; Secure(?:;|$)/.test(value)&&/; HttpOnly(?:;|$)/.test(value)&&/; SameSite=Strict(?:;|$)/.test(value)&&/; Path=\/(?:;|$)/.test(value));cookie=value.split(';')[0]!;
  check(cookie.startsWith('__Host-ce_demo_session='));check((await http('/demo/sessions','POST',{})).status===200);
  const c=await http('/demo/workflow-templates');check(c.status===200);const catalog=JSON.parse(c.body);
  check(catalog.admissionState==='WORKFLOW_OPEN'&&catalog.templates.length===4&&catalog.templates.every((v:any)=>v.version===2&&v.availability==='AVAILABLE'));
  for(const t of catalog.templates)check((await http('/demo/workflow-templates/'+t.id)).status===200);
  check((await http('/demo/workflow-templates','GET',undefined,{origin:'https://evil.invalid'})).status===403);
  for(const p of ['/health','/health/ready','/internal/jobs','/dataset-versions','/calculation-jobs','/executor-callbacks','/migrations','/seed','/debug','/admin','/api/private'])
   check((await http(p)).status===404);
 });
 await stage('WORKFLOW_ACCEPTANCE',async()=>{
  await workflowAcceptance(http,async uuid=>{check(/^[a-f0-9-]{36}$/.test(uuid));return sql(`SELECT md5(concat_ws('|',
   (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)::text FROM dataset_build_snapshots b WHERE b.dataset_version_id='${uuid}'::uuid),
   (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.upstream_dataset_series_id)::text FROM dataset_build_snapshot_dependencies d JOIN dataset_build_snapshots b ON b.id=d.snapshot_id WHERE b.dataset_version_id='${uuid}'::uuid),
   (SELECT jsonb_agg(jsonb_build_array(j.id,j.resolved_dependency_definition_version_id) ORDER BY j.id)::text FROM calculation_jobs j WHERE j.output_dataset_version_id='${uuid}'::uuid)))`);});
  const graph=JSON.parse(await sql(`SELECT jsonb_build_object('domains',(SELECT count(DISTINCT domain) FROM dataset_series),'jobs',(SELECT count(*) FROM calculation_jobs),
   'attempts',(SELECT count(*) FROM execution_attempts WHERE status='SUCCEEDED'),'published',(SELECT count(*) FROM dataset_versions WHERE status='PUBLISHED'),
   'snapshots',(SELECT count(*) FROM dataset_build_snapshots),'capex',(SELECT count(*) FROM calculation_jobs j JOIN calculation_types t ON t.id=j.calculation_type_id WHERE t.domain='CAPEX'),
   'dependencies',(SELECT jsonb_agg(jsonb_build_array(ds.domain,us.domain,u.status) ORDER BY ds.domain) FROM dataset_build_snapshot_dependencies d JOIN dataset_build_snapshots b ON b.id=d.snapshot_id
    JOIN dataset_versions v ON v.id=b.dataset_version_id JOIN dataset_series ds ON ds.id=v.dataset_series_id JOIN dataset_versions u ON u.id=d.upstream_dataset_version_id JOIN dataset_series us ON us.id=u.dataset_series_id))`));
  check(graph.domains===6&&graph.jobs===10&&graph.attempts===10&&graph.published===6&&graph.snapshots===6&&graph.capex===2);
  check(JSON.stringify(graph.dependencies)===JSON.stringify(Object.entries(upstream).sort(([a],[b])=>a.localeCompare(b)).map(([d,u])=>[d,u,'PUBLISHED'])));
 });
 await stage('WEB_CLOSURE',async()=>{await script('close-web');await closed();check((await health()).Id===backendId&&(await inspect('database')).State.Running);});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{check(process.argv.length===4&&process.argv[2]==='--scenario');await runRehearsal(process.argv[3]as Scenario);console.info(JSON.stringify({scenario:process.argv[3],result:'PASS'}));}
 catch{console.error('Deployment rehearsal failed');process.exitCode=1;}
}
