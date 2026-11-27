import { OSU_PLAYFIELD_HEIGHT, OSU_PLAYFIELD_WIDTH } from "@osujs/core";

/** A virtual stage the playfield, HUD and key overlay are laid out in. Height is always 900 units. */
export interface StageFrame {
  readonly width: number;
  readonly height: number;
  /** Left edge of the region the playfield/HUD centre in (non-zero when the live stats column needs the room). */
  readonly regionLeft: number;
  readonly playfieldHeightRatio: number;
  readonly overlaySideInset: number;
  readonly overlayTopMargin: number;
  readonly overlayPlayfieldGap: number;
}

export const STAGE_FRAME_HEIGHT = 900;
export const LIVE_PLAYFIELD_HEIGHT_RATIO = 0.815;
/** Clear space kept left and right of the playfield inside its region, in frame units. */
export const PLAYFIELD_SIDE_MARGIN = 24;
/** CSS px the live stage reserves on the left for the stats overlay (left offset 16 + width 118 + clearance 6). */
export const LIVE_STATS_RESERVE_PX = 140;
/** The stats overlay is hidden, and nothing reserved, when the stage minus the reserve is narrower than this (CSS px). */
export const LIVE_STATS_MIN_REGION_PX = 320;

/**
 * One export frame, equal to the live stage at 16:9 (`liveStageFrame(1600, 900)`): the playfield at the live ratio,
 * centred, clear of the 140-px stats column the clip draws on its left.
 */
export const EXPORT_STAGE_FRAME: StageFrame = Object.freeze({
  width: 1600,
  height: STAGE_FRAME_HEIGHT,
  regionLeft: 0,
  playfieldHeightRatio: LIVE_PLAYFIELD_HEIGHT_RATIO,
  overlaySideInset: 220,
  overlayTopMargin: 6,
  overlayPlayfieldGap: 3,
});

const isValidSize = (widthPx: number, heightPx: number) =>
  Number.isFinite(widthPx) && Number.isFinite(heightPx) && widthPx > 0 && heightPx > 0;

/** Whether the stats overlay fits left of the playfield in a live stage of this CSS-px size. */
export function liveStatsOverlayFits(widthPx: number, heightPx: number): boolean {
  return isValidSize(widthPx, heightPx) && widthPx - LIVE_STATS_RESERVE_PX >= LIVE_STATS_MIN_REGION_PX;
}

/** Left edge (CSS px) of the playfield when it is centred in the whole stage with no reserve. */
function centredPlayfieldLeftPx(widthPx: number, heightPx: number): number {
  const frameWidth = (STAGE_FRAME_HEIGHT * widthPx) / heightPx;
  const scale = Math.max(
    0,
    Math.min(
      (STAGE_FRAME_HEIGHT * LIVE_PLAYFIELD_HEIGHT_RATIO) / OSU_PLAYFIELD_HEIGHT,
      (frameWidth - PLAYFIELD_SIDE_MARGIN * 2) / OSU_PLAYFIELD_WIDTH,
    ),
  );
  return (((frameWidth - OSU_PLAYFIELD_WIDTH * scale) / 2) * heightPx) / STAGE_FRAME_HEIGHT;
}

/**
 * The live stage fills the analyzer's centre cell (`widthPx` x `heightPx`, CSS px). The playfield is centred in the
 * cell while that leaves the stats overlay its 140 px. Otherwise the region the playfield centres in starts
 * `2 x (140 - centredLeft)` px from the left, which puts the playfield's left edge at exactly 140 px: it moves
 * continuously with the stage size, and only shrinks once the remaining region is too narrow for it. The region is
 * never narrower than 320 px; a stage with no room for that reserves nothing. An invalid size falls back to 16:9
 * with no reserve.
 */
export function liveStageFrame(widthPx: number, heightPx: number): StageFrame {
  const valid = isValidSize(widthPx, heightPx);
  const deficitPx = valid && liveStatsOverlayFits(widthPx, heightPx) ? LIVE_STATS_RESERVE_PX - centredPlayfieldLeftPx(widthPx, heightPx) : 0;
  const regionLeftPx = deficitPx > 0 ? Math.min(2 * deficitPx, widthPx - LIVE_STATS_MIN_REGION_PX) : 0;
  return {
    width: valid ? (STAGE_FRAME_HEIGHT * widthPx) / heightPx : (STAGE_FRAME_HEIGHT * 16) / 9,
    height: STAGE_FRAME_HEIGHT,
    regionLeft: regionLeftPx > 0 ? (regionLeftPx * STAGE_FRAME_HEIGHT) / heightPx : 0,
    playfieldHeightRatio: LIVE_PLAYFIELD_HEIGHT_RATIO,
    overlaySideInset: 220,
    overlayTopMargin: 6,
    overlayPlayfieldGap: 3,
  };
}

export function sameStageFrame(a: StageFrame | undefined, b: StageFrame): boolean {
  if (!a) return false;
  return (Object.keys(b) as (keyof StageFrame)[]).every((key) => Math.abs(a[key] - b[key]) < 1e-6);
}
