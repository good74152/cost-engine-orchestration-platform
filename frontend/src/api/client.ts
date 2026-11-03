import {MESSAGES,type Lang} from '../i18n/messages';

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

export function errorMessage(error:unknown,lang:Lang='en'):{code:string;message:string}{
 const code=error instanceof ApiError?error.code:'REQUEST_FAILED';const errors=MESSAGES[lang].errors;
 return {code,message:errors[code]??errors.FALLBACK!};
}
