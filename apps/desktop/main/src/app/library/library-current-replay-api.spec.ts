import { LibraryCurrentReplayApi } from "./library-current-replay-api";
import type { LibraryCurrentReplayReceipt, LibraryCurrentReplayResult } from "../../../../shared/library-current-replay";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../shared/library-analysis";

const binding:Omit<LibraryCurrentReplayReceipt,"token">={version:1,replayId:"indexed-replay",replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),
  mapMd5:"c".repeat(32),numericalInputKey:"d".repeat(64),parserVersion:LIBRARY_REPLAY_PARSER_VERSION,
  preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION,numericalVersion:LIBRARY_NUMERIC_PROJECTION_VERSION};
function result():LibraryCurrentReplayResult {return {slot:"numerical",producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,
  metrics:{provenance:{replaySha256:binding.replaySha256,mapSha256:binding.mapSha256,mapMd5:binding.mapMd5,
    projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,parserVersion:binding.parserVersion,preparationVersion:binding.preparationVersion,
    ruleset:"stable",rate:1,scoreOrigin:"reconstructed",coverageQualified:true,completionEvidence:"source-domain-coverage-v1",
    completeAccuracyEvidence:true,completeBreakEvidence:true},fields:{misses:{state:"known",value:0},fc:{state:"known",value:true}}}};}
function fixture() {
  let now=0;const authority={target:"private-authority"};
  const publish=jest.fn(async(_authority:typeof authority,results:LibraryCurrentReplayResult[])=>({state:"applied" as const,accepted:results.map(value=>value.slot)}));
  const api=new LibraryCurrentReplayApi({publish,now:()=>now,ttlMs:1000,maxReceipts:2});
  const receipt=api.issue(binding,authority);
  return {api,receipt,authority,publish,advance:(ms:number)=>{now+=ms;}};
}
it("publishes bounded zero-valued observations only through the main-held authority",async()=>{
  const {api,receipt,authority,publish}=fixture();
  expect(await api.receive({method:"current-replay-publish",token:receipt.token,results:[result()]},()=>undefined)).toEqual({state:"applied",accepted:["numerical"]});
  expect(publish).toHaveBeenCalledWith(authority,[result()],expect.any(Function));
  expect(receipt).toEqual({...binding,token:receipt.token});
});
it.each(["target","identity","slot","cause","version","hash","nonfinite","duplicate"])("rejects renderer %s injection before publication",async kind=>{
  const {api,receipt,publish}=fixture();const value:Record<string,unknown>={method:"current-replay-publish",token:receipt.token,results:[result()]};
  const item=(value.results as LibraryCurrentReplayResult[])[0];
  if(kind==="target")value.target={inputKey:"e".repeat(64)};
  if(kind==="identity")value.replayId="other";
  if(kind==="slot")item.slot="incidents" as never;
  if(kind==="cause")(item.metrics.fields as Record<string,unknown>).causes={state:"known",value:[]};
  if(kind==="version")item.producerVersion="old";
  if(kind==="hash")item.metrics.provenance.replaySha256="e".repeat(64);
  if(kind==="nonfinite")item.metrics.fields.misses={state:"known",value:NaN};
  if(kind==="duplicate")(value.results as LibraryCurrentReplayResult[]).push(result());
  await expect(api.receive(value,()=>undefined)).rejects.toThrow();expect(publish).not.toHaveBeenCalled();
});
it("expires idle tokens, bounds the registry and releases explicitly without touching jobs",async()=>{
  const {api,receipt,publish,advance}=fixture();api.issue({...binding,replayId:"second"},{target:"second"});
  expect(()=>api.issue(binding,{target:"third"})).toThrow(/limit/i);
  advance(1001);expect(await api.receive({method:"current-replay-publish",token:receipt.token,results:[result()]},()=>undefined)).toEqual({state:"stale",accepted:[]});
  const fresh=api.issue(binding,{target:"fresh"});
  expect(await api.receive({method:"current-replay-release",token:fresh.token},()=>undefined)).toEqual({state:"released"});
  expect(await api.receive({method:"current-replay-publish",token:fresh.token,results:[result()]},()=>undefined)).toEqual({state:"stale",accepted:[]});
  expect(publish).not.toHaveBeenCalled();
});
it("invalidates document tokens and discards a late callback receipt",async()=>{
  let finish!:(value:{state:"applied";accepted:["numerical"]})=>void;
  const api=new LibraryCurrentReplayApi({publish:()=>new Promise<{state:"applied";accepted:["numerical"]}>(resolve=>{finish=resolve;})});
  const receipt=api.issue(binding,{});const pending=api.receive({method:"current-replay-publish",token:receipt.token,results:[result()]},()=>undefined);
  api.releaseDocument();finish({state:"applied",accepted:["numerical"]});
  expect(await pending).toEqual({state:"stale",accepted:[]});
});
it("supplies a final guard that prevents publication after token revocation during validation",async()=>{
  let resume!:()=>void;const waiting=new Promise<void>(resolve=>{resume=resolve;});const commit=jest.fn();
  const api=new LibraryCurrentReplayApi({publish:async(_authority,results,assertCurrent)=>{
    await waiting;assertCurrent();commit();return {state:"applied",accepted:results.map(result=>result.slot)};
  }});
  const receipt=api.issue(binding,{});const pending=api.receive({method:"current-replay-publish",token:receipt.token,results:[result()]},()=>undefined);
  api.release(receipt.token);resume();await expect(pending).rejects.toThrow(/stale/i);expect(commit).not.toHaveBeenCalled();
});

it("revokes the backend lease on explicit release before acknowledging completion", async () => {
  let finish!: () => void; const revoke = jest.fn((_authority: string) => new Promise<void>(resolve => { finish = resolve; }));
  const api = new LibraryCurrentReplayApi({ publish: async () => ({ state: "applied", accepted: [] }), revoke });
  const receipt = api.issue(binding, "authority"); let done = false;
  const releasing = api.receive({ method: "current-replay-release", token: receipt.token }, () => undefined).then(value => { done = true; return value; });
  expect(revoke).toHaveBeenCalledWith("authority");
  expect(await api.receive({ method: "current-replay-publish", token: receipt.token, results: [result()] }, () => undefined)).toEqual({ state: "stale", accepted: [] });
  expect(done).toBe(false); finish(); expect(await releasing).toEqual({ state: "released" }); await api.drain();
});
it("revokes idle and document capabilities once and drains them during close", async () => {
  let now = 0; const revoke = jest.fn(async (_authority: string) => undefined);
  const api = new LibraryCurrentReplayApi({ publish: async () => ({ state: "applied", accepted: [] }), revoke, now: () => now, ttlMs: 1 });
  const expired = api.issue(binding, "expired"); now = 2;
  expect(await api.receive({ method: "current-replay-publish", token: expired.token, results: [result()] }, () => undefined)).toEqual({ state: "stale", accepted: [] });
  api.issue(binding, "document"); await api.releaseDocument(); api.issue(binding, "closing"); await api.close();
  expect(revoke.mock.calls).toEqual([["expired"], ["document"], ["closing"]]); await api.close(); expect(revoke).toHaveBeenCalledTimes(3);
});
it("retains a backend revocation failure for teardown without restoring or retrying the token", async () => {
  const revoke = jest.fn(async (_authority: string) => { throw new Error("Backend release failed"); });
  const api = new LibraryCurrentReplayApi({ publish: async () => ({ state: "applied", accepted: [] }), revoke });
  const receipt = api.issue(binding, "authority"); await expect(api.release(receipt.token)).rejects.toThrow(/release failed/i);
  expect(await api.receive({ method: "current-replay-publish", token: receipt.token, results: [result()] }, () => undefined)).toEqual({ state: "stale", accepted: [] });
  await expect(api.close()).rejects.toThrow(/release failed/i); expect(revoke).toHaveBeenCalledTimes(1);
});
it("bounds pending backend revocations and makes repeated release await the same owned work", async () => {
  let finish!: () => void; const revoke = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const api = new LibraryCurrentReplayApi({ publish: async () => ({ state: "applied", accepted: [] }), revoke, maxReceipts: 1 });
  const receipt = api.issue(binding, {}), first = api.release(receipt.token); let repeatedDone = false;
  const repeated = api.release(receipt.token).then(() => { repeatedDone = true; }); await Promise.resolve();
  expect(repeatedDone).toBe(false); expect(() => api.issue(binding, {})).toThrow(/limit/i);
  finish(); await first; await repeated; expect(revoke).toHaveBeenCalledTimes(1);
  expect(api.issue(binding, {}).token).toBeTruthy(); revoke.mockImplementation(async () => undefined); await api.close();
});
