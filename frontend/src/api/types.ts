// Public DTOs mirrored from the Demo session, read and domain routes.
// The page never receives credentials; execution identity appears only in Run replies.
export interface Session {sessionId:string;companyCode:string;expiresAt:string;status:'ACTIVE'}
export interface FrozenInput {domain:string;fiscalYear:number;period:string;version:number}
export interface Dataset {datasetVersionId:string;datasetSeriesId:string;domain:string;fiscalYear:number;period:string;version:number;datasetStatus:string;createdAt:string;frozenInputs:FrozenInput[]}
export interface CreatedDataset {datasetVersionId:string;datasetSeriesId:string;version:number;calculationJobs:{jobId:string}[]}
export interface Job {jobId:string;datasetVersionId:string;calculationTypeCode:string;jobStatus:string;createdAt:string;startedAt:string|null;finishedAt:string|null}
export interface Attempt {executionAttemptId:string;attemptNumber:number;attemptStatus:string;createdAt:string;dispatchStartedAt:string|null;acceptedAt:string|null;finishedAt:string|null}
export interface RunResult {jobId:string;jobStatus:string;executionAttemptId:string;attemptNumber:number;attemptStatus:string;airflowDagRunId:string}
export type AdmissionState='LEGACY_OPEN'|'DRAINING'|'WORKFLOW_OPEN';
export interface WorkflowCatalog {admissionState:AdmissionState}
