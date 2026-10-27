import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

type Profile = "stable" | "classic" | "native" | "disabled-classic";
type Frame = [number,number,number[]];
function fixture(profile:Profile="stable", options:{repair?:boolean;four?:boolean;time?:number;x?:number;fault?:string}={}) {
  const source:Frame[]=options.four ? [[700,220,[]],[890,170,[]],[900,140,[0]],[910,100,[]],
    [915,160,[]],[920,190,[1]],[929,220,[]],[939,220,[]],[940,220,[0]],
    [949,250,[]],[959,250,[]],[960,250,[1]],...Array.from({length:12},(_,i)=>[970+i*10,250,[]] as Frame)] :
    [[700,220,[]],[880,170,[]],[900,140,[0]],[910,100,[]],[920,160,[]],[940,190,[]],
      [950,190,[1]],[960,220,[]],[980,220,[]],[1000,220,[0]],[1020,220,[]],
      [1040,220,[]],[1060,220,[]],[1080,220,[]],[1100,220,[]],[1120,220,[]]];
  const notes=options.four?[[100,900],[200,920],[230,940],[260,960]]:[[100,900],[200,950],[230,1000]];
  const current=options.four?960:1000,intermediate=options.four?920:950;
  const frames=source.map(([t,x,actions])=>{
    if(options.repair&&t===900)x=100;
    if(options.fault===`omit-${t}`||options.fault==="missing-intermediate"&&t===intermediate||options.fault==="missing-current"&&t===current)actions=[];
    if(options.fault==="outside-intermediate"&&t===intermediate)x=150;
    if(options.fault==="outside-current"&&t===current)x=270;
    if(options.fault==="dual"&&t===current)actions=[0,1];
    if(options.fault==="held"&&t===980)actions=[0];
    if(options.fault==="recovery"&&t===980||options.fault==="next-context"&&t===1020)actions=[1];
    if(options.fault==="direct"&&t===current)x=260;
    return traceFrame(t+(options.time??0),x+(options.x??0),actions);
  });
  const result=errorFixture(notes.map(([x,t])=>`${x+(options.x??0)},192,${t+(options.time??0)},1,0`).join("\n"),frames,
    profile==="stable"?"stable":"lazer",[],profile==="classic"||profile==="disabled-classic"?[{acronym:"CL",settings:{classic_note_lock:profile==="classic"}}]:[]);
  return {...result,frames,target:String(notes.length-1)};
}
function diagnosis(f:Pick<ReturnType<typeof fixture>,"trace"|"map"|"target">,trace=f.trace,excluded?:ReadonlySet<string>) {
  return classifyCircleLoss(deriveCircleEvidence(trace,f.map,f.target),f.map,trace,excluded);
}
describe("initiating placement through rejected intermediate slots",()=>{
  function prefixFixture(profile:"stable"|"classic",kind:string,repair=false) {
    const prefix=kind==="live-head"?"100,192,850,2,0,L|138:192,1,38":kind==="blocker"?"400,192,850,1,0":
      kind==="late-parent"?"400,192,600,2,0,L|488:192,1,88":"400,192,600,2,0,L|468:192,1,68";
    const raw:Frame[]=[[700,220,[]],[880,170,[]],[900,repair?100:140,[0]],[910,100,[]],[920,160,[]],[940,190,[]],
      [950,190,kind==="missing-intermediate"?[]:[1]],[960,220,[]],[980,220,[]],[1000,220,[0]],
      [1020,220,[]],[1040,220,[]],[1060,220,[]],[1080,220,[]],[1100,220,[]],[1120,220,[]]];
    const f=errorFixture(prefix+"\n100,192,900,1,0\n200,192,950,1,0\n230,192,1000,1,0",raw.map(([t,x,a])=>traceFrame(t,x,a)),
      profile==="stable"?"stable":"lazer",[],profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
    return {...f,raw,target:"3"};
  }
  it.each((["stable","classic"] as const).flatMap(profile=>["overlap","late-parent"].map(kind=>[profile,kind] as const)))(
    "keeps a resolved %s slider head outside the %s rejection chain",(profile,kind)=>{
      const f=prefixFixture(profile,kind),repaired=prefixFixture(profile,kind,true);
      expect(["1","2","3"].map(id=>f.state.hitCircleVerdict[id].type)).toEqual(["MISS","MISS","MISS"]);
      expect(["1","2","3"].map(id=>repaired.state.hitCircleVerdict[id].type)).toEqual(["GREAT","GREAT","GREAT"]);
      expect(f.raw.filter((p,k)=>JSON.stringify(p)!==JSON.stringify(repaired.raw[k]))).toHaveLength(1);
      const head=f.trace.records.find(r=>r.kind==="resolution"&&r.componentId==="0/HEAD")!;
      const parent=f.trace.records.find(r=>r.kind==="slider-parent"&&r.componentId==="0")!;
      const root=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===900)!;
      expect(head.sequence).toBeLessThan(root.sequence);expect(parent.sequence).toBeGreaterThan(root.sequence);
      expect(parent).toMatchObject({result:"MISS",pendingIds:[]});
      expect(repaired.trace.records.find(r=>r.kind==="slider-parent"&&r.componentId==="0")).toMatchObject({result:"MISS"});
      const cause=diagnosis(f);
      expect(cause.headline).toBe("Late entry");
      expect(cause.diagnostics?.primary?.initiatingChain?.eventIds).toEqual(expect.arrayContaining([head.id,parent.id]));
      expect(cause.diagnostics?.primary?.initiatingChain?.rootComponentId).toBe("1");
    },
  );
  it.each((["stable","classic"] as const).flatMap(profile=>["blocker","missing-intermediate","live-head"].map(kind=>[profile,kind] as const)))(
    "retains the independent %s prefix failure %s",(profile,kind)=>{
      const f=prefixFixture(profile,kind),repaired=prefixFixture(profile,kind,true);
      expect(repaired.state.hitCircleVerdict["3"].type).toBe("MISS");
      expect(diagnosis(f).diagnostics?.primary?.initiatingChain).toBeUndefined();
      if(kind==="live-head")expect(repaired.trace.records.find(r=>r.kind==="selection"&&r.timeMs===900)).toMatchObject({componentId:"0/HEAD"});
    },
  );
  it.each((["stable","classic"] as const).flatMap(profile=>[[0,0],[2345,27],[5000,-40]].map(([time,x])=>[profile,time,x] as const)))(
    "finds the initiating %s placement under translation %s/%s",(profile,time,x)=>{
      const f=fixture(profile,{time,x}),repaired=fixture(profile,{time,x,repair:true});
      expect(["0","1","2"].map(id=>f.state.hitCircleVerdict[id].type)).toEqual(["MISS","MISS","MISS"]);
      expect(["0","1","2"].map(id=>repaired.state.hitCircleVerdict[id].type)).toEqual(["GREAT","GREAT","GREAT"]);
      expect(f.frames.filter((p,k)=>JSON.stringify(p)!==JSON.stringify(repaired.frames[k]))).toHaveLength(1);
      expect(deriveCircleEvidence(f.trace,f.map,"2").directRejections).toEqual([]);
      const before=JSON.stringify(f.trace),cause=diagnosis(f);
      expect(cause.headline).toBe("Late entry");
      expect(cause.diagnostics?.primary?.initiatingChain).toMatchObject({rootComponentId:"0",links:[
        {targetId:"1",receiverId:"1",rejectedBy:"0"},{targetId:"2",receiverId:"1",rejectedBy:"0"}],
        rejectedDispatch:{policyVersion:"rejected-placement-v2",phaseMs:0}});
      expect(JSON.stringify(f.trace)).toBe(before);
    },
  );
  it.each(["stable","classic"] as const)("verifies every intermediate pulse in a %s multi-step rejection",profile=>{
    const f=fixture(profile,{four:true}),repaired=fixture(profile,{four:true,repair:true});
    expect(["0","1","2","3"].map(id=>f.state.hitCircleVerdict[id].type)).toEqual(["MISS","MISS","MISS","MISS"]);
    expect(["0","1","2","3"].map(id=>repaired.state.hitCircleVerdict[id].type)).toEqual(["GREAT","GREAT","GREAT","GREAT"]);
    expect(diagnosis(f).headline).toBe("Late entry");
    for(const time of [920,940]) {
      const missing=fixture(profile,{four:true,fault:`omit-${time}`}),fixed=fixture(profile,{four:true,fault:`omit-${time}`,repair:true});
      expect(fixed.state.hitCircleVerdict["3"].type).toBe("MISS");
      expect(diagnosis(missing).diagnostics?.primary?.initiatingChain).toBeUndefined();
    }
  });
  // Extra/held actions can legitimately recover the target after the root
  // repair; they are outside this proof's single-action/no-recovery scope.
  // Only the four missing/outside-slot controls must remain MISS after repair.
  const faults=[["missing-intermediate","MISS"],["outside-intermediate","MISS"],["missing-current","MISS"],["outside-current","MISS"],
    ["dual","GREAT"],["held","GREAT"],["recovery","GREAT"],["next-context","GREAT"]];
  it.each(faults)("does not inherit across %s",(fault,repairedResult)=>{
    const f=fixture("stable",{fault}),repaired=fixture("stable",{fault,repair:true});
    expect(repaired.state.hitCircleVerdict["2"].type).toBe(repairedResult);
    expect(diagnosis(f).diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
  it.each(["native","disabled-classic"] as const)("keeps %s force/order semantics",profile=>{
    const f=fixture(profile);expect(diagnosis(f).diagnostics?.primary?.initiatingChain).toBeUndefined();
    expect(f.state.hitCircleVerdict["2"].type).toBe("GREAT");
  });
  it("keeps an otherwise usable direct target rejection ahead of inheritance",()=>{
    const f=fixture("stable",{fault:"direct"});expect(diagnosis(f).headline).toBe("Notelock");
    expect(diagnosis(f).diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
  it.each(["0","1","2"])("does not inherit across excluded %s",id=>{
    const f=fixture();expect(diagnosis(f,f.trace,new Set([id])).diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
  const corruption=["synthetic","provided","index","gap","actions","raw-mask","root-source","endpoint"];
  it.each(corruption)("rejects %s evidence before inheritance",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>{
      if(r.kind!=="input")return r;
      if(fault==="root-source"&&r.timeMs===700)return {...r,source:{origin:"provided-frame" as const,preparedFrameIndex:0}};
      if(fault==="actions"&&r.timeMs===950)return {...r,previousActions:[1]};
      if(fault==="raw-mask"&&r.timeMs===950)return {...r,rawButtonMask:1};
      if(r.timeMs!==960)return r;
      if(fault==="synthetic")return {...r,source:{origin:"synthetic" as const,reason:"test"}};
      if(fault==="provided")return {...r,source:{origin:"provided-frame" as const,preparedFrameIndex:7}};
      if(fault==="index"&&r.source.origin==="parsed")return {...r,source:{...r.source,parsedFrameIndex:r.source.parsedFrameIndex+2}};
      if(fault==="gap")return {...r,source:{...r.source,discontinuityBefore:["test-gap"]}};
      return r;
    }),...(fault==="endpoint"?{domain:{...f.trace.domain,endTimeMs:999}}:{})};
    expect(diagnosis(f,trace).diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
});
