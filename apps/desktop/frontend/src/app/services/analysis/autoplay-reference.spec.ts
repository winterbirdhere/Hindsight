import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  PathType,
  Slider,
  SliderCheckPoint,
  SliderPath,
  Spinner,
} from "@osujs/core";
import { createAnalyticAutoplayReference } from "./autoplay-reference";
import { summarizeReplayComparisonParticipant } from "./replay-comparison";

function circle(id: string, hitTime: number, x: number, y: number): HitCircle {
  const hitCircle = new HitCircle();
  hitCircle.id = id;
  hitCircle.hitTime = hitTime;
  hitCircle.position = { x, y };
  hitCircle.unstackedPosition = { x, y };
  return hitCircle;
}

function slider(id: string, startTime: number, x: number, y: number): Slider {
  const head = circle(`${id}/HEAD`, startTime, x, y);
  head.sliderId = id;
  const result = new Slider(head);
  result.id = id;
  result.velocity = 1;
  result.repeatCount = 0;
  result.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);
  const checkpoint = new SliderCheckPoint(result);
  checkpoint.id = `${id}/checkpoint`;
  checkpoint.hitTime = startTime + 50;
  checkpoint.offset = { x: 50, y: 0 };
  checkpoint.type = "TICK";
  result.checkPoints = [checkpoint];
  return result;
}

function spinner(id: string, startTime: number, duration: number): Spinner {
  const result = new Spinner();
  result.id = id;
  result.startTime = startTime;
  result.duration = duration;
  return result;
}

function beatmap(hitObjects: Beatmap["hitObjects"], mods: Beatmap["appliedMods"] = []): Beatmap {
  return new Beatmap(hitObjects, { ...DEFAULT_BEATMAP_DIFFICULTY }, [...mods], Beatmap.EMPTY_BEATMAP.controlPointInfo);
}

describe("createAnalyticAutoplayReference", () => {
  it("creates perfect circle/slider judgements and ideal target, path and checkpoint samples", () => {
    const map = beatmap([circle("circle", 100, 20, 30), slider("slider", 200, 100, 100)]);
    const reference = createAnalyticAutoplayReference({
      beatmap: map,
      beatmapMd5: "beatmap-hash",
      cursorSampleIntervalMs: 25,
      maxComboInput: 999,
    });

    expect(reference.participant).toMatchObject({
      id: "autoplay-reference",
      label: "Autoplay reference",
      kind: "autoplay-reference",
      beatmapMd5: "beatmap-hash",
      gameMode: 0,
      baseRate: 1,
      inputFrames: undefined,
      maxComboInput: 999,
      scoreInput: null,
    });
    expect(reference.participant.events.map((event) => event.type)).toEqual([
      "HitObjectJudgement",
      "HitObjectJudgement",
    ]);
    expect(
      reference.participant.events.map((event) =>
        event.type === "HitObjectJudgement" ? [event.hitObjectId, event.verdict] : undefined,
      ),
    ).toEqual([
      ["circle", "GREAT"],
      ["slider", "GREAT"],
    ]);
    expect(reference.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hit-circle-target", objectId: "circle", time: 100 }),
        expect.objectContaining({ kind: "slider-head", objectId: "slider", time: 200 }),
        expect.objectContaining({
          kind: "slider-checkpoint",
          objectId: "slider",
          checkpointId: "slider/checkpoint",
          time: 250,
          position: { x: 150, y: 100 },
        }),
        expect.objectContaining({ kind: "slider-tail", objectId: "slider", time: 300 }),
      ]),
    );
    expect(reference.participant.cursorFrames.length).toBeGreaterThan(3);
    expect(reference.limitations.map((limitation) => limitation.code)).toEqual(["ANALYTIC_REFERENCE_ONLY"]);
    expect(summarizeReplayComparisonParticipant(reference.participant)).toEqual({
      counts: { count300: 2, count100: 0, count50: 0, countMiss: 0, total: 2 },
      accuracy: 1,
      maxComboInput: 999,
      scoreInput: null,
      sliderBreakCount: 0,
    });
  });

  it("includes a perfect spinner judgement while exposing trajectory and overlap limitations", () => {
    const map = beatmap([
      slider("slider", 200, 100, 100),
      circle("overlap", 250, 400, 300),
      spinner("spinner", 400, 100),
    ]);
    const reference = createAnalyticAutoplayReference({
      beatmap: map,
      beatmapMd5: "beatmap-hash",
      cursorSampleIntervalMs: 25,
    });

    expect(reference.participant.events).toHaveLength(3);
    expect(
      reference.participant.events.some(
        (event) => event.type === "HitObjectJudgement" && event.hitObjectId === "spinner",
      ),
    ).toBe(true);
    expect(reference.cursorExcludedRanges).toEqual([
      {
        startTime: 400,
        endTime: 500,
        reason: "Analytic Autoplay does not claim a spinner cursor trajectory",
        objectId: "spinner",
      },
    ]);
    expect(reference.participant.cursorExcludedRanges).toEqual(reference.cursorExcludedRanges);
    expect(reference.limitations.map((limitation) => limitation.code)).toEqual([
      "ANALYTIC_REFERENCE_ONLY",
      "MAX_COMBO_UNAVAILABLE",
      "SPINNER_TRAJECTORY_OMITTED",
      "OVERLAPPING_OBJECTS",
      "AMBIGUOUS_CURSOR_SAMPLE",
    ]);
    expect(reference.coverage).toEqual({
      perfectMainObjectJudgements: 3,
      omittedSpinnerTrajectories: 1,
      overlappingObjectPairs: 1,
      ambiguousCursorTimes: 1,
    });
    expect(summarizeReplayComparisonParticipant(reference.participant)).toMatchObject({
      counts: { count300: 3, count100: 0, count50: 0, countMiss: 0, total: 3 },
      accuracy: 1,
    });
  });
});
