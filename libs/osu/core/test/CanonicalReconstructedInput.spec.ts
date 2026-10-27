import { certifyCanonicalControl } from "../src/gameplay/error-analysis/CanonicalReplayVerifier";
import { errorFixture } from "./ErrorAnalysisFixtures";

function fixture(){
 const frames=[700,940,960,980,995,1005,1020,1060,1080,1200].map((time,k)=>({time,position:{x:[0,100,160,220,280,320,400,450,500,500][k],y:228},actions:time===940?[0]:time===1060?[1]:[]}));
 return {frames,...errorFixture("300,192,1000,1,0",frames)};
}
describe("explicit reconstructed intermediate inputs",()=>{
 it("retimes an existing edge into a declared linear sample without claiming a recorded input",()=>{
  const f=fixture(),before=JSON.stringify(f.trace),inputs=f.trace.records.filter(r=>r.kind==="input"),
   q=inputs.find(r=>r.timeMs===940)!,right=inputs.find(r=>r.timeMs===1005)!,
   plan={targetId:"0",relatedComponentIds:["0"],changes:[{inputId:q.id,actions:[]}],
    insertions:[{beforeInputId:right.id,timeMs:1000,actions:[0]}]},proof=certifyCanonicalControl(f.map,f.trace,plan);
  expect(proof?.outcomes[0].after).toEqual({type:"GREAT",judgementTime:1000});
  expect(proof?.addedFreshActions).toBe(0);expect(JSON.stringify(f.trace)).toBe(before);
 });
 it("refuses a reconstruction beyond its original adjacent time bracket",()=>{
  const f=fixture(),inputs=f.trace.records.filter(r=>r.kind==="input"),q=inputs.find(r=>r.timeMs===940)!,right=inputs.find(r=>r.timeMs===1005)!;
  for(const timeMs of [995,1005,1010])expect(certifyCanonicalControl(f.map,f.trace,{targetId:"0",relatedComponentIds:["0"],
   changes:[{inputId:q.id,actions:[]}],...{insertions:[{beforeInputId:right.id,timeMs,actions:[0]}]}})).toBeUndefined();
 });
 it.each(["successful-neighbour","active-slider","edited-endpoint"] as const)("preserves %s",fault=>{
  const original=fixture(),objects=fault==="successful-neighbour"?"100,228,940,1,0\n300,192,1000,1,0":
   fault==="active-slider"?"50,50,800,2,0,L|450:50,1,400\n300,192,1000,1,0":"300,192,1000,1,0",
   f=errorFixture(objects,original.frames),inputs=f.trace.records.filter(r=>r.kind==="input"),q=inputs.find(r=>r.timeMs===940)!,left=inputs.find(r=>r.timeMs===995)!,right=inputs.find(r=>r.timeMs===1005)!,targetId=fault==="edited-endpoint"?"0":"1";
  expect(certifyCanonicalControl(f.map,f.trace,{targetId,relatedComponentIds:[targetId],changes:[{inputId:q.id,actions:[]},
   ...(fault==="edited-endpoint"?[{inputId:left.id,position:{x:281,y:228}}]:[])],insertions:[{beforeInputId:right.id,timeMs:1000,actions:[0]}]})).toBeUndefined();
 });
});
