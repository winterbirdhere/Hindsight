import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  OsuAction,
  PathType,
  Slider,
  SliderCheckPoint,
  SliderPath,
} from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import { GameSimulator } from "../common/game/GameSimulator";

function lossyStableCascadeFixture() {
  const blocker = new HitCircle();
  blocker.id = "blocker";
  blocker.hitTime = 1_000;
  blocker.approachDuration = 600;
  blocker.position = { x: 100, y: 100 };

  const head = new HitCircle();
  head.id = "slider/HEAD";
  head.sliderId = "slider";
  head.hitTime = 1_100;
  head.approachDuration = 600;
  head.position = { x: 256, y: 192 };
  head.unstackedPosition = head.position;
  const slider = new Slider(head);
  slider.id = "slider";
  slider.velocity = 1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  const tail = new SliderCheckPoint(slider);
  tail.id = "slider/TAIL";
  tail.type = "LAST_LEGACY_TICK";
  tail.hitTime = 1_164;
  tail.offset = { x: 64, y: 0 };
  slider.checkPoints = [tail];

  const beatmap = new Beatmap(
    [blocker, slider],
    DEFAULT_BEATMAP_DIFFICULTY,
    [],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
  );
  const replay: OsuReplay = {
    md5hash: "lossy-cascade",
    beatmapMd5: "fixture-map",
    gameMode: 0,
    gameVersion: 20200101,
    mods: [],
    player: "Stable Player",
    frames: [
      { time: 0, position: head.position, actions: [] },
      { time: 1_050, position: head.position, actions: [OsuAction.leftButton] },
      { time: 1_060, position: head.position, actions: [] },
      { time: slider.startTime, position: head.position, actions: [] },
      { time: 1_120, position: head.position, actions: [OsuAction.leftButton] },
      { time: tail.hitTime, position: tail.position, actions: [OsuAction.leftButton] },
      { time: slider.endTime, position: slider.endPosition, actions: [OsuAction.leftButton] },
      { time: 1_300, position: slider.endPosition, actions: [] },
    ],
    statistics: {
      count300: 1,
      count100: 1,
      count50: 0,
      countMiss: 0,
      maxCombo: 3,
      score: 10_000,
      perfectCombo: true,
    },
  };
  return { beatmap, blocker, slider, replay };
}

describe("Stable replay judgements remain reconstructed", () => {
  it("does not transfer a spatially invalid head press onto the preceding circle to force a header match", () => {
    const { beatmap, blocker, slider, replay } = lossyStableCascadeFixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);

    expect(simulator.getEventsForRuleset("stable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: blocker.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.head.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.id, verdict: "OK" }),
        expect.objectContaining({ type: "SliderBreak", sliderId: slider.id }),
      ]),
    );
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: false,
      simulatedCounts: [0, 1, 0, 1],
    });
    expect(simulator.getTimingUnreliableHitObjectIds("stable")).toEqual(new Set());
  });

  it("retains the real blocker, head misses and slider break when header totals match", () => {
    const { beatmap, blocker, slider, replay } = lossyStableCascadeFixture();
    if (!replay.statistics) throw new Error("Fixture replay statistics are required");
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, {
      ...replay,
      statistics: {
        ...replay.statistics,
        count300: 0,
        countMiss: 1,
        maxCombo: 1,
      },
    });

    expect(simulator.getEventsForRuleset("stable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: blocker.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.head.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.id, verdict: "OK" }),
      ]),
    );
    expect(simulator.getEventsForRuleset("stable")).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "SliderBreak", sliderId: slider.id })]),
    );
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: true,
      simulatedCounts: [0, 1, 0, 1],
      simulatedMaxCombo: 1,
    });
  });

  it("does not repair a slider whose raw component outcome could change with tracking ownership", () => {
    const { beatmap, blocker, slider, replay } = lossyStableCascadeFixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, {
      ...replay,
      frames: replay.frames.map((frame) =>
        frame.time > 1_120 ? { ...frame, position: { x: 500, y: 380 }, actions: [] } : frame,
      ),
    });

    expect(simulator.getTimingUnreliableHitObjectIds("stable")).toEqual(new Set());
    expect(simulator.getEventsForRuleset("stable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: blocker.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.id, verdict: "MISS" }),
      ]),
    );
  });

  it("retains reconstructed component breaks in a Stable comparison replay", () => {
    const { beatmap, blocker, slider, replay } = lossyStableCascadeFixture();
    const simulator = new GameSimulator();
    if (!replay.statistics) throw new Error("Fixture replay statistics are required");
    const headerMatchingReplay: OsuReplay = {
      ...replay,
      statistics: { ...replay.statistics, count300: 0, countMiss: 1, maxCombo: 1 },
    };
    simulator.simulateReplay(beatmap, headerMatchingReplay);

    const comparison = simulator.compareReplay(
      beatmap,
      { ...headerMatchingReplay, md5hash: "comparison-lossy-cascade" },
      "stable",
    );

    expect(comparison.status).toBe("READY");
    if (comparison.status !== "READY") return;
    expect(comparison.secondary.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: blocker.id, verdict: "MISS" }),
        expect.objectContaining({ hitObjectId: slider.head.id, verdict: "MISS" }),
      ]),
    );
    expect(comparison.secondary.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "SliderBreak", sliderId: slider.id })]),
    );
  });

  it("retains reconstructed completed HUD accuracy when Stable header totals differ", () => {
    const { beatmap, replay } = lossyStableCascadeFixture();
    if (!replay.statistics) throw new Error("Fixture replay statistics are required");
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, {
      ...replay,
      statistics: { ...replay.statistics, count300: 2, count100: 0 },
    });

    simulator.simulate(1_200);
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([0, 1, 0, 1]);
    simulator.simulate(1_300);
    expect(simulator.getCurrentInfo()).toMatchObject({
      verdictCounts: [0, 1, 0, 1],
      accuracy: 1 / 6,
      maxComboSoFar: 1,
    });
  });
});
