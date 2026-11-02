import {DataView} from 'primereact/dataview';
import {OrganizationChart} from 'primereact/organizationchart';
import type {Dataset} from '../api/types';
import {useDemo} from '../app/demo-context';
import {buildSeriesTree,EXPLANATIONS,inputsLabel,PREVIEW_TREE,toneOf,type ChartData,type ChartNode} from './tree';

function ChartCard({node,onOpen}:{node:ChartNode;onOpen?:(data:ChartData)=>void}){
 const d=node.data;
 const body=<><strong>{d.title}</strong>{d.status&&<span className="node-status">{d.status}</span>}<small>{d.caption}</small>{d.note&&<em>{d.note}</em>}</>;
 return onOpen?<button type="button" className={'node tone-'+d.tone} data-kind={d.kind} onClick={()=>onOpen(d)} aria-label={'Details for '+d.title+(d.status?', '+d.status:'')}>{body}</button>:
  <div className={'node tone-'+d.tone} data-kind={d.kind}>{body}</div>;
}

function VersionCard({dataset,selected,onSelect}:{dataset:Dataset;selected:boolean;onSelect:()=>void}){
 const inputs=inputsLabel(dataset);
 return <button type="button" className={'version-card tone-'+toneOf(dataset.datasetStatus)} aria-pressed={selected} onClick={onSelect}>
  <strong>{dataset.domain} v{dataset.version}</strong><span>{dataset.fiscalYear} {dataset.period}</span>
  <span className="version-status">{dataset.datasetStatus}</span>{inputs&&<small>{inputs}</small>}
 </button>;
}

export function Workspace(){
 const {model,session,datasets,jobs,attempts,selectedSeriesId,calls,playback,runIds,clearing}=useDemo();
 const tree=selectedSeriesId?buildSeriesTree(selectedSeriesId,datasets,jobs,attempts):null;
 const ordered=[...datasets].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const open=(d:ChartData)=>{
  const rows:[string,string][]=[];
  if(d.status)rows.push(['Status',d.status]);
  if(d.note)rows.push(['Inputs',d.note.replace('Inputs frozen: ','')]);
  if(d.id)rows.push(['ID',d.id]);
  const run=d.id?runIds[d.id]:undefined;if(run)rows.push(['Run ID',run]);
  for(const [label,value] of d.times??[])if(value)rows.push([label,new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium'})]);
  model.openDetails({kind:'details',title:d.title+' ('+d.caption+')',explanation:EXPLANATIONS[d.kind],rows});
 };
 const busy=!!playback&&['running','paused'].includes(playback.status);
 return <section className="workspace" id="workspace" aria-labelledby="workspace-title">
  <div className="workspace-head">
   <h2 id="workspace-title">What the database holds</h2>
   {session&&<button type="button" className="link-button" disabled={busy||clearing} onClick={model.askToClear}>Clear my demo data</button>}
  </div>
  {datasets.length>0&&<DataView value={ordered} layout="grid" dataKey="datasetVersionId"
   itemTemplate={(d:Dataset)=><VersionCard dataset={d} selected={d.datasetSeriesId===selectedSeriesId} onSelect={()=>model.selectSeries(d.datasetSeriesId)}/>}/>}
  <div className="chart-scroll" tabIndex={0} role="group" aria-label={tree?'Dataset hierarchy for '+tree.data.title:'Example of the dataset hierarchy'}>
   <OrganizationChart value={[tree??PREVIEW_TREE]} nodeTemplate={(n:ChartNode)=><ChartCard node={n} {...(tree?{onOpen:open}:{})}/>}/>
  </div>
  {tree?<p className="hint">Select a box to see its IDs and timestamps. Colors show status: green succeeded, blue in progress, amber unknown, red failed.</p>:
   <p className="hint">This is an example of the hierarchy. It fills with real rows from PostgreSQL once you run a scenario.</p>}
  {calls.length>0&&<details className="calls"><summary>API commands sent ({calls.length})</summary>
   <ol>{calls.map((c,i)=><li key={i}><span className={c.status>=400||c.status===0?'call-status bad':c.status===202?'call-status unknown':'call-status'}>{c.status||'No reply'}</span>
    <code>POST {c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g,m=>m.slice(0,8))}</code>{c.detail&&<span className="call-detail">{c.detail}</span>}{c.code&&<span className="call-detail">{c.code}</span>}</li>)}</ol>
  </details>}
 </section>;
}
