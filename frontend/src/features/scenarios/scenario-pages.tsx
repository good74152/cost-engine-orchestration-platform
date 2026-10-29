import {Link,Navigate,useNavigate,useParams} from 'react-router-dom';
import {useDemo} from '../../app/demo-context';
import {catalog} from './scenario-catalog';
import type {ScenarioType} from '../../api/types';
import {Button,Icon,StatusBadge,PageHeading,EmptyState,Identity} from '../../components/ui';
import {SessionRequired} from '../sessions/session-card';
import {CalculationJobCard,DatasetCard} from '../../components/resources';

export function ScenarioCards({overview=false}:{overview?:boolean}){
 const {model,scenario,session,busy,loading,datasets,catalog:availability}=useDemo();const navigate=useNavigate();
 return <div className="scenario-grid">{(Object.entries(catalog) as [ScenarioType,(typeof catalog)[ScenarioType]][]).map(([type,item],index)=>
 <section className={'scenario-card '+item.tone} key={type}><div className="row"><span className={'icon-box '+item.tone}><Icon name={item.icon} size={23}/></span><span className="small muted">SCENARIO 0{index+1}</span></div>
 <h3>{item.title}</h3><p>{item.description}</p><div className="step-dots" aria-label={item.steps.length+' explicit steps'}>{item.steps.map((_,i)=><i key={i}/>)}<span>{item.steps.length} steps</span></div>
 {overview?<Link className="text-link" to={scenario?.scenarioType===type?'/guided/'+scenario.scenarioId:'/guided'}>{scenario?.scenarioType===type?'Continue scenario':'Explore scenario'} <Icon name="arrow" size={16}/></Link>:
 <Button variant="secondary" disabled={!session||busy||loading||availability?.admissionState!=='LEGACY_OPEN'||!!(scenario&&scenario.scenarioType!==type)||(!scenario&&datasets.length>0)} onClick={async()=>{
  if(await model.createScenario(type)){const saved=model.getSnapshot().scenario;if(saved)navigate('/guided/'+saved.scenarioId);}
 }}>{scenario?.scenarioType===type?'Continue scenario':scenario?'Reset to switch':'Start '+item.title}<Icon name="arrow" size={16}/></Button>}
 </section>)}</div>;
}
export function GuidedSelection(){
 const {session,scenario,datasets,catalog:availability}=useDemo();if(!session)return <SessionRequired/>;
 if(availability?.admissionState==='WORKFLOW_OPEN')return <Navigate to="/workflows" replace/>;
 if(!availability)return <EmptyState title="Guided availability unconfirmed">Refresh Backend availability before choosing a mode.</EmptyState>;
 if(availability.admissionState==='DRAINING')return <EmptyState title="New Guided Scenarios are paused">{scenario?<Link to={'/guided/'+scenario.scenarioId}>Continue existing Guided Scenario</Link>:'Existing sessions retain their resources. No new Scenario can be created.'}</EmptyState>;
 return <><PageHeading eyebrow="Guided demo" title="Explore the orchestration journey" description="One deliberate action at a time. Real backend state, simulated external calculation."/>
 {(scenario||datasets.length>0)&&<div className="callout"><Icon name="info"/><p>{scenario?'This session already has a guided scenario. Continue it, or use Reset session to choose another.':'Free exploration data already exists. Reset and start a new session before choosing a guided scenario.'}</p></div>}
 <ScenarioCards/><div className="panel explanatory"><h3>What you will see</h3><p>Dataset, job and execution attempt are separate facts. Simulating an executor result does not reconcile the database or publish a dataset. Every step is explicit.</p><p className="muted">Guided scenarios require a fresh session, including no prior manual FakeExecutor configuration. Reset is always your choice.</p></div></>;
}
export function GuidedRunner(){
 const {id}=useParams();const {model,session,scenario,pending,lastStep,jobs,datasets,busy,loading,catalog:availability}=useDemo();
 if(!session)return <SessionRequired/>;
 if(availability?.admissionState==='WORKFLOW_OPEN')return <Navigate to="/workflows" replace/>;
 if(!availability)return <EmptyState title="Guided availability unconfirmed">Refresh Backend availability before continuing.</EmptyState>;
 if(!scenario||scenario.scenarioId!==id)return <EmptyState title="Scenario unavailable">Choose your session's scenario from <Link to="/guided">Guided Demo</Link>.</EmptyState>;
 const plan=catalog[scenario.scenarioType];const next=model.currentStep();const current=plan.steps[next-1];const completed=scenario.status==='COMPLETED';
 const recovering=!!pending||model.hasCurrentRequest();const lost=scenario.scenarioType==='LOST_RESPONSE_RECOVERY'&&next===2&&recovering;
 const dataset=datasets.find(d=>d.domain==='CAPEX'&&d.fiscalYear===2026&&d.period==='Q4'&&d.version===1);
 return <><PageHeading eyebrow="Guided execution" title={plan.title} description={plan.description} action={<StatusBadge status={scenario.status}/>}/>
 <div className="runner-layout"><aside className="panel timeline"><div className="row"><h3>Your journey</h3><span className="small muted">{scenario.completedStep} / {plan.steps.length}</span></div>
 <progress aria-label="Scenario progress" max={plan.steps.length} value={scenario.completedStep}/><ol>{plan.steps.map((step,index)=>{
  const n=index+1;const done=n<=scenario.completedStep;return <li className={done?'done':n===next?'current':''} key={n}><span className="step-number">{done?<Icon name="check" size={14}/>:String(n).padStart(2,'0')}</span><div><strong>{step.name}</strong><small>{done?'Completed':n===next?(pending?'Pending confirmation':'Current step'):'Waiting'}</small></div></li>;
 })}</ol><p className="small muted">Progress is read from PostgreSQL. Steps never run automatically.</p></aside>
 <div className="runner-main"><section className="panel current-step">{completed?<><span className="icon-box green"><Icon name="check"/></span><p className="eyebrow">All steps confirmed</p><h2>Dataset published.</h2><p>Your scenario is complete. Inspect the durable dataset and preserved attempt history below.</p><Link to="/datasets" className="text-link">Open resource explorer →</Link></>:
 <><div className="row"><p className="eyebrow">Step {next} of {plan.steps.length}</p>{pending&&<StatusBadge status="PENDING"/>}</div><h2>{current?.name}</h2><p>{current?.description}</p><div className="expected"><span className="eyebrow">Expected backend behavior</span><p>{current?.expected}</p></div>
 {lost&&<div className="lost-response"><span className="icon-box amber"><Icon name="shield"/></span><h3>Recover the original execution.</h3><p>Execution may have started, but the acknowledgement was lost.</p><div className="recovery-flow"><span>Original request</span><b>→</b><span>DISPATCHING</span><b>→</b><span>Confirm identity</span></div><p className="small">The backend reuses the original attempt. This is dispatch response loss, not calculation failure.</p></div>}
 <Button disabled={busy||loading} onClick={()=>void model.runStep()}>{busy?'Awaiting backend…':lost?'Recover original execution':recovering?'Retry current step':current?.action}<Icon name={recovering?'refresh':'arrow'} size={17}/></Button>
 {recovering&&<p className="small muted">Retry reuses your saved request ID. No next step is sent automatically.</p>}</>}
 </section>
 {lastStep?.scenarioId===scenario.scenarioId&&<section className="panel acknowledgement"><div className="row"><h3>Last step acknowledgement</h3><StatusBadge status={lastStep.stepStatus}/></div><p className="muted">Step {lastStep.stepNumber} · request <code>{lastStep.requestId}</code></p>
 <div className="actions"><StatusBadge status={lastStep.stepResult.datasetStatus}/><StatusBadge status={lastStep.stepResult.jobStatus}/>{lastStep.stepResult.attemptStatus&&<StatusBadge status={lastStep.stepResult.attemptStatus}/>}</div>
 {lastStep.stepResult.externalStatus&&<p className="small">Fake operation acknowledged: {lastStep.stepResult.externalStatus}. This is a past action result, not live executor monitoring.</p>}
 <p className="small muted">The journey above uses the latest Scenario GET. This saved response may describe an earlier step.</p></section>}
 </div></div>
 <div className="section-heading"><div><p className="eyebrow">Durable resource state</p><h2>One dataset. Complete execution history.</h2></div><span className="small muted">Read from PostgreSQL</span></div>
 {dataset?<><div className="dataset-summary"><DatasetCard dataset={dataset}/><div className="panel explanatory"><h3>Stable identities, visible history</h3><p>The job stays the same across retries. Each confirmed retry has its own attempt ID, while the original frozen build inputs remain unchanged.</p><Identity label="Dataset version ID" value={dataset.datasetVersionId}/></div></div>
 {(jobs[dataset.datasetVersionId]??[]).map(job=><CalculationJobCard key={job.jobId} job={job}/>)}</>:<EmptyState title="No dataset yet">Step 1 will create the session-owned dataset and calculation job.</EmptyState>}</>;
}
