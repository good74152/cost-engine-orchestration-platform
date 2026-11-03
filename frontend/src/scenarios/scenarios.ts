import {ApiError} from '../api/client';
import type {CreatedDataset,Dataset,Job,RunResult} from '../api/types';
import type {Messages} from '../i18n/messages';
import {expectThat,type ScenarioDefinition,type ScenarioPlan,type ScenarioStep} from './engine';
import {domainLabel,PUBLISH_ORDER} from './labels';

export const REPOSITORY='https://github.com/good74152/cost-engine-orchestration-platform';
const publishInput=(t:Messages['flow']):ScenarioStep=>({title:t.publishInput,run:async api=>{
 const dataset=await api.publish('FAB_COST');
 return {message:t.inputPublished,focusSeriesId:dataset.datasetSeriesId};
}});

function happyPath({flow:t}:Messages):ScenarioPlan{
 const published:CreatedDataset[]=[];
 return {steps:PUBLISH_ORDER.map(domain=>({title:t.publish(domainLabel(domain)),run:async api=>{
  const dataset=await api.publish(domain);published.push(dataset);
  const saved=await api.dataset(dataset.datasetVersionId);
  const inputs=saved.frozenInputs.map(i=>domainLabel(i.domain)+' v'+i.version).join(', ');
  return {message:t.published(domainLabel(domain),dataset.version,inputs),focusSeriesId:dataset.datasetSeriesId};
 }})),summary:async api=>{
  // One at a time: the session gate rejects a fifth overlapping request.
  const saved:Dataset[]=[];const jobs:Job[]=[];
  for(const {datasetVersionId} of published){saved.push(await api.dataset(datasetVersionId));jobs.push(...await api.jobs(datasetVersionId));}
  return {title:t.happyTitle,facts:[
   t.happyPublished(saved.filter(d=>d.datasetStatus==='PUBLISHED').length),
   t.happyJobs(jobs.filter(j=>j.jobStatus==='SUCCEEDED').length),
   t.happyLocked(saved.filter(d=>d.frozenInputs.length).length),
  ]};
 }};
}

function lostResponse({flow:t}:Messages):ScenarioPlan{
 let dataset:CreatedDataset;let first:RunResult;let recovered:RunResult;
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);const attemptIds=new Map<string,string>();
 return {steps:[
  publishInput(t),
  {title:t.createReport,run:async api=>{
   dataset=await api.create('CAPEX');
   return {message:t.draft(dataset.version,dataset.calculationJobs.length),focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:t.loseReply,run:async api=>{
   const reply=await api.run(jobIds()[0]!,{dispatch:'ACCEPT_THEN_UNKNOWN',completion:'RUNNING'});first=reply.data;
   expectThat(reply.status===202&&first.attemptStatus==='DISPATCHING',t.expected202(reply.status,first.attemptStatus));
   return {message:t.noAnswer,pause:{title:t.pauseTitle,body:t.pauseBody,action:t.checkRun}};
  }},
  {title:t.checkRun,run:async api=>{
   recovered=(await api.run(first.jobId)).data;
   expectThat(recovered.executionAttemptId===first.executionAttemptId,t.differentTry);
   expectThat(recovered.airflowDagRunId===first.airflowDagRunId,t.changedRun);
   attemptIds.set(first.jobId,recovered.executionAttemptId);
   return {message:t.alreadyRunning};
  }},
  {title:t.startOthers,run:async api=>{
   for(const id of jobIds().filter(j=>j!==first.jobId)){const {data}=await api.run(id);attemptIds.set(id,data.executionAttemptId);}
   return {message:t.runningSame(jobIds().length)};
  }},
  {title:t.jobsFinish,run:async api=>{
   for(const id of attemptIds.values())await api.setExecutorState(id,'SUCCEEDED');
   return {message:t.stillRunning};
  }},
  {title:t.checkResults,run:async api=>{
   for(const id of jobIds())await api.reconcile(id);
   return {message:t.resultsSaved};
  }},
  {title:t.approve,run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:t.approved};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(first.jobId);const saved=await api.dataset(dataset.datasetVersionId);
  return {title:t.noDuplicate,facts:[t.triesCount(attempts.length),t.runSame(first.airflowDagRunId),t.reportStatus(saved.version,saved.datasetStatus)],note:t.honorRunId};
 }};
}

function failureRecovery({flow:t}:Messages):ScenarioPlan{
 let dataset:CreatedDataset;let failed='';let newest=0;const current=new Map<string,string>();
 const jobIds=()=>dataset.calculationJobs.map(j=>j.jobId);
 return {steps:[
  publishInput(t),
  {title:t.startJobs,run:async api=>{
   dataset=await api.create('CAPEX');
   for(const id of jobIds()){const {data}=await api.run(id);current.set(id,data.executionAttemptId);}
   return {message:t.inputLocked(jobIds().length),focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:t.jobFails,run:async api=>{
   failed=jobIds()[0]!;await api.setExecutorState(current.get(failed)!,'FAILED');await api.reconcile(failed);
   return {message:t.failureConfirmed};
  }},
  {title:t.newerInput,run:async api=>{
   const upstream=await api.publish('FAB_COST');newest=upstream.version;
   return {message:t.newerInputBody(upstream.version)};
  }},
  {title:t.retry,run:async api=>{
   const {data}=await api.run(failed);
   expectThat(data.executionAttemptId!==current.get(failed),t.reusedTry);
   current.set(failed,data.executionAttemptId);
   return {message:t.retried};
  }},
  {title:t.finishAll,run:async api=>{
   for(const id of current.values())await api.setExecutorState(id,'SUCCEEDED');
   for(const id of jobIds())await api.reconcile(id);
   return {message:t.allSucceeded};
  }},
  {title:t.approve,run:async api=>{
   await api.validateAndPublish(dataset.datasetVersionId);
   return {message:t.publishedOnLocked};
  }},
 ],summary:async api=>{
  const attempts=await api.attempts(failed);const saved=await api.dataset(dataset.datasetVersionId);
  return {title:t.retriedTitle,facts:[
   t.failedHistory(attempts.map(a=>t.tryStatus(a.attemptNumber,a.attemptStatus)).join(', ')),
   t.inputUsed(saved.frozenInputs.map(i=>String(i.version)).join(', '),newest),
   t.reportStatus(saved.version,saved.datasetStatus),
  ]};
 }};
}

function conflictingRequests({flow:t}:Messages):ScenarioPlan{
 let results:{created:number;conflicts:number;other:string[]};let dataset:CreatedDataset;let blocked=0;
 const isConflict=(e:unknown)=>e instanceof ApiError&&e.code==='ACTIVE_DATASET_VERSION_EXISTS';
 return {steps:[
  {title:t.sendFour,run:async api=>{
   const replies=await Promise.allSettled(Array.from({length:4},()=>api.createDataset('CAPEX')));
   const winners=replies.flatMap(r=>r.status==='fulfilled'?[r.value.data]:[]);
   const errors=replies.flatMap(r=>r.status==='rejected'?[r.reason as unknown]:[]);
   results={created:winners.length,conflicts:errors.filter(isConflict).length,other:errors.filter(e=>!isConflict(e)).map(e=>e instanceof ApiError?e.code:'REQUEST_FAILED')};
   expectThat(winners.length===1,t.expectedOne(winners.length,results.other.join(', ')));
   dataset=winners[0]!;
   return {message:t.oneCreated(results.created,results.conflicts),focusSeriesId:dataset.datasetSeriesId};
  }},
  {title:t.startEarly,run:async api=>{
   const jobId=dataset.calculationJobs[0]!.jobId;
   try{await api.run(jobId);}
   catch(error){
    if(!(error instanceof ApiError&&error.code==='DEPENDENCY_NOT_READY'))throw error;
    blocked=(await api.attempts(jobId)).length;
    return {message:t.blocked(blocked)};
   }
   expectThat(false,t.startedAnyway);
  }},
  {title:t.publishThenStart,run:async api=>{
   await api.publish('FAB_COST');
   for(const {jobId} of dataset.calculationJobs)await api.run(jobId);
   return {message:t.nowStarted,focusSeriesId:dataset.datasetSeriesId};
  }},
 ],summary:async()=>({title:t.winnerTitle,facts:[t.winnerFact(results.created,results.conflicts),t.earlyFact(blocked)],note:t.browserNote,
  link:{label:t.seeTest,href:REPOSITORY+'/blob/main/scripts/dataset-version-creation-v2.pg.test.ts'}})};
}

export const scenarios:ScenarioDefinition[]=[
 {id:'happy-path',title:'Happy path',build:happyPath},
 {id:'lost-response',title:'Lost response',build:lostResponse},
 {id:'failure-recovery',title:'Failure recovery',build:failureRecovery},
 {id:'conflicting-requests',title:'Conflicting requests',build:conflictingRequests},
];

/** Each run uses a reporting period this session hasn't touched, so scenarios can be replayed. */
export function nextReportingPeriod(used:{fiscalYear:number;period:string}[],startYear=2026):{fiscalYear:number;period:string}{
 const taken=new Set(used.map(d=>d.fiscalYear+'/'+d.period));
 for(let year=startYear;;year++)for(const period of ['Q1','Q2','Q3','Q4'])if(!taken.has(year+'/'+period))return {fiscalYear:year,period};
}
