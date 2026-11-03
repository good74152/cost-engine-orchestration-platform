import { DATASET_DOMAINS, type DatasetDomain } from '../dataset-version/dataset-version.types.js';
import { WORKFLOW_OPERATIONS, type WorkflowStep, type WorkflowTemplate, type WorkflowTemplateSummary } from './workflow-template.types.js';

/** Fail fast on invalid developer-authored definitions; no DB/configuration reads. */
export function validateWorkflowTemplates(templates: readonly WorkflowTemplate[]): void {
  const ids = new Set<string>();
  for (const template of templates) {
    if (!template.id || ids.has(template.id)) throw new Error('Invalid or duplicate workflow template ID');
    ids.add(template.id);
    if (!Number.isSafeInteger(template.version) || template.version < 1) throw new Error('Invalid workflow template version');
    const steps = new Map<string, WorkflowStep>();
    for (const step of template.steps) {
      if (!step.id || steps.has(step.id)) throw new Error('Invalid or duplicate workflow step ID');
      if (!WORKFLOW_OPERATIONS.includes(step.operation)) throw new Error('Unsupported workflow operation');
      if ((step.domain !== undefined && !DATASET_DOMAINS.includes(step.domain))
        || (step.operation === 'CREATE_DATASET' && step.domain === undefined)) throw new Error('Invalid workflow domain');
      steps.set(step.id, step);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      const step = steps.get(id);
      if (!step) throw new Error('Unknown workflow prerequisite');
      if (visiting.has(id)) throw new Error('Cyclic workflow prerequisites');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const prerequisite of step.prerequisites) visit(prerequisite);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of steps.keys()) visit(id);
  }
}

function step(id: string, title: string, description: string, operation: WorkflowStep['operation'],
  domain: DatasetDomain, prerequisites: readonly string[], expectedResult: string): WorkflowStep {
  return { id, title, description, operation, domain, prerequisites, expectedResult };
}

// Use the complete returned/paginated job set, never a fixed job count or Dataset version.
function publicationSteps(domain: DatasetDomain, prerequisites: readonly string[] = []): WorkflowStep[] {
  const prefix = domain.toLowerCase();
  return [
    step(`${prefix}.create`, `Create ${domain}`, 'Explicitly create a Dataset for the chosen fiscal year and period. Retain the returned Dataset and all Job identities.',
      'CREATE_DATASET', domain, prerequisites, 'A DRAFT Dataset and all required PENDING Jobs exist.'),
    step(`${prefix}.run`, `Run ${domain} Jobs`, 'Read all pages of Jobs for the created Dataset. Explicitly Run each required Job with ACCEPT / RUNNING simulation. Core selects published upstream inputs at first Run; do not select a fixed Dataset version.',
      'RUN_JOB', domain, [`${prefix}.create`], 'Each required Job is RUNNING with an ACCEPTED Attempt; the Dataset has one frozen build snapshot.'),
    step(`${prefix}.fake-success`, `Simulate ${domain} success`, 'For each current accepted Attempt, explicitly set Fake state to SUCCEEDED using its owned Attempt identity.',
      'SET_FAKE_STATE', domain, [`${prefix}.run`], 'Only external Fake state changes; PostgreSQL Job and Attempt state still require Reconcile.'),
    step(`${prefix}.reconcile`, `Reconcile ${domain} Jobs`, 'Explicitly Reconcile every required Job in the Dataset against the session Fake.',
      'RECONCILE_JOB', domain, [`${prefix}.fake-success`], 'All required Jobs and their current Attempts are durably SUCCEEDED.'),
    step(`${prefix}.validate`, `Validate ${domain}`, 'Explicitly submit the Dataset for validation after every required Job has succeeded.',
      'SUBMIT_VALIDATION', domain, [`${prefix}.reconcile`], 'The Dataset is VALIDATING.'),
    step(`${prefix}.publish`, `Publish ${domain}`, 'Explicitly publish the validated Dataset.',
      'PUBLISH_DATASET', domain, [`${prefix}.validate`], 'The Dataset is PUBLISHED and available to subsequent Core input resolution.'),
  ];
}

const definitions: readonly WorkflowTemplate[] = [
  {
    id: 'SIX_DOMAIN_WORKFLOW', version: 1, title: 'Six Domain Workflow',
    description: 'FAB_COST → CAPEX → DPR; FAB_COST → INSURANCE; FAB_COST → ONE_STD_COST → E2E_COST. Use the same session, fiscal year and period throughout. These publication-first teaching prerequisites describe the configured direct dependencies; Core selects inputs at first Run. Read the complete paginated Job list and explicitly process all Jobs of every Dataset.',
    steps: [
      ...publicationSteps('FAB_COST'),
      ...publicationSteps('CAPEX', ['fab_cost.publish']),
      ...publicationSteps('DPR', ['capex.publish']),
      ...publicationSteps('INSURANCE', ['fab_cost.publish']),
      ...publicationSteps('ONE_STD_COST', ['fab_cost.publish']),
      ...publicationSteps('E2E_COST', ['one_std_cost.publish']),
    ],
  },
];

validateWorkflowTemplates(definitions);
for (const template of definitions) {
  for (const entry of template.steps) { Object.freeze(entry.prerequisites); Object.freeze(entry); }
  Object.freeze(template.steps);
  Object.freeze(template);
}
const catalog = Object.freeze(definitions);

/** List intentionally excludes steps; stable order is part of the HTTP contract. */
export function listWorkflowTemplates(): readonly WorkflowTemplateSummary[] {
  return catalog.map(({ steps: _steps, ...summary }) => summary);
}

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return catalog.find(template => template.id === id);
}
