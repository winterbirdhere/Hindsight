import { readFileSync } from "fs";
import { join } from "path";
import { Spinner } from "../src/hitobjects/Spinner";
import { initialSpinnerState } from "../src/gameplay/SpinnerTracking";
import {
  advanceStableSpinnerBody,
  stableSpinnerVerdict,
  updateStableSpinnerInput,
  updateStableSpinnerRotation,
} from "../src/gameplay/StableSpinnerTracking";

describe("Stable spinner input and body clocks", () => {
  const spinner = new Spinner();
  spinner.startTime = 70095;
  spinner.duration = 1691;

  it("replays the native call sequence without importing intermediate states or the final grade", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/horie-spinner-native-calls.json"), "utf8"));
    let state = initialSpinnerState({ x: 256, y: 192 });
    expect(fixture.calls).toHaveLength(1835);
    for (const [
      kind,
      time,
      previousFresh,
      elapsed,
      x,
      y,
      held,
      angle,
      average,
      target,
      velocity,
      turns,
      zero,
      scored,
      boundary,
    ] of fixture.calls) {
      state =
        kind === "input"
          ? updateStableSpinnerInput(state, spinner, { x, y }, held, 1, 9, time, false, false, previousFresh)
          : advanceStableSpinnerBody(state, spinner, time, elapsed, 1);
      expect(state.stableHalfTurns ?? 0).toBe(turns);
      expect(state.stableZeroDeltaSamples ?? 0).toBe(zero);
      expect(state.stableScoredHalfTurns ?? 0).toBe(scored);
      expect(state.stableLastHalfTurnBoundary ?? 0).toBe(boundary);
      expect(state.stableTargetVelocity ?? 0).toBeCloseTo(target, 12);
      expect(state.stableAngularVelocity ?? 0).toBeCloseTo(velocity, 12);
      expect(state.stableAverageSampleDuration ?? 1000 / 60).toBeCloseTo(average, 12);
      if (angle !== null) expect(state.stableLastSampleAngle).toBeCloseTo(angle, 12);
    }
    expect(stableSpinnerVerdict(state)).toBe("OK");
  });

  it("does not retroactively apply a new target to the whole input gap", () => {
    const initial = updateStableSpinnerRotation(
      initialSpinnerState({ x: 356, y: 192 }),
      spinner,
      { x: 356, y: 192 },
      true,
      1,
      9,
      70100,
    );
    const after = updateStableSpinnerRotation(initial, spinner, { x: 256, y: 292 }, true, 1, 9, 70120);
    // Only the final 1 ms body step can use the newly sampled target. Starting
    // from rest, acceleration is 0.0017345 rad/ms² for this duration.
    expect(after.stableHalfTurns).toBe(Math.fround(Math.fround(0.0017345) / Math.PI));
    expect(initial.stableHalfTurns).toBe(0);
  });

  it("integrates between inputs without awarding a scored boundary until fresh input", () => {
    const before = {
      ...initialSpinnerState({ x: 356, y: 192 }),
      stableHalfTurns: 0.99,
      stableTargetVelocity: 0.05,
      stableAngularVelocity: 0.05,
    };
    const advanced = advanceStableSpinnerBody(before, spinner, 70200, 2, 1);
    expect(advanced.stableHalfTurns).toBeGreaterThan(1);
    expect(advanced.stableScoredHalfTurns).toBeUndefined();
    const sampled = updateStableSpinnerInput(advanced, spinner, { x: 356, y: 192 }, true, 1, 9, 70201);
    expect(sampled.stableScoredHalfTurns).toBe(1);
    expect(sampled.stableHalfTurns).toBe(advanced.stableHalfTurns);
  });
});
