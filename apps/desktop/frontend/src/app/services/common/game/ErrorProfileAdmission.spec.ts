import {
  buildBeatmap,
  parseBlueprint,
  parseReplayFramesWithDiagnostics,
  LazerMod,
  ReplayFrame,
  OsuClassicMod,
  deriveCircleEvidence,
} from "@osujs/core";
import { GameSimulator } from "./GameSimulator";
import { classifyCircleLoss } from "../../../../../../../../libs/osu/core/src/gameplay/error-analysis/CircleMechanisms";
import { OsuReplay } from "../../../model/OsuReplay";
import {
  traceMapText,
  traceFrame,
  normalizeTraceState,
} from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";

async function analyze(
  objects: string,
  frames: ReplayFrame[],
  native = false,
  mods: OsuClassicMod[] = [],
  lazerMods: LazerMod[] = [],
  failureTime?: number,
) {
  // Use the real parser's ordered mapping. These synthetic input tokens do not
  // pretend to establish a historical client's initial pre-recording state.
  let prior = 0;
  const raw =
    frames
      .map((f) => {
        const delta = f.time - prior;
        prior = f.time;
        const mask = (f.actions.includes(0) ? 1 : 0) | (f.actions.includes(1) ? 2 : 0);
        return `${delta}|${f.position.x}|${f.position.y}|${mask}`;
      })
      .join(",") + ",";
  const parsed = parseReplayFramesWithDiagnostics(raw);
  const map = buildBeatmap(
    parseBlueprint(traceMapText(objects).replace("OverallDifficulty:9", "OverallDifficulty:5")),
    { mods, lazerMods, addStacking: false },
  );
  const replay: OsuReplay = {
    md5hash: "profile-test",
    beatmapMd5: "profile-map",
    player: "synthetic",
    mods,
    // Even an empty native mod list identifies a native replay. Stable fixtures
    // must omit this metadata so their declared profile is actually exercised.
    ...(native ? { lazerMods } : {}),
    gameVersion: native ? 30000016 : 20260711,
    gameMode: 0,
    frames: parsed.frames,
    parseDiagnostics: parsed.diagnostics,
    ...(native ? { sourceClient: "lazer" as const, sourceProvenance: "user-confirmed" as const } : {}),
    ...(failureTime === undefined
      ? {}
      : {
          lifeBar: [
            { time: 0, health: 1 },
            { time: failureTime, health: 0 },
          ],
        }),
  };
  const simulator = new GameSimulator();
  try {
    simulator.simulateReplay(map, replay);
    expect(simulator.getRulesetFocus()).toBe(native ? "lazer" : "stable");
    simulator.simulate(950);
    const before = normalizeTraceState(simulator.getCurrentState()),
      events = simulator.replayEvents$.value;
    expect(simulator.missExplanations$.value.status).toBe("not-captured");
    const result = await simulator.analyzeMisses();
    expect(["ready", "partial"]).toContain(result.status);
    if (result.status !== "ready" && result.status !== "partial") throw Error(JSON.stringify(result));
    expect(result.identity.analysisProfileId).toBe(native ? "lazer" : "stable");
    if (!result.analysis) throw Error("missing all-error analysis");
    expect(await simulator.analyzeMisses()).toBe(result);
    expect(normalizeTraceState(simulator.getCurrentState())).toEqual(before);
    expect(simulator.replayEvents$.value).toBe(events);
    return { map, result, analysis: result.analysis };
  } finally {
    simulator.clear();
  }
}

describe("required modifier families through actual Analyze", () => {
  for (const native of [false, true]) {
    it.each([
      ["HARD_ROCK", "HR", 7, 5.2, 1],
      ["EASY", "EZ", 2.5, 2, 1],
      ["HIDDEN", "HD", 5, 4, 1],
      ["FLASH_LIGHT", "FL", 5, 4, 1],
      ["DOUBLE_TIME", "DT", 5, 4, 1.5],
      ["NIGHT_CORE", "NC", 5, 4, 1.5],
      ["HALF_TIME", "HT", 5, 4, 0.75],
    ] as const)(
      `native=${native} uses prepared %s geometry/window/clock through Analyze`,
      async (mod, acronym, od, cs, rate) => {
        const { map, analysis } = await analyze(
          "300,192,1000,1,0",
          [traceFrame(0), traceFrame(1080, 300, [0]), traceFrame(1300)],
          native,
          [mod],
          native ? [{ acronym }] : [],
        );
        expect(map.difficulty.overallDifficulty).toBeCloseTo(od, 6);
        expect(map.difficulty.circleSize).toBeCloseTo(cs, 6);
        expect(map.gameClockRate).toBe(rate);
        // +80mapms is independently within100 and outside300 for each listedOD.
        expect(analysis.inventory.atoms.map((a) => a.result)).toEqual(["OK"]);
        expect(analysis.incidents[0].mechanism).toMatchObject({ status: "supported", codes: ["late-tap"] });
        expect(analysis.incidents[0].mechanism.metric).toEqual({ value: Math.round(80 / rate), unit: "ms late" });
      },
    );
  }
  it.each([false, true])(
    "TD native=%s retains logical timing without inventing physical keyboard or finger attribution",
    async (native) => {
      const { analysis } = await analyze(
        "300,192,1000,1,0",
        [traceFrame(0), traceFrame(1060, 300, [0]), traceFrame(1300)],
        native,
        ["TOUCH_DEVICE"],
        native ? [{ acronym: "TD" }] : [],
      );
      // At OD5, +60 map ms is beyond GREAT but within the 100 window in both profiles.
      expect(analysis.inventory.atoms.map((a) => a.result)).toEqual(["OK"]);
      expect(analysis.capabilities.input).toBe("logical-touch-actions");
      expect(analysis.incidents[0].mechanism.headline).toBe("Late tap");
      const player = analysis.incidents.map((i) => `${i.mechanism.headline} ${i.mechanism.description}`).join(" ");
      expect(player).not.toMatch(/keyboard|mouse|finger|hardware|K1|K2|M1|M2/i);
    },
  );

  it.each([false, true])("AP native=%s preserves a manual No tap loss with automated aim", async (native) => {
    const { analysis } = await analyze(
      "300,192,1000,1,0",
      [traceFrame(0), traceFrame(800), traceFrame(1000), traceFrame(1300)],
      native,
      ["AUTO_PILOT"],
      native ? [{ acronym: "AP" }] : [],
    );
    expect(analysis.capabilities).toMatchObject({ aim: "automated", tapping: "manual" });
    expect(analysis.inventory.atoms.map((a) => a.result)).toEqual(["MISS"]);
    expect(analysis.incidents[0].mechanism).toMatchObject({
      status: "supported",
      codes: ["no-tap"],
      headline: "No tap",
    });
  });

  it.each([false, true])("AT native=%s keeps an actually successful replay free of invented errors", async (native) => {
    const { analysis } = await analyze(
      "300,192,1000,1,0\n100,192,1500,1,0",
      [traceFrame(0), traceFrame(1000, 300, [0]), traceFrame(1100), traceFrame(1500, 100, [0]), traceFrame(1800, 100)],
      native,
      ["AUTO_PLAY"],
      native ? [{ acronym: "AT" }] : [],
    );
    expect(analysis.capabilities).toMatchObject({ aim: "automated", tapping: "automated", spinner: "automated" });
    expect(analysis.inventory.atoms).toEqual([]);
    expect(analysis.incidents).toEqual([]);
    expect(analysis.admittedCounts.primary).toBe(0);
  });

  it.each([
    ["DT", 1.2, false],
    ["HT", 0.65, false],
    ["DT", 1.2, true],
    ["HT", 0.65, true],
  ] as const)(
    "DA and custom %s use exact adjusted windows/geometry at rate %s, sampled landing=%s",
    async (acronym, rate, dense) => {
      const objects = "300,192,1000,1,0\n300,192,1500,1,0";
      const frames = [
          traceFrame(0),
          traceFrame(1040, 323, [0]),
          traceFrame(1200, 324),
          ...(dense ? [traceFrame(1420, 324), traceFrame(1480, 324)] : []),
          traceFrame(1500, 324, [0]),
          ...(dense ? [traceFrame(1510, 324, [0])] : []),
          traceFrame(1750, 324),
        ];
      const mods: LazerMod[] = [
          { acronym, settings: { speed_change: rate } },
          { acronym: "DA", settings: { circle_size: 7, overall_difficulty: 9 } },
        ];
      const { map, analysis, result } = await analyze(objects, frames, true, [], mods);
      expect(map.gameClockRate).toBe(rate);
      expect(map.difficulty).toMatchObject({ circleSize: 7, overallDifficulty: 9 });
      // Independently: CS7 radius = 32*(1 - .14*(7-5)) = 23.04.
      // Native OD9 best/100 windows are floor(80-6*9)-.5=25.5,
      // floor(140-8*9)-.5=67.5 map ms. 40ms, x+23 is an accepted100;
      // x+24 is outside that exact radius despite being inside unadjustedCS4.
      expect(map.getHitCircle("0").radius).toBeCloseTo(23.04, 4);
      expect(analysis.inventory.atoms.map((a) => [a.componentId, a.result])).toEqual([
        ["0", "OK"],
        ["1", "MISS"],
      ]);
      expect(result.trace.records.find((r) => r.kind === "resolution" && r.componentId === "0")).toMatchObject({
        result: "OK",
        timeMs: 1040,
        mechanism: "successful-input",
      });
      expect(analysis.incidents.find((i) => i.componentId === "0")?.mechanism).toMatchObject({
        status: "supported",
        codes: ["late-tap"],
        metric: { value: Math.round(40 / rate), unit: "ms late" },
      });
      const missed = analysis.incidents.find((i) => i.componentId === "1")?.mechanism;
      expect(missed).toMatchObject({ status: "supported", codes: ["misaim"] });
      if (!dense) {
        // Sparse sampling still establishes no directional landing. The exact
        // on-time press has a separately certified aim-only correction.
        const primary = classifyCircleLoss(deriveCircleEvidence(result.trace, map, "1"), map, result.trace).diagnostics?.primary;
        expect(primary?.approaches?.episodes[0]).toMatchObject({
          placement: "unproven", spatialCandidates: [],
          limitations: expect.arrayContaining(["no-positive-local-placement", "short-local-trajectory"]),
        });
        expect(primary?.ranking?.selected[0].support?.correction).toMatchObject({
          kind: "same-time-aim", timeMs: 1500, prefix: { parentCount: 1, throughComponentId: "0" },
        });
      }
      const corrected = await analyze(objects, frames.map(f => f.time === 1500 ? { ...f, position: { x: 300, y: 192 } } : f), true, [], mods);
      const resolutions = result.trace.records.filter(r => r.kind === "resolution");
      const correctedResolutions = corrected.result.trace.records.filter(r => r.kind === "resolution");
      expect(correctedResolutions.find(r => r.componentId === "1")).toMatchObject({ result: "GREAT", timeMs: 1500 });
      expect(correctedResolutions.find(r => r.componentId === "0")).toEqual(resolutions.find(r => r.componentId === "0"));
    },
  );

  it.each([1.2, 0.65])("early timing is displayed in player milliseconds at rate %s", async (rate) => {
    const { analysis } = await analyze(
      "300,192,1000,1,0",
      [traceFrame(0), traceFrame(920, 300, [0]), traceFrame(1300)],
      true,
      [],
      [{ acronym: rate > 1 ? "DT" : "HT", settings: { speed_change: rate } }],
    );
    expect(analysis.inventory.atoms[0].result).toBe("OK");
    expect(analysis.incidents[0].mechanism.metric).toEqual({ value: Math.round(80 / rate), unit: "ms early" });
  });

  for (const native of [false, true])
    for (const perfect of [false, true]) {
      it(`${
        perfect ? "PF" : "SD"
      } native=${native} retains the actual fatal penalty and excludes later objects`, async () => {
        const failureTime = perfect ? 1060 : 1200;
        const { result, analysis } = await analyze(
          "300,192,1000,1,0\n300,192,1600,1,0",
          [traceFrame(0), traceFrame(failureTime, 300, perfect ? [0] : []), traceFrame(2000)],
          native,
          perfect ? ["PERFECT"] : ["SUDDEN_DEATH"],
          native ? [{ acronym: perfect ? "PF" : "SD" }] : [],
          failureTime,
        );
        expect(result.trace.domain).toMatchObject({ endTimeMs: failureTime, endpointBasis: "health-derived" });
        expect(analysis.inventory.atoms.map((a) => [a.componentId, a.result])).toEqual([
          ["0", perfect ? "OK" : "MISS"],
        ]);
        expect(analysis.incidents[0].mechanism).toMatchObject({
          status: "supported",
          codes: [perfect ? "late-tap" : "no-tap"],
        });
        expect(result.trace.records.filter((r) => r.kind === "resolution").map((r) => r.componentId)).toEqual(["0"]);
        expect(result.trace.records.some((r) => r.kind === "input" && r.timeMs > failureTime)).toBe(false);
      });
    }
});
