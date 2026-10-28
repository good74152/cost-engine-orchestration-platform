import type { MigrationBuilder } from 'node-pg-migrate';

// Naming-01 is an offline, forward-only identifier correction. UUID references,
// version counters, DAG mappings and immutable execution/audit payloads survive.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // One SQL statement makes the checks and writes atomic even when invoked
  // without the runner's normal enclosing migration transaction.
  pgm.sql(`
    DO $$
    BEGIN
      LOCK TABLE calculation_types, dataset_series,
        execution_dependency_definition_dependencies IN ACCESS EXCLUSIVE MODE;

      IF EXISTS (
        SELECT 1 FROM dataset_series old JOIN dataset_series target
          ON target.domain = 'E2E_COST'
         AND (target.company_code, target.fiscal_year, target.period)
           = (old.company_code, old.fiscal_year, old.period)
        WHERE old.domain = 'COWOS_S'
      ) THEN
        RAISE EXCEPTION 'Naming-01 conflict: dataset_series canonical identity';
      END IF;

      IF EXISTS (
        SELECT 1 FROM dataset_series old JOIN dataset_series target
          ON target.domain = 'E2E_COST'
         AND target.legacy_business_key = old.legacy_business_key
        WHERE old.domain = 'COWOS_S'
      ) THEN
        RAISE EXCEPTION 'Naming-01 conflict: dataset_series legacy business key';
      END IF;

      IF EXISTS (
        SELECT 1 FROM calculation_types old JOIN calculation_types target
          ON target.domain = 'E2E_COST' AND target.code = old.code
        WHERE old.domain = 'COWOS_S'
      ) THEN
        RAISE EXCEPTION 'Naming-01 conflict: calculation_types domain/code';
      END IF;

      IF EXISTS (
        SELECT 1 FROM execution_dependency_definition_dependencies old
        JOIN execution_dependency_definition_dependencies target
          ON target.definition_version_id = old.definition_version_id
         AND target.required_domain = 'E2E_COST'
        WHERE old.required_domain = 'COWOS_S'
      ) THEN
        RAISE EXCEPTION 'Naming-01 conflict: dependency definition required domain';
      END IF;

      UPDATE calculation_types SET domain = 'E2E_COST' WHERE domain = 'COWOS_S';
      UPDATE dataset_series SET domain = 'E2E_COST' WHERE domain = 'COWOS_S';
      UPDATE execution_dependency_definition_dependencies
        SET required_domain = 'E2E_COST' WHERE required_domain = 'COWOS_S';
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Only a no-data rollback is representable without a provenance ledger.
  pgm.sql(`
    DO $$
    BEGIN
      LOCK TABLE calculation_types, dataset_series,
        execution_dependency_definition_dependencies IN ACCESS EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM dataset_series WHERE domain = 'E2E_COST')
        OR EXISTS (SELECT 1 FROM calculation_types WHERE domain = 'E2E_COST')
        OR EXISTS (SELECT 1 FROM execution_dependency_definition_dependencies
                   WHERE required_domain = 'E2E_COST') THEN
        RAISE EXCEPTION 'Naming-01 cannot reverse retained E2E_COST data; use a reviewed forward migration or a coordinated pre-upgrade backup';
      END IF;
    END $$;
  `);
}
