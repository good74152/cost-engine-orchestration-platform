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
  // The exact DAG/run identity was created or confirmed.
  | { kind: 'ACCEPTED' }
  // That exact identity already exists: successful idempotent recovery.
  | { kind: 'ALREADY_EXISTS' }
  // ADR-0008: this exact identity never existed and can never be created,
  // including by overlapping/future dispatches. Irrevocable and identity-wide;
  // an adapter unable to enforce this guarantee must return UNKNOWN.
  | { kind: 'REJECTED'; message: string }
  // No irrevocable identity decision can be established. Recover with the same
  // identity; the run may already exist or may still be created later.
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
