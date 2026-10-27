import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { ReplayTrace } from "../src/gameplay/trace/ReplayTrace";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

function streamFixture(options: { missing?: boolean; normalFlow?: boolean; gap?: boolean; extra?: boolean } = {}) {
  const points = options.normalFlow
    ? [
        [800, 0],
        [1000, 100],
        [1080, 150],
        [1160, 200],
        [1240, 250],
        [1320, 300],
        [1400, 350],
        [1600, 450],
      ]
    : [
        [800, 0],
        [1000, 100],
        [1080, 150],
        [1160, 200],
        [1215, 250],
        [1275, 300],
        [1355, 350],
        [1435, 400],
        [1600, 450],
      ];
  const taps = [
    1035,
    1115,
    1195,
    ...(options.missing ? [] : [1275]),
    1355,
    1435,
    ...(options.extra ? [1210] : []),
  ].sort((a, b) => a - b);
  const times = [
    ...new Set([...Array.from({ length: 101 }, (_, i) => 800 + i * 8), ...taps, ...taps.map((t) => t + 25)]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const at = Math.max(0, points.findIndex((p) => p[0] >= time) - 1),
      a = points[at],
      b = points[at + 1] ?? a;
    const x = a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]);
    const actions = taps.flatMap((tap, index) => (time >= tap && time < tap + 25 ? [index % 2] : []));
    return traceFrame(time, options.extra && time === 1210 ? 0 : x, actions);
  });
  return errorFixture(
    "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n300,192,1320,1,0\n350,192,1400,1,0",
    frames,
  );
}
const press = (trace: ReplayTrace, time: number) => {
  const input = trace.records.find((r) => r.kind === "input" && r.timeMs === time && r.freshActions.length);
  if (!input) throw Error(`missing source press ${time}`);
  return input.id;
};
function inspect(f: ReturnType<typeof errorFixture>, id = "3", trace = f.trace) {
  return deriveStreamInputEvidence(deriveCircleEvidence(trace, f.map, id), f.map, trace);
}
function curvedFlow(profile: "stable" | "lazer" = "stable", spaced = false, hold = false) {
  const xy = spaced
    ? [
        [70, 192],
        [140, 192],
        [210, 192],
        [280, 192],
        [350, 192],
        [420, 192],
      ]
    : [
        [100, 100],
        [150, 100],
        [180, 145],
        [180, 200],
        [140, 245],
        [90, 245],
      ];
  const times = [800, 960, 1035, 1115, 1195, 1240, 1275, 1355, 1435, 1600];
  // Native input must miss both receptors here; otherwise it correctly hits
  // the next note and forces this one out of order, a different engine case.
  const positions = [
    xy[0],
    xy[0],
    xy[0],
    xy[1],
    xy[2],
    xy[3],
    profile === "lazer" ? [110, 270] : xy[4],
    xy[4],
    xy[5],
    xy[5],
  ];
  const taps = [1035, 1115, 1195, 1275, 1355, 1435];
  const frameTimes = [
    ...new Set([
      ...Array.from({ length: 101 }, (_, i) => 800 + i * 8),
      ...times,
      ...taps.map((t) => t + (hold ? 95 : 25)),
    ]),
  ].sort((a, b) => a - b);
  const frames = frameTimes.map((time) => {
    const at = Math.max(0, times.findIndex((t) => t >= time) - 1),
      next = Math.min(at + 1, times.length - 1),
      ratio = (time - times[at]) / Math.max(1, times[next] - times[at]);
    const x = positions[at][0] + (positions[next][0] - positions[at][0]) * ratio,
      y = positions[at][1] + (positions[next][1] - positions[at][1]) * ratio;
    return {
      ...traceFrame(
        time,
        x,
        taps.flatMap((tap, i) => (time >= tap && time < tap + (hold ? 95 : 25) ? [i % 2] : [])),
      ),
      position: { x, y },
    };
  });
  return errorFixture(xy.map((p, i) => `${p[0]},${p[1]},${1000 + 80 * i},1,0`).join("\n"), frames, profile);
}
function terminalHead(options: { latePress?: boolean; recovery?: boolean; shortParent?: boolean } = {}) {
  const knots = [
    [800, 50],
    [1035, 100],
    [1115, 150],
    [1195, 225],
    [1240, 250],
    [1275, 265],
    [1315, 280],
    [1405, 400],
    [1550, 400],
  ];
  const taps = [1035, 1115, 1195, ...(options.latePress ? [1290] : []), ...(options.recovery === false ? [] : [1405])];
  const times = [
    ...new Set([
      ...Array.from({ length: 95 }, (_, i) => 800 + i * 8),
      ...knots.map((p) => p[0]),
      ...taps,
      ...taps.map((t) => t + 50),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const j = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
      a = knots[j],
      b = knots[j + 1] ?? a;
    return traceFrame(
      time,
      a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
      taps.flatMap((t, i) => (time >= t && time < t + 100 ? [i % 2] : [])),
    );
  });
  return errorFixture(
    `100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,2,0,L|350:192,1,${
      options.shortParent ? 2 : 16
    }\n400,192,1400,1,0`,
    frames,
  );
}
function beforeMidpoint(options: { recovery?: boolean; reverse?: boolean; reverseAfter?: boolean } = {}) {
  const knots = [
    [800, 40],
    [1040, 100],
    [1128, 210],
    ...(options.reverse
      ? [
          [1140, 255],
          [1150, 245],
        ]
      : []),
    [1174, 255],
    [1181, 258],
    [1183, options.reverseAfter ? 250 : 259],
    [1287, 320],
    [1415, 430],
    [1580, 470],
  ];
  const taps = [1040, 1174, ...(options.recovery === false ? [] : [1287]), 1415];
  const times = [
    ...new Set([
      ...Array.from({ length: 99 }, (_, i) => 800 + i * 8),
      ...knots.map((p) => p[0]),
      ...taps.map((t) => t + 24),
    ]),
  ].sort((a, b) => a - b);
  const frames = times.map((time) => {
    const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
      a = knots[k],
      b = knots[k + 1] ?? a;
    return traceFrame(
      time,
      a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
      taps.flatMap((t, i) => (time >= t && time < t + 24 ? [i % 2] : [])),
    );
  });
  return errorFixture("100,192,1000,1,0\n210,192,1128,1,0\n320,192,1256,1,0\n430,192,1384,1,0", frames);
}
describe("shared stream input evidence", () => {
  function boundaryReconciliation(
    options: { nextX?: number; short?: boolean | "pair"; oneAnchor?: boolean; segments?: number } = {},
  ) {
    const objects: string[] = [],
      frames: ReturnType<typeof traceFrame>[] = [];
    for (let s = 0; s < (options.segments ?? 1); s++) {
      const dt = s * 1000,
        next = options.nextX ?? 280;
      objects.push(
        `100,192,${dt + 1000},1,0`,
        `150,192,${dt + 1080},1,0`,
        `200,192,${dt + 1160},2,0,L|216:192,1,16`,
        `${next},192,${dt + 1240},1,0`,
      );
      if (!options.short) objects.push(`${next + 80},192,${dt + 1320},1,0`, `${next + 160},192,${dt + 1400},1,0`);
      if (options.short === "pair") objects.push(`${next + 80},192,${dt + 1320},1,0`);
      const knots = [
        [800, 20],
        [1035, 100],
        [1115, 150],
        [1160, 200],
        [1200, 240],
        [1240, next],
        [1355, next + 80],
        [1435, next + 160],
        [1600, next + 200],
      ];
      const taps = [...(options.oneAnchor ? [] : [1035]), 1115, 1200, ...(options.short ? [] : [1355, 1435])];
      const times = [
        ...new Set([
          ...Array.from({ length: 101 }, (_, i) => 800 + i * 8),
          ...knots.map((p) => p[0]),
          ...taps.map((t) => t + 20),
        ]),
      ].sort((a, b) => a - b);
      for (const time of times) {
        const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
          a = knots[k],
          b = knots[k + 1] ?? a;
        frames.push(
          traceFrame(
            time + dt,
            a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
            taps.flatMap((t, i) => (time >= t && time < t + 20 ? [i % 2] : [])),
          ),
        );
      }
    }
    return errorFixture(objects.join("\n"), frames);
  }
  it("keeps cadence ownership when the adjacent local receptor is geometrically closer", () => {
    const f = boundaryReconciliation({ nextX: 278 }),
      id = press(f.trace, 1200);
    for (const target of ["3", "2/HEAD"]) {
      const r = inspect(f, target),
        a = r.assignments.find((a) => a.inputId === id);
      expect(a).toMatchObject({ componentId: "2/HEAD", basis: "cadence", relation: "matched" });
      expect(a?.competingClaims?.map((c) => c.componentId)).toEqual(expect.arrayContaining(["2/HEAD", "3"]));
    }
  });
  it("retains equal cross-boundary local claims as ambiguity instead of choosing query order", () => {
    const f = boundaryReconciliation({ oneAnchor: true }),
      id = press(f.trace, 1200);
    for (const target of ["3", "2/HEAD"]) {
      const r = inspect(f, target);
      expect(r.assignments.find((a) => a.inputId === id)).toMatchObject({
        relation: "ambiguous",
        confidence: "ambiguous",
      });
      expect(r.relevantInputIds).not.toContain(id);
    }
  });
  it.each([true, "pair"] as const)(
    "exposes known neighbouring ownership to a short nonstream receptor without inventing stream coverage (%s)",
    (short) => {
      const f = boundaryReconciliation({ short }),
        id = press(f.trace, 1200),
        r = inspect(f, "3");
      expect(r.status).toBe("not-stream");
      expect(r.rawFreshInputIds).toContain(id);
      expect(r.contextInputIds).toContain(id);
      expect(r.relevantInputIds).not.toContain(id);
      expect(r.assignments).toContainEqual(
        expect.objectContaining({ inputId: id, componentId: "2/HEAD", relation: "matched" }),
      );
      if (short === "pair") expect(inspect(f, "4").assignments).toEqual(r.assignments);
    },
  );
  it("returns identical boundary ownership after the bounded base cache has been evicted", () => {
    const f = boundaryReconciliation({ segments: 35 }),
      first = inspect(f, "2/HEAD");
    const before = JSON.stringify(first.assignments);
    for (let s = 1; s < 35; s++) inspect(f, `${6 * s + 2}/HEAD`);
    expect(JSON.stringify(inspect(f, "2/HEAD").assignments)).toBe(before);
    expect(JSON.stringify(first.assignments)).toBe(before);
  });
  it("fences next-note landing after a cadence press before the receptor midpoint", () => {
    const f = beforeMidpoint(),
      r = inspect(f, "1"),
      id = press(f.trace, 1174);
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["2"].type).toBe("OK");
    // At the action,45px fromthis target and65px fromnext: not yetmidpoint.
    expect(r.assignments).toContainEqual(
      expect.objectContaining({ componentId: "1", inputId: id, confidence: "corroborated" }),
    );
    expect(r.inputScopes?.[id]?.placementEnd).toMatchObject({ timeMs: 1174, eventId: id });
  });
  it.each([{ recovery: false }, { reverse: true }, { reverseAfter: true }])(
    "does not add a pre-midpoint fence without continuous forward recovery (%j)",
    (options) => {
      const f = beforeMidpoint(options),
        r = inspect(f, "1");
      expect(r.inputScopes?.[press(f.trace, 1174)]).toBeUndefined();
    },
  );
  it("retains unbroken source phase through two misses before a shifted successful receiver", () => {
    const knots = [
      [800, 50],
      [990, 100],
      [1070, 150],
      [1150, 200],
      [1230, 200],
      [1310, 305],
      [1390, 350],
      [1470, 375],
      [1550, 450],
      [1700, 480],
    ];
    const taps = [990, 1070, 1150, 1230, 1310, 1390, 1470, 1550];
    const times = [
      ...new Set([
        ...Array.from({ length: 114 }, (_, i) => 800 + i * 8),
        ...knots.map((p) => p[0]),
        ...taps.map((t) => t + 25),
      ]),
    ].sort((a, b) => a - b);
    const frames = times.map((time) => {
      const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
        a = knots[k],
        b = knots[k + 1] ?? a;
      return traceFrame(
        time,
        a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
        taps.flatMap((t, i) => (time >= t && time < t + 25 ? [i % 2] : [])),
      );
    });
    const f = errorFixture(
      Array.from({ length: 8 }, (_, i) => `${100 + i * 50},192,${1000 + i * 80},1,0`).join("\n"),
      frames,
    );
    // Raw taps never skip their80ms cadence. Taps for3 and4 fail geometrically;
    // the1470 tap at375 reaches prior5 and is recorded70ms late for that receiver.
    expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["4"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["5"].type).toBe("MEH");
    const r = inspect(f, "6");
    expect(r.phaseAlternatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseMs: -10,
          targetInputIds: [press(f.trace, 1470)],
          active: true,
          recentAnchorCount: 1,
        }),
      ]),
    );
    expect(r.assignments).toContainEqual(
      expect.objectContaining({ inputId: press(f.trace, 1470), componentId: "5", confidence: "anchored" }),
    );
    expect(r.missingTargetTap).toBe(false);
  });
  it("assigns multiple source presses to the same unique local target without inventing a missing beat", () => {
    const knots = [
      [800, 30],
      [1030, 100],
      [1080, 150],
      [1130, 195],
      [1160, 200],
      [1185, 242],
      [1240, 250],
      [1290, 290],
      [1400, 320],
    ];
    const taps = [1030, 1130, 1138, 1215, 1290];
    const times = [
      ...new Set([
        ...Array.from({ length: 76 }, (_, i) => 800 + i * 8),
        ...knots.map((p) => p[0]),
        ...taps,
        ...taps.map((t) => t + 5),
      ]),
    ].sort((a, b) => a - b);
    const frames = times.map((time) => {
      const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
        a = knots[k],
        b = knots[k + 1] ?? a;
      return traceFrame(
        time,
        a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
        taps.flatMap((t, i) => (time >= t && time < t + 5 ? [i % 2] : [])),
      );
    });
    const f = errorFixture("100,192,1000,1,0\n150,192,1120,1,0\n250,192,1240,1,0", frames),
      r = inspect(f, "1");
    expect(f.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(r.status).toBe("supported");
    expect(r.relevantInputIds).toEqual([press(f.trace, 1130), press(f.trace, 1138)]);
    expect(r.missingTargetTap).toBe(false);
  });
  it("uses a shared two-sided recovery bridge when only one earlier scored anchor exists", () => {
    // One actual earlier score and a later recovery bracket two missed notes.
    const objects = "100,192,1000,1,0\n170,192,1128,1,0\n240,192,1256,1,0\n310,192,1384,1,0\n380,192,1512,1,0";
    const knots = [
      [800, 40],
      [1040, 100],
      [1128, 170],
      [1170, 215],
      [1256, 240],
      [1295, 285],
      [1415, 310],
      [1540, 380],
      [1700, 420],
    ];
    const taps = [1040, 1170, 1295, 1415, 1540];
    const times = [
      ...new Set([
        ...Array.from({ length: 113 }, (_, i) => 800 + i * 8),
        ...knots.map((p) => p[0]),
        ...taps.map((t) => t + 24),
      ]),
    ].sort((a, b) => a - b);
    const frames = times.map((time) => {
      const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
        a = knots[k],
        b = knots[k + 1] ?? a;
      return traceFrame(
        time,
        a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
        taps.flatMap((t, i) => (time >= t && time < t + 24 ? [i % 2] : [])),
      );
    });
    const bridge = errorFixture(objects, frames);
    expect(bridge.state.hitCircleVerdict["1"].type).toBe("MISS");
    expect(bridge.state.hitCircleVerdict["2"].type).toBe("MISS");
    expect(bridge.state.hitCircleVerdict["3"].type).toBe("OK");
    const a = inspect(bridge, "1"),
      b = inspect(bridge, "2");
    expect(a.status).toBe("supported");
    expect(b.status).toBe("supported");
    expect(a.relevantInputIds).toEqual([press(bridge.trace, 1170)]);
    expect(b.relevantInputIds).toEqual([press(bridge.trace, 1295)]);
    expect(a.assignments).toEqual(b.assignments);
    expect(a.assignments.find((a) => a.componentId === "1")?.recoveryContext).toMatchObject({
      timeMs: 1415,
      afterTargetLiveEnd: true,
    });
    expect(a.assignments.find((a) => a.componentId === "1")?.contextEventIds).toContain(press(bridge.trace, 1415));
  });
  it.each(["extra", "double", "gap", "disagree"] as const)(
    "does not build a recovery bridge through %s source evidence",
    (mode) => {
      const recovery = mode === "disagree" ? 1470 : 1415;
      const objects = "100,192,1000,1,0\n170,192,1128,1,0\n240,192,1256,1,0\n310,192,1384,1,0\n380,192,1512,1,0";
      const knots = [
        [800, 40],
        [1040, 100],
        [1128, 170],
        [1170, 215],
        [1256, 240],
        [1295, 285],
        [recovery, 310],
        [1540, 380],
        [1700, 420],
      ];
      const taps = [1040, ...(mode === "extra" ? [1155] : []), 1170, 1295, recovery, 1540];
      const times = [
        ...new Set([
          ...Array.from({ length: 113 }, (_, i) => 800 + i * 8),
          ...knots.map((p) => p[0]),
          ...taps,
          ...taps.map((t) => t + 5),
        ]),
      ]
        .sort((a, b) => a - b)
        .filter((t) => mode !== "gap" || t <= 1050 || t >= 1128);
      const frames = times.map((time) => {
        const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
          a = knots[k],
          b = knots[k + 1] ?? a;
        const actions =
          mode === "double" && time >= 1170 && time < 1175
            ? [0, 1]
            : taps.flatMap((t, i) => (time >= t && time < t + 5 ? [i % 2] : []));
        return traceFrame(
          time,
          time === 1155 ? 0 : a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
          actions,
        );
      });
      const f = errorFixture(objects, frames),
        r = inspect(f, "1");
      expect(r.assignments.filter((a) => a.inputId === press(f.trace, 1170)).every((a) => !a.recoveryContext)).toBe(
        true,
      );
      expect(r.missingTargetTap).toBe(false);
    },
  );
  it("does not use an unknown first-source action as an external bridge anchor", () => {
    const knots = [
      [935, 100],
      [1150, 200],
      [1185, 245],
      [1250, 300],
      [1285, 345],
      [1385, 400],
      [1500, 450],
    ];
    const taps = [935, 1185, 1285, 1385];
    const times = [
      ...new Set([
        ...Array.from({ length: 72 }, (_, i) => 935 + i * 8),
        ...knots.map((p) => p[0]),
        ...taps.map((t) => t + 25),
      ]),
    ].sort((a, b) => a - b);
    const frames = times.map((time) => {
      const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
        a = knots[k],
        b = knots[k + 1] ?? a;
      return traceFrame(
        time,
        a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
        taps.flatMap((t, i) => (time >= t && time < t + 25 ? [i % 2] : [])),
      );
    });
    const f = errorFixture("100,192,900,1,0\n200,192,1150,1,0\n300,192,1250,1,0\n400,192,1350,1,0", frames);
    const trace = { ...f.trace, domain: { ...f.trace.domain, initialActionsKnown: false } };
    const e = deriveCircleEvidence(trace, f.map, "1");
    expect(e.dependencies.input.status).toBe("complete");
    const r = inspect(f, "1", trace),
      a = r.assignments.find((a) => a.componentId === "1");
    expect(a?.basis).not.toBe("cadence");
  });
  it("retains a late cadence-matched input despite downstream receptor rejection", () => {
    const f = streamFixture(),
      result = inspect(f);
    expect(f.state.hitCircleVerdict["2"].type).toBe("OK");
    expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(result.status).toBe("supported");
    expect(result.relevantInputIds).toEqual([press(f.trace, 1275)]);
    // OD9 live window ends at1345ms, so1355 belongs to the shared segment
    // but is not an actual live-window action for this target.
    expect(result.rawFreshInputIds).toEqual([press(f.trace, 1195), press(f.trace, 1275)]);
    expect(result.missingTargetTap).toBe(false);
    expect(result.cadence).toMatchObject({ phaseMs: 35, anchorOffsetsMs: [35, 35] });
  });
  it("shares ownership across overlapping note windows while retaining actual successful assignments", () => {
    const f = streamFixture(),
      a = inspect(f),
      b = inspect(f, "4");
    expect(a.segmentId).toBe(b.segmentId);
    expect(a.assignments).toEqual(b.assignments);
    expect(a.relevantInputIds).toEqual([press(f.trace, 1275)]);
    expect(b.relevantInputIds).toEqual([press(f.trace, 1355)]);
    expect(a.contextInputIds).toContain(press(f.trace, 1195));
    expect(a.assignments).toContainEqual(
      expect.objectContaining({ componentId: "2", inputId: press(f.trace, 1195), confidence: "anchored" }),
    );
  });
  it("proves a skipped slot from bracketing outcomes without equating raw input count with absence", () => {
    const f = streamFixture({ normalFlow: true, missing: true }),
      result = inspect(f);
    expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["4"].type).toBe("OK");
    expect(result.status).toBe("supported");
    expect(result.rawFreshActionCount).toBeGreaterThan(0);
    expect(result.relevantInputIds).toEqual([]);
    expect(result.missingTargetTap).toBe(true);
    expect(result.assignments).toContainEqual(
      expect.objectContaining({ componentId: "3", relation: "missing", confidence: "corroborated" }),
    );
  });
  it("retains an extra between-slot action as ambiguous evidence rather than inventing a missing tap", () => {
    const f = streamFixture({ extra: true }),
      result = inspect(f);
    expect(result.rawFreshInputIds).toContain(press(f.trace, 1210));
    expect(result.assignments).toContainEqual(
      expect.objectContaining({ inputId: press(f.trace, 1210), relation: "extra" }),
    );
    expect(result.missingTargetTap).toBe(false);
  });
  it("refuses stream conclusions across source discontinuity", () => {
    const f = streamFixture(),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    const input = trace.records.find((r) => r.kind === "input" && r.timeMs === 1240);
    if (input?.kind !== "input" || input.source.origin !== "parsed") throw Error("fixture");
    input.source.discontinuityBefore = ["test-gap"];
    const r = inspect(f, "3", trace);
    expect(r.status).toBe("unavailable");
    expect(r.missingTargetTap).toBe(false);
    expect(r.rawFreshActionCount).toBe(2);
  });
  it("rejects mismatched trace identity before using cached ownership", () => {
    const f = streamFixture(),
      e = deriveCircleEvidence(f.trace, f.map, "3");
    const trace = { ...f.trace, identity: { ...f.trace.identity, generationKey: "other" } };
    const r = deriveStreamInputEvidence(e, f.map, trace);
    expect(r.status).toBe("unavailable");
    expect(r.limitations).toContain("trace-identity-mismatch");
  });
  it("does not mutate gameplay, trace or input evidence when deriving shared ownership", () => {
    const f = streamFixture(),
      before = normalizeTraceState({ state: f.state, trace: f.trace });
    inspect(f);
    inspect(f, "4");
    expect(normalizeTraceState({ state: f.state, trace: f.trace })).toEqual(before);
  });
  it("exposes a one-slot reception shift instead of treating two later scores as proof of changed physical cadence", () => {
    const times = [
      800,
      ...Array.from({ length: 87 }, (_, i) => 900 + i * 8),
      970,
      995,
      1050,
      1075,
      1130,
      1155,
      1210,
      1235,
      1290,
      1315,
      1370,
      1395,
      1450,
      1475,
      1650,
    ].sort((a, b) => a - b);
    const taps = [970, 1050, 1130, 1210, 1290, 1370, 1450];
    const points = [
      [800, 50],
      [970, 100],
      [1050, 150],
      [1130, 200],
      [1210, 200],
      [1290, 250],
      [1370, 300],
      [1450, 400],
      [1650, 450],
    ];
    const frames = [...new Set(times)].map((time) => {
      const j = Math.max(0, points.findIndex((p) => p[0] >= time) - 1),
        a = points[j],
        b = points[j + 1] ?? a;
      const x = a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]);
      return traceFrame(
        time,
        x,
        taps.flatMap((tap, i) => (time >= tap && time < tap + 25 ? [i % 2] : [])),
      );
    });
    const f = errorFixture(
      "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n300,192,1320,1,0\n350,192,1400,1,0",
      frames,
    );
    // Literal raw cadence is80ms throughout; geometry alone shifts the scored
    // sequence from -30ms to+50ms after the unaccepted1210 source action.
    expect(f.state.hitCircleVerdict["3"].type).toBe("OK");
    const r = inspect(f, "5");
    expect(r.status).toBe("ambiguous");
    expect(r.limitations).toContain("stream-phase-slip-alternative");
    expect(r.phaseAlternatives).toEqual(
      expect.arrayContaining([expect.objectContaining({ phaseMs: -30, targetInputIds: [press(f.trace, 1370)] })]),
    );
    expect(r.assignments).toContainEqual(
      expect.objectContaining({ inputId: press(f.trace, 1370), componentId: "4", confidence: "anchored" }),
    );
    expect(r.missingTargetTap).toBe(false);
  });
  it("does not manufacture confidence from sparse source sampling", () => {
    const f = errorFixture("100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0", [
      traceFrame(800, 0),
      traceFrame(1035, 100, [0]),
      traceFrame(1050, 100),
      traceFrame(1115, 150, [1]),
      traceFrame(1130, 150),
      traceFrame(1195, 200, [0]),
      traceFrame(1210, 200),
      traceFrame(1275, 310, [1]),
      traceFrame(1450, 350),
    ]);
    const r = inspect(f);
    expect(r.status).toBe("ambiguous");
    expect(r.missingTargetTap).toBe(false);
  });
  it("ends shared alignment at a large jump instead of inheriting stream phase", () => {
    const f = errorFixture("50,192,1000,1,0\n100,192,1080,1,0\n150,192,1160,1,0\n500,192,1240,1,0", [
      traceFrame(800, 0),
      traceFrame(1035, 50, [0]),
      traceFrame(1050, 50),
      traceFrame(1115, 100, [1]),
      traceFrame(1130, 100),
      traceFrame(1195, 150, [0]),
      traceFrame(1210, 150),
      traceFrame(1275, 440, [1]),
      traceFrame(1450, 500),
    ]);
    expect(inspect(f).status).toBe("not-stream");
  });
  it("does not manufacture bounded long-stream evidence from an uncovered sparse source window", () => {
    const objects = Array.from({ length: 65 }, (_, i) => `300,192,${1000 + i * 80},1,0`).join("\n");
    const f = errorFixture(objects, [traceFrame(800), traceFrame(7000)]);
    const r = inspect(f);
    expect(r.status).toBe("unavailable");
    expect(r.limitations).toContain("stream-source-window-uncovered");
  });
  it.each([
    ["stable", false, false],
    ["lazer", false, false],
    ["stable", true, false],
    ["stable", false, true],
  ] as const)(
    "aligns source-supported curved/spaced/held-alternating flow (%s spaced=%s held=%s)",
    (profile, spaced, hold) => {
      const f = curvedFlow(profile, spaced, hold),
        r = inspect(f);
      expect(f.state.hitCircleVerdict["3"].type).toBe("MISS");
      expect(r.status).toBe("supported");
      expect(r.relevantInputIds).toEqual([press(f.trace, 1275)]);
      expect(r.inputScopes?.[press(f.trace, 1275)]?.placementEnd).toMatchObject({ timeMs: 1275 });
      expect(r.assignments).toContainEqual(
        expect.objectContaining({ componentId: "4", inputId: press(f.trace, 1355), confidence: "anchored" }),
      );
    },
  );
  it("splits a burst at an actual rhythm change instead of extrapolating the old cadence", () => {
    const f = errorFixture("100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1400,1,0\n300,192,1480,1,0", [
      traceFrame(800, 0),
      traceFrame(1035, 100, [0]),
      traceFrame(1050, 100),
      traceFrame(1115, 150, [1]),
      traceFrame(1130, 150),
      traceFrame(1195, 200, [0]),
      traceFrame(1210, 200),
      traceFrame(1435, 310, [1]),
      traceFrame(1650, 350),
    ]);
    const r = inspect(f);
    expect(r.status).toBe("not-stream");
    expect(r.missingTargetTap).toBe(false);
  });
  it("does not force one input onto simultaneous scheduled objects", () => {
    const f = errorFixture("100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n200,192,1160,1,0\n250,192,1240,1,0", [
      traceFrame(800, 0),
      traceFrame(1035, 100, [0]),
      traceFrame(1050, 100),
      traceFrame(1115, 150, [1]),
      traceFrame(1130, 150),
      traceFrame(1195, 200, [0, 1]),
      traceFrame(1210, 200),
      traceFrame(1275, 310, [1]),
      traceFrame(1450, 350),
    ]);
    const r = inspect(f);
    expect(r.status).toBe("not-stream");
    expect(r.missingTargetTap).toBe(false);
  });
  it("refuses synthetic source and source bounds without hiding captured fresh input counts", () => {
    const f = streamFixture(),
      trace = JSON.parse(JSON.stringify(f.trace)) as ReplayTrace;
    const input = trace.records.find((r) => r.kind === "input" && r.timeMs === 1240);
    if (input?.kind !== "input") throw Error("fixture");
    input.source = { origin: "synthetic", reason: "test" };
    const r = inspect(f, "3", trace);
    expect(r.status).toBe("unavailable");
    expect(r.rawFreshActionCount).toBe(2);
    const e = deriveCircleEvidence(f.trace, f.map, "3");
    expect(
      deriveStreamInputEvidence(e, f.map, { ...f.trace, limits: { ...f.trace.limits, maxRecords: 1 } }).status,
    ).toBe("unavailable");
  });
  it("never reassigns an actual successful receiver beyond the shared run boundary", () => {
    const objects = "100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n250,192,1240,1,0\n510,192,1320,1,0";
    const knots = [
      [800, 50],
      [1035, 100],
      [1115, 150],
      [1195, 200],
      [1240, 250],
      [1275, 510],
      [1450, 510],
    ];
    const taps = [1035, 1115, 1195, 1275];
    const times = [
      ...new Set([
        ...Array.from({ length: 88 }, (_, i) => 800 + i * 8),
        ...knots.map((p) => p[0]),
        ...taps.map((t) => t + 25),
      ]),
    ].sort((a, b) => a - b);
    const frames = times.map((time) => {
      const k = Math.max(0, knots.findIndex((p) => p[0] >= time) - 1),
        a = knots[k],
        b = knots[k + 1] ?? a;
      return traceFrame(
        time,
        a[1] + ((b[1] - a[1]) * (time - a[0])) / Math.max(1, b[0] - a[0]),
        taps.flatMap((t, i) => (time >= t && time < t + 25 ? [i % 2] : [])),
      );
    });
    const f = errorFixture(objects, frames, "lazer"),
      e = deriveCircleEvidence(f.trace, f.map, "3");
    expect(e.terminal?.mechanism).toBe("ordered-force-miss");
    expect(f.state.hitCircleVerdict["4"].type).toBe("OK");
    const r = inspect(f);
    expect(r.relevantInputIds).not.toContain(press(f.trace, 1275));
    expect(r.assignments).toContainEqual(
      expect.objectContaining({ inputId: press(f.trace, 1275), componentId: "4", confidence: "anchored" }),
    );
  });
  it("proves an omitted terminal slider-head slot across a rhythm change using source absence and actual next-note recovery", () => {
    const f = terminalHead(),
      r = inspect(f, "3/HEAD");
    expect(f.state.hitCircleVerdict["2"].type).toBe("OK");
    expect(f.state.hitCircleVerdict["3/HEAD"].type).toBe("MISS");
    expect(f.state.hitCircleVerdict["4"].type).toBe("GREAT");
    expect(r.status).toBe("supported");
    expect(r.missingTargetTap).toBe(true);
    expect(r.rawFreshActionCount).toBe(1);
    expect(r.relevantInputIds).toEqual([]);
    expect(r.assignments).toContainEqual(
      expect.objectContaining({
        componentId: "3/HEAD",
        relation: "missing",
        eventIds: expect.arrayContaining([press(f.trace, 1195), press(f.trace, 1405)]),
      }),
    );
    const evidence = deriveCircleEvidence(f.trace, f.map, "3/HEAD");
    expect(evidence.domains.liveSuccess.end?.timeMs).toBeLessThan(1405);
    expect(r.assignments.find((a) => a.componentId === "3/HEAD")?.recoveryContext).toMatchObject({
      timeMs: 1405,
      afterTargetLiveEnd: true,
    });
    expect(r.assignments.find((a) => a.componentId === "3/HEAD")?.contextEventIds).toContain(press(f.trace, 1405));
  });
  it.each([{ latePress: true }, { recovery: false }, { shortParent: true }])(
    "does not infer an omitted terminal-head slot without all positive source/lifecycle guards (%j)",
    (options) => {
      const r = inspect(terminalHead(options), "3/HEAD");
      expect(r.missingTargetTap).toBe(false);
    },
  );
});
