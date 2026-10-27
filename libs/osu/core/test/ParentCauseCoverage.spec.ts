import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { classifyParentCause } from "../src/gameplay/error-analysis/ParentCause";

describe("parent causes certify the actual contribution deadline", () => {
  it("keeps a single direction and separates directions after actual recovery",()=>{
    const frames=[traceFrame(800,100),traceFrame(1000,100,[0]),traceFrame(1100,500,[0]),traceFrame(1500,500,[0]),
      traceFrame(1550,500,[0]),traceFrame(1600,500,[0]),traceFrame(1900,500,[0]),traceFrame(1964,500,[0]),traceFrame(2000,500,[0]),traceFrame(2100,500,[0])];
    const evaluate=(f:ReturnType<typeof errorFixture>)=>{
      const a=buildErrorAnalysis(f.trace,f.map),p=a.inventory.atoms.find(x=>x.component==="slider-parent")!;
      return a.classifications.find(c=>c.atomId===p.id)!.mechanism;
    };
    expect(evaluate(errorFixture("100,192,1000,2,0,L|300:192,1,200",frames)).headline).toBe("Ran ahead");
    const recovered=errorFixture("100,192,1000,2,0,L|300:192,1,200",frames.map(q=>q.time===1550?{...q,position:{x:210,y:192}}:q.time>=1600?{...q,position:{x:0,y:192}}:q));
    const cause=evaluate(recovered);
    expect(cause.codes).toEqual(["ran-ahead","fell-behind"]);
    expect(cause.parentEvidence?.groups).toHaveLength(2);
    expect(cause.parentEvidence?.comparison.map(g=>g.contributionCount)).toEqual([1,1]);
  });
  it.each(["stable","lazer"] as const)("reconciles differing %s spatial contributions in one unrecovered lapse",profile=>{
    const mods=profile==="lazer"?[{acronym:"CL",settings:{classic_note_lock:true,no_slider_head_accuracy:true}}]:[];
    const f=errorFixture("100,192,1000,2,0,L|300:192,1,200",[
      traceFrame(800,100),traceFrame(1000,100,[0]),traceFrame(1100,500,[0]),traceFrame(1500,500,[0]),
      traceFrame(1550,500,[0]),traceFrame(1600,0,[0]),traceFrame(1900,0,[0]),traceFrame(1964,0,[0]),traceFrame(2000,0,[0]),traceFrame(2100,0,[0]),
    ],profile,[],mods);
    const analysis=buildErrorAnalysis(f.trace,f.map),parent=analysis.inventory.atoms.find(a=>a.component==="slider-parent")!;
    const linked=parent.relatedAtomIds.map(id=>analysis.classifications.find(c=>c.atomId===id)!.mechanism);
    expect(linked.map(m=>m.codes)).toEqual([["ran-ahead"],[profile==="stable"?"fell-behind":"off-track"]]);
    const cause=analysis.classifications.find(c=>c.atomId===parent.id)!.mechanism;
    expect(cause.headline).toBe("Off track");expect(cause.codes).toEqual(["off-track"]);
    expect(cause.parentEvidence?.groups).toHaveLength(1);
    expect(cause.parentEvidence?.groups[0].contributionIds).toHaveLength(2);
    expect(cause.parentEvidence?.comparison).toMatchObject([{contributionCount:2,selected:true}]);
  });
  it("certifies the pending head contribution when source ends at parent completion without inventing a head miss",()=>{
    const f=errorFixture("100,192,1000,2,0,L|110:192,1,10",[800,900,1000,1050].map(t=>traceFrame(t,500)));
    const analysis=buildErrorAnalysis(f.trace,f.map), parent=analysis.inventory.atoms.find(a=>a.component === "slider-parent")!;
    expect(parent.pendingContributionIds).toEqual(["0/HEAD"]);
    expect(analysis.inventory.atoms.some(a=>a.component === "slider-head")).toBe(false);
    expect(deriveCircleEvidence(f.trace,f.map,"0/HEAD").terminal).toBeUndefined();
    const cause=analysis.classifications.find(c=>c.atomId === parent.id)?.mechanism;
    expect(cause?.headline).toBe("No tap");
    expect(cause?.parentEvidence).toHaveProperty("pendingHeadContribution.componentId","0/HEAD");
    expect(cause?.parentEvidence?.contributions.map(c=>c.componentId)).not.toContain("0/HEAD");
    const before=errorFixture("100,192,1000,2,0,L|110:192,1,10",[800,900,1000,1040].map(t=>traceFrame(t,500)));
    expect(buildErrorAnalysis(before.trace,before.map).inventory.atoms.some(a=>a.component === "slider-parent")).toBe(false);
  });
  const short = () => errorFixture("100,192,1000,2,0,L|110:192,1,10", [
    traceFrame(800, 500), traceFrame(900, 500), traceFrame(1000, 500),
    traceFrame(1050, 500), traceFrame(1100, 100, [0]), traceFrame(1200, 500),
  ]);
  it("explains an unresolved short head only from its opportunity before parent completion", () => {
    const f = short(), analysis = buildErrorAnalysis(f.trace, f.map);
    const parent = analysis.inventory.atoms.find(a => a.component === "slider-parent")!;
    const head = deriveCircleEvidence(f.trace, f.map, "0/HEAD");
    expect(parent.result).toBe("MISS");
    expect(parent.pendingContributionIds).toEqual(["0/HEAD"]);
    expect(head.domains.liveSuccess.end).toMatchObject({ timeMs: 1050, eventId: parent.eventId, inclusive: false });
    expect(head.inputs.find(i => i.record.timeMs === 1100)?.inLiveSuccess).toBe(false);
    const classification = analysis.classifications.find(c => c.atomId === parent.id);
    expect(classification?.mechanism.status).toBe("supported");
    expect(classification?.mechanism.headline).toBe("No tap");
    // The pending evaluator identity and all component diagnoses remain intact.
    expect(analysis.inventory.atoms.find(a => a.id === parent.id)?.pendingContributionIds).toEqual(["0/HEAD"]);
    expect(parent.relatedAtomIds.every(id => analysis.classifications.some(c => c.atomId === id))).toBe(true);
  });

  it("does not absorb an independent release after actual tracking recovery into the missed head", () => {
    const f = errorFixture("100,192,1000,2,0,L|300:192,1,200", [
      traceFrame(800, 500), traceFrame(900, 300), traceFrame(950, 180), traceFrame(980, 170),
      traceFrame(990, 170, [0]), traceFrame(1010, 170, [0]), traceFrame(1100, 180, [0]),
      traceFrame(1300, 160, [0]), traceFrame(1400, 180), traceFrame(1500, 200),
      traceFrame(1600, 500), traceFrame(1964, 500), traceFrame(2100, 500),
    ]);
    const analysis = buildErrorAnalysis(f.trace, f.map);
    const parent = analysis.inventory.atoms.find(a => a.component === "slider-parent")!;
    expect(parent.result).toBe("MISS");
    const diagnosis = analysis.classifications.find(c => c.atomId === parent.id)?.mechanism;
    expect(diagnosis?.status).toBe("supported");
    // Release independently loses both tick and tail; the head's earlier placement
    // recovered at1300 and cannot explain those later losses.
    expect(diagnosis?.codes).toContain("released-early");
    expect(diagnosis?.codes).not.toEqual(["undershoot"]);
  });

  it.each(["0/HEAD", "0/TAIL"])("rejects an omitted failed contribution %s rather than certifying a subset", removed => {
    const f = short(), analysis = buildErrorAnalysis(f.trace,f.map);
    const parent = analysis.inventory.atoms.find(a => a.component === "slider-parent")!;
    const remove = analysis.inventory.atoms.find(a => removed.endsWith("HEAD") ? a.component === "slider-head" : a.component === "slider-legacy-tail")!;
    const diagnosis = classifyParentCause({...parent,relatedAtomIds:parent.relatedAtomIds.filter(id => id !== remove.id)},
      new Map(analysis.inventory.atoms.map(a=>[a.id,a])),new Map(analysis.classifications.map(c=>[c.atomId,c.mechanism])),
      f.trace,f.map,new Map(f.trace.records.map(r=>[r.id,r])),f.trace.records.filter((r): r is Extract<typeof r,{kind:"slider-tracking"}>=>r.kind === "slider-tracking"),new Set());
    expect(diagnosis.status).toBe("unavailable");
  });
});
