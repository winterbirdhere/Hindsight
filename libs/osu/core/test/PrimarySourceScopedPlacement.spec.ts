import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(repair=false,changedAxis=false){
  const objects="300,192,1000,1,0\n500,192,1300,1,0",R=stableGameplayRadius((errorFixture(objects,[traceFrame(1500)]).map.hitObjects[0] as HitCircle).radius),
    knots=[[910,-5],[910,-4],[920,-3.7],[940,-3],[970,-2],[1000,-1],[1030,-.3],[1060,-1],[1090,-2],[1096,-2.2]],
    frames=[traceFrame(0,0),...knots.map(([t,x])=>({...traceFrame(t,0,t>=1090?[0]:[]),position:repair&&t===1090?{x:300,y:192}:{x:300+x*R,y:192+(changedAxis&&t===910?1.2:.96)*R}})),
      traceFrame(1200,500),traceFrame(1300,500,[1]),traceFrame(1500,500)];
  return errorFixture(objects,frames);
}
describe("regenerated placement after an ordered source boundary",()=>{
  it("retains the refused original witness and certifies independently regenerated geometry",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1090)!,
      comparison=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace),old=comparison.approaches.episodes[0].spatialCandidates[0];
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",old.eventIds)).toBeUndefined();
    expect(comparison.candidates.some(c=>c.code==="misaim"&&c.support)).toBe(true);
    expect(comparison.candidates.some(c=>c.code==="misaim"&&!c.support)).toBe(true);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Misaim");
    const fixed=fixture(true);expect(fixed.state.hitCircleVerdict["0"]).toMatchObject({type:"MEH",judgementTime:1090});
    expect(fixed.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
  });
  it.each(["source-gap","frame-gap","mask","history","press-jump","scope-end","placement-end"])("retains %s refusal in the regenerated source span",fault=>{
    const f=fixture(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for(const r of trace.records)if(r.kind==="input"){
      if(r.timeMs===970){
        if(fault==="source-gap"&&r.source.origin==="parsed")r.source.discontinuityBefore=["source-gap"];
        if(fault==="frame-gap"&&r.source.origin==="parsed")r.source.parsedFrameIndex++;
        if(fault==="history")r.previousActions=[1];
      }
      if(r.timeMs===1090){if(fault==="mask")r.rawButtonMask=0;if(fault==="press-jump")r.timeMs=1060;}
    }
    const e=deriveCircleEvidence(trace,f.map,"0"),q=e.inputs.find(i=>i.record.freshActions.length)!,
      context={pressIds:[q.record.id],...(fault==="scope-end"?{end:{timeMs:1050,inclusive:true}}:{}),
        ...(fault==="placement-end"?{inputScopes:{[q.record.id]:{placementEnd:{timeMs:1030,inclusive:true}}}}:{})},
      comparison=comparePrimaryApproaches(e,f.map,context,trace);
    expect(comparison.sourceScopedApproaches).toEqual([]);
    expect(comparison.candidates.some(c=>c.support)).toBe(false);
  });
  it("does not equate matching distance with unchanged turn and placement geometry",()=>{
    const f=fixture(false,true),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1090)!,
      comparison=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(comparison.sourceScopedApproaches).toEqual([]);
  });
});
