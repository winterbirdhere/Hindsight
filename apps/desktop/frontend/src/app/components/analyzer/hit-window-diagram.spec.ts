import { buildHitWindowDiagram } from "./hit-window-diagram";

describe("buildHitWindowDiagram", () => {
  const windows = [20, 60, 100, 400];

  it("sizes the segments from the real windows", () => {
    expect(buildHitWindowDiagram(43, windows, 1)?.segments).toEqual([
      { kind: "50", flex: 40 },
      { kind: "100", flex: 40 },
      { kind: "300", flex: 40 },
      { kind: "100", flex: 40 },
      { kind: "50", flex: 40 },
    ]);
  });

  it("places and labels the press mark", () => {
    expect(buildHitWindowDiagram(50, windows, 1)).toMatchObject({ markPercent: 68, label: "+50 ms" });
    expect(buildHitWindowDiagram(-25, windows, 1)).toMatchObject({ markPercent: 41, label: "−25 ms" });
    expect(buildHitWindowDiagram(0, windows, 1)).toMatchObject({ markPercent: 50, label: "+0 ms" });
  });

  it("converts the windows to playback time", () => {
    // At 1.5× the 100 ms window lasts 66.7 ms of playback: a 50 ms offset sits at 50 + 0.75 × 36.
    expect(buildHitWindowDiagram(50, windows, 1.5)?.markPercent).toBeCloseTo(77, 5);
  });

  it("clamps a far press inside the diagram and keeps the true label", () => {
    expect(buildHitWindowDiagram(390, windows, 1)).toMatchObject({ markPercent: 98, label: "+390 ms" });
    expect(buildHitWindowDiagram(-390, windows, 1)).toMatchObject({ markPercent: 2, label: "−390 ms" });
  });

  it("refuses unusable windows, rates and offsets", () => {
    expect(buildHitWindowDiagram(10, [], 1)).toBeUndefined();
    expect(buildHitWindowDiagram(10, [60, 20, 100], 1)).toBeUndefined();
    expect(buildHitWindowDiagram(10, windows, 0)).toBeUndefined();
    expect(buildHitWindowDiagram(NaN, windows, 1)).toBeUndefined();
  });
});
