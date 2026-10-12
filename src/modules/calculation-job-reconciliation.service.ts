import type {
  CalculationExecutor,
  ExecutionIdentity,
  ExecutorExecutionStatus,
} from '../executors/calculation-executor.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
  CalculationJobNotFoundError,
  CalculationStateInvariantError,
  ExecutionAttemptNotFoundError,
  ExecutionNotReconcilableError,
  ExecutorStatusUnavailableError,
} from './calculation-job.errors.js';
import {
  findExecutionAttemptIdByIdentity,
  findManualReconciliationSelection,
  hasNewerExecutionAttempt,
  loadReconciliationAttemptContext,
  lockReconciliationJob,
  transitionAttemptToTerminal,
  transitionDispatchingAttemptToAccepted,
  transitionJobToRunning,
  transitionJobToTerminal,
} from './calculation-job-reconciliation.repository.js';
import type {
  ReconciliationAttemptContext,
} from './calculation-job-reconciliation.repository.js';
import { lockExecutionAttempt } from './calculation-job-run.repository.js';
import type {
  CalculationJobReconciliationResult,
  CalculationJobStatus,
  ReconciliationAttemptStatus,
  ReconciliationExecutorStatus,
} from './calculation-job.types.js';

function invariant(message: string): never {
  throw new CalculationStateInvariantError(message);
}

function reconciliationDiagnostic(
  context: ReconciliationAttemptContext,
  localAttemptStatus: string,
  executorStatus: string,
): string {
  return [
    `datasetVersionId=${context.datasetVersionId}`,
    `jobId=${context.jobId}`,
    `executionAttemptId=${context.executionAttemptId}`,
    `attemptNumber=${context.attemptNumber}`,
    `airflowDagId=${context.airflowDagId}`,
    `airflowDagRunId=${context.airflowDagRunId}`,
    `localAttemptStatus=${localAttemptStatus}`,
    `executorStatus=${executorStatus}`,
  ].join(', ');
}

function isExecutorBackedAttemptStatus(status: string): status is
  'DISPATCHING' | 'ACCEPTED' | 'SUCCEEDED' | 'FAILED' {
  return (
    status === 'DISPATCHING'
    || status === 'ACCEPTED'
    || status === 'SUCCEEDED'
    || status === 'FAILED'
  );
}

function isTerminalAttemptStatus(status: string): status is 'SUCCEEDED' | 'FAILED' {
  return status === 'SUCCEEDED' || status === 'FAILED';
}

function resultFromDurableState(params: {
  context: ReconciliationAttemptContext;
  jobStatus: CalculationJobStatus;
  attemptStatus: ReconciliationAttemptStatus;
  executorStatus: ReconciliationExecutorStatus;
}): CalculationJobReconciliationResult {
  if (params.context.datasetStatus === 'DRAFT') {
    invariant(`Reconciled attempt belongs to DRAFT dataset ${params.context.datasetVersionId}`);
  }
  return {
    datasetVersionId: params.context.datasetVersionId,
    datasetStatus: params.context.datasetStatus,
    jobId: params.context.jobId,
    jobStatus: params.jobStatus,
    executionAttemptId: params.context.executionAttemptId,
    attemptNumber: params.context.attemptNumber,
    attemptStatus: params.attemptStatus,
    airflowDagId: params.context.airflowDagId,
    airflowDagRunId: params.context.airflowDagRunId,
    executorStatus: params.executorStatus,
  };
}

async function lookupExecutorStatus(
  executor: CalculationExecutor,
  identity: ExecutionIdentity,
): Promise<ExecutorExecutionStatus> {
  try {
    return await executor.getExecutionStatus(identity);
  } catch (_error: unknown) {
    throw new ExecutorStatusUnavailableError();
  }
}

async function applyReconciliation(
  phaseAContext: ReconciliationAttemptContext,
  executorStatus: ReconciliationExecutorStatus,
): Promise<CalculationJobReconciliationResult> {
  return withTransaction(async (client) => {
    // Canonical mutation lock order: calculation_job, then execution_attempt.
    const job = await lockReconciliationJob(client, phaseAContext.jobId);
    if (!job) {
      invariant(`Calculation job disappeared during reconciliation: ${phaseAContext.jobId}`);
    }
    const attempt = await lockExecutionAttempt(
      client,
      phaseAContext.executionAttemptId,
    );
    if (!attempt || attempt.calculationJobId !== job.jobId) {
      invariant(
        `Execution attempt disappeared or changed owner during reconciliation: `
        + phaseAContext.executionAttemptId,
      );
    }
    if (
      job.datasetVersionId !== phaseAContext.datasetVersionId
      || attempt.attemptNumber !== phaseAContext.attemptNumber
      || attempt.airflowDagId !== phaseAContext.airflowDagId
      || attempt.airflowDagRunId !== phaseAContext.airflowDagRunId
    ) {
      invariant(
        `Durable reconciliation identity changed: ${reconciliationDiagnostic(
          phaseAContext,
          attempt.status,
          executorStatus,
        )}`,
      );
    }
    // Reload after acquiring the job/attempt locks: a waiting SELECT with a
    // joined dataset can otherwise retain its pre-wait lifecycle observation.
    const currentContext = await loadReconciliationAttemptContext(client, attempt.id);
    if (!currentContext) invariant(`Locked attempt disappeared: ${attempt.id}`);

    const newerAttemptExists = await hasNewerExecutionAttempt(
      client,
      job.jobId,
      attempt.attemptNumber,
    );

    if (isTerminalAttemptStatus(attempt.status)) {
      if (currentContext.datasetStatus === 'DRAFT') {
        invariant(`Terminal attempt ${attempt.id} belongs to DRAFT dataset ${job.datasetVersionId}`);
      }
      // A non-terminal Phase A can be overtaken by another reconciliation while
      // executor lookup is in flight. Its RUNNING observation is then stale.
      const isStaleRunningObservation = executorStatus === 'RUNNING'
        && (
          phaseAContext.attemptStatus === 'DISPATCHING'
          || phaseAContext.attemptStatus === 'ACCEPTED'
        );
      if (executorStatus !== attempt.status && !isStaleRunningObservation) {
        invariant(
          `Terminal reconciliation contradiction: ${reconciliationDiagnostic(
            phaseAContext,
            attempt.status,
            executorStatus,
          )}`,
        );
      }
      if (!newerAttemptExists && job.jobStatus !== attempt.status) {
        invariant(
          `Terminal attempt/job state is inconsistent: ${reconciliationDiagnostic(
            phaseAContext,
            attempt.status,
            executorStatus,
          )}, jobStatus=${job.jobStatus}`,
        );
      }
      return resultFromDurableState({
        context: currentContext,
        jobStatus: job.jobStatus,
        attemptStatus: attempt.status,
        executorStatus: attempt.status,
      });
    }

    if (currentContext.datasetStatus !== 'BUILDING') {
      invariant(
        `Reconciliation attempted outside BUILDING: ${reconciliationDiagnostic(
          currentContext,
          attempt.status,
          executorStatus,
        )}`,
      );
    }

    if (newerAttemptExists) {
      invariant(
        `Non-terminal stale attempt detected: ${reconciliationDiagnostic(
          phaseAContext,
          attempt.status,
          executorStatus,
        )}`,
      );
    }

    if (attempt.status === 'DISPATCHING') {
      if (job.jobStatus !== 'PENDING' && job.jobStatus !== 'FAILED') {
        invariant(
          `DISPATCHING attempt has contradictory job state: ${reconciliationDiagnostic(
            phaseAContext,
            attempt.status,
            executorStatus,
          )}, jobStatus=${job.jobStatus}`,
        );
      }
      if (executorStatus === 'RUNNING') {
        const attemptUpdated = await transitionDispatchingAttemptToAccepted(
          client,
          attempt.id,
        );
        const jobUpdated = await transitionJobToRunning(client, job.jobId);
        if (!attemptUpdated || !jobUpdated) {
          invariant(`Could not atomically recover DISPATCHING attempt ${attempt.id}`);
        }
        return resultFromDurableState({
          context: currentContext,
          jobStatus: 'RUNNING',
          attemptStatus: 'ACCEPTED',
          executorStatus,
        });
      }

      const attemptUpdated = await transitionAttemptToTerminal(client, {
        executionAttemptId: attempt.id,
        expectedStatus: 'DISPATCHING',
        targetStatus: executorStatus,
      });
      const jobUpdated = await transitionJobToTerminal(client, {
        jobId: job.jobId,
        expectedStatuses: ['PENDING', 'FAILED'],
        targetStatus: executorStatus,
      });
      if (!attemptUpdated || !jobUpdated) {
        invariant(`Could not atomically terminalize DISPATCHING attempt ${attempt.id}`);
      }
      return resultFromDurableState({
        context: currentContext,
        jobStatus: executorStatus,
        attemptStatus: executorStatus,
        executorStatus,
      });
    }

    if (attempt.status === 'ACCEPTED') {
      if (job.jobStatus !== 'RUNNING') {
        invariant(
          `ACCEPTED attempt has contradictory job state: ${reconciliationDiagnostic(
            phaseAContext,
            attempt.status,
            executorStatus,
          )}, jobStatus=${job.jobStatus}`,
        );
      }
      if (executorStatus === 'RUNNING') {
        return resultFromDurableState({
          context: currentContext,
          jobStatus: 'RUNNING',
          attemptStatus: 'ACCEPTED',
          executorStatus,
        });
      }

      const attemptUpdated = await transitionAttemptToTerminal(client, {
        executionAttemptId: attempt.id,
        expectedStatus: 'ACCEPTED',
        targetStatus: executorStatus,
      });
      const jobUpdated = await transitionJobToTerminal(client, {
        jobId: job.jobId,
        expectedStatuses: ['RUNNING'],
        targetStatus: executorStatus,
      });
      if (!attemptUpdated || !jobUpdated) {
        invariant(`Could not atomically terminalize ACCEPTED attempt ${attempt.id}`);
      }
      return resultFromDurableState({
        context: currentContext,
        jobStatus: executorStatus,
        attemptStatus: executorStatus,
        executorStatus,
      });
    }

    invariant(
      `Attempt became non-reconcilable during executor lookup: ${reconciliationDiagnostic(
        phaseAContext,
        attempt.status,
        executorStatus,
      )}`,
    );
  });
}

export async function selectCalculationJobAttemptForReconciliation(
  jobId: string,
): Promise<string> {
  const selection = await findManualReconciliationSelection(pool, jobId);
  if (!selection) {
    throw new CalculationJobNotFoundError(jobId);
  }
  if (selection.activeAttemptId) {
    return selection.activeAttemptId;
  }
  if (
    (selection.jobStatus === 'SUCCEEDED' || selection.jobStatus === 'FAILED')
    && selection.latestTerminalAttemptId
  ) {
    return selection.latestTerminalAttemptId;
  }
  throw new ExecutionNotReconcilableError(jobId);
}

export async function reconcileExecutionAttemptService(
  executionAttemptId: string,
  executor: CalculationExecutor,
): Promise<CalculationJobReconciliationResult> {
  const context = await loadReconciliationAttemptContext(pool, executionAttemptId);
  if (!context) {
    throw new ExecutionAttemptNotFoundError(executionAttemptId);
  }
  if (!isExecutorBackedAttemptStatus(context.attemptStatus)) {
    throw new ExecutionNotReconcilableError(context.jobId);
  }
  if (
    context.datasetStatus !== 'BUILDING'
    && (!isTerminalAttemptStatus(context.attemptStatus) || context.datasetStatus === 'DRAFT')
  ) {
    invariant(
      `Execution attempt is outside BUILDING dataset: ${reconciliationDiagnostic(
        context,
        context.attemptStatus,
        'NOT_LOOKED_UP',
      )}`,
    );
  }

  // Phase A ends before this external lookup. No explicit transaction or row lock
  // is held while waiting for the executor.
  const executorStatus = await lookupExecutorStatus(executor, {
    airflowDagId: context.airflowDagId,
    airflowDagRunId: context.airflowDagRunId,
  });
  if (executorStatus.kind === 'NOT_FOUND' || executorStatus.kind === 'UNAVAILABLE') {
    throw new ExecutorStatusUnavailableError();
  }

  return applyReconciliation(context, executorStatus.kind);
}

export async function reconcileCalculationJobService(
  jobId: string,
  executor: CalculationExecutor,
): Promise<CalculationJobReconciliationResult> {
  const executionAttemptId = await selectCalculationJobAttemptForReconciliation(jobId);
  return reconcileExecutionAttemptService(executionAttemptId, executor);
}

export async function reconcileExecutionByIdentityService(
  identity: ExecutionIdentity,
  executor: CalculationExecutor,
): Promise<CalculationJobReconciliationResult> {
  const executionAttemptId = await findExecutionAttemptIdByIdentity(pool, identity);
  if (!executionAttemptId) {
    throw new ExecutionAttemptNotFoundError(
      `${identity.airflowDagId}/${identity.airflowDagRunId}`,
    );
  }
  return reconcileExecutionAttemptService(executionAttemptId, executor);
}
