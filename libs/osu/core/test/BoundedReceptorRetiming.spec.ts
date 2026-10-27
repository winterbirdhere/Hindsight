import * as hold from "../src/gameplay/error-analysis/BoundedReceptorRetiming";
import { InputRecord } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";

const objects="220,192,950,1,0\n240,192,1000,1,0\n300,192,1100,2,0,L|314:192,2,14\n400,192,1300,2,0,L|414:192,2,14";
function frames(){
  return Array.from({length:191},(_,k)=>{
    const t=700+k*5,x=t<=950?220:t<=1050?220+(t-950)/5:t<1100?240+(t-1050)*1.2:
      t<=1170?300+(t-1100)/5:t<=1240?314-(t-1170)/5:t<1300?300+(t-1240)*5/3:
      t<=1370?400+(t-1300)/5:t<=1440?414-(t-1370)/5:400,
      intervals=[[950,1145,1],[1120,1350,0],[1320,1450,1],[1410,1600,0]];
    return traceFrame(t,x,[0,1].filter(a=>intervals.some(([s,e,b])=>b===a&&t>=s&&t<e)));
  });
}
describe("closed circle and slider-head retiming",()=>{
  it("preserves full ordered dispatch and body tracking for held earlier heads",()=>{
    const f=errorFixture(objects,frames()),inputs=f.trace.records.filter((q):q is InputRecord=>q.kind==="input"),
      plan=[["1",1120,1050],["2/HEAD",1320,1100],["3/HEAD",1410,1300]].map(([componentId,old,dest])=>({
        componentId:String(componentId),inputId:inputs.find(q=>q.timeMs===old)!.id,sampleId:inputs.find(q=>q.timeMs===dest)!.id,
        preserveHold:String(componentId).endsWith("/HEAD")})),
      fn=Reflect.get(hold,"certifyReceptorRetiming") as ((...a:unknown[])=>{changes:{inputId:string;actions:number[]}[];bodyPreservation:unknown[]})|undefined,
      proof=fn?.(f.map,f.trace,plan);
    expect(proof).toBeDefined();
    const changes=new Map(proof!.changes.map(c=>[c.inputId,c.actions])),original=frames(),fixed=errorFixture(objects,original.map((q,k)=>({
      ...q,actions:changes.get(inputs[k].id)??q.actions})));
    expect(fixed.state.hitCircleVerdict["1"]).toMatchObject({type:"OK",judgementTime:1050});
    expect(fixed.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
    expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
    expect(fixed.state.sliderVerdict).toEqual(f.state.sliderVerdict);
    expect(proof!.bodyPreservation).toHaveLength(2);
  });
  it.each(["head-release","source-gap","frame-gap","history","mask","duplicate-attempt","missing-receipt","excluded","late-destination"])(
    "refuses %s instead of assuming a repaired head preserves its body",fault=>{
      const f=errorFixture(objects,frames(),"stable",fault==="score-v2"?["SCORE_V2"]:[]),trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace,
        inputs=trace.records.filter((q):q is InputRecord=>q.kind==="input"),
        plan=[["1",1120,1050],["2/HEAD",1320,1100],["3/HEAD",1410,1300]].map(([componentId,old,dest])=>({
          componentId:String(componentId),inputId:inputs.find(q=>q.timeMs===old)!.id,sampleId:inputs.find(q=>q.timeMs===dest)!.id,
          preserveHold:fault!=="head-release"&&String(componentId).endsWith("/HEAD")}));
      for(const q of inputs)if(q.timeMs===1080){
        if(fault==="source-gap"&&q.source.origin==="parsed")q.source.discontinuityBefore=["gap"];
        if(fault==="frame-gap"&&q.source.origin==="parsed")q.source.parsedFrameIndex++;
        if(fault==="history")q.previousActions=[0];
        if(fault==="mask")q.rawButtonMask=0;
      }
      for(const r of trace.records){
        if(fault==="duplicate-attempt"&&r.kind==="attempt"&&r.timeMs===1120)r.attemptOrdinal=1;
        if(fault==="missing-receipt"&&r.kind==="resolution"&&r.componentId==="2/HEAD")r.triggerAttemptId="absent";
      }
      if(fault==="late-destination")plan[0].sampleId=inputs.find(q=>q.timeMs===1140)!.id;
      expect(hold.certifyReceptorRetiming(f.map,trace,plan,fault==="excluded"?new Set(["2"]):undefined)).toBeUndefined();
    });
  it("handles a shortened prefix hold received on the first canonical input",()=>{
    const source=[traceFrame(841,220,[1]),...frames().filter(q=>q.time>=845).map(q=>q.time<950?{...q,actions:[1]}:q)],
      f=errorFixture(objects,source),inputs=f.trace.records.filter((q):q is InputRecord=>q.kind==="input"),
      plan=[["1",1120,1050],["2/HEAD",1320,1100],["3/HEAD",1410,1300]].map(([componentId,old,dest])=>({
        componentId:String(componentId),inputId:inputs.find(q=>q.timeMs===old)!.id,sampleId:inputs.find(q=>q.timeMs===dest)!.id,preserveHold:String(componentId).endsWith("/HEAD")}));
    expect(hold.certifyReceptorRetiming(f.map,f.trace,plan)).toBeDefined();
  });
  it("validates the prepared kind of a retained receipt independently of self-consistent trace fields",()=>{
    const text=objects.replace("240,192,1000","200,192,997,1,0\n240,192,1000"),
      source=frames().map(q=>q.time===1070?{...q,position:{x:200,y:192},actions:[0,1]}:q),f=errorFixture(text,source),
      inputs=f.trace.records.filter((q):q is InputRecord=>q.kind==="input"),
      plan=[["2",1120,1050],["3/HEAD",1320,1100],["4/HEAD",1410,1300]].map(([componentId,old,dest])=>({
        componentId:String(componentId),inputId:inputs.find(q=>q.timeMs===old)!.id,sampleId:inputs.find(q=>q.timeMs===dest)!.id,preserveHold:String(componentId).endsWith("/HEAD")}));
    expect(hold.certifyReceptorRetiming(f.map,f.trace,plan)).toBeDefined();
    const trace=JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    for(const r of trace.records)if(r.timeMs===1070&&(r.kind==="selection"||r.kind==="resolution"))r.component="slider-head";
    expect(hold.certifyReceptorRetiming(f.map,trace,plan)).toBeUndefined();
  });
  it("cites the unchanged prefix receipt and lifecycle used to clear exact dispatch",()=>{
    const text=objects.replace("240,192,1000","240,192,997,1,0\n240,192,1000"),
      source=frames().map(q=>q.time>=1040&&q.time<1050?{...q,actions:q.actions.filter(a=>a!==1)}:q),f=errorFixture(text,source),
      inputs=f.trace.records.filter((q):q is InputRecord=>q.kind==="input"),
      plan=[["2",1120,1050],["3/HEAD",1320,1100],["4/HEAD",1410,1300]].map(([componentId,old,dest])=>({
        componentId:String(componentId),inputId:inputs.find(q=>q.timeMs===old)!.id,sampleId:inputs.find(q=>q.timeMs===dest)!.id,preserveHold:String(componentId).endsWith("/HEAD")})),
      proof=hold.certifyReceptorRetiming(f.map,f.trace,plan);
    expect(proof).toBeDefined();
    for(const r of f.trace.records)if((r.kind==="lifecycle"||r.kind==="resolution")&&r.componentId==="0")expect(proof?.eventIds).toContain(r.id);
  });
});
