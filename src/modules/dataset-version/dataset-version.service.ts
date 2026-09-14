import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../db/transaction.js';
import {
  ActiveDatasetVersionExistsError,
  CalculationTypeNotConfiguredError,
} from './dataset-version.errors.js';
import {
  allocateNextDatasetVersion,
  findActiveCalculationTypes,
  findActiveDatasetVersion,
  findOrCreateAndLockDatasetSeries,
  insertDraftDatasetVersion,
  insertPendingCalculationJobs,
} from './dataset-version.repository.js';
import type {
  CreateDatasetVersionInput,
  CreateDatasetVersionResult,
} from './dataset-version.types.js';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && 'code' in error;
}

export async function createDatasetVersionService(
  input: CreateDatasetVersionInput,
): Promise<CreateDatasetVersionResult> {
  try {
    return await withTransaction(async (client) => {
      const series = await findOrCreateAndLockDatasetSeries(
        client,
        input,
        randomUUID(),
      );

      const activeVersion = await findActiveDatasetVersion(client, series.id);
      if (activeVersion) {
        throw new ActiveDatasetVersionExistsError();
      }

      const version = await allocateNextDatasetVersion(client, series.id);
      const datasetVersionId = randomUUID();
      await insertDraftDatasetVersion(client, {
        id: datasetVersionId,
        datasetSeriesId: series.id,
        version,
      });

      const calculationTypes = await findActiveCalculationTypes(
        client,
        input.domain,
      );
      if (calculationTypes.length === 0) {
        throw new CalculationTypeNotConfiguredError();
      }

      const calculationJobs = await insertPendingCalculationJobs(
        client,
        datasetVersionId,
        calculationTypes.map((calculationType) => ({
          id: randomUUID(),
          calculationTypeId: calculationType.id,
          calculationTypeCode: calculationType.code,
        })),
      );

      return {
        datasetSeriesId: series.id,
        datasetVersionId,
        version,
        datasetStatus: 'DRAFT',
        calculationJobs,
      };
    });
  } catch (error: unknown) {
    if (
      isPostgresError(error)
      && error.code === '23505'
      && error.constraint === 'uq_dataset_versions_active_series'
    ) {
      throw new ActiveDatasetVersionExistsError();
    }

    throw error;
  }
}
