import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { stableGameplayRadius } from "../src/gameplay/StableHitGeometry";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { HitCircle } from "../src/hitobjects/HitCircle";

function fixture(priorTime:number){
 const objects=`500,50,${priorTime},1,0\n300,192,1000,1,0`,object=errorFixture(objects,[{time:1200,position:{x:0,y:0},actions:[]}]).map.getHitObject("1");
 if(!(object instanceof HitCircle))throw Error("fixture circle");const radius=stableGameplayRadius(object.radius),
  knots=[[850,1.294,-1.048],[867,.127,-.775],[878,-.911,-.905],[941,-1.988,-3.734],[950,-1.664,-4.162],[1000,2.254,-6.121],[1067,6.354,-3.370],[1100,4.058,-1.061],[1200,8,-3]],
  f=errorFixture(objects,knots.map(([time,x,y])=>({time,position:{x:300+x*radius,y:192+y*radius},actions:time===941||time===1100?[0]:[]}))),e=deriveCircleEvidence(f.trace,f.map,"1"),
  pressIds=e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length).map(i=>i.record.id);
 return comparePrimaryApproaches(e,f.map,{pressIds},f.trace);
}
describe("usable live movement versus an earlier unusable passage",()=>{
 it("describes the nearest prior graze as aim regardless of its certificate",()=>{
  const r=fixture(900);expect(r.ranking.selected.map(c=>c.code)).toEqual(["misaim"]);
  expect(r.ranking.selected[0].observationOnly).toBe(true);expect(r.ranking.selected[0].support).toBeUndefined();
  expect(r.ranking.selected[0].attribution?.tapOffsetMs).toBe(-59);
  expect(r.candidates.some(c=>c.code==="misaim"&&!c.support)).toBe(true);
 });
 it("retains an independently usable aim correction after a prior graze",()=>{
  const r=fixture(760);expect(r.ranking.selected.map(c=>c.code)).toEqual(["misaim"]);expect(r.ranking.selected[0].support).toBeDefined();
 });
});
