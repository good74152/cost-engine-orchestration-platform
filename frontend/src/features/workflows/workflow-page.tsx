import {useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {useDemo} from '../../app/demo-context';
import type {Dataset,Job,WorkflowStep} from '../../api/types';
import {Button,PageHeading,EmptyState,StatusBadge} from '../../components/ui';
import {DatasetCard,CalculationJobCard} from '../../components/resources';
import {SessionRequired} from '../sessions/session-card';
import {stepEvidence} from './workflow-model';

export function WorkflowCards(){
 const {catalog}=useDemo();
 return <div className="workflow-cards">{catalog?.templates.map(t=><Link className="panel workflow-template" key={t.id} to={'/workflows/'+encodeURIComponent(t.id)}>
  <div className="row"><span className="eyebrow">Version {t.version}</span><StatusBadge status={t.availability}/></div>
  <h3>{t.title}</h3><p className="muted">{t.description}</p><span className="text-link">Inspect template →</span>
 </Link>)}</div>;
}

function Operations({step,dataset,jobs}:{step:WorkflowStep;dataset:Dataset|undefined;jobs:Job[]}){
 const {model,attempts,busy,loading,ready,catalog,template,scenario}=useDemo();
 const [dispatch,setDispatch]=useState('ACCEPT');const [completion,setCompletion]=useState('RUNNING');
 const disabled=busy||loading||!ready||!!scenario||catalog?.admissionState!=='WORKFLOW_OPEN'||template?.availability!=='AVAILABLE';
 const command=(path:string,body:unknown={},notice?:string)=>void model.workflow(path,body,notice);
 if(!dataset)return <p className="muted">Create a Dataset explicitly or select an existing version above. Creation does not select or run other resources.</p>;
 if(step.operation==='CREATE_DATASET')return <p>The selected Dataset already exists. Use the creation form above for a new version when Core allows it.</p>;
 if(step.operation==='SUBMIT_VALIDATION'||step.operation==='PUBLISH_DATASET'){
  const validate=step.operation==='SUBMIT_VALIDATION';const allSucceeded=jobs.length>0&&jobs.every(j=>j.jobStatus==='SUCCEEDED');
  return <><p>{allSucceeded?'All required Jobs are durably SUCCEEDED.':'Every required Job must succeed before validation.'} Backend verifies every command.</p>
   <Button disabled={disabled||(validate?dataset.datasetStatus!=='BUILDING'||!allSucceeded:dataset.datasetStatus!=='VALIDATING')}
    onClick={()=>command('/demo/dataset-versions/'+dataset.datasetVersionId+(validate?'/submit-validation':'/publish'))}>
    {validate?'Submit validation':'Publish Dataset'}</Button></>;
 }
 return <>{step.operation==='RUN_JOB'&&<div className="workflow-simulation form-row"><label>Dispatch simulation<select aria-label="Dispatch simulation" disabled={disabled} value={dispatch} onChange={e=>setDispatch(e.target.value)}>
  <option value="ACCEPT">ACCEPT</option><option value="ACCEPT_THEN_UNKNOWN">ACCEPT_THEN_UNKNOWN · Lost response</option>
 </select></label><label>Completion simulation<select aria-label="Completion simulation" disabled={disabled} value={completion} onChange={e=>setCompletion(e.target.value)}>
  {['RUNNING','SUCCEEDED','FAILED'].map(s=><option key={s}>{s}</option>)}</select></label></div>}
 <p className="small muted">Operate one Job at a time. Simulation choices are explicit; existing execution decisions remain owned by Backend.</p>
 {jobs.map(job=>{const history=attempts[job.jobId]??[];const latest=history.at(-1);const unknown=latest?.attemptStatus==='DISPATCHING';
  const runnable=['DRAFT','BUILDING'].includes(dataset.datasetStatus)&&['PENDING','FAILED'].includes(job.jobStatus);
  return <section className="workflow-job" key={job.jobId} aria-label={'Operate '+job.calculationTypeCode}>
   <div className="row"><h4>{job.calculationTypeCode}</h4><StatusBadge status={job.jobStatus}/></div><code className="id-line">{job.jobId}</code>
   <div className="actions">{step.operation==='RUN_JOB'&&<Button disabled={disabled||!runnable} onClick={()=>command('/demo/calculation-jobs/'+job.jobId+'/run',
    {simulation:unknown?{dispatch:'ACCEPT',completion:'RUNNING'}:{dispatch,completion}})}>
    {unknown?'Recover original Job':job.jobStatus==='FAILED'?'Retry Job':'Run Job'}</Button>}
   {step.operation==='SET_FAKE_STATE'&&(['SUCCEEDED','FAILED'] as const).map(state=><Button key={state} variant="secondary"
    disabled={disabled||!latest||!['DISPATCHING','ACCEPTED'].includes(latest.attemptStatus)}
    onClick={()=>command('/demo/execution-attempts/'+latest!.executionAttemptId+'/fake-state',{state},
     'Fake state acknowledged. PostgreSQL progress requires an explicit Reconcile.')}>
    {state==='SUCCEEDED'?'Set fake success':'Set fake failure'}</Button>)}
   {step.operation==='RECONCILE_JOB'&&<Button disabled={disabled||!latest||latest.attemptStatus==='PREPARED'}
    onClick={()=>command('/demo/calculation-jobs/'+job.jobId+'/reconcile')}>Reconcile Job</Button>}</div>
   {unknown&&<p className="notice pending">Outcome unknown. DISPATCHING does not mean failure; recover this original Job explicitly.</p>}
  </section>;
 })}</>;
}

export function WorkflowPage(){
 const {id}=useParams();const [query,setQuery]=useSearchParams();
 const {model,session,catalog,template,datasets,jobs,attempts,busy,loading,ready,scenario}=useDemo();
 if(!session)return <SessionRequired/>;
 if(!catalog)return <EmptyState title="Workflow availability unconfirmed">Refresh durable state to verify Backend admission. No Workflow or Guided creation is enabled.</EmptyState>;
 if(catalog.admissionState!=='WORKFLOW_OPEN')return <EmptyState title="Workflow operations are not available">Admission is {catalog.admissionState}. Templates remain PREVIEW. {scenario&&<Link to={'/guided/'+scenario.scenarioId}>Continue existing Guided Scenario</Link>}</EmptyState>;
 if(!id)return <><PageHeading eyebrow="Workflow workspace" title="Workflow Explorer" description="Choose a Backend-authored template. Every operation is an explicit action on your session-owned resources."/><WorkflowCards/></>;
 if(!template||template.id!==id)return <EmptyState title="Template unavailable">Refresh or <Link to="/workflows">choose another template</Link>. No operation will run automatically.</EmptyState>;
 const domains=[...new Set(template.steps.flatMap(s=>s.domain?[s.domain]:[]))];
 const year=Number(query.get('year')??'2026');const period=query.get('period')??'Q4';
 const validYear=Number.isInteger(year)&&year>0&&year<=2147483647;const validPeriod=['Q1','Q2','Q3','Q4'].includes(period);
 const bound=(domain:string)=>query.get('scope')===session.sessionId?datasets.find(d=>d.datasetVersionId===query.get('dataset.'+domain)&&d.domain===domain&&d.fiscalYear===year&&d.period===period):undefined;
 const changeIdentity=(key:string,value:string)=>{const next=new URLSearchParams(query);next.set(key,value);for(const domain of domains)next.delete('dataset.'+domain);next.delete('scope');setQuery(next);};
 const active=template.steps.find(s=>s.id===query.get('step'));
 const selected=active?.domain?bound(active.domain):undefined;
 const disabled=busy||loading||!ready||!!scenario||template.availability!=='AVAILABLE';
 return <><PageHeading eyebrow="Workflow Explorer" title={template.title} description={template.description} action={<StatusBadge status={template.availability}/>}/>
  <div className="actions"><Link to="/workflows" className="text-link">Choose template</Link><Link to="/datasets" className="text-link">Open Resource Explorer</Link><Link to="/exploration" className="text-link">Open Free Exploration</Link></div>
  {scenario&&<p className="callout">An existing Guided Scenario owns this session's operations. Continue it or explicitly Reset; Workflow adds no mode lock.</p>}
  <section className="panel workflow-bindings"><h2>Choose Dataset versions</h2><p>Selections are navigation hints. Only resources reloaded from your current Session are eligible. No version is selected automatically.</p>
   <div className="form-row"><label>Workflow fiscal year<input type="number" min="1" max="2147483647" value={Number.isNaN(year)?'':year} disabled={busy||loading} onChange={e=>changeIdentity('year',e.target.value)}/></label>
    <label>Workflow period<select value={period} disabled={busy||loading} onChange={e=>changeIdentity('period',e.target.value)}>{['Q1','Q2','Q3','Q4'].map(p=><option key={p}>{p}</option>)}</select></label></div>
   {domains.map(domain=>{const current=bound(domain);const candidates=datasets.filter(d=>d.domain===domain&&d.fiscalYear===year&&d.period===period);
    return <div className="workflow-binding" key={domain}><label>{domain} Dataset version<select aria-label={domain+' Dataset version'} disabled={busy||loading} value={current?.datasetVersionId??''} onChange={e=>{
     const next=new URLSearchParams(query);next.set('scope',session.sessionId);e.target.value?next.set('dataset.'+domain,e.target.value):next.delete('dataset.'+domain);setQuery(next);
    }}><option value="">Select a Dataset version explicitly</option>{candidates.map(d=><option key={d.datasetVersionId} value={d.datasetVersionId}>Version {d.version} · {d.datasetStatus} · {d.datasetVersionId}</option>)}</select></label>
    {candidates.length>1&&!current&&<p className="small">Multiple candidate versions: choose explicitly.</p>}
    {query.get('dataset.'+domain)&&!current&&<p className="small">Previous selection is unavailable for this Session and reporting identity. Choose again.</p>}
    <Button variant="secondary" disabled={disabled||!validYear||!validPeriod} onClick={()=>void model.workflow('/demo/dataset-versions',{domain,fiscalYear:year,period})}>Create {domain} Dataset</Button>
   </div>;})}
  </section>
  <p className="small muted">Dataset / Job / Attempt pages are separate observations and may reflect different times. They are not a single atomic snapshot. Fake actions are never permanent completed steps.</p>
  <div className="workflow-layout"><section className="panel workflow-timeline"><h2>Step timeline</h2><ol>{template.steps.map(step=>{const d=step.domain?bound(step.domain):undefined;return <li key={step.id} id={'step-'+step.id}>
    <button className={'workflow-step'+(active?.id===step.id?' selected':'')} aria-label={'Select step '+step.id} aria-pressed={active?.id===step.id} onClick={()=>{const next=new URLSearchParams(query);next.set('step',step.id);setQuery(next);}}>
     <strong>{step.title}</strong><code>{step.id}</code><span>{step.operation} · {step.domain}</span></button>
    <p>{step.description}</p><p className="small"><strong>Prerequisites:</strong> {step.prerequisites.length?step.prerequisites.map((p,i)=><span key={p}>{i?', ':''}<a href={'#step-'+p}>{p}</a></span>):'None'}</p>
    <p className="small"><strong>Expected result:</strong> {step.expectedResult}</p>
    <p className="workflow-evidence">{stepEvidence(step,d,d?jobs[d.datasetVersionId]??[]:[],attempts)}</p>
   </li>;})}</ol></section>
   <section className="panel workflow-operation" aria-label="Selected step operation"><h2>{active?.title??'Choose a step'}</h2>
    {active?<Operations key={active.id} step={active} dataset={selected} jobs={selected?jobs[selected.datasetVersionId]??[]:[]}/>:<p>Select a timeline step to inspect its operation. No step runs automatically.</p>}
   </section></div>
  <section className="workflow-resources"><h2>Selected durable resources</h2>{domains.map(domain=>{const d=bound(domain);return d?<section key={domain} aria-label={domain+' resources'}><DatasetCard dataset={d}/>{(jobs[d.datasetVersionId]??[]).map(j=><CalculationJobCard key={j.jobId} job={j}/>)}</section>:null;})}</section>
 </>;
}
