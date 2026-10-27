import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

type Profile="stable"|"lazer"|"classic";
function fixture(profile:Profile,lateEntry=false){
  const knots=lateEntry ? [[600,100],[820,100],[930,160],[980,160],[990,220],[1050,220],[1138,400],[1400,400]] :
    [[600,100],[820,100],[930,160],[978,220],[1010,220],[1050,220],[1138,400],[1400,400]];
  const taps=[820,930,1138];
  const times=[...new Set([...Array.from({length:41},(_,i)=>600+i*20),...knots.map(k=>k[0]),...taps,...taps.map(t=>t+15)])].sort((a,b)=>a-b);
  const source=times.map(time=>{
    const after=knots.findIndex(k=>k[0]>time),a=knots[after<0?knots.length-1:Math.max(0,after-1)],b=knots[after<0?knots.length-1:after];
    const x=a[1]+(b[1]-a[1])*(time-a[0])/Math.max(1,b[0]-a[0]);
    const actions=taps.flatMap((tap,i)=>time>=tap&&time<tap+15?[i%2]:[]);
    return traceFrame(time,x,actions);
  });
  return errorFixture("100,192,800,1,0\n160,192,880,1,0\n220,192,960,1,0\n400,192,1120,1,0",source,
    profile==="stable"?"stable":"lazer",[],profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
}
function inspect(f:ReturnType<typeof fixture>){
  const e=deriveCircleEvidence(f.trace,f.map,"2");
  return{e,stream:deriveStreamInputEvidence(e,f.map,f.trace),cause:classifyCircleLoss(e,f.map,f.trace)};
}
describe("closed raw gap across a natural rhythm change",()=>{
  it.each(["stable","lazer","classic"] as const)("proves only the %s missing slot from the entire admissible phase envelope",profile=>{
    const f=fixture(profile),{e,stream,cause}=inspect(f);
    expect(Object.values(f.state.hitCircleVerdict).map(v=>v.type)).toEqual(["GREAT","OK","MISS","GREAT"]);
    for(const id of ["1","2","3"])expect(Object.values(deriveCircleEvidence(f.trace,f.map,id).dependencies).every(d=>d.status==="complete")).toBe(true);
    // Immediate successes are +50/+18ms around the single omitted960 pulse.
    // Their32ms difference exceeds the unchanged80*.35 cadence gate. All
    // raw positions cover978..1010 inside the middle circle; no raw edge occurs.
    expect(e.inputs.filter(i=>i.record.timeMs>930&&i.record.timeMs<1138&&i.record.freshActions.length)).toEqual([]);
    expect(stream.missingTargetTap).toBe(true);
    expect(stream.assignments.find(a=>a.componentId==="2"&&a.relation==="missing"))
      .toMatchObject({basis:"closed-source-gap",phaseEnvelopeMs:[18,50]});
    expect(cause.headline).toBe("No tap");
  });
  it("does not use a single inside phase when the whole endpoint envelope crosses entry",()=>{
    const {stream,cause}=inspect(fixture("stable",true));
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it.each(["fresh-other","hidden-fresh","source-gap","same-time-position"] as const)("rejects a %s contradiction in the complete raw bridge",kind=>{
    const original=fixture("stable");
    const f={...original,trace:{...original.trace,records:original.trace.records.map(record=>{
      if(record.kind!=="input"||record.timeMs!==1000)return record;
      if(kind==="source-gap"&&record.source.origin==="parsed")return{...record,source:{...record.source,discontinuityBefore:["source-gap"]}};
      if(kind==="same-time-position")return{...record,timeMs:980,position:{x:220,y:200}};
      return{...record,actions:[0,1],freshActions:kind==="hidden-fresh"?[]:[0,1]};
    })}};
    const {stream,cause}=inspect(f);
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it.each(["known-action","action-candidates","previous-actions"] as const)("does not use an inconsistent %s endpoint or raw state",kind=>{
    const original=fixture("stable");
    const f={...original,trace:{...original.trace,records:original.trace.records.map(record=>{
      if(record.kind==="attempt"&&record.timeMs===930){
        if(kind==="known-action")return{...record,knownAction:0};
        if(kind==="action-candidates")return{...record,actionCandidates:[0]};
      }
      if(record.kind==="input"&&record.timeMs===1000&&kind==="previous-actions")return{...record,previousActions:[1]};
      return record;
    })}};
    expect(inspect(f).cause.codes).not.toContain("no-tap");
  });
});
