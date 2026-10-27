import { LibraryActivityGate } from "./library-activity-gate";

function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
it("parks computation while native admission waits, then retains the continuation behind viewer demand",async()=>{
  const gate=new LibraryActivityGate(),entered=deferred(),release=deferred();let continued=false;
  const running=gate.run(async()=>{entered.resolve();await gate.waitForExternal(release.promise);continued=true;});await entered.promise;
  await gate.setDemand(true);release.resolve();await new Promise(resolve=>setImmediate(resolve));expect(continued).toBe(false);
  await gate.setDemand(false);await running;expect(continued).toBe(true);
});
it("acknowledges active work only at its checkpoint and resumes the same job", async () => {
  const gate = new LibraryActivityGate(); const entered = deferred(); const release = deferred(); let continuation = 0;
  const work = gate.run(async () => { entered.resolve(); await release.promise; await gate.checkpoint(); continuation++; });
  await entered.promise; const pause = gate.setDemand(true); release.resolve(); await pause;
  expect(continuation).toBe(0); await gate.setDemand(false); await work; expect(continuation).toBe(1);
});
it("cancels parked work and settles the viewer acknowledgement", async () => {
  const gate = new LibraryActivityGate(); const abort = new AbortController(); await gate.setDemand(true);
  const work = gate.run(async () => { await gate.checkpoint(abort.signal); }, abort.signal);
  abort.abort(); await expect(work).rejects.toThrow(/abort/i); await gate.setDemand(true);
});
