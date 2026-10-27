import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { recordedInputChains } from "../src/gameplay/error-analysis/RecordedInputChain";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function rootFixture(slider = false, nullAt970 = false) {
  const previous = slider ? "346,192,970,2,0,L|356:192,1,10" : `346,192,${nullAt970 ? 800 : 970},1,0`;
  const frames = [
    ...(nullAt970 ? [traceFrame(700,346),traceFrame(800,346,[0]),traceFrame(810,230)] : []),
    traceFrame(900,230),traceFrame(920,250),traceFrame(940,300),traceFrame(960,346),
    traceFrame(970,346,[0]),traceFrame(975,345,[0]),traceFrame(990,342),
    traceFrame(1000,338,[1]),traceFrame(1005,340),traceFrame(1010,300),
    traceFrame(1080,300,[0]),traceFrame(1085,300),traceFrame(1300,300),
  ];
  return errorFixture(`${previous}\n300,192,1000,1,0\n300,192,1100,1,0`,frames);
}

describe("chain-root comparison stays after the previous successful receipt",()=>{
  it.each([false,true])("does not borrow an earlier target pass from a foreign landing (slider=%s)",slider=>{
    const f=rootFixture(slider),state=JSON.stringify(f.state),trace=JSON.stringify(f.trace),a=buildErrorAnalysis(f.trace,f.map);
    expect(f.state.hitCircleVerdict["1"]).toMatchObject({type:"MEH",judgementTime:1080});
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(f.trace.records).toEqual(expect.arrayContaining([expect.objectContaining({kind:"resolution",componentId:slider?"0/HEAD":"0",mechanism:"successful-input",result:"GREAT",timeMs:970})]));
    expect(a.incidents.find(i=>i.componentId==="1")?.mechanism.headline).toBe("Late tap");
    expect(a.incidents.find(i=>i.componentId==="2")?.mechanism).toMatchObject({
      headline:"Late entry",chain:{start:{componentId:"1",timeMs:1000},disposition:"inherited",cause:{codes:["aim-late"]},
        opportunities:[expect.objectContaining({kind:"taken",receiverId:"1",receiverResult:"MEH"})],certification:{status:"observation"}},
    });
    expect(JSON.stringify(f.state)).toBe(state);expect(JSON.stringify(f.trace)).toBe(trace);
  });
  it("does not treat a null press as a successful-receipt boundary",()=>{
    const f=rootFixture(false,true),a=buildErrorAnalysis(f.trace,f.map),e=deriveCircleEvidence(f.trace,f.map,"1"),
      p=e.inputs.find(i=>i.record.timeMs===1000)!.record,next=e.inputs.find(i=>i.record.timeMs===1080)!.record,
      original=comparePrimaryApproaches(e,f.map,{pressIds:[p.id],end:{timeMs:next.timeMs,sequence:next.sequence,inclusive:false,eventId:next.id}},f.trace).ranking.selected;
    expect(f.trace.records.some(r=>r.kind==="resolution"&&r.timeMs===970)).toBe(false);
    expect(original).toHaveLength(1);expect(original[0].code).not.toBe("aim-late");
    expect(a.incidents.find(i=>i.componentId==="2")?.mechanism).toMatchObject({codes:original.map(c=>c.code),chain:{start:{componentId:"1",timeMs:1000}}});
  });
  it("retains a protected label while updating only its linked initiating cause",()=>{
    const f=rootFixture(),e=deriveCircleEvidence(f.trace,f.map,"2"),original={...classifyCircleLoss(e,f.map,f.trace),codes:["notelock"],headline:"Notelock"};
    const result=recordedInputChains(f.map,f.trace).apply(e,original);
    expect(result).toMatchObject({codes:["notelock"],headline:"Notelock",chain:{disposition:"protected",start:{componentId:"1",timeMs:1000},cause:{codes:["aim-late"]}}});
    expect(result).not.toBe(original);
  });
});
