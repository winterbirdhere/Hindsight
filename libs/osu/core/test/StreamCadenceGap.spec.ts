import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

type Profile="stable"|"lazer"|"classic";
function burst(profile:Profile,options:{extra?:boolean;freshOther?:boolean;offTarget?:boolean;nextOffset?:number}={}) {
  const nextTime=1100+(options.nextOffset ?? 65);
  const frames=[traceFrame(700,100),traceFrame(945,100),traceFrame(965,100,[0]),
    traceFrame(980,115,[0]),traceFrame(1000,135,[0]),traceFrame(1020,150,[0]),
    traceFrame(1040,options.offTarget ? 290 : 160,[0]),
    traceFrame(1060,options.offTarget ? 290 : 160,[0]),
    ...(options.extra || options.freshOther ? [traceFrame(1065,options.extra ? 290 : 160,[0,1])] : []),
    traceFrame(1080,options.offTarget ? 290 : 170,[0]),traceFrame(1100,190,[0]),
    traceFrame(1120,220,[0]),traceFrame(1140,220,[0]),traceFrame(1150,220),
    ...(nextTime>1200 ? [traceFrame(1170,220),traceFrame(1190,220)] : []),
    traceFrame(nextTime,220,[1]),traceFrame(nextTime+15,220,[1]),traceFrame(nextTime+35,220)];
  return errorFixture("100,192,900,1,0\n160,192,1000,1,0\n220,192,1100,1,0",frames,
    profile==="stable" ? "stable" : "lazer",[],profile==="classic" ? [{acronym:"CL",settings:{classic_note_lock:true}}] : []);
}
function inspect(f:ReturnType<typeof burst>) {
  const e=deriveCircleEvidence(f.trace,f.map,"1");
  return {e,stream:deriveStreamInputEvidence(e,f.map,f.trace),cause:classifyCircleLoss(e,f.map,f.trace)};
}
describe("complete two-sided cadence gaps",()=>{
  it.each(["stable","lazer","classic"] as const)("identifies a real missing pulse in a short %s burst with measured late anchors",profile=>{
    const f=burst(profile),before=JSON.stringify(normalizeTraceState(f.state)),{e,stream,cause}=inspect(f);
    // Independently authored schedule900/1000/1100 and source taps965/1165:
    // both successful endpoints are+65ms, with no fresh edge between them.
    // Cursor samples cover the missing phase1065; holding0 proves no edge only
    // because the complete raw interval also contains no other fresh action.
    expect(f.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["2"].type).not.toBe("MISS");
    expect(e.inputs.filter(i=>i.record.timeMs>965&&i.record.timeMs<1165&&i.record.freshActions.length)).toEqual([]);
    for(const id of ["0","1","2"])expect(Object.values(deriveCircleEvidence(f.trace,f.map,id).dependencies)
      .every(dependency=>dependency.status==="complete")).toBe(true);
    expect(stream.missingTargetTap).toBe(true);
    expect(cause.headline).toBe("No tap");
    expect(JSON.stringify(normalizeTraceState(f.state))).toBe(before);
  });
  it("does not infer an omitted pulse when a real extra edge occurs in the gap",()=>{
    const {stream,cause}=inspect(burst("stable",{extra:true}));
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it.each(["0","2"])("retains the raw gap but does not promote a contradicted endpoint %s",excluded=>{
    const f=burst("stable"),{e}=inspect(f);
    const cause=classifyCircleLoss(e,f.map,f.trace,new Set([excluded]));
    expect(cause.codes).not.toContain("no-tap");
    expect(cause.diagnostics?.primary?.association.stream?.assignments.some(row=>
      row.componentId==="1" && row.relation==="missing")).toBe(true);
    expect(cause.diagnostics?.primary?.association.stream?.missingTargetTap).toBe(false);
    expect(cause.diagnostics?.primary?.association.stream?.limitations)
      .toContain("stream-omission-conflicting-outcome-anchor");
    // Exclusions are query-local; neither order may poison cached alignment.
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    expect(classifyCircleLoss(e,f.map,f.trace,new Set(["unrelated"])).headline).toBe("No tap");
  });
  it("links both endpoint receipts and the complete raw gap in the promoted diagnosis",()=>{
    const {stream,cause}=inspect(burst("stable"));
    const missing=stream.assignments.find(row=>row.componentId==="1" && row.relation==="missing");
    expect(missing).toBeDefined();
    expect(cause.eventIds).toEqual(expect.arrayContaining(missing?.eventIds ?? []));
  });
  it.each(["stable","lazer","classic"] as const)("holding one action permits the other action to score the %s middle note",profile=>{
    const f=burst(profile,{freshOther:true}),{stream,cause}=inspect(f);
    expect(f.state.hitCircleVerdict["1"].type).not.toBe("MISS");
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it("does not use a rhythmic gap alone when the phase-local cursor evidence is off target",()=>{
    const {stream,cause}=inspect(burst("stable",{offTarget:true}));
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it("does not infer a constant missing phase across inconsistent endpoint timing",()=>{
    const f=burst("stable",{nextOffset:105}),{stream,cause}=inspect(f);
    expect(f.state.hitCircleVerdict["2"].type).not.toBe("MISS");
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
  it("rejects omission evidence across a local parsed-source discontinuity",()=>{
    const original=burst("stable");
    const f={...original,trace:{...original.trace,records:original.trace.records.map(record=>
      record.kind==="input" && record.timeMs===1060 && record.source.origin==="parsed"
        ? {...record,source:{...record.source,discontinuityBefore:["negative-delta"]}} : record)}};
    const {stream,cause}=inspect(f);
    expect(stream.missingTargetTap).toBe(false);
    expect(cause.codes).not.toContain("no-tap");
  });
});
