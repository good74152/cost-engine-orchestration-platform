export type CalculationDomain = 
    | 'FAB_COST'
    | 'CAPEX'
    | 'DPR';

export type DependencyType = 
    | 'FAB_COST_INPUT'
    | 'CAPEX_INPUT';

export type DependencyPolicy = 
    | 'STRICT'
    | 'OVERRIDE';

export interface CreateCalculationDependencyInput {
    dependencyType: DependencyType;
    datasetVersionId: string;
    policy: DependencyPolicy;
}

export interface CreateCalculationJobInput {
    domain: CalculationDomain;
    businessKey: string;
    dependencies: CreateCalculationDependencyInput[];
}

export interface CreateCalculationJobResult {
    jobId: string;
    datasetVersionId: string;
    version: number;
    jobStatus: 'PENDING';
    datasetStatus: 'DRAFT';
}