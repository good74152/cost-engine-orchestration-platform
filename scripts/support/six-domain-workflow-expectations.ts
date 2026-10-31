import type { DatasetDomain } from '../../src/modules/dataset-version/dataset-version.types.js';
// Shared test expectations from Demo-05C-3B, never a Core dependency definition.
export const types: Record<DatasetDomain,string[]>={
  FAB_COST:['DEMO_FAB_COST_SUMMARY'],CAPEX:['DEMO_CAPEX_TABLE_Y','DEMO_GUIDED_SUMMARY'],
  INSURANCE:['DEMO_INSURANCE_SUMMARY'],ONE_STD_COST:['DEMO_ONE_STD_COST_TABLE_X','DEMO_ONE_STD_COST_TABLE_Y'],
  DPR:['DEMO_DPR_TABLE_X','DEMO_DPR_TABLE_Y'],E2E_COST:['DEMO_E2E_COST_TABLE_X','DEMO_E2E_COST_TABLE_Y'],
};
export const upstream:Partial<Record<DatasetDomain,DatasetDomain>>={CAPEX:'FAB_COST',INSURANCE:'FAB_COST',ONE_STD_COST:'FAB_COST',DPR:'CAPEX',E2E_COST:'ONE_STD_COST'};
