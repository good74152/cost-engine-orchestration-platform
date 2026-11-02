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

const FALLBACK='The request didn’t finish. Reload the page to see the saved state, then try again.';
const MESSAGES:Record<string,string>={
 DEMO_SESSION_UNAVAILABLE:'Your demo session ended. Run a scenario to start a new one.',
 NETWORK_ERROR:'The reply didn’t arrive, so the result is unknown. Nothing was retried automatically. Reload the page to see the saved state.',
 DEPENDENCY_NOT_READY:'This job needs an upstream dataset that isn’t published yet. Publish the upstream dataset, then run the job again.',
 DEPENDENCY_DEFINITION_NOT_READY:'This job has no published dependency definition yet. Run the configuration seed for this environment.',
 CALCULATION_TYPE_NOT_CONFIGURED:'This domain has no calculation types configured. Run the configuration seed for this environment.',
 ACTIVE_DATASET_VERSION_EXISTS:'This dataset series already has a version in progress. Finish or abandon it first.',
 EXECUTOR_DISPATCH_FAILED:'The executor rejected this run, so it never started. You can retry the job.',
 EXECUTOR_STATUS_UNAVAILABLE:'The executor status isn’t available right now. The saved state wasn’t changed.',
 DATASET_NOT_READY_FOR_VALIDATION:'Every required job has to succeed before validation.',
 DATASET_HAS_ACTIVE_EXECUTION:'A job is still running, so this dataset can’t be abandoned yet.',
 JOB_NOT_RUNNABLE:'This job can’t run from its current state.',
 STATE_CONFLICT:'Another change got there first. Reload the page to see the current state.',
 RESET_CONFLICT:'Another operation is still running. Wait for it to finish, then clear your data.',
 DEMO_RESET_OUTCOME_UNKNOWN:'The result of clearing your data is unknown. Reload the page to check.',
 DEMO_RESET_FAILED:'Your data wasn’t cleared and nothing was lost. Try again.',
 DEMO_RATE_LIMITED:'Too many requests in a minute. Wait a moment, then run the scenario again.',
 DEMO_SESSION_QUEUE_FULL:'Too many requests are in progress. Wait a moment, then try again.',
 DEMO_SESSION_CAPACITY_REACHED:'The demo is at capacity right now. Try again later.',
 DEMO_EXECUTOR_CAPACITY_REACHED:'The demo is at capacity right now. Try again later.',
 DEMO_ADMISSION_UNAVAILABLE:'The demo’s configuration couldn’t be read. Reload the page to try again.',
 DEMO_ADMISSION_DRAINING:'The demo is being reconfigured. Try again later.',
 DEMO_NOT_WORKFLOW_OPEN:'This environment doesn’t have the six-domain configuration. Complete the Workflow cutover in the deployment guide, then reload.',
 DEMO_SESSION_CSRF_REJECTED:'The request failed the same-origin check. Open the demo from its public address.',
 INVALID_RESPONSE:'The server’s reply couldn’t be read. Reload the page to see the saved state.',
};
export function errorMessage(error:unknown):{code:string;message:string}{
 const code=error instanceof ApiError?error.code:'REQUEST_FAILED';
 return {code,message:MESSAGES[code]??FALLBACK};
}
