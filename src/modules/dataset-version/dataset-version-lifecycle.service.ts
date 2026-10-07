import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import {
  DatasetHasActiveExecutionError,
  DatasetNotReadyForValidationError,
  DatasetStateConflictError,
  DatasetStateInvariantError,
  DatasetVersionNotFoundError,
} from './dataset-version.errors.js';
import {
  lockLifecycleAttempts,
  lockLifecycleDataset,
  lockLifecycleJobs,
  lockLifecycleSeries,
  readDatasetSeriesId,
  transitionLifecycleDataset,
} from './dataset-version-lifecycle.repository.js';
import type {
  LifecycleTarget,
  LockedLifecycleDataset,
} from './dataset-version-lifecycle.repository.js';
import type { DatasetLifecycleResult } from './dataset-version.types.js';

function invariant(datasetVersionId: string, message: string): never {
  throw new DatasetStateInvariantError(`datasetVersionId=${datasetVersionId}: ${message}`);
}

async function applyTransition(
  client: PoolClient,
  dataset: LockedLifecycleDataset,
  target: LifecycleTarget,
): Promise<DatasetLifecycleResult> {
  if (!await transitionLifecycleDataset(client, dataset.datasetVersionId, target)) {
    invariant(dataset.datasetVersionId, `Locked lifecycle transition to ${target} failed`);
  }
  return { ...dataset, datasetStatus: target };
}

export async function submitDatasetValidationService(
  datasetVersionId: string,
): Promise<DatasetLifecycleResult> {
  return withTransaction(async (client) => {
    const dataset = await lockLifecycleDataset(client, datasetVersionId);
    if (!dataset) throw new DatasetVersionNotFoundError(datasetVersionId);
    if (dataset.datasetStatus === 'VALIDATING') return dataset;
    if (dataset.datasetStatus === 'DRAFT') throw new DatasetNotReadyForValidationError();
    if (dataset.datasetStatus !== 'BUILDING') throw new DatasetStateConflictError();

    const jobs = await lockLifecycleJobs(client, datasetVersionId);
    if (jobs.length === 0) invariant(datasetVersionId, 'Dataset has no calculation jobs');
    const attempts = await lockLifecycleAttempts(client, datasetVersionId);
    const succeededJobs = new Set(jobs.filter((job) => job.status === 'SUCCEEDED').map((job) => job.id));
    for (const attempt of attempts) {
      if (succeededJobs.has(attempt.calculation_job_id) && isActiveAttempt(attempt.status)) {
        invariant(datasetVersionId, `SUCCEEDED job ${attempt.calculation_job_id} has active attempt ${attempt.id}`);
      }
    }
    if (jobs.some((job) => job.status !== 'SUCCEEDED')) {
      throw new DatasetNotReadyForValidationError();
    }
    return applyTransition(client, dataset, 'VALIDATING');
  });
}

function isActiveAttempt(status: string): boolean {
  return status === 'PREPARED' || status === 'DISPATCHING' || status === 'ACCEPTED';
}

async function lockTerminalDecisionDataset(
  client: PoolClient,
  datasetVersionId: string,
  seriesId: string,
): Promise<LockedLifecycleDataset> {
  if (!await lockLifecycleSeries(client, seriesId)) {
    invariant(datasetVersionId, `Owning series ${seriesId} disappeared`);
  }
  const dataset = await lockLifecycleDataset(client, datasetVersionId);
  if (!dataset || dataset.datasetSeriesId !== seriesId) {
    invariant(datasetVersionId, `Dataset disappeared or changed owning series ${seriesId}`);
  }
  return dataset;
}

async function decideValidatedDataset(
  datasetVersionId: string,
  target: 'PUBLISHED' | 'REJECTED',
): Promise<DatasetLifecycleResult> {
  // Resolve only immutable ownership before BEGIN; lifecycle is read under locks.
  const seriesId = await readDatasetSeriesId(pool, datasetVersionId);
  if (!seriesId) throw new DatasetVersionNotFoundError(datasetVersionId);
  return withTransaction(async (client) => {
    const dataset = await lockTerminalDecisionDataset(client, datasetVersionId, seriesId);
    if (dataset.datasetStatus === target) return dataset;
    if (dataset.datasetStatus !== 'VALIDATING') throw new DatasetStateConflictError();
    return applyTransition(client, dataset, target);
  });
}

export function publishDatasetVersionService(datasetVersionId: string): Promise<DatasetLifecycleResult> {
  return decideValidatedDataset(datasetVersionId, 'PUBLISHED');
}

export function rejectDatasetVersionService(datasetVersionId: string): Promise<DatasetLifecycleResult> {
  return decideValidatedDataset(datasetVersionId, 'REJECTED');
}

export async function abandonDatasetVersionService(
  datasetVersionId: string,
): Promise<DatasetLifecycleResult> {
  const seriesId = await readDatasetSeriesId(pool, datasetVersionId);
  if (!seriesId) throw new DatasetVersionNotFoundError(datasetVersionId);
  return withTransaction(async (client) => {
    const dataset = await lockTerminalDecisionDataset(client, datasetVersionId, seriesId);
    if (dataset.datasetStatus === 'ABANDONED') return dataset;
    if (dataset.datasetStatus !== 'DRAFT' && dataset.datasetStatus !== 'BUILDING') {
      throw new DatasetStateConflictError();
    }
    const jobs = await lockLifecycleJobs(client, datasetVersionId);
    if (jobs.length === 0) invariant(datasetVersionId, 'Dataset has no calculation jobs');
    const attempts = await lockLifecycleAttempts(client, datasetVersionId);
    for (const job of jobs) {
      if (job.status === 'RUNNING' && !attempts.some(
        (attempt) => attempt.calculation_job_id === job.id && attempt.status === 'ACCEPTED',
      )) {
        invariant(datasetVersionId, `RUNNING job ${job.id} has no active ACCEPTED attempt`);
      }
    }
    if (attempts.some((attempt) => isActiveAttempt(attempt.status))) {
      throw new DatasetHasActiveExecutionError();
    }
    return applyTransition(client, dataset, 'ABANDONED');
  });
}
