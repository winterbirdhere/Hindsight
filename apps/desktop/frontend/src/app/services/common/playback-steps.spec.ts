import { barStep, frameStep, NUDGE_STEP_MS, noteStep, nudgeStep, type StepMap } from "./playback-steps";

// 120 BPM from 1000 ms: a beat is 500 ms.
const map = (extra: Partial<StepMap> = {}): StepMap => ({
  noteTimes: [],
  timingPoints: [{ time: 1_000, beatLength: 500 }],
  frameTimes: [],
  durationMs: 60_000,
  ...extra,
});

describe("noteStep with a fixed step", () => {
  it("goes to the next and the previous line of the beat's division", () => {
    expect(noteStep(1_000, 1, "1/4", map())).toBe(1_125);
    expect(noteStep(1_125, -1, "1/4", map())).toBe(1_000);
    expect(noteStep(1_000, 1, "1/3", map())).toBeCloseTo(1_166.667, 2);
    expect(noteStep(1_000, 1, "1/1", map())).toBe(1_500);
  });

  it("snaps a playhead that is between lines to the line in that direction", () => {
    expect(noteStep(1_060, 1, "1/4", map())).toBe(1_125);
    expect(noteStep(1_060, -1, "1/4", map())).toBe(1_000);
  });

  it("takes a playhead a fraction of a millisecond off a line as on it", () => {
    expect(noteStep(1_124.8, 1, "1/4", map())).toBe(1_250);
    expect(noteStep(1_125.2, -1, "1/4", map())).toBe(1_000);
  });

  it("follows the timing point at the playhead and restarts the grid at each one", () => {
    const changing = map({ timingPoints: [{ time: 1_000, beatLength: 500 }, { time: 2_100, beatLength: 300 }] });
    // The next line of the first section would be 2500, past the second timing point.
    expect(noteStep(2_000, 1, "1/1", changing)).toBe(2_100);
    expect(noteStep(2_100, 1, "1/1", changing)).toBe(2_400);
    expect(noteStep(2_400, -1, "1/1", changing)).toBe(2_100);
    expect(noteStep(2_100, -1, "1/1", changing)).toBe(2_000);
  });

  it("carries the first timing point's grid back to the start of the map", () => {
    expect(noteStep(400, 1, "1/1", map())).toBe(500);
    expect(noteStep(1_000, -1, "1/1", map())).toBe(500);
  });

  it("stays inside the replay", () => {
    expect(noteStep(1_000, 1, "1/1", map({ durationMs: 1_100 }))).toBe(1_100);
    expect(noteStep(200, -1, "1/1", map())).toBe(0);
    expect(noteStep(0, -1, "1/1", map())).toBe(0);
  });
});

describe("noteStep on Auto", () => {
  const notes = map({ noteTimes: [1_000, 1_250, 1_375, 3_000] });

  it("goes from note to note, whatever their rhythm", () => {
    expect(noteStep(1_000, 1, "auto", notes)).toBe(1_250);
    expect(noteStep(1_250, 1, "auto", notes)).toBe(1_375);
    expect(noteStep(1_375, -1, "auto", notes)).toBe(1_250);
    // Thirds of a beat, which a 1/4 grid never lands on.
    const thirds = map({ noteTimes: [1_000, 1_166.67, 1_333.33] });
    expect(noteStep(1_000, 1, "auto", thirds)).toBe(1_166.67);
    expect(noteStep(1_333.33, -1, "auto", thirds)).toBe(1_166.67);
  });

  it("moves one beat where the next note is more than a beat away", () => {
    expect(noteStep(1_375, 1, "auto", notes)).toBe(1_500);
    expect(noteStep(1_500, 1, "auto", notes)).toBe(2_000);
    expect(noteStep(3_000, -1, "auto", notes)).toBe(2_500);
  });

  it("goes to a note that is within a beat even when a beat line comes first", () => {
    // From 2600 the beat line is 3000 itself; from 2550 the note at 3000 is 450 ms away.
    expect(noteStep(2_550, 1, "auto", notes)).toBe(3_000);
    const offGrid = map({ noteTimes: [1_000, 1_700] });
    expect(noteStep(1_300, 1, "auto", offGrid)).toBe(1_700);
  });

  it("moves by beats where there are no notes at all, and by a second without timing either", () => {
    expect(noteStep(1_000, 1, "auto", map())).toBe(1_500);
    const bare = map({ timingPoints: [] });
    expect(noteStep(1_000, 1, "auto", bare)).toBe(2_000);
    expect(noteStep(1_000, -1, "auto", bare)).toBe(0);
    expect(noteStep(1_000, 1, "1/4", bare)).toBe(2_000);
    expect(noteStep(1_000, 1, "auto", map({ timingPoints: [], noteTimes: [1_400] }))).toBe(1_400);
  });
});

describe("frameStep", () => {
  it("goes to the next and the previous recorded frame", () => {
    const frames = map({ frameTimes: [1_000, 1_016, 1_033, 1_050] });
    expect(frameStep(1_016, 1, frames)).toBe(1_033);
    expect(frameStep(1_016, -1, frames)).toBe(1_000);
    expect(frameStep(1_020, 1, frames)).toBe(1_033);
  });

  it("never moves less than 4 ms, however densely the replay was recorded", () => {
    const dense = map({ frameTimes: Array.from({ length: 11 }, (_unused, index) => 1_000 + index) });
    expect(frameStep(1_000, 1, dense)).toBe(1_004);
    expect(frameStep(1_010, -1, dense)).toBe(1_006);
  });

  it("moves 4 ms where no frame is left in that direction, and stays inside the replay", () => {
    const frames = map({ frameTimes: [1_000, 1_016], durationMs: 1_100 });
    expect(frameStep(1_016, 1, frames)).toBe(1_020);
    expect(frameStep(1_000, -1, frames)).toBe(996);
    expect(frameStep(1_099, 1, frames)).toBe(1_100);
    expect(frameStep(2, -1, map())).toBe(0);
  });
});

describe("nudgeStep", () => {
  it("moves 30 ms of map time, each way", () => {
    expect(NUDGE_STEP_MS).toBe(30);
    expect(nudgeStep(5_000, 1, map())).toBe(5_030);
    expect(nudgeStep(5_000, -1, map())).toBe(4_970);
    expect(nudgeStep(5_030, -1, map())).toBe(5_000);
  });

  it("is the same wherever the notes, the frames and the timing are", () => {
    const busy = map({
      noteTimes: [5_001, 5_010, 5_029],
      frameTimes: [5_004, 5_008],
      timingPoints: [{ time: 4_990, beatLength: 100 }],
    });
    expect(nudgeStep(5_000, 1, busy)).toBe(5_030);
    expect(nudgeStep(5_000, -1, busy)).toBe(4_970);
    expect(nudgeStep(5_000, 1, map({ timingPoints: [] }))).toBe(5_030);
  });

  it("stops at the start and the end of the map", () => {
    expect(nudgeStep(10, -1, map())).toBe(0);
    expect(nudgeStep(0, -1, map())).toBe(0);
    expect(nudgeStep(59_990, 1, map())).toBe(60_000);
    expect(nudgeStep(60_000, 1, map())).toBe(60_000);
    expect(nudgeStep(10, 1, map({ durationMs: 0 }))).toBe(0);
  });
});

describe("barStep", () => {
  it("moves one bar: four beats, or as many as the timing point says", () => {
    expect(barStep(1_000, 1, map())).toBe(3_000);
    expect(barStep(3_000, -1, map())).toBe(1_000);
    expect(barStep(1_700, 1, map())).toBe(3_000);
    expect(barStep(1_000, 1, map({ timingPoints: [{ time: 1_000, beatLength: 500, beatsPerBar: 3 }] }))).toBe(2_500);
  });

  it("moves two seconds without timing", () => {
    expect(barStep(1_000, 1, map({ timingPoints: [] }))).toBe(3_000);
  });
});
