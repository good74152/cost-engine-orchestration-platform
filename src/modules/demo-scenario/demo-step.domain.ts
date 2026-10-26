import type { DemoRuntime } from '../demo-session/demo-runtime.js';
import type { AuthenticatedDemoSession } from '../demo-session/demo-session.service.js';
import { DemoSessionError } from '../demo-session/demo-session.errors.js';
import { CalculationJobError } from '../calculation-job.errors.js';
import { readGuidedState, readSettledGuidedState, type GuidedState, type StepIntent, type StepLedger, type StepResult } from './demo-step.repository.js';

export const stateConflict = () => new DemoSessionError('DEMO_SCENARIO_STATE_CONFLICT', 409, 'Guided resources do not match the step contract');
export const stepUnknown = () => new DemoSessionError('DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN', 503, 'Demo step outcome unavailable; retry the same request');

export function verifyGuidedBinding(state: GuidedState | null, intent: StepIntent) {
  if (!state || state.counter !== 1 || state.versions.length !== 1 || state.jobs.length !== 1) throw stateConflict();
  const version = state.versions[0]!; const job = state.jobs[0]!;
  if (version.version !== 1 || job.dataset !== version.id || job.type !== 'DEMO_GUIDED_SUMMARY' || job.domain !== 'CAPEX'
    || (intent.datasetVersionId && intent.datasetVersionId !== version.id) || (intent.jobId && intent.jobId !== job.id)) throw stateConflict();
  if (state.attempts.length > 1 || state.snapshots.length > 1) throw stateConflict();
  const attempt = state.attempts[0]; const snapshot = state.snapshots[0];
  if (attempt && (attempt.job !== job.id || attempt.number !== 1 || attempt.dag !== 'demo_capex_guided'
    || attempt.run !== `cost-engine-${attempt.id}`)) throw stateConflict();
  if (snapshot && (snapshot.dataset !== version.id || snapshot.dependencies !== 0 || state.definitions.length !== 1
    || state.definitions[0]!.id !== job.definition || state.definitions[0]!.version !== 1
    || state.definitions[0]!.status !== 'PUBLISHED' || state.definitions[0]!.dependencies !== 0)) throw stateConflict();
  if (intent.executionAttemptId && (attempt?.id !== intent.executionAttemptId || attempt.dag !== intent.airflowDagId
    || attempt.run !== intent.airflowDagRunId || snapshot?.id !== intent.datasetBuildSnapshotId
    || job.definition !== intent.resolvedDependencyDefinitionVersionId)) throw stateConflict();
  return { version, job, attempt, snapshot };
}

export function successResult(state: GuidedState | null, ledger: StepLedger): StepResult {
  const { version, job, attempt, snapshot } = verifyGuidedBinding(state, ledger.intent);
  const n = ledger.step_number;
  if (n === 1) {
    if (version.status !== 'DRAFT' || job.status !== 'PENDING' || attempt || snapshot || job.definition) throw stateConflict();
  } else {
    if (!snapshot || !attempt || !job.definition) throw stateConflict();
    const terminal = n >= 4;
    if (version.status !== (n === 6 ? 'PUBLISHED' : n === 5 ? 'VALIDATING' : 'BUILDING')
      || job.status !== (terminal ? 'SUCCEEDED' : 'RUNNING') || attempt.status !== (terminal ? 'SUCCEEDED' : 'ACCEPTED')) throw stateConflict();
  }
  return { datasetVersionId: version.id, jobId: job.id, datasetStatus: version.status, jobStatus: job.status,
    ...(attempt ? { executionAttemptId: attempt.id, attemptStatus: attempt.status,
      datasetBuildSnapshotId: snapshot!.id, resolvedDependencyDefinitionVersionId: job.definition! } : {}),
    ...(n === 3 ? { externalStatus: 'SUCCEEDED' as const } : {}) };
}

/** No Scenario transaction surrounds any of these unchanged Domain services. */
export async function executeGuidedStep(runtime: DemoRuntime, session: AuthenticatedDemoSession, ledger: StepLedger): Promise<StepResult | null> {
  // Keep DemoRuntime construction free of global-pool initialization. The app
  // configures its database before loading the existing core service boundary.
  const { createDatasetVersionService } = await import('../dataset-version/dataset-version.service.js');
  const { runCalculationJobService } = await import('../calculation-job-run.service.js');
  const { reconcileCalculationJobService } = await import('../calculation-job-reconciliation.service.js');
  const { submitDatasetValidationService, publishDatasetVersionService } = await import('../dataset-version/dataset-version-lifecycle.service.js');
  let state: GuidedState | null;
  try { state = await readSettledGuidedState(runtime.db, session, ledger.intent); }
  catch { throw stepUnknown(); }
  const n = ledger.step_number;
  if (n === 1) {
    // An existing empty/partial/unexpected series is NOT permission to allocate v2.
    if (!state) {
      await createDatasetVersionService({ domain: 'CAPEX', companyCode: session.companyCode, fiscalYear: 2026, period: 'Q4' });
      state = await readGuidedState(runtime.db, session);
    }
    return successResult(state, ledger);
  }
  const { version, job, attempt, snapshot } = verifyGuidedBinding(state, ledger.intent);
  if (n === 2) {
    if (!(version.status === 'BUILDING' && job.status === 'RUNNING' && attempt?.status === 'ACCEPTED')) {
      if (job.status !== 'PENDING' || !['DRAFT','BUILDING'].includes(version.status)
        || (attempt && !['PREPARED','DISPATCHING'].includes(attempt.status))
        || (version.status === 'BUILDING' && !snapshot)) throw stateConflict();
      const executor = await runtime.executors.forSession(session);
      try { await runCalculationJobService(job.id, executor); }
      catch (error) {
        if (error instanceof CalculationJobError && ['EXECUTOR_DISPATCH_FAILED','DEPENDENCY_NOT_READY','DEPENDENCY_DEFINITION_NOT_READY'].includes(error.code)) throw stateConflict();
        throw error;
      }
      state = await readGuidedState(runtime.db, session);
      const reloaded = verifyGuidedBinding(state, ledger.intent);
      if (reloaded.attempt?.status === 'DISPATCHING' && reloaded.job.status === 'PENDING') return null;
    }
  } else if (n === 3) {
    successResult(state, ledger); // DB remains RUNNING/ACCEPTED; no reconciliation here.
    const executor = await runtime.executors.forSession(session);
    const identity = { airflowDagId: ledger.intent.airflowDagId!, airflowDagRunId: ledger.intent.airflowDagRunId! };
    const external = await executor.getExecutionStatus(identity);
    if (external.kind === 'UNAVAILABLE') throw stepUnknown();
    if (external.kind === 'RUNNING') {
      if (!executor.setExecutionState(identity, 'SUCCEEDED')) throw stateConflict();
    } else if (external.kind !== 'SUCCEEDED') throw stateConflict();
    if ((await executor.getExecutionStatus(identity)).kind !== 'SUCCEEDED') throw stepUnknown();
  } else if (n === 4) {
    if (!(job.status === 'SUCCEEDED' && attempt?.status === 'SUCCEEDED')) {
      if (version.status !== 'BUILDING' || job.status !== 'RUNNING' || attempt?.status !== 'ACCEPTED') throw stateConflict();
      try { await reconcileCalculationJobService(job.id, await runtime.executors.forSession(session)); }
      catch (error) {
        if (error instanceof CalculationJobError && error.code === 'EXECUTOR_STATUS_UNAVAILABLE') throw stepUnknown();
        throw error;
      }
      state = await readGuidedState(runtime.db, session);
    }
  } else {
    if (job.status !== 'SUCCEEDED' || attempt?.status !== 'SUCCEEDED') throw stateConflict();
    const target = n === 5 ? 'VALIDATING' : 'PUBLISHED';
    if (version.status !== target) {
      if (version.status !== (n === 5 ? 'BUILDING' : 'VALIDATING')) throw stateConflict();
      await (n === 5 ? submitDatasetValidationService : publishDatasetVersionService)(version.id);
      state = await readGuidedState(runtime.db, session);
    }
  }
  return successResult(state, ledger);
}
