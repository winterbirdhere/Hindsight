import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

const points = [[850,80],[962,180],[974,205],[986,230],[998,253],[1010,280],[1020,300],[1030,350],[1038,380],[1050,420],[1200,650]];
function passage(shift=0, mirrored=false, sparse=false, correction?:number) {
  const frames=points.filter(([t])=>!sparse||![1010,1020].includes(t)).map(([t,x])=>{
    const time=mirrored?2000-t:t, shiftedX=sparse&&t===1030?300:x;
    return traceFrame(time,mirrored?600-shiftedX:shiftedX,correction!==undefined?
      time===correction?[0]:time===1038?[1]:[]:time===962?[0]:time===1038?[1]:[]);
  }).sort((a,b)=>a.time-b.time);
  return errorFixture(`300,192,${1000+shift},1,0`,frames);
}
describe("shared timing passage overlaps the best window",()=>{
  it.each([false,true])("retains a common complete pass away from the exact nominal instant (mirrored=%s)",mirrored=>{
    const f=passage(0,mirrored),e=deriveCircleEvidence(f.trace,f.map,"0"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    const comparison=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(e.terminal?.result).toBe("MISS");
    expect(comparison.approaches.episodes.every(ep=>ep.properPass?.deepSampled)).toBe(true);
    expect(comparison.ranking.selected.map(c=>c.code)).toEqual(["early-tap"]);
    expect(comparison.ranking.selected[0].inputIds).toEqual([ids[0]]);
    expect(comparison.ranking.selected[0].support?.correction?.kind).toBe("sampled-pass-tap");
    const corrected=passage(0,mirrored,false,mirrored?980:1010);
    expect(corrected.state.hitCircleVerdict["0"].type).toBe("GREAT");
  });
  it("retains an after-best repair as diagnostic without certifying correct tapping",()=>{
    const f=passage(0,false,true),e=deriveCircleEvidence(f.trace,f.map,"0"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    const c=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(c.approaches.episodes.every(ep=>ep.properPass!.entryTimeMs<1025)).toBe(true);
    expect(c.approaches.episodes.every(ep=>ep.properPass!.closestOffsetMs===30)).toBe(true);
    expect(c.ranking.selected.map(p=>p.code)).toEqual(["early-tap"]);
    expect(c.ranking.selected[0].observationOnly).toBe(true);
    expect(c.ranking.selected[0].support?.correction).toBeUndefined();
    expect(passage(0,false,true,1030).state.hitCircleVerdict["0"].type).toBe("OK");
  });
  it("does not invent an on-time passage when the cursor arrives outside the best window",()=>{
    const f=passage(-30),e=deriveCircleEvidence(f.trace,f.map,"0"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    const c=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(c.candidates.some(p=>p.code==="off-beat")).toBe(false);
  });
});

function anchoredSharedPass(rhythmChange=false) {
  const taps=[965,1065,1165,1265,1365,1435],knots=[[800,20],[965,100],[1065,200],[1165,300],[1265,400],[1365,440],[1385,470],[1400,500],[1410,530],[1435,560],[1600,700]];
  const times=[...new Set([...Array.from({length:161},(_,k)=>800+k*5),...knots.map(k=>k[0]),...taps,...taps.map(t=>t+2)])].sort((a,b)=>a-b);
  const frames=times.map(t=>{const at=knots.findIndex(k=>k[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at];
    return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),taps.flatMap((tap,k)=>t>=tap&&t<tap+2?[k%2]:[]));});
  return errorFixture(Array.from({length:5},(_,k)=>`${100+k*100},192,${rhythmChange&&k===2?1160:1000+k*100},1,0`).join("\n"),frames);
}
describe("shared passage preserves causal cadence roles",()=>{
  it("does not erase the established cadence when appending its aggregate passage candidate",()=>{
    const f=anchoredSharedPass(),e=deriveCircleEvidence(f.trace,f.map,"4"),r=classifyCircleLoss(e,f.map,f.trace);
    expect([0,1,2,3].map(k=>f.state.hitCircleVerdict[String(k)].type)).toEqual(["OK","OK","OK","OK"]);
    expect(f.state.hitCircleVerdict["4"].type).toBe("MISS");
    expect(r.headline).toBe("Early tap");
    expect(r.diagnostics?.primary?.ranking?.selected[0].support?.context?.role).toBe("cadence-continuation");
  });
  it("retains shared timing uncertainty when a genuine rhythm change invalidates the old cadence",()=>{
    const f=anchoredSharedPass(true),e=deriveCircleEvidence(f.trace,f.map,"4"),r=classifyCircleLoss(e,f.map,f.trace);
    expect(r.headline).toBe("Early tap");
    expect(r.diagnostics?.primary?.ranking?.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
    expect(r.diagnostics?.primary?.ranking?.selected[0].support?.context).toBeUndefined();
    expect(r.diagnostics?.primary?.ranking?.selected[0].roleEvidence?.context).toBeUndefined();
  });
});
