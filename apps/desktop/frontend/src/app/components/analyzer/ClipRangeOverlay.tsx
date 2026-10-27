import { Box } from "@mui/material";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { MIN_CLIP_DURATION_MS } from "../../services/manager/clip-export-types";
import {
  formatClipTime,
  laneFraction,
  laneTime,
  withClipEnd,
  withClipStart,
  type ClipRange,
} from "../../services/manager/clip-range";
import { REWIND_COLORS, REWIND_FOCUS_RING } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";

const DIM = "rgba(26, 27, 32, 0.72)";
const EDGE_SIDE = REWIND_COLORS.accentSoft;
const EDGE_SIDE_LOCKED = "rgba(255, 156, 188, 0.5)";
const EDGE_WIDTH_PX = 10;
const KEY_STEP_MS = 100;
const KEY_STEP_SHIFT_MS = 1000;

type Edge = "start" | "end";

const dimLayerSx = {
  position: "absolute",
  top: 0,
  bottom: 0,
  zIndex: 3,
  pointerEvents: "none",
  backgroundColor: DIM,
} as const;

// The outline's vertical extent: the edge is exactly as tall, so its focus ring surrounds the whole outline.
const OUTLINE_TOP_PX = 4;
const OUTLINE_BOTTOM_PX = 2;
// The rail band (rail at y 25-27 of the 50 px lane, the seek knob and its hover ring about 16 px) belongs to the seek
// slider: the pointer parts of an edge sit above y 18 and below y 34.
const LANE_HEIGHT_PX = 50;
const RAIL_BAND_TOP_PX = 18;
const RAIL_BAND_BOTTOM_PX = 34;
const PART_ABOVE_HEIGHT_PX = RAIL_BAND_TOP_PX - OUTLINE_TOP_PX;
const PART_BELOW_HEIGHT_PX = LANE_HEIGHT_PX - OUTLINE_BOTTOM_PX - RAIL_BAND_BOTTOM_PX;

// The slider element is the keyboard and assistive-technology target and carries the focus ring; it takes no pointer.
const edgeSx = {
  position: "absolute",
  top: `${OUTLINE_TOP_PX}px`,
  bottom: `${OUTLINE_BOTTOM_PX}px`,
  width: EDGE_WIDTH_PX,
  zIndex: 4,
  backgroundColor: "transparent",
  pointerEvents: "none",
  "&:focus-visible": REWIND_FOCUS_RING,
} as const;

// The two children that take the pointer; the press must not scroll or select, so the browser's touch gestures stay out.
const edgePartSx = {
  position: "absolute",
  left: 0,
  width: "100%",
  pointerEvents: "auto",
  touchAction: "none",
} as const;

/**
 * The export range drawn over the timeline lane: everything outside it dimmed, a pink outline with thicker left and
 * right sides, and two 10 px edges that trim it by pointer or keyboard. Rendered inside the lane's relatively
 * positioned box, so percentages refer to the lane and nothing is measured until a drag. Only the edges take pointer
 * events; the seek slider underneath keeps working inside the range.
 */
export function ClipRangeOverlay({
  range,
  durationMs,
  locked,
  onChange,
}: {
  range: ClipRange;
  durationMs: number;
  locked: boolean;
  onChange(next: ClipRange): void;
}) {
  const dragging = useRef<{ edge: Edge; pointerId: number } | null>(null);

  const startPercent = laneFraction(range.startMs, durationMs) * 100;
  const endPercent = laneFraction(range.endMs, durationMs) * 100;
  const side = locked ? EDGE_SIDE_LOCKED : EDGE_SIDE;

  const move = (edge: Edge, timeMs: number) =>
    onChange(
      edge === "start" ? withClipStart(range, timeMs, durationMs) : withClipEnd(range, timeMs, durationMs),
    );

  const handlePointerDown = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (locked || (event.button !== undefined && event.button !== 0)) return;
    // The press neither takes focus nor reaches the seek slider.
    event.preventDefault();
    event.stopPropagation();
    dragging.current = { edge, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerMove = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (locked || dragging.current?.edge !== edge) return;
    // The part's parent is the slider element, whose parent is the lane.
    const lane = event.currentTarget.parentElement?.parentElement;
    if (!lane) return;
    event.stopPropagation();
    const rect = lane.getBoundingClientRect();
    move(edge, laneTime(event.clientX, rect.left, rect.width, durationMs));
  };

  const handlePointerEnd = (edge: Edge) => (event: PointerEvent<HTMLElement>) => {
    if (dragging.current?.edge !== edge) return;
    dragging.current = null;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleKeyDown = (edge: Edge) => (event: KeyboardEvent<HTMLElement>) => {
    if (locked) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Handled here; the timeline must not also seek.
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? KEY_STEP_SHIFT_MS : KEY_STEP_MS) * (event.key === "ArrowLeft" ? -1 : 1);
    move(edge, (edge === "start" ? range.startMs : range.endMs) + step);
  };

  const edgeProps = (edge: Edge) => ({
    role: "slider",
    "aria-label": edge === "start" ? "Clip start" : "Clip end",
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": edge === "start" ? 0 : Math.min(durationMs, range.startMs + MIN_CLIP_DURATION_MS),
    "aria-valuemax": edge === "start" ? Math.max(0, range.endMs - MIN_CLIP_DURATION_MS) : durationMs,
    "aria-valuenow": edge === "start" ? range.startMs : range.endMs,
    "aria-valuetext": formatClipTime(edge === "start" ? range.startMs : range.endMs),
    "aria-disabled": locked || undefined,
    tabIndex: locked ? -1 : 0,
    onKeyDown: handleKeyDown(edge),
  });

  return (
    <>
      <Box data-testid="clip-dim-before" sx={dimLayerSx} style={{ left: 0, width: `${startPercent}%` }} />
      <Box data-testid="clip-dim-after" sx={dimLayerSx} style={{ left: `${endPercent}%`, right: 0 }} />
      <Box
        data-testid="clip-outline"
        sx={{ position: "absolute", top: "4px", bottom: "2px", borderRadius: "3px", zIndex: 3, pointerEvents: "none" }}
        style={{
          left: `${startPercent}%`,
          width: `${endPercent - startPercent}%`,
          boxShadow: `inset 3px 0 0 ${side}, inset -3px 0 0 ${side}, inset 0 0 0 1px rgba(255, 122, 160, 0.55), 0 0 12px rgba(255, 84, 104, 0.12)`,
        }}
      />
      {(["start", "end"] as const).map((edge) => {
        const percent = edge === "start" ? startPercent : endPercent;
        const cursor = locked ? "default" : "ew-resize";
        const partProps = {
          sx: edgePartSx,
          onPointerDown: handlePointerDown(edge),
          onPointerMove: handlePointerMove(edge),
          onPointerUp: handlePointerEnd(edge),
          onPointerCancel: handlePointerEnd(edge),
          onMouseDown: preventPointerFocus,
        };
        return (
          <Box
            key={edge}
            {...edgeProps(edge)}
            sx={edgeSx}
            style={{ left: `calc(${percent}% - ${EDGE_WIDTH_PX / 2}px)` }}
          >
            <Box
              data-testid={`clip-edge-${edge}-top`}
              {...partProps}
              style={{ top: 0, height: PART_ABOVE_HEIGHT_PX, cursor }}
            />
            <Box
              data-testid={`clip-edge-${edge}-bottom`}
              {...partProps}
              style={{ bottom: 0, height: PART_BELOW_HEIGHT_PX, cursor }}
            />
          </Box>
        );
      })}
    </>
  );
}
