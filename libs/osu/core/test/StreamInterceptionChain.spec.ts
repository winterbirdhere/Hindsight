import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence, derivePreResolutionRejections } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";
import { compareInitiatingArrival } from "../src/gameplay/error-analysis/InitiatingArrivalComparison";

// A near-beat tap arrives before circle3's cursor entry. The next well-placed
// cadence press is received by3, leaving4 alive to block5. Then5 receives6's
// well-placed cadence press. Only that complete chain can explain a downstream
// miss by its initiating approach; ordinary overlapping consumption cannot.
function cascade(
  options: {
    repair?: boolean;
    missing?: boolean;
    late?: boolean;
    native?: boolean;
    extra?: boolean;
    classic?: boolean;
    recovery?:boolean;
    nominalTap?:boolean;
    entryTap?:boolean;
    aimAdvance?:number;
  } = {},
) {
  const taps = [992, 1106, 1220, ...(options.missing ? [] : [options.late ? 1294 : options.nominalTap?1342:options.entryTap?1350:1334]), 1448, 1562, 1676, 1800];
  if (options.extra) taps.push(1390);
  if (options.recovery) taps.push(1760);
  taps.sort((a, b) => a - b);
  const knots = [
    [800, 100, 100],
    [992, 100, 100],
    [1106, 160, 100],
    [1220, 220, 100],
    [1294, 260, 130],
    [1334, 280, options.repair ? 200 : 156+(options.aimAdvance??0)],
    [1350, 280, 166+(options.aimAdvance??0)],
    [1390, 280, 198],
    [1448, 280, 182],
    [1562, 400, 200],
    [1676, 400, 218],
    [1800, 500, 100],
    [1950, 500, 100],
  ];
  const times = [
    ...new Set([
      ...Array.from({ length: 231 }, (_, i) => 800 + i * 5),
      ...knots.map((p) => p[0]),
      ...taps,
      ...taps.map((t) => t + 20),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
      a = knots[at],
      b = knots[at + 1] ?? a,
      f = (time - a[0]) / Math.max(1, b[0] - a[0]);
    return {
      ...traceFrame(
        time,
        0,
        taps.flatMap((t, i) => (time >= t && time < t + 20 ? [i % 2] : [])),
      ),
      position: { x: a[1] + (b[1] - a[1]) * f, y: a[2] + (b[2] - a[2]) * f },
    };
  });
  return errorFixture(
    "100,100,1000,1,0\n160,100,1114,1,0\n220,100,1228,1,0\n280,200,1342,1,0\n280,182,1456,1,0\n400,200,1570,1,0\n400,218,1684,1,0\n500,100,1798,1,0",
    frames,
    options.native ? "lazer" : "stable",
    [],
    options.classic ? [{ acronym: "CL", settings: { classic_note_lock: true } }] : [],
  );
}
function diagnosis(f: ReturnType<typeof cascade>, id: string, trace = f.trace) {
  return classifyCircleLoss(deriveCircleEvidence(trace, f.map, id), f.map, trace);
}
describe("initiating approach across a proven interception chain", () => {
  function overlappingRoot(recovery=false,reentry=false){
    const knots=[[800,100],[995,162],[1005,200],[1065,210],[1066,230],[1100,250],[1145,300],[1160,reentry?250:330],[1300,400]],
      taps=[995,1066,...(recovery?[1145]:[])],
      times=[...new Set([...Array.from({length:101},(_,i)=>800+i*5),...knots.map(p=>p[0]),...taps.flatMap(t=>[t,t+20])])].sort((a,b)=>a-b);
    const frames=times.map(t=>{
      const at=knots.findIndex(p=>p[0]>t),a=knots[at<0?knots.length-1:Math.max(0,at-1)],b=knots[at<0?knots.length-1:at];
      return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),taps.flatMap((q,i)=>t>=q&&t<q+20?[i%2]:[]));
    });
    return errorFixture("200,192,1000,1,0\n250,192,1079,1,0",frames);
  }
  it("does not count a proved initiating root again as target recovery in overlapping windows",()=>{
    const f=overlappingRoot(),e=deriveCircleEvidence(f.trace,f.map,"1"),root=e.inputs.find(i=>i.record.timeMs===995)!;
    expect(root.inLiveSuccess).toBe(true);expect(root.inside).toBe(false);
    expect(f.state.hitCircleVerdict["0"]).toMatchObject({type:"OK",judgementTime:1066});
    expect(e.terminal?.result).toBe("MISS");expect(e.directRejections).toEqual([]);
    const d=diagnosis(f,"1"),chain=d.diagnostics?.primary?.initiatingChain;
    expect(d.headline).toBe("Late entry");expect(chain?.rootInputId).toBe(root.record.id);
    expect(chain?.additionalInputEvidence).toContainEqual({inputId:root.record.id,receiverId:"0",kind:"earlier-chain-slot",eventIds:expect.arrayContaining([root.record.id])});
    expect(chain?.recoveryComparison).toBeUndefined();
  });
  it.each([false,true])("retains actual later recovery and its independent new passage (%s)",reentry=>{
    const f=overlappingRoot(true,reentry),d=diagnosis(f,"1"),chain=d.diagnostics?.primary?.initiatingChain,
      recovery=f.trace.records.find(r=>r.kind==="input"&&r.timeMs===1145)!;
    expect(chain?.additionalInputEvidence).toEqual(expect.arrayContaining([expect.objectContaining({inputId:recovery.id,kind:"failed-recovery"})]));
    expect(chain?.recoveryComparison?.candidates.map(c=>c.code)).toContain("late-tap");
    expect(!!chain?.recoveryPriority).toBe(!reentry);
    expect(d.headline).toBe("Late entry");
    expect(chain?.recoveryComparison?.ranking.selected.map(c=>c.code)).toEqual(["late-tap"]);
  });
  function earlyRootRecovery(repair=false,reentry=false,classic=false) {
    const knots=[[800,100],[900,100],[964,155],[985,177],[1000,185],[1060,200],[1100,225],[1115,260],[1141,280],[1180,reentry?216:300],[1220,350],[1400,350]];
    const times=[...new Set([...Array.from({length:121},(_,i)=>800+i*5),...knots.map(k=>k[0]),984,1080,1161,1230])].sort((a,b)=>a-b);
    const taps=[900,repair?1000:964,1060,1141,1210];
    const frames=times.map(time=>{const k=Math.max(0,knots.findIndex(p=>p[0]>=time)-1),a=knots[k],b=knots[k+1]??a;
      return traceFrame(time,a[1]+(b[1]-a[1])*(time-a[0])/Math.max(1,b[0]-a[0]),taps.flatMap((t,i)=>time>=t&&time<(i===1?1020:t+20)?[i%2]:[]));});
    return errorFixture("100,192,900,1,0\n200,192,1000,1,0\n216,192,1100,1,0\n350,192,1200,1,0",frames,classic?"lazer":"stable",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
  }
  it("retains a usable initiating early correction ahead of the same-pass failed recovery",()=>{
    const f=earlyRootRecovery(),fixed=earlyRootRecovery(true),cause=diagnosis(f,"2");
    expect(f.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(fixed.state.hitCircleVerdict["2"]).toMatchObject({type:"OK",judgementTime:1060});
    expect(cause.headline).toBe("Early tap");
    expect(cause.diagnostics?.primary?.initiatingChain).toHaveProperty("recoveryPriority.basis","usable-root-correction-and-no-new-target-pass");
    expect(cause.diagnostics?.primary?.initiatingChain?.recoveryComparison?.candidates.map(c=>c.code)).toContain("late-tap");
  });
  it("does not subsume a new target passage into the earlier failed recovery",()=>{
    expect(diagnosis(earlyRootRecovery(false,true),"2").diagnostics?.primary?.initiatingChain??{}).not.toHaveProperty("recoveryPriority");
  });
  it("keeps the same initiating priority under explicit Classic",()=>{
    expect(diagnosis(earlyRootRecovery(false,false,true),"2").headline).toBe("Early tap");
  });
  it.each(["trace","domain"])("honors an earlier prefix conflict carried by %s",location=>{
    const f=earlyRootRecovery(),conflict="dependency-conflict:lifecycle:0";
    const trace={...f.trace,...(location==="trace"?{failures:[...f.trace.failures,conflict]}:{domain:{...f.trace.domain,sourceCoverageLimits:[...f.trace.domain.sourceCoverageLimits,conflict]}})};
    expect(diagnosis(f,"2",trace).diagnostics?.primary?.initiatingChain??{}).not.toHaveProperty("recoveryPriority");
  });
  it.each(["chord-crossing","prefix-blocker","dual-recovery","source-gap","target-outside","recovery-spatial","wrong-action","false-null"])(
    "does not subsume independent or incomplete %s evidence",kind=>{
      const f=earlyRootRecovery();
      const trace={...f.trace,records:f.trace.records.map(r=>{
        if(kind==="wrong-action"&&r.kind==="attempt"&&r.timeMs===1141)return {...r,knownAction:0};
        if(kind==="false-null"&&r.kind==="selection"&&r.timeMs===1141)return {...r,inside:true,eligible:true,component:"circle" as const};
        if(kind==="prefix-blocker"&&r.kind==="resolution"&&r.componentId==="0")return {...r,sequence:f.trace.records.length+1};
        if(r.kind!=="input")return r;
        if(kind==="chord-crossing"&&r.timeMs===1180)return {...r,position:{x:160,y:192}};
        if(kind==="dual-recovery"&&r.timeMs===1141)return {...r,actions:[0,1],freshActions:[0,1]};
        if(kind==="source-gap"&&r.timeMs===1180)return {...r,source:{...r.source,discontinuityBefore:["test-gap"]}};
        if(kind==="target-outside"&&r.timeMs===1060)return {...r,position:{x:170,y:192}};
        if(kind==="recovery-spatial"&&r.timeMs>=1120&&r.timeMs<=1160)return {...r,position:{x:245,y:220}};
        return r;
      })};
      expect(diagnosis(f,"2",trace).diagnostics?.primary?.initiatingChain??{}).not.toHaveProperty("recoveryPriority");
    });
  function releaseBoundary(repair=false,shorten=false){
    const objects=`100,100,800,2,0,L|100:140,1,${shorten ? 39 : 40}\n100,192,1047,1,0\n110,200,1094,1,0\n120,208,1140,2,0,L|130:258,1,50`;
    const knots=[[600,100,100],[800,100,100],[964,100,160],[1000,100,192],[1080,110,200],[1167,120,208],[1300,130,258],[1600,130,258]];
    const times=[...new Set([...Array.from({length:201},(_,i)=>600+5*i),...knots.map(k=>k[0]),1010,1020,1100,1187])].sort((a,b)=>a-b);
    const frames=times.map(time=>{
      const k=Math.max(0,knots.findIndex(p=>p[0]>=time)-1),a=knots[k],b=knots[k+1] ?? a,q=(time-a[0])/Math.max(1,b[0]-a[0]);
      return {...traceFrame(time,0,[...(time>=800 && time<1010 || time>=1080 && time<1100 ? [0] : []),
        ...(time>=1000 && time<1020 && !(repair && time===1000) || time>=1167 && time<1187 ? [1] : [])]),
        position:{x:a[1]+(b[1]-a[1])*q,y:a[2]+(b[2]-a[2])*q}};
    });
    return {...errorFixture(objects,frames),frames};
  }
  it("follows uniquely recorded drifting recovery to a successful slider's exact release-boundary rejection",()=>{
    const f=releaseBoundary(),cause=diagnosis(f,"3/HEAD");
    expect(f.state.hitCircleVerdict["3/HEAD"].type).toBe("MISS");
    const root=deriveCircleEvidence(f.trace,f.map,"1");
    const rejection=derivePreResolutionRejections(root,f.map,f.trace).find(w=>w.blockerId==="0");
    expect(rejection).toBeDefined();
    // A hittable inside root press is routing evidence, not an Early tap departure.
    expect(cause.headline).toBe("");
    expect(cause.diagnostics?.primary?.initiatingChain).toBeUndefined();
    const repaired=releaseBoundary(true),short=releaseBoundary(false,true);
    expect(f.frames.filter((frame,i)=>JSON.stringify(frame)!==JSON.stringify(repaired.frames[i]))).toHaveLength(1);
    for(const control of [repaired,short])for(const id of ["1","2","3/HEAD"])expect(control.state.hitCircleVerdict[id].type).not.toBe("MISS");
    const gap={...f.trace,records:f.trace.records.map(r=>r.kind==="input" && r.timeMs===1120 ? {...r,source:{...r.source,discontinuityBefore:["test-gap"]}} : r)};
    expect(diagnosis(f,"3/HEAD",gap).diagnostics?.primary?.initiatingChain).toBeUndefined();
    expect(classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"3/HEAD"),f.map,f.trace,new Set(["0"])).diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
  it.each(["failed-parent", "later-release", "resolved-before-rejection"] as const)(
    "does not use %s as a successful release-boundary initiating root", (fault) => {
      const f = releaseBoundary();
      const trace = {...f.trace, records: f.trace.records.map(r => {
        if (r.kind !== "slider-parent" || r.componentId !== "0") return r;
        if (fault === "failed-parent") return {...r, result: "MISS", hitParts: 0};
        if (fault === "later-release") return {...r, timeMs: r.timeMs + 1};
        const rejection = f.trace.records.find(p => p.kind === "policy" && p.componentId === "1" && p.state === "rejected")!;
        return {...r, sequence: rejection.sequence - 1};
      })};
      expect(diagnosis(f, "3/HEAD", trace).diagnostics?.primary?.initiatingChain).toBeUndefined();
    },
  );
  it("compares a positively observed failed recovery with the initiating cause instead of dropping either",()=>{
    const f=cascade({recovery:true}),cause=diagnosis(f,"6");
    expect(deriveCircleEvidence(f.trace,f.map,"6").directRejections).toEqual([]);
    expect(cause.headline).toBe("Notelock");
    expect(cause.diagnostics?.primary?.receiverConsequence?.receiverOutcome).toBe("successful-consumption");
    expect(cause.diagnostics?.primary).toHaveProperty("initiatingChain.rootComponentId","3");
    expect(cause.diagnostics?.primary?.initiatingChain?.rootComparison.ranking.selected.map(c=>c.code)).toEqual(["aim-late"]);
    expect(cause.eventIds).toEqual(expect.arrayContaining(f.trace.records.filter(r=>r.kind === "input" && [1334,1676,1760].includes(r.timeMs)).map(r=>r.id)));
    expect(cause.metric).toBeUndefined();
  });
  function recoveredChain(kind: "early" | "input-miss", repair=false) {
    const early=kind === "early";
    const objects=early ? [[100,800],[200,900],[300,1000],[310,1060],[320,1120]] : [[100,1000],[110,1114],[120,1228],[130,1342]];
    const taps=early ? [800,900,986,1046,1106] : [1000,1110,1220,1332];
    const knots=early ? [[700,100],[800,100],[900,200],[980,250],[986,260],[998,275],[1046,305],[1106,310],[1650,320]] :
      [[700,0],[1000,60],[1010,75],[1050,100],[1110,105],[1220,115],[1332,125],[1650,130]];
    const times=[...new Set([...Array.from({length:191},(_,i)=>700+i*5),...knots.map(k=>k[0]),...taps,...taps.map(t=>t+20)])].sort((a,b)=>a-b);
    const frames=times.map(time=>{
      const index=Math.max(0,knots.findIndex(p=>p[0]>=time)-1),a=knots[index],b=knots[index+1] ?? a;
      const x=a[1]+(b[1]-a[1])*(time-a[0])/Math.max(1,b[0]-a[0]);
      return traceFrame(time,repair && time === (early ? 986 : 1000) ? (early ? 300 : 100) : x,
        taps.flatMap((t,i)=>time>=t && time<t+20 ? [i%2] : []));
    });
    return {...errorFixture(objects.map(([x,t])=>`${x},192,${t},1,0`).join("\n"),frames),frames,objects};
  }
  it.each(["early","input-miss"] as const)("follows %s recovered receivers to the independently observed initiating approach",kind=>{
    const f=recoveredChain(kind), repaired=recoveredChain(kind,true), early=kind === "early";
    const results=f.objects.map((_,i)=>deriveCircleEvidence(f.trace,f.map,String(i)).terminal?.result);
    expect(results).toEqual(early ? ["GREAT","GREAT","OK","OK","MISS"] : ["MISS","MEH","MEH","MISS"]);
    expect(f.frames.filter((frame,i)=>JSON.stringify(frame)!==JSON.stringify(repaired.frames[i]))).toHaveLength(1);
    expect(repaired.objects.map((_,i)=>deriveCircleEvidence(repaired.trace,repaired.map,String(i)).terminal?.result))
      .toEqual(repaired.objects.map(()=>"GREAT"));
    const cause=diagnosis(f,String(f.objects.length-1));
    expect(cause.headline).toBe(early ? "Early tap" : "Late entry");
    expect(cause.diagnostics?.primary).toHaveProperty("initiatingChain.rootComponentId",early ? "2" : "0");
  });
  it("retains conditional timing but compares whether nominal tap correction can repair the initiating approach", () => {
    const f = cascade();
    for (const id of ["4", "6"]) {
      const e = deriveCircleEvidence(f.trace, f.map, id);
      expect(e.terminal).toMatchObject({ result: "MISS", mechanism: "automatic-expiry" });
      expect(e.directRejections).toEqual([]);
      // The pulse is inside GREAT timing. Entry is after nominal, so moving
      // only the pulse to the nominal beat is still outside the circle.
      const cause = diagnosis(f, id);
      expect(cause).toMatchObject(id==="6"?{status:"supported",headline:"Notelock",codes:["notelock"]}:{
        status: "supported",
        headline: "Late entry",
        codes: ["aim-late"],
        briefDetail: { phrase: "Following an earlier late entry" },
      });
      expect(cause.diagnostics?.primary).toHaveProperty("initiatingChain.rootComponentId", "3");
      expect(cause.diagnostics?.primary?.initiatingChain?.rootComparison.ranking.selected.map(c=>c.code)).toEqual(["aim-late"]);
    }
  });
  it("keeps the two controls distinct: nominal timing alone fails, actual inside timing repairs",()=>{
    const nominal=cascade({nominalTap:true}),inside=cascade({entryTap:true});
    for(const id of ["4","6"]){
      expect(nominal.state.hitCircleVerdict[id].type).toBe("MISS");
      expect(inside.state.hitCircleVerdict[id].type).toBe("GREAT");
    }
  });
  it("compares the uncovered best window even when nominal timing also repairs",()=>{
    const f=cascade({aimAdvance:6}),nominal=cascade({aimAdvance:6,nominalTap:true});
    expect(diagnosis(f,"4").headline).toBe("Late entry");
    expect(nominal.state.hitCircleVerdict["4"].type).toBe("GREAT");
  });
  it.each([false,true])("does not declare an outside root while its pulse successfully serves an earlier note (Classic=%s)",classic=>{
    const knots=[[900,100],[1090,105],[1100,108],[1110,115],[1150,145],[1190,150],[1290,160],[1450,160]];
    const frames=Array.from({length:111},(_,i)=>900+i*5).map(time=>{
      const k=Math.max(0,knots.findIndex(p=>p[0]>=time)-1),a=knots[k],b=knots[k+1]??a;
      return traceFrame(time,a[1]+(b[1]-a[1])*(time-a[0])/Math.max(1,b[0]-a[0]),
        [1090,1190,1290].flatMap((t,j)=>time>=t&&time<t+20?[j%2]:[]));
    });
    const objects="100,192,1000,1,0\n145,192,1100,1,0\n155,192,1200,1,0\n165,192,1300,1,0";
    const make=(points=frames)=>errorFixture(objects,points,classic?"lazer":"stable",[],classic?[{acronym:"CL",settings:{classic_note_lock:true}}]:[]);
    const f=make(),root=deriveCircleEvidence(f.trace,f.map,"1");
    expect(f.state.hitCircleVerdict["0"].type).toBe("MEH");
    expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(root.inputs.find(i=>i.record.timeMs===1090)?.inside).toBe(false);
    // Repair to the overlapping area still serves0; moving beyond0's radius
    // creates a new earlier miss. Neither establishes a root opportunity at1.
    const overlap=make(frames.map(q=>q.time===1090?{...q,position:{x:125,y:192}}:q));
    const center=make(frames.map(q=>q.time===1090?{...q,position:{x:145,y:192}}:q));
    expect(overlap.state.hitCircleVerdict).toEqual(f.state.hitCircleVerdict);
    expect(center.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(diagnosis(f,"3").diagnostics?.primary?.initiatingChain).toBeUndefined();
  });
  it.each(["timing","left-censored","no-sample","earlier-pass","gap","coarse","slider"])(
    "does not erase conditional timing with an incomplete %s arrival certificate",fault=>{
      const f=cascade(),chain=diagnosis(f,"4").diagnostics!.primary!.initiatingChain!;
      const e=deriveCircleEvidence(f.trace,f.map,chain.rootComponentId),comparison=JSON.parse(JSON.stringify(chain.rootComparison));
      const episode=comparison.approaches.episodes[0];
      if(fault==="timing")episode.pressOffsetMs=-100;
      if(fault==="left-censored")episode.properPass.leftCensored=true;
      if(fault==="no-sample")episode.properPass.deepSampled=false;
      if(fault==="earlier-pass")episode.contacts.unshift({...episode.properPass,entryTimeMs:1300,exitTimeMs:1320});
      if(fault==="gap")e.inputs=e.inputs.map(i=>i.record.timeMs===1340?{...i,record:{...i.record,source:{...i.record.source,discontinuityBefore:["gap"]}}}:i);
      if(fault==="coarse")e.inputs=e.inputs.filter(i=>i.record.timeMs<1335||i.record.timeMs>1380);
      if(fault==="slider")f.map.getHitCircle(chain.rootComponentId).sliderId="outside-scope";
      expect(compareInitiatingArrival(e,f.map,comparison)).toBeUndefined();
    });
  it("independently removes both downstream misses when only the initiating cursor sample is repaired", () => {
    const f = cascade({ repair: true });
    for (const id of ["3", "4", "5", "6"])
      expect(deriveCircleEvidence(f.trace, f.map, id).terminal).toMatchObject({
        result: "GREAT",
        mechanism: "successful-input",
      });
  });
  it.each(["missing", "late", "extra"] as const)(
    "does not propagate a late-entry cause through %s source actions",
    (kind) => {
      const f = cascade({ [kind]: true });
      expect(diagnosis(f, "4").diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
    },
  );
  it("preserves native forced resolution instead of applying a Stable interception story", () => {
    const f = cascade({ native: true });
    expect(diagnosis(f, "4").diagnostics?.primary).not.toHaveProperty("initiatingChain");
  });
  it("validates the same chain under explicit native Classic note lock", () => {
    const f = cascade({ native: true, classic: true });
    expect(diagnosis(f, "4").headline).toBe("Late entry");
  });
  it("does not ignore a second simultaneous fresh action in the target window", () => {
    const f = cascade();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 1475
          ? { ...r, actions: [0, 1], freshActions: [0, 1], previousActions: [] }
          : r,
      ),
    };
    expect(diagnosis(f, "4", trace).diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
  });
  it("rejects discontinuous source evidence", () => {
    const f = cascade();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 1350
          ? { ...r, source: { ...r.source, discontinuityBefore: ["parser-negative-delta" as const] } }
          : r,
      ),
    };
    expect(diagnosis(f, "4", trace).diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
  });
  it.each(["1", "2", "3", "4", "5"])("does not propagate across a saved-outcome conflict on %s", (id) => {
    const f = cascade(),
      e = deriveCircleEvidence(f.trace, f.map, "6");
    expect(classifyCircleLoss(e, f.map, f.trace, new Set([id])).diagnostics?.primary ?? {}).not.toHaveProperty(
      "initiatingChain",
    );
  });
  it("keeps the chain when a saved conflict is outside every supporting dependency", () => {
    const f = cascade(),
      e = deriveCircleEvidence(f.trace, f.map, "6");
    expect(classifyCircleLoss(e, f.map, f.trace, new Set(["unrelated"])).headline).toBe("Notelock");
  });
  it("keeps recovered predecessors out of direct Miss rejection evidence", () => {
    const f = cascade();
    const e = deriveCircleEvidence(f.trace, f.map, "5");
    expect(e.terminal?.mechanism).toBe("successful-input");
    expect(e.directRejections).toEqual([]);
    expect(diagnosis(f, "5").codes).not.toContain("notelock");
  });
  it("refuses a rejected link after its receiver resolves", () => {
    const f = cascade(),
      end = deriveCircleEvidence(f.trace, f.map, "5").terminal!;
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "policy" && r.componentId === "5" && r.state === "rejected"
          ? { ...r, sequence: end.sequence + 1 }
          : r,
      ),
    };
    expect(diagnosis(f, "6", trace).diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
  });
  it("refuses an accepted receiver grade inconsistent with exact timing", () => {
    const f = cascade();
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "policy" && r.componentId === "3" && r.state === "allowed" ? { ...r, offsetMs: 0 } : r,
      ),
    };
    expect(diagnosis(f, "4", trace).diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
  });
  it.each(["previous-actions", "attempt-ordinal", "profile-branch"])(
    "rejects corrupted %s on an accepted consumption link",
    (kind) => {
      const f = cascade(),
        e = deriveCircleEvidence(f.trace, f.map, "3"),
        attempt = e.attempts.find((a) => a.id === e.terminal!.triggerAttemptId)!;
      const trace = {
        ...f.trace,
        records: f.trace.records.map((r) => {
          if (kind === "previous-actions" && r.kind === "input" && r.id === attempt.inputId)
            return { ...r, previousActions: [0, 1] };
          if (kind === "attempt-ordinal" && r.kind === "attempt" && r.id === attempt.id)
            return { ...r, attemptOrdinal: 1 };
          if (kind === "profile-branch" && r.kind === "policy" && r.attemptId === attempt.id)
            return { ...r, branch: "native:classic-note-lock" as const };
          return r;
        }),
      };
      expect(diagnosis(f, "4", trace).diagnostics?.primary ?? {}).not.toHaveProperty("initiatingChain");
    },
  );
});
