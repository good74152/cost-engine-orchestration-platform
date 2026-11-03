import {Dialog} from 'primereact/dialog';
import type {ReactNode} from 'react';
import type {RunOutcome} from '../app/controller';
import {useDemo} from '../app/demo-context';

export function DemoDialog(){
 const {model,dialog,clearing}=useDemo();
 if(!dialog)return null;
 const t=model.messages().dialog;
 const locked=dialog.kind==='pause';
 let header='';let body:ReactNode=null;let footer:ReactNode=null;
 const close=<button type="button" className="button" onClick={model.dismiss}>{t.close}</button>;
 switch(dialog.kind){
  case 'summary':
   header=dialog.summary.title;
   body=<><ul className="facts">{dialog.summary.facts.map(f=><li key={f}>{f}</li>)}</ul>{dialog.summary.note&&<p className="dialog-note">{dialog.summary.note}</p>}
    {dialog.summary.link&&<p><a href={dialog.summary.link.href} target="_blank" rel="noreferrer">{dialog.summary.link.label}</a></p>}</>;
   footer=close;break;
  case 'pause':
   header=dialog.pause.title;body=<p>{dialog.pause.body}</p>;
   footer=<button type="button" className="button" autoFocus onClick={model.proceed}>{dialog.pause.action}</button>;break;
  case 'error':
   header=dialog.title;body=<><p>{dialog.message}</p>{dialog.code&&<p className="dialog-note">{t.errorCode} <code translate="no">{dialog.status?'HTTP '+dialog.status+' ':''}{dialog.code}</code></p>}</>;
   footer=close;break;
  case 'run':{
   const {jobId,title,recovering}=dialog;const manual=model.messages().manual;
   const choices:RunOutcome[]=recovering?['SUCCEEDED','FAILED']:['SUCCEEDED','FAILED','UNKNOWN'];
   header=manual.runTitle(title);
   body=<><p>{recovering?manual.recoverLead:manual.runLead}</p>
    <div className="outcomes">{choices.map(c=><button type="button" key={c} className="block" onClick={()=>void model.runJob(jobId,title,c)}><strong translate="no">{manual.outcomes[c].label}</strong><span>{manual.outcomes[c].line}</span></button>)}</div></>;
   break;
  }
  case 'info':{
   const {content}=dialog;header=content.title;
   body=<>{content.paragraphs?.map(p=><p key={p}>{p}</p>)}
    {content.bullets&&<ul className="facts">{content.bullets.map(b=><li key={b}>{b}</li>)}</ul>}
    {content.rows&&<dl className="details">{content.rows.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
    {content.note&&<p className="dialog-note">{content.note}</p>}</>;
   const action=content.action;
   footer=action?<><button type="button" className="button quiet" onClick={model.dismiss}>{t.close}</button>
    <button type="button" className="button" onClick={()=>void model.start(action.scenarioId,'auto')}>{action.label}</button></>:close;
   break;
  }
  case 'clear':
   header=t.clearTitle;
   body=<p>{t.clearBody}</p>;
   footer=<><button type="button" className="button quiet" disabled={clearing} onClick={model.dismiss}>{t.keep}</button>
    <button type="button" className="button" disabled={clearing} onClick={()=>void model.clear()}>{clearing?t.clearing:t.clear}</button></>;
   break;
 }
 return <Dialog visible header={header} footer={footer} modal draggable={false} resizable={false} blockScroll closable={!locked} closeOnEscape={!locked}
  dismissableMask={!locked} onHide={model.dismiss}>{body}</Dialog>;
}
