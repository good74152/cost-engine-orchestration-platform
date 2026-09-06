import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- This is a forward migration from the original one-job-per-dataset model.
    -- Keep legacy_business_key during the transition so rollback does not lose
    -- historical identifiers. Application code must stop using it.

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM calculation_dependencies
      ) THEN
        RAISE EXCEPTION
          'orchestration-schema-v2 cannot safely migrate non-empty calculation_dependencies; migrate legacy dependency history explicitly first';
      END IF;
    END
    $$;

    ALTER TABLE dataset_series
      DROP CONSTRAINT IF EXISTS uq_dataset_series_domain_business_key;

    ALTER TABLE dataset_series
      RENAME COLUMN business_key TO legacy_business_key;

    ALTER TABLE dataset_series
      RENAME COLUMN last_version TO last_allocated_version;

    ALTER TABLE dataset_series
      ADD COLUMN company_code VARCHAR(20),
      ADD COLUMN fiscal_year INTEGER,
      ADD COLUMN period VARCHAR(10),
      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM dataset_series
        WHERE legacy_business_key !~ '^[^:]+:[0-9]{4}:Q[1-4](?::.*)?$'
      ) THEN
        RAISE EXCEPTION
          'Cannot derive canonical identity from one or more legacy business_key values. Expected COMPANY_CODE:FISCAL_YEAR:Qn[:legacy-suffix].';
      END IF;
    END
    $$;

    UPDATE dataset_series
    SET
      company_code = split_part(legacy_business_key, ':', 1),
      fiscal_year = split_part(legacy_business_key, ':', 2)::INTEGER,
      period = split_part(legacy_business_key, ':', 3);

    ALTER TABLE dataset_series
      ALTER COLUMN company_code SET NOT NULL,
      ALTER COLUMN fiscal_year SET NOT NULL,
      ALTER COLUMN period SET NOT NULL;

    ALTER TABLE dataset_series
      ADD CONSTRAINT ck_dataset_series_fiscal_year
        CHECK (fiscal_year > 0),
      ADD CONSTRAINT ck_dataset_series_period
        CHECK (period IN ('Q1', 'Q2', 'Q3', 'Q4')),
      ADD CONSTRAINT uq_dataset_series_identity
        UNIQUE (domain, company_code, fiscal_year, period);

    -- Dataset version lifecycle belongs to the publication unit. Execution
    -- failures are represented by calculation jobs / attempts, not by the
    -- dataset version itself. Legacy FAILED rows become non-published,
    -- terminal ABANDONED rows during this model transition.
    DO $$
    DECLARE
      constraint_name TEXT;
    BEGIN
      FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'dataset_versions'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format(
          'ALTER TABLE dataset_versions DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;
    END
    $$;

    ALTER TABLE dataset_versions
      ADD COLUMN building_started_at TIMESTAMPTZ,
      ADD COLUMN validating_at TIMESTAMPTZ,
      ADD COLUMN rejected_at TIMESTAMPTZ,
      ADD COLUMN abandoned_at TIMESTAMPTZ;

    UPDATE dataset_versions
    SET status = 'ABANDONED'
    WHERE status = 'FAILED';

    ALTER TABLE dataset_versions
      ADD CONSTRAINT ck_dataset_versions_status
        CHECK (status IN (
          'DRAFT',
          'BUILDING',
          'VALIDATING',
          'PUBLISHED',
          'REJECTED',
          'ABANDONED'
        ));

    CREATE UNIQUE INDEX uq_dataset_versions_active_series
      ON dataset_versions (dataset_series_id)
      WHERE status IN ('DRAFT', 'BUILDING', 'VALIDATING');

    CREATE INDEX idx_dataset_versions_latest_published
      ON dataset_versions (dataset_series_id, version DESC)
      WHERE status = 'PUBLISHED';

    DROP TABLE calculation_dependencies;

    CREATE TABLE calculation_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      domain VARCHAR(50) NOT NULL,
      code VARCHAR(100) NOT NULL,
      airflow_dag_id VARCHAR(250) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_allocated_dependency_definition_version INTEGER NOT NULL DEFAULT 0
        CHECK (last_allocated_dependency_definition_version >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_calculation_types_domain_code
        UNIQUE (domain, code)
    );

    -- Existing jobs are retained for history only. They are attached to an
    -- inactive legacy calculation type so new dataset creation cannot snapshot
    -- this compatibility type into the v2 workflow.
    INSERT INTO calculation_types (
      domain,
      code,
      airflow_dag_id,
      is_active
    )
    SELECT DISTINCT
      ds.domain,
      'LEGACY_DEFAULT',
      'legacy_' || lower(regexp_replace(ds.domain, '[^a-zA-Z0-9_]+', '_', 'g')),
      FALSE
    FROM calculation_jobs cj
    JOIN dataset_versions dv
      ON dv.id = cj.output_dataset_version_id
    JOIN dataset_series ds
      ON ds.id = dv.dataset_series_id
    ON CONFLICT (domain, code) DO NOTHING;

    CREATE TABLE execution_dependency_definition_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      calculation_type_id UUID NOT NULL
        REFERENCES calculation_types(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      status VARCHAR(20) NOT NULL
        CHECK (status IN ('DRAFT', 'PUBLISHED', 'ABANDONED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      CONSTRAINT uq_dependency_definition_type_version
        UNIQUE (calculation_type_id, version),
      CONSTRAINT uq_dependency_definition_type_id
        UNIQUE (calculation_type_id, id)
    );

    CREATE INDEX idx_dependency_definition_latest_published
      ON execution_dependency_definition_versions (
        calculation_type_id,
        version DESC
      )
      WHERE status = 'PUBLISHED';

    CREATE TABLE execution_dependency_definition_dependencies (
      definition_version_id UUID NOT NULL
        REFERENCES execution_dependency_definition_versions(id)
        ON DELETE RESTRICT,
      required_domain VARCHAR(50) NOT NULL,
      PRIMARY KEY (definition_version_id, required_domain)
    );

    ALTER TABLE calculation_jobs
      DROP CONSTRAINT IF EXISTS composite_fk_calculation_jobs;

    ALTER TABLE calculation_jobs
      DROP CONSTRAINT IF EXISTS uq_calculation_jobs_output_dataset_version;

    DROP INDEX IF EXISTS uq_calculation_jobs_active_series;

    DO $$
    DECLARE
      constraint_name TEXT;
    BEGIN
      FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'calculation_jobs'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'
      LOOP
        EXECUTE format(
          'ALTER TABLE calculation_jobs DROP CONSTRAINT %I',
          constraint_name
        );
      END LOOP;
    END
    $$;

    ALTER TABLE calculation_jobs
      ADD COLUMN calculation_type_id UUID,
      ADD COLUMN resolved_dependency_definition_version_id UUID;

    UPDATE calculation_jobs cj
    SET calculation_type_id = ct.id
    FROM dataset_versions dv,
         dataset_series ds,
         calculation_types ct
    WHERE dv.id = cj.output_dataset_version_id
      AND ds.id = dv.dataset_series_id
      AND ct.domain = ds.domain
      AND ct.code = 'LEGACY_DEFAULT';

    UPDATE calculation_jobs
    SET status = 'SUCCEEDED'
    WHERE status IN ('VALIDATING', 'REJECTED');

    ALTER TABLE calculation_jobs
      ALTER COLUMN calculation_type_id SET NOT NULL;

    ALTER TABLE calculation_jobs
      ADD CONSTRAINT fk_calculation_jobs_calculation_type
        FOREIGN KEY (calculation_type_id)
        REFERENCES calculation_types(id)
        ON DELETE RESTRICT,
      ADD CONSTRAINT fk_calculation_jobs_resolved_definition
        FOREIGN KEY (
          calculation_type_id,
          resolved_dependency_definition_version_id
        )
        REFERENCES execution_dependency_definition_versions (
          calculation_type_id,
          id
        )
        ON DELETE RESTRICT,
      ADD CONSTRAINT uq_calculation_jobs_dataset_type
        UNIQUE (output_dataset_version_id, calculation_type_id),
      ADD CONSTRAINT ck_calculation_jobs_status
        CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'));

    ALTER TABLE calculation_jobs
      DROP COLUMN dataset_series_id;

    CREATE TABLE dataset_build_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dataset_version_id UUID NOT NULL
        REFERENCES dataset_versions(id)
        ON DELETE RESTRICT,
      frozen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_dataset_build_snapshot_version
        UNIQUE (dataset_version_id)
    );

    CREATE TABLE dataset_build_snapshot_dependencies (
      snapshot_id UUID NOT NULL
        REFERENCES dataset_build_snapshots(id)
        ON DELETE RESTRICT,
      upstream_dataset_series_id UUID NOT NULL,
      upstream_dataset_version_id UUID NOT NULL,
      PRIMARY KEY (snapshot_id, upstream_dataset_series_id),
      CONSTRAINT fk_snapshot_dependency_series_version
        FOREIGN KEY (
          upstream_dataset_series_id,
          upstream_dataset_version_id
        )
        REFERENCES dataset_versions(dataset_series_id, id)
        ON DELETE RESTRICT
    );

    CREATE INDEX idx_snapshot_dependencies_upstream_version
      ON dataset_build_snapshot_dependencies (upstream_dataset_version_id);

    CREATE TABLE execution_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      calculation_job_id UUID NOT NULL
        REFERENCES calculation_jobs(id)
        ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status VARCHAR(30) NOT NULL
        CHECK (status IN (
          'PREPARED',
          'DISPATCHING',
          'ACCEPTED',
          'SUCCEEDED',
          'FAILED',
          'DISPATCH_FAILED'
        )),
      airflow_dag_id VARCHAR(250) NOT NULL,
      airflow_dag_run_id VARCHAR(250) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dispatch_started_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      last_dispatch_error TEXT,
      CONSTRAINT uq_execution_attempt_job_number
        UNIQUE (calculation_job_id, attempt_number),
      CONSTRAINT uq_execution_attempt_airflow_run
        UNIQUE (airflow_dag_id, airflow_dag_run_id)
    );

    CREATE UNIQUE INDEX uq_execution_attempt_active_job
      ON execution_attempts (calculation_job_id)
      WHERE status IN ('PREPARED', 'DISPATCHING', 'ACCEPTED');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT output_dataset_version_id
        FROM calculation_jobs
        GROUP BY output_dataset_version_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION
          'Cannot roll back orchestration-schema-v2: one or more dataset versions have multiple calculation jobs';
      END IF;
    END
    $$;

    DROP INDEX IF EXISTS uq_execution_attempt_active_job;
    DROP TABLE execution_attempts;

    DROP INDEX IF EXISTS idx_snapshot_dependencies_upstream_version;
    DROP TABLE dataset_build_snapshot_dependencies;
    DROP TABLE dataset_build_snapshots;

    ALTER TABLE calculation_jobs
      ADD COLUMN dataset_series_id UUID;

    UPDATE calculation_jobs cj
    SET dataset_series_id = dv.dataset_series_id
    FROM dataset_versions dv
    WHERE dv.id = cj.output_dataset_version_id;

    ALTER TABLE calculation_jobs
      ALTER COLUMN dataset_series_id SET NOT NULL;

    ALTER TABLE calculation_jobs
      DROP CONSTRAINT IF EXISTS fk_calculation_jobs_resolved_definition,
      DROP CONSTRAINT IF EXISTS fk_calculation_jobs_calculation_type,
      DROP CONSTRAINT IF EXISTS uq_calculation_jobs_dataset_type,
      DROP CONSTRAINT IF EXISTS ck_calculation_jobs_status;

    ALTER TABLE calculation_jobs
      DROP COLUMN resolved_dependency_definition_version_id,
      DROP COLUMN calculation_type_id;

    ALTER TABLE calculation_jobs
      ADD CONSTRAINT composite_fk_calculation_jobs
        FOREIGN KEY (dataset_series_id, output_dataset_version_id)
        REFERENCES dataset_versions(dataset_series_id, id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
      ADD CONSTRAINT uq_calculation_jobs_output_dataset_version
        UNIQUE (output_dataset_version_id),
      ADD CONSTRAINT calculation_jobs_status_check
        CHECK (status IN (
          'PENDING',
          'RUNNING',
          'VALIDATING',
          'SUCCEEDED',
          'FAILED',
          'REJECTED'
        ));

    CREATE UNIQUE INDEX uq_calculation_jobs_active_series
      ON calculation_jobs (dataset_series_id)
      WHERE status IN ('PENDING', 'RUNNING', 'VALIDATING');

    DROP TABLE execution_dependency_definition_dependencies;
    DROP INDEX IF EXISTS idx_dependency_definition_latest_published;
    DROP TABLE execution_dependency_definition_versions;
    DROP TABLE calculation_types;

    CREATE TABLE calculation_dependencies (
      id UUID PRIMARY KEY,
      calculation_job_id UUID NOT NULL
        REFERENCES calculation_jobs(id) ON DELETE RESTRICT,
      dataset_version_id UUID NOT NULL
        REFERENCES dataset_versions(id) ON DELETE RESTRICT,
      dependency_type VARCHAR(50) NOT NULL
        CHECK (dependency_type IN ('FAB_COST_INPUT', 'CAPEX_INPUT')),
      policy VARCHAR(50) NOT NULL
        CHECK (policy IN ('STRICT', 'OVERRIDE')),
      CONSTRAINT uq_calculation_dependencies_type
        UNIQUE (calculation_job_id, dependency_type),
      CONSTRAINT uq_calculation_dependencies_version
        UNIQUE (calculation_job_id, dataset_version_id)
    );

    DROP INDEX IF EXISTS idx_dataset_versions_latest_published;
    DROP INDEX IF EXISTS uq_dataset_versions_active_series;

    ALTER TABLE dataset_versions
      DROP CONSTRAINT IF EXISTS ck_dataset_versions_status;

    UPDATE dataset_versions
    SET status = 'FAILED'
    WHERE status = 'ABANDONED';

    ALTER TABLE dataset_versions
      DROP COLUMN building_started_at,
      DROP COLUMN validating_at,
      DROP COLUMN rejected_at,
      DROP COLUMN abandoned_at;

    ALTER TABLE dataset_versions
      ADD CONSTRAINT dataset_versions_status_check
        CHECK (status IN (
          'DRAFT',
          'BUILDING',
          'VALIDATING',
          'PUBLISHED',
          'FAILED',
          'REJECTED'
        ));

    ALTER TABLE dataset_series
      DROP CONSTRAINT IF EXISTS uq_dataset_series_identity,
      DROP CONSTRAINT IF EXISTS ck_dataset_series_fiscal_year,
      DROP CONSTRAINT IF EXISTS ck_dataset_series_period;

    ALTER TABLE dataset_series
      DROP COLUMN company_code,
      DROP COLUMN fiscal_year,
      DROP COLUMN period,
      DROP COLUMN created_at;

    ALTER TABLE dataset_series
      RENAME COLUMN last_allocated_version TO last_version;

    ALTER TABLE dataset_series
      RENAME COLUMN legacy_business_key TO business_key;

    ALTER TABLE dataset_series
      ADD CONSTRAINT uq_dataset_series_domain_business_key
        UNIQUE (domain, business_key);
  `);
}
