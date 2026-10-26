import {it,expect} from 'vitest';
import {render,screen,waitFor,within,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MemoryRouter} from 'react-router-dom';
import {App} from './app';
import {DemoProvider} from './demo-context';
import {DemoController} from './demo-controller';
import {MockApi,session,id,json,fail,dataset} from '../test/mock-api';
import {catalog} from '../features/scenarios/scenario-catalog';
import type {ScenarioType} from '../api/types';
import {saveRequest,savedRequest} from '../features/scenarios/request-storage';

async function mount(server=new MockApi(),route='/',storage:Storage=localStorage){
 const model=new DemoController(storage,server.fetcher);const user=userEvent.setup();
 const view=render(<MemoryRouter initialEntries={[route]}><DemoProvider controller={model}><App/></DemoProvider></MemoryRouter>);
 await waitFor(()=>expect(model.getSnapshot().loading).toBe(false));return {model,user,server,...view};
}
async function step(model:DemoController,user:ReturnType<typeof userEvent.setup>,name:string,completed:number){
 await user.click(screen.getByRole('button',{name}));
 await waitFor(()=>{expect(model.getSnapshot().busy).toBe(false);expect(model.getSnapshot().scenario?.completedStep).toBe(completed);});
}
const nextPosts=(server:MockApi)=>server.posts.filter(c=>c.path.endsWith('/next'));

it('restores a session without a POST, reads exact DTOs, and shows scoped empty state',async()=>{
 const {server}=await mount();expect((await screen.findAllByText(session.companyCode))[0]).toBeVisible();
 expect(server.posts).toHaveLength(0);expect(screen.getByText('No datasets yet')).toBeVisible();expect(localStorage.length).toBe(0);
});
it('starts a session only after explicit action and includes no company selector',async()=>{
 const api=new MockApi();api.active=false;const {user}=await mount(api);expect(api.posts).toHaveLength(0);
 expect(screen.getByText('Your demo session has expired. Start a new session to continue.')).toBeVisible();
 await user.click(screen.getByRole('button',{name:'Start demo session'}));await waitFor(()=>expect(api.posts).toHaveLength(1));
 await screen.findAllByText(session.companyCode);expect(api.posts[0]!.body).toEqual({});
});
it('expires an active session, clears old resource cache and request mappings, and denies old workflow UI',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',2);const {model}=await mount(api,'/guided/'+id(2));
 saveRequest(localStorage,{sessionId:session.sessionId,scenarioId:id(2),stepNumber:3,requestId:id(80)});
 api.active=false;await act(()=>model.refresh());expect(model.getSnapshot().session).toBeNull();expect(model.getSnapshot().datasets).toHaveLength(0);
 expect(localStorage.length).toBe(0);expect(screen.getByText('Your demo session has expired. Start a new session to continue.')).toBeVisible();
 expect(screen.queryByRole('button',{name:'Simulate success'})).not.toBeInTheDocument();
});
it('confirms Reset explicitly, clears session/cache/request scope only after 204 and does not auto-start',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',2);const {model,user}=await mount(api);
 saveRequest(localStorage,{sessionId:session.sessionId,scenarioId:id(2),stepNumber:3,requestId:id(80)});
 await user.click(screen.getByRole('button',{name:'Reset session'}));expect(api.posts).toHaveLength(0);
 await user.click(screen.getByRole('button',{name:'Confirm reset'}));await waitFor(()=>expect(model.getSnapshot().session).toBeNull());
 expect(model.getSnapshot().datasets).toHaveLength(0);expect(localStorage.length).toBe(0);expect(screen.getByRole('button',{name:'Start demo session'})).toBeVisible();
 expect(api.posts.map(c=>c.path)).toEqual(['/demo/sessions/reset']);
});
it.each(['DEMO_RESET_FAILED','DEMO_RESET_OUTCOME_UNKNOWN'])('retains session/cache/request identity after %s',async(code)=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',2);api.resetFailure=code;const {model,user}=await mount(api);
 const mapping={sessionId:session.sessionId,scenarioId:id(2),stepNumber:3,requestId:id(80)};saveRequest(localStorage,mapping);
 await user.click(screen.getByRole('button',{name:'Reset session'}));await user.click(screen.getByRole('button',{name:'Confirm reset'}));
 await waitFor(()=>expect(model.getSnapshot().error?.code).toBe(code));expect(model.getSnapshot().session).toEqual(session);
 expect(model.getSnapshot().datasets).toHaveLength(1);expect(savedRequest(localStorage,session.sessionId,id(2),3)).toEqual(mapping);
 expect(screen.getByRole('dialog')).toBeVisible();expect(api.posts).toHaveLength(1);
});
it.each(['HAPPY_PATH','FAILURE_RETRY','LOST_RESPONSE_RECOVERY'] as ScenarioType[])('runs the full %s with explicit actions and backend-only progress',async(type)=>{
 const api=new MockApi();const {model,user}=await mount(api,'/guided');
 await user.click(screen.getByRole('button',{name:'Start '+catalog[type].title}));await screen.findByRole('heading',{name:catalog[type].title,level:1});
 expect(api.posts[0]!.body).toEqual({scenarioType:type});expect(nextPosts(api)).toHaveLength(0);
 for(let n=1;n<=catalog[type].steps.length;n++){
  await step(model,user,catalog[type].steps[n-1]!.action,type==='LOST_RESPONSE_RECOVERY'&&n===2?1:n);
  if(type==='LOST_RESPONSE_RECOVERY'&&n===2){
   expect(screen.getByText('Execution may have started, but the acknowledgement was lost.')).toBeVisible();
   expect(model.getSnapshot().pending?.requestId).toBe(nextPosts(api).at(-1)!.body!.requestId);
   const original=nextPosts(api).at(-1)!.body;await step(model,user,'Recover original execution',2);
   expect(nextPosts(api).at(-1)!.body).toEqual(original);
   expect(screen.getByText('Original execution recovered without creating a duplicate attempt.')).toBeVisible();
  }
  if(type==='FAILURE_RETRY'&&n===4){expect(model.getSnapshot().scenario?.status).toBe('IN_PROGRESS');expect(model.getSnapshot().jobs[id(10)]![0]!.jobStatus).toBe('FAILED');}
  if(type==='FAILURE_RETRY'&&n>=5){const cards=screen.getAllByTestId('attempt-card');expect(cards).toHaveLength(2);expect(within(cards[0]!).getByText('FAILED')).toBeVisible();}
 }
 expect(model.getSnapshot().scenario?.status).toBe('COMPLETED');expect(screen.getByText('Dataset published.')).toBeVisible();
 expect(nextPosts(api)).toHaveLength(type==='LOST_RESPONSE_RECOVERY'?7:catalog[type].steps.length);
 expect(model.getSnapshot().datasets[0]!.datasetStatus).toBe('PUBLISHED');
});
it('same-type Create replay keeps durable progress; different-type conflict shows Reset guidance without switching',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',2);const {model,user}=await mount(api,'/guided');
 await user.click(screen.getByRole('button',{name:'Continue scenario'}));await waitFor(()=>expect(model.getSnapshot().busy).toBe(false));
 expect(api.posts[0]!.body).toEqual({scenarioType:'HAPPY_PATH'});expect(model.getSnapshot().scenario?.completedStep).toBe(2);
 await act(()=>model.createScenario('FAILURE_RETRY'));expect(model.getSnapshot().error?.code).toBe('DEMO_SCENARIO_TYPE_CONFLICT');
 expect(model.getSnapshot().scenario?.scenarioType).toBe('HAPPY_PATH');expect(screen.getByText(/Reset to switch scenarios/)).toBeVisible();
});
it('Failure Retry step 5 HTTP 202 preserves FAILED job, Attempt 1 history and the SAME Attempt 2 request on recovery',async()=>{
 const api=new MockApi();api.setScenario('FAILURE_RETRY',4);const firstHistory=structuredClone(api.attempts[id(20)]![0]!);let first=true;
 api.onNext=body=>{if(first){first=false;api.pending={stepNumber:5,requestId:String(body.requestId)};
  api.attempts[id(20)]!.push({executionAttemptId:id(31),attemptNumber:2,attemptStatus:'DISPATCHING',createdAt:firstHistory.createdAt,dispatchStartedAt:firstHistory.createdAt,acceptedAt:null,finishedAt:null});
  return json(api.reply(5,String(body.requestId),'PENDING'),202);}return api.performNext(body);};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Retry calculation',4);
 expect(model.getSnapshot().jobs[id(10)]![0]!.jobStatus).toBe('FAILED');expect(model.getSnapshot().attempts[id(20)]![0]).toEqual(firstHistory);
 const request=nextPosts(api)[0]!.body;await step(model,user,'Retry current step',5);expect(nextPosts(api)[1]!.body).toEqual(request);
 expect(model.getSnapshot().attempts[id(20)]![1]!.executionAttemptId).toBe(id(31));expect(nextPosts(api)).toHaveLength(2);
});
it('reload during pending restores the server request ID even when browser mapping is missing or conflicting',async()=>{
 const api=new MockApi();api.setScenario('LOST_RESPONSE_RECOVERY',1);api.performNext({expectedStep:2,requestId:id(81)});
 saveRequest(localStorage,{sessionId:session.sessionId,scenarioId:id(2),stepNumber:2,requestId:id(82)});
 const mounted=await mount(api,'/guided/'+id(2));expect(savedRequest(localStorage,session.sessionId,id(2),2)?.requestId).toBe(id(81));mounted.unmount();localStorage.clear();
 const {model,user}=await mount(api,'/guided/'+id(2));expect(nextPosts(api)).toHaveLength(0);
 await step(model,user,'Recover original execution',2);expect(nextPosts(api)[0]!.body).toEqual({expectedStep:2,requestId:id(81)});
});
it('persists request mapping before POST, retries 503 with the SAME UUID, and never auto-advances',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);let calls=0;
 api.onNext=body=>{const mapping=savedRequest(localStorage,session.sessionId,id(2),2);expect(mapping?.requestId).toBe(body.requestId);
  if(++calls===1)return fail('DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN',503);return api.performNext(body);};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Run calculation',1);
 expect(screen.getByText('Execution outcome is currently unknown. Retry using the same request.')).toBeVisible();expect(nextPosts(api)).toHaveLength(1);
 await step(model,user,'Retry current step',2);expect(nextPosts(api)[1]!.body).toEqual(nextPosts(api)[0]!.body);expect(nextPosts(api)).toHaveLength(2);
 for(let i=0;i<localStorage.length;i++){const value=JSON.parse(localStorage.getItem(localStorage.key(i)!)!);expect(Object.keys(value).sort()).toEqual(['requestId','scenarioId','sessionId','stepNumber']);}
});
it('keeps the same request across network failure and reload without generating a takeover ID',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);api.onNext=()=>{throw new Error('network offline');};
 const first=await mount(api,'/guided/'+id(2));await step(first.model,first.user,'Run calculation',1);const original=nextPosts(api)[0]!.body;
 first.unmount();api.onNext=null;const second=await mount(api,'/guided/'+id(2));expect(nextPosts(api)).toHaveLength(1);
 await step(second.model,second.user,'Retry current step',2);expect(nextPosts(api)[1]!.body).toEqual(original);
});
it('does not invent a new ID if localStorage disappears after an unknown response in the active page',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);let first=true;api.onNext=body=>{if(first){first=false;return fail('DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN',503);}return api.performNext(body);};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Run calculation',1);const original=nextPosts(api)[0]!.body;localStorage.clear();
 await step(model,user,'Retry current step',2);expect(nextPosts(api)[1]!.body).toEqual(original);
});
it('lost HTTP response refreshes confirmed server progress without a new POST or rollback guess',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);api.onNext=body=>{api.performNext(body);throw new Error('HTTP response lost');};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Run calculation',2);
 expect(nextPosts(api)).toHaveLength(1);expect(screen.getByRole('button',{name:'Simulate success'})).toBeVisible();expect(model.getSnapshot().lastStep).toBeNull();
});
it('a stored old response never replaces newer durable Scenario GET progress',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);api.onNext=body=>{const response=api.performNext(body);api.setScenario('HAPPY_PATH',4);return response;};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Run calculation',4);
 expect(screen.getByRole('button',{name:'Submit validation'})).toBeVisible();expect(model.getSnapshot().lastStep?.stepNumber).toBe(2);expect(nextPosts(api)).toHaveLength(1);
});
it('409 refreshes pending ownership and retries the SERVER original ID instead of a new ID',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);let first=true;
 api.onNext=body=>{if(first){first=false;api.pending={stepNumber:2,requestId:id(83)};return fail('DEMO_SCENARIO_STEP_CONFLICT',409);}return api.performNext(body);};
 const {model,user}=await mount(api,'/guided/'+id(2));await step(model,user,'Run calculation',1);expect(model.getSnapshot().pending?.requestId).toBe(id(83));
 await step(model,user,'Retry current step',2);expect(nextPosts(api)[1]!.body!.requestId).toBe(id(83));expect(nextPosts(api)).toHaveLength(2);
});
it('blocked storage fails BEFORE the step POST and never sends an unpersisted UUID',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);const storage={...localStorage,getItem:()=>null,setItem:()=>{throw new Error('blocked');}} as unknown as Storage;
 const {model,user}=await mount(api,'/guided/'+id(2),storage);await step(model,user,'Run calculation',1);
 expect(model.getSnapshot().error?.code).toBe('STORAGE_UNAVAILABLE');expect(nextPosts(api)).toHaveLength(0);
});
it('disables mutation buttons while in flight and prevents double submission without automatic retry',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',1);let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
 api.onNext=async body=>{await barrier;return api.performNext(body);};const {model,user}=await mount(api,'/guided/'+id(2));
 await user.click(screen.getByRole('button',{name:'Run calculation'}));expect(screen.getByRole('button',{name:'Awaiting backend…'})).toBeDisabled();
 await act(()=>model.runStep());expect(nextPosts(api)).toHaveLength(1);await act(async()=>{release();await barrier;});
 await waitFor(()=>expect(model.getSnapshot().busy).toBe(false));expect(nextPosts(api)).toHaveLength(1);
});
it('loads subsequent dataset cursor pages, shows resources and offers local list continuation',async()=>{
 const api=new MockApi();api.datasets=Array.from({length:12},(_,n)=>dataset(100+n));
 api.onCall=(path)=>path==='/demo/dataset-versions'?json({items:api.datasets.slice(api.calls.at(-1)!.path===path&&api.calls.filter(c=>c.path===path).length===1?0:6,api.calls.filter(c=>c.path===path).length===1?6:12),nextCursor:api.calls.filter(c=>c.path===path).length===1?'opaque-page-2':null}):undefined;
 const {model,user}=await mount(api,'/datasets');expect(model.getSnapshot().datasets).toHaveLength(12);expect(screen.getByText('12 dataset versions')).toBeVisible();
 expect(screen.getAllByText('Inspect dataset →')).toHaveLength(9);await user.click(screen.getByRole('button',{name:'Show more datasets'}));expect(screen.getAllByText('Inspect dataset →')).toHaveLength(12);
});
it('reads owned dataset/job detail DTOs and displays preserved Attempt 1 / 2 history',async()=>{
 const api=new MockApi();api.setScenario('FAILURE_RETRY',7);await mount(api,'/datasets/'+id(10));
 expect(await screen.findByText('Calculation jobs')).toBeVisible();expect(await screen.findAllByTestId('attempt-card')).toHaveLength(2);
 expect(api.calls.some(c=>c.path==='/demo/dataset-versions/'+id(10))).toBe(true);expect(api.calls.some(c=>c.path==='/demo/calculation-jobs/'+id(20))).toBe(true);
 const cards=screen.getAllByTestId('attempt-card');expect(within(cards[0]!).getByText('FAILED')).toBeVisible();expect(within(cards[1]!).getByText('SUCCEEDED')).toBeVisible();
});
it('resource loading follows Job and Attempt cursor pages as well as Dataset pages',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',4);api.scenario=null;
 api.jobs[id(10)]!.push({...api.jobs[id(10)]![0]!,jobId:id(21),calculationTypeCode:'SECOND_TYPE'});api.attempts[id(21)]=[];
 api.attempts[id(20)]=Array.from({length:6},(_,n)=>({...api.attempts[id(20)]![0]!,executionAttemptId:id(60+n),attemptNumber:n+1,attemptStatus:n===5?'SUCCEEDED':'FAILED'}));
 let jobPage=0,attemptPage=0;api.onCall=path=>{
  if(path==='/demo/dataset-versions/'+id(10)+'/calculation-jobs')return json({items:api.jobs[id(10)]!.slice(jobPage++===0?0:1,jobPage===1?1:2),nextCursor:jobPage===1?'jobs-2':null});
  if(path==='/demo/calculation-jobs/'+id(20)+'/execution-attempts')return json({items:api.attempts[id(20)]!.slice(attemptPage++===0?0:3,attemptPage===1?3:6),nextCursor:attemptPage===1?'attempts-2':null});
  return undefined;};
 const {model}=await mount(api,'/datasets/'+id(10));await screen.findByRole('heading',{name:'SECOND_TYPE'});
 expect(model.getSnapshot().jobs[id(10)]).toHaveLength(2);expect(model.getSnapshot().attempts[id(20)]).toHaveLength(6);expect(screen.getAllByTestId('attempt-card')).toHaveLength(6);
});
it('Free Exploration sends only canonical form fields and performs fake / reconcile / publish separately',async()=>{
 const api=new MockApi();const {model,user}=await mount(api,'/exploration');
 expect(screen.queryByLabelText('Company code')).not.toBeInTheDocument();await user.click(screen.getByRole('button',{name:'Create dataset'}));
 await waitFor(()=>expect(model.getSnapshot().datasets).toHaveLength(1));expect(api.posts[0]!.body).toEqual({domain:'CAPEX',fiscalYear:2026,period:'Q4'});
 await user.click(screen.getByRole('button',{name:'Run calculation'}));await waitFor(()=>expect(model.getSnapshot().jobs[id(10)]![0]!.jobStatus).toBe('RUNNING'));
 await user.click(screen.getByRole('button',{name:'Set fake success'}));await waitFor(()=>expect(model.getSnapshot().busy).toBe(false));expect(model.getSnapshot().jobs[id(10)]![0]!.jobStatus).toBe('RUNNING');
 await user.click(screen.getByRole('button',{name:'Reconcile'}));await waitFor(()=>expect(model.getSnapshot().jobs[id(10)]![0]!.jobStatus).toBe('SUCCEEDED'));
 await user.click(screen.getByRole('button',{name:'Submit validation'}));await waitFor(()=>expect(model.getSnapshot().datasets[0]!.datasetStatus).toBe('VALIDATING'));
 await user.click(screen.getByRole('button',{name:'Publish'}));await waitFor(()=>expect(model.getSnapshot().datasets[0]!.datasetStatus).toBe('PUBLISHED'));
 expect(api.posts.every(c=>!('companyCode'in(c.body??{})))).toBe(true);expect(document.body.textContent).not.toMatch(/airflowDag|token_hash|upstreamDatasetVersions/);
});
it('queues a manual behavior explicitly and shows session-not-empty Reset guidance without automatic Reset',async()=>{
 const api=new MockApi();const {model,user}=await mount(api,'/exploration');await user.selectOptions(screen.getByLabelText('Dispatch behavior'),'REJECT');
 await user.click(screen.getByRole('button',{name:'Queue behavior'}));await waitFor(()=>expect(model.getSnapshot().busy).toBe(false));
 expect(api.posts[0]!.body).toEqual({behavior:'REJECT'});await act(()=>model.createScenario('LOST_RESPONSE_RECOVERY'));
 expect(model.getSnapshot().error?.code).toBe('DEMO_SCENARIO_SESSION_NOT_EMPTY');expect(model.getSnapshot().scenario).toBeNull();expect(api.posts.some(c=>c.path.endsWith('/reset'))).toBe(false);
});
it('blocks manual UI during Guided mode and never silently switches or resets',async()=>{
 const api=new MockApi();api.setScenario('HAPPY_PATH',2);await mount(api,'/exploration');
 expect(screen.getByText('Guided Scenario is active. Reset your session to use Free Exploration.')).toBeVisible();
 expect(screen.queryByRole('button',{name:'Queue behavior'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Run calculation'})).not.toBeInTheDocument();expect(api.posts).toHaveLength(0);
});
