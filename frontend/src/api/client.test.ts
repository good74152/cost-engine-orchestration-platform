import {describe,it,expect,vi} from 'vitest';
import {ApiClient,ApiError,errorMessage} from './client';
import {json,fail} from '../test/mock-api';
describe('same-origin typed API boundary',()=>{
 it('includes credentials and mutation headers, sends no identity/auth header, and parses 204',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:204}));const api=new ApiClient(()=>{},fetcher);
  const result=await api.request<void>('/demo/sessions/reset',{});expect(result.status).toBe(204);expect(result.data).toBeUndefined();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/demo/sessions/reset',{method:'POST',credentials:'include',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json','X-Demo-Session':'1'},body:'{}'});
 });
 it('keeps GET read-only without a mutation header',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({}));await new ApiClient(()=>{},fetcher).get('/demo/sessions/current');
  expect(fetcher.mock.calls[0]![1]).toMatchObject({method:'GET',credentials:'include',headers:{Accept:'application/json'}});expect(fetcher.mock.calls[0]![1]?.body).toBeUndefined();
 });
 it('retains HTTP 202 as a successful pending result',async()=>{
  const api=new ApiClient(()=>{},async()=>json({stepStatus:'PENDING'},202));expect(await api.request('/demo/scenarios/x/next',{})).toEqual({status:202,data:{stepStatus:'PENDING'}});
 });
 it.each([[409,'DEMO_SCENARIO_STEP_CONFLICT'],[429,'DEMO_SESSION_QUEUE_FULL'],[503,'DEMO_SCENARIO_STEP_OUTCOME_UNKNOWN']])('preserves expected error %s / %s without automatic retry',async(status,code)=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(fail(String(code),Number(status)));const api=new ApiClient(()=>{},fetcher);
  await expect(api.request('/demo/scenarios/x/next',{})).rejects.toMatchObject({status,code});expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('invalidates a 401 once and never stores/reads an authentication token',async()=>{
  const unavailable=vi.fn();const api=new ApiClient(unavailable,async()=>fail('DEMO_SESSION_UNAVAILABLE',401));
  await expect(api.get('/demo/sessions/current')).rejects.toBeInstanceOf(ApiError);expect(unavailable).toHaveBeenCalledTimes(1);expect(localStorage.length).toBe(0);
 });
 it('treats network failure as unknown and never retries a mutation',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport detail'));await expect(new ApiClient(()=>{},fetcher).request('/demo/sessions',{})).rejects.toMatchObject({code:'NETWORK_ERROR'});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(errorMessage(new Error('SELECT private SQL')).message).not.toContain('SQL');
 });
 it('follows every opaque cursor without assuming the first page is complete',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({items:[1,2],nextCursor:'opaque/+ scoped'})).mockResolvedValueOnce(json({items:[3],nextCursor:null}));
  expect(await new ApiClient(()=>{},fetcher).pages('/demo/dataset-versions')).toEqual([1,2,3]);expect(String(fetcher.mock.calls[1]![0])).toContain('cursor=opaque%2F%2B+scoped');
 });
 it('fails closed on a repeating cursor or invalid JSON',async()=>{
  const repeated=new ApiClient(()=>{},async()=>json({items:[],nextCursor:'same'}));await expect(repeated.pages('/demo/dataset-versions')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  await expect(new ApiClient(()=>{},async()=>new Response('SQL detail',{status:500})).get('/demo/sessions/current')).rejects.toMatchObject({code:'INVALID_RESPONSE'});
 });
 it('does not render arbitrary raw server error details or executor internals',async()=>{
  const api=new ApiClient(()=>{},async()=>json({code:'SELECT token_hash FROM credentials',message:'secret'},500));
  try{await api.get('/demo/sessions/current');}catch(e){expect(errorMessage(e)).toEqual({code:'REQUEST_FAILED',message:'The request could not be completed. Refresh durable state before trying again.'});}
 });
});
