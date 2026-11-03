import type {DialogContent} from '../app/controller';
import type {Messages} from '../i18n/messages';
import {REPOSITORY} from '../scenarios/scenarios';

export interface ConceptBlock {name:string;code:string;line:string;dialog:DialogContent}
export function conceptBlocks({concepts:c}:Messages):ConceptBlock[]{
 return [
  {name:'Report',code:'dataset_series',line:c.report.line,dialog:{title:'Report (dataset_series)',paragraphs:[c.report.body],rows:[[c.contains,c.many('versions')]]}},
  {name:'Version',code:'dataset_version',line:c.version.line,dialog:{title:'Version (dataset_version)',paragraphs:[c.version.body],rows:[[c.belongsTo,c.one('report')],[c.contains,c.many('jobs')]]}},
  {name:'Job',code:'calculation_job',line:c.job.line,dialog:{title:'Job (calculation_job)',paragraphs:[c.job.body],rows:[[c.belongsTo,c.one('version')],[c.contains,c.many('tries')]]}},
  {name:'Try',code:'execution_attempt',line:c.attempt.line,dialog:{title:'Try (execution_attempt)',paragraphs:[c.attempt.body],rows:[[c.belongsTo,c.one('job')]]}},
 ];
}

export interface InfoBlock {title:string;line:string;dialog?:DialogContent;href?:string}
export function infoBlocks({more:m}:Messages):InfoBlock[]{
 return [
  {title:m.stuckTitle,line:m.thenNow,dialog:{title:m.stuckShort,rows:[[m.then,m.stuckThen],[m.now,m.stuckNow]],note:m.note,action:{label:m.try('Lost reply'),scenarioId:'lost-reply'}}},
  {title:m.failedTitle,line:m.thenNow,dialog:{title:m.failedTitle,rows:[[m.then,m.failedThen],[m.now,m.failedNow]],note:m.note+' '+m.orderNote,action:{label:m.try('Failed job and retry'),scenarioId:'failed-job'}}},
  {title:m.limitsTitle,line:m.limitsLine,dialog:{title:m.limitsTitle,bullets:m.limits,note:m.next}},
  {title:m.diagrams,line:m.diagramsLine,href:REPOSITORY+'#readme'},
  {title:m.decisions,line:m.decisionsLine,href:REPOSITORY+'/tree/main/docs/adr'},
  {title:m.tests,line:m.testsLine,href:REPOSITORY+'/tree/main/scripts'},
 ];
}
