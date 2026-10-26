import type {Session,Scenario,ScenarioType,DatasetDetail,Job,Attempt,StepReply,Pending} from '../api/types';
export const id=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const time='2026-10-27T01:00:00.000Z';
export const session:Session={sessionId:id(1),companyCode:'DEMO_000000000000001',expiresAt:'2099-10-27T05:00:00.000Z',status:'ACTIVE'};
export const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
export const fail=(code:string,status:number)=>json({code,message:'Safe backend message'},status);
export const dataset=(n=10):DatasetDetail=>({datasetVersionId:id(n),datasetSeriesId:id(n+100),domain:'CAPEX',fiscalYear:2026,period:'Q4',version:1,datasetStatus:'DRAFT',createdAt:time,
 buildingStartedAt:null,validatingAt:null,publishedAt:null,rejectedAt:null,abandonedAt:null});
export class MockApi {
 active=true;scenario:Scenario|null=null;pending:Pending|null=null;datasets:DatasetDetail[]=[];jobs:Record<string,Job[]>={};attempts:Record<string,Attempt[]>={};
 manualUsed=false;fake:'SUCCEEDED'|'FAILED'='SUCCEEDED';resetFailure:string|null=null;
 readonly calls:{path:string;method:string;body:Record<string,unknown>|undefined;init:RequestInit|undefined}[]=[];
 onNext:((body:Record<string,unknown>)=>Promise<Response>|Response)|null=null;
 onCall:((path:string,body:Record<string,unknown>|undefined)=>Promise<Response|undefined>|Response|undefined)|null=null;
 setScenario(type:ScenarioType,completedStep=0){
  this.scenario={scenarioId:id(2),scenarioType:type,status:completedStep===0?'READY':completedStep===(type==='FAILURE_RETRY'?9:6)?'COMPLETED':'IN_PROGRESS',completedStep,createdAt:time,updatedAt:time};this.applyState();
 }
 applyState(){
  const sc=this.scenario;if(!sc||!sc.completedStep){this.datasets=[];this.jobs={};this.attempts={};return;}
  const n=sc.completedStep;const retry=sc.scenarioType==='FAILURE_RETRY';const total=retry?9:6;
  const d=dataset();d.datasetStatus=n===1?'DRAFT':n===total?'PUBLISHED':n===total-1?'VALIDATING':'BUILDING';d.buildingStartedAt=n>=2?time:null;d.publishedAt=n===total?time:null;
  const status=n===1?'PENDING':retry&&n===4?'FAILED':n>=(retry?7:4)?'SUCCEEDED':'RUNNING';
  const job:Job={jobId:id(20),datasetVersionId:d.datasetVersionId,calculationTypeCode:'DEMO_GUIDED_SUMMARY',jobStatus:status,createdAt:time,startedAt:n>=2?time:null,finishedAt:['FAILED','SUCCEEDED'].includes(status)?time:null};
  this.datasets=[d];this.jobs={[d.datasetVersionId]:[job]};this.attempts={[job.jobId]:[]};
  if(n>=2)this.attempts[job.jobId]!.push({executionAttemptId:id(30),attemptNumber:1,attemptStatus:retry&&n>=4?'FAILED':n>=4?'SUCCEEDED':'ACCEPTED',createdAt:time,dispatchStartedAt:time,acceptedAt:time,finishedAt:n>=4?time:null});
  if(retry&&n>=5)this.attempts[job.jobId]!.push({executionAttemptId:id(31),attemptNumber:2,attemptStatus:n>=7?'SUCCEEDED':'ACCEPTED',createdAt:time,dispatchStartedAt:time,acceptedAt:time,finishedAt:n>=7?time:null});
 }
 reply(step:number,requestId:string,status:'PENDING'|'COMPLETED'):StepReply {
  const d=this.datasets[0]!;const j=this.jobs[d.datasetVersionId]![0]!;const a=this.attempts[j.jobId]?.at(-1);
  return {scenarioId:this.scenario!.scenarioId,stepNumber:step,requestId,stepStatus:status,completedStep:this.scenario!.completedStep,scenarioStatus:this.scenario!.status,
   stepResult:{datasetVersionId:d.datasetVersionId,jobId:j.jobId,datasetStatus:d.datasetStatus,jobStatus:j.jobStatus,
    ...(a?{executionAttemptId:a.executionAttemptId,attemptNumber:a.attemptNumber,attemptStatus:a.attemptStatus,datasetBuildSnapshotId:id(40),resolvedDependencyDefinitionVersionId:id(50)}:{}),
    ...([3,6].includes(step)&&this.scenario!.scenarioType==='FAILURE_RETRY'?{externalStatus:step===3?'FAILED' as const:'SUCCEEDED' as const}:step===3?{externalStatus:'SUCCEEDED' as const}:{})}};
 }
 performNext(body:Record<string,unknown>):Response {
  const sc=this.scenario!;const step=Number(body.expectedStep);const request=String(body.requestId);
  if(step!==sc.completedStep+1)return fail('DEMO_SCENARIO_STEP_CONFLICT',409);
  if(this.pending&&this.pending.requestId!==request)return fail('DEMO_SCENARIO_STEP_CONFLICT',409);
  if(sc.scenarioType==='LOST_RESPONSE_RECOVERY'&&step===2&&!this.pending){
   this.pending={stepNumber:2,requestId:request};this.applyState();const d=this.datasets[0]!;d.datasetStatus='BUILDING';
   const j=this.jobs[d.datasetVersionId]![0]!;this.attempts[j.jobId]=[{executionAttemptId:id(30),attemptNumber:1,attemptStatus:'DISPATCHING',createdAt:time,dispatchStartedAt:time,acceptedAt:null,finishedAt:null}];
   return json(this.reply(step,request,'PENDING'),202);
  }
  this.pending=null;sc.completedStep=step;sc.status=step===(sc.scenarioType==='FAILURE_RETRY'?9:6)?'COMPLETED':'IN_PROGRESS';this.applyState();
  return json(this.reply(step,request,'COMPLETED'));
 }
 fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input),'http://demo.test');const path=url.pathname;const method=init?.method??'GET';
  const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;this.calls.push({path,method,body,init});
  const override=await this.onCall?.(path,body);if(override)return override;
  if(path==='/demo/sessions'&&method==='POST'){this.active=true;return json(session,201);}
  if(!this.active)return fail('DEMO_SESSION_UNAVAILABLE',401);
  if(path==='/demo/sessions/current')return json(session);
  if(path==='/demo/sessions/reset'){
   if(this.resetFailure)return fail(this.resetFailure,this.resetFailure==='DEMO_RESET_FAILED'?500:503);
   this.active=false;this.scenario=null;this.pending=null;this.datasets=[];this.jobs={};this.attempts={};return new Response(null,{status:204});
  }
  if(path==='/demo/scenarios'&&method==='POST'){
   if(this.scenario){if(this.scenario.scenarioType!==body!.scenarioType)return fail('DEMO_SCENARIO_TYPE_CONFLICT',409);return json(this.scenario);}
   if(this.manualUsed||this.datasets.length)return fail('DEMO_SCENARIO_SESSION_NOT_EMPTY',409);
   this.setScenario(body!.scenarioType as ScenarioType);return json(this.scenario,201);
  }
  if(path==='/demo/scenarios/current'||path==='/demo/scenarios/'+id(2))return this.scenario?json(this.scenario):fail('DEMO_RESOURCE_UNAVAILABLE',404);
  if(path.endsWith('/pending-step'))return json({pendingStep:this.pending});
  if(path.endsWith('/next'))return this.onNext?this.onNext(body!):this.performNext(body!);
  if(path==='/demo/dataset-versions'&&method==='POST'){
   if(body!.domain!=='CAPEX')return fail('CALCULATION_TYPE_NOT_CONFIGURED',409);
   this.setScenario('HAPPY_PATH',1);this.scenario=null;this.manualUsed=true;return json({datasetVersionId:id(10)},201);
  }
  if(path==='/demo/dataset-versions')return json({items:this.datasets,nextCursor:null});
  const d=this.datasets.find(d=>path==='/demo/dataset-versions/'+d.datasetVersionId);if(d)return json(d);
  if(path.endsWith('/calculation-jobs'))return json({items:this.jobs[path.split('/')[3]!]??[],nextCursor:null});
  if(path.endsWith('/execution-attempts'))return json({items:this.attempts[path.split('/')[3]!]??[],nextCursor:null});
  if(method==='GET'&&path.startsWith('/demo/calculation-jobs/')){
   const j=Object.values(this.jobs).flat().find(j=>j.jobId===path.split('/')[3]);return j?json({...j,datasetStatus:this.datasets[0]!.datasetStatus}):fail('DEMO_RESOURCE_UNAVAILABLE',404);
  }
  if(path.endsWith('/dispatch-behavior')){this.manualUsed=true;return json({behavior:body!.behavior});}
  if(this.scenario&&method==='POST')return fail('DEMO_SCENARIO_MODE_CONFLICT',409);
  const job=Object.values(this.jobs).flat()[0];const version=this.datasets[0];
  if(path.endsWith('/run')&&job&&version){
   version.datasetStatus='BUILDING';job.jobStatus='RUNNING';
   this.attempts[job.jobId]=[{executionAttemptId:id(30),attemptNumber:1,attemptStatus:'ACCEPTED',createdAt:time,dispatchStartedAt:time,acceptedAt:time,finishedAt:null}];return json({jobId:job.jobId});
  }
  if(path.endsWith('/fake-state')){this.fake=body!.state as 'SUCCEEDED'|'FAILED';return json({state:this.fake,executionAttemptId:id(30)});}
  if(path.endsWith('/reconcile')&&job){job.jobStatus=this.fake;this.attempts[job.jobId]![0]!.attemptStatus=this.fake;return json({jobId:job.jobId});}
  if(version&&path.endsWith('/submit-validation')){version.datasetStatus='VALIDATING';return json({});}
  if(version&&path.endsWith('/publish')){version.datasetStatus='PUBLISHED';return json({});}
  return fail('DEMO_RESOURCE_UNAVAILABLE',404);
 };
 get posts(){return this.calls.filter(c=>c.method==='POST');}
}
