import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useDemo} from '../../app/demo-context';
import {Button,Icon,PageHeading,EmptyState} from '../../components/ui';
import {DatasetCard,CalculationJobCard} from '../../components/resources';
import {SessionRequired} from '../sessions/session-card';
export function ExplorationPage(){
 const {model,session,scenario,datasets,jobs,busy,loading,ready}=useDemo();
 const [domain,setDomain]=useState('CAPEX');const [year,setYear]=useState(2026);const [period,setPeriod]=useState('Q4');const [behavior,setBehavior]=useState('ACCEPT');
 if(!session)return <SessionRequired/>;
 return <><PageHeading eyebrow="Free exploration" title="Your orchestration sandbox" description="Send explicit commands and inspect their durable effects. The backend validates every operation."/>
 {scenario?<div className="callout"><Icon name="shield"/><div><strong>Guided Scenario is active. Reset your session to use Free Exploration.</strong><p><Link to={'/guided/'+scenario.scenarioId} className="text-link">Continue your guided scenario →</Link></p></div></div>:
 <div className="exploration-forms"><form className="panel" onSubmit={e=>{e.preventDefault();void model.manual('/demo/dataset-versions',{domain,fiscalYear:year,period});}}><p className="eyebrow">01 / Dataset allocation</p><h3>Create a dataset version</h3><p className="muted">Backend configuration determines the required Jobs in each Domain. Workflow configuration includes two CAPEX Jobs; publish the matching upstream inputs before First Run.</p><fieldset disabled={busy||loading||!ready}><div className="form-row"><label>Domain<select aria-label="Domain" value={domain} onChange={e=>setDomain(e.target.value)}>{['FAB_COST','CAPEX','DPR','INSURANCE','ONE_STD_COST','E2E_COST'].map(d=><option key={d}>{d}</option>)}</select></label><label>Fiscal year<input type="number" min="1" max="2147483647" required value={year} onChange={e=>setYear(Number(e.target.value))}/></label><label>Period<select value={period} onChange={e=>setPeriod(e.target.value)}>{['Q1','Q2','Q3','Q4'].map(p=><option key={p}>{p}</option>)}</select></label></div>
 <p className="small muted">Company code is assigned by your authenticated session.</p><Button type="submit">Create dataset <Icon name="arrow" size={16}/></Button></fieldset></form>
 <form className="panel" onSubmit={e=>{e.preventDefault();void model.manual('/demo/fake-executor/dispatch-behavior',{behavior},'Behavior queued for the next new dispatch decision. Existing executions were not modified.');}}><p className="eyebrow">02 / Simulation controls</p><h3>Next dispatch behavior</h3><p className="muted">Queue one test behavior. This is not a live execution state control.</p><fieldset disabled={busy||loading||!ready}><label>Dispatch behavior<select aria-label="Dispatch behavior" value={behavior} onChange={e=>setBehavior(e.target.value)}>{['ACCEPT','REJECT','ACCEPT_THEN_UNKNOWN','UNKNOWN_WITHOUT_CREATION'].map(b=><option key={b}>{b}</option>)}</select></label><p className="small muted">Even configuration without a dataset requires Reset before starting a guided scenario.</p><Button variant="secondary" type="submit">Queue behavior</Button></fieldset></form></div>}
 <div className="section-heading"><div><p className="eyebrow">Current workspace</p><h2>Datasets & calculations</h2></div><Link to="/datasets" className="text-link">Resource explorer →</Link></div>
 {!datasets.length?<EmptyState title="Your sandbox is empty">Choose a configured Domain and reporting identity to explore dispatch, reconciliation and publication.</EmptyState>:datasets.map(d=><section key={d.datasetVersionId} className="exploration-dataset"><DatasetCard dataset={d}/><div className="lifecycle actions">
 {(['submit-validation','publish','reject','abandon'] as const).map(action=><Button key={action} variant={action==='reject'||action==='abandon'?'ghost':'secondary'} disabled={!!scenario||busy||loading||!ready||
 (action==='submit-validation'?d.datasetStatus!=='BUILDING':action==='abandon'?!['DRAFT','BUILDING'].includes(d.datasetStatus):d.datasetStatus!=='VALIDATING')}
 onClick={()=>void model.manual('/demo/dataset-versions/'+d.datasetVersionId+'/'+action)}>{({'submit-validation':'Submit validation',publish:'Publish',reject:'Reject',abandon:'Abandon'})[action]}</Button>)}</div>
 <p className="small muted">Setting fake success/failure changes only the simulation. Reconcile to confirm the database result; publication remains explicit.</p>
 {(jobs[d.datasetVersionId]??[]).map(j=><CalculationJobCard key={j.jobId} job={j} manual/>)}</section>)}
 </>;
}
