import {ApiClient,ApiError,errorMessage} from '../api/client';
import type {Session,Scenario,ScenarioType,Pending,Dataset,Job,Attempt,StepReply,WorkflowCatalog,WorkflowTemplate} from '../api/types';
import {verifyCatalog,verifyTemplate} from '../features/workflows/workflow-model';
import {savedRequest,saveRequest,clearRequests,type StepRequest} from '../features/scenarios/request-storage';

export interface DemoState {
 session:Session|null;scenario:Scenario|null;pending:Pending|null;datasets:Dataset[];
 jobs:Record<string,Job[]>;attempts:Record<string,Attempt[]>;lastStep:StepReply|null;
 busy:boolean;loading:boolean;error:ReturnType<typeof errorMessage>|null;notice:string|null;noticePending:boolean;
 catalog:WorkflowCatalog|null;template:WorkflowTemplate|null;templateId:string|null;ready:boolean;
}
const empty=():DemoState=>({session:null,scenario:null,pending:null,datasets:[],jobs:{},attempts:{},lastStep:null,busy:false,loading:false,error:null,notice:null,noticePending:false,catalog:null,template:null,templateId:null,ready:false});
/** UI coordination only. No inferred lifecycle transitions, background mutation or POST retry. */
export class DemoController {
 private state:DemoState={...empty(),loading:true};
 private readonly listeners=new Set<()=>void>();
 private epoch=0;private readGeneration=0;
 private sentRequest:StepRequest|null=null;
 readonly api:ApiClient;
 constructor(private readonly storage:Storage,fetcher?:typeof fetch){
  this.api=new ApiClient(()=>this.expired(),fetcher);
 }
 getSnapshot=()=>this.state;
 subscribe=(callback:()=>void)=>{this.listeners.add(callback);return()=>{this.listeners.delete(callback);};};
 private patch(change:Partial<DemoState>){this.state={...this.state,...change};this.listeners.forEach(f=>f());}
 dismiss=()=>this.patch({error:null,notice:null});
 private expired(){this.epoch++;this.sentRequest=null;try{clearRequests(this.storage);}catch{/* no credentials are stored */}
  this.patch({...empty(),busy:this.state.busy,error:errorMessage(new ApiError(401,'DEMO_SESSION_UNAVAILABLE'))});}
 private fail(error:unknown){if(!(error instanceof ApiError&&error.status===401))this.patch({error:errorMessage(error)});}
 async refresh(preserveError=false):Promise<boolean>{
  const epoch=this.epoch;const generation=++this.readGeneration;
  this.patch({loading:true,ready:false,catalog:null,template:null,...(preserveError?{}:{error:null})});
  const current=()=>epoch===this.epoch&&generation===this.readGeneration;
  try{
   const session=await this.api.get<Session>('/demo/sessions/current');
   if(!current())return false;
   if(this.state.session?.sessionId!==session.sessionId){
    this.sentRequest=null;
    this.patch({session,scenario:null,pending:null,datasets:[],jobs:{},attempts:{},lastStep:null,notice:null,noticePending:false});
   }
   const catalog=verifyCatalog(await this.api.get<WorkflowCatalog>('/demo/workflow-templates'));
   const template=this.state.templateId?verifyTemplate(await this.api.get<WorkflowTemplate>('/demo/workflow-templates/'+encodeURIComponent(this.state.templateId)),catalog):null;
   let scenario:Scenario|null=null;
   try{scenario=await this.api.get<Scenario>('/demo/scenarios/current');}
   catch(e){if(!(e instanceof ApiError&&e.status===404&&e.code==='DEMO_RESOURCE_UNAVAILABLE'))throw e;}
   const pending=scenario?(await this.api.get<{pendingStep:Pending|null}>('/demo/scenarios/'+scenario.scenarioId+'/pending-step')).pendingStep:null;
   const datasets=await this.api.pages<Dataset>('/demo/dataset-versions');
   const jobs:Record<string,Job[]>={};const attempts:Record<string,Attempt[]>={};
   for(const d of datasets){
    jobs[d.datasetVersionId]=await this.api.pages<Job>('/demo/dataset-versions/'+d.datasetVersionId+'/calculation-jobs');
    for(const j of jobs[d.datasetVersionId]!)attempts[j.jobId]=await this.api.pages<Attempt>('/demo/calculation-jobs/'+j.jobId+'/execution-attempts');
   }
   if(!current())return false;
   if(pending&&scenario){try{const mapping={sessionId:session.sessionId,scenarioId:scenario.scenarioId,stepNumber:pending.stepNumber,requestId:pending.requestId};
     saveRequest(this.storage,mapping);this.sentRequest=mapping;}
    catch{throw new ApiError(0,'STORAGE_UNAVAILABLE');}}
   this.patch({session,scenario,pending,datasets,jobs,attempts,catalog,template,ready:true});
   return true;
  }catch(e){if(current()&&(!preserveError||!this.state.error))this.fail(e);return false;}
  finally{if(current())this.patch({loading:false});}
 }
 openTemplate=(id:string|null)=>{this.patch({templateId:id,template:null});return this.refresh();};
 clearTemplate=()=>this.patch({templateId:null,template:null});
 private async mutate(body:()=>Promise<void>):Promise<boolean>{
  if(this.state.busy)return false;
  this.patch({busy:true,error:null,notice:null,noticePending:false});
  try{await body();return true;}catch(e){this.fail(e);return false;}finally{this.patch({busy:false});}
 }
 start=()=>this.mutate(async()=>{await this.api.request<Session>('/demo/sessions',{});await this.refresh();});
 reset=()=>this.mutate(async()=>{
  await this.api.request<void>('/demo/sessions/reset',{});
  this.epoch++;this.readGeneration++;
  this.sentRequest=null;
  try{clearRequests(this.storage);}catch{/* invalidated session scope is no longer used */}
  this.patch({...empty(),busy:true});
 });
 createScenario=(scenarioType:ScenarioType)=>this.mutate(async()=>{
  if(this.state.catalog?.admissionState!=='LEGACY_OPEN'||!this.state.ready)throw new ApiError(0,'DEMO_LEGACY_ADMISSION_CLOSED');
  try{await this.api.request<Scenario>('/demo/scenarios',{scenarioType});await this.refresh();}
  catch(e){this.fail(e);if(!(e instanceof ApiError&&e.status===401))await this.refresh(true);throw e;}
 });
 currentStep(){return this.state.pending?.stepNumber??((this.state.scenario?.completedStep??0)+1);}
 private currentRequest(){const {session,scenario}=this.state;if(!session||!scenario)return null;
  const step=this.currentStep();const sent=this.sentRequest;
  return sent?.sessionId===session.sessionId&&sent.scenarioId===scenario.scenarioId&&sent.stepNumber===step?sent:savedRequest(this.storage,session.sessionId,scenario.scenarioId,step);
 }
 hasCurrentRequest(){return !!this.currentRequest();}
 runStep=()=>this.mutate(async()=>{
  const {session,scenario}=this.state;if(!session||!scenario||scenario.status==='COMPLETED')return;
  const epoch=this.epoch;const step=this.currentStep();
  const pending=this.state.pending;
  const requestId=pending?.requestId??this.currentRequest()?.requestId??crypto.randomUUID();
  try{const mapping={sessionId:session.sessionId,scenarioId:scenario.scenarioId,stepNumber:step,requestId};saveRequest(this.storage,mapping);this.sentRequest=mapping;}
  catch{throw new ApiError(0,'STORAGE_UNAVAILABLE');}
  try{
   const reply=await this.api.request<StepReply>('/demo/scenarios/'+scenario.scenarioId+'/next',{expectedStep:step,requestId});
   if(reply.data.scenarioId!==scenario.scenarioId||reply.data.stepNumber!==step||reply.data.requestId!==requestId||
    !((reply.status===200&&reply.data.stepStatus==='COMPLETED')||(reply.status===202&&reply.data.stepStatus==='PENDING')))throw new ApiError(0,'INVALID_RESPONSE');
   if(epoch!==this.epoch)return;
   this.patch({lastStep:reply.data,notice:reply.status===202?'The step is pending. Recover using the original request.':
    scenario.scenarioType==='LOST_RESPONSE_RECOVERY'&&step===2?'Original execution recovered without creating a duplicate attempt.':'Step confirmed. Durable progress has been refreshed.'});
   await this.refresh();
  }catch(e){this.fail(e);if(epoch===this.epoch)await this.refresh(true);throw e;}
 });
 manual=(path:string,body:unknown={},notice='Operation acknowledged. Durable state has been refreshed.')=>this.mutate(async()=>{
  if(!this.state.ready)throw new ApiError(0,'INVALID_RESPONSE');
  try{const reply=await this.api.request<unknown>(path,body);this.patch({noticePending:reply.status===202,notice:reply.status===202?'HTTP 202 · Outcome unknown. The execution may exist. Refresh, then explicitly Recover the original Job.':notice});await this.refresh();}
  catch(e){this.fail(e);if(!(e instanceof ApiError&&e.status===401))await this.refresh(true);throw e;}
 });
 workflow=(path:string,body:unknown={},notice?:string)=>{
  if(this.state.catalog?.admissionState!=='WORKFLOW_OPEN'||this.state.template?.availability!=='AVAILABLE'||!this.state.ready||this.state.scenario){
   this.fail(new ApiError(0,'DEMO_ADMISSION_UNAVAILABLE'));return Promise.resolve(false);
  }return this.manual(path,body,notice);
 };
}
