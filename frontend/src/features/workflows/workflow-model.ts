import {ApiError} from '../../api/client';
import type {WorkflowCatalog,WorkflowTemplate,WorkflowStep,Dataset,Job,Attempt} from '../../api/types';

export function verifyCatalog(value:WorkflowCatalog):WorkflowCatalog{
 if(!value||!['LEGACY_OPEN','DRAINING','WORKFLOW_OPEN'].includes(value.admissionState)||!Array.isArray(value.templates)||!value.templates.length)
  throw new ApiError(0,'DEMO_ADMISSION_UNAVAILABLE');
 const ids=new Set<string>();
 for(const t of value.templates){
  if(!t||typeof t.id!=='string'||!t.id||ids.has(t.id)||t.version!==2||typeof t.title!=='string'||!t.title||typeof t.description!=='string'||!t.description||
   t.availability!==(value.admissionState==='WORKFLOW_OPEN'?'AVAILABLE':'PREVIEW'))throw new ApiError(0,'DEMO_ADMISSION_UNAVAILABLE');
  ids.add(t.id);
 }return value;
}
export function verifyTemplate(t:WorkflowTemplate,catalog:WorkflowCatalog):WorkflowTemplate{
 const summary=catalog.templates.find(s=>s.id===t?.id);
 if(!summary||t.version!==summary.version||t.availability!==summary.availability||!Array.isArray(t.steps)||!t.steps.length)throw new ApiError(0,'INVALID_RESPONSE');
 const steps=new Map(t.steps.map(s=>[s.id,s]));const visiting=new Set<string>();const done=new Set<string>();
 const visit=(id:string)=>{const s=steps.get(id);if(!s||visiting.has(id))throw new ApiError(0,'INVALID_RESPONSE');if(done.has(id))return;
  if(typeof s.id!=='string'||!s.id||typeof s.title!=='string'||!s.title||typeof s.description!=='string'||!s.description||typeof s.expectedResult!=='string'||!s.expectedResult||typeof s.domain!=='string'||!s.domain||!Array.isArray(s.prerequisites)||
   !['CREATE_DATASET','RUN_JOB','SET_FAKE_STATE','RECONCILE_JOB','SUBMIT_VALIDATION','PUBLISH_DATASET'].includes(s.operation))throw new ApiError(0,'INVALID_RESPONSE');
  visiting.add(id);s.prerequisites.forEach(visit);visiting.delete(id);done.add(id);};
 if(steps.size!==t.steps.length)throw new ApiError(0,'INVALID_RESPONSE');t.steps.forEach(s=>visit(s.id));return t;
}

/** Present current verifiable observations, never a saved per-step completion ledger.
 * In particular SET_FAKE_STATE and the tutorial's selected retry/recovery history
 * cannot be inferred to have permanently completed from a generic operation. */
export function stepEvidence(step:WorkflowStep,d:Dataset|undefined,jobs:Job[],attempts:Record<string,Attempt[]>):string{
 if(!d)return 'Choose a Dataset version to inspect durable evidence.';
 const latest=jobs.map(j=>attempts[j.jobId]?.at(-1));
 switch(step.operation){
  case 'CREATE_DATASET':return `Selected Dataset version ${d.version} exists (${d.datasetStatus}).`;
  case 'RUN_JOB':return latest.some(a=>a?.attemptStatus==='DISPATCHING')?'Outcome unknown: DISPATCHING is not failure. Explicitly recover the original Job.':
   `${latest.filter(a=>a&&['ACCEPTED','SUCCEEDED','FAILED'].includes(a.attemptStatus)).length} / ${jobs.length} Jobs have confirmed execution attempts. Review each history for retry or recovery.`;
  case 'SET_FAKE_STATE':return 'Fake state is not durable progress. Reconcile to verify PostgreSQL Job and Attempt results.';
  case 'RECONCILE_JOB':return `${jobs.filter(j=>j.jobStatus==='SUCCEEDED').length} / ${jobs.length} Jobs are durably SUCCEEDED; ${jobs.filter(j=>j.jobStatus==='FAILED').length} FAILED. Failure permits explicit Retry.`;
  case 'SUBMIT_VALIDATION':return ['VALIDATING','PUBLISHED'].includes(d.datasetStatus)?`Validation observed in Dataset status ${d.datasetStatus}.`:'Validation requires every required Job to succeed; Backend verifies readiness.';
  case 'PUBLISH_DATASET':return d.datasetStatus==='PUBLISHED'?'Published: confirmed by Dataset PUBLISHED state.':'Not published. Job success alone does not publish a Dataset.';
 }
}
