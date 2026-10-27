import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { spinnerBonusProgress } from "../src/gameplay/SpinnerBonus";
import { Spinner } from "../src/hitobjects/Spinner";
import { MainHitObjectVerdict } from "../src/gameplay/Verdicts";
import { OsuClassicMod } from "../src/mods/Mods";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const bottom = { x: 256, y: 292 };
const left = { x: 156, y: 192 };
const top = { x: 256, y: 92 };
const right = { x: 356, y: 192 };

function frame(time: number, position: { x: number; y: number }, pressed = false): ReplayFrame {
  return { time, position, actions: pressed ? [OsuAction.leftButton] : [] };
}

function beatmap(spinner: Spinner, mods: OsuClassicMod[] = []): Beatmap {
  return new Beatmap([spinner], DEFAULT_BEATMAP_DIFFICULTY, mods, new ControlPointInfo());
}

function spinner(duration = 1_000, spinsRequired = 1): Spinner {
  const result = new Spinner();
  result.id = "spinner";
  result.startTime = 1_000;
  result.duration = duration;
  result.spinsRequired = spinsRequired;
  return result;
}

describe("Stable spinner reconstruction", () => {
  it.each<{ mods: OsuClassicMod[]; angle: number; verdict: MainHitObjectVerdict }>([
    // Independently reproduced with the source-shaped x86 body oracle on the
    // integer map clock (qa/spinner-scheduling-20260916/synthetic-oracle.py).
    { mods: ["RELAX"], angle: 807.04681, verdict: "OK" },
    { mods: ["RELAX", "DOUBLE_TIME"], angle: 1373.27869, verdict: "GREAT" },
    { mods: ["RELAX", "HALF_TIME"], angle: 606.39362, verdict: "MEH" },
  ])("counts real Relax cursor rotation without recorded buttons ($mods)", ({ mods, angle, verdict }) => {
    const target = spinner();
    const map = beatmap(target, mods);
    const positions = [bottom, left, top, right];
    const frames = Array.from({ length: 9 }, (_, i) => frame(1000 + i * 100, positions[i % 4]));
    frames.push(frame(target.endTime + 1, bottom));
    const state = new BucketedGameStateTimeMachine(frames, map, stableOptions).gameStateAt(1e9);
    expect(state.spinnerState.get(target.id)?.totalSpunAngle).toBeCloseTo(angle, 4);
    expect(state.spinnerState.get(target.id)?.stableRequiredHalfTurns).toBe(5);
    expect(state.spinnerVerdict[target.id]).toEqual({ type: verdict, judgementTime: target.endTime + 1 });
  });

  it("does not clear a Relax spinner without enough cursor rotation", () => {
    const target = spinner();
    const map = beatmap(target, ["RELAX"]);
    const state = new BucketedGameStateTimeMachine(
      [frame(target.startTime, bottom), frame(1500, left), frame(target.endTime + 1, left)],
      map,
      stableOptions,
    ).gameStateAt(1e9);
    expect(state.spinnerState.get(target.id)?.totalSpunAngle).toBeCloseTo(89.93866, 4);
    expect(state.spinnerVerdict[target.id].type).toBe("MISS");
  });

  it("still requires a held button for the same spinning movement without Relax", () => {
    const target = spinner();
    const positions = [bottom, left, top, right];
    const frames = Array.from({ length: 9 }, (_, i) => frame(1000 + i * 100, positions[i % 4]));
    frames.push(frame(target.endTime + 1, bottom));
    const state = new BucketedGameStateTimeMachine(frames, beatmap(target), stableOptions).gameStateAt(1e9);
    expect(state.spinnerState.get(target.id)?.totalSpunAngle).toBe(0);
    expect(state.spinnerVerdict[target.id].type).toBe("MISS");
  });

  it("restores Relax bonus progress and completion after a reverse seek and independent fork", () => {
    const target = spinner(3000);
    const map = beatmap(target, ["RELAX"]);
    const positions = [bottom, left, top, right];
    const frames = Array.from({ length: 49 }, (_, i) => frame(1000 + i * 50, positions[i % 4]));
    frames.push(frame(target.endTime + 1, bottom));
    const machine = new BucketedGameStateTimeMachine(frames, map, stableOptions, 3);
    const completed = { ...machine.gameStateAt(3400).spinnerState.get(target.id) };
    expect(completed.stableScoredHalfTurns).toBeGreaterThan(completed.stableRequiredHalfTurns ?? 0);
    expect(completed.completionTime).toBeLessThan(3400);
    expect(
      spinnerBonusProgress(target, machine.gameStateAt(3400).spinnerState.get(target.id), "stable").score,
    ).toBeGreaterThan(0);
    const fork = machine.fork();
    machine.gameStateAt(target.endTime);
    expect(machine.gameStateAt(999).spinnerState.get(target.id)).toBeUndefined();
    expect(machine.gameStateAt(3400).spinnerState.get(target.id)).toEqual(completed);
    expect(fork.gameStateAt(target.endTime + 1).spinnerVerdict[target.id].type).toBe("GREAT");
  });

  it("records a no-input spinner as an actual MISS across state, events, and aggregate info", () => {
    const target = spinner();
    const map = beatmap(target);
    const state = new BucketedGameStateTimeMachine(
      [frame(target.startTime, bottom), frame(target.endTime + 1, bottom)],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.spinnerVerdict[target.id]).toEqual({ type: "MISS", judgementTime: target.endTime + 1 });
    expect(state.judgedObjects).toEqual([target.id]);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
      verdictCounts: [0, 0, 0, 1],
      currentCombo: 0,
      maxComboSoFar: 0,
    });
    expect(retrieveEvents(state, map.hitObjects, "stable")).toEqual([
      expect.objectContaining({
        type: "HitObjectJudgement",
        eventId: `stable:hit-object-judgement:${target.id}`,
        ruleset: "stable",
        hitObjectId: target.id,
        verdict: "MISS",
        time: target.endTime + 1,
        objectTime: target.endTime,
        judgementTime: target.endTime + 1,
      }),
    ]);
  });

  it("uses Stable half-turn grading after held DT rotation", () => {
    const target = spinner();
    const map = beatmap(target, ["DOUBLE_TIME"]);
    const state = new BucketedGameStateTimeMachine(
      [
        frame(target.startTime, bottom, true),
        frame(1_100, left, true),
        frame(1_200, top, true),
        frame(1_300, right, true),
        frame(target.endTime + 1, right, true),
      ],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    // Intermediate updates cross several boundaries during this sparse gap;
    // only fresh input scores them. Three remains below the 100 threshold.
    expect(state.spinnerState.get(target.id)?.stableScoredHalfTurns).toBe(3);
    expect(state.spinnerVerdict[target.id]).toEqual({ type: "MEH", judgementTime: target.endTime + 1 });
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state)).toMatchObject({
      verdictCounts: [0, 0, 1, 0],
      currentCombo: 1,
      maxComboSoFar: 1,
    });
  });

  it("leaves a spinner after the final replay frame unjudged", () => {
    const target = spinner(2_000);
    const map = beatmap(target);
    const state = new BucketedGameStateTimeMachine(
      [frame(target.startTime, bottom, true), frame(1_500, left, true)],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.currentTime).toBe(1_500);
    expect(state.aliveSpinnerIds.has(target.id)).toBe(true);
    expect(state.spinnerVerdict[target.id]).toBeUndefined();
    expect(state.judgedObjects).toEqual([]);
    expect(
      retrieveEvents(state, map.hitObjects, "stable").filter((event) => event.type === "HitObjectJudgement"),
    ).toEqual([]);
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state).verdictCounts).toEqual([0, 0, 0, 0]);
  });

  it("implicitly clears a zero-required short spinner", () => {
    const target = spinner(100);
    target.applyLazerDefaults(5);
    expect(target.spinsRequired).toBe(0);

    const map = beatmap(target);
    const state = new BucketedGameStateTimeMachine(
      [frame(target.endTime + 1, { x: 256, y: 192 })],
      map,
      stableOptions,
    ).gameStateAt(1e9);

    expect(state.spinnerState.get(target.id)?.totalSpunAngle).toBe(0);
    expect(state.spinnerVerdict[target.id]).toEqual({ type: "GREAT", judgementTime: target.endTime + 1 });
  });
});
