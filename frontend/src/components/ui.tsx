import {useEffect,useRef,type ButtonHTMLAttributes,type ReactNode} from 'react';
export function Icon({name='grid',size=20}:{name?:string;size?:number}){
 const paths:Record<string,ReactNode>={
  grid:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  flow:<><path d="M5 4v12a3 3 0 0 0 3 3h11M5 8h11"/><circle cx="5" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="19" cy="19" r="2"/></>,
  layers:<><path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/></>,
  arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,
  refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6"/></>,
  check:<path d="m5 12 4 4L19 6"/>,
  shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
  info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  code:<><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.grid}</svg>;
}
export function Button({children,variant='primary',className='',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'danger'|'ghost'}){
 return <button {...props} className={'button '+variant+' '+className}>{children}</button>;
}
export function StatusBadge({status}:{status:string}){
 const tone=['SUCCEEDED','PUBLISHED','COMPLETED','ACTIVE'].includes(status)?'green':['FAILED','REJECTED','DISPATCH_FAILED'].includes(status)?'red':
 ['DISPATCHING','UNKNOWN'].includes(status)?'amber':status==='VALIDATING'?'purple':status==='ACCEPTED'?'cyan':
 ['BUILDING','RUNNING','IN_PROGRESS'].includes(status)?'blue':'gray';
 return <span className={'status '+tone}><span aria-hidden="true"/>{status}</span>;
}
export function PageHeading({eyebrow,title,description,action}:{eyebrow:string;title:string;description:string;action?:ReactNode}){
 return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>{action}</div>;
}
export function EmptyState({title,children}:{title:string;children:ReactNode}){
 return <div className="empty"><span className="icon-box"><Icon name="layers"/></span><h3>{title}</h3><p>{children}</p></div>;
}
export function LoadingState(){return <div role="status" className="loading"><span className="spinner"/> Reading durable state…</div>;}
export function ErrorMessage({code,message,onDismiss}:{code:string;message:string;onDismiss?:()=>void}){
 return <div role="alert" className="error-message"><Icon name="info"/><div><strong>{message}</strong><code>{code}</code></div>{onDismiss&&<button className="dismiss" aria-label="Dismiss message" onClick={onDismiss}>×</button>}</div>;
}
export function ConfirmationDialog({busy,error,onCancel,onConfirm}:{busy:boolean;error:string|null;onCancel:()=>void;onConfirm:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{ref.current?.showModal();},[]);
 return <dialog ref={ref} aria-labelledby="reset-title" onCancel={e=>{e.preventDefault();if(!busy)onCancel();}} className="confirm-dialog">
  <span className="icon-box red"><Icon name="refresh"/></span><h2 id="reset-title">Reset this demo session?</h2>
  <p>This removes your scenario, datasets, jobs and attempts and revokes this session. Shared configuration and other sessions are preserved.</p>
  <p className="muted">A new session will receive a different company code. No automatic reset is performed.</p>
  {error&&<p role="alert" className="dialog-error">{error}</p>}
  <div className="actions"><Button variant="secondary" disabled={busy} onClick={onCancel}>Keep session</Button><Button variant="danger" disabled={busy} onClick={onConfirm}>{busy?'Resetting…':'Confirm reset'}</Button></div>
 </dialog>;
}
export const date=(value:string|null|undefined)=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'Not recorded';
export function Identity({label,value}:{label:string;value:string}){return <div className="identity"><span>{label}</span><code>{value}</code></div>;}
