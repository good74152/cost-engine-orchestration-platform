export class ApiError extends Error {
 constructor(readonly status:number,readonly code:string){super(code);this.name='ApiError';}
}
export class ApiClient {
 constructor(private readonly unavailable:()=>void=()=>{},private readonly fetcher:typeof fetch=(...args)=>fetch(...args)){}
 async request<T>(path:string,body?:unknown):Promise<{status:number;data:T}>{
  if(!path.startsWith('/demo/'))throw new ApiError(0,'INVALID_API_PATH');
  let response:Response;
  try{response=await this.fetcher(path,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',
    headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json','X-Demo-Session':'1'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new ApiError(0,'NETWORK_ERROR');}
  if(response.status===401)this.unavailable();
  if(response.status===204)return {status:204,data:undefined as T};
  let data:unknown;
  try{data=await response.json();}catch{throw new ApiError(response.status,'INVALID_RESPONSE');}
  if(!response.ok){
   const code=typeof data==='object'&&data!==null&&'code'in data&&typeof data.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(data.code)?data.code:'REQUEST_FAILED';
   throw new ApiError(response.status,code);
  }
  return {status:response.status,data:data as T};
 }
 async get<T>(path:string):Promise<T>{return (await this.request<T>(path)).data;}
 async pages<T>(path:string):Promise<T[]>{
  const items:T[]=[];const seen=new Set<string>();let cursor:string|null=null;
  do{const query=new URLSearchParams({limit:'100'});if(cursor)query.set('cursor',cursor);
   const page=await this.get<{items:T[];nextCursor:string|null}>(path+'?'+query);
   if(!Array.isArray(page.items)||(page.nextCursor!==null&&typeof page.nextCursor!=='string'))throw new ApiError(0,'INVALID_RESPONSE');
   items.push(...page.items);cursor=page.nextCursor;
   if(cursor){if(seen.has(cursor))throw new ApiError(0,'INVALID_RESPONSE');seen.add(cursor);}
  }while(cursor);
  return items;
 }
}
export function errorMessage(error:unknown):{code:string;message:string}{
 const code=error instanceof ApiError?error.code:'REQUEST_FAILED';
 const messages:Record<string,string>={
  DEMO_SESSION_UNAVAILABLE:'Your demo session has expired. Start a new session to continue.',
  DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN:'Execution outcome is currently unknown. Retry using the same request.',
  NETWORK_ERROR:'The response could not be confirmed. Refresh state, then retry using the same request.',
  DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN:'Scenario creation is unconfirmed. Retry the same scenario type.',
  DEMO_RESET_OUTCOME_UNKNOWN:'Reset outcome is unknown. Your session has not been cleared. Refresh to check availability.',
  DEMO_RESET_FAILED:'Reset failed. Your session and data have been retained.',
  DEMO_SCENARIO_SESSION_NOT_EMPTY:'This session has prior exploration data or fake configuration. Reset and start a new session for a guided scenario.',
  DEMO_SCENARIO_TYPE_CONFLICT:'This session already belongs to another scenario. Reset to switch scenarios.',
  DEMO_SCENARIO_MODE_CONFLICT:'Guided Scenario is active. Reset your session to use Free Exploration.',
  DEMO_SCENARIO_STEP_CONFLICT:'This request conflicts with the saved step. Server progress and the pending request have been refreshed.',
  DEMO_SCENARIO_STATE_CONFLICT:'The saved resources do not match this guided step. Review the current state or reset the session.',
  DEMO_SCENARIO_CONFIGURATION_UNAVAILABLE:'Guided configuration is unavailable. Run the explicit Demo guided seed in the local environment.',
  CALCULATION_TYPE_NOT_CONFIGURED:'No active calculation types are configured for this domain. The local Demo seed supports CAPEX.',
  DEPENDENCY_DEFINITION_NOT_READY:'A published dependency definition is required before Run.',
  DEPENDENCY_NOT_READY:'A required published upstream dataset is unavailable.',
  ACTIVE_DATASET_VERSION_EXISTS:'This dataset series already has an active version.',
  EXECUTOR_DISPATCH_FAILED:'The executor definitely rejected this execution identity. Inspect the attempt before retrying.',
  DEMO_RESOURCE_UNAVAILABLE:'This resource is unavailable in your current session.',
  DATASET_NOT_READY_FOR_VALIDATION:'All required calculations must succeed before validation.',
  DATASET_HAS_ACTIVE_EXECUTION:'An active execution prevents this operation.',
  JOB_NOT_RUNNABLE:'This calculation cannot run from its current durable state.',
  EXECUTOR_STATUS_UNAVAILABLE:'Executor status is unavailable. No failure has been inferred.',
  EXECUTION_NOT_RECONCILABLE:'This execution is not eligible for reconciliation.',
  STATE_CONFLICT:'The operation conflicts with the current durable state. Refresh and review.',
  RESET_CONFLICT:'Another operation is active. Wait before resetting or retrying.',
  DEMO_SESSION_QUEUE_FULL:'The session queue is full. Wait, then retry explicitly.',
  DEMO_SESSION_CSRF_REJECTED:'The request failed the same-origin security check. Check the local proxy configuration.',
  INVALID_REQUEST:'The request is invalid. Check the entered fields.',
  INVALID_DOMAIN:'Choose one of the supported machine domain identifiers.',
  INVALID_PERIOD:'Choose Q1, Q2, Q3 or Q4.',
  STORAGE_UNAVAILABLE:'Browser storage is unavailable. Enable storage before sending a step; a new request has not been sent.',
  INVALID_RESPONSE:'The server response could not be verified. Refresh before continuing.',
 };
 return {code,message:messages[code]??'The request could not be completed. Refresh durable state before trying again.'};
}
