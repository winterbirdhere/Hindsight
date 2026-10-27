import { LibraryAnalysisGate } from "./library-analysis-gate";

function deferred() { let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }

it("acknowledges only after parking and continues the same traversal exactly once",async()=>{
  const gate=new LibraryAnalysisGate(), reached=deferred(), proceed=deferred();let count=0,acknowledged=false;
  const work=gate.run(async()=>{for(let i=0;i<4;i++){count++;if(i===0){reached.resolve();await proceed.promise;}await gate.checkpoint();}return count;});
  await reached.promise;
  const acknowledgement=gate.control({viewerDemand:true,userPaused:false}).then(state=>{acknowledged=true;return state;});
  await Promise.resolve();expect(acknowledged).toBe(false);expect(count).toBe(1);
  proceed.resolve();expect(await acknowledgement).toBe("parked");expect(count).toBe(1);
  await new Promise(resolve=>setTimeout(resolve,5));expect(count).toBe(1);
  await gate.control({viewerDemand:false,userPaused:false});expect(await work).toBe(4);
});

it("keeps user Pause independent from transient viewer demand",async()=>{
  const gate=new LibraryAnalysisGate();expect(await gate.control({viewerDemand:false,userPaused:true})).toBe("idle");
  let started=false;const work=gate.run(async()=>{started=true;return 42;});
  expect(await gate.control({viewerDemand:true,userPaused:true})).toBe("parked");
  expect(await gate.control({viewerDemand:false,userPaused:true})).toBe("parked");expect(started).toBe(false);
  expect(gate.status()).toMatchObject({held:true,userPaused:true,viewerDemand:false});
  await gate.control({viewerDemand:false,userPaused:false});expect(await work).toBe(42);
});

it("cancellation wakes parked work and releases its owner without a resume/restart loop",async()=>{
  const gate=new LibraryAnalysisGate(), abort=new AbortController(), failure=new Error("cancel job");
  await gate.control({viewerDemand:true,userPaused:false});let started=false;
  const work=gate.run(async()=>{started=true;},abort.signal);
  const rejected=expect(work).rejects.toBe(failure);
  expect(await gate.control({viewerDemand:true,userPaused:false})).toBe("parked");abort.abort(failure);await rejected;
  expect(started).toBe(false);expect(gate.status().active).toBe(false);
  await gate.control({viewerDemand:false,userPaused:false});expect(await gate.run(async()=>7)).toBe(7);
});

it("rejects concurrent work and reports superseded demand without claiming it parked",async()=>{
  const turn=deferred(), gate=new LibraryAnalysisGate(()=>turn.promise);let started=false;
  const work=gate.run(async()=>{started=true;});
  const pending=gate.control({viewerDemand:true,userPaused:false});
  await gate.control({viewerDemand:false,userPaused:false});expect(await pending).toBe("superseded");
  await expect(gate.run(async()=>undefined)).rejects.toThrow(/serial/);
  turn.resolve();await work;expect(started).toBe(true);
});

it("parks its own computation during externally owned I/O and gates continuation after the read",async()=>{
  const gate=new LibraryAnalysisGate(),read=deferred(),entered=deferred();let continued=false;
  const work=gate.run(async()=>{entered.resolve();await gate.waitForExternal(read.promise);continued=true;});
  await entered.promise;
  try {
    expect(await gate.control({viewerDemand:true,userPaused:false})).toBe("parked");
    read.resolve();await new Promise(resolve=>setTimeout(resolve,5));expect(continued).toBe(false);
  }finally{read.resolve();await gate.control({viewerDemand:false,userPaused:false});await work;}
  expect(continued).toBe(true);
});
