import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,realpath,rm,open,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {scenarios,check,RehearsalReport,assertRehearsalConfig,assertRuntimePorts,assertOwned,parseSummary,type Scenario} from './support/demo-05d4-contract.js';
import {workflowAcceptance,type DemoHttp,type HttpResult} from './support/demo-05d4-workflow.js';
import {upstream} from './support/six-domain-workflow-expectations.js';
import {parseOperationalManifest,parseVerifiedDrill} from '../src/deployment/readiness-evidence.js';
import {assertPrivateDirectory} from '../src/deployment/private-directory.js';

interface Result {code:number;out:string;err:string}
// Owned process group only; bounded output/time and termination. No raw output
// reaches Console, test assertions or uploaded reports, including on failure.
async function command(exe:string,args:string[],env:NodeJS.ProcessEnv,input?:string,timeout=180000):Promise<Result>{
 return new Promise((done,reject)=>{
  const p=spawn(exe,args,{env,detached:true,stdio:['pipe','pipe','pipe']});let out='',err='',bytes=0,invalid=false,force:NodeJS.Timeout|undefined;
  const stop=()=>{if(invalid)return;invalid=true;if(p.pid){try{process.kill(-p.pid,'SIGTERM');}catch{}force=setTimeout(()=>{try{process.kill(-p.pid!,'SIGKILL');}catch{}},2000);}};
  const timer=setTimeout(stop,timeout);
  const collect=(chunk:Buffer,isError:boolean)=>{bytes+=chunk.length;if(bytes>4*1024*1024){stop();return;}if(!invalid){if(isError)err+=chunk.toString();else out+=chunk.toString();}};
  p.stdout.on('data',b=>collect(b,false));p.stderr.on('data',b=>collect(b,true));p.stdin.on('error',()=>{});p.stdin.end(input);
  p.once('error',()=>{clearTimeout(timer);if(force)clearTimeout(force);reject(Error('Rehearsal command unavailable'));});
  p.once('close',code=>{clearTimeout(timer);if(force)clearTimeout(force);if(invalid)reject(Error('Rehearsal command bound exceeded'));else done({code:code??-1,out,err});});
 });
}
const digest=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();check(a&&typeof a!=='string');await new Promise<void>(r=>s.close(()=>r()));return a.port;}
async function privateJson(file:string,max=8*1024*1024){const s=await lstat(file);check(s.isFile()&&!s.isSymbolicLink()&&s.size<=max);return JSON.parse(await readFile(file,'utf8'));}
function requireHostedRunner(){
 check(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.RUNNER_OS==='Linux'&&process.env.GITHUB_REPOSITORY==='good74152/cost-engine-orchestration-platform');
}

export async function runRehearsal(scenario:Scenario,summaryRoot:string){
 requireHostedRunner();check(scenarios.includes(scenario));const summaryDirectory=assertPrivateDirectory(summaryRoot);
 const env:NodeJS.ProcessEnv={...process.env,DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONTEXT:'default'};
 const git=await command('git',['rev-parse','HEAD'],env);check(git.code===0&&/^[a-f0-9]{40}$/.test(git.out.trim()));
 check((await command('git',['diff','--quiet'],env)).code===0&&(await command('git',['diff','--cached','--quiet'],env)).code===0);
 const sha=git.out.trim(),id='rehearsal-'+randomBytes(16).toString('hex'),project='demo05d4_'+randomBytes(12).toString('hex');
 const report=new RehearsalReport(scenario,id,sha);let root:string|undefined,rootIdentity:{dev:number;ino:number}|undefined;
 let base:string[]=[],scriptEnv=env,port=0,override='',overrideText='',sourceVolume='',backendId='';
 let initialRestore:{containers:string[];volumes:string[]}|undefined,cutoverCalls=0;
 const target=['--database-url-file','/run/secrets/database_url'],approval=['--confirm-owner-acceptance-05d2-05d3',...target];
 const docker=async(args:string[],ok=true,input?:string,timeout?:number)=>{const r=await command('docker',args,env,input,timeout);if(ok)check(r.code===0);return r;};
 const compose=(...args:string[])=>docker([...base,...args]);
 const script=async(name:string,args:string[]=[],ok=true,extra:NodeJS.ProcessEnv={})=>{
  if(name==='operate'&&args[0]==='cutover')cutoverCalls++;
  const r=await command('sh',[resolve('deploy/scripts/'+name+'.sh'),...args],{...scriptEnv,...extra},undefined,name==='deploy'?900000:180000);
  if(ok)check(r.code===0);else check(r.code!==0);return r;
 };
 const sql=async(query:string)=>(await compose('exec','-T','database','psql','-U','demo_owner','-d','cost_engine_demo','-qAt','-v','ON_ERROR_STOP=1','-c','BEGIN READ ONLY;'+query+';ROLLBACK')).out.trim();
 const inspect=async(service:string)=>{
  const ids=(await compose('ps','--all','-q',service)).out.trim().split(/\s+/).filter(Boolean);check(ids.length<=1);
  if(!ids.length)return null;const c=JSON.parse((await docker(['inspect',ids[0]!])).out)[0];assertOwned(c,'container',project,id);return c;
 };
 const closed=async()=>{const w=await inspect('web');check(!w||(!w.State.Running&&!w.State.Restarting&&w.HostConfig.RestartPolicy.Name==='no'));};
 const offline=async()=>{await closed();const b=await inspect('backend');check(!b||(!b.State.Running&&b.HostConfig.RestartPolicy.Name==='no'));};
 const config=async()=>{
  const r=await compose('--profile','operations','--profile','public-web','config','--format','json');const c=JSON.parse(r.out);
  assertRehearsalConfig(c,project,id,port);
  check((await command(process.execPath,['deploy/scripts/control-json.cjs','config'],env,r.out)).code===0);return c;
 };
 const stateHash=()=>sql(`SELECT md5(concat_ws('|',${['pgmigrations','demo_admission_control','calculation_types','execution_dependency_definition_versions',
  'execution_dependency_definition_dependencies','demo_sessions','demo_scenario_instances','demo_scenario_step_executions','dataset_series','dataset_versions',
  'calculation_jobs','execution_attempts','dataset_build_snapshots','dataset_build_snapshot_dependencies'].map(t=>`(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]') FROM ${t} t)`).join(',')}))`);
 const restoreResources=async()=>({containers:(await docker(['ps','--all','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.ID}}'])).out.trim().split(/\s+/).filter(Boolean).sort(),
  volumes:(await docker(['volume','ls','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.Name}}'])).out.trim().split(/\s+/).filter(Boolean).sort()});
 const status=async()=>JSON.parse((await script('operate',['cutover-status',...target])).out);
 const health=async()=>{
  const b=await inspect('backend');check(b?.State.Running&&b.State.Health?.Status==='healthy');assertRuntimePorts(b,'backend',port);
  const result=await compose('exec','-T','backend','node','-e',"const r=await fetch('http://127.0.0.1:3000/health/ready');console.log(JSON.stringify({status:r.status,body:await r.json()}))");
  const h=JSON.parse(result.out);check(h.status===200&&h.body.status==='ready'&&h.body.version===project);
  const s=await status();check(s.state==='WORKFLOW_OPEN'&&s.configuration==='WORKFLOW');return b;
 };
 const prepare=async(failRestore=false)=>{
  await offline();await script('operate',['admission-drain',...target]);
  const preflight=JSON.parse((await script('operate',['cutover-preflight',...target])).out);check(preflight.result==='PASS'&&preflight.businessDataEmpty===true&&preflight.admissionState==='DRAINING');
  const before=await stateHash(),m=JSON.parse((await script('backup',target)).out),bundle=join(root!,'first-backups',m.identity),archive=join(bundle,'backup.dump');
  check(/^cost-engine-backup-[A-Za-z0-9_-]+$/.test(m.identity)&&m.result==='BACKUP_CREATED');
  const archiveHash=digest(await readFile(archive)),manifestHash=digest(await readFile(join(bundle,'manifest.json')));check(archiveHash===m.sha256);
  const verified=JSON.parse((await script('verify-backup',['--backup-file',archive])).out);
  check(verified.result==='RESTORE_VERIFIED'&&verified.sha256===archiveHash&&verified.isolation.cleaned===true&&verified.isolation.network==='none'&&verified.isolation.publishedPorts===0);
  if(failRestore){
   const name='cost-engine-backup-'+randomBytes(12).toString('hex'),copy=join(root!,'first-backups',name);await mkdir(copy,{mode:0o700});
   await writeFile(join(copy,'manifest.json'),JSON.stringify({...m,identity:name}),{mode:0o600});
   const bytes=await readFile(archive);bytes[0]=0;await writeFile(join(copy,'backup.dump'),bytes,{mode:0o600});
   const r=await script('verify-backup',['--backup-file',join(copy,'backup.dump')],false);
   check(r.err.includes('PostgreSQL custom archive required')&&!r.out.includes('RESTORE_VERIFIED'));
   check(cutoverCalls===0&&(await status()).state==='DRAINING');await offline();
  }
  check(await stateHash()===before&&digest(await readFile(archive))===archiveHash&&digest(await readFile(join(bundle,'manifest.json')))===manifestHash);
  check(JSON.stringify(await restoreResources())===JSON.stringify(initialRestore));
 };
 const recovery=async(label:'pre-web'|'history',populated:boolean)=>{
  const batch=join(root!,label);await mkdir(batch,{mode:0o700});for(const name of ['backups','drills','readiness','policy'])await mkdir(join(batch,name),{mode:0o700});
  const b=await health(),before=await stateHash();await closed();
  const m=parseOperationalManifest(JSON.parse((await script('backup-live',target,true,{DEMO_BACKUP_DIR:join(batch,'backups')})).out),new Date().toISOString());
  const archive=join(batch,'backups',m.identity,'backup.dump');check(digest(await readFile(archive))===m.sha256);
  const result=await command(process.execPath,['--import','tsx','deploy/dr-drill.ts','--backup-file',archive,'--report-dir',join(batch,'drills'),'--target-rpo-ms','3600000'],scriptEnv,undefined,2700000);
  check(result.code===0&&JSON.parse(result.out).result==='DRILL_VERIFIED');const names=await readdir(join(batch,'drills'));check(names.length===1);
  const d=parseVerifiedDrill(await privateJson(join(batch,'drills',names[0]!,'report.json')),m,new Date().toISOString());
  check(d.assessment.manualReviewCount===0&&d.assessment.jobStatusCounts.SUCCEEDED===(populated?10:0)&&d.assessment.attemptStatusCounts.SUCCEEDED===(populated?10:0)
   &&m.snapshot.counts.demo_sessions===(populated?1:0)&&m.snapshot.counts.calculation_jobs===(populated?10:0)&&m.snapshot.counts.execution_attempts===(populated?10:0)
   &&m.snapshot.counts.dataset_versions===(populated?6:0)&&m.snapshot.counts.dataset_build_snapshots===(populated?6:0));
  const policy=join(batch,'policy','policy.json');await writeFile(policy,JSON.stringify({formatVersion:1,targetRpoMs:3600000,maxDrillAgeMs:3600000,maxOffHostEvidenceAgeMs:3600000,trustedOffHostReviewers:[]}),{mode:0o600});
  const summary=JSON.parse((await script('recovery-readiness',['--backup-dir',join(batch,'backups'),'--drill-dir',join(batch,'drills'),'--policy-file',policy,'--report-dir',join(batch,'readiness')])).out);
  check(summary.result==='READINESS_ASSESSED'&&summary.localRecoveryReadiness==='READY'&&summary.disasterRecoveryReadiness==='NOT_VERIFIED');
  const reports=await readdir(join(batch,'readiness'));check(reports.length===1);const r=await privateJson(join(batch,'readiness',reports[0]!,'report.json'));
  check(r.localRecoveryReadiness.status==='READY'&&r.disasterRecoveryReadiness.status==='NOT_VERIFIED'&&r.latestOffHostRestoreVerifiedBackup===null
   &&r.latestLocalRestoreVerifiedBackup.backupId===m.identity&&r.latestLocalRestoreVerifiedBackup.drill.drillId===d.drillId&&r.productionRecoveryApproved===false&&r.serviceRecoveryTested===false);
  const after=await health();check(after.Id===b.Id&&after.State.StartedAt===b.State.StartedAt&&await stateHash()===before&&JSON.stringify(await restoreResources())===JSON.stringify(initialRestore));
  check((await docker(['ps','--all','--filter','label=com.docker.compose.project='+project,'--filter','label=cost-engine.backup.purpose=demo05d3a','--format','{{.ID}}'])).out.trim()==='');await closed();
  report.value.localRecoveryReadiness='READY';report.value.disasterRecoveryReadiness='NOT_VERIFIED';
 };
 try{
  await report.stage('FRESH_INSTALLATION',async()=>{
   const context=JSON.parse((await docker(['context','inspect','default'])).out)[0];check(context.Endpoints.docker.Host==='unix:///var/run/docker.sock');
   root=await mkdtemp(join(tmpdir(),'demo05d4-'));rootIdentity=await lstat(root);await writeFile(join(root,'.owner'),id,{mode:0o600});
   for(const name of ['secrets','first-backups'])await mkdir(join(root,name),{mode:0o700});port=await freePort();
   const password=randomBytes(24).toString('hex'),proxy=randomBytes(32).toString('hex');
   for(const [name,value]of Object.entries({postgres_password:password,proxy_secret:proxy,database_url:`postgres://demo_owner:${password}@database:5432/cost_engine_demo`}))
    await writeFile(join(root,'secrets',name),value,{mode:0o644}); // Private 0700 parent; image's unprivileged user must read mounted secrets.
   const envFile=join(root,'compose.env');override=join(root,'override.yaml');
   await writeFile(envFile,`COMPOSE_PROJECT_NAME=${project}\nDEPLOYMENT_VERSION=${project}\nDEMO_PUBLIC_ORIGIN=https://localhost:${port}\nACME_EMAIL=rehearsal@example.invalid\nDEMO_SECRETS_DIR=${join(root,'secrets')}\n`,{mode:0o600});
   const labels=`      cost-engine.rehearsal.owner: ${id}\n`;
   overrideText='services:\n'+['backend','database','web','operator'].map(s=>`  ${s}:\n    labels:\n${labels}`+(s==='backend'?`    container_name: ${project}-backend\n`:s==='web'?`    environment:\n      DEMO_TLS_DIRECTIVE: tls internal\n    ports: !override\n      - "127.0.0.1:${port}:${port}/tcp"\n      - "127.0.0.1:${port}:${port}/udp"\n`:'' )).join('')
    +'volumes:\n'+['postgres_data','caddy_data','caddy_config'].map(s=>`  ${s}:\n    labels:\n${labels}`).join('')
    +'networks:\n'+['edge','proxy','database'].map(s=>`  ${s}:\n    labels:\n${labels}`).join('');
   await writeFile(override,overrideText,{mode:0o600});base=['compose','--project-name',project,'--env-file',envFile,'-f',resolve('deploy/compose.yaml'),'-f',override];
   scriptEnv={...env,COMPOSE_PROJECT_NAME:project,DEMO_DEPLOY_ENV:envFile,DEMO_COMPOSE_FILE:resolve('deploy/compose.yaml'),DEMO_COMPOSE_OVERRIDE:override,DEMO_BACKUP_DIR:join(root,'first-backups')};
   await config();initialRestore=await restoreResources();
   check((await docker(['ps','--all','--filter','label=com.docker.compose.project='+project,'--format','{{.ID}}'])).out.trim()==='');
   for(const kind of ['volume','network'])check((await docker([kind,'ls','--filter','label=com.docker.compose.project='+project,'--format',kind==='volume'?'{{.Name}}':'{{.ID}}'])).out.trim()==='');
   await docker([...base,'--profile','operations','--profile','public-web','build','backend','operator','web'],true,undefined,900000);await script('deploy');
   const db=await inspect('database');check(db.State.Running&&db.State.Health.Status==='healthy');assertRuntimePorts(db,'database',port);
   check((await docker(['ps','--filter','label=com.docker.compose.project='+project,'--format','{{.Label "com.docker.compose.service"}}'])).out.trim()==='database');
   check(!await inspect('backend')&&!await inspect('web'));sourceVolume=db.Mounts.find((m:any)=>m.Type==='volume'&&m.Destination==='/var/lib/postgresql').Name;
   const v=JSON.parse((await docker(['volume','inspect',sourceVolume])).out)[0];assertOwned(v,'volume',project,id);
   check(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'")==='0');
   await script('operate',['migrate-up']);await script('operate',['seed-six-domain']);const s=await status();check(s.state==='LEGACY_OPEN'&&s.configuration==='LEGACY');
   // Complete inventory verification is performed by existing preflight below.
   const files=(await readdir('migrations')).filter(n=>/^\d+_.*\.ts$/.test(n)).map(n=>n.replace(/\.ts$/,''));
   check(JSON.stringify(JSON.parse(await sql('SELECT json_agg(name ORDER BY name) FROM pgmigrations')))===JSON.stringify(files.sort()));await offline();
  });
  if(scenario==='cutover-precondition-failure'){
   await report.stage('CONFIGURATION_CUTOVER',async()=>{const before=await stateHash();const r=await script('operate',['cutover',...target],false);
    check(r.err.includes('Operator cutover failed')&&cutoverCalls===1&&await stateHash()===before);check((await status()).state==='LEGACY_OPEN');await offline();},'EXPECTED_CUTOVER_PRECONDITION_REJECTION');
  }else{
   await report.stage('CUTOVER_PREPARATION',()=>prepare(scenario==='restore-verification-failure'),scenario==='restore-verification-failure'?'EXPECTED_RESTORE_INTEGRITY_REJECTION':'NONE');
   if(scenario!=='restore-verification-failure'){
    await report.stage('CONFIGURATION_CUTOVER',async()=>{await script('operate',['cutover',...target]);const s=await status();check(s.state==='WORKFLOW_OPEN'&&s.configuration==='WORKFLOW'&&cutoverCalls===1);await offline();});
    await report.stage('BACKEND_START',async()=>{
     const before=await stateHash();
     if(scenario==='backend-startup-failure'){
      // Override only the Backend's existing validated limit. Operator/env,
      // migrations, admission and production failure paths are unchanged.
      await writeFile(override,overrideText.replace(`    container_name: ${project}-backend\n`,`    container_name: ${project}-backend\n    environment:\n      DEMO_MAX_EXECUTORS: invalid-fixture\n`),{mode:0o600});await config();
      const r=await script('start',[],false);check(r.err.includes('Backend not ready'));
      const b=await inspect('backend');check(b&&!b.State.Running&&b.State.Health?.Status!=='healthy');
      await script('open-web',approval,false);await closed();check(!await inspect('web')&&await stateHash()===before);
     }else{await script('start');backendId=(await health()).Id;await closed();check(await stateHash()===before);}
    },scenario==='backend-startup-failure'?'EXPECTED_BACKEND_STARTUP_REJECTION':'NONE');
    if(scenario==='happy-path'){
     await report.stage('PRE_WEB_RECOVERY',()=>recovery('pre-web',false));
     let ca:Buffer|undefined,cookie='';const origin='https://localhost:'+port;
     const http:DemoHttp=(path,method='GET',body,extra={})=>new Promise<HttpResult>((done,reject)=>{
      const bytes=body===undefined?undefined:JSON.stringify(body),req=request(origin+path,{ca,family:4,method,timeout:10000,
       headers:{origin,...cookie?{cookie}:{},...bytes?{'content-type':'application/json','content-length':Buffer.byteLength(bytes),'x-demo-session':'1'}:{},...extra}},res=>{
        let text='';res.on('data',b=>{text+=b;if(text.length>1024*1024)req.destroy();});res.on('error',reject);res.on('end',()=>done({status:res.statusCode!,headers:res.headers,body:text}));});
      req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('Rehearsal HTTPS failed')));req.end(bytes);
     });
     await report.stage('WEB_ACCEPTANCE',async()=>{
      await config();check(report.value.localRecoveryReadiness==='READY'&&report.value.disasterRecoveryReadiness==='NOT_VERIFIED');
      await script('open-web',approval);const w=await inspect('web');check(w.State.Running);assertRuntimePorts(w,'web',port);
      assertRuntimePorts(await inspect('database'),'database',port);assertRuntimePorts(await health(),'backend',port);
      const caFile=join(root!,'ca.crt');const until=Date.now()+20000;
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
     await report.stage('WORKFLOW_ACCEPTANCE',async()=>{
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
     await report.stage('WEB_CLOSURE',async()=>{const before=await stateHash();await script('close-web');await closed();
      const b=await health(),db=await inspect('database');check(b.Id===backendId&&db.State.Running&&db.Mounts.some((m:any)=>m.Name===sourceVolume)&&await stateHash()===before);});
     await report.stage('HISTORY_RECOVERY',()=>recovery('history',true));
    }
   }
  }
 }catch{ /* Stage already records a fixed failure. Stop all subsequent operations. */ }
 finally{
  try{await report.stage('CLEANUP',async()=>{
   if(base.length){
    const resources:{kind:'container'|'volume'|'network';key:string;value:any}[]=[];
    for(const kind of ['container','volume','network']as const){
     const args=kind==='container'?['ps','--all','--format','{{.ID}}']:[kind,'ls','--format',kind==='volume'?'{{.Name}}':'{{.ID}}'];
     const names=(await docker([...args,'--filter','label=com.docker.compose.project='+project])).out.trim().split(/\s+/).filter(Boolean);
     for(const key of names){const value=JSON.parse((await docker([...(kind==='container'?[]:[kind]),'inspect',key])).out)[0];assertOwned(value,kind,project,id);resources.push({kind,key:kind==='volume'?value.Name:value.Id,value});}
    }
    // All project resources must be proven owned before deleting any. Recheck
    // immediately before each exact-ID/name removal; never compose down/prune.
    for(const r of resources){const current=JSON.parse((await docker([...(r.kind==='container'?[]:[r.kind]),'inspect',r.key])).out)[0];assertOwned(current,r.kind,project,id);
     await docker(r.kind==='container'?['rm','--force',r.key]:[r.kind,'rm',r.key]);}
    for(const kind of ['container','volume','network']){
     const args=kind==='container'?['ps','--all','--format','{{.ID}}']:[kind,'ls','--format',kind==='volume'?'{{.Name}}':'{{.ID}}'];check((await docker([...args,'--filter','label=com.docker.compose.project='+project])).out.trim()==='');
    }
    check(initialRestore&&JSON.stringify(await restoreResources())===JSON.stringify(initialRestore));
   }
   if(root){const now=await lstat(root);check(rootIdentity&&now.dev===rootIdentity.dev&&now.ino===rootIdentity.ino&&!now.isSymbolicLink()&&await realpath(root)===root
     &&basename(root).startsWith('demo05d4-')&&await readFile(join(root,'.owner'),'utf8')===id);await rm(root,{recursive:true});}
  });}catch{ /* Cleanup failure is never converted into negative-test success. */ }
 }
 const summary=report.finish();parseSummary(summary,sha);check(assertPrivateDirectory(summaryDirectory)===summaryDirectory);
 const final=join(summaryDirectory,scenario+'.json'),partial=final+'.'+randomBytes(16).toString('hex')+'.partial';
 // Public artifact contains only the strict allowlisted DTO, never command
 // logs, source IDs, backup paths, private reports, credentials or raw rows.
 try{await lstat(final);throw Error('Summary collision');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const file=await open(partial,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);
 try{await file.writeFile(JSON.stringify(summary)+'\n');await file.sync();}finally{await file.close();}
 await rename(partial,final);console.info(JSON.stringify({scenario,result:summary.result,productionDeploymentApproved:false}));
 if(summary.cleanupVerification==='FAIL')console.error('Rehearsal cleanup unconfirmed; inspect fixture ownership privately. No acceptance granted.');
 return summary.result==='PASS'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{check(process.argv.length===6&&process.argv[2]==='--scenario'&&process.argv[4]==='--summary-dir');process.exitCode=await runRehearsal(process.argv[3]as Scenario,process.argv[5]!);}
 catch{console.error('Deployment rehearsal failed; no verified acceptance. Inspect fixed-code summary if present.');process.exitCode=1;}
}
