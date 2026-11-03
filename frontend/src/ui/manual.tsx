import {Column} from 'primereact/column';
import {DataTable} from 'primereact/datatable';
import {Dropdown} from 'primereact/dropdown';
import type {Attempt,Dataset,Job} from '../api/types';
import {useDemo} from '../app/demo-context';
import type {VersionCommand} from '../app/controller';
import {DOMAIN_LABELS,domainLabel} from '../scenarios/labels';
import {jobTitle,statusLabel,toneOf} from './tree';

const STARTING_YEARS=[2026,2027];
const QUARTERS=['Q1','Q2','Q3','Q4'];
const periodKey=(d:{fiscalYear:number;period:string})=>d.fiscalYear+' '+d.period;
const shortId=(id:string)=>id.slice(0,8);
const clock=(value:string|null)=>value?new Date(value).toLocaleTimeString(document.documentElement.lang,{hour12:false}):'—';
const Status=({value}:{value:string})=><span className={'status tone-'+toneOf(value)}>{statusLabel(value)}</span>;
const Name=({title,sub}:{title:string;sub:string})=><span className="cell-name"><strong>{title}</strong><small translate="no">{sub}</small></span>;

/** The rules stay in the backend: buttons are never disabled by status, only while a request is in flight. */
export function ManualPanel(){
 const {model,manual,session,datasets,jobs,attempts,links,runIds,calls,clearing}=useDemo();
 if(!manual)return null;
 const m=model.messages();const t=m.manual;const w=m.workspace;
 const busy=manual.busy||clearing;
 const periods=[...new Set([...STARTING_YEARS.flatMap(y=>QUARTERS.map(q=>y+' '+q)),...datasets.map(periodKey)])].sort();
 const inPeriod=datasets.filter(d=>periodKey(d)===manual.periodKey);
 const versions=inPeriod.filter(d=>d.domain===manual.domain).sort((a,b)=>b.version-a.version);
 const version=versions.find(v=>v.datasetVersionId===manual.versionId)??versions[0]??null;
 const jobList=version?(jobs[version.datasetVersionId]??[]).slice().sort((a,b)=>a.calculationTypeCode.localeCompare(b.calculationTypeCode)):[];
 const job=jobList.find(j=>j.jobId===manual.jobId)??jobList[0]??null;
 const tries=job?(attempts[job.jobId]??[]).slice().sort((a,b)=>b.attemptNumber-a.attemptNumber):[];
 const upstream=links[manual.domain]??null;
 const upstreamVersion=upstream?inPeriod.filter(d=>d.domain===upstream&&d.datasetStatus==='PUBLISHED').sort((a,b)=>b.version-a.version)[0]:undefined;
 const command=(d:Dataset,name:VersionCommand,label:string)=><button type="button" className="button quiet small" disabled={busy} onClick={()=>void model.versionCommand(d.datasetVersionId,name)}>{label}</button>;
 const domains=Object.keys(DOMAIN_LABELS).map(value=>({value,label:domainLabel(value)}));
 return <div className="manual">
  <div className="panel-head"><div><h3>{t.title}</h3><p>{t.lead}</p></div></div>
  <div className="manual-filters">
   <div className="field"><span>{t.domain}</span><Dropdown value={manual.domain} options={domains} disabled={busy} scrollHeight="280px" ariaLabel={t.domain} aria-label={t.domain} onChange={e=>model.setManualFilter({domain:String(e.value)})}/></div>
   <div className="field"><span>{t.period}</span><Dropdown value={manual.periodKey} options={periods.map(value=>({value,label:value}))} disabled={busy} scrollHeight="280px" ariaLabel={t.period} aria-label={t.period} onChange={e=>model.setManualFilter({periodKey:String(e.value)})}/></div>
   <button type="button" className="button" disabled={busy} onClick={()=>void model.createVersion()}>{t.create}</button>
   {session&&<button type="button" className="link-button manual-clear" disabled={busy} onClick={model.askToClear}>{w.clear}</button>}
  </div>
  <p className="manual-upstream">{upstream?t.upstream(domainLabel(upstream),upstreamVersion?t.published(upstreamVersion.version):t.notPublished):t.noUpstream}</p>
  <p className="manual-status" role="status" aria-live="polite">{manual.message}</p>

  <section aria-labelledby="versions-title">
   <h4 id="versions-title">{t.versions} <code translate="no">dataset_version</code></h4>
   <div className="table-scroll"><DataTable className="data-table" cellMemo={false} value={versions} dataKey="datasetVersionId" selectionMode="single" selection={version} metaKeySelection={false}
    onSelectionChange={e=>{const row=e.value as Dataset|null;if(row)model.selectManualVersion(row.datasetVersionId);}} emptyMessage={t.noVersions}>
    <Column header={t.columns.version} body={(d:Dataset)=><Name title={'Version '+d.version} sub={shortId(d.datasetVersionId)}/>}/>
    <Column header={t.columns.status} body={(d:Dataset)=><Status value={d.datasetStatus}/>}/>
    <Column header={t.columns.input} body={(d:Dataset)=>d.frozenInputs.length?d.frozenInputs.map(i=>domainLabel(i.domain)+' v'+i.version).join(', '):'—'}/>
    <Column header={t.columns.created} body={(d:Dataset)=>clock(d.createdAt)}/>
    <Column header={t.columns.actions} body={(d:Dataset)=><div className="row-actions">{command(d,'submit-validation',t.submit)}{command(d,'publish',t.publish)}{command(d,'reject',t.reject)}{command(d,'abandon',t.abandon)}</div>}/>
   </DataTable></div>
  </section>

  <section aria-labelledby="jobs-title">
   <h4 id="jobs-title">{t.jobs} <code translate="no">calculation_job</code></h4>
   <div className="table-scroll"><DataTable className="data-table" cellMemo={false} value={jobList} dataKey="jobId" selectionMode="single" selection={job} metaKeySelection={false}
    onSelectionChange={e=>{const row=e.value as Job|null;if(row)model.selectManualJob(row.jobId);}} emptyMessage={t.noJobs}>
    <Column header={t.columns.job} body={(j:Job)=><Name title={jobTitle(j.calculationTypeCode,manual.domain)} sub={shortId(j.jobId)}/>}/>
    <Column header={t.columns.status} body={(j:Job)=><Status value={j.jobStatus}/>}/>
    <Column header={t.columns.started} body={(j:Job)=>clock(j.startedAt)}/>
    <Column header={t.columns.finished} body={(j:Job)=>clock(j.finishedAt)}/>
    <Column header={t.columns.actions} body={(j:Job)=>{const title=jobTitle(j.calculationTypeCode,manual.domain);return <div className="row-actions">
     <button type="button" className="button small" disabled={busy} aria-label={t.runLabel(title)} onClick={()=>model.askToRun(j.jobId,title)}>{t.run}</button>
     <button type="button" className="button quiet small" disabled={busy} aria-label={t.checkLabel(title)} onClick={()=>void model.checkResult(j.jobId,title)}>{t.check}</button></div>;}}/>
   </DataTable></div>
  </section>

  <section aria-labelledby="attempts-title">
   <h4 id="attempts-title">{t.attempts} <code translate="no">execution_attempt</code></h4>
   <div className="table-scroll"><DataTable className="data-table" cellMemo={false} value={tries} dataKey="executionAttemptId" emptyMessage={t.noAttempts}>
    <Column header={t.columns.attempt} body={(a:Attempt)=><Name title={'Try '+a.attemptNumber} sub={shortId(a.executionAttemptId)}/>}/>
    <Column header={t.columns.status} body={(a:Attempt)=><Status value={a.attemptStatus}/>}/>
    <Column header={t.columns.runId} body={(a:Attempt)=>{const run=runIds[a.executionAttemptId];return run?<code className="run-id" title={run} translate="no">{run}</code>:'—';}}/>
    <Column header={t.columns.accepted} body={(a:Attempt)=>clock(a.acceptedAt)}/>
    <Column header={t.columns.finished} body={(a:Attempt)=>clock(a.finishedAt)}/>
   </DataTable></div>
  </section>

  {calls.length>0&&<details className="calls"><summary>{w.commands(calls.length)}</summary>
   <ol>{calls.map((c,i)=><li key={i}><span className={c.status>=400||c.status===0?'call-status bad':c.status===202?'call-status unknown':'call-status'}>{c.status||w.noReply}</span>
    <code>POST {c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g,id=>id.slice(0,8))}</code>{c.detail&&<span className="call-detail">{c.detail}</span>}{c.code&&<span className="call-detail">{c.code}</span>}</li>)}</ol>
  </details>}
 </div>;
}
