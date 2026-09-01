import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/transaction.js';
import {
    allocateDatasetVersion,
    createDatasetVersion,
    createCalculationJob,
    createCalculationDependencies,
    findDatasetVersionDependencyInfo,
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
    CreateCalculationJobInput,
    CreateCalculationJobResult, 
} from './calculation-job.types.js';
import { 
    ActiveCalculationJobExistsError,
    CalculationJobNotFoundError,
    CalculationJobNotStartableError,
    CalculationStateInvariantError,
    CalculationJobStateConflictError
} from './calculation-job.errors.js';

export async function createCalculationJobService(
    input: CreateCalculationJobInput
): Promise<CreateCalculationJobResult> {
    try {
        return await withTransaction(async (client) => {
            const newSeriesId = randomUUID();
            const datasetVersionId = randomUUID();
            const jobId = randomUUID();

            const domain = input.domain;
            const businessKey = input.businessKey;
            const dependencies = input.dependencies;

            // 1. validate dependency business rules
            validateDependencyShape(input);
            const expectedDependencyDomain = {
                FAB_COST_INPUT: 'FAB_COST',
                CAPEX_INPUT: 'CAPEX'
            } as const;

            for (const dependency of dependencies) {
                const info = await findDatasetVersionDependencyInfo(client, dependency.datasetVersionId);
                if (!info) {
                    throw new Error(`Dataset version ${dependency.datasetVersionId} not found`);
                }

                if (info.status !== 'PUBLISHED') {
                    throw new Error(`Dataset version ${dependency.datasetVersionId} is not published`);
                }

                const expectedDomain = expectedDependencyDomain[dependency.dependencyType as keyof typeof expectedDependencyDomain];
                if (expectedDomain && expectedDomain !== domain) {
                    throw new Error(`Dependency ${dependency.datasetVersionId} belongs to domain ${expectedDomain}, but job is for domain ${domain}`);
                }

                if (businessKey !== info.businessKey) {
                    throw new Error(`Dependency ${dependency.datasetVersionId} has a different business key (${info.businessKey}) than the job (${businessKey})`);
                }
            }

            // 2. allocate series + next version
            const allocatedResult = await allocateDatasetVersion(client, { newSeriesId, domain, businessKey });

            // 3. create dataset version
            await createDatasetVersion(client, { id: datasetVersionId, datasetSeriesId: allocatedResult.datasetSeriesId, version: allocatedResult.version });

            // 4. create calculation job
            await createCalculationJob(client, { id: jobId, datasetSeriesId: allocatedResult.datasetSeriesId, outputDatasetVersionId: datasetVersionId });

            // 5. create calculation dependencies
            await createCalculationDependencies(client, { calculationJobId: jobId, dependencies });

            return {
                jobId,
                datasetVersionId,
                version: allocatedResult.version,
                jobStatus: 'PENDING',
                datasetStatus: 'DRAFT',
            };
        });
    } catch (error: unknown) {
        if (isPostgresError(error) && 
            error.code === '23505' && 
            error.constraint === 'uq_calculation_jobs_active_series'
        ) {
            throw new ActiveCalculationJobExistsError();
        }
        throw error;
    }
}

function validateDependencyShape(
    input: CreateCalculationJobInput
): void {
    const { domain, dependencies } = input;
    if (domain === 'FAB_COST' && dependencies.length !== 0) {
        throw new Error('FAB_COST calculation jobs cannot have dependencies');
    }
    if (domain === 'CAPEX') {
        if (dependencies.length !== 1 || dependencies[0]?.dependencyType !== 'FAB_COST_INPUT') {
            throw new Error('CAPEX calculation jobs must have exactly one dependency of type FAB_COST_INPUT');
        }
    }
    if (domain === 'DPR') {
        if (dependencies.length !== 1 || dependencies[0]?.dependencyType !== 'CAPEX_INPUT') {
            throw new Error('DPR calculation jobs must have exactly one dependency of type CAPEX_INPUT');
        }
    }
    return;
}

interface PostgresError extends Error {
    code?: string;
    constraint?: string;
}

function isPostgresError(error: unknown): error is PostgresError {
    return error instanceof Error &&
    'code' in error;
}

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