// Bounded read-only integrity contract, audited from the current forward migrations:
// 1786634529143 (initial allocation/version checks), 1788700000000 (Core v2),
// 1792600000000 (Sessions), 1793300000000 (Gate), 1793400000000 (Workflow Gate).
// PostgreSQL 18 deparse forms are compared using the existing narrow Cast
// normalization. These declarations never execute DDL or migrate/repair a DB.
export const criticalConstraintDefinitions = [
  ["calculation_jobs","ck_calculation_jobs_status","c","CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'RUNNING'::character varying, 'SUCCEEDED'::character varying, 'FAILED'::character varying])::text[])))"],
  ["calculation_jobs","uq_calculation_jobs_dataset_type","u","UNIQUE (output_dataset_version_id, calculation_type_id)"],
  ["calculation_types","calculation_types_last_allocated_dependency_definition_ve_check","c","CHECK ((last_allocated_dependency_definition_version >= 0))"],
  ["calculation_types","uq_calculation_types_domain_code","u","UNIQUE (domain, code)"],
  ["dataset_build_snapshots","uq_dataset_build_snapshot_version","u","UNIQUE (dataset_version_id)"],
  ["dataset_series","ck_dataset_series_fiscal_year","c","CHECK ((fiscal_year > 0))"],
  ["dataset_series","ck_dataset_series_period","c","CHECK (((period)::text = ANY ((ARRAY['Q1'::character varying, 'Q2'::character varying, 'Q3'::character varying, 'Q4'::character varying])::text[])))"],
  ["dataset_series","dataset_series_last_version_check","c","CHECK ((last_allocated_version >= 0))"],
  ["dataset_series","uq_dataset_series_identity","u","UNIQUE (domain, company_code, fiscal_year, period)"],
  ["dataset_versions","ck_dataset_versions_status","c","CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'BUILDING'::character varying, 'VALIDATING'::character varying, 'PUBLISHED'::character varying, 'REJECTED'::character varying, 'ABANDONED'::character varying])::text[])))"],
  ["dataset_versions","dataset_versions_version_check","c","CHECK ((version > 0))"],
  ["dataset_versions","uq_dataset_versions_dataset_series_id_id","u","UNIQUE (dataset_series_id, id)"],
  ["dataset_versions","uq_dataset_versions_dataset_series_id_version","u","UNIQUE (dataset_series_id, version)"],
  ["demo_admission_control","demo_admission_control_id_check","c","CHECK ((id = 1))"],
  ["demo_admission_control","demo_admission_control_pkey","p","PRIMARY KEY (id)"],
  ["demo_admission_control","demo_admission_control_state_check","c","CHECK ((state = ANY (ARRAY['LEGACY_OPEN'::text, 'DRAINING'::text, 'WORKFLOW_OPEN'::text])))"],
  ["demo_sessions","ck_demo_sessions_company","c","CHECK (((company_code)::text ~ '^DEMO_[0-9A-F]{15}$'::text))"],
  ["demo_sessions","ck_demo_sessions_expiry","c","CHECK ((expires_at > created_at))"],
  ["demo_sessions","ck_demo_sessions_hash","c","CHECK ((octet_length(token_hash) = 32))"],
  ["demo_sessions","ck_demo_sessions_revocation","c","CHECK (((revoked_at IS NULL) OR (revoked_at >= created_at)))"],
  ["demo_sessions","uq_demo_sessions_company_code","u","UNIQUE (company_code)"],
  ["demo_sessions","uq_demo_sessions_token_hash","u","UNIQUE (token_hash)"],
  ["execution_attempts","execution_attempts_attempt_number_check","c","CHECK ((attempt_number > 0))"],
  ["execution_attempts","execution_attempts_status_check","c","CHECK (((status)::text = ANY ((ARRAY['PREPARED'::character varying, 'DISPATCHING'::character varying, 'ACCEPTED'::character varying, 'SUCCEEDED'::character varying, 'FAILED'::character varying, 'DISPATCH_FAILED'::character varying])::text[])))"],
  ["execution_attempts","uq_execution_attempt_airflow_run","u","UNIQUE (airflow_dag_id, airflow_dag_run_id)"],
  ["execution_attempts","uq_execution_attempt_job_number","u","UNIQUE (calculation_job_id, attempt_number)"],
  ["execution_dependency_definition_versions","execution_dependency_definition_versions_status_check","c","CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'PUBLISHED'::character varying, 'ABANDONED'::character varying])::text[])))"],
  ["execution_dependency_definition_versions","execution_dependency_definition_versions_version_check","c","CHECK ((version > 0))"],
  ["execution_dependency_definition_versions","uq_dependency_definition_type_id","u","UNIQUE (calculation_type_id, id)"],
  ["execution_dependency_definition_versions","uq_dependency_definition_type_version","u","UNIQUE (calculation_type_id, version)"]
] as const;

export const criticalIndexDefinitions = [
  ["uq_dataset_versions_active_series","CREATE UNIQUE INDEX uq_dataset_versions_active_series ON public.dataset_versions USING btree (dataset_series_id) WHERE ((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'BUILDING'::character varying, 'VALIDATING'::character varying])::text[]))"],
  ["uq_execution_attempt_active_job","CREATE UNIQUE INDEX uq_execution_attempt_active_job ON public.execution_attempts USING btree (calculation_job_id) WHERE ((status)::text = ANY ((ARRAY['PREPARED'::character varying, 'DISPATCHING'::character varying, 'ACCEPTED'::character varying])::text[]))"]
] as const;
