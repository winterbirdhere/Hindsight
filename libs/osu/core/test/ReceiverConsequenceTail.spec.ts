import { deriveReceiverRejectionConsequence } from "../src/gameplay/error-analysis/ReceiverRejectionConsequence";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

const objects="100,192,1000,1,0\n200,192,1100,1,0\n260,192,1200,1,0\n260,192,1280,1,0\n400,192,1450,1,0";
const times=[...new Set([...Array.from({length:181},(_,k)=>700+k*5).filter(t=>t!==1310),1312,1317])].sort((a,b)=>a-b);
const pulses=[[1005,1010,1],[1105,1110,0],[1205,1210,1],[1312,1317,0],[1450,1455,1]];
function source(fault=""){
 return times.map(t=>{
  let x=t<1050?500:t<1150?200:t<1250?230:t<1400?260:400;
  let actions=[0,1].filter(a=>pulses.some(([s,e,b])=>a===b&&t>=s&&t<e));
  if(fault==="extra"&&t===1350){x=500;actions=[1];}
  if(fault==="reentry"&&t>=1250&&t<1290)x=500;
  return traceFrame(t,x,actions);
 });
}
function derive(f:ReturnType<typeof errorFixture>,excluded?:ReadonlySet<string>){
 const e=deriveCircleEvidence(f.trace,f.map,"2");
 return deriveReceiverRejectionConsequence(e,derivePrimaryInputEvidence(e,f.map,f.trace),f.map,f.trace,excluded);
}
describe("a closed downstream rejection following successful consumption",()=>{
 it("keeps recorded rejection separate from recomputed child success",()=>{
  const f=errorFixture(objects,source()),p=derive(f),fixed=errorFixture(objects,source().map(q=>q.time===1005?{...q,position:{x:100,y:192}}:q));
  expect(p).toHaveProperty("downstreamRejections");
  expect(Reflect.get(p!,"downstreamRejections")).toEqual([expect.objectContaining({receiverId:"3",actual:{selectedId:"3",state:"rejected",blockerId:"2",timingResult:"OK"},
    afterTargetSuccess:{selectedId:"3",state:"allowed",blockers:[],timingResult:"OK"}})]);
  expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["2"].type).toBe("GREAT");
  expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["3"].type).toBe("OK");
  expect(fixed.state.hitCircleVerdict["4"]).toEqual(f.state.hitCircleVerdict["4"]);
  const e=deriveCircleEvidence(f.trace,f.map,"2");expect(e.directRejections).toEqual([]);expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Notelock");
 });
 it.each(["extra","reentry","source-gap","wrong-blocker","head","exclusion"])("does not close through %s",fault=>{
  const f=errorFixture(fault==="head"?objects.replace("260,192,1280,1,0","260,192,1280,2,0,L|274:192,1,14"):objects,source(fault)),
    trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
  for(const r of trace.records){
   if(fault==="source-gap"&&r.kind==="input"&&r.timeMs===1350&&r.source.origin==="parsed")r.source.parsedFrameIndex++;
   if(fault==="wrong-blocker"&&r.kind==="policy"&&r.timeMs===1312)r.blockerId="1";
  }
  expect(derive({...f,trace},fault==="exclusion"?new Set(["3"]):undefined)).toBeUndefined();
 });
 it.each([false,true])("checks the whole source even when the child expiry is the last update (extra=%s)",extra=>{
  const f=errorFixture(objects,source(extra?"extra":"").filter(q=>q.time<=1395));
  if(extra)expect(derive(f)).toBeUndefined();else expect(derive(f)).toBeDefined();
 });
});
