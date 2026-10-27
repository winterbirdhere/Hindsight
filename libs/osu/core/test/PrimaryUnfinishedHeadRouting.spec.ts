import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(repair=false, contact=false, start=1300, suffix:ReturnType<typeof traceFrame>[]=[]){
  return errorFixture(`100,192,1000,1,0\n300,192,${start},2,0,L|314:192,1,14`,[
    traceFrame(700,500),traceFrame(900,500),traceFrame(1000,repair?100:500,[0]),traceFrame(1010,500),
    traceFrame(1090,contact?300:500,[1]),traceFrame(1100,500),traceFrame(1120,500),...suffix]);
}
function certify(f:ReturnType<typeof fixture>,trace:ReplayTrace=f.trace){
  const e=deriveCircleEvidence(trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!;
  return certifyPrimaryOpportunity(e,f.map,trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id]);
}
describe("future unfinished head routing closure",()=>{
  it("proves no changed callback without inventing a later slider terminal",()=>{
    const f=fixture(),fixed=fixture(true),proof=certify(f);
    expect(f.trace.records.some(r=>r.kind==="slider-parent"&&r.componentId==="1")).toBe(false);
    expect(f.trace.records.some(r=>r.kind==="resolution"&&r.componentId==="1/HEAD")).toBe(false);
    expect(proof).toBeDefined();
    expect(proof?.headRoutingPreservation?.map(p=>p.componentId)).toEqual(["1"]);
    expect(fixed.state.hitCircleVerdict["0"]).toMatchObject({type:"GREAT",judgementTime:1000});
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
  });
  it("refuses a reachable newly allowed head callback",()=>{
    expect(certify(fixture(false,true))).toBeUndefined();
    expect(fixture(true,true).state.hitCircleVerdict["1/HEAD"]).not.toEqual(fixture(false,true).state.hitCircleVerdict["1/HEAD"]);
  });
  it.each(["source-gap","dropped","conflict"])("retains %s safeguards",fault=>{
    const f=fixture(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    if(fault==="source-gap")for(const r of trace.records)if(r.kind==="input"&&r.timeMs===1010&&r.source.origin==="parsed")r.source.discontinuityBefore=["source-gap"];
    if(fault==="dropped")Object.assign(trace,{droppedRecordBoundary:100});
    if(fault==="conflict")Object.assign(trace,{failures:[...trace.failures,"dependency-conflict:routing:1/HEAD"]});
    expect(certify(f,trace)).toBeUndefined();
  });
  it.each([0,1,2])("preserves independently extended suffix %s",mode=>{
    const suffix=[traceFrame(1300,mode===1?500:300,mode===2?[]:[1]),traceFrame(1340,mode===1?500:300,mode===2?[]:[1]),traceFrame(1400,500),traceFrame(1600,500)],
      f=fixture(false,false,1300,suffix),fixed=fixture(true,false,1300,suffix);
    for(const key of ["sliderVerdict","checkPointVerdict","sliderTailVerdict"] as const)expect(fixed.state[key]).toEqual(f.state[key]);
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
  });
});
