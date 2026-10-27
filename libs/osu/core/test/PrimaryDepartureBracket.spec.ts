import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(){
  const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius);
  return errorFixture(object,[[700,0,0],[880,0,0],[895,1.3,.2],[920,2,.6],[960,4,1.5],[1000,6,2],
    [1040,8,3],[1080,7.8,3.2],[1095,7.5,3.4],[1400,8,4]].map(([t,x,y])=>
    ({...traceFrame(t,0,t>=1080?[0]:[]),position:{x:300+x*r,y:192+y*r}})));
}
describe("adjacent departure across an approach lookback horizon",()=>{
  it("retains a measured exit and certifies the complete source bracket",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1080)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(c.approaches.episodes[0].properPass?.exitTimeMs).toBeCloseTo(891.4,1);
    expect(c.candidates.some(w=>w.code==="left-early"&&w.support)).toBe(true);
    expect(c.ranking.selected.map(w=>w.code)).toEqual(["left-early"]);
  });
  it.each(["context","fresh","unknown-fresh","provided","frame-gap","token-gap","discontinuity","scope","same-time","outside","tangent"])(
    "does not cross a %s fence",fault=>{
      const f=fixture(),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"0"))) as ReturnType<typeof deriveCircleEvidence>,a=e.inputs.find(i=>i.record.timeMs===880)!,
        b=e.inputs.find(i=>i.record.timeMs===895)!,q=e.inputs.find(i=>i.record.timeMs===1080)!;
      if(fault==="fresh")a.record.freshActions=[1];
      if(fault==="unknown-fresh")a.freshActionsKnown=false;
      if(fault==="provided")a.record.source={origin:"provided-frame",preparedFrameIndex:1};
      if(fault==="frame-gap"&&b.record.source.origin==="parsed")b.record.source.parsedFrameIndex++;
      if(fault==="token-gap"&&b.record.source.origin==="parsed")b.record.source.rawTokenIndex=999;
      if(fault==="discontinuity"&&b.record.source.origin==="parsed")b.record.source.discontinuityBefore=["gap"];
      if(fault==="same-time")a.record.timeMs=b.record.timeMs;
      if(fault==="outside"||fault==="tangent"){
        a.record.position={x:300+e.geometry!.radius*(fault==="outside"?1.2:1),y:192};a.inside=false;
      }
      const c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id],
        ...(fault==="context"?{contextBoundaryInputIds:[a.record.id]}:{}),
        ...(fault==="scope"?{inputScopes:{[q.record.id]:{start:{timeMs:891,inclusive:true}}}}:{})},f.trace);
      expect(c.approaches.episodes[0].properPass).toBeUndefined();
    });
  it.each([918,1000])("retains historical contact but compares the usable arrival at press %i",pressTime=>{
    const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
      f=errorFixture(object,[[650,0],[700,0],[880,.99],[895,1.4],[918,3.3],[960,3],[1000,1.5],[1035,0],[1065,1.5],[1090,3],[1400,4]]
        .map(([t,x])=>traceFrame(t,300+x*r,t>=pressTime?[0]:[]))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===pressTime)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(c.approaches.episodes[0].contacts.length).toBeGreaterThanOrEqual(2);
    expect(c.candidates.some(w=>w.code==="between-passes")).toBe(false);
    // The early pulse's selected properPass is still the historical visit;
    // do not silently replace that different contextual assignment.
    expect(c.candidates.some(w=>w.code==="aim-late")).toBe(true);
    if(pressTime===1000)expect(c.ranking.selected.map(w=>w.code)).toEqual(["aim-late"]);
  });
  it.each([false,true])("keeps a second usable pass competing, mirrored=%s",mirror=>{
    const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
      f=errorFixture(object,[[650,0],[700,0],[940,.5],[955,1.4],[970,3.3],[990,3],[1000,1.5],[1035,0],[1065,1.5],[1090,3],[1400,4]]
        .map(([t,x])=>[mirror?2000-t:t,x]).sort((a,b)=>a[0]-b[0]).map(([t,x])=>traceFrame(t,300+x*r,t>=1000?[0]:[]))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(c.candidates.some(w=>w.code==="between-passes")).toBe(true);
    expect(c.ranking.selected.map(w=>w.code)).toEqual(["misaim"]);
    expect(c.ranking.selected[0].support?.correction?.kind).toBe("same-time-aim");
    expect(c.candidates.some(w=>w.code==="aim-late"||w.code==="left-early")).toBe(false);
  });
  it("preserves early exit when later history falls beyond the scoped opportunity",()=>{
    const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
      f=errorFixture(object,[[650,0],[700,0],[880,.99],[895,1.4],[918,3.3],[960,3],[1000,1.5],[1035,0],[1065,1.5],[1090,3],[1400,4]]
        .map(([t,x])=>[2000-t,x]).sort((a,b)=>a[0]-b[0]).map(([t,x])=>traceFrame(t,300+x*r,t>=1000?[0]:[]))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(c.approaches.episodes[0].relation).toBe("after-pass");
    expect(c.candidates.some(w=>w.code==="between-passes")).toBe(false);
    expect(c.ranking.selected.map(w=>w.code)).toEqual(["left-early"]);
  });
  it.each([false,true])("requires a complete source certificate for a derived temporal relation, gap=%s",gap=>{
    const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
      f=errorFixture(object,[[700,4],[900,0],[950,.5],[980,1.2],[1000,3],[1050,3],[1100,1.5],[1110,.99],[1115,4],[1400,4]]
        .map(([t,x])=>traceFrame(t,300+x*r,t>=1000?[0]:[]))),
      trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace,
      altered=trace.records.find(q=>q.kind==="input"&&q.timeMs===950);
    if(altered?.kind!=="input"||altered.source.origin!=="parsed")throw Error("source");
    if(gap)altered.source.rawTokenIndex=500;
    const e=deriveCircleEvidence(trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},trace);
    // The later shallow contact is preserved but no longer supplies a second pass.
    expect(c.approaches.episodes[0].relation).toBe("after-pass");
    expect(c.candidates.some(w=>w.code==="left-early"&&!w.recordedFailure)).toBe(!gap);
    if(gap)expect(c.ranking.selected).toEqual([]);
    if(!gap)expect(c.candidates.find(w=>w.code==="left-early")?.support).toBeDefined();
  });
});
