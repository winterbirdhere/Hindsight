import { compareTargetCadence } from "../src/gameplay/error-analysis/PrimaryCadenceComparison";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { deriveTargetCadence } from "../src/gameplay/error-analysis/StreamCadenceEvidence";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";

// Bounded, rounded motion and cadence fixture; no replay file or historical
// receipt is needed. The ordered jump is outside the target's nominal flow.
function fixture() {
  const points: Array<[number, number, number, number[]]> = [
    [722,160.4,36.9,[1]],[854,162.2,38.7,[]],[855,162.2,40.4,[]],[884,166.7,63.1,[]],
    [906,171.1,77.3,[]],[923,176.4,89.3,[]],[940,183.6,103.6,[]],[954,191.1,116,[]],
    [972,197.3,124.4,[]],[990,199.6,128,[]],[1017,200.9,130.2,[1]],[1038,200.9,131.6,[1]],
    [1054,200.4,133.3,[1]],[1072,195.1,135.1,[1]],[1072,194.7,135.6,[0,1]],
    [1101,172.4,137.8,[0]],[1123,155.6,139.6,[0]],[1139,146.2,140.9,[0]],
    [1157,139.6,142.2,[0,1]],[1173,136,142.2,[0,1]],[1190,132.9,141.8,[0,1]],
    [1205,130.7,140.4,[1]],[1222,127.6,138.7,[1]],[1240,123.6,136.4,[0,1]],
    [1256,119.6,133.8,[0,1]],[1271,115.1,131.6,[0,1]],[1289,109.8,128.4,[0]],
    [1304,107.1,126.2,[0]],[1321,106.2,125.3,[0,1]],[1339,105.3,124.4,[0,1]],
    [1368,102.2,120.9,[1]],[1390,94.7,114.2,[0,1]],[1407,86.7,107.6,[0,1]],
    [1427,75.1,98.2,[0]],[1454,61.8,83.6,[0]],[1481,53.3,75.6,[0,1]],
    [1510,52.4,75.1,[1]],[1539,52.4,75.1,[1]],[1554,48.9,76,[0,1]],
    [1572,42.7,78.7,[0,1]],[1706,73.8,215.1,[1]],
  ];
  return errorFixture(
    [[227,144,1000],[203,147,1057],[178,148,1115],[153,146,1173],[129,142,1231],
      [106,133,1288],[85,119,1346],[70,100,1404],[57,78,1461]].map(p=>p.join(",")+",1,0").join("\n"),
    points.map(([time,x,y,actions])=>({time,position:{x,y},actions})),
  );
}

describe("dedicated cadence counterevidence is separate from ordinary observation admission", () => {
  it("keeps supported cadence while refusing movement across an ordered jump", () => {
    const f=fixture(),before=JSON.stringify([f.trace,f.state]),e=deriveCircleEvidence(f.trace,f.map,"2"),
      cadence=deriveTargetCadence(e,f.map,f.trace)!,association=derivePrimaryInputEvidence(e,f.map,f.trace);
    expect(cadence).toBeDefined();
    const compared=comparePrimaryApproaches(e,f.map,{
      pressIds:cadence.binding.rawLiveInputIds,
    });
    expect(compared.complete).toBe(false);
    expect(compared.candidates.some(c=>c.recordedFailure==="recorded-leading-position-discontinuity")).toBe(true);
    // The all-input counterevidence branch has no inferred ownership scope.
    const collective=compareTargetCadence(e,f.map,{...association,stream:undefined},cadence);
    expect(collective.complete).toBe(false);
    expect(collective.selected.map(c=>c.code)).toEqual(["slow-tapping"]);
    expect(JSON.stringify([f.trace,f.state])).toBe(before);
  });
});
