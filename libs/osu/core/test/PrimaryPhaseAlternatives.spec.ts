import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function phaseDepthFixture(profile: "stable" | "lazer", deep: number) {
  const taps = [970,1050,1130,1210,1290,1370,1450];
  const points = [[800,50],[970,100],[1050,150],[1130,200],[1210,200],[1290,250],[1370,300],[deep,350],[1450,400],[1650,650]];
  const times = [...new Set([800,...Array.from({length:100},(_,i)=>900+i*8),...points.map(p=>p[0]),...taps,...taps.map(t=>t+25),1750])].sort((a,b)=>a-b);
  const frames = times.map(t => {
    const k=points.findIndex(p=>p[0]>t),a=points[k<0?points.length-1:Math.max(0,k-1)],b=points[k<0?points.length-1:k];
    return traceFrame(t,a[1]+(b[1]-a[1])*(t-a[0])/Math.max(1,b[0]-a[0]),taps.flatMap((tap,i)=>t>=tap&&t<tap+25?[i%2]:[]));
  });
  return errorFixture("100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n300,192,1320,1,0\n350,192,1400,1,0",frames,profile);
}
describe("receptor-boundary timing shared by competing phases", () => {
  it.each(["stable","lazer"] as const)("does not require the deepest %s point to fall within the best window", profile => {
    for (const deep of [1410,1430]) {
      const f=phaseDepthFixture(profile,deep),e=deriveCircleEvidence(f.trace,f.map,"5"),before=JSON.stringify(f.trace),r=classifyCircleLoss(e,f.map,f.trace);
      expect(e.terminal?.result).toBe("MISS");
      expect(Object.values(e.dependencies).every(d=>d.status==="complete")).toBe(true);
      expect(Array.from({length:5},(_,k)=>f.state.hitCircleVerdict[String(k)].type)).toEqual(["OK","OK","OK","OK","OK"]);
      const episodes=r.diagnostics?.primary?.phaseComparison?.approaches.episodes;
      expect(episodes?.map(p=>p.pressOffsetMs).sort((a,b)=>a-b)).toEqual([-30,50]);
      for (const p of episodes ?? []) {
        expect(p.status).toBe("supported"); expect(p.placement).toBe("proper-pass"); expect(p.spatialCandidates).toEqual([]);
        expect(Math.abs(p.pressOffsetMs)).toBeGreaterThan(e.geometry!.hitWindows[0]);
        expect(p.properPass!.entryTimeMs).toBeLessThan(1400+e.geometry!.hitWindows[0]);
        expect(p.properPass!.exitTimeMs).toBeGreaterThan(1400-e.geometry!.hitWindows[0]);
        expect(p.pressTimeMs<p.properPass!.entryTimeMs || p.pressTimeMs>p.properPass!.exitTimeMs).toBe(true);
      }
      if (deep===1430) expect(episodes!.every(p=>p.properPass!.closestOffsetMs>e.geometry!.hitWindows[0])).toBe(true);
      expect(r.headline).toBe("Early tap"); expect(r.metric).toEqual({value:30,unit:"ms early"});
      expect(r.diagnostics?.primary?.ranking?.selected[0].observationOnly).toBe(true);
      expect(r.diagnostics?.primary?.ranking?.attribution?.roles.rule).toBe("nearest-recorded-opportunity");
      expect(JSON.stringify(f.trace)).toBe(before);
    }
  });
});

/**
 * Source-authored 60 ms rhythms with a missed geometric reception followed by
 * two shifted successful receptions. Both plausible target actions lie on the
 * same side of an on-time circle pass; neither has an independent aim defect.
 * A diagnosis may retain their common direction without choosing either metric.
 */
function sameSidePhases(direction: "early" | "late") {
  const early = direction === "early";
  const centres = early ? [50, 100, 150, 200, 250, 350] : [100, 150, 200, 250, 300, 350];
  const taps = early ? [910, 970, 1030, 1090, 1150, 1210, 1270] : [1030, 1090, 1150, 1210, 1270, 1330, 1390];
  const points = early
    ? [
        [800, 0],
        [910, 50],
        [970, 100],
        [1030, 150],
        [1090, 150],
        [1150, 200],
        [1210, 250],
        [1270, 300],
        [1300, 350],
        [1450, 600],
      ]
    : [
        [800, 50],
        [1030, 100],
        [1090, 150],
        [1150, 200],
        [1210, 200],
        [1270, 250],
        [1300, 350],
        [1330, 300],
        [1390, 200],
        [1500, 16],
      ];
  const times = [
    ...new Set([
      ...Array.from({ length: 101 }, (_, index) => 800 + index * 8),
      ...points.map((point) => point[0]),
      ...taps,
      ...taps.map((tap) => tap + 25),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, points.findIndex((point) => point[0] >= time) - 1);
    const a = points[at],
      b = points[at + 1] ?? a;
    const x = a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]);
    return traceFrame(
      time,
      x,
      taps.flatMap((tap, index) => (time >= tap && time < tap + 25 ? [index % 2] : [])),
    );
  });
  return errorFixture(centres.map((x, index) => `${x},192,${1000 + index * 60},1,0`).join("\n"), frames);
}

describe("primary timing shared by competing stream phases", () => {
  it("does not create uncertainty when both phases identify the same fresh action", () => {
    const taps = [970,1050,1130,1210,1280,1340,1400,1460,1540];
    const knots = [[800,50],[970,100],[1050,150],[1130,150],[1160,200],[1210,200],[1280,250],
      [1340,300],[1400,350],[1440,350],[1460,355],[1470,390],[1480,400],[1500,430],[1540,450],[1800,650]];
    const times = [...new Set([...Array.from({length:126}, (_,i) => 800+i*8), ...knots.map(k=>k[0]), ...taps, ...taps.map(t=>t+25)])].sort((a,b)=>a-b);
    const frames = times.map(time => {
      const after=knots.findIndex(k=>k[0]>time), a=knots[after<0 ? knots.length-1 : Math.max(0,after-1)], b=knots[after<0 ? knots.length-1 : after];
      return traceFrame(time,a[1]+(b[1]-a[1])*(time-a[0])/Math.max(1,b[0]-a[0]),taps.flatMap((t,i)=>time>=t && time<t+25 ? [i%2] : []));
    });
    const f=errorFixture(Array.from({length:8}, (_,i)=>`${100+i*50},192,${1000+i*80},1,0`).join("\n"),frames);
    const e=deriveCircleEvidence(f.trace,f.map,"6"), result=classifyCircleLoss(e,f.map,f.trace);
    expect(f.state.hitCircleVerdict["6"].type).toBe("MISS");
    const stream=result.diagnostics?.primary?.association.stream;
    const active=stream?.phaseAlternatives?.filter(a=>a.active);
    expect(active).toHaveLength(1);
    expect(active?.[0].targetInputIds).toEqual(stream?.relevantInputIds);
    const expectedEntry=1460+(400-e.geometry!.radius-355)/3.5;
    expect(e.insideIntervals[0].startTimeMs).toBeCloseTo(expectedEntry,7);
    expect(expectedEntry).toBeGreaterThan(1460);
    expect(result.headline).toBe("Early tap");
    expect(result.codes).toEqual(["early-tap"]);
    expect(result.diagnostics?.primary?.approaches?.episodes).toHaveLength(1);
    const gap={...f.trace,records:f.trace.records.map(r=>r.kind==="input" && r.timeMs===1470 ? {...r,source:{...r.source,discontinuityBefore:["source-gap"]}} : r)};
    expect(classifyCircleLoss(deriveCircleEvidence(gap,f.map,"6"),f.map,gap).status).toBe("unavailable");
  });
  it.each([
    ["late", [30, 90], "after-pass", "Late tap", "late-tap"],
    ["early", [-90, -30], "before-pass", "Early tap", "early-tap"],
  ] as const)(
    "selects the nearest recorded %s press while retaining both phase alternatives",
    (direction, offsets, relation, headline, code) => {
      const fixture = sameSidePhases(direction);
      const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "5");
      const result = classifyCircleLoss(evidence, fixture.map, fixture.trace);
      const diagnostic = result.diagnostics?.primary;
      const comparison = diagnostic?.phaseComparison;

      // Establish the actual engine/source premises before the player-copy assertion.
      expect(fixture.state.hitCircleVerdict["5"].type).toBe("MISS");
      expect(fixture.state.hitCircleVerdict["3"].type).not.toBe("MISS");
      expect(fixture.state.hitCircleVerdict["4"].type).not.toBe("MISS");
      expect(diagnostic?.association.stream?.status).toBe("ambiguous");
      expect(diagnostic?.association.stream?.phaseAlternatives?.some((alternative) => alternative.active)).toBe(true);
      expect(comparison?.approaches.episodes).toHaveLength(2);
      expect(comparison?.approaches.episodes.map((episode) => episode.pressOffsetMs).sort((a, b) => a - b)).toEqual(
        offsets,
      );
      for (const episode of comparison?.approaches.episodes ?? []) {
        expect(episode.status).toBe("supported");
        expect(episode.relation).toBe(relation);
        expect(episode.placement).toBe("proper-pass");
        expect(episode.properPass?.closestOffsetMs).toBe(0);
        expect(episode.spatialCandidates).toEqual([]);
      }

      expect(result.status).toBe("supported");
      expect(result.headline).toBe(headline);
      expect(result.codes).toEqual([code]);
      expect(result.metric).toBeDefined();
      expect(result.briefDetail?.metric).toEqual(result.metric);
      expect(result.description).not.toMatch(/before and after/);
      expect(result.eventIds).toEqual(expect.arrayContaining(comparison?.inputIds ?? []));
    },
  );
});
