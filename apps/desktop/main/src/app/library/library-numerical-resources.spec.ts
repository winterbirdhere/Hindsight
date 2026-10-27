import { LibraryNumericalResources } from "./library-numerical-resources";
import type { LibraryPreparationTicket } from "./library-preparation-store";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { libraryIncidentTarget } from "./library-incidents-target";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";

const ticket:LibraryPreparationTicket={replayId:"replay",stage:"S",dependencyKey:"d".repeat(64),generation:1,reason:"selection",attempt:"prepare"};
const location={replayId:"replay",sourceId:"source",sourceKey:"file",kind:"replays",directory:"D:\\source",locator:"D:\\source\\file.osr",
  sha256:"a".repeat(64),locationRevision:1,sourceConfigRevision:1,metadata:{}};
const descriptor={input:{format:"resources",replayBytes:3,mapBytes:3,binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),exactMapAndProfile:true}},
  target:{slot:"numerical",stage:"S",inputKey:"e".repeat(64),producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION},origin:null,
  recipe:{version:1,replaySha256:"a".repeat(64),fixedKey:"b".repeat(64),intrinsicNative:false,embeddedModsHash:null,
    legacyModsHash:"c".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask"}};
const metric={replayId:"replay",...descriptor.target,slot:"numerical" as const,stage:"S" as const,generation:1,attempt:"metric"};
const evidence:LibraryIncidentEvidenceReceipt={version:1,state:"absent",replaySha256:"a".repeat(64),mapMd5:"c".repeat(32),validationVersion:"library-saved-evidence-v1"};
const missingImplementation=():never=>{throw Error("Missing fixture implementation");};
function fixture(incidentEvidence?:unknown){
  const metadata=jest.fn<Promise<unknown>,[string,Record<string,unknown>?]>(async method=>{
    if(method==="analysis-eligible")return true;
    if(method==="prepare-open")return{items:[location]};
    if(method==="preparation-commit"||method==="analysis-resources-confirm")return{state:"applied",replayId:"replay"};
    throw new Error("Unexpected metadata operation "+method);
  });
  const request=jest.fn(async(method:string,args?:Record<string,unknown>):Promise<unknown>=>{
    if(method==="control")return args?.viewerDemand||args?.userPaused?"parked":"released";
    if(method==="begin")return{beatmapMd5:"c".repeat(32),receipt:{sha256:"a".repeat(64),available:true,metadata:{}},nativeMap:true};
    if(method==="prepare-map")return{md5:"c".repeat(32),sha256:"b".repeat(64),storyboards:[],assetManifestComplete:true};
    if(method==="describe-analysis")return{...descriptor,...(incidentEvidence===undefined?{}:{incidentEvidence})};
    if(method==="transfer")return{id:String(args?.kind),bytes:3};
    if(method==="chunk")return{bytes:new Uint8Array([1,2,3]),done:true};
    if(method==="release")return null;
    throw new Error("Unexpected resource operation "+method);
  });
  const close=jest.fn(async()=>undefined),owner=new LibraryNumericalResources({metadata,resources:{request,close}});
  return{owner,metadata,request,close};
}
it.each(["open","openTarget"] as const)("binds the incident evidence receipt through %s metadata publication",async method=>{
  const f=fixture(evidence),signal=new AbortController().signal;
  if(method==="open")await f.owner.open(ticket,{viewerDemand:false,userPaused:false},signal);
  else await f.owner.openTarget(metric,{viewerDemand:false,userPaused:false},signal);
  expect(f.metadata.mock.calls.find(([name])=>name===(method==="open"?"preparation-commit":"analysis-resources-confirm"))?.[1]).toMatchObject({incidentEvidence:evidence});
  await f.owner.close();
});
it.each(["open","openTarget"] as const)("refuses a stale numerical producer through %s before publication and drains its owned resource",async method=>{
  const f=fixture(evidence),signal=new AbortController().signal;
  const original=f.request.getMockImplementation() ?? missingImplementation;
  f.request.mockImplementation((operation,args)=>operation==="describe-analysis"?
    Promise.resolve({...descriptor,target:{...descriptor.target,producerVersion:"library-numeric-v2"},incidentEvidence:evidence}):original(operation,args));
  await expect(method==="open"?f.owner.open(ticket,{viewerDemand:false,userPaused:false},signal):
    f.owner.openTarget(metric,{viewerDemand:false,userPaused:false},signal)).rejects.toThrow(/Invalid numerical resource descriptor/);
  expect(f.metadata.mock.calls.some(([operation])=>operation==="preparation-commit"||operation==="analysis-resources-confirm")).toBe(false);
  expect(f.close).toHaveBeenCalledTimes(1);
  await f.owner.close();expect(f.close).toHaveBeenCalledTimes(1);
});
it.each(["replaySha256","mapMd5"] as const)("rejects an incident receipt with a different %s before metadata binding",async field=>{
  const f=fixture({...evidence,[field]:"f".repeat(field==="mapMd5"?32:64)});
  await expect(f.owner.open(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal)).rejects.toThrow(/incident evidence/i);
  expect(f.metadata.mock.calls.some(([method])=>method==="preparation-commit")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});
it("rejects a retired C-only retry without opening resources",async()=>{
  const f=fixture(evidence),incident={...libraryIncidentTarget(metric,evidence),generation:4,attempt:"incidents"};
  await expect(f.owner.openTarget(incident,{viewerDemand:false,userPaused:false},new AbortController().signal)).rejects.toThrow(/Invalid numerical target ownership/);
  expect(f.metadata).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();await f.owner.close();
});
it.each(["numerical","timeline"] as const)("rejects a retired C handoff after %s",async phase=>{
  const f=fixture(evidence),incident={...libraryIncidentTarget(metric,evidence),generation:4,attempt:"incidents"};
  const start=phase==="numerical"?metric:{...libraryTimelineTarget(metric),generation:2,attempt:"timeline"};
  await f.owner.openTarget(start,{viewerDemand:false,userPaused:false},new AbortController().signal);
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method===(phase==="numerical"?"metric-numerical-handoff":"metric-timeline-handoff")?Promise.resolve({state:"claimed",ticket:incident}):original(method,args));
  if(phase==="timeline")await f.owner.publishNumerical({fields:{},provenance:{}});
  await expect(phase==="numerical"?f.owner.publishNumerical({fields:{},provenance:{}}):f.owner.publishTimeline({error:"ordinary timeline failure"})).rejects.toThrow(/handoff ownership/);
  expect(f.owner.metricTicket).toEqual(start);await f.owner.close();
});
it("publishes final FC without requiring retired incident evidence",async()=>{
  const f=fixture(),fc={...libraryFcTarget(metric),generation:3,attempt:"fc"};
  await f.owner.openTarget(fc,{viewerDemand:false,userPaused:false},new AbortController().signal);
  expect(await f.owner.publishNumerical({fields:{},provenance:{}})).toBe("fc");
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-fc-handoff"?Promise.resolve({state:"cached"}):original(method,args));
  expect(await f.owner.publishFc({metrics:{fields:{ppIfFc:{state:"known",value:0}},provenance:{}}})).toBe(false);
  expect(f.owner.metricTicket).toBeUndefined();expect(f.metadata.mock.calls.some(([method])=>method==="metric-fc-handoff")).toBe(true);await f.owner.close();
});
it.each(["cached","blocked","stale"] as const)("retires FC ownership after a %s final publication receipt",async state=>{
  const f=fixture(evidence),fc={...libraryFcTarget(metric),generation:3,attempt:"fc"};
  await f.owner.openTarget(fc,{viewerDemand:false,userPaused:false},new AbortController().signal);await f.owner.publishNumerical({fields:{},provenance:{}});
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-fc-handoff"?Promise.resolve({state}):original(method,args));
  expect(await f.owner.publishFc({error:"ordinary FC failure"})).toBe(false);expect(f.owner.metricTicket).toBeUndefined();expect(await f.owner.eligible()).toBe(true);await f.owner.close();
});
it("poisons eligibility and preserves the old exact owner after retired FC-to-C ownership",async()=>{
  const f=fixture(evidence),fc={...libraryFcTarget(metric),generation:3,attempt:"fc"};
  await f.owner.openTarget(fc,{viewerDemand:false,userPaused:false},new AbortController().signal);await f.owner.publishNumerical({fields:{},provenance:{}});
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-fc-handoff"?Promise.resolve({state:"claimed",ticket:{...libraryIncidentTarget(metric,evidence),generation:0,attempt:"bad"}}):original(method,args));
  await expect(f.owner.publishFc({error:"ordinary FC failure"})).rejects.toThrow(/final FC publication receipt/i);
  expect(f.owner.metricTicket).toEqual(fc);await expect(f.owner.eligible()).rejects.toThrow(/publication receipt/i);await f.owner.close();
});
it("holds eligibility checks across atomic publication and transfers the exact source lease",async()=>{
  const f=fixture();await f.owner.openTarget(metric,{viewerDemand:false,userPaused:false},new AbortController().signal);
  await f.owner.read("replay",0,new AbortController().signal);await f.owner.read("map",0,new AbortController().signal);
  const next={...libraryTimelineTarget(metric),generation:2,attempt:"timeline"};let reply!:(value:unknown)=>void;
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-numerical-handoff"?new Promise(resolve=>{reply=resolve;}):original(method,args));
  const publish=f.owner.publishNumerical({fields:{fc:{state:"known",value:true}},provenance:{}});
  let checked=false;const eligible=f.owner.eligible().then(value=>{checked=true;return value;});await Promise.resolve();expect(checked).toBe(false);
  reply({state:"claimed",ticket:next});expect(await publish).toBe(true);expect(await eligible).toBe(true);
  expect(f.metadata.mock.calls.find(([m])=>m==="analysis-eligible")?.[1]).toMatchObject({lease:{ticket:next,location:{sourceId:"source",sourceConfigRevision:1}}});await f.owner.close();
});
it("treats a stale publication receipt as retired work, not a fatal persistence error",async()=>{
  const f=fixture();await f.owner.openTarget(metric,{viewerDemand:false,userPaused:false},new AbortController().signal);
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-numerical-handoff"?Promise.resolve({state:"stale"}):original(method,args));
  expect(await f.owner.publishNumerical({fields:{fc:{state:"known",value:true}},provenance:{}})).toBe(false);
  expect(f.owner.metricTicket).toBeUndefined();await f.owner.close();
});
it("reacquires a derived timeline target with exact numerical resource binding",async()=>{
  const f=fixture(),next={...libraryTimelineTarget(metric),generation:2,attempt:"timeline"};
  await f.owner.openTarget(next,{viewerDemand:false,userPaused:false},new AbortController().signal);
  expect(await f.owner.publishNumerical({fields:{},provenance:{}})).toBe(true);expect(f.owner.metricTicket).toEqual(next);
  expect(f.metadata.mock.calls.some(([m])=>m==="metric-numerical-handoff")).toBe(false);await f.owner.close();
});
it("transfers a consumed resource lease from timeline to the exact FC ticket",async()=>{
  const f=fixture(),timeline={...libraryTimelineTarget(metric),generation:2,attempt:"timeline"},fc={...libraryFcTarget(metric),generation:3,attempt:"fc"};
  await f.owner.openTarget(timeline,{viewerDemand:false,userPaused:false},new AbortController().signal);
  await f.owner.read("replay",0,new AbortController().signal);await f.owner.read("map",0,new AbortController().signal);
  expect(await f.owner.publishNumerical({fields:{},provenance:{}})).toBe(true);
  const original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation((method,args)=>method==="metric-timeline-handoff"?Promise.resolve({state:"claimed",ticket:fc}):original(method,args));
  expect(await f.owner.publishTimeline({error:"timeline size"})).toBe(true);expect(f.owner.metricTicket).toEqual(fc);
  expect(await f.owner.eligible()).toBe(true);expect(f.close).toHaveBeenCalledTimes(1);
});
it("reacquires an FC-only retry without republishing completed numerical or timeline values",async()=>{
  const f=fixture(),fc={...libraryFcTarget(metric),generation:3,attempt:"fc"};
  await f.owner.openTarget(fc,{viewerDemand:false,userPaused:false},new AbortController().signal);
  expect(await f.owner.publishNumerical({fields:{},provenance:{}})).toBe("fc");
  expect(f.metadata.mock.calls.some(([m])=>m==="metric-numerical-handoff"||m==="metric-timeline-handoff")).toBe(false);await f.owner.close();
});
it("reacquires a queued exact target after restart without publishing a replacement",async()=>{
  const f=fixture();await f.owner.openTarget(metric,{viewerDemand:false,userPaused:false},new AbortController().signal);
  expect(f.metadata.mock.calls.find(([method])=>method==="analysis-resources-confirm")?.[1]).toMatchObject({ticket:metric,origin:null});
  expect(f.metadata.mock.calls.some(([method])=>method==="preparation-commit")).toBe(false);await f.owner.close();
  const changed=fixture();await expect(changed.owner.openTarget({...metric,inputKey:"f".repeat(64)},
    {viewerDemand:false,userPaused:false},new AbortController().signal)).rejects.toThrow(/target.*changed/i);
  expect(changed.metadata.mock.calls.some(([method])=>method==="analysis-resources-confirm")).toBe(false);expect(changed.close).toHaveBeenCalledTimes(1);
});
it("retains the claimed handoff even if cancellation wins after publication",async()=>{
  const f=fixture(),abort=new AbortController(),original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation(async(method,args)=>{if(method!=="preparation-commit")return original(method,args);
    expect(args?.handoff).toBe(true);abort.abort();return{state:"applied",replayId:"replay",handoff:{state:"claimed",ticket:metric}};});
  await expect(f.owner.open(ticket,{viewerDemand:false,userPaused:false},abort.signal,true)).rejects.toMatchObject({name:"AbortError"});
  expect(f.owner.handoff).toEqual({state:"claimed",ticket:metric});expect(f.close).toHaveBeenCalledTimes(1);
});
it("checks the selected source lease using the metric ticket after handoff",async()=>{
  const f=fixture(),original=f.metadata.getMockImplementation() ?? missingImplementation;
  f.metadata.mockImplementation(async(method,args)=>method==="preparation-commit"?{state:"applied",replayId:"replay",handoff:{state:"claimed",ticket:metric}}:original(method,args));
  await f.owner.open(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal,true);expect(await f.owner.eligible()).toBe(true);
  expect(f.metadata).toHaveBeenLastCalledWith("analysis-eligible",{lease:{kind:"metric",ticket:metric,location:{sourceId:location.sourceId,sourceConfigRevision:1}}});
  await f.owner.close();
});
it("publishes the exact prepared target then streams once and drains its separate utility",async()=>{
  const f=fixture(),signal=new AbortController().signal;
  const opened=await f.owner.open(ticket,{viewerDemand:false,userPaused:false},signal);
  expect(f.metadata.mock.calls.find(([method])=>method==="prepare-open")?.[1]).toMatchObject({analysis:true});
  expect(opened).toMatchObject({replayId:"replay",...descriptor});
  expect(f.metadata.mock.calls.find(([method])=>method==="preparation-commit")?.[1]).toMatchObject({ticket,location,targets:[descriptor.target],origin:null,recipe:descriptor.recipe});
  expect((await f.owner.read("replay",0,signal)).done).toBe(true);expect(f.close).not.toHaveBeenCalled();
  expect((await f.owner.read("map",0,signal)).done).toBe(true);expect(f.close).toHaveBeenCalledTimes(1);
  expect(await f.owner.control({viewerDemand:true,userPaused:false})).toBe("idle");
  await expect(f.owner.read("map",0,signal)).rejects.toThrow(/closed|consumed/);
});
it("rejects an unbound recipe before publication",async()=>{
  const f=fixture(),original=f.request.getMockImplementation() ?? missingImplementation;
  f.request.mockImplementation((method,args)=>method==="describe-analysis"?Promise.resolve({...descriptor,recipe:{...descriptor.recipe,replaySha256:"f".repeat(64)}}):original(method,args));
  await expect(f.owner.open(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal)).rejects.toThrow(/recipe/i);
  expect(f.metadata.mock.calls.some(([method])=>method==="preparation-commit")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});

it("closes and drains ordinary chunk failures and rejects cancellation during final close",async()=>{
  const f=fixture(),signal=new AbortController().signal;
  await f.owner.open(ticket,{viewerDemand:false,userPaused:false},signal);
  const original=f.request.getMockImplementation() ?? missingImplementation;
  f.request.mockImplementation((method,args)=>method==="chunk"?Promise.reject(new Error("broken chunk")):original(method,args));
  await expect(f.owner.read("replay",0,signal)).rejects.toThrow("broken chunk");expect(f.close).toHaveBeenCalledTimes(1);
  const final=fixture(),abort=new AbortController();await final.owner.open(ticket,{viewerDemand:false,userPaused:false},abort.signal);
  await final.owner.read("replay",0,abort.signal);final.close.mockImplementation(async()=>{abort.abort();});
  await expect(final.owner.read("map",0,abort.signal)).rejects.toMatchObject({name:"AbortError"});
});
it("rejects mismatched descriptors before publishing and drains errors",async()=>{
  const f=fixture(),original=f.request.getMockImplementation() ?? missingImplementation;
  f.request.mockImplementation((method,args)=>method==="describe-analysis"?Promise.resolve({...descriptor,input:{...descriptor.input,binding:{...descriptor.input.binding,mapSha256:"f".repeat(64)}}}):original(method,args));
  await expect(f.owner.open(ticket,{viewerDemand:false,userPaused:false},new AbortController().signal)).rejects.toThrow(/descriptor/);
  expect(f.metadata.mock.calls.some(([method])=>method==="preparation-commit")).toBe(false);expect(f.close).toHaveBeenCalledTimes(1);
});
it("cancels a pending read immediately but waits for utility exit before reader settlement",async()=>{
  const f=fixture(),abort=new AbortController();await f.owner.open(ticket,{viewerDemand:false,userPaused:false},abort.signal);
  let entered!:()=>void,rejectRead!:(error:unknown)=>void,drain!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),closed=new Promise<void>(resolve=>{drain=resolve;});
  const original=f.request.getMockImplementation() ?? missingImplementation;
  f.request.mockImplementation((method,args)=>method==="chunk"?new Promise((_resolve,reject)=>{rejectRead=reject;entered();}):original(method,args));
  f.close.mockImplementation(async()=>{rejectRead(new Error("resource closed"));await closed;});
  let settled=false;const read=f.owner.read("replay",0,abort.signal).catch(error=>{settled=true;return error;});await started;
  try{abort.abort();await new Promise(resolve=>setTimeout(resolve,0));expect(f.close).toHaveBeenCalledTimes(1);expect(settled).toBe(false);}
  finally{drain();await read;await f.owner.close();}
  expect(await read).toMatchObject({message:"resource closed"});
});
