import {describe,expect,it} from 'vitest';
import {cleanup,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {PrimeReactProvider} from 'primereact/api';
import {App} from './app';
import {DemoController} from './controller';
import {DemoProvider} from './demo-context';
import {fail,MockApi} from '../test/mock-api';
import {primeOptions} from '../ui/prime-theme';

function mount(api=new MockApi()){
 const model=new DemoController(api.fetch,0);
 render(<PrimeReactProvider value={primeOptions}><DemoProvider controller={model}><App/></DemoProvider></PrimeReactProvider>);
 return {api,model,user:userEvent.setup()};
}
const dialog=(name:string)=>screen.findByRole('dialog',{name},{timeout:4000});
const closeButton=(d:HTMLElement)=>within(d).getAllByRole('button',{name:'Close'}).at(-1)!;
const nodes=(status:string)=>screen.queryAllByRole('button',{name:new RegExp(', '+status+'$')});

describe('one-page demo',()=>{
 it('shows a first-time visitor no error, sends no command and explains the hierarchy',async()=>{
  const {api}=mount();
  await waitFor(()=>expect(api.calls.length).toBe(1));
  expect(screen.getByRole('heading',{level:1})).toHaveTextContent('Async Workflow for Financial Report Calculation');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.posts()).toEqual([]);
  expect(screen.getByRole('group',{name:'Example of saved records'})).toHaveTextContent('execution_attempt');
  expect(document.body.textContent).not.toMatch(/LOCAL DEMO|Development demo|durable/i);
 });
 it('publishes all six reports in order on a normal close, using the real replies',async()=>{
  const {api,user}=mount();
  expect(screen.getByRole('group',{name:'Report dependency map'})).toHaveTextContent('Depreciation');
  await user.click(screen.getByRole('button',{name:'Run Normal close'}));
  const done=await dialog('All six reports published');
  expect(done).toHaveTextContent('6 reports published');
  expect(done).toHaveTextContent('10 jobs succeeded');
  expect(done).toHaveTextContent('5 reports locked the input');
  expect(api.datasets.map(d=>d.domain)).toEqual(['FAB_COST','CAPEX','INSURANCE','ONE_STD_COST','DPR','E2E_COST']);
 });
 it('pauses a lost response until the viewer recovers it, then proves there is no duplicate',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Lost reply'}));
  const paused=await dialog('The reply never arrived');
  expect(api.attempts).toHaveLength(2);// FAB_COST plus the lost CAPEX attempt.
  expect(api.attempts.at(-1)!.attemptStatus).toBe('DISPATCHING');
  await waitFor(()=>expect(nodes('Unknown').length).toBe(1));
  const before=api.posts().length;
  expect(within(paused).queryByRole('button',{name:'Close'})).not.toBeInTheDocument();
  await user.click(within(paused).getByRole('button',{name:'Check the same run'}));
  const done=await dialog('No duplicate run');
  expect(api.posts().length).toBeGreaterThan(before);
  expect(done).toHaveTextContent('This job has 1 try.');
  expect(done).toHaveTextContent('Capital spending v1 is PUBLISHED.');
 });
 it('keeps failed history and the frozen input when a retry follows a newer upstream',async()=>{
  const {user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Failed job and retry'}));
  const done=await dialog('Retried, with the failure on record');
  expect(done).toHaveTextContent('try 1 FAILED, try 2 SUCCEEDED');
  expect(done).toHaveTextContent('Fab cost v1');
  expect(done).toHaveTextContent('The newest is v2');
 });
 it('reports conflicting requests as an expected result, using the real replies',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  const done=await dialog('One winner, and the order held');
  expect(done).toHaveTextContent('1 created, 3 rejected with HTTP 409');
  expect(done).toHaveTextContent('Starting too early created 0 tries');
  expect(done).toHaveTextContent('A browser can’t prove');
  expect(api.datasets.filter(d=>d.domain==='CAPEX')).toHaveLength(1);
 });
 it('steps one command group per click and can be stopped',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Step through Lost reply'}));
  const next=await screen.findByRole('button',{name:'Next: Create the Capital spending report'});
  expect(api.datasets.map(d=>d.domain)).toEqual(['FAB_COST']);
  await user.click(next);
  await screen.findByRole('button',{name:'Next: Start a job and lose the reply'});
  expect(api.datasets.map(d=>d.domain)).toEqual(['FAB_COST','CAPEX']);
  await user.click(screen.getByRole('button',{name:'Stop'}));
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Run Lost reply'})).toBeEnabled();
 });
 it('uses a new reporting period on replay instead of colliding with saved data',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  await user.click(closeButton(await dialog('One winner, and the order held')));
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  await dialog('One winner, and the order held');
  expect(new Set(api.datasets.map(d=>d.period))).toEqual(new Set(['Q1','Q2']));
 });
 it('restores saved data on load with GETs only',async()=>{
  const api=new MockApi();const first=mount(api);
  await first.user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  await dialog('One winner, and the order held');
  const posts=api.posts().length;cleanup();
  mount(api);
  await screen.findAllByRole('button',{name:/^Details for (Capital spending|Fab cost)/});
  expect(api.posts().length).toBe(posts);
 });
 it('opens plain-language details when a box is selected',async()=>{
  const {user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Failed job and retry'}));
  await user.click(closeButton(await dialog('Retried, with the failure on record')));
  await user.click(screen.getAllByRole('button',{name:'Details for Try 1, Failed'})[0]!);
  const details=await dialog('Try 1 (execution_attempt)');
  expect(details).toHaveTextContent('A retry adds a new try');
  expect(details).toHaveTextContent('Run ID');
 });
 it('explains an unexpected failure in a dialog and tells the viewer what to do',async()=>{
  const api=new MockApi();api.override=(method,path)=>method==='POST'&&path.endsWith('/reconcile')?fail('EXECUTOR_STATUS_UNAVAILABLE',503):undefined;
  const {user}=mount(api);
  await user.click(screen.getByRole('button',{name:'Run Lost reply'}));
  const stopped=await dialog('The scenario stopped');
  expect(stopped).toHaveTextContent('The executor status isn’t available');
  expect(stopped).toHaveTextContent('EXECUTOR_STATUS_UNAVAILABLE');
 });
 it('never treats a lost browser response as success or retries it',async()=>{
  const api=new MockApi();let aborted=0;const real=api.fetch;
  api.fetch=async(input,init)=>{if(String(input).endsWith('/run')){aborted++;throw new Error('network down');}return real(input,init);};
  const {user}=mount(api);
  await user.click(screen.getByRole('button',{name:'Run Lost reply'}));
  const stopped=await dialog('The scenario stopped');
  expect(stopped).toHaveTextContent('the result is unknown');
  expect(aborted).toBe(1);
 });
 it('refuses to run on an environment without the Workflow configuration',async()=>{
  const api=new MockApi();api.admissionState='LEGACY_OPEN';
  const {user}=mount(api);
  await user.click(screen.getByRole('button',{name:'Run Lost reply'}));
  expect(await dialog('The scenario stopped')).toHaveTextContent('Workflow cutover');
  expect(api.datasets).toEqual([]);
 });
 it('clears data only after confirmation',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  await user.click(closeButton(await dialog('One winner, and the order held')));
  await user.click(screen.getByRole('button',{name:'Clear my demo data'}));
  const confirm=await dialog('Clear your demo data?');
  expect(api.session).not.toBeNull();
  await user.click(within(confirm).getByRole('button',{name:'Clear data'}));
  await waitFor(()=>expect(api.session).toBeNull());
  await screen.findByRole('group',{name:'Example of saved records'});
 });
 it('reports a session that ends mid-visit, without emptying silently',async()=>{
  const {api,user}=mount();
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  await user.click(closeButton(await dialog('One winner, and the order held')));
  api.session=null;
  await user.click(screen.getByRole('button',{name:'Run Conflicting requests'}));
  expect(await dialog('Your demo session ended')).toHaveTextContent('Run a scenario to start a new one');
 });
});
