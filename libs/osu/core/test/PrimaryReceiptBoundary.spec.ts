import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";
import { analyzePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproach";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { laterApproachStart, latestOtherReceiptBoundary } from "../src/gameplay/error-analysis/PrimaryReceiptBoundary";

describe("far-edge return belongs to the approach after another object's receipt", () => {
  function fixture(after: boolean, slider = false, nullPress = false) {
    const frames = (after ? [[900,150],[970,200],[980,260],[990,300],[995,347],[1000,338],[1010,300],[1200,300]] :
      [[900,230],[920,250],[940,300],[960,346],[970,346],[975,345],[990,342],[1000,338],[1040,300],[1200,300]])
      .map(([t,x]) => traceFrame(t,x,t >= 1000 ? [0,1] : t >= 970 ? [0] : []));
    const previous = nullPress ? 500 : after ? 200 : 346;
    const note = slider ? `${previous},192,970,2,0,L|${previous+10}:192,1,10` : `${previous},192,970,1,0`;
    const f = errorFixture(`${note}\n300,192,1000,1,0`,frames);
    const e = deriveCircleEvidence(f.trace,f.map,"1");
    const p = e.inputs.find(i=>i.record.timeMs===1000)!;
    const context={pressIds:[p.record.id]};
    return {...f,e,p,context};
  }
  it.each([false,true])("does not borrow a deep pass and crest before a foreign receipt (slider=%s)",slider=>{
    const f=fixture(false,slider),ordinary=analyzePrimaryApproaches(f.e,f.context).episodes[0];
    expect(ordinary.farEdgeReturn).toBeDefined();
    const compared=comparePrimaryApproaches(f.e,f.map,f.context,f.trace).approaches.episodes[0];
    expect(compared.farEdgeReturn).toBeUndefined();
    const {farEdgeReturn:_a,...before}=ordinary, {farEdgeReturn:_b,...after}=compared;
    expect(after).toEqual(before);
  });
  it("keeps a complete return after the other receipt",()=>{
    const f=fixture(true),compared=comparePrimaryApproaches(f.e,f.map,f.context,f.trace).approaches.episodes[0];
    expect(compared.farEdgeReturn).toBeDefined();
    for(const id of compared.farEdgeReturn!.eventIds){
      const r=f.trace.records.find(r=>r.id===id)!;
      expect(r.timeMs).toBeGreaterThan(970);
    }
  });
  it("does not turn a null selection into a successful receipt boundary",()=>{
    const f=fixture(false,false,true);
    const compared=comparePrimaryApproaches(f.e,f.map,f.context,f.trace).approaches.episodes[0];
    expect(compared.farEdgeReturn).toBeDefined();
  });
  it.each([900,930,970,990])("uses successful receipts at any timing offset (note time %s)",time=>{
    const f=errorFixture(`200,192,${time},1,0\n300,192,1000,1,0`,
      [traceFrame(800,200),traceFrame(970,200,[0]),traceFrame(980,250),traceFrame(1000,338,[1]),traceFrame(1200)]);
    const e=deriveCircleEvidence(f.trace,f.map,"1"),p=e.inputs.find(i=>i.record.timeMs===1000)!.record;
    const b=latestOtherReceiptBoundary(f.trace,f.map,"1",p)!;
    expect(b).toMatchObject({componentId:"0",parentId:"0",timeMs:970,inclusive:false});
    const receipt=f.trace.records.find(r=>r.id===b.eventId);
    expect(receipt).toMatchObject({kind:"resolution",mechanism:"successful-input"});
    expect(latestOtherReceiptBoundary(f.trace,f.map,"0",p)).toBeUndefined();
  });
  it("orders same-time receipt and press by their source sequence",()=>{
    const f=fixture(false),b=latestOtherReceiptBoundary(f.trace,f.map,"1",f.p.record)!;
    expect(latestOtherReceiptBoundary(f.trace,f.map,"1",{...f.p.record,timeMs:b.timeMs,sequence:b.sequence+1})).toEqual(b);
    expect(latestOtherReceiptBoundary(f.trace,f.map,"1",{...f.p.record,timeMs:b.timeMs,sequence:b.sequence-1})).toBeUndefined();
  });
  it("preserves the full relevant press context when rerunning after a foreign receipt",()=>{
    const f=errorFixture("200,192,970,1,0\n300,192,1000,1,0",[
      traceFrame(900,150),traceFrame(970,200,[0]),traceFrame(980,260,[0,1]),traceFrame(990,300,[0]),
      traceFrame(995,347,[0]),traceFrame(1000,338,[0,1]),traceFrame(1010,300,[0,1]),traceFrame(1200)]);
    const e=deriveCircleEvidence(f.trace,f.map,"1"),press=e.inputs.find(i=>i.record.timeMs===1000)!.record,
      nullPress=e.inputs.find(i=>i.record.timeMs===980)!.record,context={pressIds:[nullPress.id,press.id]},
      boundary=latestOtherReceiptBoundary(f.trace,f.map,"1",press)!;
    const ordinary=analyzePrimaryApproaches(e,context).episodes.find(ep=>ep.inputId===press.id)!;
    expect(ordinary.eventIds).toContain(boundary.inputId); // Forces the scoped rerun.
    const expected=analyzePrimaryApproaches(e,{...context,start:boundary}).episodes.find(ep=>ep.inputId===press.id)!.farEdgeReturn!;
    const actual=comparePrimaryApproaches(e,f.map,context,f.trace).approaches.episodes.find(ep=>ep.inputId===press.id)!.farEdgeReturn!;
    expect(expected).toBeDefined();
    expect(actual).toEqual({...expected,receiptBoundary:boundary});
  });
  it("intersects rather than replaces stricter whole-time and per-input fences",()=>{
    const b={timeMs:970,sequence:10,inclusive:false};
    expect(laterApproachStart({timeMs:970,inclusive:false},b)).toEqual({timeMs:970,inclusive:false});
    expect(laterApproachStart({timeMs:970,inclusive:true},b)).toEqual(b);
    expect(laterApproachStart({timeMs:980,inclusive:true},b)).toEqual({timeMs:980,inclusive:true});
    const f=fixture(true),context={...f.context,inputScopes:{[f.p.record.id]:{start:{timeMs:997,inclusive:false}}}};
    expect(comparePrimaryApproaches(f.e,f.map,context,f.trace).approaches.episodes[0].farEdgeReturn).toBeUndefined();
  });
});
