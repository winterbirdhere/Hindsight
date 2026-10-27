import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  OsuAction,
  parseReplayFramesWithDiagnostics,
  ReplayFrame,
} from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { scoringReplayFrames, scoringReplayFramesAsync } from "./GameSimulator";

function map() {
  const circles = [1000, 2000].map((hitTime, index) => {
    const circle = new HitCircle();
    circle.id = `endpoint-${index}`;
    circle.hitTime = hitTime;
    circle.approachDuration = 600;
    circle.position = { x: 256, y: 192 };
    return circle;
  });
  return new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
}

function replay(frames: ReplayFrame[], overrides: Partial<OsuReplay> = {}): OsuReplay {
  return {
    md5hash: "endpoint-source",
    beatmapMd5: "map",
    gameVersion: 20200101,
    player: "synthetic",
    mods: [],
    frames,
    ...overrides,
  };
}

function frame(time: number, x = 256, held = false): ReplayFrame {
  return { time, position: { x, y: 192 }, actions: held ? [OsuAction.leftButton] : [], rawButtonMask: held ? 5 : 0 };
}

const oneGreat = { count300: 1, count100: 0, count50: 0, countMiss: 0, maxCombo: 1, score: 300, perfectCombo: false };

// Expectations follow the pre-M3 replayFramesThrough/scoringReplayFrames snapshot:
// unchanged endpoints return the original array, cutoffs retain the full prefix,
// and only an absent exact endpoint adds an interpolated frame with prior held state.
describe.each(["synchronous", "cooperative"] as const)("scoring replay endpoint provenance: %s", mode => {
  const prepare = (beatmap: Beatmap, source: OsuReplay) => mode === "synchronous" ? scoringReplayFrames(beatmap, source) : scoringReplayFramesAsync(beatmap, source, async () => undefined);
  it.each([0, 5])("retains adjacent raw endpoint actions without dispatching the successor mask %s", async mask => {
    const parsed = parseReplayFramesWithDiagnostics(`0|256|-500|0,0|256|-500|0,800|500|192|0,200|500|192|0,108|500|192|5,12|300|192|${mask},`);
    const source = replay(parsed.frames,{ parseDiagnostics:parsed.diagnostics,lifeBar:[{time:1112,health:0}] });
    const result = await prepare(map(),source);
    expect(result.frames.map(f=>f.time)).toEqual([800,1000,1108,1112]);
    expect(result.frames[3].actions).toEqual([OsuAction.leftButton]);
    expect(result.domain).toMatchObject({ endpointInputBracket: {
      previous:{timeMs:1108,source:{origin:"parsed",parsedFrameIndex:2,rawTokenIndex:4},actions:[OsuAction.leftButton],rawButtonMask:5},
      next:{timeMs:1120,source:{origin:"parsed",parsedFrameIndex:3,rawTokenIndex:5},rawButtonMask:mask},
    }});
    expect(result.domain.frameSources?.[3]).toEqual({origin:"synthetic",reason:"scoring-endpoint-interpolation"});
    expect(source.frames[3].time).toBe(1120);
  });

  it("returns the original array and every same-time sample at the recorded endpoint", async () => {
    const frames = [frame(0), frame(100, 10, true), frame(100, 20), frame(100, 30, true)];
    const result = await prepare(map(), replay(frames));
    expect(result.frames).toBe(frames);
    expect(result.domain).toMatchObject({ endTimeMs: 100, endpointBasis: "recorded-end", synthesizedEndpoint: false });
    expect(result.domain.frameSources).toEqual([
      { origin: "provided-frame", preparedFrameIndex: 0 },
      { origin: "provided-frame", preparedFrameIndex: 1 },
      { origin: "provided-frame", preparedFrameIndex: 2 },
      { origin: "provided-frame", preparedFrameIndex: 3 },
    ]);
  });

  it("retains a real health endpoint and all zero-delta samples without claiming synthesis", async () => {
    const frames = [frame(0), frame(100, 10, true), frame(100, 20), frame(100, 30, true), frame(200)];
    const result = await prepare(
      map(),
      replay(frames, {
        lifeBar: [
          { time: 0, health: 1 },
          { time: 100, health: 0 },
        ],
      }),
    );
    expect(result.frames).toHaveLength(4);
    result.frames.forEach((selected, index) => expect(selected).toBe(frames[index]));
    expect(result.domain).toMatchObject({
      endTimeMs: 100,
      endpointBasis: "health-derived",
      synthesizedEndpoint: false,
    });
    expect(frames).toHaveLength(5);
  });

  it("keeps the health-derived basis when health zero equals the final recorded time", async () => {
    const frames = [frame(0), frame(100)];
    const result = await prepare(map(), replay(frames, { lifeBar: [{ time: 100, health: 0 }] }));
    expect(result.frames).toBe(frames);
    expect(result.domain).toMatchObject({
      endTimeMs: 100,
      endpointBasis: "health-derived",
      synthesizedEndpoint: false,
    });
  });

  it("keeps the real predecessor and interpolates only position while retaining its held actions and raw mask", async () => {
    const frames = [frame(0, 0), frame(100, 100, true), frame(200, 300)];
    const result = await prepare(map(), replay(frames, { lifeBar: [{ time: 150, health: 0 }] }));
    expect(result.frames).toHaveLength(3);
    expect(result.frames[0]).toBe(frames[0]);
    expect(result.frames[1]).toBe(frames[1]);
    expect(result.frames[2]).toEqual({
      time: 150,
      position: { x: 200, y: 192 },
      actions: [OsuAction.leftButton],
      rawButtonMask: 5,
    });
    expect(result.frames[2].actions).not.toBe(frames[1].actions);
    expect(result.domain).toMatchObject({ endTimeMs: 150, endpointBasis: "health-derived", synthesizedEndpoint: true });
    expect(result.domain.frameSources).toEqual([
      { origin: "provided-frame", preparedFrameIndex: 0 },
      { origin: "provided-frame", preparedFrameIndex: 1 },
      { origin: "synthetic", reason: "scoring-endpoint-interpolation" },
    ]);
    expect(frames[2].time).toBe(200);
  });

  it("preserves the existing before-first-frame endpoint semantics without assigning a raw source to synthesis", async () => {
    const frames = [frame(100, 100, true), frame(200, 300)];
    const result = await prepare(map(), replay(frames, { lifeBar: [{ time: 50, health: 0 }] }));
    expect(result.frames).toEqual([
      { time: 50, position: { x: 100, y: 192 }, actions: [OsuAction.leftButton], rawButtonMask: 5 },
    ]);
    expect(result.frames[0]).not.toBe(frames[0]);
    expect(result.domain).toMatchObject({ endTimeMs: 50, initialActionsKnown: false, synthesizedEndpoint: true });
    expect(result.domain.frameSources).toEqual([{ origin: "synthetic", reason: "scoring-endpoint-interpolation" }]);
  });

  it("keeps parser token indices and gap boundaries aligned across a real same-time cutoff", async () => {
    const parsed = parseReplayFramesWithDiagnostics(
      "0|256|-500|0,0|256|-500|0,100|10|192|5,bad,0|20|192|0,100|30|192|2,",
    );
    const source = replay(parsed.frames, { parseDiagnostics: parsed.diagnostics, lifeBar: [{ time: 100, health: 0 }] });
    const result = await prepare(map(), source);
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toBe(parsed.frames[0]);
    expect(result.frames[1]).toBe(parsed.frames[1]);
    expect(result.domain.frameSources).toEqual([
      { origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 2 },
      { origin: "parsed", parsedFrameIndex: 1, rawTokenIndex: 4, discontinuityBefore: ["parser-malformed-token"] },
    ]);
    expect(result.domain.sourceCoverageLimits).toEqual(["initial-actions-unknown", "parser-malformed-token"]);
    expect(result.domain.synthesizedEndpoint).toBe(false);
  });

  it.each([20200101, 30000016])(
    "uses aggregate-inferred only after inference actually chooses an endpoint, version %s",
    async (gameVersion) => {
      const frames = [frame(0), frame(1000, 256, true), frame(1001), frame(2000, 256, true), frame(2100)];
      const result = await prepare(map(), replay(frames, { gameVersion, statistics: oneGreat }));
      expect(result.endTime).toBe(1000);
      expect(result.frames).toHaveLength(2);
      expect(result.frames[0]).toBe(frames[0]);
      expect(result.frames[1]).toBe(frames[1]);
      expect(result.domain).toMatchObject({ endpointBasis: "aggregate-inferred", synthesizedEndpoint: false });
    },
  );

  it.each([20200101, 30000016])(
    "keeps recorded-end when inference is eligible but finds no excess judgement, version %s",
    async (gameVersion) => {
      const frames = [frame(0), frame(1000, 256, true), frame(1100)];
      const result = await prepare(map(), replay(frames, { gameVersion, statistics: oneGreat }));
      expect(result.frames).toBe(frames);
      expect(result.domain).toMatchObject({
        endTimeMs: 1100,
        endpointBasis: "recorded-end",
        synthesizedEndpoint: false,
      });
    },
  );
});

