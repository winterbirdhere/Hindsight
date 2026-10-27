import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "./replay-display-settings";
import { readoutAt } from "./readout-source";

it("returns nothing without a replay so a cleared analyzer never shows the previous map", () => {
  const deps = {
    scenarioManager: { getBeatmapMetadata: () => ({ artist: "old", title: "Old map" }) },
    gameSimulator: {
      getPrimaryReplay: () => undefined,
      getRulesetFocus: () => "stable" as const,
      getCurrentInfo: () => undefined,
      getCurrentScoreStats: jest.fn(),
      getCurrentTimingStats: jest.fn(),
    },
    performanceTimeline: { at: jest.fn() },
    gameClock: { timeElapsedInMs: 0 },
  };
  expect(readoutAt(deps as never, DEFAULT_REPLAY_DISPLAY_SETTINGS)).toBeUndefined();
  expect(deps.performanceTimeline.at).not.toHaveBeenCalled();
});

it("reads the current replay, ruleset and time", () => {
  const at = jest.fn(() => ({ point: { time: 0, pp: 10, sr: 2 }, description: "Stable" }));
  const model = readoutAt(
    {
      scenarioManager: { getBeatmapMetadata: () => ({ artist: "xi", title: "ANiMA" }) },
      gameSimulator: {
        getPrimaryReplay: () => ({ player: "WinterBird", mods: ["HIDDEN"], lazerMods: [] }),
        getRulesetFocus: () => "lazer",
        getCurrentInfo: () => ({ verdictCounts: [1, 0, 0, 0] }),
        getCurrentScoreStats: () => ({ count100: 0, count50: 0, countMiss: 0, maxComboSoFar: 1, mapMaxCombo: 2 }),
        getCurrentTimingStats: () => ({ ur: "90.0", bias: "+1.0 ms" }),
      },
      performanceTimeline: { at },
      gameClock: { timeElapsedInMs: 1234 },
    } as never,
    DEFAULT_REPLAY_DISPLAY_SETTINGS,
  );
  expect(at).toHaveBeenCalledWith("lazer", 1234);
  expect(model?.identity).toMatchObject({ title: "ANiMA", player: "WinterBird", mods: "HD", ruleset: "Lazer" });
});
