import { REWIND_LAYOUT } from "../../styles/tokens";
import { clampInspectorWidth, INSPECTOR_WIDTH_LIMITS } from "../../services/analysis/inspector-layout-settings";
import { calculateAnalysisStageLayout } from "../../services/renderers/components/stage/AnalysisStageLayout";
import {
  LIVE_PLAYFIELD_HEIGHT_RATIO,
  liveStageFrame,
  liveStatsOverlayFits,
  STAGE_FRAME_HEIGHT,
} from "../../services/renderers/components/stage/stage-frame";

/**
 * Where the stats overlay sits on the stage; `gap` is the clearance kept to the playfield. `left + width + gap` is
 * `LIVE_STATS_RESERVE_PX`, the strip the live stage keeps free for it (asserted in the spec).
 */
export const STATS_OVERLAY = { left: 16, top: 44, width: 118, gap: 6 } as const;

export interface AnalyzerLayout {
  /** Whether the window has room for a column; a hidden column is still "column" and simply gives the stage the width. */
  inspector: "column" | "drawer";
  /** The chosen width limited to this window (spec §5.9 D); the column's, or the overlay drawer's, width. */
  inspectorWidth: number;
  stageWidth: number;
  stageHeight: number;
  /** False only when the stage is too narrow to leave 320 px beside the 140 px the overlay reserves. */
  statsOverlay: boolean;
}

/** Left edge of the real playfield rect inside a stage of this size, in CSS px. */
export function playfieldLeftPx(stageWidth: number, stageHeight: number): number {
  if (stageWidth <= 0 || stageHeight <= 0) return 0;
  const { playfield } = calculateAnalysisStageLayout(
    { x: 0, y: 0, width: 0, height: 0 },
    liveStageFrame(stageWidth, stageHeight),
  );
  return (playfield.left * stageHeight) / STAGE_FRAME_HEIGHT;
}

/** The playfield height the stage is wanted to show: the live ratio of the stage height (dock excluded). */
function wantedPlayfieldHeight(height: number): number {
  return LIVE_PLAYFIELD_HEIGHT_RATIO * Math.max(0, height - REWIND_LAYOUT.dockHeight);
}

/** Playfield height (CSS px) the real live frame draws in a stage of this size, stats reserve included. */
function livePlayfieldHeightPx(stageWidth: number, stageHeight: number): number {
  const { playfield } = calculateAnalysisStageLayout(
    { x: 0, y: 0, width: 0, height: 0 },
    liveStageFrame(stageWidth, stageHeight),
  );
  return (playfield.height * stageHeight) / STAGE_FRAME_HEIGHT;
}

/** Sub-pixel slack for the comparison with the wanted height (floating point and the 1 px width steps). */
const PLAYFIELD_HEIGHT_TOLERANCE_PX = 0.5;

/**
 * The fold test, shared by the layout and by the widest width the column can take: with the stage `width -
 * inspectorWidth` wide, the playfield the live frame really draws (stats reserve included) is at least as high as
 * wanted.
 */
function keepsColumn(width: number, height: number, inspectorWidth: number): boolean {
  const stageWidth = width - inspectorWidth;
  const stageHeight = Math.max(0, height - REWIND_LAYOUT.dockHeight);
  if (stageWidth <= 0) return false;
  return livePlayfieldHeightPx(stageWidth, stageHeight) >= wantedPlayfieldHeight(height) - PLAYFIELD_HEIGHT_TOLERANCE_PX;
}

/**
 * The widest inspector (px) that still leaves the column for this window, exactly: the largest width for which
 * `keepsColumn` holds (0 when none does). The layout itself does not limit the width by this; the resize separator
 * does, so that dragging or stepping never folds the column into the drawer.
 */
export function maxColumnInspectorWidth(width: number, height: number): number {
  // The playfield is never narrower than the 4:3 of its wanted height, so no wider inspector can keep the column.
  let widest = Math.floor(width - wantedPlayfieldHeight(height) / 0.75);
  while (widest > 0 && !keepsColumn(width, height, widest)) widest -= 1;
  return widest;
}

/**
 * The inspector never shrinks the playfield below what the height allows, measured on the frame that is really drawn
 * (stats reserve included). A width that no longer keeps that playfield shrinks to the widest that does (without
 * touching the stored preference); only when even the 240 px minimum does not fit does it fold into a drawer. In the
 * drawer and with the column hidden the stage is the full window width, and the playfield only shrinks there if the
 * window itself is too narrow. `inspectorWidth` is the user's width (limited here to the window); `visible` only matters for
 * the column.
 */
export function calculateAnalyzerLayout(
  width: number,
  height: number,
  inspectorWidth: number = REWIND_LAYOUT.inspectorWidth,
  visible = true,
): AnalyzerLayout {
  const stageHeight = Math.max(0, height - REWIND_LAYOUT.dockHeight);
  const clamped = clampInspectorWidth(inspectorWidth, width);
  const widest = keepsColumn(width, height, clamped) ? clamped : maxColumnInspectorWidth(width, height);
  const column = widest >= INSPECTOR_WIDTH_LIMITS.min;
  const shownWidth = column ? Math.min(clamped, widest) : clamped;
  const stageWidth = Math.max(0, column && visible ? width - shownWidth : width);
  return {
    inspector: column ? "column" : "drawer",
    inspectorWidth: shownWidth,
    stageWidth,
    stageHeight,
    statsOverlay: liveStatsOverlayFits(stageWidth, stageHeight),
  };
}
