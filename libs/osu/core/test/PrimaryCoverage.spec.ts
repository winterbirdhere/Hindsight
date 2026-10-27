import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

type Knot = [number, number, number];
function frames(knots: Knot[], taps: number[]) {
  const times = [...new Set([
    ...Array.from({ length: 91 }, (_, i) => 700 + i * 10),
    ...knots.map(k => k[0]), ...taps, ...taps.map(t => t + 20),
  ])].sort((a, b) => a - b);
  return times.map(time => {
    const after = knots.findIndex(k => k[0] > time);
    const a = knots[after < 0 ? knots.length - 1 : Math.max(0, after - 1)];
    const b = knots[after < 0 ? knots.length - 1 : after];
    const fraction = (time - a[0]) / Math.max(1, b[0] - a[0]);
    const frame = traceFrame(time, a[1] + (b[1] - a[1]) * fraction,
      taps.flatMap((tap, index) => time >= tap && time < tap + 20 ? [index % 2] : []));
    return { ...frame, position: { ...frame.position, y: a[2] + (b[2] - a[2]) * fraction } };
  });
}

describe("complete local cause coverage without unique intent", () => {
  it("retains a validated next-slot rejection before that neighbour's later successful recovery", () => {
    const objects = "100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0";
    const source = frames([[700,100,192],[1016,100,192],[1080,180,192],[1160,260,192],[1600,260,192]], [1016,1171,1251]);
    const f = errorFixture(objects, source), e = deriveCircleEvidence(f.trace, f.map, "1");
    expect(Object.values(f.state.hitCircleVerdict).map(v => v.type)).toEqual(["GREAT","MISS","MEH"]);
    const next = deriveCircleEvidence(f.trace, f.map, "2");
    expect(next.terminal).toMatchObject({mechanism:"successful-input", timeMs:1251});
    expect(next.routing.find(r => r.kind === "policy" && r.state === "rejected")).toMatchObject({timeMs:1171, blockerId:"1", timingResult:"GREAT"});
    const cause = classifyCircleLoss(e, f.map, f.trace);
    expect(cause.headline).toBe("No tap");
    expect(cause.diagnostics?.primary?.association.missingAction?.scope).toBe("complete-bracketed-source-gap");
    const extra = errorFixture(objects, source.map(r => r.time === 1090 ? {...r, actions:[0],position:{x:320,y:320}} : r));
    expect(classifyCircleLoss(deriveCircleEvidence(extra.trace, extra.map, "1"), extra.map, extra.trace).codes).not.toContain("no-tap");
  });
  it("uses an independently complete tail when an older verified phase anchor invalidates a longer bracket", () => {
    const objects = "100,192,1000,1,0\n110,192,1047,1,0\n120,192,1094,1,0\n400,192,1320,1,0";
    const source = frames([[700,100,192],[1000,100,192],[1047,110,192],[1094,120,192],[1200,120,192],[1320,400,192],[1600,400,192]], [1000,1047,1320]);
    const f = errorFixture(objects, source), e = deriveCircleEvidence(f.trace, f.map, "2");
    expect(e.inputs.filter(i => i.inLiveSuccess && i.record.freshActions.length).map(i => i.record.timeMs)).toEqual([1000,1047]);
    const cause = classifyCircleLoss(e, f.map, f.trace);
    expect(cause.headline).toBe("No tap");
    expect(cause.diagnostics?.primary?.association.missingAction?.scope).toBe("complete-recorded-tail-gap");
    const extra = errorFixture(objects, source.map(r => r.time === 1100 ? {...r, actions:[0],position:{x:300,y:320}} : r));
    expect(classifyCircleLoss(deriveCircleEvidence(extra.trace, extra.map, "2"), extra.map, extra.trace).codes).not.toContain("no-tap");
  });
  it("accounts for fresh actions after a blocked next-note bracket but before the target expiry",()=>{
    const f=errorFixture("100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0\n400,192,1240,1,0",
      frames([[700,100,192],[1000,100,192],[1080,180,192],[1160,260,192],[1170,400,192],[1600,400,192]],[1000,1160,1170]));
    const e=deriveCircleEvidence(f.trace,f.map,"1");
    expect(e.inputs.filter(i=>i.inLiveSuccess && i.record.freshActions.length).map(i=>i.record.timeMs)).toEqual([1000,1160,1170]);
    expect(classifyCircleLoss(e,f.map,f.trace).codes).not.toContain("no-tap");
  });
  it.each(["action","previous-actions","known-action"])("refuses an internally inconsistent %s omission anchor",kind=>{
    const f=errorFixture("100,192,1000,1,0\n110,192,1080,1,0\n120,192,1160,1,0",
      frames([[700,100,192],[1000,100,192],[1080,110,192],[1160,120,192],[1600,120,192]],[1000,1080]));
    const trace={...f.trace,records:f.trace.records.map(r=>{
      if(r.timeMs !== 1080) return r;
      if(kind === "action" && r.kind === "input") return {...r,actions:[]};
      if(kind === "previous-actions" && r.kind === "input") return {...r,previousActions:[1]};
      if(kind === "known-action" && r.kind === "attempt") return {...r,knownAction:0};
      return r;
    })};
    expect(classifyCircleLoss(deriveCircleEvidence(trace,f.map,"2"),f.map,trace).codes).not.toContain("no-tap");
  });
  it("retains the closing raw source bracket without claiming its after-window action belongs to the missing slot",()=>{
    const f=errorFixture("100,192,1000,1,0\n110,192,1080,1,0\n120,192,1160,1,0",
      frames([[700,100,192],[1000,100,192],[1080,110,192],[1160,120,192],[1260,120,192],[1270,500,192],[1600,500,192]],[1000,1080,1270]));
    const e=deriveCircleEvidence(f.trace,f.map,"2"),cause=classifyCircleLoss(e,f.map,f.trace);
    expect(cause.headline).toBe("No tap");
    const closing=e.inputs.find(i=>i.record.timeMs === 1270)!;
    expect(closing.inLiveSuccess).toBe(false);
    expect(cause.diagnostics?.primary?.association.missingAction?.eventIds).toContain(closing.record.id);
  });
  it.each(["blocked-next","recorded-tail"] as const)("proves a missing slot from %s source boundaries", kind=>{
    const tail=kind === "recorded-tail", objects=tail ? "100,192,1000,1,0\n110,192,1080,1,0\n120,192,1160,1,0" : "100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0";
    const knots:Knot[]=tail ? [[700,100,192],[1000,100,192],[1080,110,192],[1160,120,192],[1600,120,192]] :
      [[700,100,192],[1000,100,192],[1080,180,192],[1160,260,192],[1600,260,192]];
    const taps=tail ? [1000,1080] : [1000,1160], id=tail ? "2" : "1", added=tail ? 1160 : 1080;
    const source=frames(knots,taps), f=errorFixture(objects,source);
    expect(Object.values(f.state.hitCircleVerdict).map(v=>v.type)).toEqual(tail ? ["GREAT","GREAT","MISS"] : ["GREAT","MISS","MISS"]);
    // Use the same recorded cursor/timestamps and add one physical action only.
    const fixed=errorFixture(objects,source.map(frame=>frame.time === added ? traceFrame(frame.time,frame.position.x,[0]) : frame));
    expect(Object.values(fixed.state.hitCircleVerdict).map(v=>v.type)).toEqual(["GREAT","GREAT","GREAT"]);
    const e=deriveCircleEvidence(f.trace,f.map,id);
    if(!tail) expect(classifyCircleLoss(deriveCircleEvidence(f.trace,f.map,"2"),f.map,f.trace).headline).toBe("Notelock");
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    expect(classifyCircleLoss(e,f.map,f.trace,new Set([tail ? "0" : "2"])).codes).not.toContain("no-tap");
    const withExtra=source.map(frame=>frame.time === added ? traceFrame(frame.time,tail ? 180 : 230,[0]) : frame);
    const extra=errorFixture(objects,withExtra);
    expect(classifyCircleLoss(deriveCircleEvidence(extra.trace,extra.map,id),extra.map,extra.trace).codes).not.toContain("no-tap");
    const gap={...f.trace,records:f.trace.records.map(r=>r.kind === "input" && r.timeMs === (tail ? 1180 : 1100) ? {...r,source:{...r.source,discontinuityBefore:["source-gap"]}} : r)};
    expect(classifyCircleLoss(deriveCircleEvidence(gap,f.map,id),f.map,gap).codes).not.toContain("no-tap");
  });
  it.each(["stable", "lazer"] as const)("recognizes a %s on-beat press in a verified gap between two passes", profile => {
    const objects = "300,192,1000,1,0";
    const probe = errorFixture(objects, [traceFrame(700), traceFrame(1300)], profile);
    const radius = deriveCircleEvidence(probe.trace, probe.map, "0").geometry!.radius;
    const fixture = errorFixture(objects, [
      traceFrame(700, 200), traceFrame(970, 300), traceFrame(990, 300),
      traceFrame(1000, 300 + radius * 1.001, [0]),
      traceFrame(1010, 300), traceFrame(1030, 300), traceFrame(1060, 200), traceFrame(1300, 200),
    ], profile);
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "0");
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("MISS");
    expect(evidence.inputs.find(i => i.record.timeMs === 1000)?.inside).toBe(false);
    expect(evidence.insideIntervals.filter(i => !i.postTerminal)).toHaveLength(2);
    const result = classifyCircleLoss(evidence, fixture.map, fixture.trace);
    expect(result.headline).toBe("Misaim");
    expect(result.metric).toEqual({value:profile==="stable"?25:26,unit:"ms"});
    expect(result.briefDetail?.phrase).toBe("300 window left uncovered");
  });

  it("recognizes an exhaustively bracketed missing action with one verified anchor on either side", () => {
    const fixture = errorFixture("100,192,1000,1,0\n110,192,1110,1,0\n120,192,1220,1,0",
      frames([[700, 100, 192], [1600, 120, 192]], [1008, 1238]));
    expect(Object.values(fixture.state.hitCircleVerdict).map(v => v.type)).toEqual(["GREAT", "MISS", "GREAT"]);
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    expect(evidence.dependencies.input.status).toBe("complete");
    expect(evidence.inputs.filter(i => i.inLiveSuccess && i.record.freshActions.length).map(i => i.record.timeMs)).toEqual([1008]);
    expect(classifyCircleLoss(evidence, fixture.map, fixture.trace).headline).toBe("No tap");
  });

  it("recognizes a missing final circle action before a separated successful jump", () => {
    const fixture = errorFixture("100,192,1000,1,0\n140,192,1080,1,0\n180,192,1160,1,0\n420,192,1320,1,0",
      frames([[700, 100, 192], [1000, 100, 192], [1080, 140, 192], [1160, 180, 192],
        [1240, 180, 192], [1320, 420, 192], [1600, 420, 192]], [1000, 1080, 1320]));
    expect(Object.values(fixture.state.hitCircleVerdict).map(v => v.type)).toEqual(["GREAT", "GREAT", "MISS", "GREAT"]);
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "2");
    expect(evidence.inputs.filter(i => i.inLiveSuccess && i.record.freshActions.length).map(i => i.record.timeMs)).toEqual([1080]);
    expect(classifyCircleLoss(evidence, fixture.map, fixture.trace).headline).toBe("No tap");
  });
  it("uses complete local tail evidence when a later post-terminal action invalidates only the longer bracket",()=>{
    const objects="100,192,1000,1,0\n140,192,1080,1,0\n180,192,1160,1,0\n420,192,1420,1,0";
    const source=frames([[700,100,192],[1000,100,192],[1080,140,192],[1160,180,192],
      [1260,180,192],[1280,300,300],[1420,420,192],[1600,420,192]],[1000,1080,1280,1420]);
    const f=errorFixture(objects,source),e=deriveCircleEvidence(f.trace,f.map,"2");
    expect(Object.values(f.state.hitCircleVerdict).map(v=>v.type)).toEqual(["GREAT","GREAT","MISS","GREAT"]);
    const cause=classifyCircleLoss(e,f.map,f.trace);
    expect(cause.headline).toBe("No tap");
    expect(cause.diagnostics?.primary?.association.missingAction?.scope).toBe("complete-recorded-tail-gap");
    const extra=errorFixture(objects,source.map(frame=>frame.time===1180 ? {...frame,actions:[0],position:{x:320,y:300}} : frame));
    expect(classifyCircleLoss(deriveCircleEvidence(extra.trace,extra.map,"2"),extra.map,extra.trace).codes).not.toContain("no-tap");
  });

  it("does not infer omission when a real extra outside edge occupies the gap", () => {
    const input = frames([[700, 100, 192], [1600, 120, 192]], [1008, 1120, 1238]);
    const tap = input.find(i => i.time === 1120)!;
    tap.position = { x: 300, y: 192 };
    const fixture = errorFixture("100,192,1000,1,0\n110,192,1110,1,0\n120,192,1220,1,0", input);
    const result = classifyCircleLoss(deriveCircleEvidence(fixture.trace, fixture.map, "1"), fixture.map, fixture.trace);
    expect(result.codes).not.toContain("no-tap");
    expect(result.diagnostics?.primary?.association.missingAction).toBeUndefined();
  });

  it.each(["0", "2"])("does not use contradicted anchor %s as proof of a missing action", excluded => {
    const fixture = errorFixture("100,192,1000,1,0\n110,192,1110,1,0\n120,192,1220,1,0",
      frames([[700, 100, 192], [1600, 120, 192]], [1008, 1238]));
    const evidence = deriveCircleEvidence(fixture.trace,fixture.map,"1");
    const result = classifyCircleLoss(evidence,fixture.map,fixture.trace,new Set([excluded]));
    expect(result.codes).not.toContain("no-tap");
    expect(classifyCircleLoss(evidence,fixture.map,fixture.trace,new Set(["unrelated"])).headline).toBe("No tap");
  });

  it("does not prove omission across a real local source discontinuity", () => {
    const fixture = errorFixture("100,192,1000,1,0\n110,192,1110,1,0\n120,192,1220,1,0",
      frames([[700, 100, 192], [1600, 120, 192]], [1008, 1238]));
    const trace = JSON.parse(JSON.stringify(fixture.trace)) as typeof fixture.trace;
    const input = trace.records.find(r => r.kind === "input" && r.timeMs === 1110);
    if (input?.kind !== "input" || input.source.origin !== "parsed") throw new Error("Missing authored input");
    input.source.discontinuityBefore = ["test-gap"];
    const evidence = deriveCircleEvidence(trace, fixture.map, "1");
    expect(evidence.dependencies.input.status).toBe("partial");
    expect(classifyCircleLoss(evidence, fixture.map, trace).codes).not.toContain("no-tap");
  });

  it("does not call opposing observations Off beat when the complete shared pass stays blocked", () => {
    const fixture = errorFixture("100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0",
      frames([[700, 180, 320], [1040, 180, 240], [1080, 180, 192], [1120, 180, 240], [1600, 180, 320]], [1040, 1120]));
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    const result = classifyCircleLoss(evidence, fixture.map, fixture.trace);
    expect(result.headline).toBe("Early tap");
    expect(result.codes).not.toContain("off-beat");
    expect(result.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
  });
  it("preserves established early sequence attribution after an actual earlier receipt",()=>{
    const fixture=errorFixture("100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0",
      frames([[700,100,192],[1000,100,192],[1040,180,240],[1080,180,192],[1120,180,240],[1600,180,320]],[1000,1040,1120]));
    expect(fixture.state.hitCircleVerdict["0"].type).toBe("GREAT");
    const e=deriveCircleEvidence(fixture.trace,fixture.map,"1");expect(e.terminal?.result).toBe("MISS");
    // Once the preceding beat is actually hit, the sequence independently
    // assigns the two subsequent early actions to successive notes.
    expect(classifyCircleLoss(e,fixture.map,fixture.trace).headline).toBe("Early tap");
  });

  it("compares both positive misplaced approaches without demanding unique ownership", () => {
    const fixture = errorFixture("100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0",
      frames([[700, 30, 192], [980, 150, 250], [1020, 180, 270], [1160, 180, 270],
        [1300, 350, 300], [1600, 400, 300]], [1040, 1120]));
    expect(Object.values(fixture.state.hitCircleVerdict).map(v => v.type)).toEqual(["MISS", "MISS", "MISS"]);
    const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "1");
    const fresh = evidence.inputs.filter(i => i.inLiveSuccess && i.record.freshActions.length);
    expect(fresh.map(i => i.record.timeMs - 1080)).toEqual([-40, 40]);
    expect(fresh.every(i => !i.inside)).toBe(true);
    const diagnosis = classifyCircleLoss(evidence, fixture.map, fixture.trace);
    expect(diagnosis.headline).toBe("Misaim");
    expect(diagnosis.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
    expect(diagnosis.diagnostics?.primary?.ranking?.selected[0].support).toBeUndefined();
    // With these recorded frame times, the previous note expires at 1120
    // after the press. Neither centered single-press edit can reach this note.
    for (const time of [1040,1120]) {
      const edited=frames([[700,30,192],[980,150,250],[1020,180,270],[1160,180,270],
        [1300,350,300],[1600,400,300]],[1040,1120]).map(f=>f.time===time?{...f,position:{x:180,y:192}}:f);
      const control=errorFixture("100,192,1000,1,0\n180,192,1080,1,0\n260,192,1160,1,0",edited);
      expect(Object.values(control.state.hitCircleVerdict).map(v=>v.type)).toEqual(["MISS","MISS","MISS"]);
    }
  });
});
