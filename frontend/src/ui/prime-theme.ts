import type {APIOptions} from 'primereact/api';

// PrimeReact runs unstyled so all visual rules live in one static, CSP-safe stylesheet (ADR-0020).
const className=(name:string)=>({className:name});
export const primeOptions:Partial<APIOptions>={
 unstyled:true,
 pt:{
  dialog:{mask:className('dialog-mask'),root:className('dialog'),header:className('dialog-header'),headerTitle:className('dialog-title'),
   headerIcons:className('dialog-icons'),closeButton:className('dialog-close'),content:className('dialog-content'),footer:className('dialog-footer')},
  organizationchart:{root:className('chart'),table:className('chart-table'),cell:className('chart-cell'),nodeCell:className('chart-cell'),
   node:className('chart-node'),lineCell:className('chart-cell'),lineDown:className('chart-down'),nodeToggler:className('chart-toggler'),
   lineLeft:({context}:{context:{lineTop:boolean}})=>className(context.lineTop?'chart-left chart-top':'chart-left'),
   lineRight:({context}:{context:{lineTop:boolean}})=>className(context.lineTop?'chart-right chart-top':'chart-right')},
  dataview:{root:className('scenario-list')},
  dropdown:{root:className('select'),input:className('select-value'),trigger:className('select-trigger'),panel:className('select-panel'),wrapper:className('select-wrapper'),list:className('select-list'),item:className('select-item'),hiddenSelectedMessage:className('sr-only'),select:className('sr-only')},
 },
};
