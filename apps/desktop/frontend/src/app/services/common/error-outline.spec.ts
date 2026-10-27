import type { Beatmap, ReplayAnalysisEvent } from "@osujs/core";
import type { Incident } from "../analysis/incidents";
import type { ReplayError } from "../analysis/replay-events";
import { errorMarks, errorOutlineAlpha, errorOutlineHandover, ErrorOutlineStore, ErrorOutlineTarget, errorOutlineTargets } from "./error-outline";

const MISS_RED = 0xff7082;
const BREAK_LILAC = 0xc7b3ff;

// Scale 0.5 gives a 32 px radius (64 × 0.5).
const circle = (id: string, hitTime: number, sliderId?: string) => ({ type: "HIT_CIRCLE", id, hitTime, scale: 0.5, sliderId });
const slider = (id: string, startTime: number, endTime = startTime + 1_000) => ({ type: "SLIDER", id, startTime, endTime, scale: 0.5 });
const spinner = (id: string, startTime = 5_000) => ({ type: "SPINNER", id, startTime, endTime: startTime + 1_000 });

function beatmapOf(...objects: Array<{ id: string; sliderId?: string }>) {
  const byId = Object.fromEntries(objects.map((object) => [object.id, object]));
  // A slider's head is found by its id; the beatmap's own list has the slider only.
  const hitObjects = objects.filter((object) => object.sliderId === undefined);
  return { getHitObject: (id: string) => byId[id], hitObjects } as unknown as Beatmap;
}

const missEvent = (hitObjectId: string, objectTime: number, time: number, x: number, extra: object = {}) =>
  ({
    type: "HitObjectJudgement",
    verdict: "MISS",
    hitObjectId,
    objectTime,
    time,
    position: { x, y: 100 },
    ruleset: "stable",
    ...extra,
  }) as unknown as ReplayAnalysisEvent;

const breakEvent = (eventId: string, sliderId: string, objectTime: number, time: number, x: number) =>
  ({
    type: "SliderBreak",
    eventId,
    sliderId,
    componentId: `${sliderId}/tick`,
    componentType: "TICK",
    objectTime,
    judgementTime: time,
    time,
    position: { x, y: 200 },
    ruleset: "stable",
  }) as unknown as ReplayAnalysisEvent;

const missError = (hitObjectId: string, time: number): ReplayError => ({ id: `miss:${hitObjectId}`, time, type: "MISS", hitObjectId });
const incident = (errorIndices: number[], leadIndex = errorIndices[0]): Incident => ({
  id: `incident-${errorIndices[0]}`,
  errorIndices,
  leadIndex,
  links: [],
});

describe("errorOutlineTargets", () => {
  const beatmap = beatmapOf(circle("c1", 1_000), circle("c2", 1_200), slider("s1", 1_500), circle("s1/head", 1_500, "s1"), spinner("sp"));
  const events = [
    missEvent("c1", 1_000, 1_120, 50),
    missEvent("c2", 1_200, 1_320, 80),
    breakEvent("stable:slider-break:s1/tick", "s1", 2_300, 2_310, 260),
  ];
  const errors: ReplayError[] = [
    missError("c1", 1_000),
    missError("c2", 1_200),
    { id: "stable:slider-break:s1/tick", time: 2_300, type: "SLIDER_BREAK", sliderId: "s1" },
  ];
  const incidents = [incident([0, 1]), incident([2])];
  const targets = (selectedIndex: number, overrides: Partial<Parameters<typeof errorOutlineTargets>[0]> = {}) =>
    errorOutlineTargets({ mode: "selected", errors, incidents, selectedIndex, events, ruleset: "stable", beatmap, ...overrides });

  it("outlines nothing while no error is inspected", () => {
    expect(targets(-1)).toEqual([]);
  });

  it("outlines the inspected miss where it was judged, from its judgement on: when the game shows the miss", () => {
    expect(targets(0)[0]).toEqual<ErrorOutlineTarget>({
      errorId: "miss:c1",
      emphasis: "full",
      color: MISS_RED,
      position: { x: 50, y: 100 },
      radius: 32,
      appearTime: 1_120,
      holdFrom: 1_120,
      holdMs: 700,
      markObjectId: "c1",
      trail: [],
      taps: [],
      // The incident's other miss, "c2", is judged at 1320.
      supersededAt: 1_320,
    });
  });

  it("adds the other errors of the same incident as members, and none from other incidents", () => {
    expect(targets(0).map((target) => [target.errorId, target.emphasis])).toEqual([
      ["miss:c1", "full"],
      ["miss:c2", "light"],
    ]);
    expect(targets(1).map((target) => [target.errorId, target.emphasis])).toEqual([
      ["miss:c2", "full"],
      ["miss:c1", "light"],
    ]);
  });

  it("outlines every error at full weight in All mode, whatever is inspected", () => {
    for (const selectedIndex of [-1, 0, 2]) {
      expect(targets(selectedIndex, { mode: "all" }).map((target) => [target.errorId, target.emphasis])).toEqual([
        ["miss:c1", "full"],
        ["miss:c2", "full"],
        ["stable:slider-break:s1/tick", "full"],
      ]);
    }
  });

  it("outlines nothing while the option is off", () => {
    expect(targets(0, { mode: "off" })).toEqual([]);
  });

  it("puts a slider break's ring on the point that broke, in the slider-break colour, from that point's judgement", () => {
    expect(targets(2)).toEqual<ErrorOutlineTarget[]>([
      {
        errorId: "stable:slider-break:s1/tick",
        emphasis: "full",
        color: BREAK_LILAC,
        position: { x: 260, y: 200 },
        radius: 32,
        appearTime: 2_310,
        holdFrom: 2_310,
        holdMs: 700,
        markObjectId: "s1",
        trail: [],
        taps: [],
      },
    ]);
  });

  it("marks the slider, not its head, in the key overlay for a missed slider head", () => {
    const [target] = errorOutlineTargets({
      mode: "selected",
      errors: [missError("s1/head", 2_000)],
      incidents: [incident([0])],
      selectedIndex: 0,
      events: [missEvent("s1/head", 2_000, 2_100, 300, { ruleset: "lazer", isSliderHead: true })],
      ruleset: "lazer",
      beatmap,
    });
    expect(target).toMatchObject({ markObjectId: "s1", appearTime: 2_100, position: { x: 300, y: 100 } });
  });

  it("uses the judgement of the ruleset in view", () => {
    const both = [missEvent("c1", 1_000, 1_090, 11, { ruleset: "lazer" }), ...events];
    expect(targets(0, { events: both })[0]).toMatchObject({ holdFrom: 1_120, position: { x: 50, y: 100 } });
    expect(targets(0, { events: both, ruleset: "lazer" })[0]).toMatchObject({ holdFrom: 1_090, position: { x: 11, y: 100 } });
  });

  it("appears with the judgement of a miss judged early, and is held from there", () => {
    // An early tap is judged before the object's time: the ring comes with the ✕, not later.
    const early = [missEvent("c1", 1_000, 880, 50)];
    expect(targets(0, { events: early, incidents: [incident([0])] })[0]).toMatchObject({ appearTime: 880, holdFrom: 880 });
  });

  it("never appears at the object's own time, while the object can still be hit: only with its judgement", () => {
    expect(targets(0, { mode: "all" }).map((target) => [target.appearTime, target.holdFrom])).toEqual([
      [1_120, 1_120],
      [1_320, 1_320],
      [2_310, 2_310],
    ]);
  });

  describe("how long the ring is held", () => {
    const holdMs = (overrides: Parameters<typeof targets>[1]) => targets(0, { incidents: [incident([0])], ...overrides })[0].holdMs;
    // The miss "c1" is at 1000.
    const among = (...times: number[]) => beatmapOf(circle("c1", 1_000), ...times.map((time, index) => circle(`n${index}`, time)));

    it("follows the map's pace: four times the gap to the nearest object, between 0.3 s and 0.7 s", () => {
      expect(holdMs({ beatmap: among(900) })).toBe(400);
      expect(holdMs({ beatmap: among(950) })).toBe(300);
      expect(holdMs({ beatmap: among(700) })).toBe(700);
    });

    it("takes the nearer of the object before and the object after", () => {
      expect(holdMs({ beatmap: among(700, 1_090) })).toBe(360);
      expect(holdMs({ beatmap: among(910, 1_300) })).toBe(360);
    });

    it("is 0.7 s where the error has no neighbour", () => {
      expect(holdMs({ beatmap: among() })).toBe(700);
    });

    it("measures the gap as the player experienced it with a faster clock", () => {
      // 150 ms of map time is 100 ms at 1.5×.
      expect(holdMs({ beatmap: among(850), clockRate: 1.5 })).toBe(400);
    });
  });

  describe("a run of errors in All mode", () => {
    const followers = (overrides: Parameters<typeof targets>[1] = {}) =>
      targets(-1, { mode: "all", ...overrides }).map((target) => [target.errorId, target.follower === true]);

    it("marks as a follower an error that appears while the one before it is still held", () => {
      // "c1" is judged at 1120 and held 0.7 s, to 1820: "c2", judged at 1320, follows it. The slider break, judged at 2310, does not.
      expect(followers()).toEqual([
        ["miss:c1", false],
        ["miss:c2", true],
        ["stable:slider-break:s1/tick", false],
      ]);
    });

    it("keeps the run going from one error to the next, however long it gets", () => {
      const times = [1_000, 1_600, 2_200, 4_000];
      const run = {
        beatmap: beatmapOf(...times.map((time, index) => circle(`r${index}`, time))),
        errors: times.map((time, index) => missError(`r${index}`, time)),
        events: times.map((time, index) => missEvent(`r${index}`, time, time + 120, 50)),
      };
      // The third is 1.2 s after the first, but within the hold of the second.
      expect(followers(run).map(([, follower]) => follower)).toEqual([false, true, true, false]);
    });

    it("measures the hold as the player experienced it with a faster clock", () => {
      const apart = {
        beatmap: beatmapOf(circle("r0", 1_000), circle("r1", 2_000)),
        errors: [missError("r0", 1_000), missError("r1", 2_000)],
        events: [missEvent("r0", 1_000, 1_120, 50), missEvent("r1", 2_000, 2_120, 50)],
      };
      expect(followers(apart).map(([, follower]) => follower)).toEqual([false, false]);
      // 0.7 s is 1050 ms of map time at 1.5×: held to 2170.
      expect(followers({ ...apart, clockRate: 1.5 }).map(([, follower]) => follower)).toEqual([false, true]);
    });

    it("of errors that appear together outlines the first", () => {
      const together = { events: [missEvent("c1", 1_000, 1_120, 50), missEvent("c2", 1_000, 1_120, 80), events[2]], errors: [missError("c1", 1_000), missError("c2", 1_000), errors[2]] };
      expect(followers(together).map(([, follower]) => follower)).toEqual([false, true, false]);
    });

    it("has no followers in Selected mode: the inspected incident is shown whole", () => {
      expect(targets(0).map((target) => target.follower)).toEqual([undefined, undefined]);
    });
  });

  describe("newest first", () => {
    const superseded = (selectedIndex: number, overrides: Parameters<typeof targets>[1] = {}) =>
      targets(selectedIndex, overrides).map((target) => [target.errorId, target.supersededAt]);

    it("says when the next outlined error's ring appears, so an earlier one can make way for it", () => {
      // In All mode "c2" follows "c1" and has no ring: the next ring after "c1" is the slider break's.
      expect(superseded(-1, { mode: "all" })).toEqual([
        ["miss:c1", 2_310],
        ["miss:c2", undefined],
        ["stable:slider-break:s1/tick", undefined],
      ]);
    });

    it("counts only the errors that are outlined", () => {
      expect(superseded(0)).toEqual([
        ["miss:c1", 1_320],
        ["miss:c2", undefined],
      ]);
      expect(superseded(1)).toEqual([
        ["miss:c2", undefined],
        ["miss:c1", 1_320],
      ]);
    });
  });

  describe("with the miss trail on", () => {
    // One sample every 50 ms from 0 to 1400, moving along x at so many pixels a millisecond.
    const moving = (pixelsPerMs: number) => Array.from({ length: 29 }, (_unused, index) => ({ time: index * 50, position: { x: index * 50 * pixelsPerMs, y: 7 } }));
    // Fast enough that the trail never has to reach back to be long enough: x = time.
    const frames = moving(1);
    // On the circle of whichever miss is asked about ("c1" is judged at x 50, "c2" at x 80; both y 100, radius 32).
    const tap = (timeMs: number, certainty: "attributed" | "ambiguous" = "attributed") => ({ inputId: `in-${timeMs}`, timeMs, position: { x: 60 + timeMs / 1000, y: 100 }, certainty });
    // The miss "c1" is at 1000 and judged at 1120; the object before it, if any, is at `previous`.
    const before = (previous?: number) => beatmapOf(...(previous === undefined ? [] : [circle("c0", previous)]), circle("c1", 1_000));
    const trailed = (taps: ReturnType<typeof tap>[], clockRate = 1, overrides: Parameters<typeof targets>[1] = {}) =>
      targets(0, { incidents: [incident([0])], beatmap: before(850), trail: { frames, clockRate, taps: () => taps }, ...overrides })[0];
    const times = (target: ErrorOutlineTarget) => target.trail.map((point) => point.time);

    it("keeps the cursor's recorded samples of the movement into the object: from the object before it to the end of its judgement", () => {
      expect(trailed([]).trail).toEqual([850, 900, 950, 1_000, 1_050, 1_100].map((time) => ({ x: time, y: 7, time })));
    });

    it("starts no less than 0.1 s and no more than 0.4 s before the object, and 0.4 s before one with nothing before it", () => {
      expect(times(trailed([], 1, { beatmap: before(950) }))[0]).toBe(900);
      expect(times(trailed([], 1, { beatmap: before(100) }))[0]).toBe(600);
      expect(times(trailed([], 1, { beatmap: before() }))[0]).toBe(600);
    });

    it("does not take the object's own time, a rounding away from the error's, for the object before it", () => {
      expect(times(trailed([], 1, { beatmap: beatmapOf(circle("c0", 850), circle("c1", 999.4)) }))[0]).toBe(850);
    });

    it("measures the limits in real time, so they are longer in map time with Double Time", () => {
      expect(times(trailed([], 1.5, { beatmap: before(925) }))[0]).toBe(850);
      expect(times(trailed([], 1.5, { beatmap: before(100) }))[0]).toBe(400);
    });

    it("takes the end of a slider as where the cursor came from", () => {
      expect(times(trailed([], 1, { beatmap: beatmapOf(slider("s0", 300, 900), circle("c1", 1_000)) }))[0]).toBe(900);
    });

    it("reaches further back for a movement too short to read: two diameters at least, within the 0.4 s", () => {
      const slow = (pixelsPerMs: number) => times(trailed([], 1, { trail: { frames: moving(pixelsPerMs), clockRate: 1, taps: () => [] } }))[0];
      // Radius 32: 128 px. At half a pixel a millisecond, 850 to 1100 is 125 px: one sample more.
      expect(slow(0.5)).toBe(800);
      expect(slow(0.1)).toBe(600);
    });

    it("ends at the last tap the analysis attributes to the object, and not at an ambiguous one", () => {
      expect(times(trailed([tap(1_043)]))).toEqual([850, 900, 950, 1_000]);
      expect(times(trailed([tap(1_010), tap(1_060)])).pop()).toBe(1_050);
      expect(times(trailed([tap(1_043, "ambiguous")])).pop()).toBe(1_100);
    });

    it("still shows 0.1 s of the way to a tap that came before the object's time", () => {
      // The object before is 60 ms away; the tap came at 957.
      const early = trailed([tap(957)], 1, { beatmap: before(940), trail: { frames: moving(3), clockRate: 1, taps: () => [tap(957)] } });
      expect(times(early)).toEqual([900, 950]);
    });

    it("keeps the newest samples when there are more than it draws", () => {
      const dense = Array.from({ length: 1_401 }, (_unused, time) => ({ time, position: { x: time, y: 7 } }));
      const many = times(trailed([], 1, { beatmap: before(), trail: { frames: dense, clockRate: 1, taps: () => [] } }));
      expect([many.length, many[0], many[many.length - 1]]).toEqual([512, 609, 1_120]);
    });

    it("makes way for the next error when that one is judged, and not before its own taps are all there", () => {
      // The next miss, "c2", is judged at 1170.
      const close = {
        incidents: [incident([0, 1])],
        beatmap: beatmapOf(circle("c0", 850), circle("c1", 1_000), circle("c2", 1_050)),
        events: [missEvent("c1", 1_000, 1_120, 50), missEvent("c2", 1_050, 1_170, 80)],
        errors: [missError("c1", 1_000), missError("c2", 1_050)],
      };
      expect(trailed([], 1, close).supersededAt).toBe(1_170);
      expect(trailed([tap(1_043)], 1, close).supersededAt).toBe(1_170);
      // A tap the analysis is unsure about, later than that: it is shown first.
      expect(trailed([tap(1_180, "ambiguous")], 1, close).supersededAt).toBe(1_180);
    });

    it("keeps the trail for an aim cause and for an error without a cause, and drops it for any other cause", () => {
      const caused = (kind: "aim" | "other" | undefined) =>
        trailed([tap(1_043)], 1, { trail: { frames, clockRate: 1, taps: () => [tap(1_043)], causeKind: () => kind } });
      expect(caused("aim").trail.length).toBeGreaterThan(0);
      expect(caused(undefined).trail.length).toBeGreaterThan(0);
      // A late tap: the cursor was on the circle, so the path says nothing. The tap is still marked.
      expect(caused("other").trail).toEqual([]);
      expect(caused("other").taps).toHaveLength(1);
    });

    it("gives each tap its place, its time and its offset from the object in real milliseconds", () => {
      expect(trailed([tap(957), tap(1_043, "ambiguous")]).taps).toEqual([
        { position: { x: 60.957, y: 100 }, time: 957, certainty: "attributed", offsetMs: -43 },
        { position: { x: 61.043, y: 100 }, time: 1_043, certainty: "ambiguous", offsetMs: 43 },
      ]);
      // 60 ms of map time is 40 ms for the player at 1.5×.
      expect(trailed([tap(1_060)], 1.5).taps[0].offsetMs).toBe(40);
    });

    it("starts the trail early enough to hold an earlier ambiguous tap, but never more than a second before the object", () => {
      expect(times(trailed([tap(640, "ambiguous")]))[0]).toBe(650);
      const longAgo = [{ time: -100, position: { x: 0, y: 7 } }, ...frames];
      const far = [tap(-500, "ambiguous")];
      expect(times(trailed(far, 1, { trail: { frames: longAgo, clockRate: 1, taps: () => far } }))[0]).toBe(0);
    });

    it("asks for the taps of each error itself, never of a neighbour", () => {
      const asked: string[] = [];
      const taps = (error: ReplayError) => {
        asked.push(error.id);
        return error.id === "miss:c2" ? [tap(1_210)] : [];
      };
      const result = targets(0, { trail: { frames, clockRate: 1, taps } });
      expect(asked).toEqual(["miss:c1", "miss:c2"]);
      expect(result.map((target) => target.taps.length)).toEqual([0, 1]);
      expect(result[1].taps[0].offsetMs).toBe(10);
    });

    it("writes the offset as short as it can, marks an ambiguous one, and only when labels are on", () => {
      const labelOf = (one: ReturnType<typeof tap>) =>
        targets(0, { incidents: [incident([0])], trail: { frames, clockRate: 1, labels: true, taps: () => [one] } })[0].taps[0].label;
      expect([tap(957), tap(1_000), tap(1_043), tap(1_060, "ambiguous")].map(labelOf)).toEqual(["−43 ms", "0 ms", "+43 ms", "+60 ms ?"]);
      expect(trailed([tap(957)]).taps[0].label).toBeUndefined();
    });

    describe("a tap outside the circle", () => {
      // The miss "c1" is judged at (50, 100) and its radius is 32.
      const at = (x: number, certainty: "attributed" | "ambiguous" = "attributed") => ({
        inputId: `in-${x}`,
        timeMs: 1_010,
        position: { x, y: 100 },
        certainty,
      });
      const labelled = (taps: ReturnType<typeof at>[], ruleset: "stable" | "lazer" = "stable") => {
        const judged = [missEvent("c1", 1_000, 1_120, 50, { ruleset })];
        return targets(0, {
          incidents: [incident([0])],
          events: judged,
          ruleset,
          trail: { frames, clockRate: 1, labels: true, taps: () => taps },
        })[0].taps;
      };
      // Each tap on its own, as the only tap of the error.
      const measured = (taps: ReturnType<typeof at>[], ruleset: "stable" | "lazer" = "stable") =>
        taps.map((one) => {
          const [entry] = labelled([one], ruleset);
          return [entry.outsideBy === undefined ? undefined : Number(entry.outsideBy.toFixed(3)), entry.label];
        });

      it("writes one number for an error with several taps: the tap that came nearest to counting", () => {
        const labels = (taps: ReturnType<typeof at>[]) => labelled(taps).map((entry) => entry.label);
        // Two presses, both outside: the nearer one.
        expect(labels([at(87.1), at(84)])).toEqual([undefined, "2 px out"]);
        // One on the circle: its timing was the problem, whatever the other did.
        expect(labels([at(84), at(60)])).toEqual([undefined, "+10 ms"]);
        // A tap the analysis is sure of before one it is not.
        expect(labels([at(84, "ambiguous"), at(95)])).toEqual([undefined, "13 px out"]);
        // Both on the circle: the one nearer the object's time.
        const early = { inputId: "in-early", timeMs: 957, position: { x: 60, y: 100 }, certainty: "attributed" as const };
        expect(labels([early, at(60)])).toEqual([undefined, "+10 ms"]);
        // Every tap is still measured and marked.
        expect(labelled([at(87.1), at(84)]).map((entry) => entry.outsideBy !== undefined)).toEqual([true, true]);
      });

      it("says how far outside it landed instead of its timing, and keeps the timing for a tap on the circle", () => {
        // Stable hits out to 32 × 1.00041 = 32.013 from the centre.
        expect(measured([at(60), at(82), at(82.5), at(84), at(95)])).toEqual([
          [undefined, "+10 ms"],
          [undefined, "+10 ms"],
          [0.487, "0.5 px out"],
          [1.987, "2 px out"],
          [12.987, "13 px out"],
        ]);
      });

      it("uses the game's own hit test for the ruleset: Lazer has no Stable allowance", () => {
        // 32.01 from the centre: on the circle in Stable, a hair outside in Lazer.
        expect(measured([at(82.01)], "stable")).toEqual([[undefined, "+10 ms"]]);
        expect(measured([at(82.01)], "lazer")).toEqual([[0.01, "0.1 px out"]]);
      });

      it("marks an ambiguous one the same way", () => {
        expect(measured([at(84, "ambiguous")])).toEqual([[1.987, "2 px out ?"]]);
      });

      it("measures without writing anything while labels are off", () => {
        const [entry] = trailed([at(84)]).taps;
        expect(entry.outsideBy).toBeCloseTo(1.987, 3);
        expect(entry.label).toBeUndefined();
      });
    });

    it("has no trail without recorded samples in the span", () => {
      expect(trailed([], 1, { trail: { frames: [], clockRate: 1, taps: () => [] } })).toMatchObject({ trail: [], taps: [] });
    });
  });

  it.each([
    ["an error with no judgement in the events", { events: [] }],
    ["an object the beatmap does not have", { beatmap: beatmapOf() }],
    ["no beatmap", { beatmap: undefined }],
  ])("draws nothing for %s rather than guessing a place", (_name, overrides) => {
    expect(targets(0, { incidents: [incident([0])], ...overrides })).toEqual([]);
  });

  it("draws nothing for a spinner or an analysis error", () => {
    const odd: ReplayError[] = [missError("sp", 5_000), { id: "analysis", time: 6_000, type: "ANALYSIS_ERROR" }];
    const input = { mode: "selected" as const, errors: odd, incidents: [incident([0]), incident([1])], events: [missEvent("sp", 5_000, 5_000, 256)], ruleset: "stable" as const, beatmap };
    expect(errorOutlineTargets({ ...input, selectedIndex: 0 })).toEqual([]);
    expect(errorOutlineTargets({ ...input, selectedIndex: 1 })).toEqual([]);
  });
});

describe("errorOutlineAlpha", () => {
  const target = { appearTime: 1_000, holdFrom: 2_000 } as ErrorOutlineTarget;
  // Hold 700 ms, fade 200 ms: there at once at 1000, full to 2700, gone at 2900.
  it.each([
    [999, 0],
    [1_000, 1],
    [1_100, 1],
    [2_000, 1],
    [2_700, 1],
    [2_800, 0.5],
    [2_900, 0],
    [5_000, 0],
  ])("at %i ms is %d", (time, alpha) => {
    expect(errorOutlineAlpha(time, target, 700, 200)).toBeCloseTo(alpha, 6);
  });

  it("lasts half as long in map time at half speed", () => {
    expect(errorOutlineAlpha(2_350, target, 350, 100)).toBe(1);
    expect(errorOutlineAlpha(2_400, target, 350, 100)).toBeCloseTo(0.5, 6);
    expect(errorOutlineAlpha(2_450, target, 350, 100)).toBe(0);
  });
});

describe("errorOutlineHandover", () => {
  const target = (appearTime: number, supersededAt?: number) => ({ appearTime, supersededAt }) as ErrorOutlineTarget;

  it("is nothing for an error no later one follows, and nothing until the later one appears", () => {
    expect(errorOutlineHandover(9_000, target(1_000), 60, 150)).toBe(0);
    expect(errorOutlineHandover(1_100, target(1_000, 1_125), 60, 150)).toBe(0);
    expect(errorOutlineHandover(1_125, target(1_000, 1_125), 60, 150)).toBe(0);
  });

  it("takes as long as the two errors are apart", () => {
    expect(errorOutlineHandover(1_187.5, target(1_000, 1_125), 60, 150)).toBeCloseTo(0.5, 6);
    expect(errorOutlineHandover(1_250, target(1_000, 1_125), 60, 150)).toBe(1);
    expect(errorOutlineHandover(9_000, target(1_000, 1_125), 60, 150)).toBe(1);
  });

  it("but no less and no more than its limits", () => {
    expect(errorOutlineHandover(1_070, target(1_000, 1_040), 60, 150)).toBeCloseTo(0.5, 6);
    expect(errorOutlineHandover(1_575, target(1_000, 1_500), 60, 150)).toBeCloseTo(0.5, 6);
  });
});

describe("errorMarks", () => {
  const beatmap = beatmapOf(circle("c1", 1_000), circle("c2", 1_200), slider("s1", 1_500), circle("s1/head", 1_500, "s1"), spinner("sp"));
  const sliderBreak = (id: string, sliderId: string): ReplayError => ({ id, time: 2_300, type: "SLIDER_BREAK", sliderId });

  it("gives each error's object the error's colour: a miss red, a slider break lilac", () => {
    const marks = errorMarks([missError("c1", 1_000), missError("c2", 1_200), sliderBreak("break", "s1")], beatmap);
    expect(Object.fromEntries(marks)).toEqual({ c1: MISS_RED, c2: MISS_RED, s1: BREAK_LILAC });
  });

  it("marks the slider for an error on its head, and lets a miss win where an object has both", () => {
    expect(Object.fromEntries(errorMarks([missError("s1/head", 1_500)], beatmap))).toEqual({ s1: MISS_RED });
    const both = [sliderBreak("break", "s1"), missError("s1/head", 1_500)];
    expect(Object.fromEntries(errorMarks(both, beatmap))).toEqual({ s1: MISS_RED });
    expect(Object.fromEntries(errorMarks([...both].reverse(), beatmap))).toEqual({ s1: MISS_RED });
  });

  it("marks nothing for a spinner, an analysis error, an object the beatmap does not have, or no beatmap", () => {
    const odd: ReplayError[] = [missError("sp", 5_000), { id: "analysis", time: 6_000, type: "ANALYSIS_ERROR" }, missError("gone", 7_000)];
    expect(errorMarks(odd, beatmap).size).toBe(0);
    expect(errorMarks([missError("c1", 1_000)], undefined).size).toBe(0);
  });
});

describe("ErrorOutlineStore", () => {
  const target = (errorId: string, emphasis: ErrorOutlineTarget["emphasis"], color: number, markObjectId: string) =>
    ({ errorId, emphasis, color, markObjectId }) as ErrorOutlineTarget;

  it("starts empty and keeps the rings and the key overlay's marks it is given, each on its own", () => {
    const store = new ErrorOutlineStore();
    expect(store.targets).toEqual([]);
    expect(store.marks.size).toBe(0);
    const targets = [target("a", "full", MISS_RED, "c1")];
    store.setTargets(targets);
    expect(store.targets).toBe(targets);
    // The marks do not come from the rings: they have a setting of their own.
    expect(store.marks.size).toBe(0);
    const marks = new Map([["s1", BREAK_LILAC]]);
    store.setMarks(marks);
    expect(store.marks).toBe(marks);
    store.setTargets([]);
    expect(store.marks).toBe(marks);
  });

  it("remembers which error is inspected", () => {
    const store = new ErrorOutlineStore();
    expect(store.inspectedErrorId).toBeUndefined();
    store.setInspected("miss:c1");
    expect(store.inspectedErrorId).toBe("miss:c1");
    store.setInspected(undefined);
    expect(store.inspectedErrorId).toBeUndefined();
  });
});
