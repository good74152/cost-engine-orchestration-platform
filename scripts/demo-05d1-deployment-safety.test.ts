import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';
import {createServer} from 'node:net';
import {setImmediate} from 'node:timers/promises';
import {request} from 'node:https';

interface Result {code:number;out:string;err:string}
async function command(exe:string,args:string[],env=process.env,input?:string):Promise<Result>{
 return new Promise((done,reject)=>{const child=spawn(exe,args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';
  child.stdout.on('data',b=>out+=String(b));child.stderr.on('data',b=>err+=String(b));child.once('error',reject);
  child.stdin.on('error',()=>{});child.stdin.end(input);child.once('close',code=>done({code:code??-1,out,err}));});
}
const posix=(path:string)=>process.platform==='win32'?path.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d:string)=>'/'+d.toLowerCase()):path;
async function port(){const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(r=>server.close(()=>r()));return address.port;}

test('Demo-05D-1 real Docker: staged startup, explicit approval, offline operators and closed failures',{timeout:1200000},async t=>{
 const id='demo05d1_test_'+randomUUID().replaceAll('-','').slice(0,12);assert.match(id,/^demo05d1_test_[a-f0-9]+$/);
 const directory=await mkdtemp(join(tmpdir(),id+'-'));const secrets=join(directory,'secrets');await mkdir(secrets,{mode:0o700});
 const password=randomBytes(24).toString('hex'),proxy=randomBytes(32).toString('hex');const databaseUrl=`postgres://demo_owner:${password}@database:5432/cost_engine_demo`;
 for(const [key,value]of Object.entries({postgres_password:password,proxy_secret:proxy,database_url:databaseUrl}))await writeFile(join(secrets,key),value,{mode:0o644});
 const envFile=join(directory,'compose.env'),override=join(directory,'override.yaml');const httpsPort=await port();
 await writeFile(envFile,`DEPLOYMENT_VERSION=${id}\nCOMPOSE_PROJECT_NAME=${id}\nDEMO_PUBLIC_ORIGIN=https://localhost:${httpsPort}\nACME_EMAIL=test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\','/'))}\n`);
 const overrideText=`services:\n  backend:\n    container_name: ${id}-backend\n  web:\n    environment:\n      DEMO_TLS_DIRECTIVE: tls internal\n    ports: !override\n      - "127.0.0.1:${httpsPort}:${httpsPort}"\n`;
 await writeFile(override,overrideText);
 const base=['compose','--project-name',id,'--env-file',envFile,'-f',resolve('deploy/compose.yaml'),'-f',override];
 const safe=(s:string)=>[password,proxy,databaseUrl].reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),s);
 const docker=async(args:string[],ok=true,input?:string)=>{const r=await command('docker',args,process.env,input);if(ok)assert.equal(r.code,0,safe(r.err.slice(-2500)+r.out.slice(-1000)));return r;};
 const compose=(...args:string[])=>docker([...base,...args]);
 const shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'sh';
 const script=async(name:string,args:string[]=[],extra:NodeJS.ProcessEnv={},ok=true)=>{
  const r=await command(shell,[posix(resolve('deploy/scripts/'+name+'.sh')),...args],{...process.env,COMPOSE_PROJECT_NAME:id,
   DEMO_DEPLOY_ENV:posix(envFile),DEMO_COMPOSE_FILE:posix(resolve('deploy/compose.yaml')),DEMO_COMPOSE_OVERRIDE:posix(override),...extra});
  for(const secret of [password,proxy,databaseUrl])assert.ok(!(r.out+r.err).includes(secret),'Controls must not output credentials');
  if(ok)assert.equal(r.code,0,safe(r.err+r.out));else assert.notEqual(r.code,0,'Unsafe operation unexpectedly succeeded');return r;
 };
 const target=['--database-url-file','/run/secrets/database_url'];const approval=['--confirm-owner-acceptance-05d2-05d3',...target];
 const sql=async(query:string)=>(await compose('exec','-T','database','psql','-U','demo_owner','-d','cost_engine_demo','-At','-v','ON_ERROR_STOP=1','-c',query)).out.trim();
 const ids=async(service:string)=>(await compose('ps','--all','-q',service)).out.trim();
 const inspect=async(service:string)=>{const name=await ids(service);return name?JSON.parse((await docker(['inspect',name])).out)[0]:null;};
 const webClosed=async()=>{const w=await inspect('web');assert.ok(!w||(!w.State.Running&&!w.State.Restarting));if(w)assert.equal(w.HostConfig.RestartPolicy.Name,'no');};
 const stopBackend=()=>compose('stop','backend');
 let initialized=false;
 try{
  const config=JSON.parse((await compose('--profile','operations','--profile','public-web','config','--format','json')).out);
  await t.test('closed-by-default profiles, fixed Backend identity and private network/port security',async()=>{
   assert.deepEqual(config.services.web.profiles,['public-web']);assert.equal(config.services.web.restart,'no');assert.equal(config.services.backend.restart,'no');
   assert.equal(config.services.backend.container_name,id+'-backend');assert.equal(config.services.backend.ports,undefined);assert.equal(config.services.database.ports,undefined);
   assert.equal(config.networks.database.internal,true);assert.equal(config.networks.proxy.internal,true);
   assert.deepEqual((await compose('config','--services')).out.trim().split(/\r?\n/).sort(),['backend','database']);
   for(const violation of ['backend-port','database-host-network','backend-edge','web-auto-restart','backend-replicas']){
    const unsafe=structuredClone(config);
    if(violation==='backend-port')unsafe.services.backend.ports=[{target:3000,published:'3000'}];
    if(violation==='database-host-network')unsafe.services.database.network_mode='host';
    if(violation==='backend-edge')unsafe.services.backend.networks.edge={};
    if(violation==='web-auto-restart')unsafe.services.web.restart='unless-stopped';
    if(violation==='backend-replicas')unsafe.services.backend.deploy={replicas:2};
    const rejected=await command(process.execPath,['deploy/scripts/control-json.cjs','config'],process.env,JSON.stringify(unsafe));assert.notEqual(rejected.code,0,violation);
   }
   // POSIX disables implicit errexit inside a function used by an OR guard.
   // A failed enumeration must never become the valid empty/offline observation.
   const guarded=await command(shell,['-c','. "$(dirname -- "$0")/common.sh"; service_ids() { return 73; }; backend_observation offline || exit 74; exit 0',posix(resolve('deploy/scripts/operate.sh'))],
    {...process.env,COMPOSE_PROJECT_NAME:id,DEMO_DEPLOY_ENV:posix(envFile),DEMO_COMPOSE_FILE:posix(resolve('deploy/compose.yaml')),DEMO_COMPOSE_OVERRIDE:posix(override)});
   assert.notEqual(guarded.code,0,'Failed Backend enumeration must fail closed even inside a conditional');
  });
  await t.test('production images and POSIX deployment scripts build without public operations',async()=>{
   await compose('--profile','operations','--profile','public-web','build','backend','operator','web');
   await docker(['run','--rm','--network','none','--entrypoint','sh','--mount',`type=bind,source=${resolve('deploy/scripts')},target=/scripts,readonly`,`cost-engine-demo-web:${id}`,'-c','for f in /scripts/*.sh; do sh -n "$f" || exit; done']);
  });
  initialized=true;
  await t.test('start on an unmigrated database fails closed, without migration/seed or Web creation',async()=>{
   await script('start',[],{},false);await webClosed();assert.equal(await sql("SELECT count(*) FROM pg_tables WHERE schemaname='public'"),'0');
  });
  await t.test('prepare/deploy stops writers and starts DB only; explicit migrate and six-domain seed',async()=>{
   await script('deploy');await webClosed();const b=await inspect('backend');assert.ok(!b||!b.State.Running);
   await script('operate',['migrate-up']);await script('operate',['seed']);await script('operate',['seed-six-domain']);
   assert.equal(await sql('SELECT count(*) FROM pgmigrations'),'14');assert.equal(await sql('SELECT count(*) FROM calculation_types WHERE is_active'),'9');
   assert.equal(await sql('SELECT state FROM demo_admission_control'),'LEGACY_OPEN');
  });
  await t.test('Backend starts independently with matching ready/version; repeat start preserves its process',async()=>{
   await script('start');await webClosed();const before=await inspect('backend');assert.equal(before.State.Health.Status,'healthy');
   await script('start');const after=await inspect('backend');assert.equal(after.State.StartedAt,before.State.StartedAt);
   assert.equal(after.Config.Env.find((s:string)=>s.startsWith('DEPLOYMENT_VERSION=')),'DEPLOYMENT_VERSION='+id);
   t.diagnostic('STAGED_START '+JSON.stringify({backendId:after.Id,health:after.State.Health.Status,version:id,webRunning:false,sameStartedAt:true}));
  });
  await t.test('modifying operator commands refuse a running Backend; status is read-only and needs explicit target',async()=>{
   const before=await sql('SELECT row_to_json(g) FROM demo_admission_control g');
   for(const op of ['migrate-up','seed','seed-six-domain','admission-drain','cutover'])await script('operate',[op,...(['admission-drain','cutover'].includes(op)?target:[])],{},false);
   for(const op of ['admission-status','admission-drain','cutover-status','cutover'])await script('operate',[op],{},false);
   assert.equal(JSON.parse((await script('operate',['admission-status',...target])).out).state,'LEGACY_OPEN');
   assert.equal(JSON.parse((await script('operate',['cutover-status',...target])).out).configuration,'LEGACY');assert.equal(await sql('SELECT row_to_json(g) FROM demo_admission_control g'),before);
  });
  await t.test('open requires explicit Owner acceptance and refuses LEGACY_OPEN even when Backend is ready',async()=>{
   await script('open-web',[],{},false);await script('open-web',approval,{},false);await webClosed();
  });
  await t.test('DRAINING also refuses Web; cutover remains a separate explicit offline operation',async()=>{
   await stopBackend();await script('operate',['admission-drain',...target]);assert.equal(await sql('SELECT state FROM demo_admission_control'),'DRAINING');
   await script('start');await script('open-web',approval,{},false);await webClosed();
   await stopBackend();await script('operate',['cutover',...target]);assert.equal(await sql('SELECT state FROM demo_admission_control'),'WORKFLOW_OPEN');
   await webClosed();await script('start');await webClosed();
  });
  await t.test('WORKFLOW_OPEN is insufficient when complete Configuration verification conflicts',async()=>{
   // Test-only corruption of this disposable fixture; never repair/override in controls.
   const row=await sql("SELECT airflow_dag_id FROM calculation_types WHERE code='DEMO_CAPEX_TABLE_Y'");
   await sql("UPDATE calculation_types SET airflow_dag_id='invalid_fixture' WHERE code='DEMO_CAPEX_TABLE_Y'");
   try{await script('open-web',approval,{},false);await webClosed();}finally{await sql(`UPDATE calculation_types SET airflow_dag_id='${row}' WHERE code='DEMO_CAPEX_TABLE_Y'`);}
  });
  await t.test('expected Backend Deployment Version mismatch is refused without replacement',async()=>{
   const wrong=join(directory,'wrong.env');await writeFile(wrong,`DEPLOYMENT_VERSION=${id}_wrong\nCOMPOSE_PROJECT_NAME=${id}\nDEMO_PUBLIC_ORIGIN=https://localhost:${httpsPort}\nACME_EMAIL=test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\','/'))}\n`);
   const before=await inspect('backend');await script('open-web',approval,{DEMO_DEPLOY_ENV:posix(wrong)},false);await webClosed();assert.equal((await inspect('backend')).Id,before.Id);
  });
  await t.test('only complete Workflow status plus explicit acceptance opens Web',async()=>{
   const r=await script('open-web',approval);assert.match(r.out,/explicitly opened/);assert.equal((await inspect('web')).State.Running,true);
   assert.equal(JSON.parse((await script('operate',['cutover-status',...target])).out).state,'WORKFLOW_OPEN');
   const caFile=join(directory,'root.crt');const deadline=Date.now()+15000;
   while((await docker(['cp',(await inspect('web')).Id+':/data/caddy/pki/authorities/local/root.crt',caFile],false)).code!==0){assert.ok(Date.now()<deadline);await setImmediate();}
   const ca=await readFile(caFile);const origin=`https://localhost:${httpsPort}`;
   const post=(path:string,body:unknown,cookie?:string)=>new Promise<{status:number;body:string;cookie:string}>((done,reject)=>{
    const payload=JSON.stringify(body);const req=request(origin+path,{ca,family:4,method:'POST',headers:{origin,'content-type':'application/json','x-demo-session':'1','content-length':Buffer.byteLength(payload),...(cookie?{cookie}:{})}},res=>{
     let text='';res.on('data',b=>text+=String(b));res.on('end',()=>done({status:res.statusCode!,body:text,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]??''}));});req.on('error',reject);req.end(payload);
   });
   const session=await post('/demo/sessions',{});assert.equal(session.status,201,session.body);
   const dataset=await post('/demo/dataset-versions',{domain:'FAB_COST',fiscalYear:2026,period:'Q4'},session.cookie);assert.equal(dataset.status,201,dataset.body);
   t.diagnostic('MANUAL_WEB '+JSON.stringify({ownerFlag:true,state:'WORKFLOW_OPEN',configuration:'WORKFLOW',webRunning:true}));
  });
  await t.test('live Web blocks all modifying operators even with Backend stopped',async()=>{
   await stopBackend();for(const op of ['migrate-up','seed','seed-six-domain','admission-drain','cutover'])await script('operate',[op,...(['admission-drain','cutover'].includes(op)?target:[])],{},false);
  });
  await t.test('close is idempotent, preserves DB/data/Gate, and no restart policy can reopen Web',async()=>{
   const before=await sql('SELECT row_to_json(g) FROM demo_admission_control g');const dbId=(await inspect('database')).Id;
   const counts=()=>sql('SELECT jsonb_build_object(\'sessions\',(SELECT count(*) FROM demo_sessions),\'datasets\',(SELECT count(*) FROM dataset_versions),\'jobs\',(SELECT count(*) FROM calculation_jobs))');
   const dataBefore=await counts();assert.equal(JSON.parse(dataBefore).datasets,1);assert.equal(JSON.parse(dataBefore).sessions,1);
   await script('close-web');await script('close-web');await webClosed();assert.equal((await inspect('database')).Id,dbId);assert.equal((await inspect('database')).State.Running,true);
   assert.equal(await sql('SELECT row_to_json(g) FROM demo_admission_control g'),before);
   assert.equal(await counts(),dataBefore);
   assert.equal((await inspect('web')).HostConfig.RestartPolicy.Name,'no');assert.equal((await inspect('backend')).HostConfig.RestartPolicy.Name,'no');
   // Real daemon restart is validated using an independent inner daemon below,
   // never by restarting the user's Docker engine.
  });
  await t.test('Backend readiness failure closes an already-open Web and never starts another Backend',async()=>{
   await script('start');await script('open-web',approval);const b=await inspect('backend');
   await compose('pause','backend');try{await script('start',[],{},false);await webClosed();assert.equal((await inspect('backend')).Id,b.Id);}finally{await compose('unpause','backend');}
  });
  await t.test('database unavailable refuses open; a failed Web startup retains Gate and configuration',async()=>{
   await compose('stop','database');try{await script('open-web',approval,{},false);await webClosed();}finally{await compose('up','-d','--wait','database');}
   const before=await sql('SELECT row_to_json(g) FROM demo_admission_control g');
   await writeFile(override,overrideText+"    entrypoint: [sh, -c, 'exit 1']\n");
   try{await script('open-web',approval,{},false);await webClosed();assert.equal(await sql('SELECT row_to_json(g) FROM demo_admission_control g'),before);}finally{await writeFile(override,overrideText);}
  });
  await t.test('fixed Backend identity rejects a second writer and Compose scaling',async()=>{
   await docker([...base,'up','-d','--scale','backend=2','backend'],false).then(r=>assert.notEqual(r.code,0));
   const other=[...base];other[2]=id+'_other';await docker([...other,'up','-d','--no-deps','backend'],false).then(r=>assert.notEqual(r.code,0));
   await docker([...other,'down','--volumes']);assert.equal((await inspect('backend')).State.Running,true);
  });
  await t.test('strict JSON parsing rejects malformed, incomplete, misleading and UNKNOWN status observations',async()=>{
   const valid={state:'WORKFLOW_OPEN',configuration:'WORKFLOW',updatedAt:new Date().toISOString()};
   for(const body of ['WORKFLOW_OPEN WORKFLOW',JSON.stringify({...valid,state:'DRAINING'}),JSON.stringify({...valid,configuration:'LEGACY'}),
    JSON.stringify({...valid,confirmation:'UNKNOWN'}),JSON.stringify({state:'WORKFLOW_OPEN',configuration:'WORKFLOW'}),'noise\n'+JSON.stringify(valid),JSON.stringify([valid])]){
    const r=await command(process.execPath,['deploy/scripts/control-json.cjs','workflow-status'],process.env,body);assert.notEqual(r.code,0);
   }
   const r=await command(process.execPath,['deploy/scripts/control-json.cjs','workflow-status'],process.env,JSON.stringify(valid));assert.equal(r.code,0);
   const fallback=await docker(['run','--rm','-i','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','node',
    '--mount',`type=bind,source=${resolve('deploy/scripts/control-json.cjs')},target=/control-json.cjs,readonly`,'node:24-bookworm-slim','node','/control-json.cjs','workflow-status'],true,JSON.stringify(valid));
   assert.equal(fallback.out.trim(),'WORKFLOW_CONFIRMED');
  });
  await t.test('real isolated Docker daemon restart cannot auto-activate Web or Backend',async()=>{
   const daemon=id+'_daemon',volume=id+'_daemon_data';await docker(['volume','create',volume]);
   try{
    await docker(['run','-d','--privileged','--name',daemon,'--env','DOCKER_TLS_CERTDIR=','--volume',volume+':/var/lib/docker','docker:28-dind','--storage-driver=vfs']);
    const inner=(...args:string[])=>docker(['exec',daemon,'docker',...args]);
    const wait=async()=>{const deadline=Date.now()+60000;for(;;){const r=await docker(['exec',daemon,'docker','info','--format','{{.ServerVersion}}'],false);if(r.code===0)return;assert.ok(Date.now()<deadline,'Owned daemon did not become ready');await setImmediate();}};
    await wait();await inner('pull','busybox:1.37');
    for(const [name,restart]of [['database','unless-stopped'],['backend','no'],['web','no']])await inner('run','-d','--name',name!,'--restart',restart!,'busybox:1.37','sleep','3600');
    await inner('stop','web');await inner('create','--name','unapproved-web','--restart','no','busybox:1.37','sleep','3600');
    await docker(['restart',daemon]);await wait();
    const observations=JSON.parse((await inner('inspect','database','backend','web','unapproved-web')).out);
    const deadline=Date.now()+15000;while(JSON.parse((await inner('inspect','database')).out)[0].State.Running!==true){assert.ok(Date.now()<deadline);await setImmediate();}
    for(const c of observations.filter((c:{Name:string})=>c.Name!=='/database'))assert.equal(c.State.Running,false,c.Name);
    t.diagnostic('DAEMON_RESTART '+JSON.stringify({isolated:true,databaseResumes:true,backendRunning:false,webRunning:false,unapprovedWebRunning:false,hostDaemonRestarted:false}));
   }finally{await docker(['rm','--force','--volumes',daemon],false);await docker(['volume','rm',volume]);}
  });
  console.info('DEMO05D1_VERIFIED',JSON.stringify({project:id,staged:true,manualWeb:true,offlineOperators:true,migrations:14,production:false}));
 }finally{
  if(initialized){const cfg=JSON.parse((await compose('--profile','operations','--profile','public-web','config','--format','json')).out);assert.equal(cfg.name,id);
   await compose('--profile','operations','--profile','public-web','down','--volumes','--remove-orphans');}
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith(id+'-'));
  await rm(directory,{recursive:true,force:true});console.info('DEMO05D1_TEARDOWN',JSON.stringify({project:id,disposableVolumesRemoved:initialized}));
 }
});
