import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveLateSequenceContinuation } from "../src/gameplay/error-analysis/LateSequenceContinuation";
import { certifyCircleRetiming } from "../src/gameplay/error-analysis/BoundedCircleRetiming";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function sequence(options:{corrected?:boolean;reset?:boolean;extra?:boolean;rhythm?:boolean;body?:boolean;profile?:"stable"|"lazer"}={}){
  const times=[1000,1100,1200,1300,1400,1500,1600,1700],
    pulses=[1040,1150,1265,1380,1495,1620,1720,1820];
  if(options.reset)pulses[3]=1320;
  if(options.rhythm)times[2]=1170;
  const objects=times.map((t,k)=>`300,192,${t},1,0`).join("\n")+(options.body?"\n500,192,1540,2,0,L|514:192,1,14":""),
    edited=options.corrected?[...pulses.slice(0,5),1505,1605,1705]:pulses,
    frames=Array.from({length:301},(_,k)=>{const t=800+k*5,i=edited.indexOf(t),actions=i>=0?[i%2]:[];
      if(options.extra&&t===1450)actions.push(1);
      return traceFrame(t,t<=1750?300:500,actions);
    });
  return errorFixture(objects,frames,options.profile);
}
describe("late cadence continues beyond a missed circle's expiry",()=>{
  it("diagnoses the established lag when a bounded pulse sequence repairs without stealing later successes",()=>{
    const f=sequence(),fixed=sequence({corrected:true}),e=deriveCircleEvidence(f.trace,f.map,"5"),m=classifyCircleLoss(e,f.map,f.trace);
    expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");
    expect(fixed.state.hitCircleVerdict["5"].type).toBe("GREAT");
    for(const id of ["0","1","2","3","4"])expect(fixed.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
    for(const id of ["6","7"])expect(fixed.state.hitCircleVerdict[id].type).toBe("GREAT");
    expect(m.headline).toBe("Late tap");
    expect(m.diagnostics?.primary).toHaveProperty("lateSequence");
  });
  it.each(["reset","extra","rhythm","body"] as const)("does not infer the same sequence through %s",fault=>{
    const f=sequence({[fault]:true}),e=deriveCircleEvidence(f.trace,f.map,"5"),m=classifyCircleLoss(e,f.map,f.trace);
    expect(m.diagnostics?.primary??{}).not.toHaveProperty("lateSequence");
  });
  it("retains native routing as a separate rule path",()=>{
    const f=sequence({profile:"lazer"}),e=deriveCircleEvidence(f.trace,f.map,"5");
    expect(classifyCircleLoss(e,f.map,f.trace).diagnostics?.primary).not.toHaveProperty("lateSequence");
  });
  it.each(["source-gap","mask","history","identity","truncated","exclusion"])("refuses %s evidence",fault=>{
    const f=sequence(),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace,
      q=trace.records.find(r=>r.kind==="input"&&r.timeMs===1265);
    if(q?.kind!=="input"||q.source.origin!=="parsed")throw Error("fixture");
    if(fault==="source-gap")q.source.parsedFrameIndex++;
    if(fault==="mask")q.rawButtonMask=0;
    if(fault==="history")q.previousActions=[0];
    if(fault==="truncated")Object.assign(trace,{droppedRecordBoundary:0});
    const e=deriveCircleEvidence(trace,f.map,"5");if(fault==="identity")e.identity={...e.identity,generationKey:"different"};
    expect(deriveLateSequenceContinuation(e,f.map,trace,new Set(fault==="exclusion"?["4"]:[]))).toBeUndefined();
  });
  it("does not certify a plan that abandons a successful neighbor or degrades its grade",()=>{
    const f=sequence(),e=deriveCircleEvidence(f.trace,f.map,"5"),proof=deriveLateSequenceContinuation(e,f.map,f.trace)!;
    expect(proof).toBeDefined();
    const plan=proof.correction.moves.map(m=>({componentId:m.componentId,inputId:m.inputId,sampleId:m.sampleId}));
    expect(certifyCircleRetiming(f.map,f.trace,plan.slice(0,-1))).toBeUndefined();
    const late=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1675)!;
    expect(certifyCircleRetiming(f.map,f.trace,plan.map((p,k)=>k===1?{...p,sampleId:late.id}:p))).toBeUndefined();
  });
  it("does not assume map order equals activation order for an overlapping external circle",()=>{
    const objects="100,192,1000,1,0\n200,192,1100,1,0\n100,192,900,1,0",points=[[700,500,0],[800,500,0],[900,500,0],
      [1000,100,0],[1011,500,0],[1100,200,0],[1111,500,0],[1115,200,1],[1116,500,0],[1215,400,2],[1216,500,0],[1300,500,0]],
      f=errorFixture(objects,points.map(([t,x,m])=>traceFrame(t,x,[...(m&1?[0]:[]),...(m&2?[1]:[])]))),
      input=(time:number)=>f.trace.records.find(r=>r.kind==="input"&&r.timeMs===time)!.id;
    expect(certifyCircleRetiming(f.map,f.trace,[{componentId:"0",inputId:input(1115),sampleId:input(1000)},
      {componentId:"1",inputId:input(1215),sampleId:input(1100)}])).toBeUndefined();
  });
  it("scopes the lifecycle of an earlier receptor whose recorded success clears the corrected selector",()=>{
    const objects="100,192,1000,1,0\n200,192,1100,1,0\n100,192,900,1,0",points=[[700,500,0],[800,500,0],[900,500,0],
      [950,100,2],[951,500,0],[1000,100,0],[1011,500,0],[1100,200,0],[1111,500,0],[1115,200,1],[1116,500,0],[1215,400,2],[1216,500,0],[1300,500,0]],
      f=errorFixture(objects,points.map(([t,x,m])=>traceFrame(t,x,[...(m&1?[0]:[]),...(m&2?[1]:[])]))),
      input=(time:number)=>f.trace.records.find(r=>r.kind==="input"&&r.timeMs===time)!.id,
      plan=[{componentId:"0",inputId:input(1115),sampleId:input(1000)},{componentId:"1",inputId:input(1215),sampleId:input(1100)}];
    expect(certifyCircleRetiming(f.map,f.trace,plan)).toBeDefined();
    expect(certifyCircleRetiming(f.map,f.trace,plan,new Set(["2"]))).toBeUndefined();
    expect(certifyCircleRetiming(f.map,{...f.trace,failures:[...f.trace.failures,"dependency-conflict:lifecycle:2"]},plan)).toBeUndefined();
  });
});
