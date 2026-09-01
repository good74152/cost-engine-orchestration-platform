export type RawIngestionDomain = 
    | 'FAB_COST_RAW'
    | 'CAPEX_RAW'
    | 'DPR_RAW';

export interface AllocateRawIngestionBatchInput {
    domain: RawIngestionDomain;
    businessKey: string;
}

export interface AllocateRawIngestionBatchResult {
    batchId: string;
    ingestionSeriesId: string;
    batchSequence: number;
    status: 'LOADING';
}