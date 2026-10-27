import { LibraryIndexMaintenance as Maintenance } from "./library-index-maintenance";

const turn=()=>new Promise(resolve=>setImmediate(resolve));
it("exports the bounded serial maintenance owner",()=>{expect(Maintenance).toEqual(expect.any(Function));});
it("runs only after wake and yields between bounded synchronous steps",async()=>{
  const step=jest.fn(()=>step.mock.calls.length<4),owner=new Maintenance(step);
  await turn();expect(step).not.toHaveBeenCalled();expect(owner.status()).toEqual({state:"idle"});
  owner.wake();expect(step).not.toHaveBeenCalled();await turn();expect(step).toHaveBeenCalledTimes(1);
  await owner.drain();expect(step).toHaveBeenCalledTimes(4);expect(owner.status()).toEqual({state:"idle"});await owner.close();
});
it("coalesces wake bursts into one serial owner with no timer polling",async()=>{
  const step=jest.fn(()=>false),owner=new Maintenance(step);
  for(let n=0;n<100;n++)owner.wake();await owner.drain();expect(step).toHaveBeenCalledTimes(1);
  for(let n=0;n<10;n++)await turn();expect(step).toHaveBeenCalledTimes(1);owner.wake();await owner.drain();expect(step).toHaveBeenCalledTimes(2);await owner.close();
});
it("retains a wake delivered inside a step without concurrent entry",async()=>{
  let depth=0;const step=jest.fn(()=>{expect(depth++).toBe(0);if(step.mock.calls.length===1)owner.wake();depth--;return false;});
  const owner=new Maintenance(step);owner.wake();await owner.drain();expect(step).toHaveBeenCalledTimes(2);await owner.close();
});
it("keeps readiness work paused before its first step until viewer demand releases",async()=>{
  const step=jest.fn(()=>false),owner=new Maintenance(step);await owner.setViewerDemand(true);owner.wake();
  for(let n=0;n<3;n++)await turn();expect(step).not.toHaveBeenCalled();expect(owner.status()).toEqual({state:"waiting-for-viewer"});
  let drained=false;const drain=owner.drain().then(()=>{drained=true;});await turn();expect(drained).toBe(false);
  await owner.setViewerDemand(false);await drain;expect(step).toHaveBeenCalledTimes(1);await owner.close();
});
it("acknowledges a mid-loop hold only at the next actual checkpoint",async()=>{
  let hold:Promise<void>|undefined,acknowledged=false;
  const step=jest.fn(()=>{if(step.mock.calls.length===1)hold=owner.setViewerDemand(true).then(()=>{acknowledged=true;});return step.mock.calls.length<3;});
  const owner=new Maintenance(step);owner.wake();await turn();expect(acknowledged).toBe(false);await hold;expect(acknowledged).toBe(true);
  for(let n=0;n<3;n++)await turn();expect(step).toHaveBeenCalledTimes(1);await owner.setViewerDemand(false);await owner.drain();expect(step).toHaveBeenCalledTimes(3);await owner.close();
});
it("closes a parked owner through cancellation and does not pretend idle before drainage",async()=>{
  const step=jest.fn(()=>true),owner=new Maintenance(step);await owner.setViewerDemand(true);owner.wake();await turn();
  const closing=owner.close();expect(owner.status()).toEqual({state:"closing"});await closing;expect(owner.status()).toEqual({state:"closed"});expect(step).not.toHaveBeenCalled();
  owner.wake();await turn();expect(step).not.toHaveBeenCalled();await expect(owner.close()).resolves.toBeUndefined();
});
it("stops after an error, retains a bounded error, and never retries on wake",async()=>{
  const step=jest.fn(()=>{throw Error("x".repeat(3000));}),owner=new Maintenance(step);owner.wake();await expect(owner.drain()).rejects.toThrow();
  expect(owner.status()).toEqual({state:"error",error:"x".repeat(2048)});owner.wake();await turn();expect(step).toHaveBeenCalledTimes(1);
  await expect(owner.close()).rejects.toThrow();
});
it("rejects an invalid step result instead of interpreting it as completion",async()=>{
  const owner=new Maintenance(()=>"more" as unknown as boolean);owner.wake();await expect(owner.drain()).rejects.toThrow(/boolean|step/i);await expect(owner.close()).rejects.toThrow();
});
