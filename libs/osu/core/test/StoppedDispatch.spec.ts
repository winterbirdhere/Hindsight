import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function stopped(options:{repair?:boolean;early?:boolean;native?:boolean;classic?:boolean;double?:boolean;head?:boolean}={}) {
  const pulse=options.early ? 1050 : 1100;
  const frames=[traceFrame(700,100),traceFrame(980,100),traceFrame(1000,100,options.repair ? [1] : []),
    traceFrame(1002,100),traceFrame(1040,140),traceFrame(1050,options.early ? 200 : 160,options.early ? [0] : []),
    traceFrame(1052,options.early ? 200 : 160),traceFrame(1070,180),
    traceFrame(1100,200,options.early ? [] : options.double ? [0,1] : [0]),traceFrame(1102,200),
    traceFrame(1120,200),traceFrame(1180,200),traceFrame(1220,250),traceFrame(1350,300)];
  return {...errorFixture("100,192,1000,1,0\n180,192,1050,1,0\n"+(options.head ? "200,192,1100,2,0,L|200:232,1,40" : "200,192,1100,1,0"),frames,options.native ? "lazer" : "stable",[],
    options.classic ? [{acronym:"CL",settings:{classic_note_lock:true}}] : []),pulse};
}
const classify=(f:ReturnType<typeof stopped>,trace=f.trace,excluded?:ReadonlySet<string>)=>
  classifyCircleLoss(deriveCircleEvidence(trace,f.map,"2"),f.map,trace,excluded);

describe("a usable target tap stopped by an earlier rejected receptor",()=>{
  it("does not call a stopped dispatch a direct target Notelock cause when removing the rejection cannot fix that target",()=>{
    const f=stopped(),repaired=stopped({repair:true});
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(repaired.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(deriveCircleEvidence(f.trace,f.map,"1").directRejections).toHaveLength(1);
    expect(deriveCircleEvidence(repaired.trace,repaired.map,"1").directRejections).toEqual([]);
    expect(classify(f).codes).not.toContain("notelock");
  });
  it("refuses an unqueried head witness when its parent lifecycle conflicts",()=>{
    const f=stopped({head:true});
    const clean=classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"2/HEAD"),f.map,f.trace);
    expect(clean.diagnostics?.primary?.association.stoppedDispatchRejections).toHaveLength(1);
    const conflict={...f.trace,failures:[...f.trace.failures,"dependency-conflict:lifecycle:2"]};
    expect(classifyCircleLoss(deriveCircleEvidence(conflict,f.map,"2/HEAD"),f.map,conflict).diagnostics?.primary?.association.stoppedDispatchRejections).toBeUndefined();
  });
  it("refuses a previously resolved target disguised as another expiry",()=>{
    const f=stopped(),trace={...f.trace,records:f.trace.records.map(r=>r.kind==="resolution"&&r.componentId==="2" ? {...r,previousUnresolved:false} : r)};
    expect(classify(f,trace).diagnostics?.primary?.association.stoppedDispatchRejections).toBeUndefined();
  });
  it.each(["stable","classic"])("retains %s stopped-dispatch links without fabricating a direct target rejection",profile=>{
    const f=stopped({native:profile==="classic",classic:profile==="classic"});
    const e=deriveCircleEvidence(f.trace,f.map,"2"),tap=e.inputs.find(i=>i.record.timeMs===1100)!;
    expect(e.terminal).toMatchObject({result:"MISS",mechanism:"automatic-expiry"});
    expect(e.directRejections).toEqual([]);
    expect(tap.inside).toBe(true);expect(tap.record.freshActions).toEqual([0]);
    const cause=classify(f);
    expect(cause.codes).not.toContain("notelock");
    expect(cause.diagnostics?.primary?.association.stoppedDispatchRejections).toEqual([expect.objectContaining({
      inputId:tap.record.id,receiverId:"1",blockerId:"0",targetOffsetMs:0,scope:"unqueried-target-beyond-rejected-receiver",
    })]);
  });
  it("does not call a tap consumed by an earlier successful receptor Notelock",()=>{
    const f=stopped({repair:true});
    expect(f.state.hitCircleVerdict["1"].type).not.toBe("MISS");
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(classify(f).codes).not.toContain("notelock");
  });
  it("does not promote a preceding note's on-time rejected tap by overlap alone",()=>{
    expect(classify(stopped({early:true})).diagnostics?.primary?.association.stoppedDispatchRejections).toBeUndefined();
  });
  it("retains native force-miss semantics",()=>{
    const f=stopped({native:true});
    expect(classify(f).diagnostics?.primary?.association.stoppedDispatchRejections).toBeUndefined();
  });
  it.each(["double","source","receiver-conflict","blocker-conflict"])("refuses incomplete %s support",fault=>{
    const f=stopped({double:fault==="double"});
    const trace=fault==="source" ? {...f.trace,records:f.trace.records.map(r=>r.kind==="input"&&r.timeMs===1100 ? {...r,source:{...r.source,discontinuityBefore:["gap"]}} : r)} : f.trace;
    const excluded=fault==="receiver-conflict" ? new Set(["1"]) : fault==="blocker-conflict" ? new Set(["0"]) : undefined;
    expect(classify(f,trace,excluded).diagnostics?.primary?.association.stoppedDispatchRejections).toBeUndefined();
  });
});
