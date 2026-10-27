import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function lobe(turn=-.30,corrected=false,blocked=false){
  const objects=(blocked?"500,192,990,1,0\n":"")+"300,192,1000,1,0",
    reference=errorFixture(objects,[traceFrame(0),traceFrame(1200)]),object=reference.map.hitObjects[0];
  if(!(object instanceof HitCircle))throw Error("fixture");
  const radius=stableGameplayRadius(object.radius);
  const knots=[[910,-4],[940,-3],[970,-2],[1000,-1],[1030,turn],[1060,-1],[1090,-2]],
    frames=[traceFrame(0,0),...knots.map(([t,x])=>({...traceFrame(t,300+x*radius,t===1090?[0]:[]),
      position:corrected&&t===1090?{x:300,y:192}:{x:300+x*radius,y:192+.96*radius}})),traceFrame(1200,500)];
  return errorFixture(objects,frames);
}
function shortLobe(y=1.005,corrected=false,monotone=false,blocked=false){
  const objects=(blocked?"500,192,990,1,0\n":"")+"300,192,1000,1,0",reference=errorFixture(objects,[traceFrame(0),traceFrame(1200)]),object=reference.map.hitObjects[0];
  if(!(object instanceof HitCircle))throw Error("fixture");
  const radius=stableGameplayRadius(object.radius),knots=[[910,-1.3],[940,-1],[970,-.7],[1000,-.4],[1030,-.1],[1040,0],[1060,.2],[1090,.5],[1096,.56]],
    frames=[traceFrame(0,0),...knots.map(([t,x])=>({...traceFrame(t,0,t>=1090?[0]:[]),
      position:corrected&&t===1090?{x:300,y:192}:{x:300+(monotone?-3+(t-910)/90:x)*radius,y:192+y*radius}})),traceFrame(1200,500)];
  return errorFixture(objects,frames);
}
describe("complete outside lobes below directional noise margin",()=>{
  it("supports broad aim failure with a usable correction without inventing a directional subtype",()=>{
    const f=lobe(),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.freshActions.length)!;
    const ep=analyzePrimaryApproaches(e,{pressIds:[q.record.id]}).episodes[0];
    expect(ep.contacts).toEqual([]);expect(ep.reconstructedMinimumRadius).toBeGreaterThan(1);
    expect(ep.reconstructedMinimumRadius).toBeLessThan(1.025);
    expect(ep.spatialCandidates.map(c=>c.code)).toEqual(["misaim"]);
    expect(ep.boundedOutsideLobe?.eventIds).toContain(q.record.id);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Misaim");
    expect(lobe(-.30,true).state.hitCircleVerdict["0"].type).toBe("MEH");
  });
  it("treats the graze and the 0.96R sideways shortfall as Misaim",()=>{
    for(const [turn,headline]of [[-.27,"Misaim"],[-.40,"Misaim"]] as const){
      const f=lobe(turn),e=deriveCircleEvidence(f.trace,f.map,"0");expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe(headline);
    }
  });
  it("keeps the bounded morphology diagnostic when a prior unresolved object defeats its correction",()=>{
    const f=lobe(-.30,false,true),e=deriveCircleEvidence(f.trace,f.map,"1");
    expect(lobe(-.30,true,true).state.hitCircleVerdict["1"].type).toBe("MISS");
    const cause=classifyCircleLoss(e,f.map,f.trace);
    expect(cause.headline).toBe("Misaim");
    expect(cause.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
  });
  it("retains a stronger measured traversal after an earlier near-rim lobe",()=>{
    const objects="300,192,1000,1,0",reference=errorFixture(objects,[traceFrame(0),traceFrame(1400)]),
      object=reference.map.hitObjects[0];
    if(!(object instanceof HitCircle))throw Error("fixture");
    const radius=stableGameplayRadius(object.radius),knots=[[-125,3.2556,-7.0943],[-58,2.145,-3.1237],[-51,1.7423,-1.9575],
      [-26,.9093,.4581],[-10,.8399,1.0829],[8,.8538,1.2356],[23,.9788,1.1107],[39,1.4091,.6109],
      [54,2.6448,-.2221],[73,4.7272,-1.2634],[90,6.7403,-2.3185]],
      f=errorFixture(objects,[traceFrame(0),...knots.map(([dt,x,y])=>({...traceFrame(1000+dt,300+x*radius,dt===39?[0]:[]),
        position:{x:300+x*radius,y:192+y*radius}})),traceFrame(1400)]),e=deriveCircleEvidence(f.trace,f.map,"0"),
      q=e.inputs.find(i=>i.record.freshActions.length)!,ep=analyzePrimaryApproaches(e,{pressIds:[q.record.id]}).episodes[0];
    expect(ep.spatialCandidates.map(c=>c.code)).toContain("wide-aim");
    expect(ep.lateralTraversal).toBeDefined();
    expect(ep.lobeAlternatives?.length).toBeGreaterThan(0);
  });
  it("supports a completed outside lobe whose departure is too short for a directional subtype",()=>{
    const f=shortLobe(),e=deriveCircleEvidence(f.trace,f.map,"0");
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Misaim");
    expect(shortLobe(1.005,true).state.hitCircleVerdict["0"].type).toBe("MEH");
  });
  it("preserves real contact and blocked corrections",()=>{
    for(const [f,id,label]of [[shortLobe(.995),"0","Misaim"],[shortLobe(1.005,false,false,true),"1","Misaim"]] as const){
      const e=deriveCircleEvidence(f.trace,f.map,id);expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe(label);
    }
  });
  it("supports only a broad aim diagnosis from bilateral moving evidence before an unfinished inbound path",()=>{
    const f=shortLobe(1.005,false,true),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.freshActions.length)!,
      ep=analyzePrimaryApproaches(e,{pressIds:[q.record.id]}).episodes[0];
    expect(ep.placement).toBe("unproven");expect(ep.contacts).toEqual([]);expect(ep.boundedOutsideLobe).toBeUndefined();
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Misaim");
    expect(shortLobe(1.005,true,true).state.hitCircleVerdict["0"]).toMatchObject({type:"MEH",judgementTime:1090});
  });
});
