import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scenarios,stages,check,RehearsalReport,parseSummary,aggregateSummaries,assertRehearsalConfig,assertRuntimePorts,assertOwned,type Scenario,type Summary} from './support/demo-05d4-contract.js';
import {aggregateDirectory} from './demo-05d4-aggregate.js';
import {runRehearsal} from './demo-05d4-rehearsal.js';
const sha='a'.repeat(40),project='demo05d4_'+'a'.repeat(24),owner='rehearsal-'+'a'.repeat(32);
async function passing(scenario:Scenario):Promise<Summary>{
 const r=new RehearsalReport(scenario,'rehearsal-'+String(scenarios.indexOf(scenario)+1).repeat(32),sha);
 const end=scenario==='backend-startup-failure'?'BACKEND_START':scenario==='cutover-precondition-failure'?'CONFIGURATION_CUTOVER':scenario==='restore-verification-failure'?'CUTOVER_PREPARATION':undefined;
 for(const name of stages){if(name==='CLEANUP')continue;if(scenario==='cutover-precondition-failure'&&name==='CUTOVER_PREPARATION')continue;
  await r.stage(name,async()=>{},name===end?scenario==='backend-startup-failure'?'EXPECTED_BACKEND_STARTUP_REJECTION':scenario==='cutover-precondition-failure'?'EXPECTED_CUTOVER_PRECONDITION_REJECTION':'EXPECTED_RESTORE_INTEGRITY_REJECTION':'NONE');if(name===end)break;}
 if(scenario==='happy-path'){r.value.localRecoveryReadiness='READY';r.value.disasterRecoveryReadiness='NOT_VERIFIED';}
 await r.stage('CLEANUP',async()=>{});return r.finish();
}
for(const scenario of scenarios)test('Demo-05D-4 exact stage acceptance: '+scenario,async()=>{const s=await passing(scenario);assert.equal(s.result,'PASS');assert.equal(s.productionDeploymentApproved,false);assert.equal(s.cleanupVerification,'PASS');});
test('Demo-05D-4 fail-stop preserves later NOT_TESTED and rejects normal continuation',async()=>{
 const r=new RehearsalReport('happy-path',owner,sha);await assert.rejects(()=>r.stage('FRESH_INSTALLATION',async()=>{throw Error('password-must-never-be-copied');}));
 let invoked=false;await assert.rejects(()=>r.stage('BACKEND_START',async()=>{invoked=true;}));assert.equal(invoked,false);await r.stage('CLEANUP',async()=>{});
 const s=r.finish();assert.equal(s.result,'FAIL');assert.equal(s.stages[0]!.code,'FRESH_INSTALLATION_FAILED');assert.equal(s.stages[1]!.status,'NOT_TESTED');assert.ok(!JSON.stringify(s).includes('password-must-never-be-copied'));
});
test('Demo-05D-4 cleanup failure cannot become expected rejection success',async()=>{
 const r=new RehearsalReport('cutover-precondition-failure',owner,sha);await r.stage('FRESH_INSTALLATION',async()=>{});await r.stage('CONFIGURATION_CUTOVER',async()=>{},'EXPECTED_CUTOVER_PRECONDITION_REJECTION');
 await assert.rejects(()=>r.stage('CLEANUP',async()=>{throw Error('foreign container');}));assert.equal(r.finish().result,'FAIL');assert.equal(r.value.cleanupVerification,'FAIL');
});
test('Demo-05D-4 unexpected setup failure never counts as expected negative success',async()=>{
 for(const scenario of scenarios.slice(1)){const r=new RehearsalReport(scenario,owner,sha);await assert.rejects(()=>r.stage('FRESH_INSTALLATION',async()=>{throw Error('image transport failed');}));await r.stage('CLEANUP',async()=>{});assert.equal(r.finish().result,'FAIL');}
});
test('Demo-05D-4 summary exact allowlist rejects secrets, approval, future times, missing stages and forged success',async()=>{
 const s=await passing('happy-path');for(const value of [{...s,password:'secret'},{...s,productionDeploymentApproved:true},{...s,serviceRecoveryTested:true},
  {...s,completedAt:'2999-01-01T00:00:00.000Z'},{...s,stages:s.stages.slice(1)},{...s,localRecoveryReadiness:'AT_RISK'},
  {...s,stages:s.stages.map(t=>({...t,...t.name==='CLEANUP'?{status:'FAIL',code:'CLEANUP_FAILED'}:{}}))}])assert.throws(()=>parseSummary(value,sha));
 assert.throws(()=>parseSummary({...s,testedCommitSha:'b'.repeat(40)},sha));
});
test('Demo-05D-4 negative tests cannot skip prerequisites or mark later normal work PASS',async()=>{
 const s=await passing('backend-startup-failure');for(const name of ['CUTOVER_PREPARATION','PRE_WEB_RECOVERY']as const){const v=structuredClone(s),stage=v.stages.find(t=>t.name===name)!;
  stage.status=stage.status==='PASS'?'NOT_TESTED':'PASS';stage.code='NONE';stage.durationMs=0;assert.throws(()=>parseSummary(v,sha));}
});
test('Demo-05D-4 aggregate requires four distinct successful scenarios, exact revision and cleanup',async()=>{
 const all=await Promise.all(scenarios.map(passing));assert.equal(aggregateSummaries(all,sha).result,'PASS');
 for(const input of [all.slice(1),[...all,all[0]],Array(4).fill(all[0]),all.map((v,i)=>i===0?{...v,result:'FAIL'}:v)])assert.throws(()=>aggregateSummaries(input,sha));
});
test('Demo-05D-4 aggregate rejects missing/oversized/extra artifact files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'demo05d4-contract-'));try{
  await assert.rejects(()=>aggregateDirectory(dir,sha));for(const s of scenarios)await writeFile(join(dir,s+'.json'),JSON.stringify(await passing(s)));
  assert.equal((await aggregateDirectory(dir,sha)).result,'PASS');await writeFile(join(dir,'unknown.json'),'{}');await assert.rejects(()=>aggregateDirectory(dir,sha));
 }finally{await rm(dir,{recursive:true,force:true});}
});
const labels={'com.docker.compose.project':project,'cost-engine.rehearsal.owner':owner,'com.docker.compose.service':'backend'};
for(const kind of ['container','volume','network']as const)test('Demo-05D-4 '+kind+' ownership rejects foreign/missing labels before deletion',()=>{
 const v:any=kind==='container'?{Id:'1'.repeat(64),Name:'/'+project+'-backend',Config:{Labels:labels}}:{Id:'1'.repeat(64),Name:project+'_data',Labels:labels};assert.doesNotThrow(()=>assertOwned(v,kind,project,owner));
 for(const change of [{...labels,'cost-engine.rehearsal.owner':'foreign'},{...labels,'com.docker.compose.project':'production'},{}]){
  const bad=structuredClone(v);if(kind==='container')bad.Config.Labels=change;else bad.Labels=change;assert.throws(()=>assertOwned(bad,kind,project,owner));}
});
const binding=(port=15443,ip='127.0.0.1')=>({[port+'/tcp']:[{HostIp:ip,HostPort:String(port)}],[port+'/udp']:[{HostIp:ip,HostPort:String(port)}]});
test('Demo-05D-4 actual TCP and UDP Docker bindings must both be loopback',()=>{
 const good={HostConfig:{PortBindings:binding()},NetworkSettings:{Ports:{...binding(),'80/tcp':null}}};assert.doesNotThrow(()=>assertRuntimePorts(good,'web',15443));
 for(const [side,protocol]of [['HostConfig','tcp'],['NetworkSettings','udp']]){const v:any=structuredClone(good);const ports=side==='HostConfig'?v.HostConfig.PortBindings:v.NetworkSettings.Ports;
  ports['15443/'+protocol][0].HostIp='0.0.0.0';assert.throws(()=>assertRuntimePorts(v,'web',15443));}
 assert.throws(()=>assertRuntimePorts({HostConfig:{PortBindings:binding()},NetworkSettings:{Ports:binding()}},'backend',15443));
 assert.doesNotThrow(()=>assertRuntimePorts({HostConfig:{PortBindings:{}},NetworkSettings:{Ports:{'5432/tcp':null}}},'database',15443));
});
function config(){const owned={labels:{'cost-engine.rehearsal.owner':owner}};return{name:project,services:{backend:{...owned,container_name:project+'-backend',restart:'no',environment:{DEMO_PUBLIC_ORIGIN:'https://localhost:15443'}},
 database:{...owned,image:'postgres:18',volumes:[{type:'volume',source:'postgres_data',target:'/var/lib/postgresql'}]},operator:{...owned},
 web:{...owned,restart:'no',environment:{DEMO_TLS_DIRECTIVE:'tls internal',DEMO_PUBLIC_ORIGIN:'https://localhost:15443'},ports:['tcp','udp'].map(protocol=>({host_ip:'127.0.0.1',protocol,target:15443,published:'15443'}))}},
 networks:Object.fromEntries(['database','proxy','edge'].map(n=>[n,{...owned,name:project+'_'+n,internal:n!=='edge'}])),volumes:{postgres_data:{...owned,name:project+'_postgres_data'}}};}
test('Demo-05D-4 full effective config rejects non-loopback UDP, extra TCP, external volume and production identity',()=>{
 assert.doesNotThrow(()=>assertRehearsalConfig(config(),project,owner,15443));
 for(const change of ['udp','extra','external','identity','db-port','host-network','public-tls','db-bind']){const c:any=structuredClone(config());
  if(change==='udp')c.services.web.ports[1].host_ip='::';if(change==='extra')c.services.web.ports.push({host_ip:'127.0.0.1',protocol:'tcp',target:80,published:80});
  if(change==='external')c.volumes.postgres_data.external=true;if(change==='identity')c.services.backend.container_name='cost-engine-demo-backend';
  if(change==='db-port')c.services.database.ports=[{target:5432,published:5432}];if(change==='host-network')c.services.database.network_mode='host';
  if(change==='public-tls')c.services.web.environment.DEMO_TLS_DIRECTIVE='';if(change==='db-bind')c.services.database.volumes[0].type='bind';assert.throws(()=>assertRehearsalConfig(c,project,owner,15443));}
});
test('Demo-05D-4 integration driver refuses local/non-hosted execution before Docker access',async()=>{
 const prior=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;try{await assert.rejects(()=>runRehearsal('happy-path','/invalid-never-accessed'));}finally{if(prior!==undefined)process.env.GITHUB_ACTIONS=prior;}
});
test('Demo-05D-4 unknown ownership records a fixed cleanup code and blocks aggregate PASS',async()=>{
 const r=new RehearsalReport('happy-path',owner,sha);await r.stage('FRESH_INSTALLATION',async()=>{});
 await assert.rejects(()=>r.stage('CLEANUP',async()=>assertOwned({Labels:{}},'volume',project,owner)));
 const s=r.finish();assert.equal(s.result,'FAIL');assert.equal(s.stages.at(-1)!.code,'CLEANUP_OWNERSHIP_UNCONFIRMED');
});
test('Demo-05D-4 aggregate refuses oversized artifact rather than truncating evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'demo05d4-size-'));try{
  for(const s of scenarios)await writeFile(join(dir,s+'.json'),JSON.stringify(await passing(s)));
  await writeFile(join(dir,'happy-path.json'),' '.repeat(65537));await assert.rejects(()=>aggregateDirectory(dir,sha));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Demo-05D-4 summary rejects arbitrary nested error text and impossible durations',async()=>{
 const s=await passing('happy-path');
 const nested=structuredClone(s);(nested.stages[0]as any).rawError='postgres://secret';assert.throws(()=>parseSummary(nested,sha));
 const duration=structuredClone(s);duration.stages[0]!.durationMs=Number.MAX_SAFE_INTEGER;assert.throws(()=>parseSummary(duration,sha));
});
