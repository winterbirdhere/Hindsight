import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

// Recorded contact shape relative to the beat; no replay identity reaches production.
function fixture(internalJump = false, variant = "") {
  const knots = [[869,110,128.3333],[869,110,128],[881,112.6667,126],[898,115,125.3333],
    [913,116,127.6667],[930,118.6667,137.6667],[947,122,153],[965,128,175.6667],
    [977,133.6667,193]];
  if (internalJump) knots.splice(7,0,[947,124,155]);
  if (variant === "duplicate") knots.splice(3,0,[881,112.6667,126]);
  if (variant === "exit-jump") knots.splice(knots.length-1,0,[965,133.6667,193]);
  const frames = [traceFrame(0,0),...knots.map(([t,x,y])=>({
    ...traceFrame(t,x,t===977?[0]:[]),position:{x,y},
  })),traceFrame(1300,400)];
  const f = errorFixture("120,151,1000,1,0",frames);
  const e = deriveCircleEvidence(f.trace,f.map,"0");
  const press = e.inputs.find(i=>i.record.timeMs===977&&i.record.freshActions.length)!;
  return {f,e,press,context:{pressIds:[press.record.id]}};
}

describe("source-scoped exit after an earlier ordered position update",()=>{
  it("retains the refused witness and certifies the independent positive-time exit",()=>{
    const {f,e,press,context}=fixture();
    const result=comparePrimaryApproaches(e,f.map,context,f.trace);
    expect(result.candidates.some(c=>c.recordedFailure==="recorded-leading-position-discontinuity")).toBe(true);
    expect(result.ranking.selected.map(c=>c.headline)).toEqual(["Early exit"]);
    expect(result.ranking.selected[0].support).toBeDefined();
    expect(result.ranking.selected[0].inputIds).toEqual([press.record.id]);
    expect(result.approaches.episodes[0].limitations).toContain("ordered-zero-time-position-change");
  });
  it("does not scope past an internal zero-time position change",()=>{
    const {f,e,context}=fixture(true);
    const result=comparePrimaryApproaches(e,f.map,context,f.trace);
    expect(result.ranking.selected).toEqual([]);
  });
  it("does not turn an ordered jump into an exit",()=>{
    const {f,e,press,context}=fixture(false,"exit-jump");
    expect(press.inside).toBe(false);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    const result=comparePrimaryApproaches(e,f.map,context,f.trace);
    expect(result.ranking.selected).toEqual([]);
    expect(result.approaches.episodes.some(e=>e.sourceScopedArrivals?.length)).toBe(false);
  });
  it("allows identical ordered points while retaining a censored entry",()=>{
    const {f,e,context}=fixture(false,"duplicate");
    const result=comparePrimaryApproaches(e,f.map,context,f.trace);
    expect(result.ranking.selected.map(c=>c.headline)).toEqual(["Early exit"]);
    expect(result.approaches.episodes[0].sourceScopedArrivals?.[0].properPass?.leftCensored).toBe(true);
  });
  it.each(["context", "scoped-end"])("retains the caller's %s boundary",kind=>{
    const {f,e,press,context}=fixture();
    const seed=e.inputs.find(i=>i.record.timeMs===881)!;
    const result=comparePrimaryApproaches(e,f.map,{...context,
      ...(kind==="context"?{contextBoundaryInputIds:[seed.record.id]}:
        {inputScopes:{[press.record.id]:{end:{timeMs:960,inclusive:true}}}})},f.trace);
    expect(result.approaches.episodes.some(e=>e.sourceScopedArrivals?.length)).toBe(false);
  });
  it.each(["source-gap","frame-gap","raw-gap","history","mask","end-fence","seed-backwards"])(
    "preserves %s rejection in the new exit witness",fault=>{
      const {f,context}=fixture(),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
      const seed=trace.records.find(r=>r.kind==="input"&&r.timeMs===881);
      if(seed?.kind!=="input"||seed.source.origin!=="parsed")throw Error("seed");
      if(fault==="source-gap")seed.source.discontinuityBefore=["source-gap"];
      if(fault==="frame-gap")seed.source.parsedFrameIndex++;
      if(fault==="raw-gap")seed.source.rawTokenIndex=100;
      if(fault==="history")seed.previousActions=[1];
      if(fault==="mask")seed.rawButtonMask=1;
      if(fault==="seed-backwards")seed.timeMs=868;
      const e=deriveCircleEvidence(trace,f.map,"0");
      const result=comparePrimaryApproaches(e,f.map,{...context,
        ...(fault==="end-fence"?{end:{timeMs:960,inclusive:true}}:{})},trace);
      expect(result.ranking.selected).toEqual([]);
      expect(result.approaches.episodes.some(e=>e.sourceScopedArrivals?.length)).toBe(false);
    });
});
