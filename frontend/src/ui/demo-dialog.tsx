import {Dialog} from 'primereact/dialog';
import type {ReactNode} from 'react';
import {useDemo} from '../app/demo-context';

export function DemoDialog(){
 const {model,dialog,clearing}=useDemo();
 if(!dialog)return null;
 const locked=dialog.kind==='pause';
 let header='';let body:ReactNode=null;let footer:ReactNode=null;
 const close=<button type="button" className="button" onClick={model.dismiss}>Close</button>;
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
   header=dialog.title;body=<><p>{dialog.message}</p>{dialog.code&&<p className="dialog-note">Error code: <code>{dialog.code}</code></p>}</>;
   footer=close;break;
  case 'details':
   header=dialog.title;
   body=<><p>{dialog.explanation}</p><dl className="details">{dialog.rows.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>;
   footer=close;break;
  case 'clear':
   header='Clear your demo data?';
   body=<p>This deletes your datasets, jobs and attempts and ends your session. Running a scenario starts a new one.</p>;
   footer=<><button type="button" className="button quiet" disabled={clearing} onClick={model.dismiss}>Keep my data</button>
    <button type="button" className="button" disabled={clearing} onClick={()=>void model.clear()}>{clearing?'Clearing':'Clear data'}</button></>;
   break;
 }
 return <Dialog visible header={header} footer={footer} modal draggable={false} resizable={false} blockScroll closable={!locked} closeOnEscape={!locked}
  dismissableMask={!locked} onHide={model.dismiss}>{body}</Dialog>;
}
