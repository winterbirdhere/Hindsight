import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

export function upstreamArrival(fault?:"on-time-entry"|"missing-pulse"|"unrelated-target") {
 const objects="400,192,800,1,0\n400,192,900,1,0\n100,192,1000,1,0\n"+(fault==="unrelated-target"?"300":"100")+",192,1056,1,0",
  points:Array<[number,number,number[]]>=[[600,400,[]],[806,400,[0]],[820,400,[]],[899,400,[1]],[915,250,[]],
   [945,177,[]],[962,162,fault==="missing-pulse"?[]:[0]],[970,157,[]],[982,149,[]],[1000,142,[]],[1025,139,[]],
   [1043,137,[1]],[1050,135,[1]],[1072,133,[1]],[1086,130,[]],[1102,123,[]],[1105,120,[0]],[1110,120,[]],[1250,400,[]]];
 if(fault==="on-time-entry")points.find(p=>p[0]===1000)![1]=100;
 const frames=points.map(([t,x,a])=>traceFrame(t,x,a)),f=errorFixture(objects,frames);
 return {objects,frames,...f};
}
describe("upstream arrival followed by successful consumption",()=>{
 it("carries the measured earlier Late entry to the lost unchanged opportunity",()=>{
  const f=upstreamArrival(),e=deriveCircleEvidence(f.trace,f.map,"3"),r=classifyCircleLoss(e,f.map,f.trace);
  expect(f.state.hitCircleVerdict["2"]).toMatchObject({type:"MEH",judgementTime:1105});
  expect(e.directRejections).toHaveLength(0);expect(r.headline).toBe("Late entry");
 });
 it.each(["on-time-entry","missing-pulse","unrelated-target"] as const)("retains %s as a negative for the upstream arrival proof",fault=>{
  const f=upstreamArrival(fault),r=classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"3"),f.map,f.trace);
  expect(r.diagnostics?.primary).not.toHaveProperty("upstreamArrival");
 });
});
