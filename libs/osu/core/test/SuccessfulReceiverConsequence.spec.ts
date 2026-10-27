import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(classic=false, fault="", repair=false) {
  const times=[...new Set([...Array.from({length:121},(_,i)=>800+5*i),1108,1119,1196,1291])].sort((a,b)=>a-b);
  const frames=times.flatMap(t=>{
    const prior=repair?1119:fault==="expiry-edge"?1115:1108;
    const actions=t===prior&&fault!=="no-prior"?[1]:t===1196?[0]:t===1291?[1]:[];
    const q=traceFrame(t,fault==="late-reentry"&&t===1320?218:t<1100?400:t<1250?210:400,actions,actions.reduce((n,a)=>n|(a?10:5),0));
    return fault==="held-duplicate"&&t===1196?[q,{...q}]:[q];
  });
  const f=errorFixture("100,192,1000,1,0\n200,192,1114,1,0\n218,192,1228,1,0",frames,
    classic?"lazer":"stable",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
  return {...f,frames};
}
const cause=(f:ReturnType<typeof fixture>,trace=f.trace,excluded?:ReadonlySet<string>)=>
  classifyCircleLoss(deriveCircleEvidence(trace,f.map,"2"),f.map,trace,excluded);
describe("successful receipt after a distinct rejected opportunity",()=>{
  it.each([false,true])("keeps the established lost opportunity ahead of failed recovery (Classic=%s)",classic=>{
    const f=fixture(classic),fixed=fixture(classic,"",true),c=cause(f);
    expect(f.state.hitCircleVerdict["1"].type).toBe("MEH");
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(fixed.state.hitCircleVerdict["2"]).toMatchObject({type:"OK",judgementTime:1196});
    expect(fixed.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
    expect(c.headline).toBe("Notelock");
    expect(c.diagnostics?.primary?.directRejections).toEqual([]);
    expect(c.diagnostics?.primary?.receiverConsequence).toMatchObject({receiverOutcome:"successful-consumption",targetPolicy:{actualBlockers:["1"],afterPriorReceiverSuccess:[]}});
  });
  it("accepts an identical held duplicate without inventing another press",()=>expect(cause(fixture(false,"held-duplicate")).headline).toBe("Notelock"));
  it("does not infer a rejection from ordinary successful consumption",()=>expect(cause(fixture(false,"no-prior")).headline).not.toBe("Notelock"));
  it("preserves an independent re-entry after the last failed pulse",()=>expect(cause(fixture(false,"late-reentry")).diagnostics?.primary?.receiverConsequence).toBeUndefined());
  it("orders the same-frame rejected receipt before blocker expiry",()=>{
    const f=fixture(false,"expiry-edge"),policy=f.trace.records.find(r=>r.kind==="policy"&&r.timeMs===1115&&r.componentId==="1")!;
    const end=f.trace.records.find(r=>r.kind==="resolution"&&r.componentId==="0")!;
    expect(policy).toMatchObject({state:"rejected",blockerId:"0"});expect(policy.sequence).toBeLessThan(end.sequence);
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
  });
  it.each([false,true])("recomputes an independent prefix slider blocker after successful receipt (Classic=%s)",classic=>{
    const original=fixture(classic),f=errorFixture("450,192,400,2,0,L|614:192,1,164\n100,192,1000,1,0\n200,192,1114,1,0\n218,192,1228,1,0",original.frames,classic?"lazer":"stable",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
    expect(f.state.hitCircleVerdict["2"].type).toBe("MEH");
    const c=classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"3"),f.map,f.trace);
    expect(c.diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
  it("does not skip the Classic equal-time receiver exposed by the repair",()=>{
    const original=fixture(true),f=errorFixture("100,192,1000,1,0\n200,192,1114,1,0\n218,192,1228,1,0\n218,192,1228,1,0",original.frames,"lazer",[],[{acronym:"CL",settings:{classic_note_lock:true}}]);
    expect(f.state.hitCircleVerdict["1"].type).toBe("MEH");
    expect(classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"2"),f.map,f.trace).diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
  it.each(["0","1","2"])("honors excluded supporting object%s without cache contamination",id=>{
    const f=fixture();expect(cause(f,f.trace,new Set([id])).diagnostics?.primary?.receiverConsequence).toBeUndefined();
    expect(cause(f).headline).toBe("Notelock");
  });
  it.each(["gap","prior-offset","resolution-grade","prior-after-expiry"])("withholds inconsistent %s proof",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>{
      if(fault==="gap"&&r.kind==="input"&&r.timeMs===1150)return {...r,source:{...r.source,discontinuityBefore:["test"]}};
      if(fault==="prior-offset"&&r.kind==="policy"&&r.timeMs===1108)return {...r,offsetMs:0};
      if(fault==="resolution-grade"&&r.kind==="resolution"&&r.componentId==="1")return {...r,result:"GREAT" as const};
      if(fault==="prior-after-expiry"&&r.kind==="resolution"&&r.componentId==="0")return {...r,sequence:0};
      return r;
    })};
    expect(cause(f,trace).diagnostics?.primary?.receiverConsequence).toBeUndefined();
  });
});
