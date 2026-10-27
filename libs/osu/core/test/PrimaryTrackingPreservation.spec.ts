import { certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function aimFixture(next:number,x=100,corrected=false){
  const frames=[[700,300,0],[900,300,0],[1020,300,0],[1040,302,1],[1050,304,3],
    [next,300+(next-1030)*.2,3],[1105,314,3],[1250,314,0]]
    .map(([t,px,mask])=>traceFrame(t,corrected&&t===1050?x:px,[...(mask&1?[0]:[]),...(mask&2?[1]:[])]));
  return errorFixture(`${x},192,1000,1,0\n300,192,1030,2,0,L|314:192,1,14`,frames);
}
describe("correction preserves unrelated Stable tracking",()=>{
  it("does not mistake the recording end for converged history before a future body",()=>{
    const objects="100,192,1000,1,0\n300,192,1300,2,0,L|314:192,1,14",
      frames=[[700,500,0],[900,500,0],[990,500,1],[1000,100,1],[1010,100,0],[1020,500,2],[1040,500,0],[1120,500,0]]
        .map(([t,x,mask])=>traceFrame(t,x,[...(mask&1?[0]:[]),...(mask&2?[1]:[])])),
      f=errorFixture(objects,frames),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1020)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    const fixed=errorFixture(objects,frames.map(r=>r.time>=1000&&r.time<1020?{...r,actions:[...r.actions,1]}:r));
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeUndefined();
  });
  it("does not require a future body terminal after histories converge without head contact",()=>{
    const objects="100,192,1000,1,0\n300,192,1300,2,0,L|314:192,1,14",
      frames=[[700,500,0],[900,500,0],[980,500,1],[1000,100,0],[1010,100,0],[1020,500,0],[1120,500,0]]
        .map(([t,x,mask])=>traceFrame(t,x,mask?[0]:[])),
      corrected=frames.map(q=>q.time===980?{...q,actions:[]}:q.time===1000?{...q,actions:[0]}:q),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,corrected),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===980)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(f.trace.records.some(r=>r.kind==="slider-parent"&&r.componentId==="1")).toBe(false);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeDefined();
    // Several later continuations preserve the actual body outcomes. The
    // certificate relies on converged state, not invented unrecorded inputs.
    for(const [x,actions] of [[300,[1]],[500,[1]],[300,[]]] as const){
      const suffix=[traceFrame(1300,x,[...actions]),traceFrame(1340,x,[...actions]),traceFrame(1400,x),traceFrame(1600,x)],
        before=errorFixture(objects,[...frames,...suffix]),after=errorFixture(objects,[...corrected,...suffix]);
      expect(after.state.hitCircleVerdict["1/HEAD"]).toEqual(before.state.hitCircleVerdict["1/HEAD"]);
      expect(after.state.checkPointVerdict).toEqual(before.state.checkPointVerdict);expect(after.state.sliderVerdict).toEqual(before.state.sliderVerdict);
    }
  });
  it("follows an unblocked circle before a still later head callback",()=>{
    const objects="100,192,1000,1,0\n200,192,1090,1,0\n300,192,1230,2,0,L|314:192,2,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,500,[]],[900,500,[]],[1000,100,[]],
        [1020,500,[0]],[1105,200,[0,1]],[1110,500,[0]],[1150,500,[0]],[1160,300,[0,1]],
        [1230,300,[0,1]],[1240,302,[0]],[1270,310,[0]],[1300,314,[0]],[1330,306,[0]],
        [1370,300,[0]],[1410,300,[]]],frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>q.time===1000?{...q,actions:[0]}:q)),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1020)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");expect(fixed.state.hitCircleVerdict["1"].type).toBe("GREAT");
    expect(fixed.state.hitCircleVerdict["2/HEAD"].type).toBe("MEH");
    expect(Object.values(f.state.checkPointVerdict).map(v=>v.hit)).toEqual([true,true]);
    expect(Object.values(fixed.state.checkPointVerdict).map(v=>v.hit)).toEqual([false,false]);
    expect(f.state.sliderVerdict["2"]).toBe("OK");expect(fixed.state.sliderVerdict["2"]).toBe("MEH");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeUndefined();
  });
  it.each(["stable","classic"] as const)("refuses an aim correction that enables a future head and damages its body (%s)",profile=>{
    const objects="100,192,1000,1,0\n300,192,1120,2,0,L|314:192,2,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,500,[]],[900,500,[]],[1000,500,[0]],
        [1105,300,[0,1]],[1120,300,[0,1]],[1130,302,[0]],[1160,310,[0]],
        [1190,314,[0]],[1220,306,[0]],[1260,300,[0]],[1300,300,[]]],
      frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      fixture=(source:typeof frames)=>errorFixture(objects,source,profile==="stable"?"stable":"lazer",[],profile==="classic"?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]),
      f=fixture(frames),fixed=fixture(frames.map(q=>q.time===1000?{...q,position:{x:100,y:192}}:q)),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(fixed.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
    expect(Object.values(f.state.checkPointVerdict).map(v=>v.hit)).toEqual(profile==="stable"?[true,true]:[true]);
    expect(Object.values(fixed.state.checkPointVerdict).map(v=>v.hit)).toEqual(profile==="stable"?[false,false]:[false]);
    expect(f.state.sliderVerdict["1"]).toBe("OK");expect(fixed.state.sliderVerdict["1"]).toBe("MEH");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeUndefined();
  });
  it.each([false,true])("preserves a clean aim repair before a native slider, Classic=%s",classic=>{
    const objects="100,192,1000,1,0\n300,192,1120,2,0,L|314:192,2,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,500,[]],[900,500,[]],[1000,500,[0]],
        [1105,500,[0,1]],[1120,300,[0,1]],[1130,302,[0]],[1160,310,[0]],
        [1190,314,[0]],[1220,306,[0]],[1260,300,[0]],[1300,300,[]]],
      frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      fixture=(source:typeof frames)=>errorFixture(objects,source,"lazer",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]),
      f=fixture(frames),fixed=fixture(frames.map(q=>q.time===1000?{...q,position:{x:100,y:192}}:q)),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeDefined();
  });
  it("preserves a neighbour receipt before the delayed target correction",()=>{
    const objects="100,192,1000,1,0\n150,192,1050,1,0\n130,192,1120,2,0,L|144:192,1,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,50,[]],[1000,50,[]],[1010,50,[0]],
        [1070,100,[0]],[1080,100,[0,1]],[1090,150,[0,1]],[1100,144,[1]],[1125,144,[1]],
        [1160,144,[1]],[1200,144,[]],[1300,144,[]]],frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>q.time>=1010&&q.time<1090?{...q,actions:q.actions.filter(a=>a!==0)}:q)),
      e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1010)!,sample=e.inputs.find(i=>i.record.timeMs===1090)!;
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["1"].type).toBe("OK");
    expect(fixed.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
    expect(fixed.state.hitCircleVerdict["2/HEAD"]).toEqual(f.state.hitCircleVerdict["2/HEAD"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeDefined();
  });
  it("checks a future slider head even when the edited button histories already converged",()=>{
    const objects="100,192,1000,1,0\n300,192,1050,2,0,L|314:192,2,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,500,[]],[900,500,[1]],[1000,100,[1]],
        [1020,500,[0,1]],[1025,500,[1]],[1060,302,[1]],[1070,304,[0,1]],[1110,312,[1]],
        [1125,314,[1]],[1160,306,[1]],[1200,300,[1]],[1250,300,[]]],frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>({...q,actions:q.time===1000?[...q.actions,0]:q.actions}))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1020)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");expect(fixed.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
    expect(Object.values(f.state.checkPointVerdict).map(v=>v.hit)).toEqual([true,true]);
    expect(Object.values(fixed.state.checkPointVerdict).map(v=>v.hit)).toEqual([false,false]);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeUndefined();
  });
  it("does not treat a later rejected head query as unchanged after repairing its blocker",()=>{
    const objects="100,192,1000,1,0\n300,192,1050,2,0,L|314:192,2,14",
      points:[[number,number,number[]],...[number,number,number[]][]]=[[700,500,[]],[900,500,[1]],[1000,100,[1]],[1030,280,[1]],
        [1060,302,[1]],[1065,500,[]],[1070,304,[1]],[1100,310,[0,1]],[1110,312,[0]],[1125,314,[0]],
        [1160,306,[0]],[1200,300,[0]],[1250,300,[]]],frames=points.map(([t,x,a])=>traceFrame(t,x,a)),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>({...q,actions:q.time>=1000&&q.time<1100?[...q.actions,0]:q.actions}))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1100)!,sample=e.inputs.find(i=>i.record.timeMs===1000)!;
    expect(fixed.state.hitCircleVerdict["0"].type).toBe("GREAT");expect(fixed.state.hitCircleVerdict["1/HEAD"].type).toBe("GREAT");
    expect(Object.values(f.state.checkPointVerdict).map(v=>v.hit)).toEqual([true,true]);
    expect(Object.values(fixed.state.checkPointVerdict).map(v=>v.hit)).toEqual([false,false]);
    expect(f.state.sliderVerdict["1"]).toBe("OK");expect(fixed.state.sliderVerdict["1"]).toBe("MEH");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeUndefined();
  });
  it("preserves body acceptance while two temporary latch states later converge",()=>{
    const objects="100,192,1000,1,0\n300,192,1045,2,0,L|314:192,1,14",
      frames=[700,900,1000,1030,1040,1048,1050,1060,1070,1090,1120,1250].map(t=>traceFrame(t,t===1030?100:300,
        [...(t>=1000&&t<1070?[0]:[]),...(t>=1050&&t<1090?[1]:[])])),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>({...q,actions:
        [...q.actions.filter(a=>a!==1),...(q.time>=1030&&q.time<1090?[1]:[])]}))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1050)!,sample=e.inputs.find(i=>i.record.timeMs===1030)!;
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeDefined();
  });
  it("recognizes restored button history before a later slider starts",()=>{
    const objects="100,192,1000,1,0\n300,192,1055,2,0,L|314:192,1,14",
      frames=[700,900,1000,1030,1040,1050,1060,1080,1120,1250].map(t=>traceFrame(t,t===1030?100:300,t===1050?[0]:[])),
      f=errorFixture(objects,frames),fixed=errorFixture(objects,frames.map(q=>({...q,actions:q.time>=1030&&q.time<1060?[0]:[]}))),
      e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1050)!,sample=e.inputs.find(i=>i.record.timeMs===1030)!;
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).not.toBe("MISS");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id])).toBeDefined();
  });
  it.each(["stable","lazer"] as const)("preserves spinner input history, including relocation onto the original release (%s)",profile=>{
    for(const hold of ["none","through-release","through-spinner"]){
      const objects="100,192,1000,1,0\n256,192,1030,8,0,1100",
        frames=[700,900,1000,1040,1050,1060,1070,1080,1120,1250].map(t=>traceFrame(t,t>=1070?100:300,
          [...(t>=1050&&t<1070?[0]:[]),...(hold!=="none"&&t>=1000&&t<(hold==="through-release"?1070:1120)?[1]:[])])),
        f=errorFixture(objects,frames,profile),fixed=errorFixture(objects,frames.map(q=>({...q,actions:
          [...q.actions.filter(a=>a!==0),...(q.time===1070?[0]:[])]})),profile),e=deriveCircleEvidence(f.trace,f.map,"0"),
        q=e.inputs.find(i=>i.record.timeMs===1050)!,sample=e.inputs.find(i=>i.record.timeMs===1070)!,
        oldSpin=f.trace.records.find(r=>r.kind==="spinner-resolution"),newSpin=fixed.trace.records.find(r=>r.kind==="spinner-resolution");
      expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).not.toBe("MISS");
      if(oldSpin?.kind!=="spinner-resolution"||newSpin?.kind!=="spinner-resolution")throw Error("missing spinner summary");
      const proof=certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[sample.record.id],"sampled-pass-tap",[q.record.id]);
      if(hold==="through-spinner"){
        expect(newSpin.summary).toEqual(oldSpin.summary);expect(proof).toBeDefined();
      }else{
        expect(newSpin.summary).not.toEqual(oldSpin.summary);expect(proof).toBeUndefined();
      }
    }
  });
  it.each([{next:1060,x:100},{next:1080,x:240}])("certifies equal tracking or convergence before the next deadline (%j)",({next,x})=>{
    const f=aimFixture(next,x),fixed=aimFixture(next,x,true),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1050)!;
    expect(f.state.hitCircleVerdict["0"].type).toBe("MISS");expect(fixed.state.hitCircleVerdict["0"].type).toBe("OK");
    expect(fixed.state.hitCircleVerdict["1/HEAD"]).toEqual(f.state.hitCircleVerdict["1/HEAD"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeDefined();
  });
  it("refuses reacquisition after a scored deadline even when the slider head missed",()=>{
    const f=aimFixture(1080),fixed=aimFixture(1080,100,true),e=deriveCircleEvidence(f.trace,f.map,"0"),q=e.inputs.find(i=>i.record.timeMs===1050)!;
    expect(f.state.hitCircleVerdict["1/HEAD"].type).toBe("MISS");
    expect(f.state.checkPointVerdict["1/0"].hit).toBe(true);expect(fixed.state.checkPointVerdict["1/0"].hit).toBe(false);
    expect(f.state.sliderVerdict["1"]).toBe("OK");expect(fixed.state.sliderVerdict["1"]).toBe("MISS");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeUndefined();
  });
});
