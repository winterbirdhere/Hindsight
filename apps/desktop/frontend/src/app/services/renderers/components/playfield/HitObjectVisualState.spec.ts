import type { HitCircleVerdict } from "@osujs/core";
import {
  CLASSIC_NOTELOCK_SHAKE_DISTANCE,
  CLASSIC_NOTELOCK_SHAKE_LEG_DURATION,
  CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION,
  classicNotelockShakeOffset,
  directEarlyMissResolved,
} from "./HitObjectVisualState";

describe("classic notelock visuals", () => {
  it("produces the bounded, seekable classic sequence with 30 ms legs", () => {
    const shakeTime = 1_000;

    expect(classicNotelockShakeOffset(shakeTime - 0.001, shakeTime)).toBe(0);
    expect(classicNotelockShakeOffset(shakeTime, shakeTime)).toBe(0);
    expect(classicNotelockShakeOffset(shakeTime + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2, shakeTime)).toBeCloseTo(
      CLASSIC_NOTELOCK_SHAKE_DISTANCE,
    );
    expect(classicNotelockShakeOffset(shakeTime + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 1.5, shakeTime)).toBeCloseTo(
      -CLASSIC_NOTELOCK_SHAKE_DISTANCE,
    );
    expect(classicNotelockShakeOffset(shakeTime + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 2.5, shakeTime)).toBeCloseTo(
      CLASSIC_NOTELOCK_SHAKE_DISTANCE,
    );
    expect(classicNotelockShakeOffset(shakeTime + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION * 3.5, shakeTime)).toBeCloseTo(
      -CLASSIC_NOTELOCK_SHAKE_DISTANCE,
    );
    expect(classicNotelockShakeOffset(shakeTime + CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION, shakeTime)).toBe(0);
    expect(classicNotelockShakeOffset(shakeTime + 100)).toBe(0);
  });

  it.each(["HIT_TOO_EARLY", "INPUT_WINDOW_MISS"] as const)(
    "removes a resolved early direct MISS reported as %s",
    (missReason) => {
      const verdict: HitCircleVerdict = { type: "MISS", missReason, judgementTime: 900 };

      expect(directEarlyMissResolved(899, 1_000, verdict)).toBe(false);
      expect(directEarlyMissResolved(900, 1_000, verdict)).toBe(true);
    },
  );

  it("does not remove timeout, unresolved, or non-early misses", () => {
    expect(
      directEarlyMissResolved(1_200, 1_000, {
        type: "MISS",
        missReason: "TIME_EXPIRED",
        judgementTime: 1_150,
      }),
    ).toBe(false);
    expect(
      directEarlyMissResolved(1_200, 1_000, {
        type: "MISS",
        missReason: "HIT_TOO_EARLY",
        judgementTime: 1_050,
      }),
    ).toBe(false);
    expect(directEarlyMissResolved(1_200, 1_000)).toBe(false);
  });
});
