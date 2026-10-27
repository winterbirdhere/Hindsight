import { calculateAnalysisStageLayout } from "./AnalysisStageLayout";
import {
  EXPORT_STAGE_FRAME,
  LIVE_PLAYFIELD_HEIGHT_RATIO,
  LIVE_STATS_MIN_REGION_PX,
  LIVE_STATS_RESERVE_PX,
  liveStageFrame,
  liveStatsOverlayFits,
  PLAYFIELD_SIDE_MARGIN,
  sameStageFrame,
  STAGE_FRAME_HEIGHT,
} from "./stage-frame";

const NO_OVERLAY = { x: 0, y: 0, width: 0, height: 0 };

/** The playfield as the live stage draws it for a stage of this CSS-px size, converted to CSS px. */
function livePlayfieldPx(widthPx: number, heightPx: number) {
  const frame = liveStageFrame(widthPx, heightPx);
  const { playfield } = calculateAnalysisStageLayout(NO_OVERLAY, frame);
  const toPx = heightPx / STAGE_FRAME_HEIGHT;
  return {
    frame,
    left: playfield.left * toPx,
    width: playfield.width * toPx,
    height: playfield.height * toPx,
    regionLeftPx: frame.regionLeft * toPx,
    regionWidthPx: (frame.width - frame.regionLeft) * toPx,
  };
}

describe("LIVE_STATS_RESERVE_PX", () => {
  it("is the 140 px the stats overlay needs: left offset, width and the clearance to the playfield", () => {
    expect(LIVE_STATS_RESERVE_PX).toBe(140);
  });
});

describe("liveStageFrame reserves the left of the stage for the stats overlay", () => {
  it.each([
    [1100, 696], // 1440 × 782 column stage
    [1580, 994], // 1920 × 1080 column stage
  ] as const)("%i × %i: the centred playfield already leaves 140 px, so nothing is reserved", (width, height) => {
    const { frame, left } = livePlayfieldPx(width, height);
    expect(left).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX);
    expect(frame.regionLeft).toBe(0);
    expect(frame.width).toBeCloseTo((STAGE_FRAME_HEIGHT * width) / height);
  });

  it("1100 × 696 keeps the playfield centred at 171.8 px", () => {
    const { frame, left, height } = livePlayfieldPx(1100, 696);
    expect(frame.regionLeft).toBe(0);
    expect(left).toBeCloseTo(171.84, 1);
    expect(height).toBeCloseTo(LIVE_PLAYFIELD_HEIGHT_RATIO * 696, 1);
  });

  it("1100 × 814 (1440 × 900 column stage) shifts by the deficit only, putting the playfield at exactly 140 px, at its full height", () => {
    const { frame, left, height, regionLeftPx } = livePlayfieldPx(1100, 814);
    // Centred left is 107.73 px: the region starts 2 x (140 − 107.73) = 64.55 px in, not at 140 px.
    expect(regionLeftPx).toBeCloseTo(64.55, 1);
    expect(frame.regionLeft).toBeCloseTo((regionLeftPx * STAGE_FRAME_HEIGHT) / 814, 6);
    expect(left).toBeCloseTo(LIVE_STATS_RESERVE_PX, 6);
    expect(height).toBeCloseTo(LIVE_PLAYFIELD_HEIGHT_RATIO * 814, 1);
    expect(Math.round(height)).toBe(663);
  });

  it("940 × 714 (1280 × 800 column stage) keeps the full 582 px playfield, its left edge at exactly 140 px", () => {
    const { left, height, regionLeftPx } = livePlayfieldPx(940, 714);
    expect(regionLeftPx).toBeCloseTo(115.88, 1);
    expect(left).toBeCloseTo(LIVE_STATS_RESERVE_PX, 6);
    expect(height).toBeCloseTo(LIVE_PLAYFIELD_HEIGHT_RATIO * 714, 1);
  });

  it("940 × 634 (1280 × 720 column stage) keeps the full playfield, its left edge at exactly 140 px", () => {
    const { left, height, regionLeftPx } = livePlayfieldPx(940, 634);
    expect(regionLeftPx).toBeCloseTo(28.95, 1);
    expect(left).toBeCloseTo(LIVE_STATS_RESERVE_PX, 6);
    expect(height).toBeCloseTo(LIVE_PLAYFIELD_HEIGHT_RATIO * 634, 1);
  });

  it("790 × 605 shrinks the playfield to the region right of the shift (left edge stays beyond 140 px)", () => {
    const { frame, left, width, height, regionWidthPx } = livePlayfieldPx(790, 605);
    const marginPx = (PLAYFIELD_SIDE_MARGIN * 2 * 605) / STAGE_FRAME_HEIGHT;
    expect(width).toBeCloseTo(regionWidthPx - marginPx, 6);
    expect(height).toBeLessThan(LIVE_PLAYFIELD_HEIGHT_RATIO * 605 - 1);
    expect(height).toBeCloseTo((width * 384) / 512, 6);
    expect(left).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX);
    expect(frame.regionLeft).toBeCloseTo(219.3223, 3);
  });

  it("the key overlay, combo and hit-error bar anchors follow the reserved region", () => {
    const frame = liveStageFrame(940, 714);
    const { hud, keyPressOverlay } = calculateAnalysisStageLayout({ x: 0, y: 0, width: 510, height: 75 }, frame);
    expect(hud.combo.x).toBeCloseTo(frame.regionLeft);
    expect(hud.hitErrorBar.x).toBeCloseTo(frame.regionLeft + (frame.width - frame.regionLeft) / 2);
    expect(hud.accuracy.x).toBeCloseTo(frame.width - 15);
    expect(keyPressOverlay?.left).toBeGreaterThanOrEqual(frame.regionLeft);
  });

  it("reserves nothing when the region left of the playfield would be under 320 px wide (400 × 600)", () => {
    const frame = liveStageFrame(400, 600);
    expect(frame.regionLeft).toBe(0);
    expect(liveStatsOverlayFits(400, 600)).toBe(false);
  });

  it("switches exactly at a 320 px remaining region (460 wide fits, 459 does not)", () => {
    expect(liveStatsOverlayFits(460, 600)).toBe(true);
    // The deficit would shift by 248 px, but the region may not drop below 320 px: the shift is capped at 140 px.
    expect(liveStageFrame(460, 600).regionLeft).toBeCloseTo((LIVE_STATS_RESERVE_PX * STAGE_FRAME_HEIGHT) / 600, 6);
    expect(livePlayfieldPx(460, 600).regionWidthPx).toBeCloseTo(LIVE_STATS_MIN_REGION_PX, 6);
    expect(livePlayfieldPx(460, 600).left).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX);
    expect(liveStatsOverlayFits(459, 600)).toBe(false);
    expect(liveStageFrame(459, 600).regionLeft).toBe(0);
  });

  it("falls back to a 16:9 frame without a reserve for an invalid size", () => {
    for (const [w, h] of [
      [Number.NaN, 600],
      [800, Number.NaN],
      [0, 600],
      [800, 0],
      [-1, 600],
      [800, -5],
      [Number.POSITIVE_INFINITY, 600],
      [800, Number.POSITIVE_INFINITY],
    ] as const) {
      const frame = liveStageFrame(w, h);
      expect(frame.width).toBeCloseTo(1600);
      expect(frame.height).toBe(STAGE_FRAME_HEIGHT);
      expect(frame.regionLeft).toBe(0);
      expect(liveStatsOverlayFits(w, h)).toBe(false);
    }
  });
});

describe("the reserve is continuous in the stage size", () => {
  it.each([400, 500, 600, 634, 696, 714, 814, 900, 994])(
    "at height %i the playfield's left edge moves at most 1 px per px of width and never sits under 140 px while the overlay is shown",
    (heightPx) => {
      let previous: number | undefined;
      let reserved = 0;
      for (let widthPx = 460; widthPx <= 2600; widthPx += 1) {
        const { left } = livePlayfieldPx(widthPx, heightPx);
        expect(left).toBeGreaterThanOrEqual(LIVE_STATS_RESERVE_PX - 1e-6);
        if (previous !== undefined) expect(Math.abs(left - previous)).toBeLessThanOrEqual(1 + 1e-6);
        if (liveStageFrame(widthPx, heightPx).regionLeft > 0) reserved += 1;
        previous = left;
      }
      // The sweep really crosses the threshold: part of it reserves, part of it does not.
      expect(reserved).toBeGreaterThan(0);
      expect(reserved).toBeLessThan(2141);
    },
  );

  it("moves the playfield by under 1 px across the old 70 px jump (height 700, width 1040 to 1041)", () => {
    const a = livePlayfieldPx(1040, 700).left;
    const b = livePlayfieldPx(1041, 700).left;
    expect(Math.abs(a - b)).toBeLessThan(1.01);
  });
});

describe("liveStatsOverlayFits", () => {
  it("is false below a 320 px remaining region and for an invalid size", () => {
    expect(liveStatsOverlayFits(459, 600)).toBe(false);
    expect(liveStatsOverlayFits(100, 600)).toBe(false);
    expect(liveStatsOverlayFits(Number.NaN, 600)).toBe(false);
    expect(liveStatsOverlayFits(800, 0)).toBe(false);
  });

  it("is true wherever the remaining region is at least 320 px wide", () => {
    expect(liveStatsOverlayFits(1100, 814)).toBe(true);
    expect(liveStatsOverlayFits(940, 634)).toBe(true);
    expect(liveStatsOverlayFits(1920, 1080)).toBe(true);
  });
});

describe("the export frame is the live stage at 16:9", () => {
  it("exports the live stage's 16:9 frame", () => {
    expect(sameStageFrame(EXPORT_STAGE_FRAME, liveStageFrame(1600, 900))).toBe(true);
  });

  it("is the 1600 × 900 frame with the live playfield ratio and no left reserve", () => {
    expect(EXPORT_STAGE_FRAME).toEqual({
      width: 1600,
      height: 900,
      regionLeft: 0,
      playfieldHeightRatio: 0.815,
      overlaySideInset: 220,
      overlayTopMargin: 6,
      overlayPlayfieldGap: 3,
    });
  });
});
