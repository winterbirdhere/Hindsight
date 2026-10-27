import { Spinner } from "../src/hitobjects/Spinner";
import { spinnerBonusProgress } from "../src/gameplay/SpinnerBonus";
import { initialSpinnerState, updateSpinnerRotation } from "../src/gameplay/SpinnerTracking";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const bottom = { x: 256, y: 292 };
const positions = [bottom, { x: 156, y: 192 }, { x: 256, y: 92 }, { x: 356, y: 192 }];

function spinner() {
  const result = new Spinner();
  result.id = "spinner";
  result.startTime = 1_000;
  result.duration = 5_000;
  result.spinsRequired = 1;
  result.maximumBonusSpins = 2;
  return result;
}

describe("spinner bonus presentation", () => {
  it("does not award a bonus for clearing or for the two following full spins", () => {
    const target = spinner();
    for (const completedSpins of [0, 1, 2, 3]) {
      const state = { ...initialSpinnerState(bottom), completedSpins, totalSpunAngle: completedSpins * 360 + 359 };
      expect(spinnerBonusProgress(target, state, "stable").score).toBe(0);
      expect(spinnerBonusProgress(target, state, "lazer").score).toBe(0);
    }
  });

  it("shows Stable's 1000-point bonus without capping it at lazer's maximum", () => {
    const state = { ...initialSpinnerState(bottom), completedSpins: 7 };
    expect(spinnerBonusProgress(spinner(), state, "stable")).toMatchObject({
      earnedCount: 4,
      soundTriggers: 4,
      score: 4000,
    });
  });

  it("caps lazer's 50-point bonuses while retaining sounds for further full spins", () => {
    const state = { ...initialSpinnerState(bottom), completedSpins: 7 };
    expect(spinnerBonusProgress(spinner(), state, "lazer")).toEqual({
      earnedCount: 2,
      soundTriggers: 4,
      score: 100,
      maximumScore: 100,
    });
  });

  it("has no bonus before a spinner state exists", () => {
    expect(spinnerBonusProgress(spinner(), undefined, "stable").score).toBe(0);
  });

  it("records full-spin timestamps only when a tracked rotation actually completes", () => {
    let state = initialSpinnerState(bottom);
    for (let i = 0; i <= 4; i++) {
      state = updateSpinnerRotation(state, positions[i % 4], true, 1, 1, 1000 + i * 100);
    }
    expect(state.completedSpins).toBe(1);
    expect(state.lastSpinCompletionTime).toBe(1400);
    state = updateSpinnerRotation(state, positions[1], false, 1, 1, 1500);
    expect(state.lastSpinCompletionTime).toBe(1400);
  });

  it.each(["stable", "lazer"] as const)(
    "restores %s bonus score and animation timestamp when seeking backwards",
    (ruleset) => {
      const target = spinner();
      target.duration = 3000;
      const map = new Beatmap(
        [target],
        { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 0 },
        [],
        new ControlPointInfo(),
      );
      const frames: ReplayFrame[] = Array.from({ length: 49 }, (_, i) => ({
        time: 1000 + i * 50,
        position: positions[i % 4],
        actions: [OsuAction.leftButton],
      }));
      const machine =
        ruleset === "stable"
          ? new BucketedGameStateTimeMachine(frames, map, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" })
          : new LazerGameStateTimeMachine(frames, map);
      const bonusAt = (time: number) => {
        const state = machine.gameStateAt(time).spinnerState.get(target.id);
        return {
          ...spinnerBonusProgress(target, state, ruleset),
          lastSpinCompletionTime: state?.lastSpinCompletionTime,
        };
      };
      const expected = bonusAt(3000);
      expect(expected.score).toBeGreaterThan(0);
      bonusAt(3300);
      expect(bonusAt(1200).score).toBe(0);
      expect(bonusAt(3000)).toEqual(expected);
      expect(bonusAt(999).score).toBe(0);
    },
  );
});
