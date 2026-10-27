import {
  calculatePlaybarMarkerBounds,
  PLAYBAR_EVENT_CANVAS_HEIGHT,
  PLAYBAR_RAIL_BOTTOM,
  PLAYBAR_RAIL_TOP,
  playbarMarkerLeft,
  playbarMarkerLeftIn,
} from "./playbar-marker-layout";

describe("playbar marker lanes", () => {
  it("places the 3a marks around the rail", () => {
    expect([PLAYBAR_EVENT_CANVAS_HEIGHT, PLAYBAR_RAIL_TOP, PLAYBAR_RAIL_BOTTOM]).toEqual([50, 25, 27]);
    expect(calculatePlaybarMarkerBounds("above", 15)).toEqual({ top: 9, height: 15 });
    expect(calculatePlaybarMarkerBounds("above", 11)).toEqual({ top: 13, height: 11 });
    expect(calculatePlaybarMarkerBounds("below", 14)).toEqual({ top: 28, height: 14 });
    expect(calculatePlaybarMarkerBounds("below", 10)).toEqual({ top: 28, height: 10 });
  });

  it("keeps every marker clear of the seek rail", () => {
    for (const height of [1, 10, 15, 100]) {
      const above = calculatePlaybarMarkerBounds("above", height);
      const below = calculatePlaybarMarkerBounds("below", height);
      expect(above.top + above.height).toBeLessThan(PLAYBAR_RAIL_TOP);
      expect(above.top).toBeGreaterThanOrEqual(0);
      expect(below.top).toBeGreaterThan(PLAYBAR_RAIL_BOTTOM);
      expect(below.top + below.height).toBeLessThanOrEqual(PLAYBAR_EVENT_CANVAS_HEIGHT);
    }
  });

  it("left-aligns marks at their time without rounding, inside the lane", () => {
    expect(playbarMarkerLeft(500, 1000, 801, 1.5)).toBe(400.5);
    expect(playbarMarkerLeft(1000, 1000, 800, 2)).toBe(798);
    expect(playbarMarkerLeft(-5, 1000, 800, 2)).toBe(0);
    expect(playbarMarkerLeft(10, 0, 800, 2)).toBe(798);
  });
});

describe("marks on a lane that shows a stretch of the map", () => {
  const section = { startMs: 40_000, endMs: 60_000 };

  it("places a mark by its time across the stretch", () => {
    expect(playbarMarkerLeftIn(40_000, section, 1000, 2)).toBe(0);
    expect(playbarMarkerLeftIn(45_000, section, 1000, 2)).toBe(250);
    // Misses 125 ms apart are 6.25 px apart at 20 s across 1000 px, and under 1 px apart on a two-minute map.
    expect(playbarMarkerLeftIn(45_125, section, 1000, 2) - playbarMarkerLeftIn(45_000, section, 1000, 2)).toBeCloseTo(6.25, 6);
    expect(playbarMarkerLeft(45_125, 120_000, 1000, 2) - playbarMarkerLeft(45_000, 120_000, 1000, 2)).toBeLessThan(1.1);
  });

  it("keeps a mark at the stretch's end inside the lane, and is the old placement for the whole map", () => {
    expect(playbarMarkerLeftIn(60_000, section, 1000, 2)).toBe(998);
    expect(playbarMarkerLeftIn(500, { startMs: 0, endMs: 1000 }, 801, 1.5)).toBe(playbarMarkerLeft(500, 1000, 801, 1.5));
  });
});
