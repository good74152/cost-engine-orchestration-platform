export const DATASET_DOMAINS = [
  'FAB_COST',
  'CAPEX',
  'DPR',
  'INSURANCE',
  'ONE_STD_COST',
  'COWOS_S',
] as const;

export const DATASET_PERIODS = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

export type DatasetDomain = (typeof DATASET_DOMAINS)[number];
export type DatasetPeriod = (typeof DATASET_PERIODS)[number];

export interface CreateDatasetVersionInput {
  domain: DatasetDomain;
  companyCode: string;
  fiscalYear: number;
  period: DatasetPeriod;
}

export interface CreatedCalculationJob {
  jobId: string;
  calculationTypeId: string;
  calculationTypeCode: string;
  jobStatus: 'PENDING';
}

export interface CreateDatasetVersionResult {
  datasetSeriesId: string;
  datasetVersionId: string;
  version: number;
  datasetStatus: 'DRAFT';
  calculationJobs: CreatedCalculationJob[];
}
