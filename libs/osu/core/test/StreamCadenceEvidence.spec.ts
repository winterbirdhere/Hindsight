import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { CircleEvidence, deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { deriveTargetCadence } from "../src/gameplay/error-analysis/StreamCadenceEvidence";
import { OsuClassicMod } from "../src/mods/Mods";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { compareTargetCadence } from "../src/gameplay/error-analysis/PrimaryCadenceComparison";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { InitiatingChain } from "../src/gameplay/error-analysis/InterceptionChain";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

type Profile="stable"|"classic"|"native";
function fixture(profile:Profile="stable",fault="",time=0,x=0,mods:OsuClassicMod[]=[]) {
  const times=[700,800,900,1000,1050,1100,1150,1200,1250,1450];
  if(fault==="same-pace")times.splice(0,times.length,450,550,650,750,850,950,1050,1150,1250,1450);
  if(fault==="double")times[7]=times[6];
  if(fault==="recovered")times.splice(0,times.length,500,550,600,650,700,750,800,850,900,950);
  let taps=[700,800,900,1000,1100,1200,1300];
  if(fault==="on-pace"||fault==="stationary-onpace"||fault==="one-skip")taps=times.slice(0,9).filter(t=>fault!=="one-skip"||t!==1100);
  if(fault==="extra")taps=[...taps,1055].sort((a,b)=>a-b);
  if(fault==="onbeat")taps=[...taps,1250].sort((a,b)=>a-b);
  if(fault==="recovered")taps=[500,580,660,740,750,800,850,970];
  if(fault==="early-train")taps=[700,800,900,980,1080,1180,1280];
  const frames=Array.from({length:271},(_,k)=>{
    const t=400+k*5,at=times.findIndex(a=>a>=t),right=at<0?times.length-1:at,left=Math.max(0,right-1);
    const position=times[right]===times[left]?100+25*right:100+25*(left+(t-times[left])/(times[right]-times[left]));
    const tap=taps.findIndex(p=>t>=p&&t<p+10),actions=tap<0?[]:[tap%2];
    if(fault==="held-alternation"&&t>=900){actions.splice(0,actions.length,0);if(tap>=3)actions.push(1);}
    const f=traceFrame(t+time,(fault==="co-located"?300:fault.startsWith("stationary")?275:fault==="no-progress"&&t>=1000?175:position)+x,actions);
    return f;
  });
  if(fault==="zero-context"||fault==="zero-opportunity"){
    const at=fault==="zero-context"?1010:1250,k=frames.findIndex(f=>f.time===at+time);
    frames.splice(k+1,0,{...frames[k],position:{x:fault==="zero-context"?176+x:350+x,y:192}});
  }
  if(fault==="zero-press"){
    const k=frames.findIndex(f=>f.time===1200+time);
    frames.splice(k,0,{...frames[k],actions:[],position:{x:frames[k].position.x-.5,y:192}});
  }
  const f=errorFixture(times.map((t,k)=>`${(fault==="co-located"?300:100+25*k)+x},192,${t+time},1,0`).join("\n"),frames,
    profile==="stable"?"stable":"lazer",mods,profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
  return {...f,frames,times,taps,target:"8"};
}
function cause(f:ReturnType<typeof fixture>,trace=f.trace) {
  return classifyCircleLoss(deriveCircleEvidence(trace,f.map,f.target),f.map,trace);
}
function comparisonEvidence(original:CircleEvidence,points:number[][],presses:readonly number[]):CircleEvidence {
  return {...original,targetId:"target",target:{hitTimeMs:1000,spawnTimeMs:500},
    geometry:{position:{x:0,y:0},radius:1,profile:"stable",hitWindows:[19,59,99,399]},
    domains:{nominalSuccess:{state:"nonempty"},liveSuccess:{state:"nonempty"},interaction:{state:"nonempty",start:{timeMs:500,inclusive:true},end:{timeMs:1100,sequence:999,inclusive:false}}},
    inputs:points.map(([t,x,y],k)=>({record:{...original.inputs[0].record,id:"p"+k,sequence:k+1,timeMs:1000+t,position:{x,y},
      actions:presses.includes(k)?[presses.indexOf(k)%2]:[],freshActions:presses.includes(k)?[presses.indexOf(k)%2]:[],
      previousActions:presses.includes(k-1)?[presses.indexOf(k-1)%2]:[],source:{origin:"parsed",parsedFrameIndex:k}},
      inside:x*x+y*y<=1,freshActionsKnown:true,inInteraction:true,inLiveSuccess:true,pathGroup:0,postTerminal:false})),
    attempts:[],routing:[],directRejections:[],insideIntervals:[],terminalReferences:[],terminal:{...original.terminal!,id:"terminal",sequence:999,timeMs:1100},limitations:[]};
}
describe("target-bound sustained slow cadence",()=>{
  it("admits established cadence while retaining a candidate-free conditional allocation",()=>{
    const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
    const points=[[-130,-3,0],[-100,-2,0],[-70,-1.1,0],[-40,-.4,0],[-25,.3,0],[25,1.1,0],[55,2,0],[80,3,0]];
    const e=comparisonEvidence(original,points,[4,5]);
    expect(comparePrimaryApproaches(e,f.map,{pressIds:["p4","p5"]}).complete).toBe(true);
    const conditional=comparePrimaryApproaches(e,f.map,{pressIds:["p5"],contextBoundaryInputIds:["p4"]});
    expect(conditional.complete).toBe(false);expect(conditional.candidates).toEqual([]);
    expect(conditional.approaches.episodes[0]).toMatchObject({status:"supported",placement:"unproven",limitations:["no-positive-local-placement"]});
    // Comparator contract: collective cadence comes from the separately
    // simulated fixture, not from these synthetic approach coordinates.
    const contract={...cadence,binding:{...cadence.binding,rawLiveInputIds:["p4","p5"]}};
    const association={...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:[],stream:undefined};
    const r=compareTargetCadence(e,f.map,association,contract);
    expect(r.hypotheses).toHaveLength(4);expect(r.complete).toBe(false);
    expect(r.hypotheses.find(h=>h.inputIds.join()==="p5")!.complete).toBe(false);
    expect(r.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
    expect(r.reason).toBe("observed-target-cadence");
  });
  it.each((["stable","classic","native"] as const).flatMap(profile=>[[0,0],[3210,40]].map(([time,x])=>[profile,time,x] as const)))(
    "recognizes actual slow %s tapping at %s/%s without claiming a missing slot",(profile,time,x)=>{
      const f=fixture(profile,"",time,x),e=deriveCircleEvidence(f.trace,f.map,"8");
      expect(e.terminal?.result).toBe("MISS");expect(e.terminal?.mechanism).toBe("automatic-expiry");
      expect(e.directRejections).toEqual([]);
      expect(f.taps.slice(3).slice(1).map((v,k)=>v-f.taps[k+3])).toEqual([100,100,100]);
      expect(e.inputs.filter(i=>Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]&&i.record.freshActions.length)).toEqual([]);
      expect(e.inputs.filter(i=>Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]).every(i=>i.inside)).toBe(true);
      const before=JSON.stringify(f.trace),diagnosis=cause(f);
      expect(diagnosis.headline).toBe("Slow taps");expect(diagnosis.codes).toEqual(["slow-tapping"]);
      expect(JSON.stringify(f.trace)).toBe(before);
    },
  );
  it.each(["stable","classic","native"] as const)("preserves a fresh second action while one action stays held in %s",profile=>{
    const f=fixture(profile,"held-alternation");
    expect(f.trace.records.filter(r=>r.kind==="input"&&r.timeMs>=1000&&r.freshActions.length).map(r=>r.kind==="input"?r.freshActions:[])).toEqual([[1],[1],[1],[1]]);
    expect(cause(f).headline).toBe("Slow taps");
  });
  it.each(["stable","classic","native"] as const)("retains a complete %s slow train starting within the first best window",profile=>{
    const f=fixture(profile,"early-train"),e=deriveCircleEvidence(f.trace,f.map,"8");
    expect(deriveTargetCadence(e,f.map,f.trace)).toBeDefined();expect(cause(f).headline).toBe("Slow taps");
  });
  it.each(["stable","classic","native"] as const)("does not let stationary containment alone hide an independent %s flow failure",profile=>{
    const slow=fixture(profile,"stationary-inside"),onpace=fixture(profile,"stationary-onpace"),following=fixture(profile,"on-pace");
    expect(slow.state.hitCircleVerdict["8"].type).toBe(profile==="native"?"OK":"MISS");expect(onpace.state.hitCircleVerdict["8"].type).toBe(profile==="native"?"OK":"MISS");
    expect(following.state.hitCircleVerdict["8"].type).toBe("GREAT");
    const e=deriveCircleEvidence(slow.trace,slow.map,"8");
    expect(e.inputs.filter(i=>Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]).every(i=>i.inside)).toBe(true);
    expect(cause(slow).codes).not.toContain("slow-tapping");
  });
  it.each(["stable","classic","native"] as const)("retains zero-movement %s co-located rhythm demand",profile=>{
    const f=fixture(profile,"co-located");expect(f.state.hitCircleVerdict["8"].type).toBe("MISS");
    expect(cause(f).headline).toBe("Slow taps");
  });
  it("preserves two already verified independent chain causes when both outrank cadence",()=>{
    // Comparator contract only: the separately proved chain is an input here,
    // not a claim that these invented contender scores are a dispatch witness.
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(e,f.map,f.trace)!,input=e.inputs.find(i=>i.record.timeMs===1200)!.record;
    const chain:InitiatingChain={rootComponentId:"root",rootInputId:input.id,rootComparison:comparePrimaryApproaches(e,f.map,{pressIds:[input.id]}),
      causes:[decidedCandidate("misaim",input.id),decidedCandidate("early-tap",input.id)],
      componentIds:["root","8"],eventIds:[input.id],links:[],additionalInputIds:[],additionalInputEvidence:[],basis:"bounded-cadence-and-model-dispatch"};
    const comparison=compareTargetCadence(e,f.map,derivePrimaryInputEvidence(e,f.map,f.trace),cadence,chain);
    expect(comparison.selected.map(c=>c.code)).toEqual(["misaim","early-tap"]);
    expect(comparison.cadence.candidate.inputIds).toEqual([]);
  });
  it("retains a supported chain pair when cadence flow is inapplicable",()=>{
    // Pure comparator contract: these independently selected chain inputs do
    // not purport to reconstruct an actual receiver/blocker dispatch.
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(e,f.map,f.trace)!;
    const input=e.inputs.find(i=>i.record.timeMs===1200)!.record;
    const causes=[decidedCandidate("misaim",input.id),decidedCandidate("early-tap",input.id)];
    const chain:InitiatingChain={rootComponentId:"root",rootInputId:input.id,rootComparison:comparePrimaryApproaches(e,f.map,{pressIds:[input.id]}),
      causes,componentIds:["root","8"],eventIds:[input.id],links:[],additionalInputIds:[],additionalInputEvidence:[],basis:"bounded-cadence-and-model-dispatch"};
    const inapplicable={...cadence,binding:{...cadence.binding,flow:undefined},pattern:{...cadence.pattern,flow:{...cadence.pattern.flow,complete:false}}};
    const association=derivePrimaryInputEvidence(e,f.map,f.trace),comparison=compareTargetCadence(e,f.map,association,inapplicable,chain);
    expect(causes.map(c=>c.code)).toEqual(["misaim","early-tap"]);
    expect(comparison.selected.map(c=>c.code)).toEqual(["misaim","early-tap"]);
    expect(comparison.cadence.pattern.flow.complete).toBe(false);
    expect(compareTargetCadence(e,f.map,association,inapplicable).selected.map(c=>c.code)).not.toContain("slow-tapping");
  });
  it.each([[-45,true,["early-tap"]],[-80,true,["early-tap"]]] as const)(
    "preserves only the policy-supported ordinary group at offset %s with correction %s",(offset,correction,expected)=>{
      const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
      const points=[[-150,-6,2.3],[-125,-3,2.3],[-100,-.1,2.3],[-80,0,2.3],[-45,0,2.3],[-20,0,2.3],[-5,0,correction?.8:2.3],[20,0,correction?0:2.3]];
      const press=offset===-80?3:4;
      const e=comparisonEvidence(original,points,[press]);
      const ordinary=comparePrimaryApproaches(e,f.map,{pressIds:["p"+press]});
      expect(ordinary.complete).toBe(true);expect(ordinary.ranking.selected.map(c=>c.code)).toEqual(expected);
      // This supplies a cadence API contract, not cadence from this geometry.
      const contract={...cadence,binding:{...cadence.binding,rawLiveInputIds:["p"+press]}};
      const comparison=compareTargetCadence(e,f.map,{...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:["p"+press],stream:undefined},contract);
      expect(comparison.hypotheses).toHaveLength(1);
      expect(comparison.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
      expect(comparison.attribution.observationOnly).toBe(true);
    });
  it.each([{mandatory:["p4","p6"]},{mandatory:["p4"]}])("does not manufacture an independent robust pair from mixed geometry witnesses %j",({mandatory})=>{
    const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
    const points=[[-170,-6,2.3],[-150,-3,2.3],[-130,-.1,2.3],[-110,0,2.3],[-80,0,2.3],[-55,-4,2.3],[-35,0,2.3],[-15,4,2.3],[0,0,.8],[20,0,0],[40,0,0]];
    const e=comparisonEvidence(original,points,[4,6]),ordinary=comparePrimaryApproaches(e,f.map,{pressIds:["p4","p6"]});
    expect(ordinary.complete).toBe(true);
    expect(ordinary.candidates.filter(c=>c.code==="misaim").map(c=>[c.inputIds[0],c.independent])).toEqual([["p4",true],["p6",false]]);
    expect(ordinary.ranking.selected.map(c=>c.code)).toEqual(["early-tap"]);
    expect(ordinary.ranking.selected[0].inputIds).toEqual(["p6"]);
    expect(ordinary.ranking.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
    const contract={...cadence,binding:{...cadence.binding,rawLiveInputIds:["p4","p6"]}};
    const comparison=compareTargetCadence(e,f.map,{...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:mandatory,stream:undefined},contract);
    expect(comparison.contenders.filter(c=>c.code==="misaim").every(c=>c.inputIds.length===1)).toBe(true);
    expect(comparison.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
  });
  it.each([{mandatory:["p4","p6"]},{mandatory:["p4"]}])("does not infer an independent pair by averaging different scoped presses %j",({mandatory})=>{
    const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
    const points=[[-150,-6,2.3],[-125,-3,2.3],[-100,-.1,2.3],[-80,0,2.3],[-55,0,2.3],[-45,0,2.3],[-35,0,2.3],[-15,0,2.3],[0,0,.8],[20,0,0],[40,0,0]];
    const e=comparisonEvidence(original,points,[4,6]),contract={...cadence,binding:{...cadence.binding,rawLiveInputIds:["p4","p6"]}};
    const comparison=compareTargetCadence(e,f.map,{...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:mandatory,stream:undefined},contract);
    expect(comparison.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
    expect(comparison.attribution.observationOnly).toBe(true);
    for(const h of comparison.hypotheses){
      expect(h.complete).toBe(true);expect(h.approachVariantIds.map(k=>comparison.approachVariants[k].inputId).sort()).toEqual([...h.inputIds].sort());
      expect(h.candidateIds.every(k=>comparison.candidates[k].inputIds.every(id=>h.inputIds.includes(id)))).toBe(true);
      expect(h.contextInputIds.every(id=>!h.inputIds.includes(id))).toBe(true);
    }
  });
  it("does not claim complete counterevidence or a cause when the diagnostic variant budget is exceeded",()=>{
    const f=fixture(),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
    const e=comparisonEvidence(original,[[-150,-6,2.3],[-125,-3,2.3],[-100,-.1,2.3],[-80,0,2.3],[-45,0,2.3],[-20,0,2.3],[-5,0,.8],[20,0,0]],[4]);
    // Supplied incompatible diagnostic IDs, never an ordinary recorded fixture.
    const id="oversized:"+"x".repeat(2*1024*1024);e.inputs[4].record.id=id;
    const contract={...cadence,binding:{...cadence.binding,rawLiveInputIds:[id]}};
    const comparison=compareTargetCadence(e,f.map,{...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:[id],stream:undefined},contract);
    expect(comparison.complete).toBe(false);expect(comparison.selected).toEqual([]);
    expect(comparison.resources.limited).toBe(true);expect(comparison.resources.variantBytes).toBeLessThanOrEqual(comparison.resources.maximumVariantBytes);
    expect(comparison.reason).toBe("cadence-variant-resource-limit");expect(comparison.hypotheses.every(h=>!h.complete)).toBe(true);
  });
  it("retains source order in allocation members and their complete descriptor references",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(e,f.map,f.trace)!;
    const raw=cadence.binding.rawLiveInputIds;expect(raw.length).toBeGreaterThan(1);
    const association={...derivePrimaryInputEvidence(e,f.map,f.trace),associations:[],relevantInputIds:[raw[raw.length-1]],stream:undefined};
    const comparison=compareTargetCadence(e,f.map,association,cadence),full=comparison.hypotheses.find(h=>h.inputIds.length===raw.length)!;
    expect(full.inputIds).toEqual(raw);
    for(const h of comparison.hypotheses){
      expect(h.inputIds).toEqual(raw.filter(id=>h.inputIds.includes(id)));
      expect(h.approachVariantIds.map(k=>comparison.approachVariants[k].inputId)).toEqual(h.inputIds);
    }
  });
  it.each((["stable","native"] as const).flatMap(profile=>[.92,.52].map(strength=>({profile,strength}))))(
    "reconstructs allocation scope without comparing radial placement to cadence in $profile at $strength",({profile,strength})=>{
    const f=fixture(profile),original=deriveCircleEvidence(f.trace,f.map,"8"),cadence=deriveTargetCadence(original,f.map,f.trace)!;
    const points=[[-70,-.43,-3.4],[-69,-.43,-2.95],[-43,.45,-.34],[-26,.16,-.30],[-14,-.15,-.28],[8,-.61,-.23],[24,-.87,-.19],[39,-1,-.17],[42,-1.05,-.16],[58,-1.15,-.16]];
    const raw=comparisonEvidence(original,points,[2,8]),e:CircleEvidence={...raw,identity:original.identity,
      geometry:{...raw.geometry!,profile:profile==="native"?"lazer":"stable",hitWindows:[25,67,109,399]},
      domains:{...raw.domains,interaction:{...raw.domains.interaction,end:{timeMs:1110,sequence:999,inclusive:false}}},terminal:{...raw.terminal!,timeMs:1111}};
    const inputScopes={p8:{placementEnd:{timeMs:1042,sequence:9,inclusive:true},eventIds:["p2","p8"]}};
    const own=comparePrimaryApproaches(e,f.map,{pressIds:["p8"],contextBoundaryInputIds:["p2"],inputScopes});
    const full=comparePrimaryApproaches(e,f.map,{pressIds:["p8","p2"],contextBoundaryInputIds:[],inputScopes});
    expect(own.complete).toBe(true);expect(full.complete).toBe(true);
    expect(own.approaches.episodes[0].placement).toBe("proper-pass");expect(own.approaches.episodes[0].relation).toBe("after-pass");
    expect(own.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);expect(own.ranking.selected[0].strength).toBeCloseTo(1.68,12);
    expect(full.approaches.episodes.find(e=>e.inputId==="p8")!.placement).toBe("misplaced");
    const contract={...cadence,candidate:{...cadence.candidate,strength},binding:{...cadence.binding,rawLiveInputIds:["p2","p8"]}};
    const association={...derivePrimaryInputEvidence(original,f.map,f.trace),associations:[],relevantInputIds:["p8"],stream:{...derivePrimaryInputEvidence(original,f.map,f.trace).stream!,inputScopes}};
    const comparison=compareTargetCadence(e,f.map,association,contract),branch=comparison.hypotheses.find(h=>h.inputIds.length===1)!;
    expect(branch.inputIds).toEqual(["p8"]);expect(branch.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(branch.scores.find(c=>c.code==="late-tap")?.strength).toBeCloseTo(1.68,12);
    expect(comparison.hypotheses.find(h=>h.inputIds.length===2)!.scores.some(s=>s.code==="misaim")).toBe(false);
    expect(comparison.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
    expect(comparison.attribution.observationOnly).toBe(true);
  });
  it.each(["stable","classic","native"] as const)("does not let an unrelated zero-time move erase %s raw cadence",profile=>{
    expect(cause(fixture(profile,"zero-context")).headline).toBe("Slow taps");
    expect(cause(fixture(profile,"zero-opportunity")).codes).not.toContain("slow-tapping");
  });
  it.each(["stable","classic","native"] as const)("retains %s cadence when a valid fresh press follows an ordered cursor jump",profile=>{
    const f=fixture(profile,"zero-press"),before=JSON.stringify([f.trace,f.state]);
    expect(cause(f).headline).toBe("Slow taps");
    expect(JSON.stringify([f.trace,f.state])).toBe(before);
  });
  it.each(["stable","classic","native"] as const)("does not import a recovered %s rhythm's earlier slow train into an isolated gap",profile=>{
    const f=fixture(profile,"recovered"),e=deriveCircleEvidence(f.trace,f.map,"8");
    expect(e.inputs.filter(i=>Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]&&i.record.freshActions.length)).toEqual([]);
    expect(e.inputs.filter(i=>Math.abs(i.record.timeMs-e.target!.hitTimeMs)<=e.geometry!.hitWindows[0]).every(i=>i.inside)).toBe(true);
    expect(deriveTargetCadence(e,f.map,f.trace)).toBeUndefined();
  });
  it.each(["DOUBLE_TIME","HALF_TIME"] as const)("uses the same map-clock pace under %s",mod=>{
    expect(cause(fixture("stable","",0,0,[mod])).headline).toBe("Slow taps");
  });
  it.each(["RELAX","AUTO_PILOT","AUTO_PLAY"] as const)("does not infer manual cadence under %s",mod=>{
    const f=fixture("stable","",0,0,[mod]);expect(deriveTargetCadence(deriveCircleEvidence(f.trace,f.map,"8"),f.map,f.trace)).toBeUndefined();
  });
  it("keeps cached patterns query-local to conflict exclusions and leaves source immutable",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"8"),before=JSON.stringify(f.trace);
    const first=deriveTargetCadence(e,f.map,f.trace)!;expect(first).toBeDefined();
    expect(deriveTargetCadence(e,f.map,f.trace,new Set(["6"]))).toBeUndefined();
    expect(deriveTargetCadence(e,f.map,f.trace,new Set(["irrelevant"]))).toEqual(first);
    expect(deriveTargetCadence(e,f.map,f.trace)).toEqual(first);expect(JSON.stringify(f.trace)).toBe(before);
    expect(first.candidate.inputIds).toEqual([]);expect(first.binding.noAssignedTargetInputBranch).toBe(true);
    expect(first.pattern.rawFreshActionCount).toBeLessThan(first.pattern.demandCount);
  });
  it.each(["gap","parsed","raw","mask","history","unknown","partial","endpoint"])("does not use incomplete %s cadence evidence",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>{
      if(r.kind!=="input"||r.timeMs!==1120)return r;
      if(fault==="gap")return {...r,source:{...r.source,discontinuityBefore:["test-gap"]}};
      if(fault==="parsed"&&r.source.origin==="parsed")return {...r,source:{...r.source,parsedFrameIndex:r.source.parsedFrameIndex+2}};
      if(fault==="raw")return {...r,source:{...r.source,origin:"parsed" as const,parsedFrameIndex:144,rawTokenIndex:-1}};
      if(fault==="mask")return {...r,rawButtonMask:1};
      if(fault==="history")return {...r,previousActions:[1]};
      if(fault==="unknown")return {...r,source:{origin:"synthetic" as const,reason:"test"}};
      return r;
    }),...(fault==="partial"?{droppedRecordBoundary:12}:{}),
      ...(fault==="endpoint"?{domain:{...f.trace.domain,endTimeMs:1240}}:{})};
    expect(cause(f,trace).codes).not.toContain("slow-tapping");
  });
  it.each(["on-pace","one-skip","same-pace","extra","onbeat","double","no-progress"])(
    "does not infer a sustained target pace failure from %s",fault=>{
      expect(cause(fixture("stable",fault)).codes).not.toContain("slow-tapping");
    },
  );
});
