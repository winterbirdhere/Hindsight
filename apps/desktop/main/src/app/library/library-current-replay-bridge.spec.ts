import { LibraryCurrentReplayBridge } from "./library-current-replay-bridge";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryCurrentReplayOpenInput } from "./library-replay-opener";

const authority={version:1,leaseId:"lease",replayId:"replay",binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32)},
  numericalTarget:{inputKey:"d".repeat(64),producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,generation:1},sourceLease:{location:{}}};
const input={} as LibraryCurrentReplayOpenInput;
it("keeps backend authority private and revokes it before retiring the bridge",async()=>{
  const request=jest.fn(async(method:string)=>method==="current-replay-bind"?{state:"applied",replayId:"replay",authority}:null);
  const bridge=new LibraryCurrentReplayBridge(request),check=jest.fn(),result=await bridge.bind(input,check);
  expect(request).toHaveBeenCalledWith("current-replay-bind",input,check);expect(result).not.toHaveProperty("authority");
  expect("currentReplay" in result&&result.currentReplay).toMatchObject({replayId:"replay",numericalInputKey:"d".repeat(64)});
  await bridge.close();expect(request).toHaveBeenLastCalledWith("current-replay-store-release",{authority});
});
it("revokes an applied backend lease when document generation changed before token issuance",async()=>{
  const request=jest.fn(async(method:string)=>method==="current-replay-bind"?{state:"applied",replayId:"replay",authority}:null);
  const bridge=new LibraryCurrentReplayBridge(request);
  await expect(bridge.bind(input,()=>{throw Error("document expired");})).rejects.toThrow("document expired");
  expect(request).toHaveBeenLastCalledWith("current-replay-store-release",{authority});await bridge.close();
});
it("preserves a stale qualified bind instead of falling back to unguarded publication",async()=>{
  const request=jest.fn(async()=>({state:"stale" as const})),bridge=new LibraryCurrentReplayBridge(request);
  expect(await bridge.bind(input,()=>undefined)).toEqual({state:"stale"});expect(request).toHaveBeenCalledTimes(1);await bridge.close();
});
