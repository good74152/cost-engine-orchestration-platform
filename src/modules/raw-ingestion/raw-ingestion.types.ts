export type RawIngestionDomain = 
    | 'FAB_COST'
    | 'CAPEX'
    | 'DPR';

export interface AllocateRawIngestionBatchInput {
    ingestionSeriesId: string;
    domain: RawIngestionDomain;
    businessKey: string;
}

export interface AllocateRawIngestionBatchResult {
    id: string;
    ingestionSeriesId: string;
    batchSequence: number;
    status: 'LOADING';
}