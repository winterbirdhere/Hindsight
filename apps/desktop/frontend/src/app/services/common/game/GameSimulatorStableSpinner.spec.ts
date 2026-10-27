import { readFileSync } from "fs";
import { resolve } from "path";
import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, defaultGameState, Spinner } from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixture() {
  const spinner = new Spinner();
  spinner.id = "82";
  spinner.startTime = 27_388;
  spinner.duration = 611;
  spinner.applyLazerDefaults(8.5);
  const beatmap = new Beatmap(
    [spinner],
    { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 8.5 },
    ["DOUBLE_TIME"],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
  );
  const replay: OsuReplay = {
    md5hash: "short-spinner",
    beatmapMd5: "same-map",
    gameMode: 0,
    gameVersion: 20260711,
    mods: ["DOUBLE_TIME"],
    player: "Player",
    frames: JSON.parse(readFileSync(resolve("libs/osu/core/test/fixtures/crystalia-short-spinner.json"), "utf8")),
  };
  return { spinner, beatmap, replay };
}

describe("Stable spinner presentation and replay compatibility", () => {
  it("uses each replay's legacy spinner rules in primary, audio and comparison simulation", () => {
    const { beatmap, replay } = fixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    expect(simulator.getFinalInfoForRuleset("stable")?.verdictCounts).toEqual([0, 1, 0, 0]);
    const legacyReplay = { ...replay, md5hash: "old-spinner", gameVersion: 20190509 };
    simulator.simulateReplay(beatmap, legacyReplay);
    expect(simulator.getFinalInfoForRuleset("stable")?.verdictCounts).toEqual([0, 0, 0, 1]);
    expect(simulator.getStateAt(1e9)?.spinnerVerdict["82"].type).toBe("MISS");
    simulator.simulateReplay(beatmap, replay);
    const comparison = simulator.compareReplay(beatmap, legacyReplay);
    expect(comparison.status).toBe("READY");
    if (comparison.status === "READY") expect(comparison.validations.secondary?.simulatedCounts).toEqual([0, 0, 0, 1]);
  });

  it("honours a pre-change replay timestamp even with a newer game version", () => {
    const { beatmap, replay } = fixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, { ...replay, timestamp: Date.UTC(2019, 4, 9) });
    expect(simulator.getFinalInfoForRuleset("stable")?.verdictCounts).toEqual([0, 0, 0, 1]);
  });

  it("shows half-turn progress and interpolates Stable velocity without changing scoring", () => {
    const { beatmap, replay } = fixture();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    const spinner = new Spinner();
    spinner.id = "visual";
    spinner.startTime = 1000;
    spinner.duration = 1000;
    spinner.spinsRequired = 2;
    const state = defaultGameState();
    state.currentTime = 1100;
    state.spinnerState.set(spinner.id, {
      totalSpunAngle: 360,
      totalAccumulatedRotation: 90,
      currentAngle: 0,
      tracking: true,
      stableHalfTurns: 2,
      stableRequiredHalfTurns: 5,
      stableAngularVelocity: 0.01,
      stableTargetVelocity: 0.01,
    });
    Object.assign(simulator, { currentState: state, currentPlaybackTime: 1150 });
    const visual = simulator.getCurrentSpinnerVisualState(spinner);
    expect(visual.rotationDegrees).toBeCloseTo(60 + (0.5 / 1.5) * (180 / Math.PI));
    expect(visual.progress).toBeCloseTo(0.4);
    expect(state.spinnerState.get(spinner.id)?.totalSpunAngle).toBe(360);
  });
});
