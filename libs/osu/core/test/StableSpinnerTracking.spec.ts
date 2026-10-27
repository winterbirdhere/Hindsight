import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { GameplayInfoEvaluator } from "../src/gameplay/GameplayInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { Spinner } from "../src/hitobjects/Spinner";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";
import {
  stableRequiredSpinnerHalfTurns,
  stableSpinnerVerdict,
  updateStableSpinnerRotation,
  usesLegacyStableSpinnerRules,
} from "../src/gameplay/StableSpinnerTracking";
import { initialSpinnerState } from "../src/gameplay/SpinnerTracking";
import { spinnerBonusProgress, spinnerProgressForState } from "../src/gameplay/SpinnerBonus";
import { readFileSync } from "fs";
import { join } from "path";

const rawFrames: ReplayFrame[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures/crystalia-short-spinner.json"), "utf8"),
);

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function reproduction() {
  const spinner = new Spinner();
  spinner.id = "82";
  spinner.startTime = 27_388;
  spinner.duration = 611;
  spinner.applyLazerDefaults(8.5);
  const map = new Beatmap(
    [spinner],
    { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 8.5 },
    ["DOUBLE_TIME"],
    new ControlPointInfo(),
  );
  return { map, spinner, frames: rawFrames as ReplayFrame[] };
}

describe("Stable spinner velocity reconstruction", () => {
  function testMap(duration = 300) {
    const spinner = new Spinner();
    spinner.id = "sampled";
    spinner.startTime = 1000;
    spinner.duration = duration;
    spinner.applyLazerDefaults(5);
    return new Beatmap([spinner], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
  }

  it("starts with the first observed cursor sample instead of interpolating an extra spin input", () => {
    const map = testMap();
    const frames: ReplayFrame[] = Array.from({ length: 14 }, (_, index) => {
      const time = 999 + index * 25;
      const angle = (time - 1000) * 0.02 + Math.PI / 2;
      return {
        time,
        position: { x: 256 + 100 * Math.cos(angle), y: 192 + 100 * Math.sin(angle) },
        actions: [OsuAction.leftButton],
      };
    });
    const machine = new BucketedGameStateTimeMachine(frames, map, stableOptions);
    expect(machine.gameStateAt(1024).spinnerState.get("sampled")?.totalSpunAngle).toBe(0);
    const state = machine.gameStateAt(Infinity);
    expect(state.spinnerVerdict.sampled.type).toBe("OK");
    expect(state.spinnerState.get("sampled")?.stableScoredHalfTurns).toBe(1);
  });

  it("measures the initial input interval from the preceding replay frame, before the spinner start", () => {
    const frames: ReplayFrame[] = [900, 1020].map((time) => ({
      time,
      position: { x: 256, y: 292 },
      actions: [OsuAction.leftButton],
    }));
    const state = new BucketedGameStateTimeMachine(frames, testMap(), stableOptions).gameStateAt(1020);
    const decay = Math.pow(0.999, 120);
    expect(state.spinnerState.get("sampled")?.stableAverageSampleDuration).toBeCloseTo(
      decay * (1000 / 60) + (1 - decay) * 120,
      10,
    );
  });

  it("processes an exact-start legacy input once, preserving its first stationary-sample deceleration", () => {
    const frames: ReplayFrame[] = [984, 1000, 1016].map((time) => ({
      time,
      position: { x: 256, y: 292 },
      actions: [OsuAction.leftButton],
    }));
    const state = new BucketedGameStateTimeMachine(frames, testMap(1000), {
      ...stableOptions,
      replayGameVersion: 20190101,
    }).gameStateAt(1016);
    // Source-shaped x86 oracle, accelerating on each integer map millisecond.
    expect(state.spinnerState.get("sampled")?.totalSpunAngle).toBeCloseTo(16.10103, 4);
    expect(state.spinnerState.get("sampled")?.stableZeroDeltaSamples).toBe(1);
  });

  it("selects the legacy rules from either source version or recording date", () => {
    expect(usesLegacyStableSpinnerRules(20190509, Date.UTC(2020, 0, 1))).toBe(true);
    expect(usesLegacyStableSpinnerRules(20260711, Date.UTC(2019, 4, 9))).toBe(true);
    expect(usesLegacyStableSpinnerRules(20190510, Date.UTC(2019, 4, 10))).toBe(false);
    expect(usesLegacyStableSpinnerRules()).toBe(false);
  });

  it.each([
    [0, "MISS"],
    [1, "MEH"],
    [2, "MEH"],
    [3, "OK"],
    [4, "OK"],
    [5, "GREAT"],
  ] as const)("grades %i scored half turns against a four-half-turn requirement", (completed, verdict) => {
    const state = {
      ...initialSpinnerState({ x: 356, y: 192 }),
      stableRequiredHalfTurns: 4,
      stableScoredHalfTurns: completed,
    };
    expect(stableSpinnerVerdict(state)).toBe(verdict);
  });

  it("keeps an odd half-turn requirement rather than rounding down to full spins", () => {
    const spinner = new Spinner();
    spinner.duration = 1000;
    expect(stableRequiredSpinnerHalfTurns(spinner, 5)).toBe(5);
    expect(
      stableSpinnerVerdict({
        ...initialSpinnerState({ x: 356, y: 192 }),
        stableRequiredHalfTurns: 5,
        stableScoredHalfTurns: 5,
      }),
    ).toBe("OK");
  });

  it.each([
    [1400, 7],
    [1800, 9],
    [2600, 13],
  ])("matches Stable's x86 duration conversion for a %ims spinner (%i required half turns)", (duration, required) => {
    const spinner = new Spinner();
    spinner.duration = duration;
    expect(stableRequiredSpinnerHalfTurns(spinner, 5)).toBe(required);
  });

  it.each([
    [3, "MISS"],
    [4, "MEH"],
    [5, "OK"],
    [6, "GREAT"],
  ] as const)("uses the legacy spinner thresholds for %i scored half turns", (completed, verdict) => {
    expect(
      stableSpinnerVerdict({
        ...initialSpinnerState({ x: 356, y: 192 }),
        stableRequiredHalfTurns: 4,
        stableScoredHalfTurns: completed,
        stableUsesLegacyRules: true,
      }),
    ).toBe(verdict);
  });

  it("rejects a cursor transition of exactly half a turn without adding rotation", () => {
    const { spinner } = reproduction();
    const initial = updateStableSpinnerRotation(
      initialSpinnerState({ x: 356, y: 192 }),
      spinner,
      { x: 356, y: 192 },
      true,
      1.5,
      8.5,
      spinner.startTime,
    );
    const next = updateStableSpinnerRotation(
      initial,
      spinner,
      { x: 156, y: 192 },
      true,
      1.5,
      8.5,
      spinner.startTime + 25,
    );
    expect(next.totalSpunAngle).toBe(0);
    expect(next.stableAngularVelocity).toBe(0);
  });

  it("does not integrate velocity twice for two input samples at the same timestamp", () => {
    const { spinner } = reproduction();
    const initial = updateStableSpinnerRotation(
      initialSpinnerState({ x: 356, y: 192 }),
      spinner,
      { x: 356, y: 192 },
      true,
      1.5,
      8.5,
      spinner.startTime,
    );
    const next = updateStableSpinnerRotation(
      initial,
      spinner,
      { x: 256, y: 292 },
      true,
      1.5,
      8.5,
      spinner.startTime + 25,
    );
    const duplicate = updateStableSpinnerRotation(
      next,
      spinner,
      { x: 156, y: 192 },
      true,
      1.5,
      8.5,
      spinner.startTime + 25,
    );
    expect(duplicate.totalSpunAngle).toBe(next.totalSpunAngle);
  });

  it("starts Stable bonuses on the source half-turn boundary even when the requirement is odd", () => {
    const { spinner } = reproduction();
    const state = { ...initialSpinnerState({ x: 356, y: 192 }), stableRequiredHalfTurns: 5, stableScoredHalfTurns: 9 };
    expect(spinnerBonusProgress(spinner, state, "stable").score).toBe(0);
    expect(spinnerBonusProgress(spinner, { ...state, stableScoredHalfTurns: 10 }, "stable").score).toBe(1000);
    expect(spinnerBonusProgress(spinner, { ...state, stableScoredHalfTurns: 12 }, "stable").score).toBe(2000);
  });

  it("times the bonus pulse at its half-turn boundary and keeps it through an intervening half turn", () => {
    const { spinner } = reproduction();
    const position = { x: 356, y: 192 };
    const previous = {
      ...initialSpinnerState(position),
      stableHalfTurns: 9,
      stableScoredHalfTurns: 8,
      stableLastHalfTurnBoundary: 8,
      lastSpinCompletionTime: 27_800,
    };
    const bonus = updateStableSpinnerRotation(previous, spinner, position, false, 1.5, 8.5, spinner.endTime);
    expect(spinnerBonusProgress(spinner, bonus, "stable").score).toBe(1000);
    expect(bonus.lastSpinCompletionTime).toBe(spinner.endTime);
    const next = updateStableSpinnerRotation(
      { ...bonus, stableHalfTurns: 10 },
      spinner,
      position,
      false,
      1.5,
      8.5,
      spinner.endTime + 25,
    );
    expect(next.lastSpinCompletionTime).toBe(bonus.lastSpinCompletionTime);
  });

  it("uses odd Stable requirements for displayed progress while preserving native Lazer progress", () => {
    const { spinner } = reproduction();
    const initial = initialSpinnerState({ x: 356, y: 192 });
    expect(
      spinnerProgressForState(spinner, { ...initial, stableHalfTurns: 4, stableRequiredHalfTurns: 5 }),
    ).toBeCloseTo(0.8);
    expect(spinnerProgressForState(spinner, { ...initial, totalSpunAngle: 360 })).toBeCloseTo(0.5);
  });

  it("reproduces the verified Crystalia short-spinner 100 from its cursor and input samples", () => {
    const { map, spinner, frames } = reproduction();
    const state = new BucketedGameStateTimeMachine(frames, map, stableOptions).gameStateAt(1e9);
    expect(state.spinnerVerdict[spinner.id]).toEqual({ type: "OK", judgementTime: 28_001 });
    expect(new GameplayInfoEvaluator(map).evaluateReplayState(state).verdictCounts).toEqual([0, 1, 0, 0]);
  });

  it("restores the same short-spinner judgement after reverse seeking and an independent fork", () => {
    const { map, spinner, frames } = reproduction();
    const machine = new BucketedGameStateTimeMachine(frames, map, stableOptions, 3);
    machine.gameStateAt(27_776);
    const fork = machine.fork();
    const final = { ...machine.gameStateAt(1e9).spinnerState.get(spinner.id) };
    expect(machine.gameStateAt(27_387).spinnerState.get(spinner.id)).toBeUndefined();
    expect(machine.gameStateAt(1e9).spinnerState.get(spinner.id)).toEqual(final);
    expect(fork.gameStateAt(1e9).spinnerVerdict[spinner.id].type).toBe("OK");
  });
});
