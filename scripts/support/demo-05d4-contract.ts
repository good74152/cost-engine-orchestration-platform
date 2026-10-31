import { DrillClock, isoTime } from '../../src/deployment/drill-report.js';

export const scenarios = ['happy-path','backend-startup-failure','cutover-precondition-failure','restore-verification-failure'] as const;
export type Scenario = typeof scenarios[number];
export const stages = ['FRESH_INSTALLATION','CUTOVER_PREPARATION','CONFIGURATION_CUTOVER','BACKEND_START','PRE_WEB_RECOVERY',
  'WEB_ACCEPTANCE','WORKFLOW_ACCEPTANCE','WEB_CLOSURE','HISTORY_RECOVERY','CLEANUP'] as const;
export type Stage = typeof stages[number];
const expected = { 'happy-path': null,'backend-startup-failure':['BACKEND_START','EXPECTED_BACKEND_STARTUP_REJECTION'],
  'cutover-precondition-failure':['CONFIGURATION_CUTOVER','EXPECTED_CUTOVER_PRECONDITION_REJECTION'],
  'restore-verification-failure':['CUTOVER_PREPARATION','EXPECTED_RESTORE_INTEGRITY_REJECTION'] } as const;
const codes = ['NONE','EXPECTED_BACKEND_STARTUP_REJECTION','EXPECTED_CUTOVER_PRECONDITION_REJECTION','EXPECTED_RESTORE_INTEGRITY_REJECTION',
  'CLEANUP_OWNERSHIP_UNCONFIRMED',...stages.map(s=>s+'_FAILED')] as const;
export type Code = typeof codes[number];
export class OwnershipUnconfirmed extends Error{constructor(){super('Rehearsal resource ownership unconfirmed');}}
export function check(v:unknown): asserts v { if(!v)throw Error('Rehearsal assertion failed'); }
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
const readyStates=['READY','AT_RISK','NOT_VERIFIED','NOT_TESTED'];
export interface Summary {
  formatVersion:1; result:'PASS'|'FAIL'; rehearsalId:string; testedCommitSha:string; scenario:Scenario; startedAt:string; completedAt:string;
  stages:Array<{name:Stage;status:'PASS'|'FAIL'|'NOT_TESTED';code:string;durationMs:number}>;
  cleanupVerification:'PASS'|'FAIL'; localRecoveryReadiness:string; disasterRecoveryReadiness:string;
  productionDeploymentApproved:false; serviceRecoveryTested:false; fakeExecutorMemoryRestored:false;
}
function required(s:Scenario):readonly Stage[]{
  if(s==='happy-path')return stages;
  if(s==='cutover-precondition-failure')return ['FRESH_INSTALLATION','CONFIGURATION_CUTOVER','CLEANUP'];
  if(s==='restore-verification-failure')return ['FRESH_INSTALLATION','CUTOVER_PREPARATION','CLEANUP'];
  return ['FRESH_INSTALLATION','CUTOVER_PREPARATION','CONFIGURATION_CUTOVER','BACKEND_START','CLEANUP'];
}
export function parseSummary(v:unknown,sha:string):Summary {
  check(exact(v,['formatVersion','result','rehearsalId','testedCommitSha','scenario','startedAt','completedAt','stages','cleanupVerification',
    'localRecoveryReadiness','disasterRecoveryReadiness','productionDeploymentApproved','serviceRecoveryTested','fakeExecutorMemoryRestored']));
  check(v.formatVersion===1&&['PASS','FAIL'].includes(v.result as string)&&typeof v.rehearsalId==='string'&&/^rehearsal-[a-f0-9]{32}$/.test(v.rehearsalId)
    && /^[a-f0-9]{40}$/.test(sha)&&v.testedCommitSha===sha&&scenarios.includes(v.scenario as Scenario)
    && v.productionDeploymentApproved===false&&v.serviceRecoveryTested===false&&v.fakeExecutorMemoryRestored===false);
  check(isoTime(v.startedAt)<=isoTime(v.completedAt)&&isoTime(v.completedAt)<=Date.now());
  check(Array.isArray(v.stages)&&v.stages.length===stages.length);
  for(const [i,s]of v.stages.entries())check(exact(s,['name','status','code','durationMs'])&&s.name===stages[i]
    &&['PASS','FAIL','NOT_TESTED'].includes(s.status as string)&&codes.includes(s.code as Code)&&typeof s.durationMs==='number'&&Number.isFinite(s.durationMs)&&s.durationMs>=0
    &&(s.status!=='NOT_TESTED'||(s.code==='NONE'&&s.durationMs===0)));
  check(['PASS','FAIL'].includes(v.cleanupVerification as string)&&readyStates.includes(v.localRecoveryReadiness as string)&&readyStates.includes(v.disasterRecoveryReadiness as string));
  const r=v as unknown as Summary, cleanup=r.stages.at(-1)!;
  check(r.stages.reduce((n,s)=>n+s.durationMs,0)<=isoTime(r.completedAt)-isoTime(r.startedAt)+1000);
  check(cleanup.status===r.cleanupVerification);
  if(r.result==='PASS'){
    const needed=required(r.scenario), rejection=expected[r.scenario];
    for(const s of r.stages){check(s.status===(needed.includes(s.name)?'PASS':'NOT_TESTED'));
      check(s.code===(rejection&&s.name===rejection[0]?rejection[1]:'NONE'));}
    check(r.cleanupVerification==='PASS');
    check(r.localRecoveryReadiness===(r.scenario==='happy-path'?'READY':'NOT_TESTED'));
    check(r.disasterRecoveryReadiness===(r.scenario==='happy-path'?'NOT_VERIFIED':'NOT_TESTED'));
  }
  return r;
}
export class RehearsalReport {
  readonly value:Summary; private clock=new DrillClock(); private failed=false;
  constructor(scenario:Scenario,id:string,sha:string){this.value={formatVersion:1,result:'FAIL',rehearsalId:id,testedCommitSha:sha,scenario,
    startedAt:this.clock.sample().at,completedAt:'',stages:stages.map(name=>({name,status:'NOT_TESTED',code:'NONE',durationMs:0})),
    cleanupVerification:'FAIL',localRecoveryReadiness:'NOT_TESTED',disasterRecoveryReadiness:'NOT_TESTED',
    productionDeploymentApproved:false,serviceRecoveryTested:false,fakeExecutorMemoryRestored:false};}
  async stage(name:Stage,action:()=>Promise<void>,code:string='NONE'){
    check(!this.failed||name==='CLEANUP');
    const s=this.value.stages.find(s=>s.name===name)!;check(s.status==='NOT_TESTED');const start=process.hrtime.bigint();
    try{await action();s.status='PASS';s.code=code;}catch(e){s.status='FAIL';s.code=name==='CLEANUP'&&e instanceof OwnershipUnconfirmed?'CLEANUP_OWNERSHIP_UNCONFIRMED':name+'_FAILED';this.failed=true;throw e;}
    finally{s.durationMs=Number(process.hrtime.bigint()-start)/1e6;}
  }
  finish(){
    try{this.value.completedAt=this.clock.sample().at;}catch{this.failed=true;this.value.completedAt=new Date().toISOString();}
    this.value.cleanupVerification=this.value.stages.at(-1)!.status==='PASS'?'PASS':'FAIL';
    if(!this.failed){this.value.result='PASS';try{parseSummary(this.value,this.value.testedCommitSha);}catch{this.value.result='FAIL';}}
    return parseSummary(this.value,this.value.testedCommitSha);
  }
}
export function aggregateSummaries(inputs:unknown[],sha:string){
  check(inputs.length===4);const parsed=inputs.map(v=>parseSummary(v,sha));
  check(new Set(parsed.map(r=>r.scenario)).size===4&&new Set(parsed.map(r=>r.rehearsalId)).size===4);
  check(parsed.every(r=>r.result==='PASS'&&r.cleanupVerification==='PASS'));
  return {formatVersion:1,result:'PASS',testedCommitSha:sha,scenarios:scenarios.map(s=>({scenario:s,result:'PASS'})),productionDeploymentApproved:false};
}

/** Validate the complete effective model, not YAML strings. Existing production
 * config checks run too; these additional assertions belong only to CI. */
export function assertRehearsalConfig(c:any,project:string,owner:string,port:number){
  check(/^demo05d4_[a-f0-9]{24}$/.test(project)&&/^rehearsal-[a-f0-9]{32}$/.test(owner)&&c.name===project);
  check(c.services.backend.container_name===project+'-backend'&&c.services.backend.restart==='no'&&c.services.web.restart==='no');
  check(!c.services.backend.ports?.length&&!c.services.database.ports?.length&&!c.services.operator.ports?.length);
  for(const s of Object.values(c.services)as any[]){check(!s.network_mode&&!s.privileged&&s.labels['cost-engine.rehearsal.owner']===owner);}
  check(c.services.database.image==='postgres:18'&&c.networks.database.internal===true&&c.networks.proxy.internal===true);
  check(c.services.web.environment.DEMO_TLS_DIRECTIVE==='tls internal'&&c.services.web.environment.DEMO_PUBLIC_ORIGIN==='https://localhost:'+port
    &&c.services.backend.environment.DEMO_PUBLIC_ORIGIN==='https://localhost:'+port);
  check(c.services.database.volumes.length===1&&c.services.database.volumes[0].type==='volume'
    &&c.services.database.volumes[0].source==='postgres_data'&&c.services.database.volumes[0].target==='/var/lib/postgresql');
  const ports=c.services.web.ports;check(Array.isArray(ports)&&ports.length===2);
  for(const protocol of ['tcp','udp'])check(ports.some((p:any)=>p.host_ip==='127.0.0.1'&&p.protocol===protocol&&p.target===port&&Number(p.published)===port));
  for(const [name,v]of Object.entries({...c.volumes,...c.networks})as [string,any][]){
    check(!v.external&&v.name===project+'_'+name&&v.labels['cost-engine.rehearsal.owner']===owner);
  }
}
export function assertRuntimePorts(c:any,service:string,port:number){
  const bindings=c.HostConfig.PortBindings??{}, actual=c.NetworkSettings.Ports??{};
  if(service!=='web'){check(Object.keys(bindings).length===0&&Object.values(actual).every(v=>v===null));return;}
  for(const ports of [bindings,actual]){
    const active=Object.entries(ports).filter(([,v])=>v!==null);check(active.length===2);
    for(const protocol of ['tcp','udp']){
      const list=ports[port+'/'+protocol];check(Array.isArray(list)&&list.length===1&&list[0].HostIp==='127.0.0.1'&&list[0].HostPort===String(port));
    }
  }
}
export function assertOwned(resource:any,kind:'container'|'volume'|'network',project:string,owner:string){
  try{
  check(/^demo05d4_[a-f0-9]{24}$/.test(project)&&/^rehearsal-[a-f0-9]{32}$/.test(owner));
  const labels=kind==='container'?resource.Config?.Labels:resource.Labels;
  check(labels?.['com.docker.compose.project']===project&&labels?.['cost-engine.rehearsal.owner']===owner);
  if(kind==='container')check(/^[a-f0-9]{64}$/.test(resource.Id)&&resource.Name.startsWith('/'+project)
    &&['backend','database','web','operator'].includes(labels['com.docker.compose.service']));
  else check(resource.Name.startsWith(project+'_')&&(kind!=='network'||/^[a-f0-9]{64}$/.test(resource.Id)));
  }catch{throw new OwnershipUnconfirmed();}
}
