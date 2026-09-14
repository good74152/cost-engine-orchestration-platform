export type DatasetVersionStatus =
  | 'DRAFT'
  | 'BUILDING'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'ABANDONED';

export type CalculationJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED';

export interface PreparedCalculationRun {
  datasetVersionId: string;
  datasetStatus: 'BUILDING';
  datasetBuildSnapshotId: string;
  jobId: string;
  jobStatus: 'PENDING';
  executionAttemptId: string;
  attemptNumber: number;
  attemptStatus: 'PREPARED';
  airflowDagId: string;
  airflowDagRunId: string;
}
