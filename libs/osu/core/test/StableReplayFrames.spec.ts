import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { cloneGameState, NOT_PRESSING } from "../src/gameplay/GameState";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { calculateReplayButtonIntervals } from "../src/replays/ReplayClicks";
import { parseReplayFramesFromRaw } from "../src/replays/ReplayParser";

describe("recorded Stable frames at the same timestamp", () => {
  it("judges the press at its own position and preserves it through seeking and audio forks", () => {
    // Dramatic object 229: the first sample is outside CS5; the K2 press is inside.
    const frames = parseReplayFramesFromRaw(
      "49000|62.22222|291.5555|0,11|62.22222|291.5555|0,0|63.11111|292.8889|10,0|63.11111|292.8889|0,202|68|324|0",
    );
    const target = new HitCircle();
    Object.assign(target, {
      id: "229",
      hitTime: 49_013,
      approachDuration: 600,
      scale: 0.5,
      position: { x: 68, y: 324 },
      unstackedPosition: { x: 68, y: 324 },
    });
    const map = new Beatmap([target], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());
    const machine = new BucketedGameStateTimeMachine(
      frames,
      map,
      { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
      2,
    );
    const atPress = cloneGameState(machine.gameStateAt(49_011));
    expect(atPress.hitCircleVerdict[target.id]).toMatchObject({ type: "GREAT", judgementTime: 49_011 });
    expect(atPress.cursorPosition).toEqual({ x: 63.11111, y: 292.8889 });
    expect(atPress.pressingSince).toEqual([NOT_PRESSING, NOT_PRESSING]);
    expect(calculateReplayButtonIntervals(frames).K2).toEqual([[49_011, 49_011]]);

    const audio = machine.fork();
    machine.gameStateAt(49_213);
    machine.gameStateAt(49_000);
    audio.gameStateAt(49_000);
    expect(machine.gameStateAt(49_011)).toEqual(atPress);
    expect(audio.gameStateAt(49_011)).toEqual(atPress);
  });
});
