import { OSU_PLAYFIELD_HEIGHT, OSU_PLAYFIELD_WIDTH } from "@osujs/core";
import { EXPORT_STAGE_FRAME, PLAYFIELD_SIDE_MARGIN, type StageFrame } from "./stage-frame";

export interface LocalBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StagePoint {
  x: number;
  y: number;
}

export interface HudAnchors {
  accuracy: StagePoint;
  combo: StagePoint;
  hitErrorBar: StagePoint;
}

export interface AnalysisStageLayout {
  playfield: { left: number; top: number; width: number; height: number; scale: number };
  keyPressOverlay?: {
    positionX: number;
    positionY: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    scale: number;
  };
  hud: HudAnchors;
}

export function calculateAnalysisStageLayout(
  overlayBounds: LocalBounds,
  frame: StageFrame = EXPORT_STAGE_FRAME,
): AnalysisStageLayout {
  const regionWidth = frame.width - frame.regionLeft;
  const playfieldScale = Math.max(
    0,
    Math.min(
      (frame.height * frame.playfieldHeightRatio) / OSU_PLAYFIELD_HEIGHT,
      (regionWidth - PLAYFIELD_SIDE_MARGIN * 2) / OSU_PLAYFIELD_WIDTH,
    ),
  );
  const playfieldWidth = OSU_PLAYFIELD_WIDTH * playfieldScale;
  const playfieldHeight = OSU_PLAYFIELD_HEIGHT * playfieldScale;
  const playfieldLeft = frame.regionLeft + (regionWidth - playfieldWidth) / 2;
  const playfieldTop = (frame.height - playfieldHeight) / 2;
  const playfield = {
    left: playfieldLeft,
    top: playfieldTop,
    width: playfieldWidth,
    height: playfieldHeight,
    scale: playfieldScale,
  };
  const hud: HudAnchors = {
    accuracy: { x: frame.width - 15, y: 25 },
    combo: { x: frame.regionLeft, y: frame.height - 50 },
    hitErrorBar: { x: frame.regionLeft + regionWidth / 2, y: frame.height - 20 },
  };

  if (overlayBounds.width <= 0 || overlayBounds.height <= 0) return { playfield, hud };

  const availableOverlayWidth = Math.max(0, Math.min(playfieldWidth, regionWidth - frame.overlaySideInset * 2));
  const availableOverlayHeight = Math.max(0, playfieldTop - frame.overlayTopMargin - frame.overlayPlayfieldGap);
  const overlayScale = Math.min(
    availableOverlayWidth / overlayBounds.width,
    availableOverlayHeight / overlayBounds.height,
  );
  const overlayWidth = overlayBounds.width * overlayScale;
  const overlayHeight = overlayBounds.height * overlayScale;
  const overlayLeft = frame.regionLeft + (regionWidth - overlayWidth) / 2;
  const overlayTop = frame.overlayTopMargin;

  return {
    playfield,
    hud,
    keyPressOverlay: {
      positionX: overlayLeft - overlayBounds.x * overlayScale,
      positionY: overlayTop - overlayBounds.y * overlayScale,
      left: overlayLeft,
      top: overlayTop,
      right: overlayLeft + overlayWidth,
      bottom: overlayTop + overlayHeight,
      scale: overlayScale,
    },
  };
}
