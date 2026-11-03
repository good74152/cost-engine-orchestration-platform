/** Plain names for the page. The codes stay visible as captions, because they are the API's values. */
export const DOMAIN_LABELS:Record<string,string>={FAB_COST:'Fab cost',CAPEX:'Capital expenditure',DPR:'Depreciation',INSURANCE:'Insurance',ONE_STD_COST:'Standard cost',E2E_COST:'End-to-end cost'};
export const domainLabel=(domain:string)=>DOMAIN_LABELS[domain]??domain;

/** Which report each report needs. Shown before a session exists; afterward the backend template is the source. */
export type WorkflowLinks=Record<string,string|null>;
export const DEFAULT_LINKS:WorkflowLinks={FAB_COST:null,CAPEX:'FAB_COST',DPR:'CAPEX',INSURANCE:'FAB_COST',ONE_STD_COST:'FAB_COST',E2E_COST:'ONE_STD_COST'};
/** Each report after the ones it needs. The backend still rejects a run whose input isn't published. */
export const PUBLISH_ORDER=['FAB_COST','CAPEX','INSURANCE','ONE_STD_COST','DPR','E2E_COST'];
