import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {assertRehearsalConfig,assertRuntimePorts} from './support/demo-05d4-contract.js';
import {runRehearsal,assertExpectedBackendStartupFailure} from './demo-05d4-rehearsal.js';
const project='demo05d4_'+'a'.repeat(24);
const binding=(port=15443,ip='127.0.0.1')=>({[port+'/tcp']:[{HostIp:ip,HostPort:String(port)}],[port+'/udp']:[{HostIp:ip,HostPort:String(port)}]});
test('Rehearsal: actual TCP and UDP Docker bindings must both be loopback',()=>{
 const good={HostConfig:{PortBindings:binding()},NetworkSettings:{Ports:{...binding(),'80/tcp':null}}};assert.doesNotThrow(()=>assertRuntimePorts(good,'web',15443));
 for(const [side,protocol]of [['HostConfig','tcp'],['NetworkSettings','udp']]){const v:any=structuredClone(good);const ports=side==='HostConfig'?v.HostConfig.PortBindings:v.NetworkSettings.Ports;
  ports['15443/'+protocol][0].HostIp='0.0.0.0';assert.throws(()=>assertRuntimePorts(v,'web',15443));}
 assert.throws(()=>assertRuntimePorts({HostConfig:{PortBindings:binding()},NetworkSettings:{Ports:binding()}},'backend',15443));
 assert.doesNotThrow(()=>assertRuntimePorts({HostConfig:{PortBindings:{}},NetworkSettings:{Ports:{'5432/tcp':null}}},'database',15443));
});
function config(){return{name:project,services:{backend:{container_name:project+'-backend',restart:'no',environment:{DEMO_PUBLIC_ORIGIN:'https://localhost:15443'}},
 database:{image:'postgres:18',volumes:[{type:'volume',source:'postgres_data',target:'/var/lib/postgresql'}]},operator:{},
 web:{restart:'no',environment:{DEMO_TLS_DIRECTIVE:'tls internal',DEMO_PUBLIC_ORIGIN:'https://localhost:15443'},ports:['tcp','udp'].map(protocol=>({host_ip:'127.0.0.1',protocol,target:15443,published:'15443'}))}},
 networks:Object.fromEntries(['database','proxy','edge'].map(n=>[n,{name:project+'_'+n,internal:n!=='edge'}])),volumes:{postgres_data:{name:project+'_postgres_data'}}};}
test('Rehearsal: effective config rejects non-loopback UDP, extra TCP, external volume and production identity',()=>{
 assert.doesNotThrow(()=>assertRehearsalConfig(config(),project,15443));
 for(const change of ['udp','extra','external','identity','db-port','host-network','public-tls','db-bind']){const c:any=structuredClone(config());
  if(change==='udp')c.services.web.ports[1].host_ip='::';if(change==='extra')c.services.web.ports.push({host_ip:'127.0.0.1',protocol:'tcp',target:80,published:80});
  if(change==='external')c.volumes.postgres_data.external=true;if(change==='identity')c.services.backend.container_name='cost-engine-demo-backend';
  if(change==='db-port')c.services.database.ports=[{target:5432,published:5432}];if(change==='host-network')c.services.database.network_mode='host';
  if(change==='public-tls')c.services.web.environment.DEMO_TLS_DIRECTIVE='';if(change==='db-bind')c.services.database.volumes[0].type='bind';assert.throws(()=>assertRehearsalConfig(c,project,15443));}
});
test('Rehearsal: effective config accepts exactly the four required services',()=>{
 for(const kind of ['extra','database','backend','web','operator']){
  const c:any=structuredClone(config());
  if(kind==='extra')c.services.worker={};else delete c.services[kind];
  assert.throws(()=>assertRehearsalConfig(c,project,15443));
 }
});
test('Rehearsal: refuses to run outside CI before touching Docker',async()=>{
 const prior=process.env.GITHUB_ACTIONS;delete process.env.GITHUB_ACTIONS;try{await assert.rejects(()=>runRehearsal('happy-path'));}finally{if(prior!==undefined)process.env.GITHUB_ACTIONS=prior;}
});
const backend=()=>({Config:{Env:['DEMO_MAX_EXECUTORS=invalid-fixture']},State:{Status:'exited',Running:false,Restarting:false,Paused:false,
 OOMKilled:false,ExitCode:1,Error:'',Health:{Status:'unhealthy'}},HostConfig:{RestartPolicy:{Name:'no'}}});
const environmentDiagnostic='application_environment_invalid: verify APP_MODE and production Demo configuration';
test('Rehearsal: Backend attribution accepts the injected setting and exact environment diagnostic',()=>{
 assert.doesNotThrow(()=>assertExpectedBackendStartupFailure(backend(),environmentDiagnostic+'\n',null));
});
for(const kind of ['unrelated','conflicting','missing-injection','duplicate-setting','oom','launch-error','wrong-exit'])test('Rehearsal: unrelated Backend startup failure cannot pass: '+kind,()=>{
 const b=backend();let logs=environmentDiagnostic;
 if(kind==='unrelated')logs='application_startup_failed';if(kind==='conflicting')logs+='\napplication_startup_failed';
 if(kind==='missing-injection')b.Config.Env=['DEMO_MAX_EXECUTORS=100'];if(kind==='duplicate-setting')b.Config.Env.push('DEMO_MAX_EXECUTORS=100');
 if(kind==='oom')b.State.OOMKilled=true;if(kind==='launch-error')b.State.Error='fixture container launch failed';if(kind==='wrong-exit')b.State.ExitCode=137;
 assert.throws(()=>assertExpectedBackendStartupFailure(b,logs,null));
});
test('Rehearsal: real Backend entrypoint produces the environment diagnostic without connecting or printing secrets',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'demo05d4-env-'));try{
 const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',APP_MODE:'demo',EXECUTOR_TYPE:'fake',DEMO_PUBLIC_ENABLED:'true',DEMO_PUBLIC_ORIGIN:'https://localhost',
  DEPLOYMENT_VERSION:'review-fixture',DEMO_MAX_EXECUTORS:'invalid-fixture',DATABASE_URL:'postgres://fixture:private-test-password@127.0.0.1:1/never_connected',DEMO_PROXY_SECRET:'f'.repeat(64),
  DOTENV_CONFIG_QUIET:'true',DOTENV_CONFIG_DEBUG:'false',DOTENV_CONFIG_OVERRIDE:'false',DOTENV_CONFIG_PATH:join(directory,'absent.env')};
 delete env.DATABASE_URL_FILE;delete env.DEMO_PROXY_SECRET_FILE;delete env.DOTENV_KEY;
 const r=await new Promise<{code:number|null;logs:string}>((done,reject)=>{
  const p=spawn(process.execPath,['--import','tsx','src/server.ts'],{env,stdio:['ignore','pipe','pipe']});let logs='';
  const timer=setTimeout(()=>{p.kill();reject(Error('Backend fixture deadline exceeded'));},10000);
  const read=(b:Buffer)=>{logs+=b.toString();if(logs.length>65536){p.kill();reject(Error('Backend fixture output limit exceeded'));}};
  p.stdout.on('data',read);p.stderr.on('data',read);p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',code=>{clearTimeout(timer);done({code,logs});});
 });
 assert.equal(r.code,1);assertExpectedBackendStartupFailure(backend(),r.logs,null);
 for(const value of [env.DATABASE_URL!,env.DEMO_PROXY_SECRET!,'private-test-password'])assert.equal(r.logs.includes(value),false,'Startup fixture must not emit secrets');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('Rehearsal: Backend environment rejection cannot pass if Web was created',()=>{
 assert.throws(()=>assertExpectedBackendStartupFailure(backend(),environmentDiagnostic,{State:{Running:false}}));
});
