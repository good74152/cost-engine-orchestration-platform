import {DataView} from 'primereact/dataview';
import {useRef} from 'react';
import {useDemo} from './demo-context';
import {LANGUAGES} from '../i18n/messages';
import type {ScenarioDefinition} from '../scenarios/engine';
import {REPOSITORY,scenarios} from '../scenarios/scenarios';
import {conceptBlocks,infoBlocks} from '../ui/content';
import {DemoDialog} from '../ui/demo-dialog';
import {ManualPanel} from '../ui/manual';
import {Workspace} from '../ui/workspace';

const KEY_SCENARIO='lost-response';

function Player(){
 const {model,playback}=useDemo();if(!playback)return null;
 const t=model.messages().player;
 const {status,stepNumber,totalSteps,stepTitle,nextStepTitle,message,title}=playback;
 const heading=status==='done'?t.finished(title):status==='failed'?t.stopped(title):t.step(stepNumber,totalSteps,stepTitle);
 return <div className="player" role="status" aria-live="polite">
  <progress max={totalSteps} value={status==='done'?totalSteps:stepNumber} aria-label={t.progress}/>
  <p className="player-title">{heading}</p>
  {message&&<p className="player-message">{message}</p>}
  {status==='waiting'&&<div className="actions"><button type="button" className="button" onClick={model.proceed}>{t.next(nextStepTitle??'')}</button>
   <button type="button" className="button quiet" onClick={model.stop}>{t.stop}</button></div>}
 </div>;
}

export function App(){
 const {model,playback,clearing,lang,manual}=useDemo();const results=useRef<HTMLDivElement>(null);
 const m=model.messages();
 const active=!!playback&&['running','waiting','paused'].includes(playback.status);
 const start=(id:string,mode:'auto'|'step')=>{
  const reduce=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  results.current?.scrollIntoView?.({behavior:reduce?'auto':'smooth',block:'nearest'});
  void model.start(id,mode);
 };
 const scenarioBlock=(s:ScenarioDefinition)=><div className={'scenario'+(s.id===KEY_SCENARIO?' key':'')+(playback?.scenarioId===s.id?' current':'')}>
  <h3><span translate="no">{s.title}</span>{s.id===KEY_SCENARIO&&<span className="tag">{m.scenario.key}</span>}</h3><p>{m.scenario.descriptions[s.id]}</p>
  <div className="actions"><button type="button" className="button" disabled={active||clearing||!!manual?.busy} aria-label={m.scenario.runLabel(s.title)} onClick={()=>start(s.id,'auto')}>{m.scenario.run}</button>
   <button type="button" className="button quiet" disabled={active||clearing||!!manual?.busy} aria-label={m.scenario.stepLabel(s.title)} onClick={()=>start(s.id,'step')}>{m.scenario.step}</button></div>
 </div>;
 return <>
  <a className="skip-link" href="#main">{m.skip}</a>
  <header className="top"><div className="top-inner"><span translate="no">Cost Engine Orchestration Platform</span>
   <div className="top-actions">
    <div className="language" role="group" aria-label={m.language}>{LANGUAGES.map(l=><button type="button" key={l.code} lang={l.code} aria-pressed={lang===l.code} onClick={()=>model.setLanguage(l.code)}>{l.label}</button>)}</div>
    <a href={REPOSITORY} target="_blank" rel="noreferrer">GitHub</a>
   </div></div></header>
  <div className="page">
  <main id="main">
   <section className="hero">
    <p className="badge" translate="no"><i aria-hidden="true"/>node@24 + postgresql@18</p>
    <h1>{m.hero.title}</h1>
    <p className="lead">{m.hero.lead}</p>
    <div className="actions hero-actions"><button type="button" className="button" disabled={active||clearing} onClick={()=>start(KEY_SCENARIO,'auto')}>{m.hero.runKey}</button>
     <a className="button quiet" href={REPOSITORY} target="_blank" rel="noreferrer">{m.hero.viewCode}</a></div>
    <p className="truth">{m.hero.truth}</p>
   </section>
   <section className="concepts" aria-label={m.sections.concepts}>
    <ol>{conceptBlocks(m).map(c=><li key={c.code}><button type="button" className="block" aria-haspopup="dialog" onClick={()=>model.openInfo(c.dialog)}><strong translate="no">{c.name}</strong><small translate="no">{c.code}</small><span>{c.line}</span></button></li>)}</ol>
   </section>
   <section className="demo" aria-label={m.sections.demo}>
    <aside className="scenarios" aria-labelledby="scenarios-title">
     <h2 id="scenarios-title">{m.sections.pick}</h2>
     <DataView value={scenarios} dataKey="id" itemTemplate={scenarioBlock}/>
     <div className={'scenario'+(manual?' current':'')}>
      <h3 translate="no">{m.manual.card}</h3><p>{m.manual.cardLine}</p>
      <div className="actions"><button type="button" className="button quiet" disabled={active||clearing||!!manual?.busy} aria-label={manual?m.manual.closeLabel:m.manual.openLabel} aria-pressed={!!manual}
       onClick={()=>{if(manual)model.closeManual();else{model.openManual();results.current?.scrollIntoView?.({behavior:'auto',block:'nearest'});}}}>{manual?m.manual.close:m.manual.open}</button></div>
     </div>
    </aside>
    <div ref={results} className="results">{manual?<ManualPanel/>:<><Player/><Workspace/></>}</div>
   </section>
   <section className="more" aria-labelledby="more-title">
    <h2 id="more-title">{m.sections.more}</h2>
    <ul>{infoBlocks(m).map(b=><li key={b.title}>{b.dialog?
     <button type="button" className="block" aria-haspopup="dialog" onClick={()=>model.openInfo(b.dialog!)}><strong>{b.title}</strong><span>{b.line}</span></button>:
     <a className="block" href={b.href} target="_blank" rel="noreferrer"><strong>{b.title}</strong><span>{b.line}</span></a>}</li>)}</ul>
   </section>
  </main>
  </div>
  <DemoDialog/>
 </>;
}
