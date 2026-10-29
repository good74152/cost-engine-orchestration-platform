import {it,expect} from 'vitest';
import {render,screen,waitFor,within,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import {App} from '../../app/app';
import {DemoProvider} from '../../app/demo-context';
import {DemoController} from '../../app/demo-controller';
import {MockApi,id,session,dataset,json,fail} from '../../test/mock-api';
import type {Job,Attempt} from '../../api/types';

function fixture(){
 const api=new MockApi();api.admissionState='WORKFLOW_OPEN';
 const capex=dataset(20);const a:Job={jobId:id(30),datasetVersionId:capex.datasetVersionId,calculationTypeCode:'DEMO_GUIDED_SUMMARY',jobStatus:'PENDING',createdAt:capex.createdAt,startedAt:null,finishedAt:null};
 const b={...a,jobId:id(31),calculationTypeCode:'DEMO_CAPEX_TABLE_Y'};
 api.datasets=[capex];api.jobs={[capex.datasetVersionId]:[a,b]};api.attempts={[a.jobId]:[],[b.jobId]:[]};
 const fake=new Map<string,string>();let allocated=60;
 api.onCall=(path,body)=>{
  if(!body)return undefined;
  const job=Object.values(api.jobs).flat().find(j=>path.includes('/'+j.jobId+'/'));
  const d=job?api.datasets.find(d=>d.datasetVersionId===job.datasetVersionId):api.datasets.find(d=>path.includes('/'+d.datasetVersionId+'/'));
  if(job&&d&&path.endsWith('/run')){
   const history=api.attempts[job.jobId]!;let attempt=history.at(-1);
   const recovery=attempt?.attemptStatus==='DISPATCHING';
   if(!recovery){attempt={executionAttemptId:id(allocated++),attemptNumber:history.length+1,attemptStatus:'ACCEPTED',createdAt:d.createdAt,dispatchStartedAt:d.createdAt,acceptedAt:d.createdAt,finishedAt:null};history.push(attempt);}
   const sim=body.simulation as {dispatch:string;completion:string};const unknown=!recovery&&sim?.dispatch==='ACCEPT_THEN_UNKNOWN';
   attempt!.attemptStatus=unknown?'DISPATCHING':'ACCEPTED';job.jobStatus=unknown?'PENDING':'RUNNING';d.datasetStatus='BUILDING';
   if(!recovery)fake.set(attempt!.executionAttemptId,sim?.completion??'RUNNING');
   return json({jobId:job.jobId,executionAttemptId:attempt!.executionAttemptId,attemptStatus:attempt!.attemptStatus},unknown?202:200);
  }
  if(path.endsWith('/fake-state')){fake.set(path.split('/')[3]!,String(body.state));return json({});}
  if(job&&path.endsWith('/reconcile')){const a=api.attempts[job.jobId]!.at(-1)!;const status=fake.get(a.executionAttemptId)??'SUCCEEDED';job.jobStatus=status;a.attemptStatus=status;a.finishedAt=a.createdAt;return json({});}
  if(d&&path.endsWith('/submit-validation')){if(!api.jobs[d.datasetVersionId]!.every(j=>j.jobStatus==='SUCCEEDED'))return fail('DATASET_NOT_READY_FOR_VALIDATION',409);d.datasetStatus='VALIDATING';return json({});}
  if(d&&path.endsWith('/publish')){d.datasetStatus='PUBLISHED';return json({});}
  return undefined;
 };
 return api;
}
async function mount(api=new MockApi(),route='/workflows/HAPPY_PATH'){
 const model=new DemoController(localStorage,api.fetcher);const user=userEvent.setup();
 const view=render(<MemoryRouter initialEntries={[route]}><DemoProvider controller={model}><App/></DemoProvider></MemoryRouter>);
 await waitFor(()=>expect(model.getSnapshot().loading).toBe(false));return {api,model,user,...view};
}
const bound=(template='HAPPY_PATH')=>`/workflows/${template}?scope=${session.sessionId}&dataset.CAPEX=${id(20)}`;
async function choose(user:ReturnType<typeof userEvent.setup>,template:string,step:string){
 await user.click(screen.getByRole('button',{name:'Select step '+step}));
}
async function click(user:ReturnType<typeof userEvent.setup>,model:DemoController,name:string,job?:string){
 const target=job?within(screen.getByRole('region',{name:'Operate '+job})):screen;
 await user.click(target.getByRole('button',{name}));await waitFor(()=>expect(model.getSnapshot().busy||model.getSnapshot().loading).toBe(false));
}

it('has a neutral unauthenticated Session start and never guesses mode or reads templates',async()=>{
 const api=new MockApi();api.active=false;await mount(api);
 expect(screen.getByRole('button',{name:'Start demo session'})).toBeVisible();
 expect(screen.queryByRole('link',{name:'Workflow Explorer'})).not.toBeInTheDocument();
 expect(api.calls.some(c=>c.path.startsWith('/demo/workflow-templates'))).toBe(false);expect(api.posts).toHaveLength(0);
});
it('LEGACY_OPEN preserves Guided and Free Exploration',async()=>{
 await mount(new MockApi(),'/guided');expect(screen.getByRole('button',{name:'Start Happy Path'})).toBeEnabled();
 expect(screen.getByRole('link',{name:'Free Exploration'})).toBeVisible();
});
it('DRAINING hides new Guided Create and does not expose Workflow operations',async()=>{
 const api=new MockApi();api.admissionState='DRAINING';const {model}=await mount(api,'/guided');
 expect(screen.getByText('New Guided Scenarios are paused')).toBeVisible();
 expect(screen.queryByRole('button',{name:/Start Happy Path/})).not.toBeInTheDocument();
 await act(()=>model.createScenario('HAPPY_PATH'));expect(api.posts).toHaveLength(0);
});
it('DRAINING preserves existing Guided Next without Create replay',async()=>{
 const api=new MockApi();api.admissionState='DRAINING';api.setScenario('HAPPY_PATH',1);
 const {user,model}=await mount(api,'/guided');await user.click(screen.getByRole('link',{name:'Continue existing Guided Scenario'}));
 await click(user,model,'Run calculation');expect(api.posts.map(p=>p.path)).toEqual(['/demo/scenarios/'+id(2)+'/next']);
});
it.each(['/guided','/guided/'+id(2)])('WORKFLOW_OPEN handles %s deep links without any Legacy Create',async route=>{
 const api=fixture();const {model}=await mount(api,route);
 await screen.findByRole('heading',{name:'Workflow Explorer'});await act(()=>model.createScenario('HAPPY_PATH'));
 expect(api.posts).toHaveLength(0);expect(screen.queryByRole('link',{name:'Guided Demo'})).not.toBeInTheDocument();
});
it('loads four Backend v2 templates and uses their Step IDs, prerequisites and expected results',async()=>{
 const api=fixture();const {user}=await mount(api,'/workflows');expect(screen.getAllByText('Version 2')).toHaveLength(4);
 await user.click(screen.getByRole('link',{name:/Six Domain Workflow/}));
 await screen.findByRole('heading',{name:'Six Domain Workflow',level:1});
 expect(screen.getAllByRole('link',{name:'fab_cost.publish'})).toHaveLength(3);
 expect(screen.getAllByText(/Expected result:/).length).toBe(36);expect(api.posts).toHaveLength(0);
});
it.each(['failed','missing-state','inconsistent-availability'])('availability %s fails closed and never enables a mode mutation',async mode=>{
 const api=fixture();const original=api.onCall;api.onCall=(path,body)=>path==='/demo/workflow-templates'?
  mode==='failed'?fail('DEMO_ADMISSION_UNAVAILABLE',503):json({...(mode==='missing-state'?{}:{admissionState:'WORKFLOW_OPEN'}),templates:[{id:'HAPPY_PATH',version:2,title:'Happy',description:'test',availability:'PREVIEW'}]}):original?.(path,body);
 const {model}=await mount(api);expect(model.getSnapshot().catalog).toBeNull();
 expect(screen.queryByRole('button',{name:/Create CAPEX Dataset/})).not.toBeInTheDocument();
 await act(()=>model.workflow('/demo/dataset-versions',{}));expect(api.posts).toHaveLength(0);
});
it('Template Detail failure disables operations and does not substitute a local Step Catalog',async()=>{
 const api=fixture();const original=api.onCall;api.onCall=(path,body)=>path==='/demo/workflow-templates/HAPPY_PATH'?fail('INTERNAL_SERVER_ERROR',500):original?.(path,body);
 const {model}=await mount(api);expect(model.getSnapshot().template).toBeNull();expect(model.getSnapshot().ready).toBe(false);
 await act(()=>model.workflow('/demo/dataset-versions',{}));expect(api.posts).toHaveLength(0);
});
it('paginated Dataset, Job and Attempt reads load the entire Workflow resource set',async()=>{
 const api=fixture();const original=api.onCall;
 const attempt:Attempt={executionAttemptId:id(80),attemptNumber:1,attemptStatus:'FAILED',createdAt:dataset().createdAt,dispatchStartedAt:null,acceptedAt:null,finishedAt:dataset().createdAt};
 api.attempts[id(30)]=[attempt,{...attempt,executionAttemptId:id(81),attemptNumber:2,attemptStatus:'SUCCEEDED'}];
 const offset=new Map<string,number>();api.onCall=(path,body)=>{
  const rows=path==='/demo/dataset-versions'?api.datasets:path.endsWith('/calculation-jobs')?api.jobs[id(20)]:path==='/demo/calculation-jobs/'+id(30)+'/execution-attempts'?api.attempts[id(30)]:undefined;
  if(rows&&!body){const n=offset.get(path)??0;offset.set(path,n+1);return json({items:rows.slice(n,n+1),nextCursor:n+1<rows.length?'opaque-next':null});}return original?.(path,body);
 };
 const {model}=await mount(api,bound());expect(model.getSnapshot().jobs[id(20)]).toHaveLength(2);expect(model.getSnapshot().attempts[id(30)]).toHaveLength(2);
 expect(api.posts).toHaveLength(0);
});
it('requires explicit version selection even with a single candidate and revalidates unavailable/foreign URL identities',async()=>{
 const {api,user}=await mount(fixture());expect(screen.getByLabelText('CAPEX Dataset version')).toHaveValue('');
 await user.selectOptions(screen.getByLabelText('CAPEX Dataset version'),id(20));
 expect(screen.getByRole('region',{name:'CAPEX resources'})).toBeVisible();expect(screen.queryAllByTestId('attempt-card')).toHaveLength(0);
 expect(api.posts).toHaveLength(0);
});
it('multiple Dataset versions require a choice; reload keeps only verified navigation bindings and sends GET only',async()=>{
 const api=fixture();api.datasets.push({...dataset(21),version:2,datasetStatus:'DRAFT'});api.jobs[id(21)]=[];
 const first=await mount(api);expect(screen.getByText('Multiple candidate versions: choose explicitly.')).toBeVisible();first.unmount();
 const second=await mount(api,bound());expect(screen.getByLabelText('CAPEX Dataset version')).toHaveValue(id(20));expect(api.posts).toHaveLength(0);second.unmount();
 await mount(api,`/workflows/HAPPY_PATH?scope=${id(999)}&dataset.CAPEX=${id(20)}`);
 expect(screen.getByLabelText('CAPEX Dataset version')).toHaveValue('');expect(screen.queryByRole('region',{name:'CAPEX resources'})).not.toBeInTheDocument();
});
it('two CAPEX Jobs are independently operated; fake success alone is never durable completion',async()=>{
 const {api,user,model}=await mount(fixture(),bound());await choose(user,'HAPPY_PATH','capex.run');
 await click(user,model,'Run Job','DEMO_GUIDED_SUMMARY');expect(api.posts.filter(p=>p.path.endsWith('/run'))).toHaveLength(1);
 expect(api.jobs[id(20)]![1]!.jobStatus).toBe('PENDING');
 await choose(user,'HAPPY_PATH','capex.fake-success');await click(user,model,'Set fake success','DEMO_GUIDED_SUMMARY');
 expect(api.jobs[id(20)]![0]!.jobStatus).toBe('RUNNING');expect(screen.getAllByText(/Fake state is not durable progress/).length).toBeGreaterThan(0);
 await choose(user,'HAPPY_PATH','capex.validate');expect(screen.getByRole('button',{name:'Submit validation'})).toBeDisabled();
});
it('Failure Retry preserves Attempt 1 history, retries only A and leaves B untouched',async()=>{
 const {api,user,model}=await mount(fixture(),bound('FAILURE_RETRY'));
 await choose(user,'FAILURE_RETRY','capex.run');await user.selectOptions(screen.getByLabelText('Completion simulation'),'FAILED');
 await click(user,model,'Run Job','DEMO_GUIDED_SUMMARY');await choose(user,'FAILURE_RETRY','capex.reconcile-failure');await click(user,model,'Reconcile Job','DEMO_GUIDED_SUMMARY');
 const original=structuredClone(api.attempts[id(30)]![0]);
 await choose(user,'FAILURE_RETRY','capex.retry');await click(user,model,'Retry Job','DEMO_GUIDED_SUMMARY');
 await choose(user,'FAILURE_RETRY','capex.fake-success');await click(user,model,'Set fake success','DEMO_GUIDED_SUMMARY');
 await choose(user,'FAILURE_RETRY','capex.reconcile');await click(user,model,'Reconcile Job','DEMO_GUIDED_SUMMARY');
 expect(api.attempts[id(30)]!.map(a=>a.attemptStatus)).toEqual(['FAILED','SUCCEEDED']);expect(api.attempts[id(30)]![0]).toEqual(original);
 expect(api.attempts[id(31)]).toHaveLength(0);expect(api.posts.filter(p=>p.path.includes(id(31)))).toHaveLength(0);
});
it('Lost ACK 202 requires explicit Recover and retains original Attempt across reload',async()=>{
 const api=fixture();const first=await mount(api,bound('LOST_RESPONSE_RECOVERY'));await choose(first.user,'LOST_RESPONSE_RECOVERY','capex.run-lost-response');
 await first.user.selectOptions(screen.getByLabelText('Dispatch simulation'),'ACCEPT_THEN_UNKNOWN');await click(first.user,first.model,'Run Job','DEMO_GUIDED_SUMMARY');
 expect(first.model.getSnapshot().notice).toMatch(/HTTP 202.*Outcome unknown/);const attempt=api.attempts[id(30)]![0]!;
 first.unmount();const second=await mount(api,bound('LOST_RESPONSE_RECOVERY'));expect(api.posts).toHaveLength(1);
 await choose(second.user,'LOST_RESPONSE_RECOVERY','capex.recover');await click(second.user,second.model,'Recover original Job','DEMO_GUIDED_SUMMARY');
 expect(api.attempts[id(30)]).toHaveLength(1);expect(api.attempts[id(30)]![0]!.executionAttemptId).toBe(attempt.executionAttemptId);
});
it('Network Error reads durable state, never retries POST and requires explicit Refresh/recovery choice',async()=>{
 const api=fixture();const original=api.onCall;api.onCall=async(path,body)=>{const response=await original?.(path,body);if(path.endsWith('/run'))throw new Error('lost response after commit');return response;};
 const {model,user}=await mount(api,bound());await choose(user,'HAPPY_PATH','capex.run');await click(user,model,'Run Job','DEMO_GUIDED_SUMMARY');
 expect(model.getSnapshot().error?.code).toBe('NETWORK_ERROR');expect(model.getSnapshot().jobs[id(20)]![0]!.jobStatus).toBe('RUNNING');
 expect(api.posts).toHaveLength(1);await act(()=>model.refresh());expect(api.posts).toHaveLength(1);
});
it('return from Free Exploration refreshes changed durable state rather than cached progress',async()=>{
 const api=fixture();const {user,model}=await mount(api,bound());
 await user.click(screen.getByRole('link',{name:'Open Free Exploration'}));await waitFor(()=>expect(model.getSnapshot().loading).toBe(false));
 api.datasets[0]!.datasetStatus='PUBLISHED';api.jobs[id(20)]!.forEach(j=>j.jobStatus='SUCCEEDED');
 await user.click(screen.getByRole('link',{name:'Workflow Explorer'}));await screen.findByRole('heading',{name:'Workflow Explorer'});
 await user.click(screen.getByRole('link',{name:/Happy Path/}));await screen.findByRole('heading',{name:'Happy Path',level:1});
 expect(model.getSnapshot().datasets[0]!.datasetStatus).toBe('PUBLISHED');expect(api.posts).toHaveLength(0);
});
it('Reset clears data, template and UI selections and does not automatically start another Session',async()=>{
 const {model,user,api}=await mount(fixture(),bound());await user.click(screen.getByRole('button',{name:'Reset session'}));await click(user,model,'Confirm reset');
 expect(model.getSnapshot().session).toBeNull();expect(model.getSnapshot().template).toBeNull();expect(model.getSnapshot().datasets).toHaveLength(0);
 expect(screen.queryByRole('region',{name:'CAPEX resources'})).not.toBeInTheDocument();expect(api.posts.map(p=>p.path)).toEqual(['/demo/sessions/reset']);
});
it('Session expiration removes all Workflow resources and bindings from the rendered view',async()=>{
 const {api,model}=await mount(fixture(),bound());api.active=false;await act(()=>model.refresh());
 expect(model.getSnapshot().catalog).toBeNull();expect(model.getSnapshot().templateId).toBeNull();
 expect(screen.queryByRole('region',{name:'CAPEX resources'})).not.toBeInTheDocument();expect(api.posts).toHaveLength(0);
});
