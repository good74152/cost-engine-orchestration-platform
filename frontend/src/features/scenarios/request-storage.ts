const prefix='fcp.step.v1:';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface StepRequest {sessionId:string;scenarioId:string;stepNumber:number;requestId:string}
export const requestKey=(sessionId:string,scenarioId:string,step:number)=>prefix+sessionId+':'+scenarioId+':'+step;
export function savedRequest(storage:Storage,sessionId:string,scenarioId:string,step:number):StepRequest|null{
 try{const raw=storage.getItem(requestKey(sessionId,scenarioId,step));if(!raw)return null;const value=JSON.parse(raw) as StepRequest;
  return value.sessionId===sessionId&&value.scenarioId===scenarioId&&value.stepNumber===step&&typeof value.requestId==='string'&&uuid.test(value.requestId)?value:null;
 }catch{return null;}
}
export function saveRequest(storage:Storage,value:StepRequest):void{
 storage.setItem(requestKey(value.sessionId,value.scenarioId,value.stepNumber),JSON.stringify({
  sessionId:value.sessionId,scenarioId:value.scenarioId,stepNumber:value.stepNumber,requestId:value.requestId,
 }));
}
export function clearRequests(storage:Storage):void{
 for(let i=storage.length-1;i>=0;i--){const key=storage.key(i);if(key?.startsWith(prefix))storage.removeItem(key);}
}
