import type { DatasetDomain } from '../dataset-version/dataset-version.types.js';

/** Descriptive API capabilities, never commands for an automatic runner. */
export const WORKFLOW_OPERATIONS = [
  'CREATE_DATASET', 'RUN_JOB', 'SET_FAKE_STATE', 'RECONCILE_JOB',
  'SUBMIT_VALIDATION', 'PUBLISH_DATASET',
] as const;
export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];

export interface WorkflowStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly operation: WorkflowOperation;
  readonly domain?: DatasetDomain;
  readonly prerequisites: readonly string[];
  readonly expectedResult: string;
}

export interface WorkflowTemplate {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly availability: 'PREVIEW';
  readonly steps: readonly WorkflowStep[];
}

export type WorkflowTemplateSummary = Omit<WorkflowTemplate, 'steps'>;

/** HTTP projection only; developer-authored static definitions stay PREVIEW. */
export type WorkflowTemplateResponse = Omit<WorkflowTemplate, 'availability'> & {
  readonly availability: 'PREVIEW' | 'AVAILABLE';
};
export type WorkflowTemplateSummaryResponse = Omit<WorkflowTemplateResponse, 'steps'>;
export interface WorkflowCatalogResponse {
  readonly admissionState: 'LEGACY_OPEN' | 'DRAINING' | 'WORKFLOW_OPEN';
  readonly templates: readonly WorkflowTemplateSummaryResponse[];
}
