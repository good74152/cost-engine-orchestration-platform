import {useNavigate} from 'react-router-dom';
import {useDemo} from '../../app/demo-context';
import {Button,Icon,Identity,StatusBadge,date} from '../../components/ui';
export function SessionCard(){
 const {model,session,busy,loading}=useDemo();const navigate=useNavigate();
 return <section className="session-card"><div className="row"><h3>Your demo workspace</h3><Icon name="shield"/></div>
 {session?<><div className="row"><span className="company">{session.companyCode}</span><StatusBadge status="ACTIVE"/></div>
 <Identity label="Session ID" value={session.sessionId}/><p className="muted">Expires {date(session.expiresAt)} · fixed four-hour lifetime</p><p className="small">Cookie authentication is managed by your browser. No credentials are stored in this UI.</p></>:
 <><p>A private company scope for guided scenarios and free exploration.</p><Button disabled={busy||loading} onClick={async()=>{if(await model.start())navigate('/');}}>{busy?'Starting…':'Start demo session'}<Icon name="arrow" size={16}/></Button><p className="small">Development demo · HttpOnly session cookie · No real financial calculation</p></>}
 </section>;
}
export function SessionRequired(){return <div className="session-required"><p className="eyebrow">A session is required</p><h1>Start your demo workspace</h1><p className="muted">Restore your workspace or explicitly start a session to continue.</p><SessionCard/></div>;}
