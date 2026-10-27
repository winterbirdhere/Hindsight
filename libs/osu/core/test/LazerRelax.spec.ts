import { Beatmap, NOT_PRESSING, OsuAction, ReplayFrame, buildBeatmap, parseBlueprint } from "../src";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";

const header = `osu file format v14
[General]
Mode:0
[Difficulty]
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
`;
const at = (time: number, x = 100, y = 100, actions: OsuAction[] = []): ReplayFrame => ({
  time,
  position: { x, y },
  actions,
});
const map = (objects: string) =>
  buildBeatmap(parseBlueprint(header + objects), { mods: ["RELAX"], addStacking: false });
const machine = (frames: ReplayFrame[], beatmap: Beatmap, legacyReplay = true) =>
  new LazerGameStateTimeMachine(frames, beatmap, 1, { legacyReplay });

describe("lazer Relax replay input", () => {
  it("reconstructs legacy automatic presses at the inclusive 12ms boundary and alternates buttons", () => {
    const beatmap = map("100,100,1000,1,0\n100,100,1100,1,0\n");
    const playback = machine([at(0), at(987), at(988), at(1088), at(1300)], beatmap);
    const first = beatmap.hitObjects[0].id;
    const second = beatmap.hitObjects[1].id;
    expect(playback.gameStateAt(987).hitCircleVerdict[first]).toBeUndefined();
    expect(playback.gameStateAt(988).hitCircleVerdict[first]).toMatchObject({
      type: "GREAT",
      judgementTime: 988,
      hitAction: OsuAction.rightButton,
    });
    expect(playback.gameStateAt(1300).hitCircleVerdict[second]).toMatchObject({
      type: "GREAT",
      judgementTime: 1088,
      hitAction: OsuAction.leftButton,
    });
  });

  it("preserves modern Relax's recorded miss and late press instead of generating input", () => {
    const beatmap = map("100,100,1000,1,0\n");
    const id = beatmap.hitObjects[0].id;
    expect(machine([at(0), at(1300)], beatmap, false).gameStateAt(1300).hitCircleVerdict[id].type).toBe("MISS");
    const recorded = machine([at(0), at(1080, 100, 100, [OsuAction.leftButton]), at(1300)], beatmap, false);
    expect(recorded.gameStateAt(1300).hitCircleVerdict[id]).toMatchObject({
      type: "OK",
      judgementTime: 1080,
      hitAction: OsuAction.leftButton,
    });
  });

  it("holds each automatic tap for 50ms and releases only after that boundary", () => {
    const beatmap = map("100,100,1000,1,0\n");
    const playback = machine([at(0), at(988), at(1038), at(1038.01), at(1300)], beatmap);
    expect(playback.gameStateAt(1038).pressingSince[OsuAction.rightButton]).toBe(988);
    expect(playback.gameStateAt(1038.01).pressingSince).toEqual([NOT_PRESSING, NOT_PRESSING]);
    expect(playback.gameStateAt(1038).pressingSince[OsuAction.rightButton]).toBe(988);
  });

  it("does not auto-hit circles when recorded aim misses", () => {
    const beatmap = map("100,100,1000,1,0\n");
    const state = machine([at(0, 400, 300), at(1300, 400, 300)], beatmap).gameStateAt(1300);
    expect(state.hitCircleVerdict[beatmap.hitObjects[0].id].type).toBe("MISS");
  });

  it("does not generate a late tap after a short slider ends, while retaining recorded late taps", () => {
    const beatmap = map("100,100,1000,2,0,L|114:100,1,14\n");
    const slider = beatmap.getSlider(beatmap.hitObjects[0].id);
    expect(slider.endTime).toBeCloseTo(1050);
    const frames = [at(0, 400, 300), at(1060, 400, 300), at(1080), at(1300)];
    expect(machine(frames, beatmap).gameStateAt(1300).hitCircleVerdict[slider.head.id].type).toBe("MISS");

    const recorded = frames.map((frame) =>
      frame.time === 1080 ? { ...frame, actions: [OsuAction.leftButton] } : frame,
    );
    expect(machine(recorded, beatmap, false).gameStateAt(1300).hitCircleVerdict[slider.head.id]).toMatchObject({
      type: "OK",
      judgementTime: 1080,
    });
  });

  it("keeps native note lock when a legacy Relax pulse targets an early later object", () => {
    const beatmap = map("100,100,1000,1,0\n400,300,1005,1,0\n");
    const playback = machine([at(0, 400, 300), at(993, 400, 300), at(1005, 400, 300), at(1300, 400, 300)], beatmap);
    expect(playback.gameStateAt(993).hitCircleVerdict[beatmap.hitObjects[1].id]).toBeUndefined();
    const final = playback.gameStateAt(1300);
    expect(final.hitCircleVerdict[beatmap.hitObjects[0].id]).toMatchObject({
      type: "MISS",
      missReason: "ORDERED_POLICY_FORCE_MISS",
    });
    expect(final.hitCircleVerdict[beatmap.hitObjects[1].id].type).toBe("GREAT");
  });

  it("tracks a legacy Relax slider without physical keys and still loses off-path ticks", () => {
    const beatmap = map("100,100,1000,2,0,L|380:100,1,280\n");
    const slider = beatmap.getSlider(beatmap.hitObjects[0].id);
    const frames = [
      at(0),
      at(988),
      ...Array.from({ length: 11 }, (_, i) => at(1000 + i * 100, 100 + i * 28)),
      at(2300, 380),
    ];
    const good = machine(frames, beatmap).gameStateAt(2300);
    expect(good.sliderTailVerdict[slider.id].hit).toBe(true);
    expect(Object.values(good.checkPointVerdict).every((value) => value.hit)).toBe(true);
    const badFrames = frames.map((frame) =>
      frame.time >= 1400 && frame.time <= 1700 ? { ...frame, position: { x: 500, y: 350 } } : frame,
    );
    const bad = machine(badFrames, beatmap).gameStateAt(2300);
    expect(Object.values(bad.checkPointVerdict).some((value) => !value.hit)).toBe(true);
  });

  it("holds spinner input for legacy Relax but requires recorded spinning movement", () => {
    const beatmap = map("256,192,1000,8,0,2000\n");
    const id = beatmap.hitObjects[0].id;
    const still = machine([at(0, 336, 192), at(2200, 336, 192)], beatmap).gameStateAt(2200);
    expect(still.spinnerVerdict[id].type).toBe("MISS");
    const frames = [
      at(0, 336, 192),
      ...Array.from({ length: 21 }, (_, i) => {
        const angle = (i * Math.PI) / 2;
        return at(1000 + i * 50, 256 + Math.cos(angle) * 80, 192 + Math.sin(angle) * 80);
      }),
      at(2200, 336, 192),
    ];
    expect(machine(frames, beatmap).gameStateAt(2200).spinnerVerdict[id].type).toBe("GREAT");
  });

  it("starts a spinner hold 12ms early without counting prestart cursor rotation", () => {
    const beatmap = map("256,192,1000,8,0,2000\n");
    const id = beatmap.hitObjects[0].id;
    const playback = machine(
      [
        at(0, 336, 192),
        at(987, 336, 192),
        at(988, 336, 192),
        at(999, 256, 272),
        at(1000, 176, 192),
        at(1010, 256, 112),
        at(2200, 256, 112),
      ],
      beatmap,
    );
    expect(playback.gameStateAt(987).pressingSince).toEqual([NOT_PRESSING, NOT_PRESSING]);
    expect(playback.gameStateAt(988).pressingSince[OsuAction.rightButton]).toBe(988);
    expect(playback.gameStateAt(999).spinnerState.get(id)?.totalSpunAngle).toBe(0);
    expect(playback.gameStateAt(1000).spinnerState.get(id)?.totalSpunAngle).toBe(0);
    expect(playback.gameStateAt(1010).spinnerState.get(id)?.totalSpunAngle).toBeCloseTo(90);
  });

  it("requires the base slider radius to reacquire after losing expanded follow tracking", () => {
    const beatmap = map("100,100,1000,2,0,L|380:100,1,280\n");
    const slider = beatmap.getSlider(beatmap.hitObjects[0].id);
    const playback = machine(
      [
        at(0),
        at(988),
        at(1100, 128, 100 + slider.radius * 2),
        at(1120, 133.6, 100 + slider.radius * 3),
        at(1140, 139.2, 100 + slider.radius * 2),
        at(1160, 144.8, 100 + slider.radius * 0.9),
        at(2300, 380),
      ],
      beatmap,
    );
    expect(playback.gameStateAt(1100).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
    expect(playback.gameStateAt(1120).sliderBodyState.get(slider.id)?.isTracking).toBe(false);
    expect(playback.gameStateAt(1140).sliderBodyState.get(slider.id)?.isTracking).toBe(false);
    expect(playback.gameStateAt(1160).sliderBodyState.get(slider.id)?.isTracking).toBe(true);
  });

  it("uses canonical catch-up samples so sparse replay seeks cannot change auto-hit times", () => {
    const beatmap = map("100,100,1000,1,0\n100,100,1400,1,0\n");
    const frames = [at(0), at(1700)];
    const playback = machine(frames, beatmap);
    const expected = machine(frames, beatmap).gameStateAt(1700).hitCircleVerdict;
    expect(Object.values(expected).map((value) => value.type)).toEqual(["GREAT", "GREAT"]);
    for (const time of [999, 1200, 1001, 1700, 500, 1401, 1700]) playback.gameStateAt(time);
    expect(playback.gameStateAt(1700).hitCircleVerdict).toEqual(expected);
    const fork = playback.fork();
    fork.gameStateAt(500);
    expect(fork.gameStateAt(1700).hitCircleVerdict).toEqual(expected);
    expect(playback.gameStateAt(1700).hitCircleVerdict).toEqual(expected);
  });

  it("never extends legacy automation beyond the recorded replay end", () => {
    const beatmap = map("100,100,1000,1,0\n100,100,2000,1,0\n");
    const final = machine([at(0), at(1300)], beatmap).gameStateAt(Infinity);
    expect(final.hitCircleVerdict[beatmap.hitObjects[0].id].type).toBe("GREAT");
    expect(final.hitCircleVerdict[beatmap.hitObjects[1].id]).toBeUndefined();
    expect(final.currentTime).toBe(1300);
  });
});
