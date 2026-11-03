import {DataView} from 'primereact/dataview';
import {useRef} from 'react';
import {useDemo} from './demo-context';
import type {ScenarioDefinition} from '../scenarios/engine';
import {REPOSITORY,scenarios} from '../scenarios/scenarios';
import {CONCEPTS,INFO_BLOCKS} from '../ui/content';
import {DemoDialog} from '../ui/demo-dialog';
import {Workspace} from '../ui/workspace';

const KEY_SCENARIO='lost-reply';

function Player(){
 const {model,playback}=useDemo();if(!playback)return null;
 const {status,stepNumber,totalSteps,stepTitle,nextStepTitle,message,title}=playback;
 const heading=status==='done'?title+' finished':status==='failed'?title+' stopped':'Step '+stepNumber+' of '+totalSteps+': '+stepTitle;
 return <div className="player" role="status" aria-live="polite">
  <progress max={totalSteps} value={status==='done'?totalSteps:stepNumber} aria-label="Scenario progress"/>
  <p className="player-title">{heading}</p>
  {message&&<p className="player-message">{message}</p>}
  {status==='waiting'&&<div className="actions"><button type="button" className="button" onClick={model.proceed}>Next: {nextStepTitle}</button>
   <button type="button" className="button quiet" onClick={model.stop}>Stop</button></div>}
 </div>;
}

export function App(){
 const {model,playback,clearing}=useDemo();const results=useRef<HTMLDivElement>(null);
 const active=!!playback&&['running','waiting','paused'].includes(playback.status);
 const start=(id:string,mode:'auto'|'step')=>{
  const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  results.current?.scrollIntoView?.({behavior:reduce?'auto':'smooth',block:'nearest'});
  void model.start(id,mode);
 };
 const scenarioBlock=(s:ScenarioDefinition)=><div className={'scenario'+(s.id===KEY_SCENARIO?' key':'')+(playback?.scenarioId===s.id?' current':'')}>
  <h3>{s.title}{s.id===KEY_SCENARIO&&<span className="tag">Key demo</span>}</h3><p>{s.description}</p>
  <div className="actions"><button type="button" className="button" disabled={active||clearing} aria-label={'Run '+s.title} onClick={()=>start(s.id,'auto')}>Run it</button>
   <button type="button" className="button quiet" disabled={active||clearing} aria-label={'Step through '+s.title} onClick={()=>start(s.id,'step')}>Step through</button></div>
 </div>;
 return <>
  <a className="skip-link" href="#main">Skip to content</a>
  <header className="top"><div className="top-inner"><span>Cost Engine Orchestration Platform</span><a href={REPOSITORY} target="_blank" rel="noreferrer">GitHub</a></div></header>
  <div className="page">
  <main id="main">
   <section className="hero">
    <p className="badge" translate="no"><i aria-hidden="true"/>node@24 + postgresql@18</p>
    <h1>Async Workflow for Financial Report Calculation</h1>
    <p className="lead">How a backend stays in sync with external workflows and jobs, including lost responses, failure recovery and conflicting requests.</p>
    <div className="actions hero-actions"><button type="button" className="button" disabled={active||clearing} onClick={()=>start(KEY_SCENARIO,'auto')}>Run the key demo</button>
     <a className="button quiet" href={REPOSITORY} target="_blank" rel="noreferrer">View the code</a></div>
    <p className="truth">The tracking, database and recovery are real. The jobs are simulated.</p>
   </section>
   <section className="concepts" aria-label="How the data is organized">
    <ol>{CONCEPTS.map(c=><li key={c.code}><button type="button" className="block" aria-haspopup="dialog" onClick={()=>model.openInfo(c.dialog)}><strong>{c.name}</strong><small translate="no">{c.code}</small><span>{c.line}</span></button></li>)}</ol>
   </section>
   <section className="demo" aria-label="Interactive demo">
    <aside className="scenarios" aria-labelledby="scenarios-title">
     <h2 id="scenarios-title">Pick a scenario</h2>
     <DataView value={scenarios} dataKey="id" itemTemplate={scenarioBlock}/>
    </aside>
    <div ref={results} className="results"><Player/><Workspace/></div>
   </section>
   <section className="more" aria-labelledby="more-title">
    <h2 id="more-title">Learn more</h2>
    <ul>{INFO_BLOCKS.map(b=><li key={b.title}>{b.dialog?
     <button type="button" className="block" aria-haspopup="dialog" onClick={()=>model.openInfo(b.dialog!)}><strong>{b.title}</strong><span>{b.line}</span></button>:
     <a className="block" href={b.href} target="_blank" rel="noreferrer"><strong>{b.title}</strong><span>{b.line}</span></a>}</li>)}</ul>
   </section>
  </main>
  </div>
  <DemoDialog/>
 </>;
}
