import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
import { traceBeatmap, traceFixtures, traceFrame, traceMapText, normalizeTraceState } from "./ReplayTraceFixtures";

for (const profile of ["stable", "lazer"] as const) {
  const setup = (fixture = traceFixtures[0]) => {
    const map = traceBeatmap(fixture.objects);
    const machine = profile === "stable"
      ? new BucketedGameStateTimeMachine(fixture.frames, map, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" })
      : new LazerGameStateTimeMachine(fixture.frames, map);
    return { map, machine };
  };
  it.each(traceFixtures)(`${profile} numerical traversal preserves full state and ordered events without a collector: $name`, async fixture => {
    const sync = setup(fixture), async = setup(fixture), expected = sync.machine.gameStateAt(Infinity);
    const actual = await async.machine.evaluateReplayAsync(async () => undefined);
    expect(normalizeTraceState(actual)).toEqual(normalizeTraceState(expected));
    expect(retrieveEvents(actual, async.map.hitObjects, profile)).toEqual(retrieveEvents(expected, sync.map.hitObjects, profile));
    expect(async.machine.gameStateAt(Infinity)).toBe(actual);
  });

  it(`${profile} parks between bounded groups and rejects overlapping numerical traversals`, async () => {
    const fixture = { ...traceFixtures[0], frames: Array.from({ length: 1200 }, (_, index) => traceFrame(index * 2)) };
    const { machine } = setup(fixture), expected = setup(fixture).machine.gameStateAt(Infinity);
    let release!: () => void, reached!: () => void, calls = 0, settled = false;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const parked = new Promise<void>(resolve => { reached = resolve; });
    const work = machine.evaluateReplayAsync(async () => { if (++calls === 2) { reached(); await hold; } });
    void work.then(() => { settled = true; });
    await parked; await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false); expect(calls).toBe(2);
    await expect(machine.evaluateReplayAsync(async () => undefined)).rejects.toThrow(/fresh/);
    release(); expect(normalizeTraceState(await work)).toEqual(normalizeTraceState(expected));
    expect(calls).toBe(6);
    await expect(machine.evaluateReplayAsync(async () => undefined)).rejects.toThrow(/fresh/);
  });

  it(`${profile} consumes traversal admission on initial cancellation and empty input`, async () => {
    const { machine } = setup();
    await expect(machine.evaluateReplayAsync(async () => { throw Error("cancelled before frames"); })).rejects.toThrow("cancelled before frames");
    await expect(machine.evaluateReplayAsync(async () => undefined)).rejects.toThrow(/fresh/);
    const emptyFixture = { ...traceFixtures[0], frames: [] };
    const empty = setup(emptyFixture).machine, expected = setup(emptyFixture).machine.gameStateAt(Infinity);
    expect(normalizeTraceState(await empty.evaluateReplayAsync(async () => undefined))).toEqual(normalizeTraceState(expected));
    await expect(empty.evaluateReplayAsync(async () => undefined)).rejects.toThrow(/fresh/);
  });

  it(`${profile} leaves an interrupted numerical traversal unusable for accidental restart`, async () => {
    const { machine } = setup({ ...traceFixtures[0], frames: Array.from({ length: 1200 }, (_, index) => traceFrame(index * 2)) });
    let calls = 0;
    await expect(machine.evaluateReplayAsync(async () => { if (++calls === 3) throw Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(calls).toBe(3); await expect(machine.evaluateReplayAsync(async () => undefined)).rejects.toThrow(/fresh/);
  });
}

it("preserves sparse legacy Relax catch-up and never judges beyond the recorded end", async () => {
  const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0\n300,192,2000,1,0")), { mods: ["RELAX"], addStacking: false });
  const frames = [traceFrame(0), traceFrame(1300)];
  const make = () => new LazerGameStateTimeMachine(frames, map, undefined, { legacyReplay: true });
  const expected = make().gameStateAt(Infinity), actual = await make().evaluateReplayAsync(async () => undefined);
  expect(normalizeTraceState(actual)).toEqual(normalizeTraceState(expected));
  expect(retrieveEvents(actual, map.hitObjects, "lazer")).toEqual(retrieveEvents(expected, map.hitObjects, "lazer"));
  expect(actual.hitCircleVerdict[map.hitObjects[0].id].type).toBe("GREAT");
  expect(actual.hitCircleVerdict[map.hitObjects[1].id]).toBeUndefined(); expect(actual.currentTime).toBe(1300);
});

it.each([true, false])("preserves Classic slider-head scoring with head accuracy %s", async accuracy => {
  const map = buildBeatmap(parseBlueprint(traceMapText("100,192,1000,2,0,L|300:192,1,200")), {
    mods: [], lazerMods: [{ acronym: "CL", settings: { no_slider_head_accuracy: !accuracy, classic_note_lock: true } }], addStacking: false,
  });
  const frames = [traceFrame(900, 100), traceFrame(1080, 116, [0]), traceFrame(1500, 200, [0]), traceFrame(1970, 294, [0]), traceFrame(2100, 300, [0])];
  const make = () => new LazerGameStateTimeMachine(frames, map);
  const expected = make().gameStateAt(Infinity), actual = await make().evaluateReplayAsync(async () => undefined);
  expect(normalizeTraceState(actual)).toEqual(normalizeTraceState(expected));
  expect(retrieveEvents(actual, map.hitObjects, "lazer")).toEqual(retrieveEvents(expected, map.hitObjects, "lazer"));
});
