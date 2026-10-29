import {useEffect,useRef,useState} from 'react';
import {Link,NavLink,Route,Routes,useLocation,useNavigate} from 'react-router-dom';
import {useDemo} from './demo-context';
import {Button,Icon,PageHeading,ErrorMessage,LoadingState,ConfirmationDialog,EmptyState} from '../components/ui';
import {SessionCard} from '../features/sessions/session-card';
import {ScenarioCards,GuidedSelection,GuidedRunner} from '../features/scenarios/scenario-pages';
import {DatasetsPage,DatasetPage} from '../features/datasets/datasets-page';
import {DatasetCard} from '../components/resources';
import {ExplorationPage} from '../features/exploration/exploration-page';
import {WorkflowCards,WorkflowPage} from '../features/workflows/workflow-page';
function Dashboard(){
 const {session,scenario,datasets,jobs,catalog}=useDemo();const all=Object.values(jobs).flat();
 const workflow=catalog?.admissionState==='WORKFLOW_OPEN';
 const succeeded=all.filter(j=>j.jobStatus==='SUCCEEDED').length;
 return <><PageHeading eyebrow="Orchestration workspace" title="Financial Calculation Platform" description="Explore reliable financial data orchestration, execution retries, and failure recovery."/>
 <div className="overview-top"><section className="intro-panel"><span className="tag"><Icon name="code" size={14}/> BACKEND ENGINEERING DEMO</span><h2>Reliable by design.<br/><span>Visible at every step.</span></h2>
 <p>Follow a dataset from its first version to publication. See how durable state and stable execution identities make recovery safe.</p><div className="actions">{session&&catalog&&(workflow||scenario||catalog.admissionState==='LEGACY_OPEN')&&<Link to={workflow?'/workflows':scenario?'/guided/'+scenario.scenarioId:'/guided'} className="button primary">{workflow?'Open Workflow Explorer':scenario?'Continue your scenario':'Explore guided scenarios'}<Icon name="arrow" size={17}/></Link>}<Link to="/about" className="text-link">How it works</Link></div>
 <p className="small muted">FakeExecutor simulates external work. No real financial calculations are performed.</p></section><SessionCard/></div>
 <div className="metrics"><div><span className="metric-icon"><Icon name="layers"/></span><p>Dataset versions</p><strong>{session?datasets.length:'—'}</strong><small>All cursor pages · session-owned</small></div>
 <div><span className="metric-icon"><Icon name="flow"/></span><p>Calculation jobs</p><strong>{session?all.length:'—'}</strong><small>{session?all.filter(j=>j.jobStatus==='RUNNING').length+' running · '+all.filter(j=>j.jobStatus==='PENDING').length+' pending · '+all.filter(j=>j.jobStatus==='FAILED').length+' failed':'Start a session to load state'}</small></div>
 <div><span className="metric-icon green"><Icon name="check"/></span><p>Succeeded jobs</p><strong>{session?succeeded:'—'}</strong><small>Confirmed by reconciliation</small></div></div>
 <div className="section-heading"><div><p className="eyebrow">Learn by doing</p><h2>{workflow?'Your Workflow templates':'Explicit actions. Durable recovery.'}</h2></div><span className="small muted">Backend controls availability</span></div>
 {workflow?<WorkflowCards/>:catalog?.admissionState==='LEGACY_OPEN'?<ScenarioCards overview/>:<EmptyState title={session?'New mode admission is paused':'Start a session to discover available modes'}>Existing work is preserved. Availability is read from Backend after authentication.</EmptyState>}<Link to="/exploration" className="exploration-banner"><div className="row"><span className="icon-box"><Icon name="code"/></span><div><p className="eyebrow">Prefer to explore?</p><h3>Your own orchestration sandbox</h3><p>Create datasets, control the fake and inspect execution history.</p></div></div><span className="button secondary">Open Free Exploration <Icon name="arrow" size={17}/></span></Link>
 <div className="section-heading"><h2>Recent workspace datasets</h2><Link className="text-link" to="/datasets">View all resources →</Link></div>
 {datasets.length?<div className="dataset-grid">{datasets.slice(0,3).map(d=><DatasetCard key={d.datasetVersionId} dataset={d}/>)}</div>:<EmptyState title={session?'No datasets yet':'A fresh workspace awaits'}>Your session-owned datasets will appear here after an explicit creation step.</EmptyState>}</>;
}
function About(){return <><PageHeading eyebrow="Engineering notes" title="Orchestration, not calculation." description="A portfolio demonstration of versioned datasets, explicit coordination and safe execution recovery."/>
 <div className="about-grid">{[
 ['01','Versioned datasets','Canonical identity is domain, authenticated company, fiscal year and quarter. A dataset version contains its complete calculation-job set.'],
 ['02','Frozen build inputs','First Run freezes one dataset-wide snapshot. Retries reuse it; they never silently refresh upstream versions.'],
 ['03','Durable execution identity','An uncertain dispatch keeps its DISPATCHING attempt. Recovery uses the same identity instead of duplicating work.'],
 ['04','Explicit confirmation','Fake success alone changes no PostgreSQL result. Reconcile, validate and publish are separate commands.'],
 ].map(([n,title,text])=><section className="panel" key={n}><p className="eyebrow">PRINCIPLE {n}</p><h2>{title}</h2><p className="muted">{text}</p></section>)}</div>
 <div className="panel explanatory"><h3>Demonstration boundaries</h3><p>One local backend instance, one isolated FakeExecutor per session. Fake state lives in memory; backend restart invalidates old sessions. There is no real Airflow adapter, financial calculation or live external monitoring.</p><p className="muted">Development/test only. These local settings are not a secure public deployment configuration. Deployment belongs to a separate task.</p></div></>;}
export function App(){
 const {model,session,catalog,scenario,error,notice,noticePending,lastStep,busy,loading}=useDemo();const [resetOpen,setResetOpen]=useState(false);const navigate=useNavigate();const location=useLocation();
 const previousPath=useRef<string|null>(null);
 useEffect(()=>{const match=/^\/workflows\/([^/]+)$/.exec(location.pathname);let id=match?.[1]??null;
  try{if(id)id=decodeURIComponent(id);}catch{/* unknown encoded ID remains a safe API lookup */}
  const restore=previousPath.current===null||location.pathname.startsWith('/workflows')||location.pathname==='/exploration';
  previousPath.current=location.pathname;if(restore)void model.openTemplate(id);else model.clearTemplate();},[model,location.pathname]);
 const modeNav=catalog?.admissionState==='WORKFLOW_OPEN'?[['/workflows','flow','Workflow Explorer']]:
  catalog?.admissionState==='LEGACY_OPEN'||(catalog?.admissionState==='DRAINING'&&scenario)?[['/guided','flow','Guided Demo']]:[];
 return <div className="app-shell"><a href="#main-content" className="skip-link">Skip to content</a><aside className="sidebar"><Link to="/" className="brand"><span className="brand-icon"><Icon name="layers" size={23}/></span><span>FINANCIAL<br/><b>CALCULATION PLATFORM</b></span></Link>
 <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{[['/','grid','Dashboard'],...modeNav,['/exploration','code','Free Exploration'],['/datasets','layers','Resources'],['/about','info','About']] .map(([to,icon,label])=><NavLink key={to} to={to!} end={to==='/'}><Icon name={icon}/><span>{label}</span></NavLink>)}</nav>
 <div className="sidebar-bottom"><div className="demo-note"><Icon name="shield"/><div><strong>Simulated execution</strong><p>Real orchestration.<br/>No financial calculation.</p></div></div><button disabled={!session||busy||loading} onClick={()=>{model.dismiss();setResetOpen(true);}} className="reset-button"><Icon name="refresh" size={17}/> Reset session</button><span className="sidebar-version">PORTFOLIO DEMO / v2</span></div></aside>
 <div className="workspace"><header className="header"><span className="header-location">Workspace <span>/</span> Demo environment</span><div className="actions"><span className="environment"><i/> LOCAL DEMO</span>{session&&<span className="header-company">{session.companyCode}</span>}<Button variant="ghost" disabled={busy||loading} aria-label="Refresh durable state" onClick={()=>void model.refresh()}><Icon name="refresh" size={17}/>Refresh</Button></div></header>
 <main id="main-content" tabIndex={-1}>{error&&<ErrorMessage {...error} onDismiss={model.dismiss}/>}
 {notice&&<div className={'notice'+(noticePending||lastStep?.stepStatus==='PENDING'?' pending':'')} role="status"><Icon name={noticePending||lastStep?.stepStatus==='PENDING'?'clock':'check'}/><span>{notice}</span></div>}
 {loading&&<LoadingState/>}
 <Routes><Route path="/" element={<Dashboard/>}/><Route path="/workflows" element={<WorkflowPage/>}/><Route path="/workflows/:id" element={<WorkflowPage/>}/><Route path="/guided" element={<GuidedSelection/>}/><Route path="/guided/:id" element={<GuidedRunner/>}/><Route path="/exploration" element={<ExplorationPage/>}/><Route path="/datasets" element={<DatasetsPage/>}/><Route path="/datasets/:id" element={<DatasetPage/>}/><Route path="/about" element={<About/>}/><Route path="*" element={<EmptyState title="Page not found"><Link to="/">Return to Dashboard</Link></EmptyState>}/></Routes>
 <footer><span>Financial Calculation Platform</span><span>PostgreSQL state · explicit actions · FakeExecutor simulation</span></footer></main></div>
 {resetOpen&&<ConfirmationDialog busy={busy} error={error?.message??null} onCancel={()=>setResetOpen(false)} onConfirm={async()=>{if(await model.reset()){setResetOpen(false);navigate('/');}}}/>}
 </div>;
}
