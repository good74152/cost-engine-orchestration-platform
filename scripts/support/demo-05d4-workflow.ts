import type { IncomingHttpHeaders } from 'node:http';
import type { DemoAttemptDto,DemoJobDto,DemoDatasetDetailDto } from '../../src/modules/demo-session/demo-read.repository.js';
import type { CreateDatasetVersionResult,DatasetDomain } from '../../src/modules/dataset-version/dataset-version.types.js';
import type { CalculationJobRunResult } from '../../src/modules/calculation-job.types.js';
import { types } from './six-domain-workflow-expectations.js';
import { check } from './demo-05d4-contract.js';

export interface HttpResult {status:number;body:string;headers:IncomingHttpHeaders}
export type DemoHttp=(path:string,method?:string,body?:unknown,extra?:Record<string,string>)=>Promise<HttpResult>;
const json=<T>(r:HttpResult,status=200):T=>{check(r.status===status&&r.headers['cache-control']==='no-store');return JSON.parse(r.body)as T;};
export async function workflowAcceptance(http:DemoHttp,snapshot:(id:string)=>Promise<string>){
  const pages=async<T>(path:string):Promise<T[]>=>{
    const all:T[]=[],seen=new Set<string>();let cursor:string|null=null;
    do{const p:{items:T[];nextCursor:string|null}=json(await http(path+'?limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'')));
      check(Array.isArray(p.items)&&p.items.length<=1);all.push(...p.items);check(all.length<=32);
      cursor=p.nextCursor;if(cursor!==null){check(typeof cursor==='string'&&!seen.has(cursor));seen.add(cursor);}
    }while(cursor);return all;
  };
  const data=new Map<DatasetDomain,{dataset:CreateDatasetVersionResult;jobs:DemoJobDto[]}>();
  for(const domain of Object.keys(types)as DatasetDomain[]){
    const dataset=json<CreateDatasetVersionResult>(await http('/demo/dataset-versions','POST',{domain,fiscalYear:2026,period:'Q4'}),201);
    const jobs=await pages<DemoJobDto>('/demo/dataset-versions/'+dataset.datasetVersionId+'/calculation-jobs');
    check(JSON.stringify(jobs.map(j=>j.calculationTypeCode).sort())===JSON.stringify(types[domain])&&jobs.every(j=>j.jobStatus==='PENDING'));
    data.set(domain,{dataset,jobs});
  }
  const capex=data.get('CAPEX')!;
  for(const j of capex.jobs){
    const r=await http('/demo/calculation-jobs/'+j.jobId+'/run','POST',{simulation:{dispatch:'ACCEPT',completion:'RUNNING'}});
    check(r.status===409&&JSON.parse(r.body).code==='DEPENDENCY_NOT_READY');
    check((await pages('/demo/calculation-jobs/'+j.jobId+'/execution-attempts')).length===0);
  }
  for(const {dataset,jobs}of data.values()){
    const life=(op:string)=>http('/demo/dataset-versions/'+dataset.datasetVersionId+'/'+op,'POST',{});
    check((await life('publish')).status===409);let frozen:string|undefined;
    const attempts=new Map<string,string>();
    for(const j of jobs){
      const run=json<CalculationJobRunResult>(await http('/demo/calculation-jobs/'+j.jobId+'/run','POST',{simulation:{dispatch:'ACCEPT',completion:'RUNNING'}}));
      check(run.attemptStatus==='ACCEPTED'&&run.attemptNumber===1);attempts.set(j.jobId,run.executionAttemptId);
      const digest=await snapshot(dataset.datasetVersionId);if(frozen)check(digest===frozen);else frozen=digest;
    }
    check((await life('submit-validation')).status===409);
    for(const j of jobs){
      json(await http('/demo/execution-attempts/'+attempts.get(j.jobId)+'/fake-state','POST',{state:'SUCCEEDED'}));
      check(json<DemoJobDto>(await http('/demo/calculation-jobs/'+j.jobId)).jobStatus==='RUNNING');
      json(await http('/demo/calculation-jobs/'+j.jobId+'/reconcile','POST',{}));
      const history=await pages<DemoAttemptDto>('/demo/calculation-jobs/'+j.jobId+'/execution-attempts');
      check(history.length===1&&history[0]!.attemptStatus==='SUCCEEDED'&&history[0]!.attemptNumber===1&&!!history[0]!.finishedAt);
    }
    json(await life('submit-validation'));json(await life('publish'));
    check(json<DemoDatasetDetailDto>(await http('/demo/dataset-versions/'+dataset.datasetVersionId)).datasetStatus==='PUBLISHED');
    check(await snapshot(dataset.datasetVersionId)===frozen);
  }
  check((await pages('/demo/dataset-versions')).length===6&&capex.jobs.length===2);
}
