import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { rankSupportedPrimaryCandidates } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { annotateInitialAimOpportunity } from "../src/gameplay/error-analysis/PrimaryAimOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture() {
  const points:[number,number,number,number[]][]=[
    [850,260,245,[]],[900,280,245,[1]],[948,293.7778,238.2222,[0,1]],
    [954,300,232,[1]],[964,311.1111,222.2222,[1]],[982,343.1111,195.1111,[1]],
    [998,380.4445,159.5556,[1]],[1009,412,125.3333,[0,1]],[1016,412,125.3333,[0,1]],
    [1031,436.4445,96,[0,1]],[1041,455.1111,75.11111,[0,1]],[1048,455.1111,75.11111,[0,1]],
    [1057,466.2222,65.33334,[0]],[1065,468.4445,63.55556,[0]],
    [1083,469.7778,62.66667,[0]],[1088,469.7778,62.66667,[0]],
    [1098,470.2222,66.66666,[0,1]],[1101,470.2222,66.66666,[0,1]],
    [1120,480,80,[]],[1250,550,120,[]]],scale=36.49495315551758/32.013118743896484;
  const f=errorFixture("300,192,1000,1,0",points.map(([t,x,y,actions])=>({
    ...traceFrame(t,0,actions),position:{x:300+(x-469)*scale,y:192+(y-30)*scale}})));
  const e=deriveCircleEvidence(f.trace,f.map,"0"),pressIds=e.inputs.filter(i=>[1009,1098].includes(i.record.timeMs)).map(i=>i.record.id);
  return {...f,e,pressIds};
}
const compare=(f:ReturnType<typeof fixture>)=>comparePrimaryApproaches(f.e,f.map,{pressIds:f.pressIds,
  contextBoundaryInputIds:f.e.inputs.filter(i=>i.record.freshActions.length&&!f.pressIds.includes(i.record.id)).map(i=>i.record.id)},f.trace);

describe("initial usable aim opportunity in one continuous outside approach",()=>{
  it("prefers the recorded best-window placement over a comparable later subtype from the same approach",()=>{
    const f=fixture(),r=compare(f);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(r.candidates.map(c=>c.code)).toEqual(expect.arrayContaining(["misaim","undershoot"]));
    expect(r.ranking.selected.map(c=>c.code)).toEqual(["misaim"]);
    expect(rankSupportedPrimaryCandidates(r.candidates,f.pressIds).selected.map(c=>c.code)).toEqual(["misaim"]);
    expect(r.candidates.find(c=>c.code==="misaim")?.roleEvidence).toMatchObject({aimOpportunity:{role:"initial-best-window"}});
    expect(r.candidates.find(c=>c.code==="misaim")?.strength).toBeCloseTo(1.0207044);
    expect(r.approaches.episodes[0].boundedOutsideLobe).toBeDefined();
    expect(r.candidates.find(c=>c.code==="misaim")?.support?.correction?.timeMs).toBe(1009);
    expect(r.candidates.find(c=>c.code==="undershoot")?.support?.correction).toBeUndefined();
    const numerical=r.candidates.map(c=>({...c,roleEvidence:{...c.roleEvidence,aimOpportunity:undefined},support:c.support?{...c.support,aimOpportunity:undefined}:undefined}));
    expect(rankSupportedPrimaryCandidates(numerical,f.pressIds).selected.map(c=>c.code)).toEqual(["misaim"]);
    expect(rankSupportedPrimaryCandidates(numerical,f.pressIds).attribution?.roles.rule).toBe("nearest-recorded-opportunity");
  });
  it.each(["independent","phase","third-candidate","outside-best",
    "later-within-best","disjoint-witness","pooled-geometry","missing-lobe","lobe-union","intervening-pulse","receiver","source-gap","path-gap","sample-contact","chord-contact","not-near-tie"])(
    "does not carry a narrower preference into %s evidence",fault=>{
      const f=fixture(),r=compare(f);f.e=JSON.parse(JSON.stringify(f.e));
      const first=r.candidates.find(c=>c.code==="misaim")!,last=r.candidates.find(c=>c.code==="undershoot")!,
        p=f.e.inputs.find(i=>i.record.id===first.inputIds[0])!,q=f.e.inputs.find(i=>i.record.id===last.inputIds[0])!,
        middle=f.e.inputs.find(i=>i.record.timeMs===1041)!;
      expect(first.roleEvidence?.aimOpportunity).toBeDefined();
      if(fault==="independent")last.independent=true;
      if(fault==="phase")last.roleEvidence={...last.roleEvidence,context:{role:"cadence-continuation",phaseMs:0,residualMs:0,eventIds:[]}};
      if(fault==="third-candidate")r.candidates.push({...last,family:"timing",code:"late-tap",independent:true,support:{...last.support!}});
      if(fault==="outside-best")f.e.target!.hitTimeMs-=40;
      if(fault==="later-within-best")f.e.geometry!.hitWindows[0]=100;
      if(fault==="disjoint-witness")r.approaches.episodes[1].spatialCandidates[0].eventIds.push("another-lobe");
      if(fault==="pooled-geometry")r.candidates.push({...last,eventIds:[f.e.inputs[0].record.id],support:{...last.support!}});
      if(fault==="missing-lobe")delete r.approaches.episodes[0].boundedOutsideLobe;
      if(fault==="lobe-union"){
        const lobe=r.approaches.episodes[0].lobeAlternatives![0],ids=lobe.eventIds;
        r.approaches.episodes[0].lobeAlternatives=[{...lobe,eventIds:ids.slice(0,6)},{...lobe,eventIds:ids.slice(5)}];
      }
      if(fault==="intervening-pulse")middle.record.freshActions=[1];
      if(fault==="receiver"){
        const attempt=f.e.attempts.find(a=>a.inputId===q.record.id)!,selection=f.e.routing.find(s=>s.kind==="selection"&&s.attemptId===attempt.id)!;
        if(selection.kind!=="selection")throw Error("fixture");selection.componentId="other";
      }
      if(fault==="source-gap")middle.record.source={origin:"synthetic",reason:"fixture-gap"};
      if(fault==="path-gap")middle.pathGroup=p.pathGroup+1;
      if(fault==="sample-contact")middle.inside=true;
      if(fault==="chord-contact"){
        const previous=f.e.inputs[f.e.inputs.indexOf(middle)-1].record.position;
        middle.record.position={x:600-previous.x,y:384-previous.y};
      }
      if(fault==="not-near-tie")last.strength=4;
      annotateInitialAimOpportunity(f.e,r.approaches,r.candidates);
      expect(r.candidates.every(c=>!c.roleEvidence?.aimOpportunity)).toBe(fault!=="not-near-tie");
      expect(r.candidates).toEqual(expect.arrayContaining([first,last]));
    });
  it("keeps recorded roles when all correction certificates are removed",()=>{
    const f=fixture(),r=compare(f);
    for(const c of r.candidates)c.support=undefined;
    annotateInitialAimOpportunity(f.e,r.approaches,r.candidates);
    expect(r.candidates.find(c=>c.code==="misaim")?.roleEvidence?.aimOpportunity?.role).toBe("initial-best-window");
  });
  it.each(["prefix","kind"])("keeps recorded roles independent of a correction %s mutation",field=>{
    const f=fixture(),r=compare(f),first=r.candidates.find(c=>c.code==="misaim")!;
    if(field==="prefix")first.support!.correction!.prefix={parentCount:999};
    else first.support!.correction!.kind="sampled-pass-tap";
    annotateInitialAimOpportunity(f.e,r.approaches,r.candidates);
    expect(first.roleEvidence?.aimOpportunity?.role).toBe("initial-best-window");
  });
});
