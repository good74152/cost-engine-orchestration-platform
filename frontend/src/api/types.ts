// Public DTOs mirrored from demo-session.service, demo-scenario.repository,
// demo-step.repository and demo-read.repository. No executor commands or credentials.
export interface Session { sessionId:string; companyCode:string; expiresAt:string; status:'ACTIVE' }
export type ScenarioType='HAPPY_PATH'|'FAILURE_RETRY'|'LOST_RESPONSE_RECOVERY';
export interface Scenario {scenarioId:string;scenarioType:ScenarioType;status:'READY'|'IN_PROGRESS'|'COMPLETED';completedStep:number;createdAt:string;updatedAt:string}
export interface Pending {stepNumber:number;requestId:string}
export interface Dataset {datasetVersionId:string;datasetSeriesId:string;domain:string;fiscalYear:number;period:string;version:number;datasetStatus:string;createdAt:string}
export interface DatasetDetail extends Dataset {buildingStartedAt:string|null;validatingAt:string|null;publishedAt:string|null;rejectedAt:string|null;abandonedAt:string|null}
export interface Job {jobId:string;datasetVersionId:string;calculationTypeCode:string;jobStatus:string;createdAt:string;startedAt:string|null;finishedAt:string|null}
export interface JobDetail extends Job {datasetStatus:string}
export interface Attempt {executionAttemptId:string;attemptNumber:number;attemptStatus:string;createdAt:string;dispatchStartedAt:string|null;acceptedAt:string|null;finishedAt:string|null}
export interface Page<T>{items:T[];nextCursor:string|null}
export type AdmissionState='LEGACY_OPEN'|'DRAINING'|'WORKFLOW_OPEN';
export type WorkflowOperation='CREATE_DATASET'|'RUN_JOB'|'SET_FAKE_STATE'|'RECONCILE_JOB'|'SUBMIT_VALIDATION'|'PUBLISH_DATASET';
export interface WorkflowStep {id:string;title:string;description:string;operation:WorkflowOperation;domain?:string;prerequisites:string[];expectedResult:string}
export interface WorkflowSummary {id:string;version:number;title:string;description:string;availability:'PREVIEW'|'AVAILABLE'}
export interface WorkflowTemplate extends WorkflowSummary {steps:WorkflowStep[]}
export interface WorkflowCatalog {admissionState:AdmissionState;templates:WorkflowSummary[]}
export interface StepReply {scenarioId:string;stepNumber:number;requestId:string;stepStatus:'PENDING'|'COMPLETED';completedStep:number;scenarioStatus:string;stepResult:{
 datasetVersionId:string;jobId:string;datasetStatus:string;jobStatus:string;executionAttemptId?:string;attemptNumber?:number;attemptStatus?:string;
 datasetBuildSnapshotId?:string;resolvedDependencyDefinitionVersionId?:string;externalStatus?:'SUCCEEDED'|'FAILED';
}}
