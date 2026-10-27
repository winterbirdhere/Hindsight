import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(profile:"stable"|"lazer"="stable",classic=false,corrected=false) {
  return errorFixture("100,192,1000,1,0\n300,192,1100,2,0,L|314:192,1,14",[
    traceFrame(700,500),traceFrame(900,500),traceFrame(1000,500,[0]),traceFrame(1090,500,[0]),
    traceFrame(1101,corrected?100:500,[0,1]),traceFrame(1105,500,[0,1]),traceFrame(1190,500,[0,1]),traceFrame(1300,500),
  ],profile,[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
}
function certify(f:ReturnType<typeof fixture>,trace=f.trace){
  const e=deriveCircleEvidence(trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1101)!;
  return certifyPrimaryOpportunity(e,f.map,trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id]);
}
describe("Stable first recorded body update preserves aim correction",()=>{
  it.each([1100,1101])("preserves equal inside acquisition geometry at the first update (%s)",time=>{
    const objects="100,192,1000,1,0\n125,192,1100,2,0,L|139:192,1,14",frames=[traceFrame(700,500),traceFrame(900,500),
      traceFrame(1000,500,[0]),traceFrame(1090,500,[0]),traceFrame(time,150,[0,1]),traceFrame(time+4,500,[0,1]),traceFrame(1300,500)],
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>q.time===time?{...q,position:{x:100,y:192}}:q)),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===time)!,
      proof=certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id]);
    expect(proof?.trackingPreservation?.[0].basis).toBe("equal-tracking");
    expect(fixed.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
  });
  it("uses the recorded initial body state across its actual birth boundary",()=>{
    const f=fixture(),fixed=fixture("stable",false,true);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    for(const k of ["sliderVerdict","checkPointVerdict","sliderTailVerdict","spinnerVerdict"] as const)expect(fixed.state[k]).toEqual(f.state[k]);
    const proof=certify(f);
    expect(proof?.trackingPreservation?.[0].basis).toBe("equal-tracking");
    expect(proof?.trackingPreservation?.[0].eventIds).toContain(f.trace.records.find(r=>r.kind==="slider-tracking"&&r.componentId==="1")!.id);
  });
  it.each([false,true])("does not extrapolate the Stable proof to native/Classic bodies (%s)",classic=>{
    const f=fixture("lazer",classic);expect(certify(f)).toBeUndefined();
  });
  it.each(["prior-tracking","interpolated","wrong-time","wrong-position","wrong-ball","wrong-radius","wrong-geometry","no-birth-boundary","missing-initial-state"])("refuses unsupported %s body evidence",fault=>{
    const f=fixture(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    const first=trace.records.find(r=>r.kind==="slider-tracking"&&r.componentId==="1");
    if(first?.kind!=="slider-tracking")throw Error("fixture");
    if(fault==="prior-tracking")first.tracking.beforeTracking=true;
    if(fault==="interpolated")first.tracking.sampleBasis="reconstructed-update";
    if(fault==="wrong-time")first.tracking.timeMs++;
    if(fault==="wrong-position")first.tracking.position.x++;
    if(fault==="wrong-ball")first.tracking.ball.x++;
    if(fault==="wrong-radius")first.tracking.radius++;
    if(fault==="wrong-geometry")first.tracking.geometryAccepted=true;
    if(fault==="no-birth-boundary"){const before=trace.records.find(r=>r.kind==="input"&&r.timeMs===1090)!;before.timeMs=1100;}
    expect(certify(f,fault==="missing-initial-state"?{...trace,records:trace.records.filter(r=>r.id!==first.id)}:trace)).toBeUndefined();
  });
});
