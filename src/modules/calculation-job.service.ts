import { withTransaction } from '../db/transaction.js';
import {
    startJobIfPending,
    findCalculationJobStatus,
    markDatasetBuildingIfDraft,
    markJobValidatingIfRunning,
    markDatasetValidatingIfBuilding,
    succeedJobIfValidating,
    publishDatasetIfValidating,
    rejectJobIfValidating,
    rejectDatasetIfValidating,
    failJobIfRunning,
    failDatasetIfBuilding
} from './calculation-job.repository.js';
import { 
    CalculationJobNotFoundError,
    CalculationJobNotStartableError,
    CalculationStateInvariantError,
    CalculationJobStateConflictError
} from './calculation-job.errors.js';

export interface StartCalculationJobResult {
    jobId: string;
    jobStatus: 'RUNNING';
    datasetVersionId: string;
    datasetStatus: string;
}

export async function startCalculationJobService(
    jobId: string
):Promise<StartCalculationJobResult> {
    return await withTransaction(
        async(client) => {
            const startedJob = await startJobIfPending(client, jobId);
            if(!startedJob) {
                const currentStatus = await findCalculationJobStatus(client, jobId);
                if(!currentStatus) {
                    throw new CalculationJobNotFoundError(jobId);
                }
                throw new CalculationJobNotStartableError(currentStatus);
            }

            const datasetUpdated = await markDatasetBuildingIfDraft(client, startedJob.outputDatasetVersionId);
            if(!datasetUpdated) {
                throw new CalculationStateInvariantError(`
                    Output dataset ${startedJob.outputDatasetVersionId} was not DRAFT
                    `);
            }

            return {
                jobId: startedJob.jobId,
                jobStatus: "RUNNING",
                datasetVersionId: startedJob.outputDatasetVersionId,
                datasetStatus: "BUILDING"
            }
        }
    )
}

export async function submitCalculationForValidationService(jobId: string) {
    return await withTransaction(async (client) => {
        const job = await markJobValidatingIfRunning(client, jobId);
        if(!job) {
            const currentStatus = await findCalculationJobStatus(client, jobId);

            if(!currentStatus) {
                throw new CalculationJobNotFoundError(jobId);
            }

            throw new CalculationJobStateConflictError(currentStatus, "RUNNING");
        }

        const datasetUpdated = await markDatasetValidatingIfBuilding(client, job.outputDatasetVersionId);
        if(!datasetUpdated) {
            throw new CalculationStateInvariantError(
                `Output dataset ${job.outputDatasetVersionId} must be BUILDING when job enters VALIDATING`
            )
        }

        return {
            jobId: job.jobId,
            jobStatus: 'VALIDATING' as const,
            datasetVersionId: job.outputDatasetVersionId,
            datasetStatus: 'VALIDATING' as const
        }
    })
}

export async function publishCalculationJobService(jobId: string) {
    return await withTransaction(async (client) => {
        const datasetVersionId = await succeedJobIfValidating(client, jobId);
        if(!datasetVersionId) {
            const currentStatus = await findCalculationJobStatus(client, jobId);
            if(!currentStatus) {
                throw new CalculationJobNotFoundError(jobId);
            }
            throw new CalculationJobStateConflictError(currentStatus, "VALIDATING");
        }
        const published = await publishDatasetIfValidating(client, datasetVersionId);
        if(!published) {
            throw new CalculationStateInvariantError(`Dataset ${datasetVersionId} must be VALIDATING`)
        }
        return {
            jobId,
            jobStatus: 'SUCCEEDED' as const,
            datasetVersionId,
            datasetStatus: 'PUBLISHED' as const 
        }
    })
}

export async function rejectCalculationJobService(jobId: string) {
    return await withTransaction(async (client) => {
        const datasetVersionId = await rejectJobIfValidating(client, jobId);
        if(!datasetVersionId) {
            const currentStatus = await findCalculationJobStatus(client, jobId);
            if(!currentStatus) {
                throw new CalculationJobNotFoundError(jobId);
            }
            throw new CalculationJobStateConflictError(currentStatus, "VALIDATING");
        }
        const rejected = await rejectDatasetIfValidating(client, datasetVersionId);
        if(!rejected) {
            throw new CalculationStateInvariantError(`Dataset ${datasetVersionId} must be VALIDATING`)
        }
        return {
            jobId,
            jobStatus: 'REJECTED' as const,
            datasetVersionId,
            datasetStatus: 'REJECTED' as const 
        }
    })
}

export async function failCalculationJobService(jobId: string) {
    return await withTransaction(async (client) => {
        const datasetVersionId = await failJobIfRunning(client, jobId);
        if(!datasetVersionId) {
            const currentStatus = await findCalculationJobStatus(client, jobId);
            if(!currentStatus) {
                throw new CalculationJobNotFoundError(jobId);
            }
            throw new CalculationJobStateConflictError(currentStatus, "RUNNING");
        }
        const failed = await failDatasetIfBuilding(client, datasetVersionId);
        if(!failed) {
            throw new CalculationStateInvariantError(`Dataset ${datasetVersionId} must be BUILDING`)
        }
        return {
            jobId,
            jobStatus: 'FAILED' as const,
            datasetVersionId,
            datasetStatus: 'FAILED' as const 
        }
    })
}
