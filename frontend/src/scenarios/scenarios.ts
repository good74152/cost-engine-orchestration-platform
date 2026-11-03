import {ApiError} from '../api/client';
import type {CreatedDataset,RunResult} from '../api/types';
import {expectThat,type ScenarioDefinition,type ScenarioPlan,type ScenarioStep} from './engine';
import {domainLabel,PUBLISH_ORDER} from './labels';

export const REPOSITORY='https://github.com/good74152/cost-engine-orchestration-platform';
const plural=(n:number,word:string)=>n+' '+word+(n===1?'':'s');
const CAPEX=domainLabel('CAPEX');const FAB=domainLabel('FAB_COST');
const publishInput:ScenarioStep={title:'Publish the input report',run:async api=>{
 const dataset=await api.publish('FAB_COST');
 return {message:FAB+' v'+dataset.version+' is published, so '+CAPEX+' can use it.',focusSeriesId:dataset.datasetSeriesId};
}};

function normalClose():ScenarioPlan{
 const published:CreatedDataset[]=[];
 return {steps:PUBLISH_ORDER.map(domain=>({title:'Publish '+domainLabel(domain),run:async api=>{
  const dataset=await api.publish(domain);published.push(dataset);
  const saved=await api.dataset(dataset.datasetVersionId);
  const inputs=saved.frozenInputs.map(i=>domainLabel(i.domain)+' v'+i.version).join(', ');
  return {message:domainLabel(domain)+' v'+dataset.version+' is published'+(inputs?', using '+inputs:'')+'.',focusSeriesId:dataset.datasetSeriesId};
 }})),summary:async api=>{
  const saved=await Promise.all(published.map(d=>api.dataset(d.datasetVersionId)));
  const jobs=(await Promise.all(published.map(d=>api.jobs(d.datasetVersionId)))).flat();
  return {title:'All six reports published',facts:[
   saved.filter(d=>d.datasetStatus==='PUBLISHED').length+' reports published, in order.',
   jobs.filter(j=>j.jobStatus==='SUCCEEDED').length+' jobs succeeded.',
   saved.filter(d=>d.frozenInputs.length).length+' reports locked the input they needed.',
  ]};
 }};
}

function lostReply():ScenarioPlan{
 let dataset:CreatedDataset;let first:RunResult;let recovered:RunResult;
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);const attemptIds=new Map<string,string>();
 return {steps:[
  publishInput,
  {title:'Create the '+CAPEX+' report',run:async api=>{
   dataset=await api.create('CAPEX');
   return {message:'Version '+dataset.version+' is a draft with '+plural(dataset.calculationJobs.length,'job')+' waiting.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'Start a job and lose the reply',run:async api=>{
   const reply=await api.run(jobIds()[0]!,{dispatch:'ACCEPT_THEN_UNKNOWN',completion:'RUNNING'});first=reply.data;
   expectThat(reply.status===202&&first.attemptStatus==='DISPATCHING','Expected HTTP 202 with an open try, but got HTTP '+reply.status+' with '+first.attemptStatus+'.');
   return {message:'No answer yet (HTTP 202). The job isn’t marked as failed.',
    pause:{title:'The reply never arrived',body:'The job may already be running. Marking it failed and starting again could run it twice, so the system keeps this try open and checks first.',action:'Check the same run'}};
  }},
  {title:'Check the same run',run:async api=>{
   recovered=(await api.run(first.jobId)).data;
   expectThat(recovered.executionAttemptId===first.executionAttemptId,'The check created a different try.');
   expectThat(recovered.airflowDagRunId===first.airflowDagRunId,'The check changed the run ID.');
   attemptIds.set(first.jobId,recovered.executionAttemptId);
   return {message:'The job was already running under this run ID, so nothing started twice.'};
  }},
  {title:'Start the other jobs',run:async api=>{
   for(const id of jobIds().filter(j=>j!==first.jobId)){const {data}=await api.run(id);attemptIds.set(id,data.executionAttemptId);}
   return {message:plural(jobIds().length,'job')+' running on the same input.'};
  }},
  {title:'The jobs finish',run:async api=>{
   for(const id of attemptIds.values())await api.setExecutorState(id,'SUCCEEDED');
   return {message:'The jobs are done, but the database still says running until the system checks.'};
  }},
  {title:'Check the results',run:async api=>{
   for(const id of jobIds())await api.reconcile(id);
   return {message:'The system read each real result and saved it.'};
  }},
  {title:'Approve and publish',run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:'Every job succeeded, so the report was approved and published.'};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(first.jobId);const saved=await api.dataset(dataset.datasetVersionId);
  return {title:'No duplicate run',facts:[
   'This job has '+plural(attempts.length,'try').replace('trys','tries')+'.',
   'The run ID stayed the same: '+first.airflowDagRunId+'.',
   CAPEX+' v'+saved.version+' is '+saved.datasetStatus+'.',
  ],note:'This also needs the job system to honor the run ID. The simulator here does, and a real one must too.'};
 }};
}

function failedJob():ScenarioPlan{
 let dataset:CreatedDataset;let failed='';let newest=0;const current=new Map<string,string>();
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);
 return {steps:[
  publishInput,
  {title:'Start '+CAPEX,run:async api=>{
   dataset=await api.create('CAPEX');
   for(const id of jobIds()){const {data}=await api.run(id);current.set(id,data.executionAttemptId);}
   return {message:'The input is now locked. '+plural(jobIds().length,'job')+' running.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'A job fails',run:async api=>{
   failed=jobIds()[0]!;await api.setExecutorState(current.get(failed)!,'FAILED');await api.reconcile(failed);
   return {message:'The system confirmed the failure. The other job keeps running.'};
  }},
  {title:'A newer input appears',run:async api=>{
   const upstream=await api.publish('FAB_COST');newest=upstream.version;
   return {message:FAB+' v'+upstream.version+' is out. This report keeps the input it locked, so its jobs can’t end up on different data.'};
  }},
  {title:'Retry the failed job',run:async api=>{
   const {data}=await api.run(failed);
   expectThat(data.executionAttemptId!==current.get(failed),'The retry reused the failed try.');
   current.set(failed,data.executionAttemptId);
   return {message:'The retry is a new try with a new run ID. The failed try stays on record.'};
  }},
  {title:'Finish every job',run:async api=>{
   for(const id of current.values())await api.setExecutorState(id,'SUCCEEDED');
   for(const id of jobIds())await api.reconcile(id);
   return {message:'All jobs succeeded, and each result was checked.'};
  }},
  {title:'Approve and publish',run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:'The report was published on the input it locked at the start.'};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(failed);const saved=await api.dataset(dataset.datasetVersionId);
  const inputs=saved.frozenInputs.map(i=>domainLabel(i.domain)+' v'+i.version).join(', ');
  return {title:'Retried, with the failure on record',facts:[
   'The failed job: '+attempts.map(a=>'try '+a.attemptNumber+' '+a.attemptStatus).join(', ')+'.',
   'Input used: '+inputs+'. The newest is v'+newest+'.',
   CAPEX+' v'+saved.version+' is '+saved.datasetStatus+'.',
  ]};
 }};
}

function conflictingRequests():ScenarioPlan{
 let results:{created:number;conflicts:number;other:string[]};let dataset:CreatedDataset;let blocked=0;
 const isConflict=(e:unknown)=>e instanceof ApiError&&e.code==='ACTIVE_DATASET_VERSION_EXISTS';
 return {steps:[
  {title:'Send 4 Create requests at once',run:async api=>{
   const replies=await Promise.allSettled(Array.from({length:4},()=>api.createDataset('CAPEX')));
   const winners=replies.flatMap(r=>r.status==='fulfilled'?[r.value.data]:[]);
   const errors=replies.flatMap(r=>r.status==='rejected'?[r.reason as unknown]:[]);
   results={created:winners.length,conflicts:errors.filter(isConflict).length,other:errors.filter(e=>!isConflict(e)).map(e=>e instanceof ApiError?e.code:'REQUEST_FAILED')};
   expectThat(winners.length===1,'Expected one new report, but got '+winners.length+'.'+(results.other.length?' Other replies: '+results.other.join(', ')+'.':''));
   dataset=winners[0]!;
   return {message:results.created+' created the report. '+results.conflicts+' got HTTP 409. One version exists.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'Start a job before its input is ready',run:async api=>{
   const jobId=dataset.calculationJobs[0]!.jobId;
   try{await api.run(jobId);}
   catch(error){
    if(!(error instanceof ApiError&&error.code==='DEPENDENCY_NOT_READY'))throw error;
    blocked=(await api.attempts(jobId)).length;
    return {message:'Blocked with HTTP 409 because '+FAB+' isn’t published. Tries created: '+blocked+'.'};
   }
   expectThat(false,'The job started even though '+FAB+' isn’t published.');
  }},
  {title:'Publish the input and start again',run:async api=>{
   const upstream=await api.publish('FAB_COST');
   for(const {jobId} of dataset.calculationJobs)await api.run(jobId);
   return {message:FAB+' v'+upstream.version+' is published, so the jobs can start and lock it as their input.',focusSeriesId:dataset.datasetSeriesId};
  }},
 ],summary:async()=>({title:'One winner, and the order held',facts:[
  '4 requests at once: '+results.created+' created, '+results.conflicts+' rejected with HTTP 409.',
  'Starting too early created '+blocked+' tries.',
 ],note:'A browser can’t prove the requests overlapped. A PostgreSQL test with 20 concurrent requests does.',
  link:{label:'See the test',href:REPOSITORY+'/blob/main/scripts/dataset-version-creation-v2.pg.test.ts'}})};
}

export const scenarios:ScenarioDefinition[]=[
 {id:'normal-close',title:'Normal close',description:'Six reports run in order. Each one waits for the reports it needs.',build:normalClose},
 {id:'lost-reply',title:'Lost reply',description:'A job starts, but the reply never arrives. The system checks instead of starting it twice.',build:lostReply},
 {id:'failed-job',title:'Failed job and retry',description:'A job fails. The retry uses the same input and keeps a record of the failure.',build:failedJob},
 {id:'conflicting-requests',title:'Conflicting requests',description:'Four people click Create at once. Only one succeeds.',build:conflictingRequests},
];

/** Each run uses a reporting period this session hasn't touched, so scenarios can be replayed. */
export function nextReportingPeriod(used:{fiscalYear:number;period:string}[],startYear=2026):{fiscalYear:number;period:string}{
 const taken=new Set(used.map(d=>d.fiscalYear+'/'+d.period));
 for(let year=startYear;;year++)for(const period of ['Q1','Q2','Q3','Q4'])if(!taken.has(year+'/'+period))return {fiscalYear:year,period};
}
