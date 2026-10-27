import { PrimaryCandidate, rankPrimaryCandidates, rankPrimaryHypotheses } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function candidates():PrimaryCandidate[]{
  const observation={targetId:"target",boundary:"entry" as const,boundaryTimeMs:1057,entryTimeMs:1057,exitTimeMs:1095,eventIds:["a","b","c"],sampledEventIds:["b"]};
  return [{code:"early-tap",headline:"Early tap",family:"timing",strength:2.5652173913,independent:false,relationId:"tap:r0",inputIds:["r0"],eventIds:["r0"]},
    ...["r0","r1"].map(inputId=>Object.assign({code:"aim-late",headline:"Late entry",family:"arrival" as const,strength:2.4820681246,
      independent:false,relationId:"tap:"+inputId,inputIds:[inputId],eventIds:[inputId,"a","b","c"]},{arrivalObservation:{...observation}}))];
}
describe("shared arrival observations",()=>{
  it("does not multiply a single entry observation by the number of nearby presses",()=>{
    const c=candidates(),before=JSON.stringify(c),r=rankPrimaryCandidates(c,["r0","r1"]);
    expect(r.selected).toEqual([]); // Boundary observations alone do not certify a channel.
    expect(r.scores).toEqual([]); expect(r.candidates).toEqual(c);
    expect(JSON.stringify(c)).toBe(before);expect(r.candidates[1].strength).toBe(2.4820681246);
  });
  it("is invariant to witness order and duplicate copies on one input",()=>{
    const c=candidates(),r=rankPrimaryCandidates(c,["r0","r1"]);
    expect(rankPrimaryCandidates([c[2],c[0],c[1],c[1]],["r0","r1"]).selected).toEqual(r.selected);
  });
  it.each(["eventIds","sampledEventIds","targetId","boundary","boundaryTimeMs","entryTimeMs","exitTimeMs"])("keeps distinct %s observations independent",key=>{
    const c=candidates(),o=(c[2] as PrimaryCandidate&{arrivalObservation:Record<string,unknown>}).arrivalObservation;
    o[key]=Array.isArray(o[key])?["other"]:typeof o[key]==="number"?Number(o[key])+1:"other";
    expect(rankPrimaryCandidates(c,["r0","r1"]).selected).toEqual([]); expect(rankPrimaryCandidates(c).candidates).toEqual(c);
  });
  it("retains a stronger single arrival observation",()=>{
    const c=candidates();c[0].strength=3.347826087;c[1].strength=c[2].strength=3.516619700;
    expect(rankPrimaryCandidates(c,["r0","r1"]).selected).toEqual([]); expect(rankPrimaryCandidates(c).candidates).toEqual(c);
  });
  it("does not divide an already aggregated hypothesis score twice",()=>{
    const c=candidates();c[0]={...c[0],code:"late-tap",headline:"Late tap",strength:.8947368,inputIds:["r0","r1"]};
    c[1].strength=c[2].strength=3.224159;
    const result=rankPrimaryHypotheses(c,["r0"],["r1"]);
    expect(result.selected).toEqual([]); expect(result.candidates[1].strength).toBe(3.224159);
  });
  it("counts the same uncensored exit once across different left-censored views",()=>{
    const object="300,192,1000,1,0",r=stableGameplayRadius((errorFixture(object,[traceFrame(1400)]).map.hitObjects[0] as HitCircle).radius),
      f=errorFixture(object,[[700,0],[800,0],[880,0],[895,.5],[910,1.4],[950,3],[980,3.5],[1000,4],[1040,6],[1080,5.5],[1100,5.2],[1105,5],[1400,8]]
        .map(([t,x])=>traceFrame(t,300+x*r,t===980||t===1000?[0]:t===1100||t===1105?[1]:[]))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),pressIds=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id),
      c=comparePrimaryApproaches(e,f.map,{pressIds},f.trace),exits=c.candidates.filter(w=>w.code==="left-early");
    expect(exits).toHaveLength(2);expect(exits.filter(w=>!!w.support)).toHaveLength(1);
    expect(exits[0].arrivalObservation?.entryTimeMs).not.toEqual(exits[1].arrivalObservation?.entryTimeMs);
    expect(exits[0].arrivalObservation?.boundaryTimeMs).toEqual(exits[1].arrivalObservation?.boundaryTimeMs);
    expect(c.ranking.selected.map(w=>w.code)).toEqual(["left-early"]);
    expect(c.ranking.attribution?.presses.every(p=>!p.tapFeasible&&p.aimFeasible)).toBe(true);
  });
  it("keeps full passage views as diagnostics while sharing an exact boundary bracket",()=>{
    const c=candidates();c[1].arrivalObservation!.boundaryEventIds=["a","b"];c[2].arrivalObservation={
      ...c[2].arrivalObservation!,boundaryEventIds:["a","b"],exitTimeMs:1100,eventIds:["a","b","later"],sampledEventIds:["different"]};
    expect(rankPrimaryCandidates(c,["r0","r1"]).selected).toEqual([]); expect(rankPrimaryCandidates(c).candidates).toEqual(c);
  });
  it.each(["pair","targetId","boundary","boundaryTimeMs"])("does not consolidate a different %s",key=>{
    const c=candidates();c[1].arrivalObservation!.boundaryEventIds=["a","b"];c[2].arrivalObservation!.boundaryEventIds=["a","b"];
    const o=c[2].arrivalObservation!;
    if(key==="pair")o.boundaryEventIds=["other","b"];
    if(key==="targetId")o.targetId="other";
    if(key==="boundary")o.boundary="exit";
    if(key==="boundaryTimeMs")o.boundaryTimeMs++;
    expect(rankPrimaryCandidates(c,["r0","r1"]).selected).toEqual([]); expect(rankPrimaryCandidates(c).candidates).toEqual(c);
  });
});
