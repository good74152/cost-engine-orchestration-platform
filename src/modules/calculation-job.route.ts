import type { FastifyInstance } from 'fastify';
import { 
    createCalculationJobService,
    startCalculationJobService,
    submitCalculationForValidationService,
    publishCalculationJobService,
    rejectCalculationJobService,
    failCalculationJobService
} from './calculation-job.service.js';
import { CreateCalculationJobInput } from './calculation-job.types.js';

export async function calculationJobRoutes(app: FastifyInstance): Promise<void> {
    app.post<{ Body: CreateCalculationJobInput }>('/calculation-jobs', async (request, reply) => {
        const input = request.body;
        const result = await createCalculationJobService(input);
        reply.status(201).send(result);
    });
}

export async function startCalculationJobRoutes(app: FastifyInstance): Promise<void> {
    app.post<{
        Params: {
            jobId: string;
        }
    }>(
        '/calculation-jobs/:jobId/start',
        async (request, reply) => {
            const jobId = request.params.jobId;
            const result = await startCalculationJobService(jobId);
            return reply.code(200).send(result);
        }
    )
}

export async function submitCalculationForValidationRoutes(app: FastifyInstance): Promise<void> {
    app.post<{
        Params: {
            jobId: string;
        }
    }>(
        '/calculation-jobs/:jobId/submit-validation',
        async (request, reply) => {
            const jobId = request.params.jobId;
            const result = await submitCalculationForValidationService(jobId);
            return reply.code(200).send(result);
        }
    )
}

export async function publishCalculationJobRoutes(app: FastifyInstance): Promise<void> {
    app.post<{
        Params: {
            jobId: string;
        }
    }>(
        '/calculation-jobs/:jobId/publish',
        async (request, reply) => {
            const jobId = request.params.jobId;
            const result = await publishCalculationJobService(jobId);
            return reply.code(200).send(result);
        }
    )
}

export async function rejectCalculationJobRoutes(app: FastifyInstance): Promise<void> {
    app.post<{
        Params: {
            jobId: string;
        }
    }>(
        '/calculation-jobs/:jobId/reject',
        async (request, reply) => {
            const jobId = request.params.jobId;
            const result = await rejectCalculationJobService(jobId);
            return reply.code(200).send(result);
        }
    )
}

export async function failCalculationJobRoutes(app: FastifyInstance): Promise<void> {
    app.post<{
        Params: {
            jobId: string;
        }
    }>(
        '/calculation-jobs/:jobId/fail',
        async (request, reply) => {
            const jobId = request.params.jobId;
            const result = await failCalculationJobService(jobId);
            return reply.code(200).send(result);
        }
    )
}