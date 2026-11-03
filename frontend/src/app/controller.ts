import {ApiClient,ApiError,errorMessage} from '../api/client';
import type {Attempt,Dataset,Job,Session,WorkflowCatalog,WorkflowTemplate} from '../api/types';
import {ScenarioApi,ScenarioMismatch,type ApiCall,type PauseRequest,type ScenarioDefinition,type ScenarioSummary} from '../scenarios/engine';
import {DEFAULT_LINKS,type WorkflowLinks} from '../scenarios/labels';
import {nextReportingPeriod,scenarios} from '../scenarios/scenarios';
import {linksFromTemplate} from '../ui/tree';

export type DialogState=
 |{kind:'summary';summary:ScenarioSummary}
 |{kind:'pause';pause:PauseRequest}
 |{kind:'error';title:string;message:string;code?:string}
 |{kind:'details';title:string;explanation:string;rows:[string,string][]}
 |{kind:'clear'};

export interface PlaybackState {
 scenarioId:string;title:string;mode:'auto'|'step';status:'running'|'waiting'|'paused'|'done'|'failed';
 stepNumber:number;totalSteps:number;stepTitle:string;nextStepTitle:string|null;message:string;
}
export interface DemoState {
 session:Session|null;datasets:Dataset[];jobs:Record<string,Job[]>;attempts:Record<string,Attempt[]>;
 selectedSeriesId:string|null;links:WorkflowLinks;playback:PlaybackState|null;calls:ApiCall[];dialog:DialogState|null;runIds:Record<string,string>;clearing:boolean;
}
const empty=():DemoState=>({session:null,datasets:[],jobs:{},attempts:{},selectedSeriesId:null,links:DEFAULT_LINKS,playback:null,calls:[],dialog:null,runIds:{},clearing:false});
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));

/** Page state. Commands come only from a viewer's click; reloading the page sends GETs only. */
export class DemoController {
 private state=empty();private readonly listeners=new Set<()=>void>();
 private epoch=0;private generation=0;private release:(()=>void)|null=null;
 readonly api:ApiClient;
 constructor(fetcher?:typeof fetch,private readonly stepDelay=900){this.api=new ApiClient(()=>this.sessionEnded(),fetcher);}
 getSnapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private patch(change:Partial<DemoState>){this.state={...this.state,...change};this.listeners.forEach(l=>l());}
 private patchPlayback(change:Partial<PlaybackState>){if(this.state.playback)this.patch({playback:{...this.state.playback,...change}});}
 private isActive(){const s=this.state.playback?.status;return s==='running'||s==='waiting'||s==='paused';}

 /** A first-time visitor has no session. That is the normal start, not an error. */
 private sessionEnded(){
  const hadSession=!!this.state.session;this.abandon();
  this.state=empty();
  if(hadSession)this.state.dialog={kind:'error',title:'Your demo session ended',...errorMessage(new ApiError(401,'DEMO_SESSION_UNAVAILABLE'))};
  this.listeners.forEach(l=>l());
 }
 private abandon(){this.epoch++;this.generation++;const release=this.release;this.release=null;release?.();}
 private gate(){return new Promise<void>(done=>{this.release=done;});}

 load=async()=>{
  const epoch=this.epoch;
  try{const session=await this.api.get<Session>('/demo/sessions/current');
   if(epoch!==this.epoch)return;this.patch({session});await this.refresh();if(epoch===this.epoch)await this.readWorkflow();}
  catch(error){
   if(epoch!==this.epoch||(error instanceof ApiError&&error.status===401))return;
   this.showError('The saved state couldn’t be loaded',error);
  }
 };
 /** Replaces data only when the whole read succeeds, so the page never empties or jumps. */
 private async refresh(){
  const generation=++this.generation;
  const datasets=await this.api.pages<Dataset>('/demo/dataset-versions');
  const jobs:Record<string,Job[]>={};const attempts:Record<string,Attempt[]>={};
  for(const d of datasets){
   const list=await this.api.pages<Job>('/demo/dataset-versions/'+d.datasetVersionId+'/calculation-jobs');jobs[d.datasetVersionId]=list;
   for(const j of list)attempts[j.jobId]=await this.api.pages<Attempt>('/demo/calculation-jobs/'+j.jobId+'/execution-attempts');
  }
  if(generation!==this.generation)return;
  const newest=[...datasets].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  const selected=datasets.some(d=>d.datasetSeriesId===this.state.selectedSeriesId)?this.state.selectedSeriesId:newest?.datasetSeriesId??null;
  this.patch({datasets,jobs,attempts,selectedSeriesId:selected});
 }
 private async ensureSession(){
  if(!this.state.session)this.patch({session:(await this.api.request<Session>('/demo/sessions',{})).data});
  if(!await this.readWorkflow())throw new ApiError(0,'DEMO_NOT_WORKFLOW_OPEN');
 }
 /** The backend's template decides the map. Other admission states have no workflow to show. */
 private async readWorkflow(){
  const catalog=await this.api.get<WorkflowCatalog>('/demo/workflow-templates');
  if(catalog.admissionState!=='WORKFLOW_OPEN')return false;
  this.patch({links:linksFromTemplate(await this.api.get<WorkflowTemplate>('/demo/workflow-templates/SIX_DOMAIN_WORKFLOW'))});
  return true;
 }
 start=(scenarioId:string,mode:'auto'|'step')=>{
  const definition=scenarios.find(s=>s.id===scenarioId);if(!definition||this.isActive()||this.state.clearing)return Promise.resolve();
  return this.play(definition,mode);
 };
 private async play(definition:ScenarioDefinition,mode:'auto'|'step'){
  const epoch=++this.epoch;const live=()=>epoch===this.epoch;const plan=definition.build();const total=plan.steps.length;
  this.patch({calls:[],dialog:null,playback:{scenarioId:definition.id,title:definition.title,mode,status:'running',stepNumber:1,totalSteps:total,
   stepTitle:plan.steps[0]!.title,nextStepTitle:null,message:''}});
  try{
   await this.ensureSession();if(!live())return;
   await this.refresh();if(!live())return;
   const {fiscalYear,period}=nextReportingPeriod(this.state.datasets);
   const api=new ScenarioApi(this.api,call=>this.patch({calls:[...this.state.calls,call]}),
    result=>this.patch({runIds:{...this.state.runIds,[result.executionAttemptId]:result.airflowDagRunId}}),fiscalYear,period);
   let resumed=true;
   for(const [index,step] of plan.steps.entries()){
    if(mode==='step'&&!resumed){
     this.patchPlayback({status:'waiting',nextStepTitle:step.title});
     await this.gate();if(!live())return;
    }
    resumed=false;
    this.patchPlayback({status:'running',stepNumber:index+1,stepTitle:step.title,nextStepTitle:null});
    const result=await step.run(api);if(!live())return;
    this.patchPlayback({message:result.message});
    if(result.focusSeriesId)this.patch({selectedSeriesId:result.focusSeriesId});
    await this.refresh();if(!live())return;
    if(result.pause){
     this.patch({dialog:{kind:'pause',pause:result.pause}});this.patchPlayback({status:'paused'});
     await this.gate();if(!live())return;
     this.patch({dialog:null});this.patchPlayback({status:'running'});resumed=true;
    }else if(mode==='auto'&&index<total-1){await sleep(this.stepDelay);if(!live())return;}
   }
   const summary=await plan.summary(api);if(!live())return;
   this.patchPlayback({status:'done'});this.patch({dialog:{kind:'summary',summary}});
  }catch(error){
   if(!live())return;
   this.patchPlayback({status:'failed'});
   if(error instanceof ScenarioMismatch)this.patch({dialog:{kind:'error',title:'The backend replied differently than this scenario expected',message:error.message}});
   else this.showError('The scenario stopped',error);
   try{await this.refresh();}catch{/* the error dialog already explains the state */}
  }
 }
 private showError(title:string,error:unknown){this.patch({dialog:{kind:'error',title,...errorMessage(error)}});}
 /** Moves to the next step, or continues from a pause. */
 proceed=()=>{const release=this.release;this.release=null;release?.();};
 /** Leaves a step-through run. Data already saved stays visible. */
 stop=()=>{if(this.state.playback?.status!=='waiting')return;this.abandon();this.patch({playback:null});};
 dismiss=()=>{if(this.state.dialog?.kind!=='pause')this.patch({dialog:null});};
 selectSeries=(id:string)=>this.patch({selectedSeriesId:id});
 openDetails=(dialog:Extract<DialogState,{kind:'details'}>)=>this.patch({dialog});
 askToClear=()=>{if(!this.isActive()||this.state.playback?.status==='waiting')this.patch({dialog:{kind:'clear'}});};
 clear=async()=>{
  this.patch({clearing:true});
  try{await this.api.request<void>('/demo/sessions/reset',{});this.abandon();this.state=empty();this.listeners.forEach(l=>l());}
  catch(error){this.patch({clearing:false});if(!(error instanceof ApiError&&error.status===401))this.showError('Your data wasn’t cleared',error);}
 };
}
