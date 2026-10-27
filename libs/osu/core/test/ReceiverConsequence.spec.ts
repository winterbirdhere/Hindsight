import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { createReplayTraceCollector } from "../src/gameplay/trace/ReplayTraceCollector";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";

type Profile = "stable" | "classic" | "native";
function fixture(profile:Profile="stable", options:{prior?:number;fault?:string;repair?:boolean;shift?:number;prefix?:string;peer?:boolean}={}) {
  const prior=options.prior??930,shift=options.shift??0,current=options.prefix?980:1000;
  const times=[680,700,720,740,760,780,800,820,840,860,880,900,920,930,940,950,970,980,990,1000,1020,1040,1050,1060,1080,1100,1120];
  const frames=times.map(t=>{
    let x=t===820?100:t<930?200:220,actions:number[]=t===prior?[0]:t===current?[1]:[];
    if(options.repair&&t===820)actions=[1];
    if(options.fault==="missing-prior"&&t===prior)actions=[];
    if(options.fault==="outside-prior"&&t===prior)x=400;
    if(options.fault==="outside-target"&&t===1000)x=180;
    if(options.fault==="multiple-prior"&&t===950)actions=[1];
    if(options.fault==="dual"&&t===1000)actions=[0,1];
    if(options.fault==="held"&&t>=970&&t<=1000)actions=[1];
    if(options.fault==="recovery"&&t===1050){x=400;actions=[0];}
    if(options.fault==="recovered-target"&&t===1100){x=250;actions=[0];}
    if(options.fault==="direct"&&t===1000)x=250;
    return traceFrame(t+shift,x,actions,actions.reduce((mask,a)=>mask|(a===0?5:10),0));
  });
  const objects=[...(options.prefix?[options.prefix]:[]),`100,192,${900+shift},1,0`,`200,192,${950+shift},1,0`,`230,192,${1000+shift},1,0`,...(options.peer?[`230,192,${1000+shift},1,0`]:[])].join("\n");
  const f=errorFixture(objects,frames,profile==="stable"?"stable":"lazer",[],profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
  return {...f,frames,target:options.prefix?"3":"2",receiver:options.prefix?"2":"1",blocker:options.prefix?"1":"0"};
}
function diagnosis(f:ReturnType<typeof fixture>,trace=f.trace,excluded?:ReadonlySet<string>) {
  return classifyCircleLoss(deriveCircleEvidence(trace,f.map,f.target),f.map,trace,excluded);
}
describe("a distinct receiver rejection can prevent a later target opportunity",()=>{
  it.each((["stable","classic"] as const).flatMap(profile=>[930,920,860].map(prior=>[profile,prior] as const)))(
    "reconstructs %s consequence after distinct usable receipt at %s",(profile,prior)=>{
      const f=fixture(profile,{prior}),repaired=fixture(profile,{prior,repair:true});
      expect([f.blocker,f.receiver,f.target].map(id=>f.state.hitCircleVerdict[id].type)).toEqual(["MISS","MISS","MISS"]);
      expect(repaired.state.hitCircleVerdict[f.target].type).toBe("GREAT");
      expect(repaired.state.hitCircleVerdict[f.receiver].type).not.toBe("MISS");
      expect(f.frames.filter((q,k)=>JSON.stringify(q)!==JSON.stringify(repaired.frames[k]))).toHaveLength(1);
      const e=deriveCircleEvidence(f.trace,f.map,f.target);expect(e.directRejections).toEqual([]);
      const before=JSON.stringify(f.trace),cause=diagnosis(f);
      expect(cause.headline).toBe("Notelock");
      expect(cause.diagnostics?.primary?.directRejections).toEqual([]);
      expect(JSON.stringify(f.trace)).toBe(before);
    });
  it("keeps a later unsuccessful recovery visible without erasing the earlier lost opportunity",()=>{
    const f=fixture("stable",{fault:"recovery"});expect(diagnosis(f).headline).toBe("Notelock");
    const input=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1050)!;
    expect(diagnosis(f).eventIds).toContain(input.id);
  });
  it.each(["known-action","inside","component"])("rejects inconsistent later %s evidence",fault=>{
    const f=fixture("stable",{fault:"recovery"}),trace={...f.trace,records:f.trace.records.map(r=>{
      if(r.timeMs!==1050)return r;
      if(r.kind==="attempt"&&fault==="known-action")return {...r,knownAction:1};
      if(r.kind==="selection"&&fault==="inside")return {...r,inside:true};
      if(r.kind==="selection"&&fault==="component")return {...r,component:"circle" as const};
      return r;
    })};
    expect(diagnosis(f,trace).diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
  it("checks the newly exposed Classic positive stack after correcting the blocker",()=>{
    const f=fixture("classic",{prefix:"400,192,600,2,0,L|482:192,1,82"});
    f.map.getSlider("0").head.stackHeight=1;
    const capture=createReplayTraceCollector(f.trace.identity,{...f.trace.domain,initialActionsKnown:true,
      frameSources:f.frames.map((_,parsedFrameIndex)=>({origin:"parsed" as const,parsedFrameIndex}))},f.trace.limits);
    const machine=new LazerGameStateTimeMachine(f.frames,f.map,undefined,{},capture);
    const state=machine.gameStateAt(Infinity),trace=capture.seal();
    expect(state.hitCircleVerdict[f.target].type).toBe("MISS");
    expect(diagnosis(f,trace).diagnostics?.primary?.receiverConsequence).toBeUndefined();
    // The original receiver still has actual order-rejection receipts.
    expect(trace.records.filter(r=>r.kind==="policy"&&r.componentId===f.receiver&&r.blockerId===f.blocker)).toHaveLength(2);
  });
  it("accepts unrelated high raw-mask bits without inventing additional logical actions",()=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>r.kind==="input"?{...r,rawButtonMask:(r.rawButtonMask??0)|64}:r)};
    expect(diagnosis(f,trace).headline).toBe("Notelock");
  });
  it("is unchanged by clock translation",()=>expect(diagnosis(fixture("stable",{shift:4321})).headline).toBe("Notelock"));
  it("withholds the certificate when a same-time Classic peer receives the repaired input",()=>{
    const f=fixture("classic",{peer:true}),repaired=fixture("classic",{peer:true,repair:true});
    expect(repaired.state.hitCircleVerdict["3"].type).toBe("GREAT");
    expect(repaired.state.hitCircleVerdict[f.target].type).toBe("MISS");
    expect(diagnosis(f).diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
  it("does not skip an independent unresolved prefix blocker",()=>{
    const f=fixture("stable",{prefix:"400,192,850,1,0"});
    expect(diagnosis(f).diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
  it.each(["missing-prior","outside-prior","outside-target","multiple-prior","dual","held"])("withholds an unproved %s chain",fault=>{
    const f=fixture("stable",{fault});
    expect(diagnosis(f).headline).not.toBe("Notelock");
  });
  it("does not turn successful consumption into rejection",()=>{
    const f=fixture("stable",{repair:true,fault:"missing-prior"});
    expect(f.state.hitCircleVerdict[f.receiver].type).toBe("OK");
    expect(diagnosis(f).headline).not.toBe("Notelock");
  });
  it.each(["stable","classic"] as const)("recomputes %s target blockers independently of the receiver",profile=>{
    // This parent ends985, so it does not block receiver950 but DOES block target1000.
    const prefix="400,192,600,2,0,L|477:192,1,77";
    const f=fixture(profile,{prefix}),repaired=fixture(profile,{prefix,repair:true});
    expect(repaired.state.hitCircleVerdict[f.receiver].type).not.toBe("MISS");
    expect(repaired.state.hitCircleVerdict[f.target].type).toBe("MISS");
    expect(diagnosis(f).headline).not.toBe("Notelock");
  });
  it("keeps direct target Notelock first",()=>{
    const f=fixture("stable",{fault:"direct"}),e=deriveCircleEvidence(f.trace,f.map,f.target);
    expect(e.directRejections.length).toBeGreaterThan(0);expect(diagnosis(f).headline).toBe("Notelock");
  });
  it("never promotes a target which later recovers",()=>{
    const f=fixture("stable",{fault:"recovered-target"});expect(f.state.hitCircleVerdict[f.target].type).toBe("MEH");
    expect(diagnosis(f).headline).not.toBe("Notelock");
  });
  it("preserves native ordered force misses",()=>{
    const f=fixture("native"),e=deriveCircleEvidence(f.trace,f.map,f.blocker);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Out of order");
    expect(f.state.hitCircleVerdict[f.target].type).toBe("GREAT");
  });
  it.each(["0","1","2"])("keeps exclusions query-local for %s",id=>{
    const f=fixture();expect(diagnosis(f,f.trace,new Set([id])).headline).not.toBe("Notelock");
    expect(diagnosis(f).headline).toBe("Notelock");
  });
  it.each(["gap","source","mask","actions","endpoint","routing"])("rejects incomplete %s proof",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>{
      if(fault==="routing"&&r.kind==="policy"&&r.timeMs===1000)return {...r,blockerId:"missing"};
      if(r.kind!=="input"||r.timeMs!==970)return r;
      if(fault==="gap")return {...r,source:{...r.source,discontinuityBefore:["test"]}};
      if(fault==="source")return {...r,source:{origin:"provided-frame" as const,preparedFrameIndex:0}};
      if(fault==="mask")return {...r,rawButtonMask:1};
      if(fault==="actions")return {...r,previousActions:[1]};
      return r;
    }),...(fault==="endpoint"?{domain:{...f.trace.domain,endTimeMs:999}}:{})};
    expect(diagnosis(f,trace).headline).not.toBe("Notelock");
  });
});
