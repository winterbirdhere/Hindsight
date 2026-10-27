import { LibraryQueryClient, LibraryPassiveRequest } from "./library-query-client";

function pending<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const page=(id:string)=>({items:[{id}],total:1,analysisExcluded:0});
afterEach(()=>jest.useRealTimers());
it("previews an already-composed removal candidate through the passive preview API without reading rows",async()=>{
  jest.useFakeTimers(); const request=jest.fn(async()=>({count:7,analysisExcluded:2,resultExcluded:{unknownOutcome:4,missingBreakEvidence:1}}));
  const client=new LibraryQueryClient({request},{previewDelayMs:0}),query={search:"test"};
  const result=client.preview(query);jest.runOnlyPendingTimers();
  expect(await result).toEqual({count:7,analysisExcluded:2,resultExcluded:{unknownOutcome:4,missingBreakEvidence:1}});
  expect(request).toHaveBeenCalledWith({method:"query-preview",query,draft:undefined});client.dispose();
});
it("discards older row responses and obsolete failures without admitting analysis",async()=>{
  const a=pending<unknown>(),b=pending<unknown>(),request=jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise),client=new LibraryQueryClient({request});
  const first=client.page({search:"a"}),second=client.page({search:"b"});b.resolve(page("b"));expect(await second).toEqual(page("b"));a.reject(new Error("old failure"));expect(await first).toBeUndefined();
  expect(request.mock.calls.map(call=>call[0].method)).toEqual(["query-page","query-page"]);
});
it("coalesces settled preview drafts and serializes one in-flight request plus the latest pending draft",async()=>{
  jest.useFakeTimers();const a=pending<unknown>(),b=pending<unknown>(),request=jest.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise),client=new LibraryQueryClient({request},{previewDelayMs:100});
  const first=client.preview({}, {field:"ur",op:"atMost",a:80,b:null});jest.advanceTimersByTime(100);expect(request).toHaveBeenCalledTimes(1);
  const second=client.preview({}, {field:"ur",op:"atMost",a:90,b:null}),third=client.preview({}, {field:"ur",op:"atMost",a:100,b:null});
  expect(await second).toBeUndefined();jest.advanceTimersByTime(100);expect(request).toHaveBeenCalledTimes(1);
  a.resolve({count:1,analysisExcluded:2});expect(await first).toBeUndefined();await Promise.resolve();expect(request).toHaveBeenCalledTimes(2);
  b.resolve({count:3,analysisExcluded:2});expect(await third).toEqual({count:3,analysisExcluded:2});expect(request.mock.calls[1][0].draft.a).toBe(100);
});
it("drops disposed pending previews and releases snapshots created by stale open requests",async()=>{
  jest.useFakeTimers();const a=pending<unknown>(),b=pending<unknown>();const request=jest.fn((input:LibraryPassiveRequest)=>input.method==="query-snapshot-create"?(input.replayId==="a"?a.promise:b.promise):Promise.resolve(null));
  const client=new LibraryQueryClient({request}),first=client.createSnapshot({},"a"),second=client.createSnapshot({},"b");
  b.resolve({snapshotId:"new",total:2,position:1,scopeLabel:"All",sortLabel:"PP"});await second;
  a.resolve({snapshotId:"old",total:2,position:0,scopeLabel:"All",sortLabel:"PP"});expect(await first).toBeUndefined();
  expect(request).toHaveBeenCalledWith({method:"query-snapshot-release",snapshotId:"old"});
  const preview=client.preview({}, {field:"grade",values:[]});client.dispose();expect(await preview).toBeUndefined();jest.runAllTimers();
  expect(request).toHaveBeenCalledWith({method:"query-snapshot-release",snapshotId:"new"});expect(request.mock.calls.some(call=>call[0].method==="query-preview")).toBe(false);
});
it("returns a current storage failure and keeps preview-only reads separate from committed rows",async()=>{
  jest.useFakeTimers();const request=jest.fn(async(input:LibraryPassiveRequest)=>{if(input.method==="query-page")throw Object.assign(new Error("changed"),{code:"library-query-invalidated"});return{count:0,analysisExcluded:0};});
  const client=new LibraryQueryClient({request},{previewDelayMs:0});await expect(client.page({})).rejects.toMatchObject({code:"library-query-invalidated"});
  const preview=client.preview({}, {field:"grade",values:[]});jest.runAllTimers();expect(await preview).toEqual({count:0,analysisExcluded:0});
});
it("settles a synchronously throwing preview transport without wedging the next preview",async()=>{
  jest.useFakeTimers();const request=jest.fn().mockImplementationOnce(()=>{throw new Error("transport closed");}).mockResolvedValue({count:2,analysisExcluded:0});
  const client=new LibraryQueryClient({request},{previewDelayMs:0}),first=client.preview({}, {field:"grade",values:[]});
  const rejected=expect(first).rejects.toThrow("transport closed");expect(()=>jest.runOnlyPendingTimers()).not.toThrow();await rejected;
  const next=client.preview({}, {field:"grade",values:["S"]});jest.runOnlyPendingTimers();expect(await next).toEqual({count:2,analysisExcluded:0});
});
