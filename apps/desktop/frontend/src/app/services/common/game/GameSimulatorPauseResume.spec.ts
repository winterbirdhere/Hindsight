import { readFileSync } from "fs";
import { resolve } from "path";
import { buildBeatmap, modsFromBitmask, parseBlueprint, parseReplayFramesFromRaw } from "@osujs/core";
import { OsuReplay, parseReplayLifeBar } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/cloud9-pause-resume.json"), "utf8"));

function loadReplay(index: number) {
  const { header, replayData } = fixture.replays[index];
  const mods = modsFromBitmask(header.mods);
  const beatmap = buildBeatmap(parseBlueprint(fixture.beatmap.text), { addStacking: true, mods });
  const replay: OsuReplay = {
    md5hash: header.replayMD5,
    beatmapMd5: header.beatmapMD5,
    gameMode: header.gameMode,
    gameVersion: header.gameVersion,
    timestamp: header.timestamp,
    player: header.playerName,
    mods,
    frames: parseReplayFramesFromRaw(replayData),
    lifeBar: parseReplayLifeBar(header.life_bar),
    statistics: {
      count300: header.number_300s,
      count100: header.number_100s,
      count50: header.number_50s,
      countMiss: header.misses,
      maxCombo: header.max_combo,
      score: header.score,
      perfectCombo: header.perfect_combo,
    },
  };
  return { beatmap, replay };
}

describe("Saved resume presses and original score validation", () => {
  // This catches either suppressing a guessed resume input or replacing playback
  // totals with the score header. Native playback's miss was confirmed by the user.
  it("keeps the on-circle resume miss separate from the original SS score", () => {
    const { beatmap, replay } = loadReplay(2);
    const originalReplay = JSON.stringify(replay);
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    simulator.simulate(1e9);

    expect(simulator.getFinalInfoForRuleset("stable")).toMatchObject({
      verdictCounts: [4, 0, 0, 1],
      maxComboSoFar: 3,
    });
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([4, 0, 0, 1]);
    expect(simulator.getStateAt(1e9)?.hitCircleVerdict["3"]).toMatchObject({
      type: "MISS",
      judgementTime: 16684,
    });
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: false,
      judgementTotalsMatch: false,
      missCountMatch: false,
      maxComboMatch: false,
      expectedCounts: [5, 0, 0, 0],
      simulatedCounts: [4, 0, 0, 1],
      expectedMaxCombo: 5,
      simulatedMaxCombo: 3,
    });
    expect(simulator.getPrimaryReplay()?.statistics).toMatchObject({
      count300: 5,
      count100: 0,
      count50: 0,
      countMiss: 0,
      maxCombo: 5,
    });
    expect(JSON.stringify(replay)).toBe(originalReplay);
  });

  it("preserves the early miss when seeking backwards and reloading the replay", () => {
    const { beatmap, replay } = loadReplay(2);
    const simulator = new GameSimulator();
    for (let load = 0; load < 2; load++) {
      simulator.simulateReplay(beatmap, replay);
      simulator.simulate(1e9);
      simulator.simulate(16683);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([3, 0, 0, 0]);
      simulator.simulate(16684);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([3, 0, 0, 1]);
      // The normal tap arrives later; it cannot recover the already missed note.
      simulator.simulate(16970);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([3, 0, 0, 1]);
      simulator.simulate(1e9);
      expect(simulator.getCurrentInfo().verdictCounts).toEqual([4, 0, 0, 1]);
      expect(simulator.validation$.getValue().verified).toBe(false);
    }
  });

  it.each([
    [0, "without a pause"],
    [1, "with the resume press outside the circle"],
  ])("retains matching original and playback scores: %s (%s)", (index) => {
    const { beatmap, replay } = loadReplay(index as number);
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay);
    simulator.simulate(1e9);
    expect(simulator.getFinalInfoForRuleset("stable")).toMatchObject({
      verdictCounts: [5, 0, 0, 0],
      maxComboSoFar: 5,
    });
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([5, 0, 0, 0]);
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: true,
      expectedCounts: [5, 0, 0, 0],
      simulatedCounts: [5, 0, 0, 0],
      expectedMaxCombo: 5,
      simulatedMaxCombo: 5,
    });
  });
});
