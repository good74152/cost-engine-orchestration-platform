import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/transaction.js';
import {
  CalculationJobNotFoundError,
  CalculationStateInvariantError,
  DependencyDefinitionNotReadyError,
  DependencyNotReadyError,
  JobNotRunnableError,
} from './calculation-job.errors.js';
import {
  allocateNextAttemptNumber,
  findActiveExecutionAttempt,
  findLatestPublishedDependencyDefinitions,
  findLatestPublishedUpstreamVersion,
  findRequiredDomains,
  insertDatasetBuildSnapshot,
  insertDatasetBuildSnapshotDependency,
  insertPreparedExecutionAttempt,
  loadCalculationRunContext,
  lockCalculationType,
  lockOutputDatasetVersion,
  lockSelectedCalculationJob,
  lockUpstreamDatasetSeries,
  persistResolvedDependencyDefinition,
  readDatasetFreezeState,
  transitionDatasetVersionToBuilding,
} from './calculation-job-preparation.repository.js';
import type {
  CalculationRunContext,
  LockedUpstreamSeries,
  PublishedDependencyDefinition,
  PublishedUpstreamVersion,
  UpstreamSeriesRequirement,
} from './calculation-job-preparation.repository.js';
import type { PreparedCalculationRun } from './calculation-job.types.js';
import type { PoolClient } from 'pg';

function invariant(message: string): never {
  throw new CalculationStateInvariantError(message);
}

function validateImmutableContext(context: CalculationRunContext): void {
  if (context.jobs.length === 0) {
    invariant(`Dataset version ${context.datasetVersionId} contains no calculation jobs`);
  }

  if (!context.jobs.some((job) => job.id === context.selectedJobId)) {
    invariant(
      `Selected job ${context.selectedJobId} is not part of dataset version ${context.datasetVersionId}`,
    );
  }

  for (const job of context.jobs) {
    if (job.calculationTypeDomain !== context.outputIdentity.domain) {
      invariant(
        `Calculation job ${job.id} uses a calculation type from another domain`,
      );
    }
  }
}

async function requireBuildingSnapshot(
  client: PoolClient,
  context: CalculationRunContext,
): Promise<string> {
  const state = await readDatasetFreezeState(client, context.datasetVersionId);
  if (
    state.snapshotIds.length !== 1
    || state.jobCount !== context.jobs.length
    || state.jobCount === 0
    || state.resolvedJobCount !== state.jobCount
  ) {
    invariant(
      `BUILDING dataset version ${context.datasetVersionId} has an inconsistent frozen build contract`,
    );
  }
  return state.snapshotIds[0]!;
}

async function freezeDraftBuild(
  client: PoolClient,
  context: CalculationRunContext,
  definitionsByType: Map<string, PublishedDependencyDefinition>,
  upstreamSeries: LockedUpstreamSeries[],
  upstreamVersions: Map<string, PublishedUpstreamVersion>,
): Promise<string> {
  const state = await readDatasetFreezeState(client, context.datasetVersionId);
  if (
    state.snapshotIds.length !== 0
    || state.jobCount !== context.jobs.length
    || state.jobCount === 0
    || state.resolvedJobCount !== 0
  ) {
    invariant(
      `DRAFT dataset version ${context.datasetVersionId} already contains frozen build state`,
    );
  }

  for (const job of context.jobs) {
    const definition = definitionsByType.get(job.calculationTypeId);
    if (!definition) {
      invariant(`Resolved definition disappeared for calculation job ${job.id}`);
    }
    const updated = await persistResolvedDependencyDefinition(client, {
      datasetVersionId: context.datasetVersionId,
      jobId: job.id,
      calculationTypeId: job.calculationTypeId,
      definitionVersionId: definition.id,
    });
    if (!updated) {
      invariant(`Could not freeze dependency definition for calculation job ${job.id}`);
    }
  }

  const snapshotId = randomUUID();
  await insertDatasetBuildSnapshot(client, snapshotId, context.datasetVersionId);

  for (const series of upstreamSeries) {
    const version = upstreamVersions.get(series.id);
    if (!version) {
      invariant(`Resolved upstream version disappeared for dataset series ${series.id}`);
    }
    await insertDatasetBuildSnapshotDependency(client, {
      snapshotId,
      upstreamDatasetSeriesId: series.id,
      upstreamDatasetVersionId: version.datasetVersionId,
    });
  }

  const transitioned = await transitionDatasetVersionToBuilding(
    client,
    context.datasetVersionId,
  );
  if (!transitioned) {
    invariant(`Could not transition dataset version ${context.datasetVersionId} to BUILDING`);
  }

  return snapshotId;
}

async function initializeOrReuseDraftDataset(
  client: PoolClient,
  context: CalculationRunContext,
): Promise<string> {
  for (const job of context.jobs) {
    const lockedType = await lockCalculationType(client, job.calculationTypeId);
    if (
      !lockedType
      || lockedType.domain !== job.calculationTypeDomain
      || lockedType.code !== job.calculationTypeCode
    ) {
      invariant(`Calculation type changed while preparing dataset ${context.datasetVersionId}`);
    }
  }

  const publishedDefinitions = await findLatestPublishedDependencyDefinitions(
    client,
    context.jobs.map((job) => job.calculationTypeId),
  );
  const definitionsByType = new Map(
    publishedDefinitions.map((definition) => [
      definition.calculationTypeId,
      definition,
    ]),
  );
  const missingDefinitionCodes = context.jobs
    .filter((job) => !definitionsByType.has(job.calculationTypeId))
    .map((job) => `${job.calculationTypeDomain}/${job.calculationTypeCode}`);
  if (missingDefinitionCodes.length > 0) {
    throw new DependencyDefinitionNotReadyError(missingDefinitionCodes);
  }

  const requiredDomains = await findRequiredDomains(
    client,
    publishedDefinitions.map((definition) => definition.id),
  );
  const upstreamRequirements: UpstreamSeriesRequirement[] = requiredDomains.map(
    (domain) => ({
      domain,
      companyCode: context.outputIdentity.companyCode,
      fiscalYear: context.outputIdentity.fiscalYear,
      period: context.outputIdentity.period,
    }),
  );

  const upstreamSeries: LockedUpstreamSeries[] = [];
  const missingSeriesDomains: string[] = [];
  for (const requirement of upstreamRequirements) {
    const series = await lockUpstreamDatasetSeries(client, requirement);
    if (series) {
      upstreamSeries.push(series);
    } else {
      missingSeriesDomains.push(requirement.domain);
    }
  }
  if (missingSeriesDomains.length > 0) {
    throw new DependencyNotReadyError(missingSeriesDomains);
  }

  const upstreamVersions = new Map<string, PublishedUpstreamVersion>();
  const missingVersionDomains: string[] = [];
  for (const series of upstreamSeries) {
    const version = await findLatestPublishedUpstreamVersion(client, series.id);
    if (version) {
      upstreamVersions.set(series.id, version);
    } else {
      missingVersionDomains.push(series.domain);
    }
  }
  if (missingVersionDomains.length > 0) {
    throw new DependencyNotReadyError(missingVersionDomains);
  }

  const lockedDataset = await lockOutputDatasetVersion(
    client,
    context.datasetVersionId,
  );
  if (!lockedDataset) {
    invariant(`Output dataset version ${context.datasetVersionId} disappeared`);
  }

  if (lockedDataset.status === 'DRAFT') {
    return freezeDraftBuild(
      client,
      context,
      definitionsByType,
      upstreamSeries,
      upstreamVersions,
    );
  }
  if (lockedDataset.status === 'BUILDING') {
    return requireBuildingSnapshot(client, context);
  }
  throw new JobNotRunnableError(context.selectedJobId);
}

async function reuseBuildingDataset(
  client: PoolClient,
  context: CalculationRunContext,
): Promise<string> {
  const lockedDataset = await lockOutputDatasetVersion(
    client,
    context.datasetVersionId,
  );
  if (!lockedDataset) {
    invariant(`Output dataset version ${context.datasetVersionId} disappeared`);
  }
  if (lockedDataset.status !== 'BUILDING') {
    throw new JobNotRunnableError(context.selectedJobId);
  }
  return requireBuildingSnapshot(client, context);
}

async function prepareSelectedJobAttempt(
  client: PoolClient,
  context: CalculationRunContext,
  snapshotId: string,
): Promise<PreparedCalculationRun> {
  const job = await lockSelectedCalculationJob(client, context.selectedJobId);
  if (!job || job.outputDatasetVersionId !== context.datasetVersionId) {
    invariant(`Selected calculation job ${context.selectedJobId} disappeared`);
  }
  if (job.status !== 'PENDING') {
    throw new JobNotRunnableError(context.selectedJobId);
  }

  const activeAttempt = await findActiveExecutionAttempt(client, job.id);
  if (activeAttempt) {
    if (activeAttempt.status !== 'PREPARED') {
      throw new JobNotRunnableError(job.id);
    }
    return {
      datasetVersionId: context.datasetVersionId,
      datasetStatus: 'BUILDING',
      datasetBuildSnapshotId: snapshotId,
      jobId: job.id,
      jobStatus: 'PENDING',
      executionAttemptId: activeAttempt.id,
      attemptNumber: activeAttempt.attemptNumber,
      attemptStatus: 'PREPARED',
      airflowDagId: activeAttempt.airflowDagId,
      airflowDagRunId: activeAttempt.airflowDagRunId,
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
    datasetVersionId: context.datasetVersionId,
    datasetStatus: 'BUILDING',
    datasetBuildSnapshotId: snapshotId,
    jobId: job.id,
    jobStatus: 'PENDING',
    executionAttemptId,
    attemptNumber,
    attemptStatus: 'PREPARED',
    airflowDagId: job.airflowDagId,
    airflowDagRunId,
  };
}

export async function prepareCalculationJobRunService(
  jobId: string,
): Promise<PreparedCalculationRun> {
  return withTransaction(async (client) => {
    const context = await loadCalculationRunContext(client, jobId);
    if (!context) {
      throw new CalculationJobNotFoundError(jobId);
    }
    validateImmutableContext(context);

    let snapshotId: string;
    if (context.datasetStatus === 'DRAFT') {
      snapshotId = await initializeOrReuseDraftDataset(client, context);
    } else if (context.datasetStatus === 'BUILDING') {
      snapshotId = await reuseBuildingDataset(client, context);
    } else {
      throw new JobNotRunnableError(jobId);
    }

    return prepareSelectedJobAttempt(client, context, snapshotId);
  });
}
