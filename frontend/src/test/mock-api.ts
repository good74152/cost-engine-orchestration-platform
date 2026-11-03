import type {Attempt,Dataset,FrozenInput,Job,RunResult,Session} from '../api/types';

export const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
export const fail=(code:string,status:number)=>json({code,message:'Safe backend message'},status);
const uuid=(n:number)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const TIME='2026-11-02T01:00:00.000Z';
const JOBS:Record<string,string[]>={FAB_COST:['DEMO_FAB_COST_SUMMARY'],CAPEX:['DEMO_CAPEX_TABLE_Y','DEMO_GUIDED_SUMMARY'],DPR:['DEMO_DPR_TABLE_X','DEMO_DPR_TABLE_Y'],
 INSURANCE:['DEMO_INSURANCE_SUMMARY'],ONE_STD_COST:['DEMO_ONE_STD_COST_TABLE_X','DEMO_ONE_STD_COST_TABLE_Y'],E2E_COST:['DEMO_E2E_COST_TABLE_X','DEMO_E2E_COST_TABLE_Y']};
const NEEDS:Record<string,string>={CAPEX:'FAB_COST',DPR:'CAPEX',INSURANCE:'FAB_COST',ONE_STD_COST:'FAB_COST',E2E_COST:'ONE_STD_COST'};
const TEMPLATE={steps:Object.keys(JOBS).flatMap(domain=>{const need=NEEDS[domain];return [
 {id:domain+'.create',domain,operation:'CREATE_DATASET',prerequisites:need?[need+'.publish']:[]},{id:domain+'.publish',domain,operation:'PUBLISH_DATASET',prerequisites:[domain+'.create']}];})};

/** In-memory stand-in for the Demo API. Real behavior is proven by the PostgreSQL and browser tests. */
export class MockApi {
 session:Session|null=null;admissionState='WORKFLOW_OPEN';
 datasets:Dataset[]=[];jobs:Job[]=[];attempts:(Attempt&{jobId:string;runId:string;external:string})[]=[];
 calls:{method:string;path:string;body:unknown}[]=[];
 override:((method:string,path:string)=>Response|undefined)|null=null;
 private next=1;private inFlight=0;
 private id(){return uuid(this.next++);}
 posts(){return this.calls.filter(c=>c.method==='POST');}
 fetch:typeof fetch=async(input,init)=>{
  const url=new URL(String(input),'http://local');const method=init?.method??'GET';const path=url.pathname;
  const body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:undefined;this.calls.push({method,path,body});
  // Same limit as the backend's session gate: a fifth overlapping request gets 429.
  if(++this.inFlight>4){this.inFlight--;return fail('DEMO_SESSION_QUEUE_FULL',429);}
  await new Promise(done=>setTimeout(done,0));this.inFlight--;
  const forced=this.override?.(method,path);if(forced)return forced;
  if(path==='/demo/sessions'&&method==='POST'){this.session={sessionId:uuid(9000),companyCode:'DEMO_1',expiresAt:'2099-01-01T00:00:00.000Z',status:'ACTIVE'};return json(this.session,201);}
  if(!this.session)return fail('DEMO_SESSION_UNAVAILABLE',401);
  if(path==='/demo/sessions/current')return json(this.session);
  if(path==='/demo/sessions/reset'){this.session=null;this.datasets=[];this.jobs=[];this.attempts=[];return new Response(null,{status:204});}
  if(path==='/demo/workflow-templates')return json({admissionState:this.admissionState,templates:[]});
  if(path==='/demo/workflow-templates/SIX_DOMAIN_WORKFLOW')return json(TEMPLATE);
  const page=(items:unknown[])=>json({items,nextCursor:null});
  let m:RegExpExecArray|null;
  if(path==='/demo/dataset-versions'&&method==='GET')return page(this.datasets);
  if(path==='/demo/dataset-versions')return this.create(body as {domain:string;fiscalYear:number;period:string});
  if((m=/^\/demo\/dataset-versions\/([^/]+)$/.exec(path)))return json(this.datasets.find(d=>d.datasetVersionId===m![1]));
  if((m=/^\/demo\/dataset-versions\/([^/]+)\/calculation-jobs$/.exec(path)))return page(this.jobs.filter(j=>j.datasetVersionId===m![1]));
  if((m=/^\/demo\/dataset-versions\/([^/]+)\/(submit-validation|publish)$/.exec(path))){const d=this.datasets.find(x=>x.datasetVersionId===m![1])!;d.datasetStatus=m[2]==='publish'?'PUBLISHED':'VALIDATING';return json(d);}
  if((m=/^\/demo\/calculation-jobs\/([^/]+)\/execution-attempts$/.exec(path)))return page(this.attempts.filter(a=>a.jobId===m![1]));
  if((m=/^\/demo\/calculation-jobs\/([^/]+)\/run$/.exec(path)))return this.run(m[1]!,body as {simulation:{dispatch:string;completion:string}});
  if((m=/^\/demo\/calculation-jobs\/([^/]+)\/reconcile$/.exec(path)))return this.reconcile(m[1]!);
  if((m=/^\/demo\/execution-attempts\/([^/]+)\/fake-state$/.exec(path))){this.attempts.find(a=>a.executionAttemptId===m![1])!.external=String(body?.state);return json({});}
  return fail('REQUEST_FAILED',500);
 };
 private create({domain,fiscalYear,period}:{domain:string;fiscalYear:number;period:string}){
  const same=this.datasets.filter(d=>d.domain===domain&&d.fiscalYear===fiscalYear&&d.period===period);
  if(same.some(d=>!['PUBLISHED','REJECTED','ABANDONED'].includes(d.datasetStatus)))return fail('ACTIVE_DATASET_VERSION_EXISTS',409);
  const d:Dataset={datasetVersionId:this.id(),datasetSeriesId:same[0]?.datasetSeriesId??this.id(),domain,fiscalYear,period,version:same.length+1,datasetStatus:'DRAFT',createdAt:new Date(Date.parse(TIME)+this.next*1000).toISOString(),frozenInputs:[]};
  this.datasets.push(d);const calculationJobs=(JOBS[domain]??[]).map(code=>{const j:Job={jobId:this.id(),datasetVersionId:d.datasetVersionId,calculationTypeCode:code,jobStatus:'PENDING',createdAt:TIME,startedAt:null,finishedAt:null};this.jobs.push(j);return {jobId:j.jobId};});
  return json({...d,calculationJobs},201);
 }
 private run(jobId:string,{simulation}:{simulation:{dispatch:string;completion:string}}){
  const job=this.jobs.find(j=>j.jobId===jobId)!;const d=this.datasets.find(x=>x.datasetVersionId===job.datasetVersionId)!;
  const need=NEEDS[d.domain];
  if(need&&!d.frozenInputs.length){
   const upstream=this.datasets.filter(x=>x.domain===need&&x.fiscalYear===d.fiscalYear&&x.period===d.period&&x.datasetStatus==='PUBLISHED').at(-1);
   if(!upstream)return fail('DEPENDENCY_NOT_READY',409);
   const frozen:FrozenInput={domain:need,fiscalYear:d.fiscalYear,period:d.period,version:upstream.version};d.frozenInputs=[frozen];
  }
  d.datasetStatus='BUILDING';
  let attempt=this.attempts.filter(a=>a.jobId===jobId).at(-1);
  if(!attempt||attempt.attemptStatus==='FAILED'){
   const number=(attempt?.attemptNumber??0)+1;const executionAttemptId=this.id();
   attempt={jobId,executionAttemptId,attemptNumber:number,attemptStatus:'DISPATCHING',createdAt:TIME,dispatchStartedAt:TIME,acceptedAt:null,finishedAt:null,runId:'cost-engine-'+executionAttemptId,external:simulation.completion};
   this.attempts.push(attempt);
  }
  const lost=simulation.dispatch==='ACCEPT_THEN_UNKNOWN';
  if(!lost){attempt.attemptStatus='ACCEPTED';attempt.acceptedAt=TIME;job.jobStatus='RUNNING';job.startedAt=TIME;}
  const result:RunResult={jobId,jobStatus:job.jobStatus,executionAttemptId:attempt.executionAttemptId,attemptNumber:attempt.attemptNumber,attemptStatus:attempt.attemptStatus,airflowDagRunId:attempt.runId};
  return json(result,lost?202:200);
 }
 private reconcile(jobId:string){
  const job=this.jobs.find(j=>j.jobId===jobId)!;const attempt=this.attempts.filter(a=>a.jobId===jobId).at(-1)!;
  if(attempt.external==='SUCCEEDED'||attempt.external==='FAILED'){attempt.attemptStatus=attempt.external;job.jobStatus=attempt.external;attempt.finishedAt=TIME;job.finishedAt=TIME;}
  return json({jobId,jobStatus:job.jobStatus});
 }
}
