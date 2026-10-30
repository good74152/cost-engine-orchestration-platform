import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { cutoverPreflight } from '../src/deployment/cutover-preflight.js';

export async function runCutoverPreflight(): Promise<void> {
  const file=process.env.DEMO_CUTOVER_DATABASE_URL_FILE;
  if(!file || process.env.DEMO_CUTOVER_DATABASE_URL) throw new Error('Exactly one explicit preflight target file required');
  const target=readFileSync(file,'utf8').trim(); const url=new URL(target);
  // pg_dump runs in this Compose service. Refuse a shared secret that was
  // repointed to a different server/database or contains connection overrides.
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='database'||url.username!=='demo_owner'
    ||url.pathname!=='/cost_engine_demo'||!['','5432'].includes(url.port)||url.search||url.hash) throw new Error('Explicit Compose Demo database target required');
  const db=new Pool({connectionString:target,connectionTimeoutMillis:3000,query_timeout:6000,max:1});db.on('error',()=>{});
  try{console.info(JSON.stringify(await cutoverPreflight(db,process.env.DEPLOYMENT_VERSION??'')));}finally{await db.end();}
}
