import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`LOCK TABLE demo_scenario_instances, demo_scenario_step_executions IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM demo_scenario_step_executions l JOIN demo_scenario_instances sc ON sc.id=l.scenario_id
        WHERE sc.scenario_type<>'HAPPY_PATH') THEN
        RAISE EXCEPTION 'Cannot reinterpret pre-02D non-Happy-Path ledger history';
      END IF;
    END $$;
    -- Keep the exact applied validator for lossless supported rollback, not a
    -- rewritten copy of historical migration code.
    ALTER FUNCTION validate_demo_step_binding() RENAME TO validate_demo_step_binding_02c;
    DROP TRIGGER demo_step_binding ON demo_scenario_step_executions;
    ALTER TABLE demo_scenario_step_executions DROP CONSTRAINT demo_scenario_step_executions_step_number_check;
    ALTER TABLE demo_scenario_step_executions DROP CONSTRAINT demo_scenario_step_executions_check;
    ALTER TABLE demo_scenario_step_executions ADD CONSTRAINT ck_demo_step_range CHECK(step_number BETWEEN 1 AND 9);
    ALTER TABLE demo_scenario_step_executions ADD CONSTRAINT ck_demo_step_completion CHECK (
      ((status='PENDING' AND result IS NULL AND completed_at IS NULL) OR
       (status='COMPLETED' AND result IS NOT NULL AND completed_at IS NOT NULL AND jsonb_typeof(result)='object'
        AND jsonb_typeof(result->'stepResult')='object')) IS TRUE);

    CREATE FUNCTION validate_demo_step_binding() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE company text; kind text; total int; num int; prior jsonb; initial_run jsonb;
      failed_result jsonb; item jsonb; expected_dataset text; expected_job text; expected_attempt text; external text;
    BEGIN
      IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.scenario_id<>OLD.scenario_id OR NEW.step_number<>OLD.step_number
        OR NEW.request_id<>OLD.request_id OR NEW.intent<>OLD.intent OR NEW.created_at<>OLD.created_at OR OLD.status='COMPLETED') THEN
        RAISE EXCEPTION 'Immutable demo step history' USING ERRCODE='23514';
      END IF;
      SELECT s.company_code,sc.scenario_type INTO STRICT company,kind FROM demo_scenario_instances sc
        JOIN demo_sessions s ON s.id=sc.session_id WHERE sc.id=NEW.scenario_id FOR UPDATE OF sc;
      IF kind NOT IN ('HAPPY_PATH','FAILURE_RETRY') THEN
        RAISE EXCEPTION 'Unsupported demo scenario type' USING ERRCODE='23514';
      END IF;
      total:=CASE WHEN kind='HAPPY_PATH' THEN 6 ELSE 9 END;
      num:=CASE WHEN kind='FAILURE_RETRY' AND NEW.step_number>=5 THEN 2 ELSE 1 END;
      IF NEW.step_number NOT BETWEEN 1 AND total THEN
        RAISE EXCEPTION 'Invalid scenario step range' USING ERRCODE='23514';
      END IF;
      expected_dataset:=CASE WHEN NEW.step_number=1 THEN 'DRAFT' WHEN NEW.step_number=total THEN 'PUBLISHED'
        WHEN NEW.step_number=total-1 THEN 'VALIDATING' ELSE 'BUILDING' END;
      expected_job:=CASE WHEN NEW.step_number=1 THEN 'PENDING' WHEN kind='FAILURE_RETRY' AND NEW.step_number=4 THEN 'FAILED'
        WHEN (kind='HAPPY_PATH' AND NEW.step_number>=4) OR (kind='FAILURE_RETRY' AND NEW.step_number>=7)
          THEN 'SUCCEEDED' ELSE 'RUNNING' END;
      expected_attempt:=CASE WHEN expected_job='RUNNING' THEN 'ACCEPTED' ELSE expected_job END;
      external:=CASE WHEN kind='FAILURE_RETRY' AND NEW.step_number=3 THEN 'FAILED'
        WHEN (kind='HAPPY_PATH' AND NEW.step_number=3) OR (kind='FAILURE_RETRY' AND NEW.step_number=6) THEN 'SUCCEEDED' END;
      IF NEW.status='COMPLETED' AND NOT coalesce(NEW.result @> jsonb_build_object(
        'scenarioId',NEW.scenario_id,'stepNumber',NEW.step_number,'requestId',NEW.request_id,
        'stepStatus','COMPLETED','completedStep',NEW.step_number,
        'scenarioStatus',CASE WHEN NEW.step_number=total THEN 'COMPLETED' ELSE 'IN_PROGRESS' END,
        'stepResult',jsonb_build_object('datasetStatus',expected_dataset,'jobStatus',expected_job))
        AND (NEW.step_number=1 OR NEW.result->'stepResult' @> jsonb_build_object('attemptStatus',expected_attempt))
        AND (NEW.step_number=1 OR kind='HAPPY_PATH' OR NEW.result->'stepResult' @> jsonb_build_object('attemptNumber',num))
        AND (external IS NULL OR NEW.result->'stepResult' @> jsonb_build_object('externalStatus',external)),false) THEN
        RAISE EXCEPTION 'Invalid demo completion result' USING ERRCODE='23514';
      END IF;
      IF NEW.step_number=1 THEN
        IF NEW.intent<>jsonb_build_object('domain','CAPEX','companyCode',company,'fiscalYear',2026,
          'period','Q4','expectedVersion',1,'calculationTypeCode','DEMO_GUIDED_SUMMARY') THEN
          RAISE EXCEPTION 'Invalid demo dataset intent' USING ERRCODE='23514';
        END IF;
      ELSE
        SELECT result->'stepResult' INTO prior FROM demo_scenario_step_executions
          WHERE scenario_id=NEW.scenario_id AND step_number=NEW.step_number-1 AND status='COMPLETED';
        IF prior IS NULL OR NEW.intent->>'datasetVersionId' IS DISTINCT FROM prior->>'datasetVersionId'
          OR NEW.intent->>'jobId' IS DISTINCT FROM prior->>'jobId' THEN
          RAISE EXCEPTION 'Invalid demo parent binding' USING ERRCODE='23514';
        END IF;
        IF NEW.step_number>2 THEN
          SELECT result->'stepResult' INTO initial_run FROM demo_scenario_step_executions
            WHERE scenario_id=NEW.scenario_id AND step_number=2 AND status='COMPLETED';
          IF NEW.intent->>'datasetBuildSnapshotId' IS DISTINCT FROM initial_run->>'datasetBuildSnapshotId'
            OR NEW.intent->>'resolvedDependencyDefinitionVersionId' IS DISTINCT FROM initial_run->>'resolvedDependencyDefinitionVersionId' THEN
            RAISE EXCEPTION 'Changed demo frozen inputs' USING ERRCODE='23514';
          END IF;
          IF NOT (kind='FAILURE_RETRY' AND NEW.step_number=5)
            AND NEW.intent->>'executionAttemptId' IS DISTINCT FROM prior->>'executionAttemptId' THEN
            RAISE EXCEPTION 'Changed demo attempt binding' USING ERRCODE='23514';
          END IF;
        END IF;
      END IF;
      IF num=2 THEN
        SELECT result->'stepResult' INTO failed_result FROM demo_scenario_step_executions
          WHERE scenario_id=NEW.scenario_id AND step_number=4 AND status='COMPLETED';
        IF NOT coalesce(NEW.intent @> '{"previousAttemptStatus":"FAILED","expectedAttemptNumber":2}'::jsonb
          AND NEW.intent->>'previousExecutionAttemptId'=failed_result->>'executionAttemptId'
          AND failed_result->>'attemptStatus'='FAILED'
          AND NOT (NEW.step_number=5 AND NEW.intent ? 'executionAttemptId')
          AND EXISTS(SELECT 1 FROM execution_attempts a WHERE a.id=(NEW.intent->>'previousExecutionAttemptId')::uuid
            AND a.calculation_job_id=(NEW.intent->>'jobId')::uuid AND a.attempt_number=1 AND a.status='FAILED'
            AND to_jsonb(a)=NEW.intent->'previousAttemptHistory'),false) THEN
          RAISE EXCEPTION 'Invalid retry predecessor history' USING ERRCODE='23514';
        END IF;
        IF NEW.step_number>5 AND NOT EXISTS(SELECT 1 FROM demo_scenario_step_executions retry
          WHERE retry.scenario_id=NEW.scenario_id AND retry.step_number=5 AND retry.status='COMPLETED'
            AND retry.intent->'previousAttemptHistory'=NEW.intent->'previousAttemptHistory') THEN
          RAISE EXCEPTION 'Changed retry predecessor history' USING ERRCODE='23514';
        END IF;
      END IF;
      FOR item IN SELECT NEW.intent UNION ALL SELECT NEW.result->'stepResult' WHERE NEW.result IS NOT NULL LOOP
        IF item ? 'datasetVersionId' THEN
          IF NOT EXISTS(SELECT 1 FROM dataset_versions v JOIN dataset_series ds ON ds.id=v.dataset_series_id
            JOIN calculation_jobs j ON j.output_dataset_version_id=v.id JOIN calculation_types ct ON ct.id=j.calculation_type_id
            WHERE v.id=(item->>'datasetVersionId')::uuid AND j.id=(item->>'jobId')::uuid
              AND ds.company_code=company AND ds.domain='CAPEX' AND ds.fiscal_year=2026 AND ds.period='Q4'
              AND v.version=1 AND ct.domain='CAPEX' AND ct.code='DEMO_GUIDED_SUMMARY'
              AND (SELECT count(*) FROM calculation_jobs WHERE output_dataset_version_id=v.id)=1
              AND (SELECT count(*) FROM execution_attempts WHERE calculation_job_id=j.id)<=num
              AND NOT EXISTS(SELECT 1 FROM execution_attempts WHERE calculation_job_id=j.id AND attempt_number NOT BETWEEN 1 AND num)) THEN
            RAISE EXCEPTION 'Invalid demo resource binding' USING ERRCODE='23514';
          END IF;
          IF NEW.step_number>1 AND (item->>'datasetVersionId' IS DISTINCT FROM NEW.intent->>'datasetVersionId'
            OR item->>'jobId' IS DISTINCT FROM NEW.intent->>'jobId') THEN
            RAISE EXCEPTION 'Changed demo resource binding' USING ERRCODE='23514';
          END IF;
        ELSIF NEW.step_number>1 OR (NEW.status='COMPLETED' AND item=NEW.result->'stepResult') THEN
          RAISE EXCEPTION 'Missing demo resource binding' USING ERRCODE='23514';
        END IF;
        IF item ? 'executionAttemptId' THEN
          IF NOT EXISTS(SELECT 1 FROM execution_attempts a JOIN calculation_jobs j ON j.id=a.calculation_job_id
            JOIN dataset_build_snapshots b ON b.dataset_version_id=j.output_dataset_version_id
            WHERE a.id=(item->>'executionAttemptId')::uuid AND a.calculation_job_id=(item->>'jobId')::uuid AND a.attempt_number=num
              AND b.id=(item->>'datasetBuildSnapshotId')::uuid
              AND j.resolved_dependency_definition_version_id=(item->>'resolvedDependencyDefinitionVersionId')::uuid
              AND a.airflow_dag_id='demo_capex_guided' AND a.airflow_dag_run_id='cost-engine-'||a.id::text
              AND (NOT item ? 'airflowDagId' OR a.airflow_dag_id=item->>'airflowDagId')
              AND (NOT item ? 'airflowDagRunId' OR a.airflow_dag_run_id=item->>'airflowDagRunId')) THEN
            RAISE EXCEPTION 'Invalid demo attempt binding' USING ERRCODE='23514';
          END IF;
          IF NEW.step_number>2 AND NOT (kind='FAILURE_RETRY' AND NEW.step_number=5)
            AND item->>'executionAttemptId' IS DISTINCT FROM NEW.intent->>'executionAttemptId' THEN
            RAISE EXCEPTION 'Changed demo attempt binding' USING ERRCODE='23514';
          END IF;
        ELSIF (NEW.step_number>2 AND NOT (kind='FAILURE_RETRY' AND NEW.step_number=5 AND item=NEW.intent))
          OR (NEW.step_number=2 AND NEW.status='COMPLETED' AND item=NEW.result->'stepResult') THEN
          RAISE EXCEPTION 'Missing demo attempt binding' USING ERRCODE='23514';
        END IF;
      END LOOP;
      RETURN NEW;
    END $$;
    CREATE TRIGGER demo_step_binding BEFORE INSERT OR UPDATE ON demo_scenario_step_executions
      FOR EACH ROW EXECUTE FUNCTION validate_demo_step_binding();
    CREATE FUNCTION preserve_demo_scenario_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (NEW.id<>OLD.id OR NEW.session_id<>OLD.session_id OR NEW.scenario_type<>OLD.scenario_type)
        AND EXISTS(SELECT 1 FROM demo_scenario_step_executions WHERE scenario_id=OLD.id) THEN
        RAISE EXCEPTION 'Immutable demo scenario binding' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER demo_scenario_binding BEFORE UPDATE ON demo_scenario_instances
      FOR EACH ROW EXECUTE FUNCTION preserve_demo_scenario_binding();`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`LOCK TABLE demo_scenario_instances, demo_scenario_step_executions IN ACCESS EXCLUSIVE MODE;
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM demo_scenario_instances WHERE scenario_type='FAILURE_RETRY') THEN
        RAISE EXCEPTION 'Cannot roll back with retained Failure Retry scenarios';
      END IF;
    END $$;
    DROP TRIGGER demo_scenario_binding ON demo_scenario_instances;
    DROP FUNCTION preserve_demo_scenario_binding();
    DROP TRIGGER demo_step_binding ON demo_scenario_step_executions;
    DROP FUNCTION validate_demo_step_binding();
    ALTER FUNCTION validate_demo_step_binding_02c() RENAME TO validate_demo_step_binding;
    CREATE TRIGGER demo_step_binding BEFORE INSERT OR UPDATE ON demo_scenario_step_executions
      FOR EACH ROW EXECUTE FUNCTION validate_demo_step_binding();
    ALTER TABLE demo_scenario_step_executions DROP CONSTRAINT ck_demo_step_range;
    ALTER TABLE demo_scenario_step_executions DROP CONSTRAINT ck_demo_step_completion;
    ALTER TABLE demo_scenario_step_executions ADD CONSTRAINT demo_scenario_step_executions_step_number_check CHECK(step_number BETWEEN 1 AND 6);
    ALTER TABLE demo_scenario_step_executions ADD CONSTRAINT demo_scenario_step_executions_check CHECK (
      ((status='PENDING' AND result IS NULL AND completed_at IS NULL) OR
       (status='COMPLETED' AND completed_at IS NOT NULL AND result IS NOT NULL AND jsonb_typeof(result)='object'
        AND result @> jsonb_build_object('scenarioId',scenario_id,'stepNumber',step_number,'requestId',request_id,
          'stepStatus','COMPLETED','completedStep',step_number,'scenarioStatus',CASE WHEN step_number=6 THEN 'COMPLETED' ELSE 'IN_PROGRESS' END)
        AND jsonb_typeof(result->'stepResult')='object'
        AND result->'stepResult' @> jsonb_build_object('datasetStatus',CASE WHEN step_number=1 THEN 'DRAFT' WHEN step_number=5 THEN 'VALIDATING'
          WHEN step_number=6 THEN 'PUBLISHED' ELSE 'BUILDING' END,'jobStatus',CASE WHEN step_number=1 THEN 'PENDING' WHEN step_number<4 THEN 'RUNNING' ELSE 'SUCCEEDED' END)
        AND (step_number=1 OR result->'stepResult' @> jsonb_build_object('attemptStatus',CASE WHEN step_number<4 THEN 'ACCEPTED' ELSE 'SUCCEEDED' END))
        AND (step_number<>3 OR result->'stepResult' @> '{"externalStatus":"SUCCEEDED"}'::jsonb))) IS TRUE);`);
}
