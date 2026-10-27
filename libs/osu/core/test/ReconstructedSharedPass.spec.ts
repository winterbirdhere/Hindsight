import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveReconstructedSharedPass } from "../src/gameplay/error-analysis/ReconstructedSharedPass";

function source(fault?:"tangent"|"late-pass"|"second-pass"|"turn"|"gap"|"shifted"){
 const scale=36.49495315551758/40.97679138183594,points=[[-150,420,140],[-56,396,103.6667],[-52,407.6667,87.33334],[-35,434.3333,51.33333],[-19,427,50],[-10,410,55],[-1,381,64],[15,309.6667,80.66666],[32,198.3333,93.33334],[48,96.33334,99.66666],[51,68,100.6667],[65,18.66667,101.6667],[69,4.666667,102.3333],[250,-350,120]];
 const frames=points.map(([t,x,y])=>({time:1000+t+(fault==="late-pass"&&Math.abs(t)<=19?40:0),position:{x:300+(x-381)*scale,y:192+(y-22)*scale+(fault==="tangent"?1:0)},actions:t>=-56&&t<69?[0,...(t>=51?[1]:[])]:[]})).sort((a,b)=>a.time-b.time);
 if(fault==="shifted")for(const f of frames)f.time=f.time===850?850:f.time===944?909:f.time+40;
 if(fault==="second-pass")frames[3].position={x:300,y:192};
 if(fault==="turn")frames[4].position.y+=100;
 const original=errorFixture("300,192,1000,1,0",frames),f={...original,trace:JSON.parse(JSON.stringify(original.trace)) as typeof original.trace};
 if(fault==="gap"){const q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===999)!;if(q.kind==="input")q.source={origin:"parsed",parsedFrameIndex:99};}
 return {...f,e:deriveCircleEvidence(f.trace,f.map,"0")};
}
function fixture(fault?:Parameters<typeof source>[0]){const f=source(fault);return classifyCircleLoss(f.e,f.map,f.trace);}
describe("reconstructed shared timing passage",()=>{
 it("does not turn a reconstructed rim graze into an on-best timing passage",()=>{
  const r=fixture();expect(r.headline).toBe("");
  expect(r.diagnostics?.primary?.reconstructedPass).toBeUndefined();
 });
 it.each(["tangent","late-pass","second-pass","turn","gap"] as const)("does not infer shared timing from %s",fault=>{
  expect(fixture(fault).diagnostics?.primary?.reconstructedPass).toBeUndefined();
 });
 it("revalidates prepared best windows before declaring an on-best passage",()=>{
  const f=source("shifted"),e=JSON.parse(JSON.stringify(f.e)) as typeof f.e;e.geometry!.hitWindows[0]=40;
  const pressIds=e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length).map(i=>i.record.id),comparison=comparePrimaryApproaches(e,f.map,{pressIds},f.trace);
  expect(deriveReconstructedSharedPass(e,f.map,f.trace,comparison)).toBeUndefined();
 });
});
