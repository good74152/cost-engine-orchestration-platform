import {DataView} from 'primereact/dataview';
import {useRef} from 'react';
import {useDemo} from './demo-context';
import type {ScenarioDefinition} from '../scenarios/engine';
import {REPOSITORY,scenarios} from '../scenarios/scenarios';
import {DemoDialog} from '../ui/demo-dialog';
import {Workspace} from '../ui/workspace';

const THEN_AND_NOW=[
 {problem:'A job looked stuck after a status message was lost.',
  then:'A database rule stopped duplicate runs, and a sync tool fixed stuck jobs.',
  now:'The job is marked “unknown”, and the system checks the same run again.',scenario:'lost-reply'},
 {problem:'A step failed in a long cost workflow.',
  then:'Someone reran it by hand in Airflow.',
  now:'A retry starts on the same input, and the failure stays on record.',scenario:'failed-job'},
];

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
 const scenarioRow=(s:ScenarioDefinition)=><div className={'scenario'+(playback?.scenarioId===s.id?' current':'')}>
  <h3>{s.title}</h3><p>{s.description}</p>
  <div className="actions"><button type="button" className="button" disabled={active||clearing} aria-label={'Run '+s.title} onClick={()=>start(s.id,'auto')}>Run it</button>
   <button type="button" className="button quiet" disabled={active||clearing} aria-label={'Step through '+s.title} onClick={()=>start(s.id,'step')}>Step through</button></div>
 </div>;
 return <div className="page">
  <header className="top"><span>Cost Engine Orchestration Platform</span><a href={REPOSITORY} target="_blank" rel="noreferrer">Source on GitHub</a></header>
  <main>
   <section className="hero">
    <h1>Async Workflow for Financial Report Calculation</h1>
    <p className="lead">How a backend stays in sync with external workflows and jobs, including lost responses, failure recovery and conflicting requests.</p>
    <p className="truth">The tracking, database and recovery are real. The jobs are simulated.</p>
   </section>
   <section className="demo" aria-label="Interactive demo">
    <aside className="scenarios" aria-labelledby="scenarios-title">
     <h2 id="scenarios-title">Pick a scenario</h2>
     <DataView value={scenarios} dataKey="id" itemTemplate={scenarioRow}/>
    </aside>
    <div ref={results} className="results"><Player/><Workspace/></div>
   </section>
   <section className="then-now" aria-labelledby="then-now-title">
    <h2 id="then-now-title">From my last job to this project</h2>
    <p className="section-lead">“Then” is production work I did. “Now” is this project, a new build rather than a copy.</p>
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Then and now comparison"><table>
     <thead><tr><th scope="col">Problem</th><th scope="col">Then</th><th scope="col">Now</th><th scope="col"><span className="visually-hidden">Try it</span></th></tr></thead>
     <tbody>{THEN_AND_NOW.map(row=><tr key={row.scenario}><td>{row.problem}</td><td>{row.then}</td><td>{row.now}</td>
      <td><button type="button" className="link-button" disabled={active||clearing} aria-label={'Try '+scenarios.find(s=>s.id===row.scenario)?.title} onClick={()=>start(row.scenario,'auto')}>Try it</button></td></tr>)}</tbody>
    </table></div>
    <p className="section-note">Waiting for the reports a job needs comes from that work. Locking the input is an idea I added here.</p>
   </section>
   <section className="limits" aria-labelledby="limits-title">
    <h2 id="limits-title">What it doesn’t do</h2>
    <ul>
     <li>No real Airflow. A simulator stands in and forgets everything on restart.</li>
     <li>One backend instance only. This isn’t a production system.</li>
     <li>Nothing checks results in the background. A check runs only when asked.</li>
    </ul>
    <p className="section-note">Next I’d build the Airflow connection, then start downstream reports automatically.</p>
   </section>
  </main>
  <footer className="bottom"><a href={REPOSITORY+'#readme'} target="_blank" rel="noreferrer">Architecture and flow diagrams</a><a href={REPOSITORY+'/tree/main/docs/adr'} target="_blank" rel="noreferrer">Design decisions</a></footer>
  <DemoDialog/>
 </div>;
}
