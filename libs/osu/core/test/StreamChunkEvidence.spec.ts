import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

// Independently scheduled curved flow: every ordinary press is +35ms, with
// contiguous8ms source samples. The failed slot keeps its own source pulse.
function flow(count:number, options:{missing?:number;bad?:number;failed?:number[];extra?:number;held?:boolean;profile?:"stable"|"lazer"|"classic"}={}) {
  const xy=[[100,100],[150,100],[180,145],[180,200],[140,245],[90,245]];
  const slots=Array.from({length:count},(_,i)=>({time:1000+80*i,xy:xy[i%xy.length]}));
  const edges=slots.flatMap((n,i)=>i===options.missing ? [] : [{time:n.time+35,action:i%2}]);
  if(options.extra!==undefined)edges.push({time:slots[options.extra].time+43,action:1-options.extra%2});
  edges.sort((a,b)=>a.time-b.time);
  const knots=slots.flatMap((n,i)=>[
    {time:n.time,xy:n.xy},
    {time:n.time+35,xy:i===options.bad || options.failed?.includes(i) ? [n.xy[0],n.xy[1]-60] : n.xy},
  ]);
  const through=slots[count-1].time+220,hold=options.held ? 95 : 25;
  const times=[...new Set([800,...Array.from({length:Math.ceil((through-800)/8)+1},(_,i)=>800+8*i),
    ...knots.map(k=>k.time),...edges.flatMap(e=>[e.time,e.time+hold]),through])].sort((a,b)=>a-b);
  const frames=times.map(time=>{
    const right=knots.findIndex(k=>k.time>=time);
    const a=right<=0 ? knots[right===0 ? 0 : knots.length-1] : knots[right-1];
    const b=right<0 ? a : knots[right];
    const ratio=b.time===a.time ? 0 : (time-a.time)/(b.time-a.time);
    const position={x:a.xy[0]+ratio*(b.xy[0]-a.xy[0]),y:a.xy[1]+ratio*(b.xy[1]-a.xy[1])};
    return {...traceFrame(time,position.x,edges.flatMap(e=>time>=e.time&&time<e.time+hold ? [e.action] : [])),position};
  });
  return errorFixture(slots.map(n=>`${n.xy[0]},${n.xy[1]},${n.time},1,0`).join("\n"),frames,
    options.profile==="stable"||!options.profile ? "stable" : "lazer",[],options.profile==="classic" ? [{acronym:"CL",settings:{classic_note_lock:true}}] : []);
}
function shiftedReception() {
  const count=65,notes=Array.from({length:count},(_,i)=>({time:1000+80*i,
    x:i<37 ? [100,150,200,250][i%4] : i<=44 ? [100,150,200,250,300,350,400,450][i-37] : i%2 ? 350 : 450}));
  const taps=notes.map((n,i)=>({time:n.time+(i<37 ? 35 : -10),x:i>=37&&i<=44 ? [100,150,200,200,305,350,375,450][i-37] : n.x}));
  const times=[...new Set([800,...Array.from({length:690},(_,i)=>900+8*i),...taps.flatMap(t=>[t.time,t.time+25]),6500])].sort((a,b)=>a-b);
  const frames=times.map(time=>{
    const right=taps.findIndex(t=>t.time>=time),a=right<=0 ? taps[right===0 ? 0 : count-1] : taps[right-1],b=right<0 ? a : taps[right];
    const x=a.x+(b.x-a.x)*(time-a.time)/Math.max(1,b.time-a.time);
    return traceFrame(time,x,taps.flatMap((t,i)=>time>=t.time&&time<t.time+25 ? [i%2] : []));
  });
  return errorFixture(notes.map(n=>`${n.x},192,${n.time},1,0`).join("\n"),frames);
}
function longHeadBoundary() {
  const prefix=Array.from({length:62},(_,i)=>({time:1040+80*i,x:i%2 ? 150 : 100}));
  const objects=[...prefix.map(n=>`${n.x},192,${n.time},1,0`),
    "100,192,6000,1,0","150,192,6080,1,0","200,192,6160,2,0,L|216:192,1,16",
    "278,192,6240,1,0","358,192,6320,1,0","438,192,6400,1,0"];
  const knots=[{time:800,x:100},...prefix.map(n=>({time:n.time+35,x:n.x})),
    {time:6035,x:100},{time:6115,x:150},{time:6160,x:200},{time:6200,x:240},
    {time:6240,x:278},{time:6355,x:358},{time:6435,x:438},{time:6600,x:478}];
  const taps=[...prefix.map(n=>n.time+35),6035,6115,6200,6355,6435];
  const times=[...new Set([...Array.from({length:726},(_,i)=>800+8*i),...knots.map(n=>n.time),...taps.flatMap(t=>[t,t+20])])].sort((a,b)=>a-b);
  return errorFixture(objects.join("\n"),times.map(time=>{
    const right=knots.findIndex(k=>k.time>=time),a=right<=0 ? knots[right===0 ? 0 : knots.length-1] : knots[right-1],b=right<0 ? a : knots[right];
    return traceFrame(time,a.x+(b.x-a.x)*(time-a.time)/Math.max(1,b.time-a.time),taps.flatMap((t,i)=>time>=t&&time<t+20 ? [i%2] : []));
  }));
}
function inspect(f:ReturnType<typeof flow>,slot:number,trace:ReplayTrace=f.trace) {
  return deriveStreamInputEvidence(deriveCircleEvidence(trace,f.map,String(slot)),f.map,trace);
}
function pulse(f:ReturnType<typeof flow>,slot:number) {
  const at=1000+80*slot+35;
  const r=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===at&&r.freshActions.length);
  if(!r)throw Error("Missing independently scheduled pulse");
  return r.id;
}

describe("canonical bounded context in longer physical streams",()=>{
  it.each([65,129])("keeps a %i-note curved stream's real failed-slot action across a canonical boundary",count=>{
    const f=flow(count,{bad:48});
    expect(f.state.hitCircleVerdict["48"].type).toBe("MISS");
    const r=inspect(f,48);
    expect(r.status).toBe("supported");
    expect(r.relevantInputIds).toEqual([pulse(f,48)]);
    expect(r.rawFreshInputIds).toContain(pulse(f,48));
    expect(r.assignments).toContainEqual(expect.objectContaining({componentId:"48",inputId:pulse(f,48),confidence:"corroborated"}));
    expect(r).toMatchObject({boundedContext:{ownedStartId:"48",ownedEndId:count===65 ? "64" : "95",alignmentNoteCount:count===65 ? 25 : 64,artificialLeft:true}});
  });
  it.each([47,48,95,96])("certifies a genuinely absent slot%i using complete neighbouring pulses",slot=>{
    const f=flow(129,{missing:slot}),r=inspect(f,slot);
    expect(f.state.hitCircleVerdict[String(slot)].type).toBe("MISS");
    expect(r.status).toBe("supported");
    expect(r.missingTargetTap).toBe(true);
    expect(r.relevantInputIds).toEqual([]);
    expect(r.assignments).toContainEqual(expect.objectContaining({componentId:String(slot),relation:"missing"}));
  });
  it("does not erase a fresh extra action or infer absence across it",()=>{
    const f=flow(129,{missing:48,extra:48}),r=inspect(f,48);
    expect(r.missingTargetTap).toBe(false);
    expect(r.rawFreshActionCount).toBeGreaterThan(0);
    expect(r.limitations).not.toContain("stream-note-limit");
  });
  it("retains held-key alternation with a separate real fresh action",()=>{
    const f=flow(129,{bad:48,held:true}),r=inspect(f,48);
    expect(r.status).toBe("supported");
    expect(r.relevantInputIds).toEqual([pulse(f,48)]);
    const raw=f.trace.records.find(r=>r.id===pulse(f,48));
    expect(raw?.kind==="input"&&raw.actions.length).toBe(2);
  });
  it.each(["stable","lazer","classic"] as const)("retains exact %s successful receptions across an artificial core",profile=>{
    const f=flow(65,{held:true,profile}),r=inspect(f,48);
    expect(f.state.hitCircleVerdict["48"].type).not.toBe("MISS");
    expect(r.assignments).toContainEqual(expect.objectContaining({componentId:"48",inputId:pulse(f,48),confidence:"anchored"}));
  });
  it("retains an originating peer's active phase witnesses even when the canonical prefix cannot reset",()=>{
    const f=shiftedReception(),r=inspect(f,48);
    const q43=f.trace.records.find(row=>row.kind==="input"&&row.timeMs===1000+80*43-10&&row.freshActions.length);
    expect(f.state.hitCircleVerdict["42"].type).not.toBe("MISS");
    expect(r.assignments).toContainEqual(expect.objectContaining({componentId:"42",inputId:q43?.id,confidence:"anchored"}));
    expect(r.status).toBe("unavailable");
    expect(r.limitations).toContain("stream-left-history-unresolved");
    expect(r.phaseAlternatives).toEqual(expect.arrayContaining([expect.objectContaining({phaseMs:-10,active:true})]));
    expect(r.missingTargetTap).toBe(false);
  });
  it("keeps the validated cadence priority consistent from either side of a long slider-head boundary",()=>{
    const f=longHeadBoundary(),input=f.trace.records.find(row=>row.kind==="input"&&row.timeMs===6200&&row.freshActions.length);
    for(const id of ["64/HEAD","65"]) {
      const r=deriveStreamInputEvidence(deriveCircleEvidence(f.trace,f.map,id),f.map,f.trace);
      const assignment=r.assignments.find(row=>row.inputId===input?.id);
      expect(assignment).toMatchObject({componentId:"64/HEAD",basis:"cadence",relation:"matched"});
      expect(assignment?.competingClaims?.map(row=>row.componentId)).toEqual(expect.arrayContaining(["64/HEAD","65"]));
    }
  });
  it("keeps query order and fresh-trace ownership deterministic",()=>{
    const f=flow(129,{bad:48});
    const forward=[47,48,49,95,96].map(i=>[i,inspect(f,i)] as const);
    for(const [i,r]of forward.slice().reverse())expect(inspect(f,i,JSON.parse(JSON.stringify(f.trace)))).toEqual(r);
    for(const [i,r]of forward.slice().reverse())expect(inspect(f,i)).toEqual(r);
  });
  it("exports the target dependency closure without duplicating unrelated peer assignments",()=>{
    const f=flow(129,{bad:48}),e=deriveCircleEvidence(f.trace,f.map,"48"),r=inspect(f,48);
    const relevant=new Set([...e.inputs.map(input=>input.record.id),...r.assignments.filter(row=>row.componentId==="48").flatMap(row=>row.eventIds),
      ...(r.phaseAlternatives ?? []).flatMap(row=>row.targetInputIds)]);
    expect(r.assignments.filter(row=>row.inputId&&!relevant.has(row.inputId))).toEqual([]);
    expect(r.relevantInputIds).toEqual([pulse(f,48)]);
    expect(r.assignments).toContainEqual(expect.objectContaining({componentId:"48",inputId:pulse(f,48)}));
  });
  it("keeps discontinuous local source unavailable instead of blaming an omitted tap",()=>{
    const f=flow(129,{missing:48}),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    const record=trace.records.find(r=>r.kind==="input"&&r.timeMs>=1000+80*48);
    if(!record||record.kind!=="input"||record.source.origin!=="parsed")throw Error("Missing parsed source");
    record.source.discontinuityBefore=["test-gap"];
    const r=inspect(f,48,trace);
    expect(r.status).toBe("unavailable");
    expect(r.missingTargetTap).toBe(false);
    expect(r.limitations).not.toContain("stream-note-limit");
  });
  it("does not reset unknown phase history at an artificial left boundary",()=>{
    const f=flow(129,{failed:Array.from({length:9},(_,i)=>40+i)}),r=inspect(f,48);
    expect(f.state.hitCircleVerdict["48"].type).toBe("MISS");
    expect(r.status).toBe("unavailable");
    expect(r.limitations).toContain("stream-left-history-unresolved");
    expect(r.rawFreshActionCount).toBeGreaterThan(0);
    expect(r.missingTargetTap).toBe(false);
  });
  it("bounds every alignment and stays deterministic after cache eviction",()=>{
    const f=flow(1601,{bad:48});
    const first=inspect(f,48);
    for(let i=96;i<1601;i+=48)expect(inspect(f,i).boundedContext?.alignmentNoteCount).toBeLessThanOrEqual(64);
    expect(inspect(f,48)).toEqual(first);
  });
});
