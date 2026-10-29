import {useEffect,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {useDemo} from '../../app/demo-context';
import type {DatasetDetail,JobDetail} from '../../api/types';
import {Button,PageHeading,EmptyState,Identity,StatusBadge,date,LoadingState} from '../../components/ui';
import {DatasetCard,CalculationJobCard} from '../../components/resources';
import {SessionRequired} from '../sessions/session-card';
import {errorMessage} from '../../api/client';
export function DatasetsPage(){
 const {session,datasets}=useDemo();const [count,setCount]=useState(9);
 if(!session)return <SessionRequired/>;
 return <><PageHeading eyebrow="Resource explorer" title="Datasets, jobs & attempts" description="Session-owned resources from PostgreSQL. All backend cursor pages are read; no live fake state is inferred."/>
 <div className="section-heading"><h3>{datasets.length} dataset versions</h3><span className="small muted">Your company scope only</span></div>
 {datasets.length?<><div className="dataset-grid">{datasets.slice(0,count).map(d=><DatasetCard key={d.datasetVersionId} dataset={d}/>)}</div>{count<datasets.length&&<Button variant="secondary" onClick={()=>setCount(c=>c+9)}>Show more datasets</Button>}</>:<EmptyState title="No datasets yet">Start a guided scenario or create a dataset in <Link to="/exploration">Free Exploration</Link>.</EmptyState>}</>;
}
export function DatasetPage(){
 const {id}=useParams();const {model,session,jobs,datasets,loading}=useDemo();const [detail,setDetail]=useState<DatasetDetail|null>(null);const [problem,setProblem]=useState<string|null>(null);
 const dataset=datasets.find(d=>d.datasetVersionId===id);
 useEffect(()=>{let active=true;setDetail(null);setProblem(null);if(!session||!id)return;
  void model.api.get<DatasetDetail>('/demo/dataset-versions/'+encodeURIComponent(id)).then(async d=>{
   // Exercise owned detail contracts as well as paged list DTOs.
   for(const job of jobs[id]??[])await model.api.get<JobDetail>('/demo/calculation-jobs/'+job.jobId);
   if(active)setDetail(d);
  }).catch(e=>{if(active)setProblem(errorMessage(e).message);});return()=>{active=false;};
 },[id,session?.sessionId,dataset?.datasetStatus,jobs,model]);
 if(!session)return <SessionRequired/>;
 if(problem)return <EmptyState title="Dataset unavailable">{problem}</EmptyState>;
 if(!dataset)return loading?<LoadingState/>:<EmptyState title="Dataset unavailable">This Dataset is not in the current Session's resource list.</EmptyState>;
 if(!detail)return <LoadingState/>;
 return <><PageHeading eyebrow="Dataset detail" title={detail.domain+' / '+detail.fiscalYear+' '+detail.period+' / v'+detail.version} description="Persisted lifecycle and complete calculation-job history." action={<StatusBadge status={detail.datasetStatus}/>}/>
 <section className="panel"><Identity label="Dataset version ID" value={detail.datasetVersionId}/><Identity label="Dataset series ID" value={detail.datasetSeriesId}/>
 <div className="times">{(['createdAt','buildingStartedAt','validatingAt','publishedAt','rejectedAt','abandonedAt'] as const).map(key=><span key={key}>{key.replace(/([A-Z])/g,' $1')}<b>{date(detail[key])}</b></span>)}</div></section>
 <div className="section-heading"><h2>Calculation jobs</h2><Link to="/exploration" className="text-link">Open operations →</Link></div>
 {loading&&<LoadingState/>}{(jobs[detail.datasetVersionId]??[]).map(j=><CalculationJobCard key={j.jobId} job={j}/>)}</>;
}
