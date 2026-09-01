import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('dataset_series', {
        id: { type: 'uuid', primaryKey: true },
        domain: { type: 'varchar(50)', notNull: true },
        business_key: { type: 'varchar(255)', notNull: true },
        last_version: { type: 'integer', notNull: true , default: 0 , check: 'last_version >= 0'},
    });
    pgm.addConstraint('dataset_series', 'uq_dataset_series_domain_business_key', {
        unique: ['domain','business_key']
    });

    pgm.createTable('dataset_versions', {
        id: { type: 'uuid', primaryKey: true },
        dataset_series_id: { 
            type: 'uuid', 
            notNull: true,
            references: 'dataset_series',
            onDelete: 'RESTRICT'
        },
        version: { type: 'integer', notNull: true , check: 'version > 0'},
        status: { type: 'varchar(30)', notNull: true , check: "status IN ('DRAFT','BUILDING','VALIDATING','PUBLISHED','FAILED','REJECTED')"},
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        published_at: { type: 'timestamptz', notNull: false },
    });
    pgm.addConstraint('dataset_versions', 'uq_dataset_versions_dataset_series_id_version', {
        unique: ['dataset_series_id','version']
    });
    pgm.addConstraint('dataset_versions', 'uq_dataset_versions_dataset_series_id_id', {
        unique: ['dataset_series_id','id']
    });

    pgm.createTable('calculation_jobs', {
        id: { type: 'uuid', primaryKey: true },
        dataset_series_id: { 
            type: 'uuid', 
            notNull: true,
            references: 'dataset_series',
            onDelete: 'RESTRICT'
        },
        output_dataset_version_id: { 
            type: 'uuid', 
            notNull: true
        },
        status: { type: 'varchar(20)', notNull: true, check: "status IN ('PENDING','RUNNING','VALIDATING','SUCCEEDED','FAILED','REJECTED')"},
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        started_at: { type: 'timestamptz', notNull: false },
        finished_at: { type: 'timestamptz', notNull: false },
    });
    pgm.addConstraint('calculation_jobs', 'composite_fk_calculation_jobs',
        {
            foreignKeys: {
                columns: ['dataset_series_id', 'output_dataset_version_id'],
                references: 'dataset_versions(dataset_series_id, id)',
                onDelete: 'RESTRICT',
                onUpdate: 'RESTRICT',
            }
        }
    );
    pgm.addConstraint(
        'calculation_jobs',
        'uq_calculation_jobs_output_dataset_version',
        {
            unique: ['output_dataset_version_id'],
        },
    );
    pgm.createIndex(
        'calculation_jobs',
        ['dataset_series_id'],
        {
            name: 'uq_calculation_jobs_active_series',
            unique: true,
            where: "status IN ('PENDING', 'RUNNING', 'VALIDATING')",
        }
    );
    
    pgm.createTable('calculation_dependencies', {
        id: { type: 'uuid', primaryKey: true },
        calculation_job_id: { 
            type: 'uuid', 
            notNull: true, 
            references: 'calculation_jobs',
            onDelete: 'RESTRICT'
        },
        dataset_version_id: { 
            type: 'uuid', 
            notNull: true, 
            references: 'dataset_versions',
            onDelete: 'RESTRICT'
        },
        dependency_type: { 
            type: 'varchar(50)', 
            notNull: true,
            check: "dependency_type IN ('FAB_COST_INPUT','CAPEX_INPUT')"
        },
        policy: { 
            type: 'varchar(50)', 
            notNull: true,
            check: "policy IN ('STRICT', 'OVERRIDE')"
        },
    });
    pgm.addConstraint('calculation_dependencies', 'uq_calculation_dependencies_type', {
        unique: ['calculation_job_id', 'dependency_type']
    });
    pgm.addConstraint('calculation_dependencies', 'uq_calculation_dependencies_version', {
        unique: ['calculation_job_id', 'dataset_version_id']
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable('calculation_dependencies');
    pgm.dropTable('calculation_jobs');
    pgm.dropTable('dataset_versions');
    pgm.dropTable('dataset_series');
}
