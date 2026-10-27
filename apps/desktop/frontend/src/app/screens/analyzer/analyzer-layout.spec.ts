import { calculateAnalyzerLayout, maxColumnInspectorWidth, playfieldLeftPx, STATS_OVERLAY } from "./analyzer-layout";
import { calculateAnalysisStageLayout } from "../../services/renderers/components/stage/AnalysisStageLayout";
import {
  LIVE_STATS_RESERVE_PX,
  liveStageFrame,
  STAGE_FRAME_HEIGHT,
} from "../../services/renderers/components/stage/stage-frame";
import { INSPECTOR_WIDTH_LIMITS } from "../../services/analysis/inspector-layout-settings";

/** Playfield height (CSS px) the real live frame draws for a layout's stage. */
function playfieldHeightPx({ stageWidth, stageHeight }: { stageWidth: number; stageHeight: number }) {
  const { playfield } = calculateAnalysisStageLayout(
    { x: 0, y: 0, width: 0, height: 0 },
    liveStageFrame(stageWidth, stageHeight),
  );
  return (playfield.height * stageHeight) / STAGE_FRAME_HEIGHT;
}

const wantedPx = (height: number) => 0.815 * (height - 86);

it("derives the stats overlay's needed margin from the one stage-frame constant", () => {
  expect(STATS_OVERLAY.left + STATS_OVERLAY.width + STATS_OVERLAY.gap).toBe(LIVE_STATS_RESERVE_PX);
  expect(16 + 118 + 6).toBe(LIVE_STATS_RESERVE_PX);
});

it.each([
  [1920, 1080, "column", true],
  [1440, 900, "column", true], // was false: the stage now reserves the left 140 px for the stats instead of hiding them
  [1440, 782, "column", true],
  [1280, 800, "column", true], // was false
  [1024, 768, "drawer", true],
  [900, 800, "drawer", true], // was false
] as const)("%i × %i folds to %s, stats overlay %s", (width, height, inspector, statsOverlay) => {
  const layout = calculateAnalyzerLayout(width, height);
  expect(layout.inspector).toBe(inspector);
  expect(layout.statsOverlay).toBe(statsOverlay);
  expect(layout.stageWidth).toBe(inspector === "column" ? width - 260 : width);
  expect(layout.stageHeight).toBe(height - 86);
});

// The fold and the live stage frame together give these playfield heights.
it.each([
  [1920, 1080, 810],
  [1440, 900, 663],
  [1440, 782, 567],
  [1280, 800, 582], // the reserve shifts the region by the deficit only, so the playfield keeps its full height
  [1280, 720, 517],
  [1024, 768, 556],
] as const)("%i × %i shows a %i px playfield", (width, height, expectedPx) => {
  const { stageWidth, stageHeight } = calculateAnalyzerLayout(width, height);
  const { playfield } = calculateAnalysisStageLayout(
    { x: 0, y: 0, width: 0, height: 0 },
    liveStageFrame(stageWidth, stageHeight),
  );
  expect(Math.round((playfield.height * stageHeight) / STAGE_FRAME_HEIGHT)).toBe(expectedPx);
});

// The stats overlay never overlaps the playfield: the playfield starts at or after the overlay's right edge plus clearance.
it.each([
  [1920, 1080],
  [1440, 900],
  [1440, 782],
  [1280, 800],
  [1280, 720],
  [1024, 768],
  [900, 800],
] as const)("%i × %i leaves the stats overlay its margin left of the playfield", (width, height) => {
  const { stageWidth, stageHeight, statsOverlay } = calculateAnalyzerLayout(width, height);
  expect(statsOverlay).toBe(true);
  expect(playfieldLeftPx(stageWidth, stageHeight)).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX - 1e-6);
});

it("hides the stats overlay only when the region left of the playfield would be under 320 px", () => {
  // A 440 px window folds the inspector away (stage 440 wide): 440 − 140 = 300 < 320.
  expect(calculateAnalyzerLayout(440, 800).statsOverlay).toBe(false);
  expect(calculateAnalyzerLayout(460, 800).statsOverlay).toBe(true);
});

it("never hides the stats overlay for a small window alone", () => {
  // A wide, short window leaves a large art margin: the overlay stays.
  expect(calculateAnalyzerLayout(1100, 480).statsOverlay).toBe(true);
});

it("measures the art margin left of the playfield", () => {
  // 1100 × 696 stage: playfield 567.24 px high, 756.32 px wide, centred.
  expect(playfieldLeftPx(1100, 696)).toBeCloseTo(171.84, 1);
  expect(playfieldLeftPx(0, 0)).toBe(0);
});

// Phase 1b: the inspector's width is a user choice, clamped to the window; the fold rule and stats rule use it.
describe("calculateAnalyzerLayout with a chosen inspector width", () => {
  it.each([
    // width, height, inspector width, clamped width, fold, stage width, stats overlay
    [1440, 782, 240, 240, "column", 1200, true],
    [1440, 782, 280, 280, "column", 1160, true],
    [1440, 782, 340, 340, "column", 1100, true],
    [1440, 782, 520, 440, "column", 1000, true], // limited to 440; the stage reserves the stats margin (was false)
    [1920, 1080, 240, 240, "column", 1680, true],
    [1920, 1080, 340, 340, "column", 1580, true],
    [1920, 1080, 520, 440, "column", 1480, true],
    [1440, 900, 340, 340, "column", 1100, true], // was false
    [1440, 900, 520, 394, "column", 1046, true], // limited to 440, but 440 leaves a 612 px playfield; 394 is the widest keeping 663 (was column 440, stats false)
    [1200, 900, 440, 440, "drawer", 1200, true], // even 240 leaves less than the 663 px playfield (the widest is 154): folds
    [1100, 900, 440, 440, "drawer", 1100, true], // even 240 does not fit (the widest is 167): folds
    [1024, 768, 240, 240, "drawer", 1024, true],
    [1024, 768, 340, 340, "drawer", 1024, true],
    [1024, 768, 520, 440, "drawer", 1024, true],
    [900, 768, 640, 420, "drawer", 900, true], // limited to window − 480 (stats was false)
  ] as const)("%i × %i with %i px: width %i, %s, stage %i, stats %s", (width, height, requested, clamped, inspector, stageWidth, statsOverlay) => {
    const layout = calculateAnalyzerLayout(width, height, requested);
    expect(layout.inspectorWidth).toBe(clamped);
    expect(layout.inspector).toBe(inspector);
    expect(layout.stageWidth).toBe(stageWidth);
    expect(layout.statsOverlay).toBe(statsOverlay);
    expect(layout.stageHeight).toBe(height - 86);
  });

  it("keeps the 260 px default and reports it", () => {
    expect(calculateAnalyzerLayout(1440, 782).inspectorWidth).toBe(260);
    expect(calculateAnalyzerLayout(1440, 782)).toEqual(calculateAnalyzerLayout(1440, 782, 260, true));
  });

  it("clamps a bad request instead of throwing", () => {
    expect(calculateAnalyzerLayout(1440, 782, 5).inspectorWidth).toBe(240);
    expect(calculateAnalyzerLayout(1440, 782, 5000).inspectorWidth).toBe(440);
    expect(calculateAnalyzerLayout(1440, 782, Number.NaN).inspectorWidth).toBe(260);
  });

  it("gives a hidden column the full width and judges the stats overlay on it", () => {
    const shown = calculateAnalyzerLayout(1440, 900, 340, true);
    const hidden = calculateAnalyzerLayout(1440, 900, 340, false);
    expect(shown).toMatchObject({ inspector: "column", stageWidth: 1100, statsOverlay: true }); // was false
    expect(hidden).toMatchObject({ inspector: "column", stageWidth: 1440, statsOverlay: true });
    expect(calculateAnalyzerLayout(1280, 800, 340, false)).toMatchObject({ inspector: "column", stageWidth: 1280, statsOverlay: true });
    expect(hidden.stageHeight).toBe(814);
  });

  it("still folds by the clamped width when hidden, and a drawer is as wide as the window", () => {
    // 1100 × 900: even the 240 px minimum does not keep the column, so it folds whatever the width.
    expect(calculateAnalyzerLayout(1100, 900, 440, false)).toMatchObject({ inspector: "drawer", stageWidth: 1100 });
    expect(calculateAnalyzerLayout(1024, 768, 340, false)).toMatchObject({ inspector: "drawer", stageWidth: 1024 });
  });
});

describe("maxColumnInspectorWidth", () => {
  it.each([
    // width, height, widest inspector that keeps the playfield at its wanted height on the real (reserve-aware) frame
    [1440, 782, 525], // was 635
    [1440, 900, 394], // was 507
    [1200, 900, 154], // was 267
    [1920, 1080, 673], // was 791
    [1600, 400, 1242], // was 1210
  ] as const)("%i × %i keeps the column up to %i px", (width, height, widest) => {
    expect(maxColumnInspectorWidth(width, height)).toBe(widest);
    expect(calculateAnalyzerLayout(width, height, widest).inspector).toBe(widest >= 240 ? "column" : "drawer");
    // Exact: the playfield is at its wanted height at that width and short of it one pixel wider.
    const at = (inspector: number) => ({ stageWidth: width - inspector, stageHeight: height - 86 });
    expect(playfieldHeightPx(at(widest))).toBeGreaterThanOrEqual(wantedPx(height) - 0.5);
    expect(playfieldHeightPx(at(widest + 1))).toBeLessThan(wantedPx(height) - 0.5);
    // One pixel more than the column allows shrinks to the widest that fits instead of folding.
    if (widest + 1 <= 440 && widest + 1 <= width - 480 && widest >= INSPECTOR_WIDTH_LIMITS.min) {
      expect(calculateAnalyzerLayout(width, height, widest + 1)).toMatchObject({ inspector: "column", inspectorWidth: widest });
    }
  });

  it("is zero or less when even a narrow inspector folds", () => {
    expect(maxColumnInspectorWidth(1024, 768)).toBeLessThan(240);
    expect(maxColumnInspectorWidth(1024, 768)).toBe(125);
  });
});

describe("the inspector shrinks before it folds into the drawer", () => {
  it("keeps the column at the largest width that keeps the playfield when the stored width no longer does (1440 × 900, stored 440)", () => {
    // 440 would leave 612 px of the wanted 663 px; 394 is the widest that keeps it.
    const stored = calculateAnalyzerLayout(1440, 900, 440);
    expect(maxColumnInspectorWidth(1440, 900)).toBe(394);
    expect(stored).toMatchObject({ inspector: "column", inspectorWidth: 394, stageWidth: 1046, stageHeight: 814, statsOverlay: true });
    expect(playfieldHeightPx(stored)).toBeGreaterThanOrEqual(wantedPx(900) - 0.5);
    expect(Math.round(playfieldHeightPx(stored))).toBe(663);
    expect(playfieldHeightPx({ stageWidth: 1000, stageHeight: 814 })).toBeLessThan(wantedPx(900) - 0.5);
    expect(playfieldLeftPx(stored.stageWidth, stored.stageHeight)).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX - 1e-6);
    // A width that fits is used as it is.
    expect(calculateAnalyzerLayout(1440, 900, 340)).toMatchObject({ inspector: "column", inspectorWidth: 340, stageWidth: 1100 });
    expect(calculateAnalyzerLayout(1440, 782, 440)).toMatchObject({ inspector: "column", inspectorWidth: 440, stageWidth: 1000 });
    expect(Math.round(playfieldHeightPx(calculateAnalyzerLayout(1440, 782, 440)))).toBe(567);
  });

  it("never leaves a playfield shorter than wanted in a column, at any stored width", () => {
    for (const [width, height] of [[1440, 900], [1440, 782], [1280, 800], [1280, 720], [1920, 1080], [1300, 900], [1286, 900]] as const) {
      for (const stored of [240, 300, 340, 400, 440]) {
        const layout = calculateAnalyzerLayout(width, height, stored);
        if (layout.inspector === "column") {
          expect(playfieldHeightPx(layout)).toBeGreaterThanOrEqual(wantedPx(height) - 0.5);
        }
      }
    }
  });

  it("folds into the drawer at 1200 × 900, where even 240 px leaves a shorter playfield, and the drawer playfield is full height", () => {
    expect(maxColumnInspectorWidth(1200, 900)).toBeLessThan(INSPECTOR_WIDTH_LIMITS.min);
    const layout = calculateAnalyzerLayout(1200, 900, 440);
    expect(layout).toMatchObject({ inspector: "drawer", inspectorWidth: 440, stageWidth: 1200 });
    expect(Math.round(playfieldHeightPx(layout))).toBe(663);
  });

  it.each([
    // height, narrowest window with a 240 px column (recomputed with the reserve-aware rule; at 900 it was 1173)
    [900, 1286],
    [800, 1175],
    [782, 1155],
    [720, 1086],
  ] as const)("takes exactly the 240 px minimum at height %i from window width %i, and folds one pixel earlier", (height, width) => {
    expect(maxColumnInspectorWidth(width, height)).toBe(240);
    const column = calculateAnalyzerLayout(width, height, 440);
    expect(column).toMatchObject({ inspector: "column", inspectorWidth: 240, stageWidth: width - 240 });
    expect(playfieldHeightPx(column)).toBeGreaterThanOrEqual(wantedPx(height) - 0.5);
    expect(maxColumnInspectorWidth(width - 1, height)).toBe(239);
    expect(calculateAnalyzerLayout(width - 1, height, 440)).toMatchObject({ inspector: "drawer", stageWidth: width - 1 });
  });

  it("folds into the drawer, as before, when even 240 px does not fit", () => {
    expect(maxColumnInspectorWidth(1024, 768)).toBeLessThan(INSPECTOR_WIDTH_LIMITS.min);
    expect(calculateAnalyzerLayout(1024, 768, 240)).toMatchObject({ inspector: "drawer", inspectorWidth: 240, stageWidth: 1024 });
    expect(calculateAnalyzerLayout(1024, 768, 440)).toMatchObject({ inspector: "drawer", inspectorWidth: 440, stageWidth: 1024 });
  });

  it("is a pure function of the window and the request: the stored width comes back when the window grows", () => {
    expect(calculateAnalyzerLayout(1440, 900, 440).inspectorWidth).toBe(394);
    expect(calculateAnalyzerLayout(1600, 900, 440).inspectorWidth).toBe(440);
  });

  it("gives a hidden column the full width, and still judges the fold by the shrunken width", () => {
    expect(calculateAnalyzerLayout(1440, 900, 440, false)).toMatchObject({ inspector: "column", inspectorWidth: 394, stageWidth: 1440 });
    expect(calculateAnalyzerLayout(1285, 900, 440, false)).toMatchObject({ inspector: "drawer", stageWidth: 1285 });
  });
});
