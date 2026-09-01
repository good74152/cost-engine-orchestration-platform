import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('raw_ingestion_series', {
        id: {
            type: 'uuid',
            primaryKey: true
        },
        domain: {
            type: 'varchar(50)',
            notNull: true,
            check: "domain IN ('FAB_COST_RAW','CAPEX_RAW','DPR_RAW')"
        },
        business_key: {
            type: 'varchar(255)',
            notNull: true
        },
        last_batch_sequence: {
            type: 'integer',
            notNull: true,
            default: 0,
            check: 'last_batch_sequence >= 0'
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()')
        }
    });

    pgm.addConstraint(
        'raw_ingestion_series',
        'uq_raw_ingestion_series_domain_business_key',
        {
            unique: ['domain', 'business_key']
        }
    );

    pgm.createTable('raw_ingestion_batches', {
        id: {
            type: 'uuid',
            primaryKey: true
        },
        ingestion_series_id: {
            type: 'uuid',
            notNull: true,
            references: 'raw_ingestion_series',
            onDelete: 'RESTRICT'
        },
        batch_sequence: {
            type: 'integer',
            notNull: true,
            check: 'batch_sequence > 0'
        },
        status: {
            type: 'varchar(30)',
            notNull: true,
            check: "status IN ('LOADING','VALIDATING','READY','FAILED')"
        },
        created_at: {
            type: 'timestamptz',
            notNull: true,
            default: pgm.func('now()')
        },
        completed_at: {
            type: 'timestamptz',
            notNull: false
        },
        source_row_count: {
            type: 'integer',
            notNull: false,
            check: 'source_row_count >= 0'
        },
        source_total_amount: {
            type: 'numeric(20,2)',
            notNull: false
        }
    });

    pgm.addConstraint(
        'raw_ingestion_batches',
        'uq_raw_ingestion_batches_series_sequence',
        {
            unique: ['ingestion_series_id', 'batch_sequence']
        }
    );

    pgm.createIndex(
        'raw_ingestion_batches',
        ['ingestion_series_id'],
        {
            name: 'uq_raw_ingestion_batches_active_series',
            unique: true,
            where: "status IN ('LOADING', 'VALIDATING')"
        }
    );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
    pgm.dropTable('raw_ingestion_batches');
    pgm.dropTable('raw_ingestion_series');
}
