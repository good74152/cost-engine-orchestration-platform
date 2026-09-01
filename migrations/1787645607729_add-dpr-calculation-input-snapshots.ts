import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('dpr_calculation_input_snapshots', {
        calculation_job_id: {
            type: 'uuid',
            notNull: true,
            references: 'calculation_jobs',
            onDelete: 'RESTRICT',
            primaryKey: true     
        },
        status: { 
            type: 'varchar(20)', 
            notNull: true, 
            check: "status IN ('PUBLISHED','BUILDING','FAILED')"
        },
        fab: {type: 'varchar(20)', notNull: true},
        period_start: {type: 'timestamptz', notNull: true},
        period_end: {type: 'timestamptz', notNull: true, check: "period_end > period_start"},
        source_row_count: {type: 'bigint', notNull: false},
        materialized_row_count: {type: 'bigint', notNull: false},
        source_total_amount: {type: 'numeric(20,2)', notNull: false},
        materialized_total_amount: {type: 'numeric(20,2)', notNull: false},
        invalid_asset_count: {type: 'bigint', notNull: false},
        created_at: {type: 'timestamptz', notNull: true, default: pgm.func('now()')},
        built_at: {type: 'timestamptz', notNull: false},
        failed_at: {type: 'timestamptz', notNull: false}
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable('dpr_calculation_input_snapshots');
}
