import { Spinner } from "../src/hitobjects/Spinner";
import { spunOutSpinnerState } from "../src/gameplay/SpunOutSpinner";
import { spinnerBonusProgress } from "../src/gameplay/SpinnerBonus";
import { spinnerProgress, spinnerVerdictForProgress } from "../src/gameplay/SpinnerTracking";

function spinner(spinsRequired = 5, duration = 2000): Spinner {
  const target = new Spinner();
  target.startTime = 1000;
  target.duration = duration;
  target.spinsRequired = spinsRequired;
  target.maximumBonusSpins = 3;
  return target;
}

describe("native lazer Spun Out", () => {
  it("starts rotation only inside the spinner's active time", () => {
    const target = spinner();
    const before = spunOutSpinnerState(target, 999);
    expect(before.totalSpunAngle).toBe(0);
    expect(before.completedSpins).toBe(0);
    expect(before.tracking).toBe(false);
    expect(before.completionTime).toBeUndefined();
    expect(before.lastSpinCompletionTime).toBeUndefined();
    expect(spunOutSpinnerState(target, 1000).tracking).toBe(true);
  });

  it("automatically rotates to 101% of the clear requirement over the map duration", () => {
    const target = spinner();
    const half = spunOutSpinnerState(target, 2000);
    expect(half.totalSpunAngle).toBeCloseTo(909);
    expect(half.completedSpins).toBe(2);
    expect(half.currentSpinMaxRotation).toBeCloseTo(189);
    expect(half.completionTime).toBeUndefined();
    const end = spunOutSpinnerState(target, target.endTime);
    expect(end.totalSpunAngle).toBeCloseTo(1818);
    expect(end.completedSpins).toBe(5);
    expect(end.tracking).toBe(false);
    expect(spinnerVerdictForProgress(spinnerProgress(end.totalSpunAngle, target.spinsRequired))).toBe("GREAT");
    expect(spinnerBonusProgress(target, end, "lazer").score).toBe(0);
  });

  it("records exact map timestamps for the clear and most recent completed spin", () => {
    const target = spinner();
    const midway = spunOutSpinnerState(target, 2400);
    expect(midway.completedSpins).toBe(3);
    expect(midway.lastSpinCompletionTime).toBeCloseTo(2188.118811881188);
    expect(midway.completionTime).toBeUndefined();
    const cleared = spunOutSpinnerState(target, 2990);
    expect(cleared.completionTime).toBeCloseTo(2980.19801980198);
    expect(cleared.lastSpinCompletionTime).toBeCloseTo(2980.19801980198);
  });

  it("freezes state after the end and restores the same state after seeking", () => {
    const target = spinner();
    const beforeSeek = spunOutSpinnerState(target, 2200);
    const end = spunOutSpinnerState(target, target.endTime);
    expect(spunOutSpinnerState(target, 50000)).toEqual(end);
    expect(spunOutSpinnerState(target, 1100).completedSpins).toBe(0);
    expect(spunOutSpinnerState(target, 2200)).toEqual(beforeSeek);
  });

  it("clears a zero-required spinner without inventing rotation or bonus sounds", () => {
    const target = spinner(0, 100);
    expect(spunOutSpinnerState(target, 999).completionTime).toBeUndefined();
    const active = spunOutSpinnerState(target, 1050);
    expect(active.completionTime).toBe(1000);
    expect(active.totalSpunAngle).toBe(0);
    expect(active.lastSpinCompletionTime).toBeUndefined();
    expect(spinnerBonusProgress(target, active, "lazer").soundTriggers).toBe(0);
  });

  it("handles a zero-duration spinner without non-finite rotation state", () => {
    const target = spinner(0, 0);
    const state = spunOutSpinnerState(target, 1000);
    expect(state.totalSpunAngle).toBe(0);
    expect(state.tracking).toBe(false);
    expect(state.completionTime).toBe(1000);
  });

  it("keeps lazer's existing bonus cap if the 1% safety margin reaches extra spins", () => {
    const target = spinner(1000, 600000);
    const end = spunOutSpinnerState(target, target.endTime);
    expect(end.completedSpins).toBe(1010);
    expect(spinnerBonusProgress(target, end, "lazer")).toMatchObject({
      earnedCount: 3,
      soundTriggers: 8,
      score: 150,
    });
  });
});
