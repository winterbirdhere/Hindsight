import { LibraryNativeBroker, LibraryNativeBridge, LibraryNativeDrainError } from "./library-native-admission";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function peer(broker:LibraryNativeBroker,priority?:"artwork"){
  const sent:unknown[]=[];
  const send=(value:unknown)=>{sent.push(value);queueMicrotask(()=>bridge.receive(value));};
  const endpoint=broker.attach(send,priority);
  const bridge=new LibraryNativeBridge(value=>queueMicrotask(()=>endpoint.receive(value)));
  return{endpoint,bridge,sent};
}
it("prefers trusted artwork at the next free slot without preempting active work",async()=>{
  const broker=new LibraryNativeBroker(),active=peer(broker),background=peer(broker),art=peer(broker,"artwork"),order:string[]=[];let end!:()=>void;
  const running=active.bridge.run("map-performance",()=>new Promise<void>(resolve=>{order.push("running");end=resolve;}));await tick();
  const queued=background.bridge.run("replay-decode",async()=>{order.push("background");});
  const visible=art.bridge.run("source-resolve",async()=>{order.push("artwork");});await tick();expect(order).toEqual(["running"]);
  end();await Promise.all([running,queued,visible]);expect(order).toEqual(["running","artwork","background"]);await broker.close();
});
it("keeps priority artwork behind viewer hold and serialized source ownership",async()=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(2);const source=peer(broker),art=peer(broker,"artwork"),calculation=peer(broker);let end!:()=>void;const order:string[]=[];
  const running=source.bridge.run("source-page",()=>new Promise<void>(resolve=>{end=resolve;}));await tick();
  const visible=art.bridge.run("source-resolve",async()=>{order.push("artwork");});
  const useful=calculation.bridge.run("map-performance",async()=>{order.push("calculation");});await useful;expect(order).toEqual(["calculation"]);
  const hold=broker.setViewerDemand(true);end();await running;await hold;expect(order).toEqual(["calculation"]);
  await broker.setViewerDemand(false);await visible;expect(order).toEqual(["calculation","artwork"]);await broker.close();
});
it.each([1,2,4] as const)("Maximum speed bounds isolated helpers at %s and global hold waits for all of them",async capacity=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(capacity);
  const peers=Array.from({length:capacity+1},()=>peer(broker)),ends:(()=>void)[]=[],started:number[]=[];
  const work=peers.map((p,i)=>p.bridge.run(i%2?"replay-decode":"map-performance",()=>new Promise<void>(resolve=>{started.push(i);ends[i]=resolve;})));
  await tick();expect(started).toHaveLength(capacity);expect(broker.status().active).toBe(capacity);
  let held=false;const hold=broker.setViewerDemand(true).then(()=>{held=true;});
  for(let i=0;i<capacity;i++){ends[i]();await work[i];await tick();expect(held).toBe(i===capacity-1);expect(started).toHaveLength(capacity);}
  await hold;await broker.setViewerDemand(false);await tick();expect(started).toHaveLength(capacity+1);ends[capacity]();await work[capacity];await broker.close();
});
it("capacity downgrade keeps owned helpers and blocks new grants until the smaller ceiling is free",async()=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(4);const peers=Array.from({length:5},()=>peer(broker)),ends:(()=>void)[]=[],started:number[]=[];
  const work=peers.map((p,i)=>p.bridge.run("timeline-performance",()=>new Promise<void>(resolve=>{started.push(i);ends[i]=resolve;})));
  await tick();broker.setCapacity(1);expect(broker.status().active).toBe(4);
  for(let i=0;i<3;i++){ends[i]();await work[i];await tick();expect(started).toEqual([0,1,2,3]);}
  ends[3]();await work[3];await tick();expect(started).toEqual([0,1,2,3,4]);ends[4]();await work[4];await broker.close();
  expect(()=>broker.setCapacity(3 as 1)).toThrow(/capacity/i);
});
it("peer-only drain does not wait for or retire another active helper",async()=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(2);const a=peer(broker),b=peer(broker);let endA!:()=>void,endB!:()=>void;
  const wa=a.bridge.run("source-resolve",()=>new Promise<void>(r=>{endA=r;})),wb=b.bridge.run("replay-decode",()=>new Promise<void>(r=>{endB=r;}));await tick();
  let held=false;const hold=a.endpoint.setHeld(true).then(()=>{held=true;});await tick();expect(held).toBe(false);endA();await wa;await hold;expect(broker.status().active).toBe(1);
  let closed=false;const closing=broker.close().then(()=>{closed=true;});await tick();expect(closed).toBe(false);endB();await wb;await closing;
});
it("keeps source reads in one group while calculation/decode peers use spare capacity, including a hold-time upgrade",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker),c=peer(broker),started:string[]=[];
  let endA!:()=>void,endB!:()=>void,endC!:()=>void;
  await broker.setViewerDemand(true);broker.setCapacity(4);
  const wa=a.bridge.run("source-page",()=>new Promise<void>(r=>{started.push("page");endA=r;}));
  const wb=b.bridge.run("source-resolve",()=>new Promise<void>(r=>{started.push("resolve");endB=r;}));
  const wc=c.bridge.run("replay-decode",()=>new Promise<void>(r=>{started.push("decode");endC=r;}));
  await tick();expect(started).toEqual([]);await broker.setViewerDemand(false);await tick();expect(started).toEqual(["page","decode"]);
  endA();await wa;await tick();expect(started).toEqual(["page","decode","resolve"]);endB();endC();await Promise.all([wb,wc]);await broker.close();
});
it("mixed-peer grant/cancel and late duplicate release never clear another helper's lease",async()=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(2);const a=peer(broker);let end!:()=>void;
  const active=a.bridge.run("timeline-performance",()=>new Promise<void>(r=>{end=r;}));await tick();
  const replies:unknown[]=[],endpoint=broker.attach(v=>replies.push(v)),bridge=new LibraryNativeBridge(v=>endpoint.receive(v)),abort=new AbortController(),work=jest.fn(async()=>1);
  const unused=bridge.run("replay-decode",work,abort.signal),cancelled=expect(unused).rejects.toThrow("cancel before grant delivery");
  abort.abort(new Error("cancel before grant delivery"));for(const reply of replies)bridge.receive(reply);await cancelled;
  endpoint.receive({version:1,event:"native-release",id:1,drained:true});expect(work).not.toHaveBeenCalled();expect(broker.status().active).toBe(1);expect(broker.status().error).toBeUndefined();end();await active;await broker.close();
});
it("one uncertain helper poisons multi-active holds and replacements without forgetting other owned helpers",async()=>{
  const latch:{error?:Error}={},broker=new LibraryNativeBroker(latch);broker.setCapacity(2);const a=peer(broker),b=peer(broker),c=peer(broker);let fail!:(e:Error)=>void,end!:()=>void;
  const wa=a.bridge.run("map-performance",()=>new Promise<void>((_r,j)=>{fail=j;})),failed=expect(wa).rejects.toThrow("uncertain"),wb=b.bridge.run("replay-decode",()=>new Promise<void>(r=>{end=r;}));await tick();
  const next=jest.fn(async()=>1),wc=c.bridge.run("source-page",next),rejected=expect(wc).rejects.toMatchObject({libraryNativeOwnershipUncertain:true});
  const hold=expect(broker.setViewerDemand(true)).rejects.toThrow(/uncertain/);fail(new LibraryNativeDrainError("uncertain"));await failed;await rejected;await hold;
  expect(broker.status().active).toBe(2);end();await wb;await tick();expect(broker.status().active).toBe(1);expect(next).not.toHaveBeenCalled();await expect(broker.close()).rejects.toThrow(/uncertain/);
  const replacement=new LibraryNativeBroker(latch);replacement.setCapacity(4);await expect(peer(replacement).bridge.run("map-performance",next)).rejects.toMatchObject({libraryNativeOwnershipUncertain:true});expect(next).not.toHaveBeenCalled();
});
it("disconnecting one of multiple active peers poisons admission and preserves the surviving lease",async()=>{
  const broker=new LibraryNativeBroker();broker.setCapacity(2);const a=peer(broker),b=peer(broker);let ea!:()=>void,eb!:()=>void;
  const wa=a.bridge.run("source-resolve",()=>new Promise<void>(r=>{ea=r;})),wb=b.bridge.run("timeline-performance",()=>new Promise<void>(r=>{eb=r;}));await tick();a.endpoint.disconnected();
  expect(broker.status()).toMatchObject({active:2,error:expect.stringMatching(/unconfirmed/)});ea();eb();await Promise.all([wa,wb]);await tick();expect(broker.status().active).toBe(1);await expect(broker.close()).rejects.toThrow(/unconfirmed/);
});
it("serializes helper phases across utilities and holds admission without restarting queued work",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker);let end!:()=>void,calls=0;
  const first=a.bridge.run("source-page",()=>new Promise<void>(resolve=>{end=resolve;}));await tick();
  const second=b.bridge.run("replay-decode",async()=>{calls++;return 42;});await tick();expect(calls).toBe(0);
  let held=false;const holding=broker.setViewerDemand(true).then(()=>{held=true;});await tick();expect(held).toBe(false);
  end();await first;await holding;expect(calls).toBe(0);expect(broker.status()).toMatchObject({active:0,queued:1,held:true});
  await broker.setViewerDemand(false);expect(await second).toBe(42);await tick();expect(calls).toBe(1);await broker.close();
});
it("per-peer Pause lets unrelated metadata phases proceed and queued cancellation never spawns",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker);await a.endpoint.setHeld(true);
  const abort=new AbortController(),work=jest.fn(async()=>1),pending=a.bridge.run("replay-decode",work,abort.signal);
  const cancelled=expect(pending).rejects.toThrow("stop");await tick();expect(await b.bridge.run("source-page",async()=>2)).toBe(2);
  abort.abort(new Error("stop"));await cancelled;await a.endpoint.setHeld(false);await tick();expect(work).not.toHaveBeenCalled();await broker.close();
});
it("an abort racing a grant returns the unused permit without executing work",async()=>{
  const broker=new LibraryNativeBroker(),replies:unknown[]=[];
  const endpoint=broker.attach(value=>replies.push(value)),bridge=new LibraryNativeBridge(value=>endpoint.receive(value));
  const abort=new AbortController(),work=jest.fn(async()=>1),pending=bridge.run("source-page",work,abort.signal),cancelled=expect(pending).rejects.toThrow("stop");
  abort.abort(new Error("stop"));for(const reply of replies)bridge.receive(reply);await cancelled;expect(work).not.toHaveBeenCalled();expect(broker.status().active).toBe(0);await broker.close();
});
it("unconfirmed helper drainage poisons all further admission and persists across owner replacement",async()=>{
  const latch:{error?:Error}={},broker=new LibraryNativeBroker(latch),a=peer(broker),b=peer(broker);
  const failed=a.bridge.run("replay-decode",async()=>{throw new LibraryNativeDrainError("exit not confirmed");});
  await expect(failed).rejects.toThrow("exit not confirmed");await tick();
  await expect(b.bridge.run("source-page",async()=>1)).rejects.toThrow(/exit not confirmed/);
  await expect(broker.close()).rejects.toThrow(/exit not confirmed/);
  const replacement=new LibraryNativeBroker(latch);await expect(peer(replacement).bridge.run("source-page",async()=>1)).rejects.toThrow(/exit not confirmed/);
});
it("utility exit with an active permit fails closed; queued peer exit only cancels its request",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),b=peer(broker);let end!:()=>void;
  const active=a.bridge.run("source-page",()=>new Promise<void>(resolve=>{end=resolve;}));await tick();
  const queued=b.bridge.run("replay-decode",async()=>1),rejected=expect(queued).rejects.toThrow(/disconnected/);await tick();
  b.endpoint.disconnected();b.bridge.close();await rejected;expect(broker.status().error).toBeUndefined();
  a.endpoint.disconnected();end();await active;await tick();expect(broker.status().error).toMatch(/exit.*unconfirmed/i);await expect(broker.close()).rejects.toThrow();
});
it("coalesces repeated hold acknowledgements while one helper is draining",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker);let end!:()=>void;
  const active=a.bridge.run("source-page",()=>new Promise<void>(resolve=>{end=resolve;}));await tick();
  const holds=Array.from({length:100},()=>broker.setViewerDemand(true));
  const outcomes=Promise.all(holds);end();await active;await expect(outcomes).resolves.toHaveLength(100);await broker.close();
});
it("preserves uncertain ownership for a queued peer and replacement broker without starting work",async()=>{
  const latch:{error?:Error}={},broker=new LibraryNativeBroker(latch),a=peer(broker),b=peer(broker);let fail!:(error:Error)=>void,calls=0;
  const active=a.bridge.run("source-page",()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
  const failed=expect(active).rejects.toThrow("exit unconfirmed");await tick();
  const queued=b.bridge.run("timeline-performance",async()=>{calls++;}),outcome=queued.catch(error=>error);
  await tick();expect(broker.status().queued).toBe(1);fail(new LibraryNativeDrainError("exit unconfirmed"));await failed;
  expect(await outcome).toMatchObject({libraryNativeOwnershipUncertain:true});expect(calls).toBe(0);
  const future=await b.bridge.run("map-performance",async()=>{calls++;}).catch(error=>error);
  expect(future).toMatchObject({libraryNativeOwnershipUncertain:true});expect(calls).toBe(0);
  await expect(broker.close()).rejects.toThrow(/unconfirmed/);
  const replacement=new LibraryNativeBroker(latch),next=peer(replacement);
  const restored=await next.bridge.run("timeline-performance",async()=>{calls++;}).catch(error=>error);
  expect(restored).toMatchObject({libraryNativeOwnershipUncertain:true});expect(calls).toBe(0);
  await expect(replacement.close()).rejects.toThrow(/unconfirmed/);
});
it.each(["busy","closed"])("does not mark ordinary %s admission rejection as uncertain ownership",async reason=>{
  const broker=new LibraryNativeBroker({},reason==="busy"?0:8),a=peer(broker);let calls=0;
  if(reason==="closed")await broker.close();
  const error=await a.bridge.run("timeline-performance",async()=>{calls++;}).catch(failure=>failure);
  expect(error).toBeInstanceOf(Error);expect(error.message).toMatch(new RegExp(reason));
  expect(error.libraryNativeOwnershipUncertain).toBeUndefined();expect(calls).toBe(0);await broker.close();
});
it("retains explicit abort precedence when a queued uncertainty reply is delayed",async()=>{
  const broker=new LibraryNativeBroker(),a=peer(broker),replies:unknown[]=[];let fail!:(error:Error)=>void,calls=0;
  const active=a.bridge.run("source-page",()=>new Promise<void>((_resolve,reject)=>{fail=reject;}));
  const failed=expect(active).rejects.toThrow("exit unconfirmed");await tick();
  const endpoint=broker.attach(value=>replies.push(value)),bridge=new LibraryNativeBridge(value=>endpoint.receive(value)),abort=new AbortController();
  const queued=bridge.run("timeline-performance",async()=>{calls++;},abort.signal),outcome=queued.catch(error=>error);
  fail(new LibraryNativeDrainError("exit unconfirmed"));await failed;await tick();
  const stopped=new Error("explicit cancellation");abort.abort(stopped);for(const reply of replies)bridge.receive(reply);
  expect(await outcome).toBe(stopped);expect(calls).toBe(0);expect(broker.status().error).toMatch(/unconfirmed/);
  await expect(broker.close()).rejects.toThrow(/unconfirmed/);
});
