import { Beatmap } from "../beatmap/Beatmap";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "./LazerGameStateTimeMachine";
import { ReplayFrame } from "../replays/Replay";

describe("independent audio traversal cursors", () => {
  const frames: ReplayFrame[] = [0, 10, 20, 30, 40, 50].map((time) => ({
    time,
    position: { x: time, y: time },
    actions: [],
  }));

  it.each(["stable", "lazer"] as const)("forks %s without changing the source cursor or cached states", (ruleset) => {
    const machine =
      ruleset === "stable"
        ? new BucketedGameStateTimeMachine(
            frames,
            Beatmap.EMPTY_BEATMAP,
            { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" },
            2,
          )
        : new LazerGameStateTimeMachine(frames, Beatmap.EMPTY_BEATMAP, 2);
    machine.gameStateAt(50);
    const visibleState = machine.gameStateAt(10);
    const audio = machine.fork();
    expect(audio.gameStateAt(30).currentTime).toBe(30);
    expect(visibleState.currentTime).toBe(10);
    expect(visibleState.cursorPosition).toEqual({ x: 10, y: 10 });

    const audioState = audio.gameStateAt(40);
    machine.gameStateAt(20);
    expect(audioState.currentTime).toBe(40);
    expect(audioState.cursorPosition).toEqual({ x: 40, y: 40 });

    // Both can traverse the shared cached bucket in opposite directions.
    audio.gameStateAt(0);
    expect(machine.gameStateAt(40).cursorPosition).toEqual({ x: 40, y: 40 });
    expect(audio.gameStateAt(20).cursorPosition).toEqual({ x: 20, y: 20 });
  });
});
