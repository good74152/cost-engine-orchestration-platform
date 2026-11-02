import {ApiError} from '../api/client';
import type {CreatedDataset,RunResult} from '../api/types';
import {expectThat,type ScenarioDefinition,type ScenarioPlan,type ScenarioStep} from './engine';

export const REPOSITORY='https://github.com/good74152/cost-engine-orchestration-platform';
const plural=(n:number,word:string)=>n+' '+word+(n===1?'':'s');
const publishUpstream:ScenarioStep={title:'Publish the upstream dataset',run:async api=>{
 const dataset=await api.publish('FAB_COST');
 return {message:'FAB_COST version '+dataset.version+' is published, so CAPEX has an input to read.',focusSeriesId:dataset.datasetSeriesId};
}};

function lostResponse():ScenarioPlan{
 let dataset:CreatedDataset;let first:RunResult;let recovered:RunResult;
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);const attemptIds=new Map<string,string>();
 return {steps:[
  publishUpstream,
  {title:'Create the CAPEX dataset',run:async api=>{
   dataset=await api.create('CAPEX');
   return {message:'CAPEX version '+dataset.version+' is a draft with '+plural(dataset.calculationJobs.length,'pending job')+'.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'Run a job and lose the reply',run:async api=>{
   const reply=await api.run(jobIds()[0]!,{dispatch:'ACCEPT_THEN_UNKNOWN',completion:'RUNNING'});first=reply.data;
   expectThat(reply.status===202&&first.attemptStatus==='DISPATCHING','Expected HTTP 202 with an open attempt, but got HTTP '+reply.status+' with '+first.attemptStatus+'.');
   return {message:'HTTP 202. Attempt '+first.attemptNumber+' stays open, and the job isn’t marked as failed.',
    pause:{title:'The reply was lost',body:'The executor may already be running this job, but the backend can’t tell. Marking it failed and starting again could run the same work twice, so the backend keeps attempt '+first.attemptNumber+' open.',action:'Recover the original run'}};
  }},
  {title:'Recover the same run',run:async api=>{
   recovered=(await api.run(first.jobId)).data;
   expectThat(recovered.executionAttemptId===first.executionAttemptId,'Recovery created a different attempt.');
   expectThat(recovered.airflowDagRunId===first.airflowDagRunId,'Recovery changed the run ID.');
   attemptIds.set(first.jobId,recovered.executionAttemptId);
   return {message:'The executor already had this run ID, so it confirmed the run instead of starting another. Same attempt, no duplicate.'};
  }},
  {title:'Run the remaining jobs',run:async api=>{
   const rest=jobIds().filter(id=>id!==first.jobId);
   for(const id of rest){const {data}=await api.run(id);attemptIds.set(id,data.executionAttemptId);}
   return {message:plural(jobIds().length,'job')+' now running on the same frozen inputs.'};
  }},
  {title:'Let the executor finish',run:async api=>{
   for(const id of attemptIds.values())await api.setExecutorState(id,'SUCCEEDED');
   return {message:'The executor reports success, but PostgreSQL still shows the jobs running. It only changes once the backend checks.'};
  }},
  {title:'Check the results with the executor',run:async api=>{
   for(const id of jobIds())await api.reconcile(id);
   return {message:'The backend read the executor’s real status and saved each job and attempt together.'};
  }},
  {title:'Validate and publish',run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:'Every job succeeded, so CAPEX passed validation and was published as a separate, explicit step.'};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(first.jobId);const saved=await api.dataset(dataset.datasetVersionId);
  return {title:'Recovered with no duplicate run',facts:[
   'The affected job has '+plural(attempts.length,'attempt')+'.',
   'Its run ID didn’t change: '+first.airflowDagRunId+'.',
   'CAPEX version '+saved.version+' is '+saved.datasetStatus+'.',
  ],note:'Avoiding a duplicate also needs the executor to enforce the run ID. The simulated executor here does; a real one would have to.'};
 }};
}

function failureRetry():ScenarioPlan{
 let dataset:CreatedDataset;let failedJob='';let newestUpstream=0;const current=new Map<string,string>();
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);
 return {steps:[
  publishUpstream,
  {title:'Create CAPEX and run its jobs',run:async api=>{
   dataset=await api.create('CAPEX');
   for(const id of jobIds()){const {data}=await api.run(id);current.set(id,data.executionAttemptId);}
   return {message:'The first run froze the inputs for the whole dataset. '+plural(jobIds().length,'job')+' now running.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'One job fails',run:async api=>{
   failedJob=jobIds()[0]!;await api.setExecutorState(current.get(failedJob)!,'FAILED');await api.reconcile(failedJob);
   return {message:'The backend confirmed the failure with the executor. The other job isn’t affected.'};
  }},
  {title:'Upstream publishes a newer version',run:async api=>{
   const upstream=await api.publish('FAB_COST');newestUpstream=upstream.version;
   return {message:'FAB_COST version '+upstream.version+' is out. CAPEX keeps the version it froze, so its jobs can’t end up on different inputs.'};
  }},
  {title:'Retry the failed job',run:async api=>{
   const {data}=await api.run(failedJob);
   expectThat(data.executionAttemptId!==current.get(failedJob),'The retry reused the failed attempt.');
   current.set(failedJob,data.executionAttemptId);
   return {message:'The retry is a new attempt with a new run ID. The failed attempt stays in the history.'};
  }},
  {title:'Finish every job',run:async api=>{
   for(const id of current.values())await api.setExecutorState(id,'SUCCEEDED');
   for(const id of jobIds())await api.reconcile(id);
   return {message:'All jobs succeeded and the results were checked with the executor.'};
  }},
  {title:'Validate and publish',run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:'CAPEX was published on the inputs it froze at the first run.'};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(failedJob);const saved=await api.dataset(dataset.datasetVersionId);
  const inputs=saved.frozenInputs.map(i=>i.domain+' version '+i.version).join(', ');
  return {title:'Retried without rewriting history',facts:[
   'Failed job history: '+attempts.map(a=>'attempt '+a.attemptNumber+' '+a.attemptStatus).join(', ')+'.',
   'Frozen input: '+inputs+'. The newest FAB_COST is version '+newestUpstream+'.',
   'CAPEX version '+saved.version+' is '+saved.datasetStatus+'.',
  ]};
 }};
}

function conflictingRequests():ScenarioPlan{
 let results:{created:number;conflicts:number;other:string[]};let dataset:CreatedDataset;let blockedAttempts=0;
 return {steps:[
  {title:'Send 4 create requests at once',run:async api=>{
   const replies=await Promise.allSettled(Array.from({length:4},()=>api.createDataset('CAPEX')));
   const winners=replies.flatMap(r=>r.status==='fulfilled'?[r.value.data]:[]);
   const errors=replies.flatMap(r=>r.status==='rejected'?[r.reason as unknown]:[]);
   const conflicts=errors.filter(e=>e instanceof ApiError&&e.code==='ACTIVE_DATASET_VERSION_EXISTS').length;
   results={created:winners.length,conflicts,other:errors.filter(e=>!(e instanceof ApiError&&e.code==='ACTIVE_DATASET_VERSION_EXISTS')).map(e=>e instanceof ApiError?e.code:'REQUEST_FAILED')};
   expectThat(winners.length===1,'Expected one created dataset, but got '+winners.length+'.'+(results.other.length?' Other replies: '+results.other.join(', ')+'.':''));
   dataset=winners[0]!;
   return {message:plural(results.created,'request')+' created the dataset. '+plural(results.conflicts,'request')+' got HTTP 409. One version exists.',focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:'Run a job before its input exists',run:async api=>{
   const jobId=dataset.calculationJobs[0]!.jobId;
   try{await api.run(jobId);}
   catch(error){
    if(!(error instanceof ApiError&&error.code==='DEPENDENCY_NOT_READY'))throw error;
    blockedAttempts=(await api.attempts(jobId)).length;
    return {message:'Blocked with HTTP 409 because FAB_COST isn’t published. Nothing was frozen, and '+plural(blockedAttempts,'attempt')+' exist.'};
   }
   expectThat(false,'The job ran even though FAB_COST isn’t published.');
  }},
  {title:'Publish the input and run again',run:async api=>{
   const upstream=await api.publish('FAB_COST');
   for(const {jobId} of dataset.calculationJobs)await api.run(jobId);
   return {message:'FAB_COST version '+upstream.version+' is published, so the CAPEX jobs can run and freeze it as their input.',focusSeriesId:dataset.datasetSeriesId};
  }},
 ],summary:async()=>({title:'One winner, and order enforced',facts:[
  '4 requests at once: '+results.created+' created, '+results.conflicts+' rejected with HTTP 409.',
  'Running before FAB_COST was published left '+plural(blockedAttempts,'attempt')+' behind.',
 ],note:'Clicks in a browser can’t prove that requests overlapped. The proof is a PostgreSQL test that sends 20 concurrent creates.',
  link:{label:'Read the concurrency test',href:REPOSITORY+'/blob/main/scripts/dataset-version-creation-v2.pg.test.ts'}})};
}

export const scenarios:ScenarioDefinition[]=[
 {id:'lost-response',title:'Lost response',description:'A job starts, but the reply never comes back. Can it recover without running twice?',build:lostResponse},
 {id:'failure-retry',title:'Failed job and retry',description:'A job fails while a newer input is published. Does the retry stay on the same data?',build:failureRetry},
 {id:'conflicting-requests',title:'Conflicting requests',description:'Four people click Create at once, and a job runs too early. Who wins?',build:conflictingRequests},
];

/** Each run uses a reporting period this session hasn't touched, so scenarios can be replayed. */
export function nextReportingPeriod(used:{fiscalYear:number;period:string}[],startYear=2026):{fiscalYear:number;period:string}{
 const taken=new Set(used.map(d=>d.fiscalYear+'/'+d.period));
 for(let year=startYear;;year++)for(const period of ['Q1','Q2','Q3','Q4'])if(!taken.has(year+'/'+period))return {fiscalYear:year,period};
}
