import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,readdir,stat,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join,dirname,basename } from 'node:path';
import { setImmediate } from 'node:timers/promises';

interface Result {code:number;out:string;err:string}
async function command(exe:string,args:string[],env=process.env,input?:string):Promise<Result>{return new Promise((done,reject)=>{
 const p=spawn(exe,args,{env,stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=String(b));p.stderr.on('data',b=>err+=String(b));
 p.once('error',reject);p.stdin.on('error',()=>{});p.stdin.end(input);p.once('close',code=>done({code:code??-1,out,err}));});}
const posix=(p:string)=>process.platform==='win32'?p.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,d:string)=>'/'+d.toLowerCase()):p;
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('Demo-05D-2 real Docker: offline backup, actual isolated restore and fail-closed artifacts',{timeout:1200000},async t=>{
 const id='demo05d2_test_'+randomUUID().replaceAll('-','').slice(0,12);
 const directory=await mkdtemp(join(tmpdir(),id+'-'));const secrets=join(directory,'secrets'),backups=join(directory,'backups');
 await mkdir(secrets,{mode:0o700});await mkdir(backups,{mode:0o700});
 const password=randomBytes(24).toString('hex'),proxy=randomBytes(32).toString('hex'),url=`postgres://demo_owner:${password}@database:5432/cost_engine_demo`;
 for(const [key,value]of Object.entries({postgres_password:password,proxy_secret:proxy,database_url:url}))await writeFile(join(secrets,key),value,{mode:0o644});
 const envFile=join(directory,'compose.env'),override=join(directory,'override.yaml');
 await writeFile(envFile,`DEPLOYMENT_VERSION=${id}\nCOMPOSE_PROJECT_NAME=${id}\nDEMO_PUBLIC_ORIGIN=https://localhost\nACME_EMAIL=test@example.invalid\nDEMO_SECRETS_DIR=${JSON.stringify(secrets.replaceAll('\\','/'))}\n`);
 await writeFile(override,`services:\n  backend:\n    container_name: ${id}-backend\n  web:\n    environment:\n      DEMO_TLS_DIRECTIVE: tls internal\n    ports: !override []\n`);
 const base=['compose','--project-name',id,'--env-file',envFile,'-f',resolve('deploy/compose.yaml'),'-f',override];
 const safe=(s:string)=>[password,proxy,url].reduce((text,value)=>text.replaceAll(value,'[redacted]'),s);
 const docker=async(args:string[],ok=true)=>{const r=await command('docker',args);if(ok)assert.equal(r.code,0,safe(r.err.slice(-2500)+r.out.slice(-1000)));return r;};
 const compose=(...args:string[])=>docker([...base,...args]);
 const shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'sh';
 const env={...process.env,COMPOSE_PROJECT_NAME:id,DEMO_DEPLOY_ENV:posix(envFile),DEMO_COMPOSE_FILE:posix(resolve('deploy/compose.yaml')),
  DEMO_COMPOSE_OVERRIDE:posix(override),DEMO_BACKUP_DIR:posix(backups)};
 const script=async(name:string,args:string[]=[],ok=true,extra:NodeJS.ProcessEnv={})=>{
  const r=await command(shell,[posix(resolve('deploy/scripts/'+name+'.sh')),...args],{...env,...extra});
  for(const secret of [password,proxy,url])assert.ok(!(r.out+r.err).includes(secret),'Credentials must not be logged');
  if(ok)assert.equal(r.code,0,safe(r.err+r.out));else{assert.notEqual(r.code,0);assert.doesNotMatch(r.out,/RESTORE_VERIFIED|"result":"PASS"/);}return r;
 };
 const target=['--database-url-file','/run/secrets/database_url'];
 const preflight=(ok=true)=>script('operate',['cutover-preflight',...target],ok);
 const backup=(ok=true,extra:NodeJS.ProcessEnv={})=>script('backup',target,ok,extra);
 const sql=async(query:string)=>(await compose('exec','-T','database','psql','-U','demo_owner','-d','cost_engine_demo','-At','-v','ON_ERROR_STOP=1','-c',query)).out.trim();
 const inspect=async(service:string)=>{const value=(await compose('ps','--all','-q',service)).out.trim();return value?JSON.parse((await docker(['inspect',value])).out)[0]:null;};
 const resources=async()=>({containers:(await docker(['ps','--all','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.ID}}'])).out.trim().split(/\r?\n/).filter(Boolean).sort(),
  volumes:(await docker(['volume','ls','--filter','label=cost-engine.restore.purpose=demo05d2','--format','{{.Name}}'])).out.trim().split(/\r?\n/).filter(Boolean).sort()});
 const sourceEvidence=async()=>{
  const database=await inspect('database');
  const volume=database.Mounts.find((m:{Type:string;Destination:string})=>m.Type==='volume'&&m.Destination==='/var/lib/postgresql');
  assert.ok(volume?.Name,'Source must retain its named database volume');
  return {dbId:database.Id,volume:volume.Name,gate:await sql('SELECT row_to_json(g) FROM demo_admission_control g'),
   migrations:await sql('SELECT count(*) FROM pgmigrations'),config:await sql("SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text)) FROM calculation_types t")};
 };
 let first:any;let archive='';let initialized=false;
 try{
  await t.test('production operator images include read-only tools and all POSIX scripts parse',async()=>{
   await compose('--profile','operations','--profile','public-web','build','backend','operator','web');initialized=true;
   await docker(['run','--rm','--network','none','--entrypoint','sh','--mount',`type=bind,source=${resolve('deploy/scripts')},target=/scripts,readonly`,`cost-engine-demo-web:${id}`,'-c','for f in /scripts/*.sh; do sh -n "$f" || exit; done']);
   await compose('up','-d','--no-deps','--wait','database');await script('operate',['migrate-up']);await script('operate',['seed-six-domain']);
  });
  await t.test('explicit target is mandatory; LEGACY_OPEN cannot pass or produce a backup',async()=>{
   await script('operate',['cutover-preflight'],false);await script('backup',[],false);await preflight(false);await backup(false);assert.deepEqual(await readdir(backups),[]);
   await script('operate',['admission-drain',...target]);assert.equal(JSON.parse((await preflight()).out).result,'PASS');
  });
  await t.test('running Backend refuses Preflight and Backup without stopping it',async()=>{
   await script('start');const b=await inspect('backend');await preflight(false);await backup(false);assert.equal((await inspect('backend')).Id,b.Id);assert.equal((await inspect('backend')).State.Running,true);await compose('stop','backend');
  });
  await t.test('stopped Backend with automatic restart enabled is still unsafe',async()=>{
   const b=await inspect('backend');await docker(['update','--restart','always',b.Id]);try{await preflight(false);await backup(false);}finally{await docker(['update','--restart','no',b.Id]);}
  });
  await t.test('running Web refuses Preflight and Backup even while Backend is stopped',async()=>{
   await compose('--profile','public-web','up','-d','--no-deps','web');assert.equal((await inspect('web')).State.Running,true);
   await preflight(false);await backup(false);await script('close-web');
  });
  await t.test('backup rejects repository paths and targets other than the explicit shared Demo file',async()=>{
   await backup(false,{DEMO_BACKUP_DIR:posix(resolve('.'))});await script('backup',['--database-url-file','/run/secrets/other'],false);
   await writeFile(join(secrets,'database_url'),url+'?host=outside.invalid');try{await preflight(false);await backup(false);}finally{await writeFile(join(secrets,'database_url'),url);}
   assert.deepEqual(await readdir(backups),[]);
  });
  await t.test('actual custom-format pg_dump records identity, bytes, SHA-256 and complete immutable evidence',async()=>{
   const before=await sourceEvidence();first=JSON.parse((await backup()).out);archive=join(backups,first.identity,'backup.dump');
   assert.equal(first.result,'BACKUP_CREATED');assert.equal(first.preflight.admissionState,'DRAINING');assert.equal(first.preflight.configuration,'LEGACY');
   const bytes=await readFile(archive);assert.equal(bytes.subarray(0,5).toString(),'PGDMP');assert.equal(digest(bytes),first.sha256);assert.equal(bytes.length,Number(first.sizeBytes));
   assert.equal(first.preflight.migrations.length,14);assert.equal(Object.keys(first.preflight.counts).length,21);
   if(process.platform!=='win32'){assert.equal((await stat(archive)).mode&0o077,0);assert.equal((await stat(dirname(archive))).mode&0o077,0);}
   assert.deepEqual(await sourceEvidence(),before);console.info('BACKUP_CREATED',JSON.stringify({identity:first.identity,sizeBytes:first.sizeBytes,sha256:first.sha256,format:'PGDMP',state:'DRAINING',configuration:'LEGACY'}));
  });
  await t.test('repeated backup creates a separate artifact and never overwrites/deletes an earlier dump',async()=>{
   const next=JSON.parse((await backup()).out);assert.notEqual(next.identity,first.identity);assert.equal(digest(await readFile(archive)),first.sha256);
   assert.equal((await readdir(backups)).length,2);
  });
  await t.test('injected pg_dump failure removes its incomplete artifact while preserving older backups',async()=>{
   const shim=join(directory,'fault-bin');await mkdir(shim);const actual=(await command(shell,['-c','command -v docker'])).out.trim();assert.ok(actual);
   await writeFile(join(shim,'docker'),'#!/bin/sh\ncase " $* " in *" pg_dump "*) exit 47;; esac\nexec "$DEMO_TEST_REAL_DOCKER" "$@"\n',{mode:0o755});
   const before=(await readdir(backups)).sort();const r=await command(shell,['-c','PATH="$1:$PATH"; export PATH; exec sh "$2" --database-url-file /run/secrets/database_url','fault',posix(shim),posix(resolve('deploy/scripts/backup.sh'))],{...env,DEMO_TEST_REAL_DOCKER:actual});
   assert.notEqual(r.code,0);assert.match(r.err,/dump failed/);assert.deepEqual((await readdir(backups)).sort(),before);assert.equal(digest(await readFile(archive)),first.sha256);
  });
  await t.test('restore accepts no caller-selected URL, database, target container or extra arguments',async()=>{
   const before=await resources();for(const args of [[],['--database-url',url],['--backup-file',posix(archive),'--target','production']])await script('verify-backup',args,false);
   assert.deepEqual(await resources(),before);
  });
  const damaged=async(label:string,bytes:Buffer,rehash=false)=>{
   const identity='cost-engine-backup-'+label+'-'+randomBytes(6).toString('hex');const dir=join(backups,identity);await mkdir(dir,{mode:0o700});
   const manifest={...first,identity,...(rehash?{sizeBytes:String(bytes.length),sha256:digest(bytes)}:{})};
   await writeFile(join(dir,'backup.dump'),bytes,{mode:0o600});await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest),{mode:0o600});return join(dir,'backup.dump');
  };
  await t.test('modified and truncated archives fail checksum validation before creating restore resources',async()=>{
   const bytes=await readFile(archive),before=await resources();const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
   for(const file of [await damaged('modified',changed),await damaged('truncated',bytes.subarray(0,256))])await script('verify-backup',['--backup-file',posix(file)],false);
   assert.deepEqual(await resources(),before);
  });
  await t.test('even a rehashed truncated archive must actually restore; failure never claims success and cleans owned resources',async()=>{
   const before=await resources();const file=await damaged('rehashed-truncated',(await readFile(archive)).subarray(0,256),true);
   const r=await script('verify-backup',['--backup-file',posix(file)],false);assert.match(r.err,/Actual PostgreSQL restore failed/);assert.deepEqual(await resources(),before);
  });
  await t.test('real PostgreSQL 18 restore uses proven-owned network-none volume, exact schema/configuration/counts, and cleans them',async()=>{
   const before=await sourceEvidence(),initial=await resources();const pending=script('verify-backup',['--backup-file',posix(archive)],true,{DATABASE_URL:url,DEMO_CUTOVER_DATABASE_URL:url});
   let observed:any;const deadline=Date.now()+60000;
   for(;;){const now=await resources();const created=now.containers.find(c=>!initial.containers.includes(c));if(created){observed=JSON.parse((await docker(['inspect',created])).out)[0];break;}assert.ok(Date.now()<deadline,'Owned restore must be observable');await setImmediate();}
   assert.equal(observed.Config.Image,'postgres:18');assert.equal(observed.HostConfig.NetworkMode,'none');assert.deepEqual(Object.keys(observed.NetworkSettings.Networks),['none']);
   assert.equal(observed.HostConfig.PortBindings&&Object.keys(observed.HostConfig.PortBindings).length||0,0);assert.equal(observed.Mounts.length,1);
   assert.notEqual(observed.Mounts[0].Name,before.volume);assert.equal(observed.Config.Env.some((e:string)=>e.startsWith('POSTGRES_PASSWORD')),false);
   const nonce=observed.Config.Labels['cost-engine.restore.owner'];assert.match(nonce,/^[a-f0-9]{32}$/);
   for(const violation of ['wrong-owner','public-network','production-volume']){
    const unsafe=structuredClone(observed);if(violation==='wrong-owner')unsafe.Config.Labels['cost-engine.restore.owner']='foreign';
    if(violation==='public-network')unsafe.HostConfig.NetworkMode='host';if(violation==='production-volume')unsafe.Mounts[0].Name=before.volume;
    const r=await command(process.execPath,['deploy/scripts/control-json.cjs','restore-container',observed.Id,observed.Mounts[0].Name,nonce],process.env,JSON.stringify([unsafe]));assert.notEqual(r.code,0,violation);
   }
   const r=JSON.parse((await pending).out);assert.equal(r.result,'RESTORE_VERIFIED');assert.equal(r.postgresVersion,'18');assert.equal(r.schemaSha256,first.preflight.schemaSha256);
   assert.equal(r.configurationSha256,first.preflight.configurationSha256);assert.deepEqual(r.counts,first.preflight.counts);assert.equal(r.isolation.network,'none');assert.equal(r.isolation.cleaned,true);
   assert.deepEqual(await resources(),initial);assert.deepEqual(await sourceEvidence(),before);assert.equal((await inspect('web')).State.Running,false);assert.equal((await inspect('backend')).State.Running,false);
   console.info('RESTORE_VERIFIED',JSON.stringify(r));
  });
  await t.test('changed required backup state cannot be replaced by a successful pg_restore exit code',async()=>{
   const file=await damaged('wrong-state',await readFile(archive),true);const manifestPath=join(dirname(file),'manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
   manifest.preflight.schemaSha256='0'.repeat(64);await writeFile(manifestPath,JSON.stringify(manifest));const before=await resources();
   const r=await script('verify-backup',['--backup-file',posix(file)],false);assert.match(r.err,/does not match backup evidence/);assert.deepEqual(await resources(),before);
  });
  await t.test('restore remains independent while source deployment DB is stopped',async()=>{
   const before=(await inspect('database')).Id;await compose('stop','database');try{assert.equal(JSON.parse((await script('verify-backup',['--backup-file',posix(archive)])).out).result,'RESTORE_VERIFIED');}
   finally{await compose('up','-d','--no-deps','--wait','database');}assert.equal((await inspect('database')).Id,before);assert.equal(await sql('SELECT state FROM demo_admission_control'),'DRAINING');
  });
  await t.test('verification never performs Cutover or opens Web, and completed Workflow refuses first-deployment tools',async()=>{
   assert.equal(await sql('SELECT state FROM demo_admission_control'),'DRAINING');assert.equal(await sql('SELECT count(*) FROM calculation_types'),'9');
   assert.equal((await inspect('web')).State.Running,false);await script('operate',['cutover',...target]);await preflight(false);await backup(false);
   assert.equal(await sql('SELECT state FROM demo_admission_control'),'WORKFLOW_OPEN');assert.equal((await inspect('web')).State.Running,false);
  });
 }finally{
  if(initialized){const cfg=JSON.parse((await compose('--profile','operations','--profile','public-web','config','--format','json')).out);assert.equal(cfg.name,id);await compose('--profile','operations','--profile','public-web','down','--volumes','--remove-orphans');}
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith(id+'-'));await rm(directory,{recursive:true,force:true});
  console.info('DEMO05D2_DOCKER_TEARDOWN',JSON.stringify({project:id,removed:true,production:false}));
 }
});
