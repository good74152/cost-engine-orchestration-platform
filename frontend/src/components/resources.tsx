import {Link} from 'react-router-dom';
import type {Dataset,Job,Attempt} from '../api/types';
import {useDemo} from '../app/demo-context';
import {Button,StatusBadge,Identity,EmptyState,date,Icon} from './ui';
export function DatasetCard({dataset}:{dataset:Dataset}){
 return <Link to={'/datasets/'+dataset.datasetVersionId} className="dataset-card"><div className="row"><span className="icon-box"><Icon name="layers"/></span><StatusBadge status={dataset.datasetStatus}/></div>
 <h3>{dataset.domain} <span className="muted">/ {dataset.fiscalYear} {dataset.period}</span></h3><div className="row"><span className="muted">Version {dataset.version}</span><span className="text-link">Inspect dataset →</span></div>
 <code className="id-line">{dataset.datasetVersionId}</code><small className="muted">Created {date(dataset.createdAt)}</small></Link>;
}
export function AttemptCard({attempt,manual=false}:{attempt:Attempt;manual?:boolean}){
 const {model,busy,loading,scenario}=useDemo();const active=['DISPATCHING','ACCEPTED'].includes(attempt.attemptStatus);
 return <div className="attempt-card" data-testid="attempt-card"><div className="row"><h4>Attempt {attempt.attemptNumber}</h4><StatusBadge status={attempt.attemptStatus}/></div>
 <Identity label="Attempt ID" value={attempt.executionAttemptId}/><div className="times"><span>Created <b>{date(attempt.createdAt)}</b></span><span>Accepted <b>{date(attempt.acceptedAt)}</b></span><span>Finished <b>{date(attempt.finishedAt)}</b></span></div>
 {manual&&!scenario&&<div className="actions"><Button variant="secondary" disabled={busy||loading||!active} onClick={()=>void model.manual('/demo/execution-attempts/'+attempt.executionAttemptId+'/fake-state',{state:'SUCCEEDED'},'Fake success acknowledged. PostgreSQL changes only after reconciliation.')}>Set fake success</Button>
 <Button variant="secondary" disabled={busy||loading||!active} onClick={()=>void model.manual('/demo/execution-attempts/'+attempt.executionAttemptId+'/fake-state',{state:'FAILED'},'Fake failure acknowledged. PostgreSQL changes only after reconciliation.')}>Set fake failure</Button></div>}
 </div>;
}
export function CalculationJobCard({job,manual=false}:{job:Job;manual?:boolean}){
 const {model,attempts,busy,loading,scenario}=useDemo();const history=attempts[job.jobId]??[];
 const active=history.find(a=>['PREPARED','DISPATCHING','ACCEPTED'].includes(a.attemptStatus));
 return <section className="job-card"><div className="row"><div><p className="eyebrow">Calculation job</p><h3>{job.calculationTypeCode}</h3></div><StatusBadge status={job.jobStatus}/></div>
 <Identity label="Job ID" value={job.jobId}/><div className="times"><span>Started <b>{date(job.startedAt)}</b></span><span>Finished <b>{date(job.finishedAt)}</b></span></div>
 {manual&&!scenario&&<div className="actions"><Button disabled={busy||loading||!['PENDING','FAILED'].includes(job.jobStatus)} onClick={()=>void model.manual('/demo/calculation-jobs/'+job.jobId+'/run')}>
 {active?.attemptStatus==='DISPATCHING'?'Recover dispatch':job.jobStatus==='FAILED'?'Retry calculation':'Run calculation'}</Button>
 <Button variant="secondary" disabled={busy||loading||!active||active.attemptStatus==='PREPARED'} onClick={()=>void model.manual('/demo/calculation-jobs/'+job.jobId+'/reconcile')}>Reconcile</Button></div>}
 <div className="attempt-heading"><h4>Execution attempt history</h4><span className="count">{history.length}</span></div>
 {history.length?history.map(a=><AttemptCard key={a.executionAttemptId} attempt={a} manual={manual}/>):<EmptyState title="No execution attempts">Run this calculation to prepare its first attempt.</EmptyState>}
 </section>;
}
