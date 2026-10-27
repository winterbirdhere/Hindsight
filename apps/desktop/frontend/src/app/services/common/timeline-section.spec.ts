import { defaultSection, dragSection, MAX_DRAG_SECTION_MS, MIN_SECTION_MS, pageSection, sectionFraction, zoomSection, type SectionContext } from "./timeline-section";

// 120 BPM in 4/4 from 1000 ms: a bar is 2 s, eight bars are 16 s. The map is two minutes long.
const context = (extra: Partial<SectionContext> = {}): SectionContext => ({
  timingPoints: [{ time: 1_000, beatLength: 500 }],
  errorTimes: [],
  durationMs: 120_000,
  nearMs: 500,
  ...extra,
});

describe("defaultSection", () => {
  it("is eight bars around the point, starting on a bar line", () => {
    // Eight seconds before 60 000 is 52 000; the bar line at or before it is 51 000.
    expect(defaultSection(60_000, context())).toEqual({ startMs: 51_000, endMs: 67_000 });
  });

  it("follows the tempo at the point", () => {
    const faster = context({ timingPoints: [{ time: 1_000, beatLength: 500 }, { time: 40_000, beatLength: 250 }] });
    // A bar is 1 s there: eight bars, from the bar line at 56 000.
    expect(defaultSection(60_000, faster)).toEqual({ startMs: 56_000, endMs: 64_000 });
    const waltz = context({ timingPoints: [{ time: 1_000, beatLength: 500, beatsPerBar: 3 }] });
    expect(defaultSection(60_000, waltz)).toEqual({ startMs: 53_500, endMs: 65_500 });
  });

  it("is sixteen seconds around the point without timing", () => {
    expect(defaultSection(60_000, context({ timingPoints: [] }))).toEqual({ startMs: 52_000, endMs: 68_000 });
  });

  it("stays inside the map at its ends without getting shorter", () => {
    expect(defaultSection(2_000, context())).toEqual({ startMs: 0, endMs: 16_000 });
    expect(defaultSection(119_000, context())).toEqual({ startMs: 104_000, endMs: 120_000 });
  });

  it("widens to hold the whole run of errors that was pointed at, with a bar to spare on each side", () => {
    // Errors every 1.5 s from 50 s to 71 s: one run (a bar is 2 s), longer than eight bars.
    const run = Array.from({ length: 15 }, (_unused, index) => 50_000 + index * 1_500);
    const section = defaultSection(60_100, context({ errorTimes: [10_000, ...run, 90_000] }));
    expect(section).toEqual({ startMs: 47_000, endMs: 73_000 });
  });

  it("does not widen for errors that were not pointed at, or that are not part of the run", () => {
    const errors = [50_000, 58_000, 60_000, 61_000, 66_500];
    // The point is 600 ms from the nearest error, further than `nearMs`.
    expect(defaultSection(59_400, context({ errorTimes: errors }))).toEqual({ startMs: 51_000, endMs: 67_000 });
    // On the error at 60 000: its run is 58 000 to 61 000, well inside eight bars.
    expect(defaultSection(60_000, context({ errorTimes: errors }))).toEqual({ startMs: 51_000, endMs: 67_000 });
  });

  it("is the whole map, so no section, when the map is no longer than that", () => {
    expect(defaultSection(5_000, context({ durationMs: 16_000 }))).toBeUndefined();
    expect(defaultSection(5_000, context({ durationMs: 0 }))).toBeUndefined();
  });
});

describe("dragSection", () => {
  it("is the stretch that was dragged over, in either direction", () => {
    expect(dragSection(30_000, 42_500, 120_000)).toEqual({ startMs: 30_000, endMs: 42_500 });
    expect(dragSection(42_500, 30_000, 120_000)).toEqual({ startMs: 30_000, endMs: 42_500 });
  });

  it("is never shorter than two seconds: a short drag grows around its middle", () => {
    expect(MIN_SECTION_MS).toBe(2_000);
    expect(dragSection(30_000, 30_400, 120_000)).toEqual({ startMs: 29_200, endMs: 31_200 });
    expect(dragSection(100, 300, 120_000)).toEqual({ startMs: 0, endMs: 2_000 });
  });

  it("is never longer than thirty seconds: a longer drag keeps the thirty from where it began", () => {
    expect(MAX_DRAG_SECTION_MS).toBe(30_000);
    expect(dragSection(10_000, 80_000, 120_000)).toEqual({ startMs: 10_000, endMs: 40_000 });
    // Dragged leftwards from 80 s: the thirty seconds before it.
    expect(dragSection(80_000, 10_000, 120_000)).toEqual({ startMs: 50_000, endMs: 80_000 });
    expect(dragSection(0, 130_000, 120_000)).toEqual({ startMs: 0, endMs: 30_000 });
    expect(dragSection(60_000, 90_000, 120_000)).toEqual({ startMs: 60_000, endMs: 90_000 });
  });

  it("stays inside the map, and is no section when it covers all of a short one", () => {
    expect(dragSection(-5_000, 10_000, 120_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(dragSection(0, 25_000, 20_000)).toBeUndefined();
  });
});

describe("zoomSection", () => {
  const section = { startMs: 40_000, endMs: 60_000 };

  it("makes the section longer or shorter around the point under the pointer", () => {
    // The pointer is a quarter of the way in, at 45 000, and stays a quarter of the way in.
    expect(zoomSection(section, 2, 45_000, 120_000)).toEqual({ startMs: 35_000, endMs: 75_000 });
    expect(zoomSection(section, 0.5, 45_000, 120_000)).toEqual({ startMs: 42_500, endMs: 52_500 });
  });

  it("starts from the whole map when there is no section yet", () => {
    expect(zoomSection(undefined, 0.5, 60_000, 120_000)).toEqual({ startMs: 30_000, endMs: 90_000 });
    expect(zoomSection(undefined, 2, 60_000, 120_000)).toBeUndefined();
  });

  it("stops at two seconds, and is the whole map again once it is as long as the map", () => {
    expect(zoomSection({ startMs: 40_000, endMs: 42_500 }, 0.5, 41_250, 120_000)).toEqual({ startMs: 40_250, endMs: 42_250 });
    expect(zoomSection({ startMs: 10_000, endMs: 100_000 }, 2, 50_000, 120_000)).toBeUndefined();
  });

  it("stays inside the map without losing length", () => {
    expect(zoomSection({ startMs: 0, endMs: 10_000 }, 2, 9_000, 120_000)).toEqual({ startMs: 0, endMs: 20_000 });
    expect(zoomSection({ startMs: 110_000, endMs: 120_000 }, 2, 111_000, 120_000)).toEqual({ startMs: 100_000, endMs: 120_000 });
  });
});

describe("pageSection", () => {
  const section = { startMs: 40_000, endMs: 60_000 };

  it("leaves the section alone while the playhead is in it, its ends included", () => {
    for (const time of [40_000, 50_000, 60_000]) expect(pageSection(section, time, 120_000)).toBe(section);
  });

  it("turns as many pages as it takes to hold the playhead", () => {
    expect(pageSection(section, 60_016, 120_000)).toEqual({ startMs: 60_000, endMs: 80_000 });
    expect(pageSection(section, 105_000, 120_000)).toEqual({ startMs: 100_000, endMs: 120_000 });
    expect(pageSection(section, 39_000, 120_000)).toEqual({ startMs: 20_000, endMs: 40_000 });
    expect(pageSection(section, 500, 120_000)).toEqual({ startMs: 0, endMs: 20_000 });
  });

  it("keeps its length on the last page of a map that does not divide evenly", () => {
    expect(pageSection(section, 109_000, 110_000)).toEqual({ startMs: 90_000, endMs: 110_000 });
  });
});

describe("sectionFraction", () => {
  it("says where a time is across the section", () => {
    const section = { startMs: 40_000, endMs: 60_000 };
    expect(sectionFraction(45_000, section)).toBe(0.25);
    expect(sectionFraction(30_000, section)).toBe(-0.5);
  });
});
