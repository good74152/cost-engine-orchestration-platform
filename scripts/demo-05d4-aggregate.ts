import {readFile,lstat,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {aggregateSummaries,check,scenarios} from './support/demo-05d4-contract.js';
export async function aggregateDirectory(directory:string,sha:string){
 const names=(await readdir(directory)).sort();check(JSON.stringify(names)===JSON.stringify(scenarios.map(s=>s+'.json').sort()));
 const inputs:unknown[]=[];
 for(const s of scenarios){const file=join(directory,s+'.json'),stat=await lstat(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=65536);
  const v=JSON.parse(await readFile(file,'utf8'));check(v.scenario===s);inputs.push(v);}
 return aggregateSummaries(inputs,sha);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{check(process.argv.length===5);const result=await aggregateDirectory(process.argv[2]!,process.argv[3]!);
  await writeFile(process.argv[4]!,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});console.info(JSON.stringify(result));}
 catch{console.error('Deployment rehearsal aggregate failed: four complete successful scenarios and owned cleanup are mandatory');process.exitCode=1;}
}
