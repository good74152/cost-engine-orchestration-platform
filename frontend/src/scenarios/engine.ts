import {ApiClient,ApiError} from '../api/client';
import type {Attempt,CreatedDataset,Dataset,Job,RunResult} from '../api/types';
import type {Messages} from '../i18n/messages';

/** One command the page sent. Reads are omitted: they are not what a scenario demonstrates. */
export interface ApiCall {path:string;status:number;code?:string;detail?:string}
export type Simulation={dispatch:'ACCEPT'|'ACCEPT_THEN_UNKNOWN';completion:'RUNNING'|'SUCCEEDED'|'FAILED'};

/** The scenario read something it did not expect. Shown as-is; never hidden or retried. */
export class ScenarioMismatch extends Error {}
export function expectThat(condition:boolean,message:string):asserts condition{if(!condition)throw new ScenarioMismatch(message);}

/**
 * Explicit commands against the existing Demo API, each validated by the backend.
 * There is no scenario endpoint: this is a UI playing the same calls a person could send.
 */
export class ScenarioApi {
 constructor(private readonly api:ApiClient,private readonly onCall:(call:ApiCall)=>void,
  private readonly onRun:(result:RunResult)=>void,readonly fiscalYear:number,readonly period:string){}
 async post<T>(path:string,body:unknown={},detail?:string):Promise<{status:number;data:T}>{
  try{const reply=await this.api.request<T>(path,body);this.onCall({path,status:reply.status,...(detail?{detail}:{})});return reply;}
  catch(error){if(error instanceof ApiError)this.onCall({path,status:error.status,code:error.code,...(detail?{detail}:{})});throw error;}
 }
 createDataset(domain:string){return this.post<CreatedDataset>('/demo/dataset-versions',{domain,fiscalYear:this.fiscalYear,period:this.period},domain);}
 async create(domain:string){return (await this.createDataset(domain)).data;}
 async run(jobId:string,simulation:Simulation={dispatch:'ACCEPT',completion:'RUNNING'}){
  const reply=await this.post<RunResult>('/demo/calculation-jobs/'+jobId+'/run',{simulation},simulation.dispatch+' / '+simulation.completion);
  this.onRun(reply.data);return reply;
 }
 setExecutorState(attemptId:string,state:'SUCCEEDED'|'FAILED'){return this.post('/demo/execution-attempts/'+attemptId+'/fake-state',{state},state);}
 reconcile(jobId:string){return this.post('/demo/calculation-jobs/'+jobId+'/reconcile');}
 async validateAndPublish(datasetVersionId:string){
  await this.post('/demo/dataset-versions/'+datasetVersionId+'/submit-validation');
  await this.post('/demo/dataset-versions/'+datasetVersionId+'/publish');
 }
 /** Takes a dataset with no unmet inputs all the way to published. */
 async publish(domain:string){
  const dataset=await this.create(domain);
  for(const {jobId} of dataset.calculationJobs){await this.run(jobId,{dispatch:'ACCEPT',completion:'SUCCEEDED'});await this.reconcile(jobId);}
  await this.validateAndPublish(dataset.datasetVersionId);
  return dataset;
 }
 dataset(id:string){return this.api.get<Dataset>('/demo/dataset-versions/'+id);}
 jobs(datasetVersionId:string){return this.api.pages<Job>('/demo/dataset-versions/'+datasetVersionId+'/calculation-jobs');}
 attempts(jobId:string){return this.api.pages<Attempt>('/demo/calculation-jobs/'+jobId+'/execution-attempts');}
}

/** Stops the scenario until the viewer acts, whichever mode is playing. */
export interface PauseRequest {title:string;body:string;action:string}
export interface StepResult {message:string;focusSeriesId?:string;pause?:PauseRequest}
export interface ScenarioStep {title:string;run:(api:ScenarioApi)=>Promise<StepResult>}
export interface ScenarioSummary {title:string;facts:string[];note?:string;link?:{label:string;href:string}}
export interface ScenarioPlan {steps:ScenarioStep[];summary:(api:ScenarioApi)=>Promise<ScenarioSummary>}
export interface ScenarioDefinition {id:string;title:string;build:(messages:Messages)=>ScenarioPlan}
