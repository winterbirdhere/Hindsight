import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveLateReceptorSequence } from "../src/gameplay/error-analysis/LateReceptorSequence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function headSequence(fault?:"reset"|"extra"|"absence"|"rhythm"|"recovery-seeded") {
 const pulses=[1040,1155,1270,1385,1500,1620,1820,1910];if(fault==="reset")pulses[3]=1320;
 if(fault==="recovery-seeded")pulses.splice(0,5,1040,1150,1265,1380,1495);
 const times=[1000,1100,1200,1300,1400,1500];if(fault==="rhythm")times[2]=1170;
 const objects=times.map((t,k)=>`${fault==="absence"&&k===5?500:300},192,${t},1,0`).join("\n")+
  "\n300,192,1600,2,0,L|314:192,2,14\n300,192,1800,2,0,L|314:192,2,14";
 const frames=Array.from({length:341},(_,k)=>{const t=500+k*5,actions:number[]=[];
  for(let j=0;j<pulses.length;j++){const end=j<4?pulses[j]+40:j===4?1660:j===5?1880:j===6?2000:2050;
   if(t>=pulses[j]&&t<end&&!actions.includes(j%2))actions.push(j%2);}
  if(fault==="extra"&&t===1450)actions.push(1);
  return traceFrame(t,fault==="extra"&&t===1450?500:300,actions.sort());});
 return {objects,frames,...errorFixture(objects,frames)};
}
function recoveredHeadSequence(offsets:number[]) {
 const scheduled=[1000,1150,1300,1450,1600,1750],pulses=offsets.map((o,k)=>scheduled[k]+o),
  objects=scheduled.map(t=>`300,192,${t},1,0`).join("\n")+
   "\n300,192,1900,2,0,L|314:192,2,14\n400,192,2100,2,0,L|414:192,2,14",
  times=[...new Set([...Array.from({length:341},(_,k)=>800+k*5),...pulses,...pulses.map(t=>t+5),1906])].sort((a,b)=>a-b),
  intervals=[...pulses.map((t,k)=>[t,k===4?1906:t+5,k%2?0:1]),[1905,2050,0],[2100,2250,1],[2250,2260,0],[2400,2405,1],[2410,2415,0]],
  frames=times.map(t=>{
   const x=t<=1900?300:t<=1970?300+(t-1900)/5:t<=2040?314-(t-1970)/5:t<2100?300+(t-2040)*5/3:
    t<=2170?400+(t-2100)/5:t<=2240?414-(t-2170)/5:t<2250?400+(t-2240)*10:500;
   return traceFrame(t,x,[0,1].filter(a=>intervals.some(([s,e,b])=>a===b&&t>=s&&t<e)));
  });
 return {objects,frames,...errorFixture(objects,frames)};
}
describe("observed late cadence with a closed head recovery",()=>{
 it("retains preceding drift when an extra-capacity control closes before a long successful suffix",()=>{
  const objects=[1000,1100,1200,1300,1400,1500].map(t=>`300,192,${t},1,0`).join("\n")+
   "\n300,192,1600,2,0,L|314:192,2,14\n300,192,1800,2,0,L|314:192,2,14\n"+
   Array.from({length:14},(_,k)=>`300,192,${1900+100*k},1,0`).join("\n"),
   pulses=[1040,1155,1270,1385,1500,1620,1820,...Array.from({length:14},(_,k)=>1910+100*k)],
   frames=Array.from({length:641},(_,k)=>{const t=500+k*5;return traceFrame(t,300,[0,1].filter(a=>pulses.some((s,j)=>
    a===j%2&&t>=s&&t<(j<4?s+40:j===4?1660:j===5?1880:j===6?1900:s+40))));}),
   f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"5");
  expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");
  expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
 });
 it.each([[48,60,72,84,96],[49,61,73,85,97]])("does not let a successful head seed a missing phase: %j",(...offsets)=>{
  const f=recoveredHeadSequence(offsets),e=deriveCircleEvidence(f.trace,f.map,"5");
  expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");
  expect(f.state.hitCircleVerdict["6/HEAD"].type).toBe("GREAT");
  expect(deriveLateReceptorSequence(e,f.map,f.trace)).toBeUndefined();
 });
 it("diagnoses before searching and preserves head bodies with the generated control",()=>{
  const f=headSequence(),e=deriveCircleEvidence(f.trace,f.map,"5"),proof=deriveLateReceptorSequence(e,f.map,f.trace)!;
  expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
  expect(proof.anchors.map(a=>a.offsetMs)).toEqual([40,55,70,85,100]);
  expect(proof.phaseFit.predictedTargetOffsetMs).toBe(115);
  expect(proof.search.tried).toBe(1);expect(proof.correction.moves.map(m=>m.timeMs)).toEqual([1500,1600,1800]);
  const byIndex=new Map(proof.correction.changes.map(c=>{
    const q=f.trace.records.find(q=>q.id===c.inputId);if(q?.kind!=="input"||q.source.origin!=="parsed")throw Error("source");
    return [q.source.parsedFrameIndex,c.actions] as const;
  })),fixed=errorFixture(f.objects,f.frames.map((q,k)=>({...q,actions:byIndex.get(k)??q.actions})));
  expect(f.state.hitCircleVerdict["5"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["5"].type).toBe("GREAT");
  for(const id of ["0","1","2","3","4"])expect(fixed.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
  for(const id of ["6/HEAD","7/HEAD"])expect(fixed.state.hitCircleVerdict[id].type).toBe("GREAT");
  expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
 });
 it.each(["reset","extra","absence","rhythm","recovery-seeded"] as const)("retains %s as distinct evidence",fault=>{
  const f=headSequence(fault),e=deriveCircleEvidence(f.trace,f.map,"5");
  expect(deriveLateReceptorSequence(e,f.map,f.trace)).toBeUndefined();
  expect(classifyCircleLoss(e,f.map,f.trace).diagnostics?.primary?.lateSequence).toBeUndefined();
 });
 it.each(["source-gap","mask","history","excluded","identity","partial-trace"])("requires complete %s evidence",fault=>{
  const f=headSequence(),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace,
    q=trace.records.find(r=>r.kind==="input"&&r.timeMs===1270);
  if(q?.kind!=="input"||q.source.origin!=="parsed")throw Error("source");
  if(fault==="source-gap")q.source.parsedFrameIndex++;
  if(fault==="mask")q.rawButtonMask=0;
  if(fault==="history")q.previousActions=[0];
  if(fault==="partial-trace")Object.assign(trace,{droppedRecordBoundary:0});
  const e=deriveCircleEvidence(trace,f.map,"5");if(fault==="identity")e.identity={...e.identity,generationKey:"different"};
  expect(deriveLateReceptorSequence(e,f.map,trace,new Set(fault==="excluded"?["4"]:[]))).toBeUndefined();
 });
});
