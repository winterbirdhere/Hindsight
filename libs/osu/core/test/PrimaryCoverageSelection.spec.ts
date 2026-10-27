import { CircleEvidence, deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import { comparePrimaryApproaches, comparePrimaryInputHypotheses } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function driftingDwell(profile: "stable" | "lazer", repair=false, rotate=false) {
  const frames=[[700,340],[970,340],[985,342],[1000,344],[1015,346],[1030,347],[1200,500]].map(([t,x])=>{
    const point=repair&&t===1000?{x:300,y:192}:{x,y:228};
    return {...traceFrame(t,x,t>=1000&&t<=1030?[0]:[]),position:rotate?{x:300+point.y-192,y:192-point.x+300}:point};
  });
  return errorFixture("300,192,1000,1,0",frames,profile);
}

describe("positive bounded outside placement",()=>{
  it.each([false,true])("retains a blocked dwell only as an observation (dual=%s)",dual=>{
    const objects="250,192,945,1,0\n300,192,1000,1,0",frames=[[700,340],[970,340],[985,342],[1000,344],[1015,346],[1030,347],[1200,500]].map(([t,x])=>
      ({...traceFrame(t,x,t>=1000&&t<=1030?(dual?[0,1]:[0]):[]),position:{x,y:228}}));
    const f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"1"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    expect(analyzePrimaryApproaches(e,{pressIds:ids}).episodes[0].spatialCandidates.map(c=>c.code)).toEqual(["misaim"]);
    const corrected=errorFixture(objects,frames.map(q=>q.time===1000?{...q,position:{x:300,y:192}}:q));
    expect(corrected.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(deriveCircleEvidence(corrected.trace,corrected.map,"1").directRejections.length).toBeGreaterThan(0);
    const comparison=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(comparison.candidates.some(c=>c.code==="misaim")).toBe(true);
    expect(comparison.candidates.every(c=>!c.support?.correction)).toBe(true);
    if(!dual){expect(comparison.ranking.selected[0].code).toBe("misaim");expect(comparison.ranking.selected[0].observationOnly).toBe(true);}
  });
  it("does not turn an explicitly supplied held-only sample into a tap",()=>{
    const frames=[[700,360],[970,340],[985,342],[1000,344],[1015,346],[1030,347],[1200,500]].map(([t,x])=>
      ({...traceFrame(t,x,t<=1030?[0]:[]),position:{x,y:228}}));
    const f=errorFixture("300,192,1000,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"0"),held=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(held.record.freshActions).toEqual([]);
    expect(analyzePrimaryApproaches(e,{pressIds:[held.record.id]}).episodes[0].spatialCandidates).toEqual([]);
  });
  it.each(["stable","lazer"] as const)("recognizes a drifting %s dwell without inventing an approach direction",profile=>{
    for(const rotate of [false,true]){
      const f=driftingDwell(profile,false,rotate),e=deriveCircleEvidence(f.trace,f.map,"0"),press=e.inputs.find(i=>i.record.timeMs===1000)!;
      const ep=analyzePrimaryApproaches(e,{pressIds:[press.record.id]}).episodes[0];
      expect(e.terminal?.result).toBe("MISS");expect(ep.contacts).toEqual([]);
      expect(ep.spatialCandidates.map(c=>c.code)).toEqual(["misaim"]);
      expect(ep.landing?.eventIds).toContain(press.record.id);
      expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Misaim");
      expect(driftingDwell(profile,true,rotate).state.hitCircleVerdict["0"].type).toBe("GREAT");
    }
  });
  it.each(["gap","parsed","raw","mask","history","unknown","fresh","placement","terminal","instant","not-live"])(
    "does not establish a drifting dwell across a %s failure",fault=>{
      const f=driftingDwell("stable"),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"0"))) as CircleEvidence;
      const press=e.inputs.find(i=>i.record.timeMs===1000)!,next=e.inputs.find(i=>i.record.timeMs===1015)!;
      if(press.record.source.origin!=="parsed")throw Error("fixture");
      if(fault==="gap")press.record.source.discontinuityBefore=["source-gap"];
      if(fault==="parsed")press.record.source.parsedFrameIndex++;
      if(fault==="raw"){e.inputs.forEach(i=>{if(i.record.source.origin==="parsed")i.record.source.rawTokenIndex=i.record.source.parsedFrameIndex;});press.record.source.rawTokenIndex!++;}
      if(fault==="mask")press.record.rawButtonMask=2;
      if(fault==="history")press.record.previousActions=[1];
      if(fault==="unknown")press.freshActionsKnown=false;
      if(fault==="fresh"){next.record.actions=[0,1];next.record.freshActions=[1];}
      if(fault==="terminal"){e.terminal!.timeMs=1000;e.terminal!.sequence=press.record.sequence;}
      if(fault==="instant")next.record.timeMs=1000;
      if(fault==="not-live")press.inLiveSuccess=false;
      const context={pressIds:[press.record.id],inputScopes:fault==="placement"?{[press.record.id]:{placementEnd:{timeMs:1000,inclusive:true}}}:undefined};
      expect(analyzePrimaryApproaches(e,context).episodes[0].spatialCandidates).toEqual([]);
    });
});

function targetBlockedReceiver(brake=true) {
  const knots=brake?[[800,0],[945,100],[980,200],[1005,200],[1020,240],[1038,250],[1060,260],[1300,400]]:
    [[800,0],[945,100],[980,200],[1005,200],[1038,250],[1300,250+262*50/33]],taps=[[945,0],[1038,1],[1046,0]];
  const times=[...new Set([...Array.from({length:101},(_,k)=>800+k*5),...knots.map(p=>p[0]),...taps.flatMap(p=>[p[0],p[0]+2])])].sort((a,b)=>a-b);
  const frames=times.map(t=>{
    const at=knots.findIndex(k=>k[0]>t),b=knots[at<0?knots.length-1:at],a=knots[at<0?knots.length-1:Math.max(0,at-1)];
    return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),taps.filter(p=>t>=p[0]&&t<p[0]+2).map(p=>p[1]));
  });
  return errorFixture("100,192,945,1,0\n200,192,1000,1,0\n250,192,1055,1,0",frames);
}

function unconsumedNeighbourContext(){
    const knots=[[700,0],[950,70],[980,100],[1000,100],[1010,110],[1050,162],[1080,200],[1110,200],[1300,400]],
      times=[...new Set([...Array.from({length:121},(_,i)=>700+5*i),...knots.map(q=>q[0]),1052])].sort((a,b)=>a-b),
      frames=times.map(t=>{const at=knots.findIndex(q=>q[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at];
        return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),t>=1050&&t<1052?[0]:[]);}),
      f=errorFixture("100,192,1000,1,0\n200,192,1080,1,0",frames);
  return {...f,frames};
}

describe("failed later receiver as target comparison evidence",()=>{
  it("does not treat an inferred neighbour claim as an observed consumed press",()=>{
    const f=unconsumedNeighbourContext(),e=deriveCircleEvidence(f.trace,f.map,"0"),
      association=derivePrimaryInputEvidence(e,f.map,f.trace),p=e.inputs.find(i=>i.record.timeMs===1050)!;
    expect(association.relevantInputIds).toEqual([]);expect(association.associations.find(a=>a.inputId===p.record.id)?.role).toBe("context");
    expect(association.targetDependentRejections??[]).toEqual([]);expect(e.directRejections).toEqual([]);
    expect(f.trace.records.find(r=>r.kind==="selection"&&r.timeMs===1050)).toMatchObject({componentId:null});
    const before=JSON.stringify(f.trace);expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
    expect(derivePrimaryInputEvidence(e,f.map,f.trace)).toEqual(association);expect(JSON.stringify(f.trace)).toBe(before);
    const fixed=errorFixture("100,192,1000,1,0\n200,192,1080,1,0",f.frames.map(q=>q.time>=980&&q.time<1050?{...q,actions:[0]}:q));
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");expect(fixed.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
  });
  it.each(["source-gap","position","mask","raw-token","double","held","excluded"])("does not admit an inferred context press with %s evidence",fault=>{
    const f=unconsumedNeighbourContext(),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"0"))) as CircleEvidence,
      p=e.inputs.find(i=>i.record.timeMs===1050)!;
    if(fault==="source-gap"&&p.record.source.origin==="parsed")p.record.source.discontinuityBefore=["source-gap"];
    if(fault==="position")p.record.position.x++;
    if(fault==="mask")p.record.rawButtonMask=0;
    if(fault==="raw-token"&&p.record.source.origin==="parsed")p.record.source.rawTokenIndex=12345;
    if(fault==="double")p.record.freshActions=[0,1];
    if(fault==="held")p.record.freshActions=[];
    const cause=classifyCircleLoss(e,f.map,f.trace,fault==="excluded"?new Set(["0"]):undefined);
    expect(cause.diagnostics?.primary?.association.relevantInputIds).toEqual([]);
  });
  it("preserves actual successful neighbour consumption even when target-local comparison has candidates",()=>{
    const knots=[[700,250],[900,200],[970,200],[1000,100],[1030,100],[1300,400]],
      times=[...new Set([...Array.from({length:121},(_,i)=>700+5*i),...knots.map(q=>q[0]),972])].sort((a,b)=>a-b),
      frames=times.map(t=>{const at=knots.findIndex(q=>q[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at];
        return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),t>=970&&t<972?[0]:[]);}),
      f=errorFixture("200,192,920,1,0\n100,192,1000,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"1");
    expect(f.state.hitCircleVerdict["0"].type).toBe("OK");expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    const cause=classifyCircleLoss(e,f.map,f.trace);
    expect(cause.headline).toBe("Early tap");
    const rank=cause.diagnostics?.primary?.rawOpportunityComparison?.ranking??cause.diagnostics?.primary?.unconsumedContextComparison?.ranking??cause.diagnostics?.primary?.ranking;
    expect(rank?.selected[0].observationOnly).toBe(true);
    expect(rank?.selected[0].support).toBeUndefined();expect(cause.diagnostics?.primary?.association.relevantInputIds).toEqual([]);
  });
  it("retains timing for constant departure and placement for a genuine outside brake",()=>{
    const f=targetBlockedReceiver(false),e=deriveCircleEvidence(f.trace,f.map,"1");
    expect(derivePrimaryInputEvidence(e,f.map,f.trace).targetDependentRejections).toHaveLength(2);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
    expect(deriveCircleEvidence(f.trace,f.map,"2").directRejections).toHaveLength(2);
  });
  it("compares the initiating target without inventing its own rejection",()=>{
    const f=targetBlockedReceiver(),e=deriveCircleEvidence(f.trace,f.map,"1"),before=JSON.stringify(f.trace);
    const association=derivePrimaryInputEvidence(e,f.map,f.trace);
    const failed=e.inputs.filter(i=>[1038,1046].includes(i.record.timeMs)).map(i=>i.record.id);
    expect(e.directRejections).toEqual([]);expect(association.relevantInputIds).toEqual([]);
    expect(association.targetDependentRejections?.map(w=>w.inputId)).toEqual(failed);
    expect(association.associations.filter(a=>failed.includes(a.inputId)).every(a=>a.role==="context")).toBe(true);
    expect(association.stream?.assignments.filter(a=>failed.includes(a.inputId??"")&&a.relation==="matched").map(a=>a.componentId)).toEqual(["2","2"]);
    // This trajectory actually brakes outside after its valid pass. The routing
    // certificate exposes comparison; it does not prescribe a timing label.
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
    const receiver=deriveCircleEvidence(f.trace,f.map,"2");
    expect(receiver.directRejections).toHaveLength(2);expect(classifyCircleLoss(receiver,f.map,f.trace).headline).toBe("Notelock");
    expect(JSON.stringify(f.trace)).toBe(before);
  });
  it.each(["blocker","policy","source","unknown","double","mask","raw","lifecycle"])("does not promote invalid %s routing evidence",fault=>{
    const f=targetBlockedReceiver(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    trace.records.forEach(r=>{
      if(![1038,1046].includes(r.timeMs))return;
      if(r.kind==="policy"&&fault==="blocker")r.blockerId="0";
      if(r.kind==="policy"&&fault==="policy")r.state="allowed";
      if(r.kind==="input"&&r.source.origin==="parsed"&&fault==="source")r.source.discontinuityBefore=["source-gap"];
      if(r.kind==="input"&&fault==="double")r.freshActions=[0,1];
      if(r.kind==="input"&&fault==="mask")r.rawButtonMask=0;
      if(r.kind==="input"&&r.source.origin==="parsed"&&fault==="raw")r.source.rawTokenIndex=12345;
    });
    const e=deriveCircleEvidence(trace,f.map,"1");
    if(fault==="unknown")e.inputs.filter(i=>[1038,1046].includes(i.record.timeMs)).forEach(i=>i.freshActionsKnown=false);
    if(fault==="lifecycle")e.terminal!.previousUnresolved=false;
    const association=derivePrimaryInputEvidence(e,f.map,trace);
    expect(association.targetDependentRejections??[]).toEqual([]);
  });
});

describe("shared passage timing on slider heads",()=>{
  it("retains the certified aggregate passage across ambiguous singleton boundaries",()=>{
    const f=errorFixture("300,192,1000,2,0,L|300:292,1,100",[
      traceFrame(800,100),traceFrame(930,230),traceFrame(950,250,[0]),traceFrame(970,270,[0]),
      traceFrame(1000,300,[0]),traceFrame(1020,320),traceFrame(1045,345,[1]),traceFrame(1400,500),
    ]),e=deriveCircleEvidence(f.trace,f.map,"0/HEAD"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    const ordinary=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(ordinary.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(ordinary.ranking.selected[0].inputIds).toEqual([ids[1]]);
    const allocated=comparePrimaryInputHypotheses(e,f.map,{pressIds:ids},[],ids,f.trace);
    expect(allocated.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(allocated.ranking.selected[0].inputIds).toEqual([ids[1]]);
  });
  it.each(["mask","position","raw"])("does not bypass canonical %s evidence through a shared passage",fault=>{
    const f=errorFixture("300,192,1000,2,0,L|300:292,1,100",[
      traceFrame(800,100),traceFrame(930,230),traceFrame(950,250,[0]),traceFrame(970,270),traceFrame(1000),traceFrame(1045,345,[1]),traceFrame(1400,500),
    ]),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"0/HEAD"))) as CircleEvidence;
    for(const i of e.inputs){
      if(fault==="mask")i.record.rawButtonMask=(i.record.rawButtonMask??0)+32;
      if(fault==="position")i.record.position.x+=.01;
      if(fault==="raw"&&i.record.source.origin==="parsed")i.record.source.rawTokenIndex=(i.record.source.rawTokenIndex??i.record.source.parsedFrameIndex)+3;
    }
    const ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    expect(comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace).ranking.selected.map(c=>c.code)).not.toContain("off-beat");
  });
  it.each(["stable","lazer"] as const)("uses the %s head geometry and parent prefix",profile=>{
    const f=errorFixture("300,192,1000,2,0,L|300:292,1,100",[
      traceFrame(800,100),traceFrame(930,230),traceFrame(950,250,[0]),traceFrame(970,270),traceFrame(1000),traceFrame(1045,345,[1]),traceFrame(1400,500),
    ],profile);
    const e=deriveCircleEvidence(f.trace,f.map,"0/HEAD"),ids=e.inputs.filter(i=>i.record.freshActions.length).map(i=>i.record.id);
    const comparison=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(e.terminal?.result).toBe("MISS");
    expect(comparison.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect(comparison.ranking.selected[0].inputIds).toEqual([ids[1]]);
    expect(comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace,new Set(["0"])).ranking.selected.map(c=>c.code)).not.toContain("off-beat");
  });
});

describe("positive comparison support despite an unresolved secondary episode",()=>{
  it("keeps a usable timing correction when the opposing action cannot reach the shared passage",()=>{
    const objects="180,192,900,1,0\n300,192,1000,1,0",frames=[
      traceFrame(800,100),traceFrame(900,180,[0]),traceFrame(950,240,[0,1]),traceFrame(970,270,[0,1]),
      traceFrame(1000,300,[0,1]),traceFrame(1040,340,[0]),traceFrame(1050,350),traceFrame(1060,360,[0]),traceFrame(1300,500),
    ],f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"1"),
      ids=e.inputs.filter(i=>[950,1060].includes(i.record.timeMs)).map(i=>i.record.id),
      c=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace);
    expect(c.complete).toBe(true);
    expect(c.candidates.map(q=>q.code)).toEqual(expect.arrayContaining(["early-tap","aim-late","left-early"]));
    expect(c.candidates.filter(q=>q.support).map(q=>q.code)).toEqual(["early-tap"]);
    expect(c.candidates.map(q=>q.code)).not.toContain("off-beat");
    expect(c.ranking.selected.map(q=>q.code)).toEqual(["early-tap"]);
    const corrected=errorFixture(objects,frames.map(q=>q.time>=950&&q.time<1000?{...q,actions:q.actions.filter(a=>a!==1)}:q));
    expect(corrected.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(corrected.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
  });
  it.each([false,true])("retains the original release when delaying an edge (held=%s)",held=>{
    const f=errorFixture("300,192,1000,1,0",[
      traceFrame(800,100),traceFrame(940,230,[0]),traceFrame(950,240,held?[0]:[]),traceFrame(970,270,held?[0]:[]),
      traceFrame(1000,300,held?[0]:[]),...(held?[traceFrame(1005,340)]:[]),traceFrame(1010,350,[0]),traceFrame(1040,360),traceFrame(1300,500),
    ]),e=deriveCircleEvidence(f.trace,f.map,"0"),press=e.inputs.find(i=>i.record.timeMs===940)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(!!certifyPrimaryOpportunity(e,f.map,f.trace,press.record.id,[sample.record.id],"sampled-pass-tap",[press.record.id,sample.record.id])).toBe(held);
  });
  it("can relocate a short pulse only when its new release is an existing key-up frame",()=>{
    const frames=[traceFrame(800,100),traceFrame(940,230,[0]),traceFrame(950,240),traceFrame(970,270),
      traceFrame(1000,300),traceFrame(1005,340),traceFrame(1010,350,[0]),traceFrame(1040,360),traceFrame(1300,500)],
      f=errorFixture("300,192,1000,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"0"),
      press=e.inputs.find(i=>i.record.timeMs===940)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!,
      proof=certifyPrimaryOpportunity(e,f.map,f.trace,press.record.id,[sample.record.id],"sampled-pass-tap",[press.record.id,sample.record.id]);
    expect(proof?.relocatedRelease).toMatchObject({timeMs:1005});
    const corrected=errorFixture("300,192,1000,1,0",frames.map(q=>q.time===940?{...q,actions:[]}:q.time===1000?{...q,actions:[0]}:q));
    expect(corrected.state.hitCircleVerdict["0"].type).toBe("GREAT");
    const pulses=(trace:ReplayTrace)=>trace.records.filter(q=>q.kind==="input"&&q.freshActions.length).length;
    expect(pulses(corrected.trace)).toBe(pulses(f.trace));
  });
  function combinedContext(repair?:"early"|"late"|"prior"){
    const knots=[[700,94,140],[900,94,190],[940,90,240],[970,65,298],[987,62,298],[1040,62,324],[1067,70,326],[1080,100,360],[1100,180,440],[1300,300,500]],
      times=[...new Set([...Array.from({length:121},(_,i)=>700+i*5),...knots.map(q=>q[0]),987,989,1067,1069])].sort((a,b)=>a-b),
      frames=times.map(t=>{
        const at=knots.findIndex(q=>q[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at],u=(t-a[0])/Math.max(1,b[0]-a[0]),
          q={...traceFrame(t,0,[...(t>=987&&t<989?[0]:[]),...(t>=1067&&t<1069?[1]:[])]),position:{x:a[1]+(b[1]-a[1])*u,y:a[2]+(b[2]-a[2])*u}};
        if(repair==="late"&&t===1067||repair==="early"&&t===987)q.position={x:81,y:240};
        if(repair==="prior"&&t===987)q.position={x:94,y:201};
        return q;
      });
    return errorFixture("94,201,953,1,0\n81,240,1000,1,0\n70,298,1047,1,0\n70,326,1094,1,0",frames);
  }
  it("retains a certified combined raw-context candidate when singleton boundaries lose its approach",()=>{
    const f=combinedContext(),e=deriveCircleEvidence(f.trace,f.map,"1"),a=derivePrimaryInputEvidence(e,f.map,f.trace),
      ids=a.associations.filter(q=>q.role==="ambiguous").map(q=>q.inputId),
      comparison=comparePrimaryInputHypotheses(e,f.map,{pressIds:ids},[],ids,f.trace);
    // The singleton now has positive moving-outside evidence, while the raw
    // context still supplies the more specific description of that repair.
    expect(ids).toHaveLength(2);expect(comparison.complete).toBe(true);
    expect(comparison.ranking.selected.map(c=>c.code)).toEqual(["overshoot"]);
    expect(comparison.admissible).toBe(true);
    expect(comparison.rawContextCandidateIds.length).toBeGreaterThan(0);
    expect(comparison.ranking.selected[0].hypothesisIds).toContain("raw-context");
    const late=combinedContext("late"),early=combinedContext("early"),prior=combinedContext("prior");
    expect(late.state.hitCircleVerdict["1"]).toMatchObject({type:"OK",judgementTime:1067});
    for(const id of ["0","2","3"])expect(late.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
    expect(early.state.hitCircleVerdict).toEqual(f.state.hitCircleVerdict);
    expect(prior.state.hitCircleVerdict["0"].type).toBe("OK");expect(prior.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
  });
  it.each(["mask","sample-position","scope"])("does not pool an uncertified or out-of-scope %s raw-context candidate",fault=>{
    const f=combinedContext(),e=JSON.parse(JSON.stringify(deriveCircleEvidence(f.trace,f.map,"1"))) as CircleEvidence,
      late=e.inputs.find(i=>i.record.timeMs===1067)!,ids=e.inputs.filter(i=>i.inLiveSuccess&&i.record.freshActions.length).map(i=>i.record.id);
    if(fault==="mask")late.record.rawButtonMask=0;
    if(fault==="sample-position")late.record.position.x+=.01;
    const comparison=comparePrimaryInputHypotheses(e,f.map,{pressIds:ids,...(fault==="scope"?{end:{timeMs:1040,inclusive:true}}:{})},[],ids,f.trace);
    expect(comparison.admissible).toBe(false);expect(comparison.complete).toBe(false);
    expect(comparison.ranking.selected).toEqual([]);
  });
  function cadenceFixture(variant="") {
    const objects=Array.from({length:5},(_,i)=>`${100+i*100},192,${1000+i*114},1,0`).join("\n"),
      knots=[[800,20],[970,100],[992,145],[1106,variant==="outside-quorum"?245:200],[1222,300],[variant==="phase-band"?1290:1325,445],[1400,400],[1430,460],[1700,1000]],
      taps=[992,1106,1222,variant==="phase-band"?1290:1325,1430,variant==="two-continuations"?1470:1523,...(variant==="extra"?[1180]:[])].sort((a,b)=>a-b),
      times=[...new Set([...Array.from({length:181},(_,k)=>800+k*5),...knots.map(p=>p[0]),...taps.flatMap(t=>[t,t+2])])].sort((a,b)=>a-b);
    const frames=times.map(t=>{
      const at=knots.findIndex(q=>q[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at],
        tap=taps.findIndex(q=>t>=q&&t<q+2);
      return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),tap<0?[]:[tap%2]);
    });
    return errorFixture(objects,frames);
  }
  function cadenceComparison(f:ReturnType<typeof cadenceFixture>,trace=f.trace){
    const e=deriveCircleEvidence(trace,f.map,"4"),ids=e.inputs.filter(i=>i.inLiveSuccess&&i.record.freshActions.length).map(i=>i.record.id);
    return comparePrimaryInputHypotheses(e,f.map,{pressIds:ids},[],ids,trace);
  }
  it("does not advance a later edge into another pulse's hold or erase its release",()=>{
    const f=errorFixture("300,192,1000,1,0",[
      traceFrame(800,100),traceFrame(950,240,[0]),traceFrame(980,300,[0]),traceFrame(990,330),
      traceFrame(1000,340),traceFrame(1020,370),traceFrame(1050,400,[0]),traceFrame(1080,420),traceFrame(1300,500),
    ]),e=deriveCircleEvidence(f.trace,f.map,"0"),late=e.inputs.find(i=>i.record.timeMs===1050)!;
    for(const t of [980,990]){
      const sample=e.inputs.find(i=>i.record.timeMs===t)!;expect(sample.inside).toBe(true);
      expect(certifyPrimaryOpportunity(e,f.map,f.trace,late.record.id,[sample.record.id],"sampled-pass-tap",[late.record.id,sample.record.id])).toBeUndefined();
    }
  });
  it("prefers corroborated cadence over a later repair without inventing successful anchors",()=>{
    const f=cadenceFixture(),e=deriveCircleEvidence(f.trace,f.map,"4");
    expect(Object.values(f.state.hitCircleVerdict).map(v=>v.type)).toEqual(["MISS","MISS","MISS","MISS","MISS"]);
    const diagnosis=classifyCircleLoss(e,f.map,f.trace);
    expect(diagnosis.headline).toBe("Early tap");
    expect(diagnosis.diagnostics?.primary?.ranking?.selected[0].support?.context?.role).toBe("cadence-continuation");
  });
  it.each(["extra","phase-band","outside-quorum","two-continuations"])("keeps competing corrections without a cadence preference for %s",variant=>{
    const f=cadenceFixture(variant),comparison=cadenceComparison(f);
    const supported=comparison.candidates;
    expect(supported.map(c=>c.code)).toEqual(expect.arrayContaining(["early-tap","late-tap"]));
    expect(supported.every(c=>!c.roleEvidence?.context&&!c.support?.context)).toBe(true);
  });
  it.each(["parsed-gap","raw-gap","source-gap","previous-actions","mask","instant-movement"])("scopes %s to cadence preference without erasing local correction evidence",fault=>{
    const f=cadenceFixture(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for(const r of trace.records){
      if(r.kind!=="input")continue;
      if(fault==="raw-gap"&&r.source.origin==="parsed")r.source.rawTokenIndex=r.source.parsedFrameIndex;
      if(r.timeMs!==1200)continue;
      if(fault==="parsed-gap"&&r.source.origin==="parsed")r.source.parsedFrameIndex++;
      if(fault==="raw-gap"&&r.source.origin==="parsed")r.source.rawTokenIndex!++;
      if(fault==="source-gap"&&r.source.origin==="parsed")r.source.discontinuityBefore=["source-gap"];
      if(fault==="previous-actions")r.previousActions=[1];
      if(fault==="mask")r.rawButtonMask=15;
      if(fault==="instant-movement")r.timeMs=1195;
    }
    const comparison=cadenceComparison(f,trace),supported=comparison.candidates;
    expect(supported.map(c=>c.code)).toEqual(expect.arrayContaining(["early-tap","late-tap"]));
    expect(supported.every(c=>!c.roleEvidence?.context&&!c.support?.context)).toBe(true);
  });
  it.each(["stable","lazer"] as const)("does not assume equal-time ownership in %s",profile=>{
    const frames=[[800,360],[980,340],[1001,344],[1002,345],[1050,380],[1200,500]].map(([t,x])=>
      ({...traceFrame(t,x,t===1001?[0]:[]),position:{x,y:228}}));
    const objects="300,192,1000,1,0\n300,192,1000,1,0",f=errorFixture(objects,frames,profile),e=deriveCircleEvidence(f.trace,f.map,"0"),
      press=e.inputs.find(i=>i.record.timeMs===1001)!;
    const repaired=errorFixture(objects,frames.map(q=>q.time===1001?{...q,position:{x:300,y:192}}:q),profile);
    expect(repaired.state.hitCircleVerdict["0"].type).toBe(profile==="stable"?"GREAT":"MISS");
    expect(!!certifyPrimaryOpportunity(e,f.map,f.trace,press.record.id,[press.record.id],"same-time-aim",[press.record.id])).toBe(profile==="stable");
  });
  function aimCorrection(blocked=false,repair=false){
    const frames=[[800,360],[980,340],[1001,344],[1002,345],[1050,380],[1200,500]].map(([t,x])=>
      ({...traceFrame(t,x,t===1001?[0]:[]),position:repair&&t===1001?{x:300,y:192}:{x,y:228}}));
    return errorFixture((blocked?"100,192,900,1,0\n":"")+"300,192,1000,1,0",frames);
  }
  it.each([false,true])("requires a usable same-time aim correction (blocked=%s)",blocked=>{
    const f=aimCorrection(blocked),target=blocked?"1":"0",e=deriveCircleEvidence(f.trace,f.map,target),press=e.inputs.find(i=>i.record.timeMs===1001)!;
    expect(e.terminal?.result).toBe("MISS");
    const comparison=comparePrimaryApproaches(e,f.map,{pressIds:[press.record.id]},f.trace);
    // A completed short lobe now supplies placement directly. Admission still
    // needs the same usable aim correction, whatever the extraction path.
    expect(comparison.candidates.filter(c=>c.support?.correction?.kind==="same-time-aim").map(c=>c.code)).toEqual(blocked?[]:["misaim"]);
    expect(aimCorrection(blocked,true).state.hitCircleVerdict[target].type).toBe(blocked?"MISS":"GREAT");
  });
  it.each(["sample-position","sample-time","press-mask","raw-hole","geometry","lifecycle","excluded"])(
    "refuses a positive correction with %s evidence",fault=>{
      const f=aimCorrection(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
      if(fault==="press-mask")trace.records.forEach(r=>{if(r.kind==="input"&&r.timeMs===1001)r.rawButtonMask=0;});
      if(fault==="raw-hole")trace.records.forEach(r=>{if(r.kind==="input"&&r.source.origin==="parsed"&&r.timeMs!==1001)r.source.rawTokenIndex=r.source.parsedFrameIndex;});
      const e=JSON.parse(JSON.stringify(deriveCircleEvidence(trace,f.map,"0"))) as CircleEvidence;
      const press=e.inputs.find(i=>i.record.timeMs===1001)!,sample=e.inputs.find(i=>i.record.timeMs===980)!;
      if(fault==="sample-position"){sample.record.position={x:300,y:192};sample.inside=true;}
      if(fault==="sample-time"){sample.record.timeMs=1000;sample.inside=true;}
      if(fault==="geometry")e.geometry!.hitWindows.reverse();
      if(fault==="lifecycle")e.terminal!.sequence=press.record.sequence;
      const timing=fault.startsWith("sample-");
      expect(certifyPrimaryOpportunity(e,f.map,trace,press.record.id,[timing?sample.record.id:press.record.id],
        timing?"sampled-pass-tap":"same-time-aim",[press.record.id],fault==="excluded"?new Set(["0"]):undefined)).toBeUndefined();
    });
  it("retains scoped placement uncertainty while completing independent timing evidence",()=>{
    const f=errorFixture("300,192,1000,1,0",[
      traceFrame(800,100),traceFrame(910,150,[0]),traceFrame(920,180),traceFrame(950,230),
      traceFrame(980,300),traceFrame(1010,360),traceFrame(1035,360,[1]),traceFrame(1060,360),traceFrame(1300,500),
    ]);
    const e=deriveCircleEvidence(f.trace,f.map,"0"),early=e.inputs.find(i=>i.record.timeMs===910)!,late=e.inputs.find(i=>i.record.timeMs===1035)!;
    const comparison=comparePrimaryApproaches(e,f.map,{pressIds:[early.record.id,late.record.id],
      inputScopes:{[early.record.id]:{end:{timeMs:920,inclusive:true}}}},f.trace);
    expect(comparison.approaches.episodes[0].placement).toBe("unproven");
    expect(comparison.candidates.some(c=>c.family==="placement"&&c.inputIds.includes(late.record.id))).toBe(true);
    expect(comparison.complete).toBe(false);
    expect(comparison.ranking.selected[0].support?.correction?.kind).toBe("sampled-pass-tap");
    expect(comparison.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
    expect((comparison as typeof comparison&{admissible?:boolean}).admissible).toBe(true);
  });
});
