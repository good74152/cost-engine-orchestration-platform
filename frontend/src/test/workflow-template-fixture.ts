import type {WorkflowStep,WorkflowSummary,WorkflowTemplate} from '../api/types';

// Frontend test data only. Production UI still reads the Backend API; this file
// deliberately has no dependency on Backend source or its catalog implementation.
const step=(id:string,title:string,operation:WorkflowStep['operation'],domain:string,prerequisites:string[]):WorkflowStep=>({
 id,title,operation,domain,prerequisites,description:`Test operation: ${title}.`,expectedResult:`Inspect durable state after ${title}.`,
});
function publication(domain:string,prerequisites:string[]=[]):WorkflowStep[]{
 const p=domain.toLowerCase();
 return [
  step(p+'.create','Create '+domain,'CREATE_DATASET',domain,prerequisites),
  step(p+'.run','Run '+domain+' Jobs','RUN_JOB',domain,[p+'.create']),
  step(p+'.fake-success','Simulate '+domain+' success','SET_FAKE_STATE',domain,[p+'.run']),
  step(p+'.reconcile','Reconcile '+domain+' Jobs','RECONCILE_JOB',domain,[p+'.fake-success']),
  step(p+'.validate','Validate '+domain,'SUBMIT_VALIDATION',domain,[p+'.reconcile']),
  step(p+'.publish','Publish '+domain,'PUBLISH_DATASET',domain,[p+'.validate']),
 ];
}
const fab=publication('FAB_COST');const capex=publication('CAPEX',['fab_cost.publish']);
const template=(id:string,title:string,steps:WorkflowStep[]):WorkflowTemplate=>({
 id,title,version:2,availability:'PREVIEW',description:`Frontend test fixture for ${title}.`,steps,
});
const fixtures:WorkflowTemplate[]=[
 template('HAPPY_PATH','Happy Path',[...fab,...capex]),
 template('FAILURE_RETRY','Failure and Retry',[
  ...fab,capex[0]!,capex[1]!,
  step('capex.fake-failure','Simulate failure','SET_FAKE_STATE','CAPEX',['capex.run']),
  step('capex.reconcile-failure','Confirm failure','RECONCILE_JOB','CAPEX',['capex.fake-failure']),
  step('capex.retry','Retry the failed Job','RUN_JOB','CAPEX',['capex.reconcile-failure']),
  {...capex[2]!,prerequisites:['capex.retry']},capex[3]!,capex[4]!,capex[5]!,
 ]),
 template('LOST_RESPONSE_RECOVERY','Lost Response Recovery',[
  ...fab,capex[0]!,
  step('capex.run-lost-response','Run with a lost acknowledgement','RUN_JOB','CAPEX',['capex.create']),
  step('capex.recover','Recover the original execution','RUN_JOB','CAPEX',['capex.run-lost-response']),
  step('capex.run-other-jobs','Run every other CAPEX Job','RUN_JOB','CAPEX',['capex.recover']),
  {...capex[2]!,prerequisites:['capex.run-other-jobs']},capex[3]!,capex[4]!,capex[5]!,
 ]),
 template('SIX_DOMAIN_WORKFLOW','Six Domain Workflow',[
  ...fab,...capex,...publication('DPR',['capex.publish']),
  ...publication('INSURANCE',['fab_cost.publish']),...publication('ONE_STD_COST',['fab_cost.publish']),
  ...publication('E2E_COST',['one_std_cost.publish']),
 ]),
];
export function workflowFixtureList():WorkflowSummary[]{
 return fixtures.map(({steps:_steps,...summary})=>({...summary}));
}
export function workflowFixtureDetail(id:string):WorkflowTemplate|undefined{
 const found=fixtures.find(t=>t.id===id);return found?structuredClone(found):undefined;
}
