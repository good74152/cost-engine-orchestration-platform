import {it,expect} from 'vitest';
import {id} from '../../test/mock-api';
import {saveRequest,savedRequest,clearRequests,requestKey} from './request-storage';
it('scopes only non-sensitive request mapping by session/scenario/step',()=>{
 const value={sessionId:id(1),scenarioId:id(2),stepNumber:2,requestId:id(80)};saveRequest(localStorage,value);
 expect(savedRequest(localStorage,id(1),id(2),2)).toEqual(value);expect(savedRequest(localStorage,id(3),id(2),2)).toBeNull();
 expect(savedRequest(localStorage,id(1),id(3),2)).toBeNull();expect(savedRequest(localStorage,id(1),id(2),3)).toBeNull();
 expect(JSON.parse(localStorage.getItem(requestKey(id(1),id(2),2))!)).toEqual(value);
});
it('rejects malformed or forged mappings and clears only this application prefix',()=>{
 localStorage.setItem('other-app','keep');localStorage.setItem(requestKey(id(1),id(2),2),JSON.stringify({sessionId:id(3),requestId:'invalid'}));
 expect(savedRequest(localStorage,id(1),id(2),2)).toBeNull();clearRequests(localStorage);expect(localStorage.getItem('other-app')).toBe('keep');expect(localStorage.length).toBe(1);
});
it('projects only the four allowed fields even if a caller supplies extra properties',()=>{
 saveRequest(localStorage,{sessionId:id(1),scenarioId:id(2),stepNumber:2,requestId:id(80),token:'must-not-persist'} as unknown as Parameters<typeof saveRequest>[1]);
 const value=JSON.parse(localStorage.getItem(requestKey(id(1),id(2),2))!);expect(Object.keys(value).sort()).toEqual(['requestId','scenarioId','sessionId','stepNumber']);
});
