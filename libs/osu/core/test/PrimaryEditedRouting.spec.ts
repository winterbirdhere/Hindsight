import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { correctionRoutingHorizon } from "../src/gameplay/error-analysis/StableHoldPreservation";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

describe("timing correction follows the edited dispatch",()=>{
  const objects="100,192,1000,1,0\n200,192,1090,1,0\n300,192,1230,2,0,L|314:192,1,14";
  const points=[[700,500,0],[900,500,0],[1000,100,0],[1030,500,0],[1105,200,1],[1111,500,0],
    [1160,300,2],[1230,300,2],[1240,302,2],[1270,308,2],[1300,314,0]];
  it("does not relay a circle cascade through the pulse removed by its own correction",()=>{
    const frames=points.map(([t,x,mask])=>traceFrame(t,x,[...(mask&1?[0]:[]),...(mask&2?[1]:[])])),
      fixedFrames=frames.map(q=>q.time>=1000&&q.time<1111?{...q,actions:[...new Set([...q.actions,0])]}:q),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,fixedFrames),e=deriveCircleEvidence(f.trace,f.map,"0"),
      old=e.inputs.find(i=>i.record.timeMs===1105)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(fixed.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
    expect(fixed.state.hitCircleVerdict["2/HEAD"]).toEqual(f.state.hitCircleVerdict["2/HEAD"]);
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,old.record.id,[sample.record.id],"sampled-pass-tap",[old.record.id])).toBeDefined();
  });
  it("retains a distinct fresh circle contact and the following head cascade",()=>{
    const frames=points.flatMap(([t,x,mask])=>[
      traceFrame(t,x,[...(mask&1?[0]:[]),...(mask&2?[1]:[])]),
      ...(t===1030?[traceFrame(1095,200,[1]),traceFrame(1100,500)]:[]),
    ]),f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"0"),
      old=e.inputs.find(i=>i.record.timeMs===1105)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    const inputs=f.trace.records.filter((r):r is typeof old.record=>r.kind==="input"),
      horizon=correctionRoutingHorizon(f.map,f.trace,inputs,inputs.findIndex(q=>q.id===sample.record.id),"0",{inputId:old.record.id,action:0});
    expect(horizon?.componentIds).toContain("1");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,old.record.id,[sample.record.id],"sampled-pass-tap",[old.record.id])).toBeUndefined();
  });
});
