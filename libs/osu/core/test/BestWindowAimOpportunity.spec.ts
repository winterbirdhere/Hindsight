import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";

type Point=[number,number,number,number[]];
const arrival:Point[]=[[-117,-351.8889,11.4444,[1]],[-101,-357.2222,-1,[1]],[-99,-357.2222,-1,[1]],[-93,-357.6667,-6.3333,[0]],[-83,-355.4444,-12.5556,[0]],[-67,-339.4444,-25,[0]],[-51,-300.7778,-33.4444,[0]],[-34,-234.1111,-35.6667,[0]],[-17,-153.2222,-36.1111,[0]],[-14,-110.5555,-35.6667,[0,1]],[2,-45.2222,-27.2222,[0,1]],[9,-26.1111,-23.2222,[1]],[16,-15.8889,-20.1111,[1]],[33,-9.2222,-15.2222,[1]],[50,-13.2222,-.5556,[1]],[67,-23.4445,24.3333,[1]],[84,-40.3333,55.8889,[1]],[90,-51.8889,71,[0,1]],[101,-65.2222,84.7778,[0,1]],[116,-95.8889,105.6667,[0,1]]];
const placement:Point[]=[[-114,214.2222,-231.66667,[0]],[-98,192.8889,-206.77778,[0]],[-93,182.6667,-196.11111,[0]],[-90,175.5556,-189,[0,1]],[-80,147.5556,-163.2222,[0,1]],[-63,89.3333,-117,[0,1]],[-52,44.88889,-85.4444,[1]],[-47,29.77778,-75.2222,[1]],[-30,-21.33333,-37,[1]],[-15,-39.111111,-13,[1]],[3,-39.555556,2.1111,[1]],[13,-34.666667,5.6667,[0]],[19,-30.666667,6.1111,[0]],[36,-13.77778,5.2222,[0]],[53,10.66667,3.4445,[0]],[70,44.88889,4.7778,[0]],[76,63.55556,6.1111,[0,1]],[86,94.2222,8.7778,[0,1]],[102,146.6667,13.2222,[0,1]],[120,194.2222,19.8889,[0,1]]];
function fixture(kind:"arrival"|"placement",fault?:"no-best"|"extra-contact"|"attempt-time"|"selection-time"|"extra-policy"){
 const scale=36.49495315551758/(kind==="arrival"?34.2540397644043:34.70222091674805),points=kind==="arrival"?arrival:placement,
  frames=[{time:850,position:{x:300+points[0][1]*scale,y:192+points[0][2]*scale},actions:[]},
   ...points.map(([t,x,y,actions])=>({time:1000+t,position:{x:300+x*scale,y:192+y*scale},actions:[...actions]})),
   {time:1250,position:{x:650,y:400},actions:[]}];
 if(fault==="no-best")for(const f of frames)if(f.time>=986&&f.time<1090)f.actions=f.actions.filter(a=>a!==1);
 if(fault==="extra-contact")frames.find(f=>f.time===949)!.position={x:300,y:192};
 const f=errorFixture("300,192,1000,1,0",frames),trace=JSON.parse(JSON.stringify(f.trace)) as typeof f.trace;
 const attempt=trace.records.find(r=>r.kind==="attempt"&&r.timeMs===(kind==="arrival"?907:910))!;
 const selection=trace.records.find(r=>r.kind==="selection"&&r.attemptId===attempt.id)!;
 if(fault==="attempt-time")attempt.timeMs++;
 if(fault==="selection-time")selection.timeMs++;
 if(fault==="extra-policy")Object.assign(trace,{records:[...trace.records,{id:"fake-policy",sequence:trace.records.length,kind:"policy",phase:"dispatch",timeMs:attempt.timeMs,attemptId:attempt.id,componentId:"0",state:"rejected",branch:"stable:STABLE",blockerId:"1",timingResult:"OK",offsetMs:-90}]});
 const e=deriveCircleEvidence(trace,f.map,"0"),
  pressIds=e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.freshActionsKnown&&i.record.freshActions.length===1).map(i=>i.record.id);
 return {...comparePrimaryApproaches(e,f.map,{pressIds},trace),classified:classifyCircleLoss(e,f.map,trace)};
}
describe("causal role of a unique best-window aim opportunity",()=>{
 it.each([["arrival","aim-late"],["placement","misaim"]] as const)("retains %s with both flanking timing alternatives",(kind,code)=>{
  const r=fixture(kind);expect(r.ranking.selected.map(c=>c.code)).toEqual([code]);
  expect(r.ranking.reason).toBe("shared-best-window-tolerance");
  expect(r.ranking.attribution?.roles.rule).toBe("witnessed-contextual-attempt");
  expect(r.candidates.some(c=>c.code==="early-tap")).toBe(true);expect(r.candidates.some(c=>c.code==="late-tap")).toBe(true);
  const primary=r.classified.diagnostics!.primary!,chosen=primary.ranking?.selected??primary.rawOpportunityComparison?.ranking.selected??[],
    marker=chosen.find(c=>c.support?.bestWindowAim?.role==="best-window-aim")?.support?.bestWindowAim;
  expect(marker).toBeDefined();expect(marker!.eventIds.every(id=>r.classified.eventIds.includes(id))).toBe(true);
 });
 it.each(["no-best","extra-contact","attempt-time","selection-time","extra-policy"] as const)("does not infer the role with %s",fault=>{
  expect(fixture("arrival",fault).ranking.attribution?.roles.rule).not.toBe("witnessed-contextual-attempt");
 });
});
