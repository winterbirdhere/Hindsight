import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(fault="",classic=false) {
  const beats=Array.from({length:12},(_,k)=>1000+114*k+(fault==="rhythm"&&k>=7?55:0));
  const offsets=fault==="constant"?Array(10).fill(40):[-19,1,8,16,20,34,48,51,51,56];
  if(fault==="reset")offsets[7]=-10;
  if(fault==="oscillation")offsets[8]=30;
  if(fault==="recovered")offsets[9]=0;
  if(fault==="phase-recovery")offsets[8]=0;
  const pulses=offsets.map((off,k)=>beats[k]+off);
  if(fault==="skip"||fault==="balanced")pulses.splice(7,1);
  if(fault==="extra"||fault==="balanced")pulses.push(beats[7]-30);
  pulses.sort((a,b)=>a-b);
  const knots=beats.flatMap((t,k)=>[[t-25,k%2?400:100],[t+25,k%2?400:100]]);
  const times=[...new Set([...Array.from({length:280},(_,k)=>800+k*5),...knots.map(p=>p[0]).filter(t=>t<=2195),...pulses,...pulses.map(t=>t+10)])].sort((a,b)=>a-b);
  const frames=times.map(t=>{
    const j=Math.max(0,knots.findIndex(p=>p[0]>=t)-1),a=knots[j],b=knots[j+1]??a;
    let x=a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]);
    if(t<knots[0][0])x=knots[0][1];
    if(fault==="geometry"&&Math.abs(t-beats[7])<=20)x=250;
    const actions=pulses.flatMap((p,k)=>t>=p&&t<p+10?[k%2]:[]);
    if(fault==="dual"&&t===pulses[7])actions.push(1-actions[0]);
    return traceFrame(t,x,actions,actions.reduce((n,a)=>n|(a?10:5),0));
  });
  const f=errorFixture(beats.map((t,k)=>`${k%2?400:100},192,${t},1,0`).join("\n"),frames,classic?"lazer":"stable",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
  return {...f,frames};
}
function diagnosis(f:ReturnType<typeof fixture>,trace=f.trace,excluded?:ReadonlySet<string>){
  return classifyCircleLoss(deriveCircleEvidence(trace,f.map,"9"),f.map,trace,excluded);
}
describe("anchored cumulative timing drift across spatial jumps",()=>{
  it.each([false,true])("uses positive past rhythm despite an incomplete unrelated tail (Classic=%s)",classic=>{
    const f=fixture("",classic),c=diagnosis(f);
    expect(f.state.hitCircleVerdict["9"].type).toBe("MISS");
    expect(c.headline).toBe("Late tap");
    expect(c.diagnostics?.primary).toHaveProperty("timingDrift");
  });
  it.each(["rhythm","constant","reset","oscillation","recovered","phase-recovery","skip","extra","balanced","geometry","dual"])("does not assert anchored drift through %s",fault=>{
    expect(diagnosis(fixture(fault)).diagnostics?.primary??{}).not.toHaveProperty("timingDrift");
  });
  it("does not inherit old drift through recovered phase into a new missed target",()=>{
    const f=fixture("phase-recovery");expect(f.state.hitCircleVerdict["9"].type).toBe("MISS");
    expect(diagnosis(f).diagnostics?.primary).not.toHaveProperty("timingDrift");
  });
  it.each(["gap","mask","history","coarse"])("requires complete %s source evidence",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.filter(r=>!(fault==="coarse"&&r.kind==="input"&&r.timeMs>1760&&r.timeMs<1840)).map(r=>{
      if(r.kind!=="input"||r.timeMs!==1750)return r;
      if(fault==="gap")return {...r,source:{...r.source,discontinuityBefore:["test"]}};
      if(fault==="mask")return {...r,rawButtonMask:15};
      if(fault==="history")return {...r,previousActions:[0,1]};
      return r;
    })};
    expect(diagnosis(f,trace).diagnostics?.primary).not.toHaveProperty("timingDrift");
  });
  it("keeps exclusions local",()=>{
    const f=fixture();expect(diagnosis(f,f.trace,new Set(["4"])).diagnostics?.primary).not.toHaveProperty("timingDrift");
    expect(diagnosis(f).headline).toBe("Late tap");
  });
  it.each(["position","selection-kind","allowed-blocker","prior-unresolved","activation","raw-index"])("validates actual anchor %s independently of nominal flow",fault=>{
    const f=fixture(),trace={...f.trace,records:f.trace.records.map(r=>{
      if(fault==="raw-index"&&r.kind==="input"&&r.source.origin==="parsed")return {...r,source:{...r.source,rawTokenIndex:r.source.parsedFrameIndex-10000}};
      if(fault==="activation"&&r.kind==="lifecycle"&&r.componentId==="4")return {...r,transition:"invalid" as "activated"};
      if(r.timeMs!==1476)return r;
      if(fault==="position"&&r.kind==="input")return {...r,position:{x:500,y:500}};
      if(fault==="selection-kind"&&r.kind==="selection")return {...r,component:"slider-head" as const};
      if(fault==="allowed-blocker"&&r.kind==="policy")return {...r,blockerId:"3"};
      if(fault==="prior-unresolved"&&r.kind==="resolution")return {...r,previousUnresolved:false};
      return r;
    })};
    expect(diagnosis(f,trace).diagnostics?.primary).not.toHaveProperty("timingDrift");
  });
});
