import {it,expect} from 'vitest';
import {MockApi} from './mock-api';
import type {AdmissionState,WorkflowCatalog,WorkflowTemplate} from '../api/types';

it.each(['LEGACY_OPEN','DRAINING','WORKFLOW_OPEN'] as AdmissionState[])('self-contained v2 fixtures preserve list/detail and prerequisite behavior in %s',async state=>{
 const api=new MockApi();api.admissionState=state;
 const list=await (await api.fetcher('/demo/workflow-templates')).json() as WorkflowCatalog;
 expect(list.admissionState).toBe(state);
 expect(list.templates.map(t=>t.id)).toEqual(['HAPPY_PATH','FAILURE_RETRY','LOST_RESPONSE_RECOVERY','SIX_DOMAIN_WORKFLOW']);
 const counts=[12,15,14,36];
 for(const [i,summary]of list.templates.entries()){
  expect(summary.version).toBe(2);expect(summary.availability).toBe(state==='WORKFLOW_OPEN'?'AVAILABLE':'PREVIEW');
  const {steps,...detail}=await (await api.fetcher('/demo/workflow-templates/'+summary.id)).json() as WorkflowTemplate;
  expect(detail).toEqual(summary);expect(steps).toHaveLength(counts[i]!);
  expect(new Set(steps.map(s=>s.id)).size).toBe(steps.length);
  const seen=new Set<string>();
  while(seen.size<steps.length){const ready=steps.filter(s=>!seen.has(s.id)&&s.prerequisites.every(id=>seen.has(id)));
   expect(ready.length).toBeGreaterThan(0);ready.forEach(s=>seen.add(s.id));}
  expect(steps.find(s=>s.id==='capex.create')!.prerequisites).toEqual(['fab_cost.publish']);
 }
});
