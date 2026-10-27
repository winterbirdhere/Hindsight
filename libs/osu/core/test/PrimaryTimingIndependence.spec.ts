import { PrimaryCandidate, rankPrimaryCandidates } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { decidedCandidate } from "./PrimaryAttributionTestFixtures";
const candidates:PrimaryCandidate[]=[
  {code:"early-tap",headline:"Early tap",family:"timing",strength:2,independent:true,relationId:"a",inputIds:["a"],eventIds:["a"]},
  {code:"late-tap",headline:"Late tap",family:"timing",strength:1.9,independent:true,relationId:"b",inputIds:["b"],eventIds:["b"]},
];
it("does not equate different action IDs and comparable offsets with independent timing mistakes",()=>{
  expect(rankPrimaryCandidates(candidates).selected).toEqual([]);
});
it("preserves independently supported timing mistakes on distinct complete passages",()=>{
  const proved=candidates.map((c,k)=>({...decidedCandidate(c.code,c.inputIds[0],10+k),timingPass:{entryTimeMs:1000+k*100,exitTimeMs:1040+k*100}}));
  expect(rankPrimaryCandidates(proved).selected.map(c=>c.code)).toEqual(["early-tap","late-tap"]);
});
it.each([false,true])("conservatively merges duplicate passage proof without order dependence (missing=%s)",missing=>{
  const early={...candidates[0],timingPass:{entryTimeMs:0,exitTimeMs:10}},conflict={...early,timingPass:missing?undefined:{entryTimeMs:20,exitTimeMs:30}};
  const late={...candidates[1],timingPass:{entryTimeMs:22,exitTimeMs:28}},input=[early,conflict,late],before=JSON.stringify(input);
  expect(rankPrimaryCandidates(input).selected).toEqual([]);
  expect(rankPrimaryCandidates([conflict,early,late]).selected).toEqual([]);
  expect(JSON.stringify(input)).toBe(before);
});
it("does not use numerical dominance without certified per-press attribution",()=>{
  for(const second of [1.6,1.59]){
    const result=rankPrimaryCandidates([{...candidates[0],strength:2},{...candidates[1],strength:second}]);
    expect(result.selected).toEqual([]);
  }
  for(const first of [3.5,3.50001]){
    const result=rankPrimaryCandidates([{...candidates[0],strength:first},{...candidates[1],strength:2.8}]);
    expect(result.selected).toEqual([]);
  }
});
