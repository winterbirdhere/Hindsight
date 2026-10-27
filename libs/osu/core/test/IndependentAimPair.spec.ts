import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { certifyIndependentAimPair, certifyPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { comparePrimaryApproaches } from "../src/gameplay/error-analysis/PrimaryApproachComparison";

function fixture(repair:"none"|"prior"|"target"|"both"="none",fault="",priorTime=1020){
  const points:number[][]=[
    [700,136,40,0],[1008,134.2222,39.55556,10],[1020,136.4444,40.44444,15],
    [1025,136.8889,42.66667,15],[1035,136.8889,54.66667,5],[1041,137.3333,65.77778,5],
    [1059,137.7778,115.1111,5],[1075,131.5556,174.2222,5],[1091,121.3333,220.8889,5],
    [1100,115.1111,239.1111,15],[1101,114.2222,240.8889,15],[1109,108.8889,252,15],
    [1125,96.44444,260,15],[1139,85.77778,254.2222,10],[1142,84,252.4444,10],
    [1157,59.55556,225.7778,10],[1174,24.44444,183.5556,10],[1191,-5.777778,137.3333,10],
    [1195,-9.777778,128.8889,10],[1204,-12.88889,111.1111,15],[1208,-12,106.6667,15],
    [1224,11.11111,88,15],[1228,20.88889,85.33334,5],[1400,-12,111,0],
  ];
  const position=fault==="consumption"?{x:220,y:236}:{x:9,y:39};
  const frames=points.map(([time,x,y,mask])=>{
    if(["extra","timed-pass"].includes(fault)&&time===1059)mask=15;
    if(fault==="timed-pass"&&time===1041){x=204;y=236;}
    if(fault==="timed-pass"&&time>=1059&&time<=1125){x=204+(time-1041)*4;y=236;}
    return {time,position:time===priorTime&&(repair==="prior"||repair==="both")?{x:204,y:236}:
      time===1100&&(repair==="target"||repair==="both")?position:{x,y},
      actions:[...(mask&5?[0]:[]),...(mask&10?[1]:[])],rawButtonMask:mask};
  });
  return errorFixture((fault==="earlier-blocker"?"500,192,970,1,0\n":"")+
    `204,236,1000,1,0\n${position.x},${position.y},1094,1,0`,frames);
}

describe("separate aim mistakes behind a single unresolved predecessor",()=>{
  it("keeps blocked recorded arrival observation separate from compound repair research",()=>{
    const knots=[[700,0],[980,50],[1002,60],[1092,162],[1120,200],[1150,240],[1300,400]],
      times=[...new Set([...Array.from({length:121},(_,k)=>700+k*5),...knots.map(p=>p[0]),1005,1095])].sort((a,b)=>a-b),
      frames=times.map(t=>{const at=knots.findIndex(q=>q[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at];
        return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),[...(t>=1002&&t<1005?[0]:[]),...(t>=1092&&t<1095?[1]:[])]);}),
      f=errorFixture("100,192,1000,1,0\n200,192,1080,1,0",frames),e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1092)!,
      c=comparePrimaryApproaches(e,f.map,{pressIds:[q.record.id]},f.trace),arrival=c.candidates.find(x=>x.code==="aim-late");
    expect(arrival).toBeDefined();expect(arrival?.support?.compound).toBeUndefined();
    expect(c.ranking.selected[0].observationOnly).toBe(true);
    expect(c.candidates.filter(x=>x.family==="timing").every(x=>!x.support?.compound)).toBe(true);
    const fixed=errorFixture("100,192,1000,1,0\n200,192,1080,1,0",frames.map(q=>q.time===1002?{...q,position:{x:100,y:192}}:
      q.time===1092?{...q,position:{x:200,y:192}}:q));
    expect(Object.values(fixed.state.hitCircleVerdict).map(v=>v.type)).toEqual(["GREAT","GREAT"]);
  });
  it.each([1095,1105])("does not disturb a later spinner starting at %s through incoming or outgoing interpolation",start=>{
    const points:number[][]=[[700,136,40,0],[1008,134.2222,39.55556,10],[1020,136.4444,40.44444,15],
      [1025,136.8889,42.66667,15],[1035,136.8889,54.66667,5],[1041,137.3333,65.77778,5],
      [1059,137.7778,115.1111,5],[1075,131.5556,174.2222,5],[1091,121.3333,220.8889,5],[1100,115.1111,239.1111,15]];
    for(let time=1120;time<=1380;time+=20){const angle=1.247+.03*(time-1100);points.push([time,256+120*Math.cos(angle),192+120*Math.sin(angle),15]);}
    points.push([1500,256,192,0]);
    const frames=points.map(([time,x,y,mask])=>({...traceFrame(time,x,[...(mask&5?[0]:[]),...(mask&10?[1]:[])],mask),position:{x,y}})),
      objects=`204,236,1000,1,0\n9,39,1094,1,0\n256,192,${start},8,0,1400`,mods=[{acronym:"CL",settings:{classic_note_lock:true}}],
      f=errorFixture(objects,frames,"lazer",[],mods),changed=errorFixture(objects,frames.map(q=>q.time===1020?{...q,position:{x:204,y:236}}:
        q.time===1100?{...q,position:{x:9,y:39}}:q),"lazer",[],mods),e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1100)!;
    expect(f.state.spinnerVerdict["2"].type).toBe("GREAT");expect(changed.state.spinnerVerdict["2"].type).toBe("OK");
    expect(certifyIndependentAimPair(e,f.map,f.trace,q.record.id,[q.record.id])).toBeUndefined();
  });
  it("does not certify an aim edit that changes a preceding spinner through interpolation",()=>{
    const objects="256,192,700,8,0,1019\n204,236,1000,1,0\n9,39,1094,1,0\n500,192,1618,1,0",
      points:number[][]=[[600,136,40.21,0],[700,136,40.21,0],[800,136,40.21,2],[850,256,40,2],
        [900,376,192,2],[950,256,344,2],[1008,134.2222,39.55556,2],[1020,136.4444,40.44444,3],
        [1025,136.8889,42.66667,3],[1035,136.8889,54.66667,1],[1041,137.3333,65.77778,1],
        [1059,137.7778,115.1111,1],[1075,131.5556,174.2222,1],[1091,121.3333,220.8889,1],
        [1100,115.1111,239.1111,3],[1125,96.44444,260,3],[1208,-12,106.6667,3],[2000,-12,111,0]],
      frames=points.map(([time,x,y,mask])=>({...traceFrame(time,x,[...(mask&1?[0]:[]),...(mask&2?[1]:[])]),position:{x,y}})),
      mods=[{acronym:"CL",settings:{classic_note_lock:true}}],f=errorFixture(objects,frames,"lazer",[],mods),
      changed=errorFixture(objects,frames.map(q=>q.time===1020?{...q,position:{x:204,y:236}}:q),"lazer",[],mods),
      e=deriveCircleEvidence(f.trace,f.map,"1"),p=e.inputs.find(i=>i.record.timeMs===1020)!;
    expect(f.state.spinnerVerdict["0"].type).toBe("GREAT");expect(changed.state.spinnerVerdict["0"].type).toBe("OK");
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,p.record.id,[p.record.id],"same-time-aim",[p.record.id])).toBeUndefined();
    const target=deriveCircleEvidence(f.trace,f.map,"2"),q=target.inputs.find(i=>i.record.timeMs===1100)!;
    expect(certifyIndependentAimPair(target,f.map,f.trace,q.record.id,[q.record.id])).toBeUndefined();
  });
  it("requires two distinct aim corrections and preserves observed routing",()=>{
    const f=fixture(),e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1100)!,before=JSON.stringify(f.trace);
    expect(e.directRejections).toEqual([]);
    expect(certifyPrimaryOpportunity(e,f.map,f.trace,q.record.id,[q.record.id],"same-time-aim",[q.record.id])).toBeUndefined();
    const prior=fixture("prior"),target=fixture("target"),both=fixture("both");
    expect(prior.state.hitCircleVerdict["0"].type).toBe("GREAT");
    expect(prior.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
    expect(target.state.hitCircleVerdict).toEqual(f.state.hitCircleVerdict);
    expect(deriveCircleEvidence(target.trace,target.map,"1").directRejections.map(r=>r.blockerId)).toEqual(["0"]);
    expect(Object.values(both.state.hitCircleVerdict).map(v=>v.type)).toEqual(["GREAT","GREAT"]);
    const diagnosis=classifyCircleLoss(e,f.map,f.trace);
    expect(diagnosis.headline).toBe("Misaim");
    expect(diagnosis.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
    expect(diagnosis.diagnostics?.primary?.ranking?.attribution?.presses.some(p=>!p.tapFeasible&&p.aimFeasible)).toBe(true);
    expect(certifyIndependentAimPair(e,f.map,f.trace,q.record.id,[q.record.id])?.targetPolicy).toEqual({actualBlockers:["0"],afterPriorAimCorrection:[]});
    expect(JSON.stringify(f.trace)).toBe(before);
  });
  it("retains an earlier failed attempt when a distinct later placement supplies the prior correction",()=>{
    const f=fixture("none","extra"),e=deriveCircleEvidence(f.trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===1100)!,
      p=e.inputs.find(i=>i.record.timeMs===1059)!,proof=certifyIndependentAimPair(e,f.map,f.trace,q.record.id,[q.record.id]);
    expect(proof?.priorInputId).toBe(p.record.id);
    const prior=fixture("prior","extra",1059),target=fixture("target","extra",1059),both=fixture("both","extra",1059);
    expect(prior.state.hitCircleVerdict["0"].type).toBe("OK");expect(prior.state.hitCircleVerdict["1"]).toEqual(f.state.hitCircleVerdict["1"]);
    expect(target.state.hitCircleVerdict).toEqual(f.state.hitCircleVerdict);
    expect(Object.values(both.state.hitCircleVerdict).map(v=>v.type)).toEqual(["OK","GREAT"]);
  });
  it.each(["consumption","earlier-blocker","timed-pass"])("does not infer compound placement across %s",fault=>{
    const f=fixture("none",fault),id=fault==="earlier-blocker"?"2":"1",e=deriveCircleEvidence(f.trace,f.map,id);
    const q=e.inputs.find(i=>i.record.timeMs===1100)!;
    expect(certifyIndependentAimPair(e,f.map,f.trace,q.record.id,[q.record.id])).toBeUndefined();
  });
  it.each(["same-pulse","source-gap","raw-mask","automated","excluded-prior","excluded-target","missing-route"])(
    "retains the %s safeguard for a conditional correction",fault=>{
      const f=fixture();let trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
      for(const r of trace.records){
        if(r.timeMs!==1100)continue;
        if(fault==="source-gap"&&r.kind==="input"&&r.source.origin==="parsed")r.source.discontinuityBefore=["source-gap"];
        if(fault==="raw-mask"&&r.kind==="input")r.rawButtonMask=0;
        if(fault==="automated"&&r.kind==="attempt")r.automated=true;
      }
      if(fault==="missing-route")trace={...trace,records:trace.records.filter(r=>!(r.kind==="attempt"&&r.timeMs===1100))};
      const e=deriveCircleEvidence(trace,f.map,"1"),q=e.inputs.find(i=>i.record.timeMs===(fault==="same-pulse"?1020:1100))!,
        excluded=new Set(fault==="excluded-prior"?["0"]:fault==="excluded-target"?["1"]:[]);
      expect(certifyIndependentAimPair(e,f.map,trace,q.record.id,[q.record.id],excluded)).toBeUndefined();
    });
});
