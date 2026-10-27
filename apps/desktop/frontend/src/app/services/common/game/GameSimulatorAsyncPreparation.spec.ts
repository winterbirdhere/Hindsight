import { Beatmap, BucketedGameStateTimeMachine, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, LazerGameStateTimeMachine, OsuAction, ReplayFrame } from "@osujs/core";
import { OsuReplay } from "../../../model/OsuReplay";
import { scoringReplayFramesAsync } from "./GameSimulator";

const counts = { count300: 1, count100: 0, count50: 0, countMiss: 0, maxCombo: 1, score: 300, perfectCombo: false };
const frame = (time: number, held = false): ReplayFrame => ({ time, position: { x: 256, y: 192 }, actions: held ? [OsuAction.leftButton] : [] });
const replay = (overrides: Partial<OsuReplay> = {}): OsuReplay => ({ md5hash: "async-source", beatmapMd5: "map", player: "synthetic", gameVersion: 20200101,
  mods: [], statistics: counts, frames: [frame(0), frame(1000, true), frame(1100)], ...overrides });
function map() {
  return new Beatmap([1000, 2000].map((hitTime, index) => {
    const circle = new HitCircle(); circle.id = `async-${index}`; circle.hitTime = hitTime; circle.approachDuration = 600; circle.position = { x: 256, y: 192 }; return circle;
  }), DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
}
afterEach(() => jest.restoreAllMocks());

it.each([20200101, 30000016])("reuses completed source state only for an unchanged source endpoint: %s", async gameVersion => {
  const beatmap = map(), source = replay({ gameVersion });
  const syncStable = jest.spyOn(BucketedGameStateTimeMachine.prototype, "gameStateAt"), syncNative = jest.spyOn(LazerGameStateTimeMachine.prototype, "gameStateAt");
  const result = await scoringReplayFramesAsync(beatmap, source, async () => undefined);
  expect(syncStable).not.toHaveBeenCalled(); expect(syncNative).not.toHaveBeenCalled();
  expect(result.frames).toBe(source.frames); expect(result.reusableSourceState?.profile).toBe(gameVersion < 30000000 ? "stable" : "lazer");
  const expected = gameVersion < 30000000
    ? new BucketedGameStateTimeMachine(source.frames, beatmap, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE", replayGameVersion: source.gameVersion, replayTimestamp: source.timestamp }).gameStateAt(Infinity)
    : new LazerGameStateTimeMachine(source.frames, beatmap).gameStateAt(Infinity);
  expect(result.reusableSourceState?.state).toEqual(expected);
  const truncated = await scoringReplayFramesAsync(beatmap, replay({ gameVersion, frames: [frame(0), frame(1000, true), frame(1001), frame(2000, true), frame(2100)] }), async () => undefined);
  expect(truncated.endTime).toBe(1000); expect(truncated.domain.synthesizedEndpoint).toBe(false);
  expect(truncated.reusableSourceState).toBeUndefined();
});

it.each<Partial<OsuReplay>>([{ lifeBar: [{ time: 1000, health: 0 }] }, { mods: ["NO_FAIL"] }, { statistics: undefined }])(
  "does no inference traversal when health, NF or missing counts resolve preparation %j", async overrides => {
    const stable = jest.spyOn(BucketedGameStateTimeMachine.prototype, "evaluateReplayAsync");
    const native = jest.spyOn(LazerGameStateTimeMachine.prototype, "evaluateReplayAsync");
    const result = await scoringReplayFramesAsync(map(), replay(overrides), async () => undefined);
    expect(stable).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(result.reusableSourceState).toBeUndefined();
  },
);

it("propagates checkpoint rejection from inside fallback inference and does not return recorded-end", async () => {
  const failure = new Error("cancel numerical inference"); let calls = 0;
  const source = replay({ frames: Array.from({ length: 1200 }, (_, index) => frame(index * 2)) });
  await expect(scoringReplayFramesAsync(map(), source, async () => { if (++calls === 3) throw failure; })).rejects.toBe(failure);
  expect(calls).toBe(3);
});
