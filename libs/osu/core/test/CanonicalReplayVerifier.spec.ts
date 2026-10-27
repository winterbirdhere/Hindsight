import { certifyCanonicalControl, collectCanonicalControls, completeCanonicalControls } from "../src/gameplay/error-analysis/CanonicalReplayVerifier";
import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function miss() {
 const frames=[traceFrame(800,100,[]),traceFrame(1000,100,[0]),traceFrame(1010,100,[]),traceFrame(1200,100,[])];
 return {frames,...errorFixture("300,192,1000,1,0",frames)};
}
describe("private canonical counterfactual controls",()=>{
 it.each([["global-totals-mismatch",true],["broken-reference",false],["invalid-observation",false]] as const)("keeps %s scoped to its actual evidence",(failure,accepted)=>{
  const f=miss(),trace={...f.trace,failures:[failure]},q=trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!;
  expect(!!certifyCanonicalControl(f.map,trace,{targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]})).toBe(accepted);
 });
 it("verifies the unchanged trace first, then records a hypothetical aim repair without mutation",()=>{
  const f=miss(),before=JSON.stringify(f.trace),q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!;
  const proof=certifyCanonicalControl(f.map,f.trace,{targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]});
  expect(proof?.basis).toBe("canonical-model-counterfactual");
  expect(proof?.outcomes).toEqual([{componentId:"0",before:{type:"MISS",judgementTime:1200,missReason:"TIME_EXPIRED"},after:{type:"GREAT",judgementTime:1000}}]);
  expect(proof?.addedFreshActions).toBe(0);expect(JSON.stringify(f.trace)).toBe(before);
 });
 it("rejects a forged baseline and missing source records",()=>{
  for(const fault of ["verdict","source"]){const f=miss(),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
   const q=trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!;
   if(fault==="source")trace.domain.frameSources!.pop();
   else {const r=trace.records.find(r=>r.kind==="resolution");if(r?.kind==="resolution")r.result="GREAT";}
   expect(certifyCanonicalControl(f.map,trace,{targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]})).toBeUndefined();
  }
 });
 it("refuses to steal a successful neighbour's pulse",()=>{
  const f=errorFixture("100,192,1000,1,0\n300,192,1000,1,0",[traceFrame(800,100,[]),traceFrame(1000,100,[0]),traceFrame(1010,100,[]),traceFrame(1200,100,[])]),
   q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!;
  expect(certifyCanonicalControl(f.map,f.trace,{targetId:"1",relatedComponentIds:["0","1"],changes:[{inputId:q.id,position:{x:300,y:192}}]})).toBeUndefined();
 });
 it("keeps public proof mutations out of the cached baseline",()=>{
  const f=miss(),q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!,plan={targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]};
  const first=certifyCanonicalControl(f.map,f.trace,plan)!;first.changes[0].before.position.x=999;first.outcomes[0].before.type="GREAT";
  const second=certifyCanonicalControl(f.map,f.trace,plan)!;
  expect(second.changes[0].before.position.x).toBe(100);expect(second.outcomes[0].before.type).toBe("MISS");
 });
 it("requires consecutive source ordinals even when a forged trace reproduces",()=>{
  const f=miss(),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
  for(const source of trace.domain.frameSources!)if(source.origin==="parsed"&&source.parsedFrameIndex>=2)source.parsedFrameIndex++;
  for(const r of trace.records)if(r.kind==="input"&&r.source.origin==="parsed"&&r.source.parsedFrameIndex>=2)r.source.parsedFrameIndex++;
  const q=trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!;
  expect(certifyCanonicalControl(f.map,trace,{targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]})).toBeUndefined();
 });
 it("preserves unrelated geometry acceptance even while a slider is not held",()=>{
  const f=errorFixture("300,192,1000,1,0\n100,192,1500,2,0,L|200:192,1,100",
   [[700,0],[800,0],[1000,0],[1010,0],[1200,0],[1500,100],[1600,125],[1700,150],[2000,200]].map(([t,x])=>traceFrame(t,x,t===1000?[0]:[]))),
   ids=[1000,1600].map(t=>f.trace.records.find(r=>r.kind==="input"&&r.timeMs===t)!.id);
  expect(certifyCanonicalControl(f.map,f.trace,{targetId:"0",relatedComponentIds:["0"],changes:ids.map(inputId=>({inputId,position:{x:300,y:192}}))})).toBeUndefined();
 });
 it.each(["radius","profile","position","terminal"])("does not use a canonical fallback to bypass %s integrity",fault=>{
  const f=miss(),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!;
  const corrupted=JSON.parse(JSON.stringify(e)) as typeof e;
  if(fault==="radius")corrupted.geometry!.radius=999;
  if(fault==="profile")corrupted.geometry!.profile="lazer";
  if(fault==="position")corrupted.inputs.find(i=>i.record.id===q.record.id)!.record.position.x=999;
  if(fault==="terminal")corrupted.terminal!.timeMs++;
  expect(certifyPrimaryOpportunity(corrupted,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeUndefined();
 });
 it("reports a related parent improvement alongside its head",()=>{
  const f=errorFixture("100,192,1000,2,0,L|200:192,1,100",[[700,0],[950,0],[960,100],[1000,100],[1120,124],[1250,150],[1400,180],[1500,200],[1600,200]].map(([t,x])=>traceFrame(t,x,t>=950?[0]:[])),"stable",["SCORE_V2"]),
   q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===950)!,p=certifyCanonicalControl(f.map,f.trace,{targetId:"0/HEAD",relatedComponentIds:["0/HEAD","0"],changes:[{inputId:q.id,position:{x:100,y:192}}]});
  expect(p?.parentOutcomes).toEqual([{componentId:"0",before:"MEH",after:"OK",judgementTime:1500}]);
 });
 it("can abandon cooperative preparation and then verify the same control independently",()=>{
  const frames=Array.from({length:1201},(_,k)=>traceFrame(k,100,k===1000?[0]:[])),f=errorFixture("300,192,1000,1,0",frames),
   q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!,plan={targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]},
   pending=collectCanonicalControls(f.map,f.trace,()=>certifyCanonicalControl(f.map,f.trace,plan));
  expect(pending.value).toBeUndefined();expect(pending.queue).toHaveLength(1);
  const work=completeCanonicalControls(f.map,f.trace,pending.queue);expect(work.next().done).toBe(false);work.return();
  expect(certifyCanonicalControl(f.map,f.trace,plan)?.outcomes[0].after.type).toBe("GREAT");
 });
 it("retains native profiles and excluded components as unavailable to this Stable verifier",()=>{
  const f=miss(),q=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1000)!,plan={targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,position:{x:300,y:192}}]};
  expect(certifyCanonicalControl(f.map,f.trace,plan,new Set(["0"]))).toBeUndefined();
  expect(certifyCanonicalControl(f.map,{...f.trace,identity:{...f.trace.identity,analysisProfileId:"lazer"}},plan)).toBeUndefined();
 });
});
