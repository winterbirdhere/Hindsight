import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";

function source(time:number){
 const object="500,50,850,2,0,L|600:50,1,100\n300,192,1000,1,0",R=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[1] as HitCircle).radius),
  initial=[700,910,940,980,1020,1040,1060,1080,1090].map(t=>({...traceFrame(t,0,t>=1040?[0]:[]),position:{x:300+(-3+(t-1040)*.05)*R,y:192+1.5*R}}));
 initial.push({...traceFrame(850,500,[1]),position:{x:500,y:50}},traceFrame(860,500),traceFrame(1400,500));initial.sort((a,b)=>a.time-b.time);
 const original=errorFixture(object,initial),frames=original.trace.records.filter(r=>r.kind==="input").flatMap(q=>{
  const frame={time:q.timeMs,position:{...q.position},actions:[...q.actions]};return q.timeMs===time?[frame,{...frame,position:{x:q.position.x+150,y:q.position.y+40}}]:[frame];
 }),f=errorFixture(object,frames),e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1040)!,
  comparison=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
 return {f,e,q,comparison};
}
describe("beat movement closed before a future ordered source group",()=>{
 it("regenerates a complete on-beat witness and keeps the later source boundary explicit",()=>{
  const r=source(1060);expect(r.comparison.ranking.selected.map(c=>c.code)).toEqual(["misaim"]);
  expect(r.comparison.ranking.selected[0].support).toBeDefined();
  const candidate=r.comparison.ranking.selected[0];expect(candidate.sourceClosure?.basis).toBe("before-future-ordered-position-group");
  expect(candidate.support?.correction?.canonicalControl).toBeDefined();
  expect(candidate.sourceClosure!.eventIds.every(id=>candidate.eventIds.includes(id))).toBe(true);
  expect(candidate.sourceClosure!.eventIds.some(id=>candidate.support!.correction!.eventIds.includes(id))).toBe(false);
 });
 it.each([1020,1040])("does not move a source boundary at %i out of the relevant best window or press",time=>{
  const r=source(time);expect(r.comparison.candidates.some(c=>c.support&&c.placementBasis==="beat-spanning-outside")).toBe(false);
 });
});
