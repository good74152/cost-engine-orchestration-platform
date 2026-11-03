import type {Attempt,Dataset,Job,WorkflowTemplate} from '../api/types';
import type {Messages} from '../i18n/messages';
import {domainLabel,type WorkflowLinks} from '../scenarios/labels';

export type Tone='neutral'|'active'|'good'|'bad'|'unknown';
export type NodeKind='series'|'version'|'job'|'attempt';
export interface ChartData {kind:NodeKind;title:string;caption:string;status?:string;tone:Tone;note?:string;id?:string;times?:[string,string|null][]}
export interface ChartNode {key:string;expanded:true;data:ChartData;children?:ChartNode[]}
export interface MapData {domain:string;label:string;status:string|null;tone:Tone;seriesId:string|null}
export interface MapNode {key:string;expanded:true;data:MapData;children?:MapNode[]}

const TONES:Record<string,Tone>={PUBLISHED:'good',SUCCEEDED:'good',FAILED:'bad',REJECTED:'bad',DISPATCH_FAILED:'bad',DISPATCHING:'unknown',
 BUILDING:'active',VALIDATING:'active',RUNNING:'active',ACCEPTED:'active'};
export const toneOf=(status:string):Tone=>TONES[status]??'neutral';
const STATUS_LABELS:Record<string,string>={DRAFT:'Draft',BUILDING:'In progress',VALIDATING:'Being approved',PUBLISHED:'Published',REJECTED:'Rejected',ABANDONED:'Abandoned',
 PENDING:'Waiting',RUNNING:'Running',SUCCEEDED:'Succeeded',FAILED:'Failed',PREPARED:'Prepared',DISPATCHING:'Unknown',ACCEPTED:'Running',DISPATCH_FAILED:'Rejected by job system'};
export const statusLabel=(status:string)=>STATUS_LABELS[status]??status;
/** DEMO_CAPEX_TABLE_Y becomes "Table Y". The raw code stays in the details dialog. */
export function jobTitle(code:string,domain=''){
 const words=code.replace(/^DEMO_/,'').replace(new RegExp('^'+domain+'_'),'').split('_');
 return words.map(w=>w.charAt(0)+w.slice(1).toLowerCase()).join(' ');
}
export const inputsLabel=(d:Dataset,m:Messages)=>d.frozenInputs.length?m.workspace.inputLocked(d.frozenInputs.map(i=>domainLabel(i.domain)+' v'+i.version).join(', ')):undefined;

/** Reads the template's prerequisites, so the page doesn't define the workflow itself. */
export function linksFromTemplate(template:WorkflowTemplate):WorkflowLinks{
 const domainOf=new Map(template.steps.map(s=>[s.id,s.domain]));const links:WorkflowLinks={};
 for(const step of template.steps)if(step.operation==='CREATE_DATASET')links[step.domain]=domainOf.get(step.prerequisites[0]??'')??null;
 return links;
}
export function buildWorkflowMap(links:WorkflowLinks,inPeriod:Dataset[]):MapNode|null{
 const node=(domain:string):MapNode=>{
  const latest=inPeriod.filter(d=>d.domain===domain).sort((a,b)=>b.version-a.version)[0];
  const children=Object.keys(links).filter(d=>links[d]===domain).map(node);
  return {key:domain,expanded:true,data:{domain,label:domainLabel(domain),status:latest?.datasetStatus??null,tone:latest?toneOf(latest.datasetStatus):'neutral',seriesId:latest?.datasetSeriesId??null},...(children.length?{children}:{})};
 };
 const root=Object.keys(links).find(d=>links[d]===null);
 return root?node(root):null;
}

/** Reads one report into dataset_series → dataset_version → calculation_job → execution_attempt. */
export function buildSeriesTree(seriesId:string,datasets:Dataset[],jobs:Record<string,Job[]>,attempts:Record<string,Attempt[]>,m:Messages):ChartNode|null{
 const versions=datasets.filter(d=>d.datasetSeriesId===seriesId).sort((a,b)=>a.version-b.version);const first=versions[0];
 if(!first)return null;
 return {key:seriesId,expanded:true,data:{kind:'series',title:domainLabel(first.domain)+' '+first.fiscalYear+' '+first.period,caption:'dataset_series',tone:'neutral',id:seriesId},
  children:versions.map(v=>{const note=inputsLabel(v,m);return {key:v.datasetVersionId,expanded:true as const,
   data:{kind:'version' as const,title:'Version '+v.version,caption:'dataset_version',status:v.datasetStatus,tone:toneOf(v.datasetStatus),id:v.datasetVersionId,times:[[m.details.created,v.createdAt]],...(note?{note}:{})},
   children:(jobs[v.datasetVersionId]??[]).slice().sort((a,b)=>a.calculationTypeCode.localeCompare(b.calculationTypeCode)).map(j=>({key:j.jobId,expanded:true as const,
    data:{kind:'job' as const,title:jobTitle(j.calculationTypeCode,v.domain),caption:'calculation_job',status:j.jobStatus,tone:toneOf(j.jobStatus),id:j.jobId,times:[[m.details.started,j.startedAt],[m.details.finished,j.finishedAt]]},
    children:(attempts[j.jobId]??[]).slice().sort((a,b)=>a.attemptNumber-b.attemptNumber).map(a=>({key:a.executionAttemptId,expanded:true as const,
     data:{kind:'attempt' as const,title:'Try '+a.attemptNumber,caption:'execution_attempt',status:a.attemptStatus,tone:toneOf(a.attemptStatus),id:a.executionAttemptId,times:[[m.details.created,a.createdAt],[m.details.accepted,a.acceptedAt],[m.details.finished,a.finishedAt]]},
    })),
   })),
  };}),
 };
}

/** Shown before anything has run, so the hierarchy explains itself. */
export const previewTree=(m:Messages):ChartNode=>({key:'series',expanded:true,data:{kind:'series',title:m.workspace.oneReport,caption:'dataset_series',tone:'neutral'},children:[
 {key:'version',expanded:true,data:{kind:'version',title:'Version 1',caption:'dataset_version',tone:'neutral'},children:[
  {key:'job-a',expanded:true,data:{kind:'job',title:'Job A',caption:'calculation_job',tone:'neutral'},children:[
   {key:'attempt-a1',expanded:true,data:{kind:'attempt',title:'Try 1',caption:'execution_attempt',tone:'neutral'}},
   {key:'attempt-a2',expanded:true,data:{kind:'attempt',title:'Try 2',caption:'execution_attempt',tone:'neutral'}},
  ]},
  {key:'job-b',expanded:true,data:{kind:'job',title:'Job B',caption:'calculation_job',tone:'neutral'},children:[
   {key:'attempt-b1',expanded:true,data:{kind:'attempt',title:'Try 1',caption:'execution_attempt',tone:'neutral'}},
  ]},
 ]},
]});
