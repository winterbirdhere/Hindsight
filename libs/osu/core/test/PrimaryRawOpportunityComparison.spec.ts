import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { rankPrimaryCandidates } from "../src/gameplay/error-analysis/PrimaryDiagnosisPolicy";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(strongerEarly=false,repair=false){
  const points=[[880,329.6667,306],[891,329,306],[907,316.3333,301.6667],...(strongerEarly?[[914,304.37498125,297.87501875]]:[]),
    [923,289,293],[933,266.6667,285.3333],[940,250.3333,280],[958,220.6667,271],[970,216.6667,270.3333],
    [974,216.6667,270.3333],[992,225.6667,276.6667],[1007,240.6667,288],[1019,258,301.6667],[1023,263.6667,306.6667],
    [1041,289.3333,330],[1044,293.6667,334],[1057,307,345.6667],[1074,311.6667,349.6667],[1090,308.3333,342],
    [1104,301.6667,324.6667],[1107,299.6667,320.3333],[1124,284.6667,288.3333],[1136,271,264.3333],[1140,267,257],
    [1170,251,251],[1190,251,251],[1191,251,251],[1210,251,251],[1240,291,251],[1300,291,251]];
  const frames=[traceFrame(0,329),...points.map(([t,x,y])=>({...traceFrame(t,x,[
    ...(t>=880&&t<970||t>=1019&&t<1136||t>=1190&&t<1191?[0]:[]),
    ...(t>=(strongerEarly?914:933)&&t<1044||t>=1104&&t<1300?[1]:[]),
  ]),position:repair&&t===1104?{x:222,y:272}:{x,y}})),traceFrame(1500,500)];
  return errorFixture("222,272,1000,1,0\n301,320,1088,1,0\n251,251,1176,2,0,L|291:251,1,40",frames);
}
describe("source-bounded raw opportunities survive narrow input scopes",()=>{
  it("compares a later usable aim correction against every raw competitor",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"0"),fixed=fixture(false,true);
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(fixed.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
    expect(fixed.state.hitCircleVerdict["2/HEAD"]).toEqual(f.state.hitCircleVerdict["2/HEAD"]);
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
    const result=classifyCircleLoss(e,f.map,f.trace);
    expect(result.headline).toBe("Late tap");
    expect(result.diagnostics?.primary?.ranking?.selected[0].attribution?.tapOffsetMs).toBe(19);
    expect(result.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
    expect(result.diagnostics?.primary?.ranking?.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
  });
  it("keeps the same nearest recorded verdict when an earlier press changes",()=>{
    const f=fixture(true),e=deriveCircleEvidence(f.trace,f.map,"0"),ids=e.inputs.filter(i=>i.inLiveSuccess&&!i.postTerminal&&i.record.freshActions.length===1).map(i=>i.record.id),
      c=comparePrimaryApproaches(e,f.map,{pressIds:ids},f.trace),raw=rankPrimaryCandidates(c.candidates,ids);
    expect(c.candidates.some(p=>p.code==="misaim")).toBe(true);
    expect(raw.selected.map(p=>p.code)).toEqual(["late-tap"]);
    expect(raw.selected[0].attribution?.tapOffsetMs).toBe(19);
    expect(raw.selected[0].support?.correction).toBeUndefined();
    expect(raw.selected[0].observationOnly).toBe(true);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
  });
});
