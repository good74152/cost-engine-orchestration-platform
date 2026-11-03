import {describe,expect,it} from 'vitest';
import type {Attempt,Dataset,Job} from '../api/types';
import {nextReportingPeriod} from '../scenarios/scenarios';
import {MESSAGES} from '../i18n/messages';
import {DEFAULT_LINKS} from '../scenarios/labels';
import {buildSeriesTree,buildWorkflowMap,jobTitle,linksFromTemplate,statusLabel,toneOf} from './tree';

const dataset=(version:number,status:string):Dataset=>({datasetVersionId:'v'+version,datasetSeriesId:'s',domain:'CAPEX',fiscalYear:2026,period:'Q1',version,datasetStatus:status,createdAt:'2026-01-01T00:00:00Z',frozenInputs:version===2?[{domain:'FAB_COST',fiscalYear:2026,period:'Q1',version:3}]:[]});
const job=(id:string,code:string,status:string):Job=>({jobId:id,datasetVersionId:'v2',calculationTypeCode:code,jobStatus:status,createdAt:'',startedAt:null,finishedAt:null});
const attempt=(n:number,status:string):Attempt=>({executionAttemptId:'a'+n,attemptNumber:n,attemptStatus:status,createdAt:'',dispatchStartedAt:null,acceptedAt:null,finishedAt:null});

describe('dataset hierarchy',()=>{
 it('orders series → versions → jobs → attempts and shows frozen inputs on the version',()=>{
  const tree=buildSeriesTree('s',[dataset(2,'BUILDING'),dataset(1,'REJECTED')],{v2:[job('j2','DEMO_Z','RUNNING'),job('j1','DEMO_A','FAILED')]},{j1:[attempt(2,'ACCEPTED'),attempt(1,'FAILED')]},MESSAGES.en)!;
  expect(tree.data).toMatchObject({title:'Capital expenditure 2026 Q1',caption:'dataset_series'});
  expect(tree.children!.map(v=>v.data.title)).toEqual(['Version 1','Version 2']);
  const v2=tree.children![1]!;expect(v2.data.note).toBe('Input locked: Fab cost v3');
  expect(v2.children!.map(j=>j.data.title)).toEqual(['A','Z']);
  expect(v2.children![0]!.children!.map(a=>[a.data.title,a.data.tone])).toEqual([['Try 1','bad'],['Try 2','active']]);
 });
 it('returns nothing for a series with no versions',()=>expect(buildSeriesTree('x',[],{},{},MESSAGES.en)).toBeNull());
 it('treats an unknown dispatch as unknown, not failed',()=>{expect(toneOf('DISPATCHING')).toBe('unknown');expect(toneOf('FAILED')).toBe('bad');});
 it('turns job codes into plain words',()=>{expect(jobTitle('DEMO_CAPEX_TABLE_Y','CAPEX')).toBe('Table Y');expect(jobTitle('DEMO_GUIDED_SUMMARY','CAPEX')).toBe('Summary');});
});
describe('workflow map',()=>{
 it('reads links from template prerequisites',()=>{
  expect(linksFromTemplate({steps:[
   {id:'a.create',domain:'A',operation:'CREATE_DATASET',prerequisites:[]},{id:'a.publish',domain:'A',operation:'PUBLISH_DATASET',prerequisites:['a.create']},
   {id:'b.create',domain:'B',operation:'CREATE_DATASET',prerequisites:['a.publish']},
  ]})).toEqual({A:null,B:'A'});
 });
 it('draws a tree from the links, with status from the selected period',()=>{
  const map=buildWorkflowMap(DEFAULT_LINKS,[{...dataset(1,'PUBLISHED'),domain:'FAB_COST',datasetSeriesId:'fab'}])!;
  expect(map.data).toMatchObject({label:'Fab cost',status:'PUBLISHED',tone:'good',seriesId:'fab'});
  expect(map.children!.map(c=>c.data.domain)).toEqual(['CAPEX','INSURANCE','ONE_STD_COST']);
  expect(map.children![0]!.children![0]!.data).toMatchObject({label:'Depreciation',status:null,seriesId:null});
 });
 it('says "unknown" for a try with no answer, not failed',()=>expect(statusLabel('DISPATCHING')).toBe('Unknown'));
});
describe('Chinese text',()=>{
 it('has no full stops, as the System Owner asked',()=>{
  const text=(value:unknown):string[]=>typeof value==='string'?[value]:typeof value==='function'?[String((value as (...args:unknown[])=>unknown)(1,2,'x'))]:Array.isArray(value)?value.flatMap(text):value&&typeof value==='object'?Object.values(value).flatMap(text):[];
  expect(text(MESSAGES['zh-TW']).filter(line=>line.includes('。'))).toEqual([]);
 });
});
describe('reporting period',()=>{
 it('finds the first period this session has not used',()=>{
  expect(nextReportingPeriod([])).toEqual({fiscalYear:2026,period:'Q1'});
  expect(nextReportingPeriod([{fiscalYear:2026,period:'Q1'},{fiscalYear:2026,period:'Q2'}])).toEqual({fiscalYear:2026,period:'Q3'});
  expect(nextReportingPeriod(['Q1','Q2','Q3','Q4'].map(period=>({fiscalYear:2026,period})))).toEqual({fiscalYear:2027,period:'Q1'});
 });
});
