import {useRef} from 'react';
import {useDemo} from './demo-context';
import {REPOSITORY,scenarios} from '../scenarios/scenarios';
import {DemoDialog} from '../ui/demo-dialog';
import {Workspace} from '../ui/workspace';

const THEN_AND_NOW=[
 {problem:'A job stayed “running” forever after a callback or dispatch failed.',
  then:'A database rule allowed one active job. Generating run IDs before dispatch, a sync button and a polling tool at month and quarter close kept it accurate.',
  now:'“Unknown” is its own state, so nothing guesses. The backend recovers with the same attempt and run ID.',scenario:'lost-response'},
 {problem:'A stage failed partway through a long cost workflow.',
  then:'People cleared the failed run by hand in the workflow tool, then started the next stage themselves.',
  now:'A retry is a new attempt on the same frozen inputs. The failed attempt stays in the history.',scenario:'failure-retry'},
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
  results.current?.scrollIntoView?.({behavior:reduce?'auto':'smooth',block:'start'});
  void model.start(id,mode);
 };
 return <div className="page">
  <header className="top"><span>Cost Engine Orchestration Platform</span><a href={REPOSITORY} target="_blank" rel="noreferrer">Source on GitHub</a></header>
  <main>
   <section className="hero">
    <h1>Financial data stays correct, even when a job’s reply gets lost.</h1>
    <p className="lead">This backend coordinates versioned cost datasets: which inputs a build uses, which jobs ran, and when a result can be published. Pick a failure and watch it recover.</p>
    <p className="truth">The backend, PostgreSQL locks and recovery logic are real. Job execution is simulated, and no financial figures are calculated.</p>
   </section>
   <section className="scenarios" aria-labelledby="scenarios-title">
    <h2 id="scenarios-title">Pick a failure</h2>
    <ul>{scenarios.map(s=><li key={s.id} className={playback?.scenarioId===s.id?'current':''}>
     <div><h3>{s.title}</h3><p>{s.description}</p></div>
     <div className="actions"><button type="button" className="button" disabled={active||clearing} aria-label={'Run '+s.title} onClick={()=>start(s.id,'auto')}>Run it</button>
      <button type="button" className="button quiet" disabled={active||clearing} aria-label={'Step through '+s.title} onClick={()=>start(s.id,'step')}>Step through</button></div>
    </li>)}</ul>
   </section>
   <div ref={results} className="results"><Player/><Workspace/></div>
   <section className="then-now" aria-labelledby="then-now-title">
    <h2 id="then-now-title">From my last role to this project</h2>
    <p className="section-lead">“Then” is production work I did. “Now” is how this portfolio project handles the same problem. It’s a new implementation, not a copy of that system.</p>
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Then and now comparison"><table>
     <thead><tr><th scope="col">Problem</th><th scope="col">Then</th><th scope="col">Now</th><th scope="col"><span className="visually-hidden">Try it</span></th></tr></thead>
     <tbody>{THEN_AND_NOW.map(row=><tr key={row.scenario}><td>{row.problem}</td><td>{row.then}</td><td>{row.now}</td>
      <td><button type="button" className="link-button" disabled={active||clearing} aria-label={'Try '+scenarios.find(s=>s.id===row.scenario)?.title} onClick={()=>start(row.scenario,'auto')}>Try it</button></td></tr>)}</tbody>
    </table></div>
    <p className="section-note">The rule that a downstream job waits for its upstream comes from that work too. Freezing inputs at the first run is a design I added for this project.</p>
   </section>
   <section className="limits" aria-labelledby="limits-title">
    <h2 id="limits-title">What this doesn’t do</h2>
    <ul>
     <li>It doesn’t connect to a real Airflow. A simulated executor stands in, and its memory is lost on restart.</li>
     <li>It runs on one backend instance, and it isn’t a production system.</li>
     <li>Nothing checks results in the background. Reconciliation runs only when asked.</li>
    </ul>
    <p className="section-note">Next, I’d build the Airflow adapter, then automatic downstream triggers once an upstream publishes.</p>
   </section>
  </main>
  <footer className="bottom"><a href={REPOSITORY+'#readme'} target="_blank" rel="noreferrer">Architecture and flow diagrams</a><a href={REPOSITORY+'/tree/main/docs/adr'} target="_blank" rel="noreferrer">Design decisions</a></footer>
  <DemoDialog/>
 </div>;
}
