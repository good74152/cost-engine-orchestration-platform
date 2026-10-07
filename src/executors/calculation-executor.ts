export interface FrozenUpstreamDatasetVersion {
  domain: string;
  companyCode: string;
  fiscalYear: number;
  period: string;
  datasetSeriesId: string;
  datasetVersionId: string;
  version: number;
}

export interface DispatchCalculationCommand {
  executionAttemptId: string;
  attemptNumber: number;
  jobId: string;
  datasetVersionId: string;
  datasetBuildSnapshotId: string;
  calculationTypeId: string;
  calculationTypeCode: string;
  resolvedDependencyDefinitionVersionId: string;
  airflowDagId: string;
  airflowDagRunId: string;
  upstreamDatasetVersions: FrozenUpstreamDatasetVersion[];
}

export type DispatchResult =
  | { kind: 'ACCEPTED' }
  | { kind: 'ALREADY_EXISTS' }
  | { kind: 'REJECTED'; message: string }
  | { kind: 'UNKNOWN'; message: string };

export interface ExecutionIdentity {
  airflowDagId: string;
  airflowDagRunId: string;
}

export type ExecutorExecutionStatus =
  | { kind: 'RUNNING' }
  | { kind: 'SUCCEEDED' }
  | { kind: 'FAILED'; message?: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'UNAVAILABLE'; message: string };

export interface CalculationExecutor {
  dispatch(command: DispatchCalculationCommand): Promise<DispatchResult>;
  getExecutionStatus(
    identity: ExecutionIdentity,
  ): Promise<ExecutorExecutionStatus>;
}
