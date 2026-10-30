import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockDemoAdmission } from '../modules/demo-admission/demo-admission.repository.js';
import { lockCutoverConfiguration, requireCutoverQuiescence, verifyCutoverConfiguration } from '../modules/demo-cutover/demo-cutover.configuration.js';
import { DemoSessionError } from '../modules/demo-session/demo-session.errors.js';
import { verifyMigrationInventory } from './verify-database.js';
import { criticalConstraintDefinitions, criticalIndexDefinitions } from './cutover-schema-invariants.js';

// Inventory audited against all existing forward migrations, including retained v1
// and raw-ingestion tables. An unknown/missing relation fails closed, even if empty.
export const firstDeploymentBusinessTables = [
  'demo_sessions','demo_scenario_instances','demo_scenario_step_executions',
  'dataset_series','dataset_versions','calculation_jobs','execution_attempts',
  'dataset_build_snapshots','dataset_build_snapshot_dependencies',
  'orchestration_v2_legacy_calculation_type_bridges','raw_ingestion_series','raw_ingestion_batches',
  'assets','raw_dpr','raw_dpr_2026_q1','raw_dpr_2026_q2','raw_dpr_2026_q3','raw_dpr_2026_q4',
  'dpr_calculation_input_snapshots','dpr_calculation_inputs','dpr_results',
] as const;
const configurationTables = ['calculation_types','execution_dependency_definition_versions','execution_dependency_definition_dependencies'] as const;
const allTables = [...firstDeploymentBusinessTables,...configurationTables,'demo_admission_control','pgmigrations'].sort();
const rejected = () => new DemoSessionError('DEMO_PREFLIGHT_REJECTED',503,'First deployment preflight failed; keep Web closed and investigate privately');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// pg_dump/reparse distributes an unbounded varchar[] -> text[] cast over each
// literal. These casts are equivalent; retain bounded casts and all other SQL.
function logicalDDL(sql:string):string {
  return sql.replace(/\(\(ARRAY\[([^\]]*)\]\)::text\[\]\)|ARRAY\[([^\]]*)\]/g,(whole:string,castList:string|undefined,plainList:string|undefined)=>{
    const entries=(castList??plainList??'').split(/,\s*/);
    const values=entries.map(entry=>/^'([A-Za-z0-9_]+)'::(?:character varying|text)$/.exec(entry)
      ?? /^\('([A-Za-z0-9_]+)'::character varying\)::text$/.exec(entry));
    // Only simple literal arrays from the approved schema are equivalent here.
    // Quoted SQL text, escaped literals, bounded casts and expressions stay exact.
    if(values.some(value=>!value)) return whole;
    const array='ARRAY['+values.map(value=>`'${value![1]}'::text`).join(', ')+']';
    return castList===undefined?array:'('+array+')';
  });
}

export interface CutoverPreflightResult {
  result: 'PASS'; deploymentVersion: string; postgresVersion: '18';
  admissionState: 'DRAINING'; admissionUpdatedAt: string; configuration: 'LEGACY';
  businessDataEmpty: true; migrations: string[]; counts: Record<string,number>;
  schemaSha256: string; configurationSha256: string;
}

async function schemaEvidence(client: PoolClient): Promise<string> {
  const relations = (await client.query<{name:string;kind:string;partition:boolean}>(`SELECT n.nspname||'.'||c.relname AS name,c.relkind AS kind,c.relispartition AS partition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND c.relkind IN ('r','p','f','v','m') ORDER BY n.nspname,c.relname`)).rows;
  if (JSON.stringify(relations.map(r=>r.name))!==JSON.stringify(allTables.map(t=>'public.'+t))
    || relations.some(r=>r.kind!==(r.name==='public.raw_dpr'?'p':'r') || r.partition!==/^public\.raw_dpr_2026_q[1-4]$/.test(r.name))) throw rejected();
  const constraints = (await client.query<{table_name:string;name:string;type:string;definition:string;valid:boolean}>(`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,
    pg_get_constraintdef(k.oid) AS definition,k.convalidated AS valid FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,k.conname`)).rows.map(c=>({...c,definition:logicalDDL(c.definition)}));
  if (constraints.some(c=>!c.valid)) throw rejected();
  if ((await client.query<{blocked:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgisinternal AND t.tgenabled NOT IN ('O','A')) AS blocked`)).rows[0]?.blocked) throw rejected();
  // Structural FK checks reuse the actual schema's keys, not another business model.
  for (const [table,definition] of [
    ['dataset_versions','FOREIGN KEY (dataset_series_id) REFERENCES dataset_series(id) ON DELETE RESTRICT'],
    ['calculation_jobs','FOREIGN KEY (output_dataset_version_id) REFERENCES dataset_versions(id) ON DELETE RESTRICT'],
    ['calculation_jobs','FOREIGN KEY (calculation_type_id) REFERENCES calculation_types(id) ON DELETE RESTRICT'],
    ['calculation_jobs','FOREIGN KEY (calculation_type_id, resolved_dependency_definition_version_id) REFERENCES execution_dependency_definition_versions(calculation_type_id, id) ON DELETE RESTRICT'],
    ['execution_attempts','FOREIGN KEY (calculation_job_id) REFERENCES calculation_jobs(id) ON DELETE RESTRICT'],
    ['dataset_build_snapshots','FOREIGN KEY (dataset_version_id) REFERENCES dataset_versions(id) ON DELETE RESTRICT'],
    ['dataset_build_snapshot_dependencies','FOREIGN KEY (upstream_dataset_series_id, upstream_dataset_version_id) REFERENCES dataset_versions(dataset_series_id, id) ON DELETE RESTRICT'],
    ['demo_scenario_instances','FOREIGN KEY (session_id) REFERENCES demo_sessions(id) ON DELETE RESTRICT'],
    ['demo_scenario_step_executions','FOREIGN KEY (scenario_id) REFERENCES demo_scenario_instances(id) ON DELETE RESTRICT'],
    ['execution_dependency_definition_dependencies','FOREIGN KEY (definition_version_id) REFERENCES execution_dependency_definition_versions(id) ON DELETE RESTRICT'],
  ]) if (!constraints.some(c=>c.table_name===table && c.type==='f' && c.definition===definition)) throw rejected();
  for (const [table,name,type,definition] of criticalConstraintDefinitions) {
    if (!constraints.some(c=>c.table_name===table && c.name===name && c.type===type && c.definition===logicalDDL(definition))) throw rejected();
  }
  const indexes = (await client.query<{name:string;definition:string;valid:boolean}>(`SELECT i.relname AS name,pg_get_indexdef(i.oid) AS definition,x.indisvalid AS valid
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=i.relnamespace
    WHERE n.nspname='public' ORDER BY i.relname`)).rows.map(i=>({...i,definition:logicalDDL(i.definition)}));
  if (indexes.some(i=>!i.valid) || !criticalIndexDefinitions.every(([name,definition])=>
    indexes.some(i=>i.name===name && i.definition===logicalDDL(definition)))) throw rejected();
  const triggers = (await client.query<{name:string;enabled:string;definition:string}>(`SELECT t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
  if (!['protect_demo_admission_row','protect_demo_admission_truncate','demo_step_binding','demo_scenario_binding']
    .every(name=>triggers.some(t=>t.name===name && t.enabled==='O'))) throw rejected();
  // A logical restore removes holes left by historical DROP COLUMN. Compare the
  // visible column order, not PostgreSQL's physical attribute slot numbers.
  const columns = (await client.query(`SELECT table_name,column_name,
    (row_number() OVER (PARTITION BY table_name ORDER BY ordinal_position))::integer AS position,data_type,udt_schema,udt_name,
    character_maximum_length,numeric_precision,numeric_precision_radix,numeric_scale,datetime_precision,is_nullable,column_default,
    is_identity,identity_generation,is_generated,generation_expression,collation_name,domain_name
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
  const functions = (await client.query(`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
  return sha({constraints,indexes,triggers,columns,functions});
}

/** Logical read-only verification. Row/table locks need a normal transaction;
 * no DML, cleanup, migration, Cutover or HTTP runtime is called. PASS expires at return. */
export async function cutoverPreflight(db: Pool, deploymentVersion: string, migrationsDirectory='migrations'): Promise<CutoverPreflightResult> {
  let client: PoolClient | undefined;
  try {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(deploymentVersion)) throw rejected();
    client=await db.connect(); await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout='3s'"); await client.query("SET LOCAL statement_timeout='5s'");
    await client.query('SET LOCAL search_path=pg_catalog,public');
    await client.query("SET LOCAL TimeZone='UTC'");
    const gate=await lockDemoAdmission(client);
    if(gate.state!=='DRAINING') throw rejected();
    await lockCutoverConfiguration(client,false);
    await requireCutoverQuiescence(client);
    await client.query(`LOCK TABLE orchestration_v2_legacy_calculation_type_bridges,raw_ingestion_series,raw_ingestion_batches,
      assets,raw_dpr,dpr_calculation_input_snapshots,dpr_calculation_inputs,dpr_results,pgmigrations IN SHARE MODE`);
    const migrations=await verifyMigrationInventory(client,migrationsDirectory);
    await verifyCutoverConfiguration(client,'LEGACY');
    const postgres=Number((await client.query<{server_version_num:string}>('SHOW server_version_num')).rows[0]?.server_version_num);
    if(postgres<180000 || postgres>=190000 || !Number.isInteger(postgres)) throw rejected();
    const schemaSha256=await schemaEvidence(client);
    if((await client.query<{n:string}>('SELECT count(*) AS n FROM demo_admission_control')).rows[0]?.n!=='1') throw rejected();
    const counts: Record<string,number>={};
    for(const table of [...firstDeploymentBusinessTables].sort()) {
      const n=Number((await client.query<{n:string}>(`SELECT count(*) AS n FROM public.${table}`)).rows[0]?.n);
      if(!Number.isSafeInteger(n) || n!==0) throw rejected(); counts[table]=n;
    }
    const configuration: unknown[]=[];
    for(const table of configurationTables) configuration.push((await client.query(`SELECT to_jsonb(r) AS row FROM public.${table} r ORDER BY to_jsonb(r)::text`)).rows);
    const result: CutoverPreflightResult={result:'PASS',deploymentVersion,postgresVersion:'18',admissionState:'DRAINING',admissionUpdatedAt:gate.updatedAt,
      configuration:'LEGACY',businessDataEmpty:true,migrations,counts,schemaSha256,configurationSha256:sha(configuration)};
    await client.query('COMMIT'); client.release(); client=undefined; return result;
  } catch(error) {
    await client?.query('ROLLBACK').catch(()=>{});
    // Errors intentionally reveal no relation contents, SQL or connection details.
    if(error instanceof DemoSessionError && ['DEMO_PREFLIGHT_REJECTED','DEMO_CUTOVER_CONFIGURATION_CONFLICT','DEMO_CUTOVER_PRECONDITION_FAILED'].includes(error.code)) throw error;
    throw rejected();
  } finally { client?.release(true); }
}
