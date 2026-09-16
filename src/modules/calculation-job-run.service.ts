import { randomUUID } from 'node:crypto';
import type {
  CalculationExecutor,
  DispatchCalculationCommand,
  DispatchResult,
  FrozenUpstreamDatasetVersion,
} from '../executors/calculation-executor.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
  allocateNextAttemptNumber,
  findActiveExecutionAttempt,
  insertPreparedExecutionAttempt,
  lockOutputDatasetVersion,
  lockSelectedCalculationJob,
  readDatasetFreezeState,
} from './calculation-job-preparation.repository.js';
import { prepareCalculationJobRunService } from './calculation-job-preparation.service.js';
import {
  CalculationJobNotFoundError,
  CalculationStateInvariantError,
  ExecutorDispatchFailedError,
  JobNotRunnableError,
} from './calculation-job.errors.js';
import {
  findFrozenSnapshotDependencies,
  findRequiredDomainsForDefinition,
  loadCalculationJobRunRoutingState,
  lockActiveExecutionAttempt,
  lockCalculationJobDispatchContext,
  lockExecutionAttempt,
  markCalculationJobRunning,
  markExecutionAttemptAccepted,
  markExecutionAttemptDispatchFailed,
  markExecutionAttemptDispatching,
  readDatasetBuildSnapshotIds,
  recordUnknownDispatchDiagnostic,
} from './calculation-job-run.repository.js';
import type {
  CalculationJobRunRoutingState,
  FrozenSnapshotDependency,
} from './calculation-job-run.repository.js';
import type {
  CalculationJobRunResult,
  CalculationJobStatus,
} from './calculation-job.types.js';

interface DurableRunAttempt {
  datasetVersionId: string;
  datasetBuildSnapshotId: string;
  jobId: string;
  jobStatus: CalculationJobStatus;
  executionAttemptId: string;
  attemptNumber: number;
  attemptStatus: 'PREPARED' | 'DISPATCHING' | 'ACCEPTED';
  airflowDagId: string;
  airflowDagRunId: string;
}

type BeginDispatchResult =
  | { kind: 'DISPATCH'; command: DispatchCalculationCommand }
  | { kind: 'ALREADY_ACCEPTED'; result: CalculationJobRunResult };

type RecordOutcomeResult =
  | { kind: 'RESULT'; result: CalculationJobRunResult }
  | { kind: 'REJECTED' };

class AttemptRoutingRaceError extends Error {}

function invariant(message: string): never {
  throw new CalculationStateInvariantError(message);
}

function requireFrozenRoutingState(
  state: CalculationJobRunRoutingState,
): string {
  if (
    state.datasetStatus !== 'BUILDING'
    || state.snapshotIds.length !== 1
    || state.resolvedDependencyDefinitionVersionId === null
  ) {
    invariant(
      `Calculation job ${state.jobId} has inconsistent durable run state `
      + `(datasetVersionId=${state.datasetVersionId})`,
    );
  }
  return state.snapshotIds[0]!;
}

function durableAttemptFromRoutingState(
  state: CalculationJobRunRoutingState,
): DurableRunAttempt {
  const activeAttempt = state.activeAttempt;
  if (!activeAttempt) {
    invariant(`Calculation job ${state.jobId} has no active execution attempt`);
  }
  return {
    datasetVersionId: state.datasetVersionId,
    datasetBuildSnapshotId: requireFrozenRoutingState(state),
    jobId: state.jobId,
    jobStatus: state.jobStatus,
    executionAttemptId: activeAttempt.id,
    attemptNumber: activeAttempt.attemptNumber,
    attemptStatus: activeAttempt.status,
    airflowDagId: activeAttempt.airflowDagId,
    airflowDagRunId: activeAttempt.airflowDagRunId,
  };
}

async function prepareFailedCalculationJobRetry(
  state: CalculationJobRunRoutingState,
): Promise<DurableRunAttempt> {
  return withTransaction(async (client) => {
    const dataset = await lockOutputDatasetVersion(client, state.datasetVersionId);
    if (!dataset) {
      invariant(`Dataset version ${state.datasetVersionId} disappeared during retry preparation`);
    }
    if (dataset.status !== 'BUILDING') {
      throw new JobNotRunnableError(state.jobId);
    }

    const freezeState = await readDatasetFreezeState(client, state.datasetVersionId);
    if (
      freezeState.snapshotIds.length !== 1
      || freezeState.jobCount === 0
      || freezeState.resolvedJobCount !== freezeState.jobCount
    ) {
      invariant(
        `BUILDING dataset version ${state.datasetVersionId} has an inconsistent frozen build contract`,
      );
    }

    const job = await lockSelectedCalculationJob(client, state.jobId);
    if (!job || job.outputDatasetVersionId !== state.datasetVersionId) {
      invariant(`Calculation job ${state.jobId} disappeared during retry preparation`);
    }
    if (job.status !== 'FAILED') {
      throw new AttemptRoutingRaceError();
    }
    if (job.resolvedDependencyDefinitionVersionId === null) {
      invariant(`FAILED calculation job ${job.id} has no frozen dependency definition`);
    }

    const existingAttempt = await findActiveExecutionAttempt(client, job.id);
    if (existingAttempt) {
      if (
        existingAttempt.status !== 'PREPARED'
        && existingAttempt.status !== 'DISPATCHING'
      ) {
        invariant(
          `FAILED calculation job ${job.id} has contradictory active attempt ${existingAttempt.id} (${existingAttempt.status})`,
        );
      }
      return {
        datasetVersionId: state.datasetVersionId,
        datasetBuildSnapshotId: freezeState.snapshotIds[0]!,
        jobId: job.id,
        jobStatus: 'FAILED',
        executionAttemptId: existingAttempt.id,
        attemptNumber: existingAttempt.attemptNumber,
        attemptStatus: existingAttempt.status,
        airflowDagId: existingAttempt.airflowDagId,
        airflowDagRunId: existingAttempt.airflowDagRunId,
      };
    }

    const attemptNumber = await allocateNextAttemptNumber(client, job.id);
    const executionAttemptId = randomUUID();
    const airflowDagRunId = `cost-engine-${executionAttemptId}`;
    await insertPreparedExecutionAttempt(client, {
      id: executionAttemptId,
      jobId: job.id,
      attemptNumber,
      airflowDagId: job.airflowDagId,
      airflowDagRunId,
    });
    return {
      datasetVersionId: state.datasetVersionId,
      datasetBuildSnapshotId: freezeState.snapshotIds[0]!,
      jobId: job.id,
      jobStatus: 'FAILED',
      executionAttemptId,
      attemptNumber,
      attemptStatus: 'PREPARED',
      airflowDagId: job.airflowDagId,
      airflowDagRunId,
    };
  });
}

async function obtainDurableRunAttempt(jobId: string): Promise<DurableRunAttempt> {
  const state = await loadCalculationJobRunRoutingState(pool, jobId);
  if (!state) {
    throw new CalculationJobNotFoundError(jobId);
  }

  if (state.jobStatus === 'SUCCEEDED') {
    throw new JobNotRunnableError(jobId);
  }
  if (state.jobStatus === 'RUNNING') {
    if (!state.activeAttempt || state.activeAttempt.status !== 'ACCEPTED') {
      invariant(`RUNNING calculation job ${jobId} has no ACCEPTED active attempt`);
    }
    return durableAttemptFromRoutingState(state);
  }

  if (state.jobStatus === 'PENDING') {
    if (state.activeAttempt) {
      if (state.activeAttempt.status === 'ACCEPTED') {
        invariant(`PENDING calculation job ${jobId} has an ACCEPTED active attempt`);
      }
      return durableAttemptFromRoutingState(state);
    }
    const prepared = await prepareCalculationJobRunService(jobId);
    return {
      datasetVersionId: prepared.datasetVersionId,
      datasetBuildSnapshotId: prepared.datasetBuildSnapshotId,
      jobId: prepared.jobId,
      jobStatus: prepared.jobStatus,
      executionAttemptId: prepared.executionAttemptId,
      attemptNumber: prepared.attemptNumber,
      attemptStatus: prepared.attemptStatus,
      airflowDagId: prepared.airflowDagId,
      airflowDagRunId: prepared.airflowDagRunId,
    };
  }

  if (state.datasetStatus !== 'BUILDING') {
    throw new JobNotRunnableError(jobId);
  }
  if (state.activeAttempt) {
    if (state.activeAttempt.status === 'ACCEPTED') {
      invariant(`FAILED calculation job ${jobId} has an ACCEPTED active attempt`);
    }
    return durableAttemptFromRoutingState(state);
  }
  return prepareFailedCalculationJobRetry(state);
}

function selectRelevantFrozenDependencies(
  jobId: string,
  snapshotId: string,
  requiredDomains: string[],
  snapshotDependencies: FrozenSnapshotDependency[],
): FrozenUpstreamDatasetVersion[] {
  const dependenciesByDomain = new Map<string, FrozenSnapshotDependency[]>();
  for (const dependency of snapshotDependencies) {
    const current = dependenciesByDomain.get(dependency.domain) ?? [];
    current.push(dependency);
    dependenciesByDomain.set(dependency.domain, current);
  }

  return requiredDomains.map((domain) => {
    const candidates = dependenciesByDomain.get(domain) ?? [];
    if (candidates.length !== 1) {
      invariant(
        `Frozen definition for calculation job ${jobId} requires ${domain}, `
        + `but snapshot ${snapshotId} contains ${candidates.length} matching dependencies`,
      );
    }
    return candidates[0]!;
  });
}

function acceptedResult(
  attempt: DurableRunAttempt,
  dispatchOutcome: 'ACCEPTED' | 'ALREADY_EXISTS' = 'ACCEPTED',
): CalculationJobRunResult {
  return {
    datasetVersionId: attempt.datasetVersionId,
    datasetStatus: 'BUILDING',
    datasetBuildSnapshotId: attempt.datasetBuildSnapshotId,
    jobId: attempt.jobId,
    jobStatus: 'RUNNING',
    executionAttemptId: attempt.executionAttemptId,
    attemptNumber: attempt.attemptNumber,
    attemptStatus: 'ACCEPTED',
    airflowDagId: attempt.airflowDagId,
    airflowDagRunId: attempt.airflowDagRunId,
    dispatchOutcome,
  };
}

async function beginDispatch(
  durableAttempt: DurableRunAttempt,
): Promise<BeginDispatchResult> {
  return withTransaction(async (client) => {
    const context = await lockCalculationJobDispatchContext(
      client,
      durableAttempt.jobId,
    );
    if (!context) {
      invariant(`Calculation job ${durableAttempt.jobId} disappeared before dispatch`);
    }
    if (context.datasetStatus !== 'BUILDING') {
      invariant(
        `Active attempt ${durableAttempt.executionAttemptId} belongs to non-BUILDING `
        + `dataset version ${context.datasetVersionId} (${context.datasetStatus})`,
      );
    }

    const snapshotIds = await readDatasetBuildSnapshotIds(
      client,
      context.datasetVersionId,
    );
    if (
      snapshotIds.length !== 1
      || context.resolvedDependencyDefinitionVersionId === null
    ) {
      invariant(
        `Calculation job ${context.jobId} has an inconsistent frozen build contract `
        + `(datasetVersionId=${context.datasetVersionId})`,
      );
    }
    const snapshotId = snapshotIds[0]!;
    if (snapshotId !== durableAttempt.datasetBuildSnapshotId) {
      invariant(`Dataset snapshot changed before dispatch for calculation job ${context.jobId}`);
    }

    const activeAttempt = await lockActiveExecutionAttempt(client, context.jobId);
    if (!activeAttempt || activeAttempt.id !== durableAttempt.executionAttemptId) {
      throw new AttemptRoutingRaceError();
    }

    const normalizedAttempt: DurableRunAttempt = {
      ...durableAttempt,
      jobStatus: context.jobStatus,
      attemptNumber: activeAttempt.attemptNumber,
      attemptStatus: activeAttempt.status,
      airflowDagId: activeAttempt.airflowDagId,
      airflowDagRunId: activeAttempt.airflowDagRunId,
    };

    if (activeAttempt.status === 'ACCEPTED') {
      if (context.jobStatus !== 'RUNNING') {
        invariant(
          `ACCEPTED attempt ${activeAttempt.id} has contradictory job state ${context.jobStatus}`,
        );
      }
      return {
        kind: 'ALREADY_ACCEPTED',
        result: acceptedResult(normalizedAttempt),
      };
    }
    if (context.jobStatus !== 'PENDING' && context.jobStatus !== 'FAILED') {
      invariant(
        `Active attempt ${activeAttempt.id} cannot dispatch from job state ${context.jobStatus}`,
      );
    }
    if (activeAttempt.status === 'PREPARED') {
      const transitioned = await markExecutionAttemptDispatching(
        client,
        activeAttempt.id,
      );
      if (!transitioned) {
        invariant(`Could not transition attempt ${activeAttempt.id} to DISPATCHING`);
      }
    }

    const definitionId = context.resolvedDependencyDefinitionVersionId;
    const [requiredDomains, snapshotDependencies] = await Promise.all([
      findRequiredDomainsForDefinition(client, definitionId),
      findFrozenSnapshotDependencies(client, snapshotId),
    ]);
    const upstreamDatasetVersions = selectRelevantFrozenDependencies(
      context.jobId,
      snapshotId,
      requiredDomains,
      snapshotDependencies,
    );

    return {
      kind: 'DISPATCH',
      command: {
        executionAttemptId: activeAttempt.id,
        attemptNumber: activeAttempt.attemptNumber,
        jobId: context.jobId,
        datasetVersionId: context.datasetVersionId,
        datasetBuildSnapshotId: snapshotId,
        calculationTypeId: context.calculationTypeId,
        calculationTypeCode: context.calculationTypeCode,
        resolvedDependencyDefinitionVersionId: definitionId,
        airflowDagId: activeAttempt.airflowDagId,
        airflowDagRunId: activeAttempt.airflowDagRunId,
        upstreamDatasetVersions,
      },
    };
  });
}

function commandAttempt(
  command: DispatchCalculationCommand,
  jobStatus: CalculationJobStatus,
): DurableRunAttempt {
  return {
    datasetVersionId: command.datasetVersionId,
    datasetBuildSnapshotId: command.datasetBuildSnapshotId,
    jobId: command.jobId,
    jobStatus,
    executionAttemptId: command.executionAttemptId,
    attemptNumber: command.attemptNumber,
    attemptStatus: 'DISPATCHING',
    airflowDagId: command.airflowDagId,
    airflowDagRunId: command.airflowDagRunId,
  };
}

async function recordDispatchOutcome(
  command: DispatchCalculationCommand,
  outcome: DispatchResult,
): Promise<RecordOutcomeResult> {
  return withTransaction(async (client) => {
    const context = await lockCalculationJobDispatchContext(client, command.jobId);
    if (!context) {
      invariant(`Calculation job ${command.jobId} disappeared after executor dispatch`);
    }
    if (context.datasetStatus !== 'BUILDING') {
      invariant(
        `Dispatched attempt ${command.executionAttemptId} belongs to non-BUILDING `
        + `dataset version ${context.datasetVersionId} (${context.datasetStatus})`,
      );
    }
    const attempt = await lockExecutionAttempt(client, command.executionAttemptId);
    if (!attempt || attempt.calculationJobId !== command.jobId) {
      invariant(`Execution attempt ${command.executionAttemptId} disappeared after dispatch`);
    }
    if (
      attempt.airflowDagId !== command.airflowDagId
      || attempt.airflowDagRunId !== command.airflowDagRunId
      || attempt.attemptNumber !== command.attemptNumber
    ) {
      invariant(`Execution identity changed for attempt ${command.executionAttemptId}`);
    }

    const durableAttempt = commandAttempt(command, context.jobStatus);
    if (attempt.status === 'ACCEPTED' && context.jobStatus === 'RUNNING') {
      return { kind: 'RESULT', result: acceptedResult(durableAttempt) };
    }

    if (outcome.kind === 'ACCEPTED' || outcome.kind === 'ALREADY_EXISTS') {
      if (
        attempt.status !== 'DISPATCHING'
        || (context.jobStatus !== 'PENDING' && context.jobStatus !== 'FAILED')
      ) {
        invariant(
          `Cannot confirm attempt ${attempt.id} from attempt/job state `
          + `${attempt.status}/${context.jobStatus}`,
        );
      }
      const attemptUpdated = await markExecutionAttemptAccepted(client, attempt.id);
      const jobUpdated = await markCalculationJobRunning(client, context.jobId);
      if (!attemptUpdated || !jobUpdated) {
        invariant(`Could not atomically confirm attempt ${attempt.id}`);
      }
      return {
        kind: 'RESULT',
        result: acceptedResult(durableAttempt, outcome.kind),
      };
    }

    if (outcome.kind === 'REJECTED') {
      if (
        attempt.status === 'DISPATCH_FAILED'
        && (context.jobStatus === 'PENDING' || context.jobStatus === 'FAILED')
      ) {
        return { kind: 'REJECTED' };
      }
      if (
        attempt.status !== 'DISPATCHING'
        || (context.jobStatus !== 'PENDING' && context.jobStatus !== 'FAILED')
      ) {
        invariant(
          `Cannot reject attempt ${attempt.id} from attempt/job state `
          + `${attempt.status}/${context.jobStatus}`,
        );
      }
      const updated = await markExecutionAttemptDispatchFailed(
        client,
        attempt.id,
        outcome.message,
      );
      if (!updated) {
        invariant(`Could not record definite rejection for attempt ${attempt.id}`);
      }
      return { kind: 'REJECTED' };
    }

    if (
      attempt.status !== 'DISPATCHING'
      || (context.jobStatus !== 'PENDING' && context.jobStatus !== 'FAILED')
    ) {
      invariant(
        `Cannot record unknown outcome for attempt ${attempt.id} from attempt/job state `
        + `${attempt.status}/${context.jobStatus}`,
      );
    }
    const updated = await recordUnknownDispatchDiagnostic(
      client,
      attempt.id,
      outcome.message,
    );
    if (!updated) {
      invariant(`Could not record unknown dispatch outcome for attempt ${attempt.id}`);
    }
    return {
      kind: 'RESULT',
      result: {
        datasetVersionId: command.datasetVersionId,
        datasetStatus: 'BUILDING',
        datasetBuildSnapshotId: command.datasetBuildSnapshotId,
        jobId: command.jobId,
        jobStatus: context.jobStatus,
        executionAttemptId: command.executionAttemptId,
        attemptNumber: command.attemptNumber,
        attemptStatus: 'DISPATCHING',
        airflowDagId: command.airflowDagId,
        airflowDagRunId: command.airflowDagRunId,
        dispatchOutcome: 'UNKNOWN',
      },
    };
  });
}

function unknownDispatchResult(error: unknown): DispatchResult {
  const message = error instanceof Error
    ? `Executor dispatch raised an ambiguous error: ${error.message}`
    : 'Executor dispatch raised an ambiguous error';
  return { kind: 'UNKNOWN', message };
}

export async function runCalculationJobService(
  jobId: string,
  executor: CalculationExecutor,
): Promise<CalculationJobRunResult> {
  for (let routingAttempt = 0; routingAttempt < 3; routingAttempt += 1) {
    try {
      const durableAttempt = await obtainDurableRunAttempt(jobId);
      const dispatch = await beginDispatch(durableAttempt);
      if (dispatch.kind === 'ALREADY_ACCEPTED') {
        return dispatch.result;
      }

      let outcome: DispatchResult;
      try {
        outcome = await executor.dispatch(dispatch.command);
      } catch (error: unknown) {
        outcome = unknownDispatchResult(error);
      }

      const recorded = await recordDispatchOutcome(dispatch.command, outcome);
      if (recorded.kind === 'REJECTED') {
        throw new ExecutorDispatchFailedError(jobId);
      }
      return recorded.result;
    } catch (error: unknown) {
      if (
        error instanceof AttemptRoutingRaceError
        || (error instanceof JobNotRunnableError && routingAttempt < 2)
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new JobNotRunnableError(jobId);
}
