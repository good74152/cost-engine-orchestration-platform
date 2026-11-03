import type {DialogContent} from '../app/controller';
import {REPOSITORY} from '../scenarios/scenarios';

export interface ConceptBlock {name:string;code:string;line:string;dialog:DialogContent}
export const CONCEPTS:ConceptBlock[]=[
 {name:'Report',code:'dataset_series',line:'One report for one year/period.',dialog:{title:'Report (dataset_series)',
  paragraphs:['One report for one year/period. Requests for the same report take turns, so version numbers never repeat.'],
  rows:[['Contains','Many versions']]}},
 {name:'Version',code:'dataset_version',line:'The build that gets published.',dialog:{title:'Version (dataset_version)',
  paragraphs:['One build of the report. Its input locks when the first job starts, and it is published as a whole.'],
  rows:[['Belongs to','One report'],['Contains','Many jobs']]}},
 {name:'Job',code:'calculation_job',line:'One calculation a version needs.',dialog:{title:'Job (calculation_job)',
  paragraphs:['One calculation the version needs. The version can’t be approved until every job succeeds.'],
  rows:[['Belongs to','One version'],['Contains','Many tries']]}},
 {name:'Try',code:'execution_attempt',line:'One run of a job.',dialog:{title:'Try (execution_attempt)',
  paragraphs:['One run of a job. A retry adds a new try, so failures stay on record.'],
  rows:[['Belongs to','One job']]}},
];

const THEN_NOW='“Then” is production work I did. “Now” is this project, a new build rather than a copy.';
export interface InfoBlock {title:string;line:string;dialog?:DialogContent;href?:string}
export const INFO_BLOCKS:InfoBlock[]=[
 {title:'A job looked stuck after a status message was lost',line:'Then and now',dialog:{title:'A job looked stuck',
  rows:[['Then','A database rule stopped duplicate runs, and a sync tool fixed stuck jobs.'],['Now','The job is marked “unknown”, and the system checks the same run again.']],
  note:THEN_NOW,action:{label:'Try Lost reply',scenarioId:'lost-reply'}}},
 {title:'A step failed in a long workflow',line:'Then and now',dialog:{title:'A step failed in a long workflow',
  rows:[['Then','Someone reran it by hand in Airflow.'],['Now','A retry starts on the same input, and the failure stays on record.']],
  note:THEN_NOW+' Waiting for the reports a job needs comes from that work. Locking the input is an idea I added here.',action:{label:'Try Failed job and retry',scenarioId:'failed-job'}}},
 {title:'What it doesn’t do',line:'Limits and next steps',dialog:{title:'What it doesn’t do',
  bullets:['No real Airflow. A simulator stands in and forgets everything on restart.','One backend instance only. This isn’t a production system.','Nothing checks results in the background. A check runs only when asked.'],
  note:'Next I’d build the Airflow connection, then start downstream reports automatically.'}},
 {title:'Architecture and flow diagrams',line:'README on GitHub',href:REPOSITORY+'#readme'},
 {title:'Design decisions',line:'ADRs on GitHub',href:REPOSITORY+'/tree/main/docs/adr'},
 {title:'Concurrency tests',line:'PostgreSQL tests on GitHub',href:REPOSITORY+'/tree/main/scripts'},
];
