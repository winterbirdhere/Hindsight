import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { CircleEvidence, deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { comparePrimaryApproaches, comparePrimaryInputHypotheses } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import * as association from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function source(profile:"stable"|"lazer") {
  const f=errorFixture("300,192,1000,1,0",[traceFrame(700,100),traceFrame(1000,200,[0]),traceFrame(1300,500)],profile);
  const points=[[-146,3.386462,-1.699718],[-139,3.010188,-1.777568],[-121,2.244667,-1.855418],[-111,1.894343,-1.868393],[-105,1.582943,-1.855418],[-89,1.128822,-1.777568],[-75,.830395,-1.647818],[-71,.830395,-1.647818],[-54,.596846,-1.401295],[-43,.389248,-.960146],[-38,.389248,-.960146],[-21,.272473,-.402224],[-6,.259499,.142725],[11,.3114,.583873],[29,.518999,1.012047],[44,.596846,1.089895],[46,.674697,1.141795],[61,.908246,1.219646],[78,1.323444,1.31047],[96,1.933267,1.531043],[109,2.646891,1.907317]];
  const actions=(k:number)=>k<6?[1]:k<9?[0,1]:k<16?[0]:k===16?[]:[1];
  const original=deriveCircleEvidence(f.trace,f.map,"0"),e:CircleEvidence={...original,
    geometry:{position:{x:0,y:0},radius:1,profile,hitWindows:[23,65,107,399]},
    target:{hitTimeMs:1000,spawnTimeMs:500},terminal:{...original.terminal!,timeMs:1110,sequence:999},
    domains:{nominalSuccess:{state:"nonempty",start:{timeMs:893,inclusive:true},end:{timeMs:1107,inclusive:true}},
      liveSuccess:{state:"nonempty",start:{timeMs:893,inclusive:true},end:{timeMs:1107,inclusive:true}},
      interaction:{state:"nonempty",start:{timeMs:500,inclusive:true},end:{timeMs:1110,sequence:999,inclusive:false}}},
    attempts:[],routing:[],directRejections:[],insideIntervals:[],terminalReferences:[],limitations:[],
    dependencies:{input:{status:"complete",reasons:[]},geometry:{status:"complete",reasons:[]},routing:{status:"complete",reasons:[]},lifecycle:{status:"complete",reasons:[]}},
    inputs:points.map(([time,x,y],k)=>({record:{...original.inputs[0].record,id:"p"+k,sequence:k+1,timeMs:1000+time,position:{x,y},actions:actions(k),
      previousActions:k?actions(k-1):[1],freshActions:k===6?[0]:k===17?[1]:[],source:{origin:"parsed",parsedFrameIndex:k}},
      inside:x*x+y*y<=1,freshActionsKnown:true,inLiveSuccess:true,inInteraction:true,pathGroup:0,postTerminal:false})),
  };
  return {...f,e};
}
describe("independent geometry for each ordinary input allocation",()=>{
  afterEach(()=>jest.restoreAllMocks());
  it.each(["stable","lazer"] as const)("keeps excluded %s edges as context rather than importing their correction",profile=>{
    const f=source(profile),before=JSON.stringify(f.e),all=comparePrimaryApproaches(f.e,f.map,{pressIds:["p6","p17"]}),
      early=comparePrimaryApproaches(f.e,f.map,{pressIds:["p6"],contextBoundaryInputIds:["p17"]}),
      late=comparePrimaryApproaches(f.e,f.map,{pressIds:["p17"],contextBoundaryInputIds:["p6"]});
    expect([all.complete,early.complete,late.complete]).toEqual([true,true,true]);
    expect(all.candidates.map(c=>c.code)).toEqual(["early-tap","late-tap","aim-late","left-early"]);
    expect(early.ranking.selected.map(c=>c.code)).toEqual(["early-tap"]);
    expect(late.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(late.approaches.episodes[0].spatialCandidates[0].radialR).toBeCloseTo(1.32623977,7);
    jest.spyOn(association,"derivePrimaryInputEvidence").mockReturnValue({policyVersion:"test",relevantInputIds:[],contextInputIds:[],limitations:[],
      associations:["p6","p17"].map(inputId=>({inputId,role:"ambiguous",reasons:["unresolved-stream-surplus"],eventIds:[inputId]}))});
    const r=classifyCircleLoss(f.e,f.map),ranking=r.diagnostics?.primary?.ranking as unknown as {hypotheses:Array<{inputIds:string[];primaryCodes:string[]}>};
    expect(r.headline).toBe("Late tap");
    expect(r.diagnostics?.primary?.ranking?.selected[0].inputIds).toEqual(["p17"]);
    expect(ranking.hypotheses.find(h=>h.inputIds.includes("p17"))!.primaryCodes).toEqual(late.ranking.selected.map(c=>c.code));
    expect(JSON.stringify(f.e)).toBe(before);
  });
  it("preserves ordinary all-input comparison without optional ownership",()=>{
    const f=source("stable"),r=comparePrimaryInputHypotheses(f.e,f.map,{pressIds:["p6","p17"]},["p6","p17"],[]),ordinary=comparePrimaryApproaches(f.e,f.map,{pressIds:["p6","p17"]});
    expect(r.complete).toBe(true);expect(r.hypotheses.map(h=>h.inputIds)).toEqual([["p6","p17"]]);
    expect(r.ranking.selected.map(({hypothesisIds,...c})=>c)).toEqual(ordinary.ranking.selected);
  });
  it("preserves mandatory-only plus one optional allocations and source order",()=>{
    const f=source("stable"),r=comparePrimaryInputHypotheses(f.e,f.map,{pressIds:["p17","p6"]},["p17"],["p6"]);
    expect(r.hypotheses.map(h=>h.inputIds)).toEqual([["p17"],["p6","p17"]]);
    expect(r.hypotheses[0].contextInputIds).toContain("p6");
    expect(r.hypotheses[0].approachVariantIds.map(k=>r.approachVariants[k].spatialCandidates.map(c=>c.code))).toEqual([["misaim"]]);
    expect(r.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(r.ranking.selected[0].inputIds).toEqual(["p17"]);
  });
  it.each(["unknown-input","duplicate-request","unknown-action","resource"])("retains explicit unavailable %s allocations",fault=>{
    const f=source("stable");
    if(fault==="unknown-action")f.e.inputs[17].freshActionsKnown=false;
    const ids=fault==="unknown-input"?["p6","missing"]:fault==="duplicate-request"?["p6","p6","p17"]:["p6","p17"];
    const r=comparePrimaryInputHypotheses(f.e,f.map,{pressIds:ids,inputScopes:fault==="resource"?{p6:{eventIds:["x".repeat(4*1024*1024)]}}:undefined},["p6"],fault==="unknown-input"?["missing"]:["p17"]);
    expect(r.complete).toBe(false);expect(r.ranking.selected).toEqual([]);
    if(fault==="resource"){expect(r.resources.limited).toBe(true);expect(r.reason).toBe("primary-allocation-resource-limit");expect(r.resources.variantBytes).toBeLessThanOrEqual(r.resources.maximumVariantBytes);}
  });
});
