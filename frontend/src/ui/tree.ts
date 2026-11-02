import type {Attempt,Dataset,Job} from '../api/types';

export type Tone='neutral'|'active'|'good'|'bad'|'unknown';
export type NodeKind='series'|'version'|'job'|'attempt';
export interface ChartData {kind:NodeKind;title:string;caption:string;status?:string;tone:Tone;note?:string;id?:string;times?:[string,string|null][]}
export interface ChartNode {key:string;expanded:true;data:ChartData;children?:ChartNode[]}

const TONES:Record<string,Tone>={PUBLISHED:'good',SUCCEEDED:'good',FAILED:'bad',REJECTED:'bad',DISPATCH_FAILED:'bad',DISPATCHING:'unknown',
 ABANDONED:'neutral',DRAFT:'neutral',PENDING:'neutral',PREPARED:'neutral',BUILDING:'active',VALIDATING:'active',RUNNING:'active',ACCEPTED:'active'};
export const toneOf=(status:string):Tone=>TONES[status]??'neutral';
/** DEMO_CAPEX_TABLE_Y becomes "Capex table y". The raw code stays in the details dialog. */
export function jobTitle(code:string){const words=code.replace(/^DEMO_/,'').replaceAll('_',' ').toLowerCase();return words.charAt(0).toUpperCase()+words.slice(1);}
export const inputsLabel=(d:Dataset)=>d.frozenInputs.length?'Inputs frozen: '+d.frozenInputs.map(i=>i.domain+' v'+i.version).join(', '):undefined;

export const EXPLANATIONS:Record<NodeKind,string>={
 series:'One report for one company and period. Requests that touch the same series take turns on this row, so version numbers are never reused.',
 version:'One build of that report, and the unit that gets published. Its inputs freeze at the first run.',
 job:'One calculation the version needs. The version can’t be validated until every job succeeds.',
 attempt:'One try at running a job. A retry adds an attempt, so failures stay in the history.',
};

/** Reads one series into dataset_series → dataset_version → calculation_job → execution_attempt. */
export function buildSeriesTree(seriesId:string,datasets:Dataset[],jobs:Record<string,Job[]>,attempts:Record<string,Attempt[]>):ChartNode|null{
 const versions=datasets.filter(d=>d.datasetSeriesId===seriesId).sort((a,b)=>a.version-b.version);const first=versions[0];
 if(!first)return null;
 return {key:seriesId,expanded:true,data:{kind:'series',title:first.domain+' '+first.fiscalYear+' '+first.period,caption:'dataset_series',tone:'neutral',id:seriesId},
  children:versions.map(v=>{const note=inputsLabel(v);return {key:v.datasetVersionId,expanded:true as const,
   data:{kind:'version' as const,title:'Version '+v.version,caption:'dataset_version',status:v.datasetStatus,tone:toneOf(v.datasetStatus),id:v.datasetVersionId,times:[['Created',v.createdAt]],...(note?{note}:{})},
   children:(jobs[v.datasetVersionId]??[]).slice().sort((a,b)=>a.calculationTypeCode.localeCompare(b.calculationTypeCode)).map(j=>({key:j.jobId,expanded:true as const,
    data:{kind:'job' as const,title:jobTitle(j.calculationTypeCode),caption:'calculation_job',status:j.jobStatus,tone:toneOf(j.jobStatus),id:j.jobId,times:[['Started',j.startedAt],['Finished',j.finishedAt]]},
    children:(attempts[j.jobId]??[]).slice().sort((a,b)=>a.attemptNumber-b.attemptNumber).map(a=>({key:a.executionAttemptId,expanded:true as const,
     data:{kind:'attempt' as const,title:'Attempt '+a.attemptNumber,caption:'execution_attempt',status:a.attemptStatus,tone:toneOf(a.attemptStatus),id:a.executionAttemptId,times:[['Created',a.createdAt],['Accepted',a.acceptedAt],['Finished',a.finishedAt]]},
    })),
   })),
  };}),
 };
}

/** Shown before anything has run, so the hierarchy explains itself. */
export const PREVIEW_TREE:ChartNode={key:'series',expanded:true,data:{kind:'series',title:'CAPEX 2026 Q1',caption:'dataset_series',tone:'neutral'},children:[
 {key:'version',expanded:true,data:{kind:'version',title:'Version 1',caption:'dataset_version',tone:'neutral'},children:[
  {key:'job-a',expanded:true,data:{kind:'job',title:'Table Y',caption:'calculation_job',tone:'neutral'},children:[
   {key:'attempt-a1',expanded:true,data:{kind:'attempt',title:'Attempt 1',caption:'execution_attempt',tone:'neutral'}},
   {key:'attempt-a2',expanded:true,data:{kind:'attempt',title:'Attempt 2',caption:'execution_attempt',tone:'neutral'}},
  ]},
  {key:'job-b',expanded:true,data:{kind:'job',title:'Summary',caption:'calculation_job',tone:'neutral'},children:[
   {key:'attempt-b1',expanded:true,data:{kind:'attempt',title:'Attempt 1',caption:'execution_attempt',tone:'neutral'}},
  ]},
 ]},
]};
