import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
    pgm.createTable('raw_ingestion_batches', {
        id: { 
            type: 'uuid', 
            primaryKey: true, 
            notNull: true
        },
        domain: { 
            type: 'varchar(50)', 
            notNull: true
        },
        business_key: { 
            type: 'varchar(255)', 
            notNull: true
        },
        status: { 
            type: 'varchar(30)', 
            notNull: true , 
            check: "status IN ('LOADING','VALIDATING','READY','FAILED')"
        },
        batch_sequence: { 
            type: 'bigint', 
            notNull: true,
            check: "batch_sequence > 0"
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
            type: 'bigint', 
            notNull: false
        },
        source_total_amount: {
            type: 'numeric(20,2)', 
            notNull: false
        }
    }),
    pgm.addConstraint('raw_ingestion_batches', 'uq_raw_ingestion_batches_domain_business_key_batch_sequence', {
        unique: ['domain', 'business_key', 'batch_sequence']
    }),
    pgm.createTable({
        
    });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
        pgm.dropTable('raw_ingestion_batches');
}
