import type {ScenarioType} from '../../api/types';
export interface StepDescription {name:string;description:string;expected:string;action:string}
const create={name:'Create dataset',description:'Allocate version 1 and its required calculation job.',expected:'Dataset DRAFT · Job PENDING',action:'Create dataset'};
const run={name:'Run calculation',description:'Freeze build inputs and dispatch the original execution.',expected:'Job RUNNING · Attempt ACCEPTED after confirmation',action:'Run calculation'};
const fake={name:'Simulate success',description:'Set the original session-owned fake execution to success.',expected:'External acknowledgement only; DB remains RUNNING / ACCEPTED',action:'Simulate success'};
const reconcile={name:'Reconcile execution',description:'Ask the backend to confirm executor truth.',expected:'Job SUCCEEDED · Attempt SUCCEEDED',action:'Reconcile execution'};
const validate={name:'Submit validation',description:'Check that all required calculations succeeded.',expected:'Dataset VALIDATING',action:'Submit validation'};
const publish={name:'Publish dataset',description:'Explicitly publish the completed dataset.',expected:'Dataset PUBLISHED · Scenario COMPLETED',action:'Publish dataset'};
export const catalog:Record<ScenarioType,{title:string;description:string;tone:string;icon:string;steps:StepDescription[]}>={
 HAPPY_PATH:{title:'Happy Path',description:'See how a dataset moves from creation to publication.',tone:'green',icon:'check',steps:[create,run,fake,reconcile,validate,publish]},
 FAILURE_RETRY:{title:'Failure & Retry',description:'Experience execution failure, reconciliation, and safe retry.',tone:'purple',icon:'refresh',steps:[
  create,run,{name:'Simulate failure',description:'Mark only the original fake execution as failed.',expected:'DB still RUNNING / ACCEPTED until reconciliation',action:'Simulate failure'},
  {name:'Reconcile failure',description:'Confirm failed Attempt 1 without ending the scenario.',expected:'Job FAILED · Scenario IN_PROGRESS',action:'Reconcile failure'},
  {name:'Retry calculation',description:'Use the same job and frozen inputs with a new execution attempt.',expected:'Attempt 2; Attempt 1 remains immutable FAILED history',action:'Retry calculation'},fake,reconcile,validate,publish]},
 LOST_RESPONSE_RECOVERY:{title:'Lost Response Recovery',description:'Discover how idempotency prevents duplicate execution when responses are lost.',tone:'amber',icon:'shield',steps:[
  create,{name:'Run with lost acknowledgement',description:'The fake creates an execution, then its dispatch acknowledgement is lost.',expected:'First response: HTTP 202 · Job PENDING · Attempt DISPATCHING',action:'Run calculation'},fake,reconcile,validate,publish]},
};
