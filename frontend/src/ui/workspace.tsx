import {OrganizationChart} from 'primereact/organizationchart';
import {useDemo} from '../app/demo-context';
import {domainLabel} from '../scenarios/labels';
import {buildSeriesTree,buildWorkflowMap,EXPLANATIONS,inputsLabel,PREVIEW_TREE,statusLabel,type ChartData,type ChartNode,type MapNode} from './tree';

function RecordBox({node,onOpen}:{node:ChartNode;onOpen?:(data:ChartData)=>void}){
 const d=node.data;const status=d.status?statusLabel(d.status):undefined;
 const body=<><strong>{d.title}</strong>{status&&<span className="node-status">{status}</span>}<small translate="no">{d.caption}</small>{d.note&&<em>{d.note}</em>}</>;
 return onOpen?<button type="button" className={'node tone-'+d.tone} data-kind={d.kind} onClick={()=>onOpen(d)} aria-label={'Details for '+d.title+(status?', '+status:'')}>{body}</button>:
  <div className={'node tone-'+d.tone} data-kind={d.kind}>{body}</div>;
}
function ReportBox({node,selected,onSelect}:{node:MapNode;selected:boolean;onSelect:(id:string)=>void}){
 const d=node.data;const status=d.status?statusLabel(d.status):'Not started';const id=d.seriesId;
 const body=<><strong>{d.label}</strong><span className="node-status">{status}</span><small translate="no">{d.domain}</small></>;
 return id?<button type="button" className={'node tone-'+d.tone+(selected?' selected':'')} aria-pressed={selected} aria-label={'Show '+d.label+', '+status} onClick={()=>onSelect(id)}>{body}</button>:
  <div className={'node tone-'+d.tone}>{body}</div>;
}

const periodKey=(d:{fiscalYear:number;period:string})=>d.fiscalYear+' '+d.period;

export function Workspace(){
 const {model,session,datasets,jobs,attempts,links,selectedSeriesId,calls,playback,runIds,clearing}=useDemo();
 const selected=datasets.find(d=>d.datasetSeriesId===selectedSeriesId);
 const periods=[...new Set(datasets.map(periodKey))].sort();
 const period=selected?periodKey(selected):periods.at(-1);
 const inPeriod=datasets.filter(d=>periodKey(d)===period);
 const map=buildWorkflowMap(links,inPeriod);
 const tree=selectedSeriesId?buildSeriesTree(selectedSeriesId,datasets,jobs,attempts):null;
 const open=(d:ChartData)=>{
  const rows:[string,string][]=[];
  if(d.status)rows.push(['Status',d.status]);
  if(d.note)rows.push(['Input',d.note.replace('Input locked: ','')]);
  if(d.id)rows.push(['ID',d.id]);
  const run=d.id?runIds[d.id]:undefined;if(run)rows.push(['Run ID',run]);
  for(const [label,value] of d.times??[])if(value)rows.push([label,new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium'})]);
  model.openInfo({title:d.title+' ('+d.caption+')',paragraphs:[EXPLANATIONS[d.kind]],rows});
 };
 const showPeriod=(key:string)=>{const inNew=datasets.filter(d=>periodKey(d)===key);const pick=inNew.find(d=>d.domain==='CAPEX')??inNew[0];if(pick)model.selectSeries(pick.datasetSeriesId);};
 const busy=!!playback&&['running','paused'].includes(playback.status);
 return <div className="workspace">
  <section aria-labelledby="map-title">
   <div className="panel-head"><div><h3 id="map-title">Six reports that depend on each other</h3><p>Each waits for the one above it.</p></div>
    {periods.length>1&&<label className="period">Period <select value={period} disabled={busy} onChange={e=>showPeriod(e.target.value)}>{periods.map(p=><option key={p}>{p}</option>)}</select></label>}
   </div>
   {map&&<div className="chart-scroll" tabIndex={0} role="group" aria-label="Report dependency map">
    <OrganizationChart value={[map]} nodeTemplate={(n:MapNode)=><ReportBox node={n} selected={n.data.seriesId===selectedSeriesId} onSelect={model.selectSeries}/>}/>
   </div>}
  </section>
  <section aria-labelledby="records-title">
   <div className="panel-head"><div><h3 id="records-title">{tree?'What the database saved for '+domainLabel(selected!.domain):'What the database saves for one report'}</h3>
    {selected&&inputsLabel(selected)?<p>{inputsLabel(selected)}</p>:null}</div>
    {session&&<button type="button" className="link-button" disabled={busy||clearing} onClick={model.askToClear}>Clear my demo data</button>}
   </div>
   <div className="chart-scroll" tabIndex={0} role="group" aria-label={tree?'Saved records for '+tree.data.title:'Example of saved records'}>
    <OrganizationChart value={[tree??PREVIEW_TREE]} nodeTemplate={(n:ChartNode)=><RecordBox node={n} {...(tree?{onOpen:open}:{})}/>}/>
   </div>
   <p className="hint">{tree?'Click a box for details. Green: done. Blue: in progress. Amber: unknown. Red: failed.':'An example. Real rows from PostgreSQL appear when you run a scenario.'}</p>
   {calls.length>0&&<details className="calls"><summary>API commands sent ({calls.length})</summary>
    <ol>{calls.map((c,i)=><li key={i}><span className={c.status>=400||c.status===0?'call-status bad':c.status===202?'call-status unknown':'call-status'}>{c.status||'No reply'}</span>
     <code>POST {c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g,m=>m.slice(0,8))}</code>{c.detail&&<span className="call-detail">{c.detail}</span>}{c.code&&<span className="call-detail">{c.code}</span>}</li>)}</ol>
   </details>}
  </section>
 </div>;
}
