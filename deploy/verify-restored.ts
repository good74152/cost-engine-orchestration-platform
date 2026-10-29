import { Pool } from 'pg';
import { cutoverPreflight } from '../src/deployment/cutover-preflight.js';

// Invoked only in an ephemeral operator sharing the owned restore container's
// network namespace. No supplied URL, deployed secret, Compose network or HTTP app.
async function main() {
  const nonce=process.argv[2];
  if(process.argv.length!==3 || !nonce || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid restore identity');
  const db=new Pool({host:'127.0.0.1',port:5432,user:'restore_owner',database:'restore_'+nonce,
    connectionTimeoutMillis:3000,query_timeout:6000,max:1});db.on('error',()=>{});
  try{console.info(JSON.stringify(await cutoverPreflight(db,process.env.DEPLOYMENT_VERSION??'')));}finally{await db.end();}
}
main().catch(()=>{console.error('Restored database verification failed; no production recovery performed');process.exitCode=1;});
