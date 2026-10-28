import assert from 'node:assert/strict';
import test from 'node:test';
import { getWorkflowTemplate, listWorkflowTemplates, validateWorkflowTemplates } from '../src/modules/workflow-template/workflow-template.catalog.js';
import { WORKFLOW_OPERATIONS, type WorkflowTemplate } from '../src/modules/workflow-template/workflow-template.types.js';

const ids = ['HAPPY_PATH', 'FAILURE_RETRY', 'LOST_RESPONSE_RECOVERY', 'SIX_DOMAIN_WORKFLOW'];
const templates = ids.map(id => getWorkflowTemplate(id)!);
const clone = () => structuredClone(templates[0]!);

test('four stable identities, positive versions, PREVIEW and exact descriptive fields', () => {
  assert.deepEqual(listWorkflowTemplates().map(t => t.id), ids);
  for (const template of templates) {
    assert.equal(template.version, 1);
    assert.equal(template.availability, 'PREVIEW');
    assert.deepEqual(Object.keys(template).sort(), ['availability', 'description', 'id', 'steps', 'title', 'version']);
    assert.ok(template.title && template.description && template.steps.length);
    for (const step of template.steps) {
      assert.deepEqual(Object.keys(step).sort(), ['description', 'domain', 'expectedResult', 'id', 'operation', 'prerequisites', 'title']);
      assert.ok(step.title && step.description && step.expectedResult);
      assert.ok(WORKFLOW_OPERATIONS.includes(step.operation));
    }
  }
});

test('list summaries match details, missing IDs have no fallback, definitions are immutable', () => {
  for (const summary of listWorkflowTemplates()) {
    const { steps, ...detailSummary } = getWorkflowTemplate(summary.id)!;
    assert.deepEqual(summary, detailSummary);
    assert.ok(Object.isFrozen(getWorkflowTemplate(summary.id)) && Object.isFrozen(steps));
    assert.ok(steps.every(s => Object.isFrozen(s) && Object.isFrozen(s.prerequisites)));
  }
  for (const id of ['missing', 'happy_path', '__proto__', 'constructor']) assert.equal(getWorkflowTemplate(id), undefined);
});

test('stable step IDs and unique steps in each template', () => {
  assert.deepEqual(templates.map(t => t.steps.map(s => s.id)), [
    ['capex.create', 'capex.run', 'capex.fake-success', 'capex.reconcile', 'capex.validate', 'capex.publish'],
    ['capex.create', 'capex.run', 'capex.fake-failure', 'capex.reconcile-failure', 'capex.retry', 'capex.fake-success', 'capex.reconcile', 'capex.validate', 'capex.publish'],
    ['capex.create', 'capex.run-lost-response', 'capex.recover', 'capex.fake-success', 'capex.reconcile', 'capex.validate', 'capex.publish'],
    ['fab_cost', 'capex', 'dpr', 'insurance', 'one_std_cost', 'e2e_cost'].flatMap(domain =>
      ['create', 'run', 'fake-success', 'reconcile', 'validate', 'publish'].map(action => `${domain}.${action}`)),
  ]);
  for (const template of templates) assert.equal(new Set(template.steps.map(s => s.id)).size, template.steps.length);
});

test('all prerequisites resolve within the same acyclic template (independent topological check)', () => {
  for (const template of templates) {
    const done = new Set<string>();
    while (done.size < template.steps.length) {
      const ready = template.steps.filter(s => !done.has(s.id) && s.prerequisites.every(id => done.has(id)));
      assert.ok(ready.length, `${template.id} has a cycle or unknown prerequisite`);
      for (const step of ready) done.add(step.id);
    }
  }
  validateWorkflowTemplates(templates);
});

test('six-domain dependencies bind upstream publication to downstream creation without extra cross-domain edges', () => {
  const six = getWorkflowTemplate('SIX_DOMAIN_WORKFLOW')!;
  const crossDomain = six.steps.flatMap(s => s.prerequisites.filter(id => six.steps.find(p => p.id === id)!.domain !== s.domain)
    .map(id => [id, s.id]));
  assert.deepEqual(crossDomain, [
    ['fab_cost.publish', 'capex.create'], ['capex.publish', 'dpr.create'],
    ['fab_cost.publish', 'insurance.create'], ['fab_cost.publish', 'one_std_cost.create'],
    ['one_std_cost.publish', 'e2e_cost.create'],
  ]);
  assert.equal(six.steps.filter(s => s.operation === 'CREATE_DATASET').length, 6);
  assert.ok(six.steps.filter(s => s.operation === 'RUN_JOB').every(s => /each required Job/.test(s.description)));
  assert.doesNotMatch(JSON.stringify(templates), /sessionId|companyCode|completedStep|executionStatus|datasetVersionId|requestId/);
});

test('validator rejects invalid versions and duplicate template identities', () => {
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateWorkflowTemplates([{ ...clone(), version }]), /version/);
  }
  assert.throws(() => validateWorkflowTemplates([clone(), clone()]), /template ID/);
  assert.throws(() => validateWorkflowTemplates([{ ...clone(), id: '' }]), /template ID/);
});

test('validator rejects duplicate/empty step IDs, foreign prerequisites and cycles', () => {
  const template = clone();
  const first = template.steps[0]!;
  assert.throws(() => validateWorkflowTemplates([{ ...template, steps: [first, first] }]), /step ID/);
  assert.throws(() => validateWorkflowTemplates([{ ...template, steps: [{ ...first, id: '' }] }]), /step ID/);
  for (const prerequisites of [['foreign.step'], [first.id]]) {
    assert.throws(() => validateWorkflowTemplates([{ ...template, steps: [{ ...first, prerequisites }] }]), /prerequisite/);
  }
  assert.throws(() => validateWorkflowTemplates([{ ...template, steps: [
    { ...first, prerequisites: ['second'] }, { ...first, id: 'second', prerequisites: [first.id] },
  ] }]), /Cyclic/);
});

test('validator rejects capabilities outside Demo API and invalid creation domains', () => {
  const template = clone();
  for (const change of [{ operation: 'START_WORKFLOW' }, { domain: 'COWOS_S' }, { domain: undefined }]) {
    const invalid = { ...template, steps: [{ ...template.steps[0], ...change }] } as unknown as WorkflowTemplate;
    assert.throws(() => validateWorkflowTemplates([invalid]), /operation|domain/);
  }
});
