import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { derivePrimaryInputEvidence } from "../src/gameplay/error-analysis/PrimaryInputEvidence";
import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function expiryBoundary(repair=false){
  const times=[...new Set([...Array.from({length:121},(_,i)=>800+i*5),991,993,1112])].sort((a,b)=>a-b),
    frames=times.map(t=>traceFrame(t,127+(t-991)*93/119,[...(t>=991&&t<993?[0]:[]),...(t>=(repair?1020:1110)&&t<1112?[1]:[])]));
  return errorFixture("100,192,917,1,0\n145,192,1000,1,0\n190,192,1083,1,0",frames);
}
describe("preterminal failed receiver timing opportunity",()=>{
  it("uses an ordered rejection before expiry at the exact terminal timestamp",()=>{
    const fixture=(repair=false)=>{
      const times=[...new Set([...Array.from({length:121},(_,i)=>800+i*5).filter(t=>t<1100||t>1111),991,993,1111,1112])].sort((a,b)=>a-b);
      return errorFixture("100,192,917,1,0\n145,192,1000,1,0\n190,192,1083,1,0",times.map(t=>traceFrame(t,127+(t-991)*93/119,
        [...(t>=991&&t<993?[0]:[]),...(t>=(repair?1020:1111)&&t<1112?[1]:[])])));
    },f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"1"),late=e.inputs.find(i=>i.record.timeMs===1111)!,sample=e.inputs.find(i=>i.record.timeMs===1020)!;
    expect(late.inLiveSuccess).toBe(false);expect(late.inInteraction).toBe(false);expect(late.postTerminal).toBe(false);
    expect(e.terminal?.timeMs).toBe(1111);expect(late.record.sequence).toBeLessThan(e.terminal!.sequence);expect(e.directRejections).toEqual([]);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,late.record.id,[sample.record.id],"sampled-pass-tap",[late.record.id,sample.record.id])).toBeDefined();
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("Late tap");
    const fixed=fixture(true);expect(fixed.state.hitCircleVerdict["1"]).toMatchObject({type:"GREAT",judgementTime:1020});
    for(const id of ["0","2"])expect(fixed.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
  });
  it("keeps the original press outside live success while admitting a usable earlier correction",()=>{
    const f=expiryBoundary(),e=deriveCircleEvidence(f.trace,f.map,"1"),late=e.inputs.find(i=>i.record.timeMs===1110)!;
    expect(late.inLiveSuccess).toBe(false);expect(late.inInteraction).toBe(true);expect(late.postTerminal).toBe(false);
    expect(e.directRejections).toEqual([]);expect(e.terminal?.timeMs).toBe(1112);
    const association=derivePrimaryInputEvidence(e,f.map,f.trace);
    expect(association.associations.find(a=>a.inputId===late.record.id)?.role).toBe("context");
    const result=classifyCircleLoss(e,f.map,f.trace),rejection=e.routing.find(r=>r.kind==="policy"&&r.timeMs===1110)!;
    expect(result.headline).toBe("Late tap");
    expect(result.diagnostics?.primary?.ranking?.selected[0].support?.correction?.eventIds).toContain(rejection.id);
    expect(late.inLiveSuccess).toBe(false);
    const fixed=expiryBoundary(true);
    expect(fixed.state.hitCircleVerdict["1"]).toMatchObject({type:"GREAT",judgementTime:1020});
    for(const id of ["0","2"])expect(fixed.state.hitCircleVerdict[id]).toEqual(f.state.hitCircleVerdict[id]);
  });
  it.each(["source-gap","mask","history","allowed-policy","wrong-blocker","after-terminal","outside-interaction"])(
    "does not admit %s as a preterminal correction",fault=>{
      const f=expiryBoundary(),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
      for(const r of trace.records){
        if(r.kind==="input"&&r.timeMs===1110){
          if(fault==="source-gap"&&r.source.origin==="parsed")r.source.discontinuityBefore=["source-gap"];
          if(fault==="mask")r.rawButtonMask=0;
          if(fault==="history")r.previousActions=[1];
        }
        if(r.kind==="policy"&&r.timeMs===1110){
          if(fault==="allowed-policy")r.state="allowed";
          if(fault==="wrong-blocker")r.blockerId="0";
        }
      }
      const e=deriveCircleEvidence(trace,f.map,"1"),late=e.inputs.find(i=>i.record.timeMs===1110)!,sample=e.inputs.find(i=>i.record.timeMs===1020)!;
      if(fault==="after-terminal")late.postTerminal=true;
      if(fault==="outside-interaction")late.inInteraction=false;
      expect(certifyPrimaryOpportunity(e,f.map,trace,late.record.id,[sample.record.id],"sampled-pass-tap",[late.record.id,sample.record.id])).toBeUndefined();
    });
});
