import * as hold from "../src/gameplay/error-analysis/StableHoldPreservation";
import { InputRecord } from "../src/gameplay/miss-explanation/CircleEvidence";
import { Slider } from "../src/hitobjects/Slider";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

const objects="220,192,950,1,0\n240,192,1000,1,0\n300,192,1100,2,0,L|314:192,2,14\n400,192,1300,2,0,L|414:192,2,14";
function frames(mode:"original"|"held"|"one-frame"){
  return Array.from({length:151},(_,k)=>{
    const t=900+k*5,x=t<=950?220:t<=1050?220+(t-950)/5:t<1100?240+(t-1050)*1.2:
      t<=1170?300+(t-1100)/5:t<=1240?314-(t-1170)/5:t<1300?300+(t-1240)*5/3:
      t<=1370?400+(t-1300)/5:t<=1440?414-(t-1370)/5:400,
      intervals=mode==="original"?[[950,1145,1],[1120,1350,0],[1320,1450,1],[1410,1600,0]]:
        mode==="held"?[[950,1095,1],[1050,1055,0],[1100,1450,1],[1300,1600,0]]:
          [[950,1095,1],[1050,1055,0],[1100,1105,1],[1300,1305,0]];
    return traceFrame(t,x,[0,1].filter(a=>intervals.some(([s,e,b])=>b===a&&t>=s&&t<e)));
  });
}
describe("complete edited-mask body preservation",()=>{
  it.each(["held","one-frame"] as const)("checks actual body state for %s head retiming",mode=>{
    const original=frames("original"),changed=frames(mode),f=errorFixture(objects,original),fixed=errorFixture(objects,changed),
      inputs=f.trace.records.filter((r):r is InputRecord=>r.kind==="input"),
      masks=new Map(inputs.flatMap(q=>{
        if(q.source.origin!=="parsed")throw Error("fixture source");
        const value=changed[q.source.parsedFrameIndex].actions.reduce((v,a)=>v|(1<<a),0),old=q.actions.reduce((v,a)=>v|(1<<a),0);
        return value===old?[]:[[q.id,value] as [string,number]];
      })),callbacks=[{componentId:"2/HEAD",time:1100},{componentId:"3/HEAD",time:1300}].map(c=>{
        const q=inputs.find(r=>r.timeMs===c.time)!,policy=f.trace.records.find(r=>r.kind==="policy"&&r.componentId===c.componentId&&r.state==="allowed")!;
        return {componentId:c.componentId,inputId:q.id,eventIds:[q.id,policy.id]};
      }),fn=Reflect.get(hold,"certifyStableMaskPreservation") as ((...args:unknown[])=>unknown)|undefined;
    expect(fixed.state.hitCircleVerdict["0"]).toEqual(f.state.hitCircleVerdict["0"]);
    expect(fixed.state.hitCircleVerdict["1"]).toMatchObject({type:"OK",judgementTime:1050});
    for(const id of ["2","3"]){
      expect(fixed.state.hitCircleVerdict[id+"/HEAD"].type).toBe("GREAT");
      const proof=fn?.(f.map.getHitObject(id) as Slider,f.trace,inputs,masks,callbacks);
      if(mode==="held"){
        expect(proof).toBeDefined();expect(fixed.state.sliderVerdict[id]).toBe(f.state.sliderVerdict[id]);
        expect(fixed.state.checkPointVerdict).toEqual(f.state.checkPointVerdict);
        expect(fn?.(f.map.getHitObject(id) as Slider,f.trace,inputs.slice(0,-1),masks,callbacks)).toBeUndefined();
        const reordered=[...inputs];[reordered[reordered.length-2],reordered[reordered.length-1]]=[reordered[reordered.length-1],reordered[reordered.length-2]];
        expect(fn?.(f.map.getHitObject(id) as Slider,f.trace,reordered,masks,callbacks)).toBeUndefined();
      }else{expect(proof).toBeUndefined();expect(fixed.state.sliderVerdict[id]).toBe("MEH");expect(f.state.sliderVerdict[id]).toBe("GREAT");}
    }
  });
});
