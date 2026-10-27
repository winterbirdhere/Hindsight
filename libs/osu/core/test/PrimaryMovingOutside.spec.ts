import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { boundedMovingOutside, boundedBeatOutside } from "../src/gameplay/error-analysis/PrimaryMovingOutside";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

export function fixture(repair=false,mode="moving"){
  const object="300,192,1000,1,0",R=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
    frames=[700,910,940,980,1020,1040,1060,1080,1090].filter(t=>mode!=="terminal-pulse"||t<=1040).map(t=>({...traceFrame(t,0,t>=1040?[0]:[]),position:{
      x:300+(-3+(mode==="still"?0:mode==="noise"?Math.max(-.01,Math.min(.01,(t-1040)*.0001)):(mode==="no-after"?Math.min(t,1040):t)-1040)*.05)*R,y:192+1.5*R}}));
  if(repair)frames.find(q=>q.time===1040)!.position={x:300,y:192};
  frames.push(traceFrame(1400,500));return errorFixture(object,frames);
}
describe("bounded moving outside aim evidence",()=>{
  it("retains continuous moving geometry across an explicitly NULL-routed extra edge",()=>{
    const seed=fixture(),frames=seed.trace.records.filter(r=>r.kind==="input").map(r=>{
      if(r.kind!=="input")throw Error("input");return {...traceFrame(r.timeMs,r.position.x,r.timeMs===980?[1]:r.actions),position:r.position};}),
      f=errorFixture("300,192,1000,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1040)!,
      result=comparePrimaryApproaches(e,f.map,{pressIds:e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id)},f.trace),
      candidate=result.candidates.find(c=>c.code==="misaim"&&c.inputIds.includes(q.record.id));
    expect(candidate).toBeDefined();
    expect(candidate?.support?.correction).toBeUndefined();
    expect(result.ranking.selected[0].attribution?.tapOffsetMs).toBe(-20);
    const attempt=f.trace.records.find(r=>r.kind==="attempt"&&r.timeMs===980)!;
    expect(candidate?.eventIds).toContain(attempt.id);
  });
  it("admits broad aim beyond the best window with measured motion on both sides",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1040)!,
      result=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace);
    expect(result.approaches.episodes[0]).toMatchObject({placement:"unproven",contacts:[]});
    const candidate=result.candidates.find(c=>c.code==="misaim");
    expect(candidate).toBeDefined();expect(candidate?.independent).toBe(false);
    expect(candidate?.support?.correction?.kind).toBe("same-time-aim");
    expect(candidate?.eventIds.length).toBeGreaterThan(3);
    expect(fixture(true).state.hitCircleVerdict["0"]).toMatchObject({type:"OK",judgementTime:1040});
  });
  it.each(["still","noise"])("does not fill a blank from %s geometry",mode=>{
    const f=fixture(false,mode),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1040)!;
    expect(comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace).candidates.some(c=>c.relationId==="aim-correction:"+q.record.id)).toBe(false);
  });
  it("distinguishes beat-spanning motion from an unobserved post-press landing",()=>{
    const f=fixture(false,"terminal-pulse"),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1040)!,
      r=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace),ep=r.approaches.episodes[0];
    expect(boundedMovingOutside(e,ep,f.trace)).toBeUndefined();
    expect(boundedBeatOutside(e,ep,f.trace)).toBeDefined();
    expect(r.candidates.find(c=>c.code==="misaim")?.placementBasis).toBe("beat-spanning-outside");
  });
  it("does not promote a prebeat fragment even when every sample is live",()=>{
    const f=errorFixture("300,192,1000,1,0",[traceFrame(891,100),traceFrame(910,150,[0]),traceFrame(920,180),
      traceFrame(950,230),traceFrame(980,300),traceFrame(1010,360),traceFrame(1035,360,[1]),traceFrame(1060,360),traceFrame(1300,500)]),
      e=deriveCircleEvidence(f.trace,f.map,"0"),p=e.inputs.find(i=>i.record.timeMs===910)!,q=e.inputs.find(i=>i.record.timeMs===1035)!,
      result=comparePrimaryApproaches(e,f.map,{pressIds:[p.record.id,q.record.id],inputScopes:{[p.record.id]:{end:{timeMs:920,inclusive:true}}}},f.trace);
    expect(result.candidates.some(c=>c.code==="misaim"&&c.inputIds.includes(p.record.id))).toBe(false);
    expect(result.complete).toBe(false);
    const timing=result.ranking.selected[0];
    expect(timing.inputIds).toEqual([q.record.id]);
    expect(timing?.support?.correction?.kind).toBe("sampled-pass-tap");
    expect(Math.abs(timing!.support!.correction!.timeMs-1000)).toBeLessThanOrEqual(e.geometry!.hitWindows[0]);
    expect(result.approaches.episodes.find(ep=>ep.inputId===p.record.id)?.inputScope?.end?.timeMs).toBe(920);
  });
  it.each(["inside","crossing-chord","fresh-fence","same-time","frame-gap","token-gap","source-gap","history","mask","placement-end"])(
    "refuses a moving witness with %s",fault=>{
      const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"0"),q=original.inputs.find(i=>i.record.timeMs===1040)!,
        e=JSON.parse(JSON.stringify(original)) as typeof original,
        ep=JSON.parse(JSON.stringify(comparePrimaryApproaches(original,f.map,{pressIds:[q.record.id]},f.trace).approaches.episodes[0]));
      expect(boundedMovingOutside(e,ep)).toBeDefined();
      const p=e.inputs.find(i=>i.record.timeMs===1040)!,before=e.inputs.find(i=>i.record.timeMs===1020)!,after=e.inputs.find(i=>i.record.timeMs===1060)!;
      if(fault==="inside")before.inside=true;
      if(fault==="crossing-chord")before.record.position={x:600-p.record.position.x,y:384-p.record.position.y};
      if(fault==="fresh-fence"){before.record.actions=[1];before.record.freshActions=[1];}
      if(fault==="same-time")after.record.timeMs=p.record.timeMs;
      if(fault==="frame-gap"&&after.record.source.origin==="parsed")after.record.source.parsedFrameIndex+=1;
      if(fault==="token-gap"&&after.record.source.origin==="parsed")after.record.source.rawTokenIndex=999;
      if(fault==="source-gap"&&p.record.source.origin==="parsed")p.record.source.discontinuityBefore=["source-gap"];
      if(fault==="history")after.record.previousActions=[];
      if(fault==="mask")p.record.rawButtonMask=0;
      if(fault==="placement-end")ep.inputScope={placementEnd:{timeMs:1030,inclusive:true}};
      expect(boundedMovingOutside(e,ep)).toBeUndefined();
    });
});
