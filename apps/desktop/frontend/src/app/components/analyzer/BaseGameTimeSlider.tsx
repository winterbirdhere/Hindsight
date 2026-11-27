import { Box, ButtonBase, styled } from "@mui/material";
import { formatGameTime } from "@osujs/math";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Chart, registerables } from "chart.js";
import { ReplaySeekSlider, type ReplaySeekSliderProps } from "./ReplaySeekSlider";
import {
  calculatePlaybarMarkerBounds,
  PLAYBAR_EVENT_CANVAS_HEIGHT,
  playbarMarkerLeftIn,
  type PlaybarMarkerPlacement,
} from "./playbar-marker-layout";
import type { TimelineSection } from "../../services/common/timeline-section";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

//
Chart.register(...registerables);

type EventType = {
  timings: number[];
  tooltip: string;
  color: string;
  markerWidth?: number;
  markerHeight?: number;
  placement?: PlaybarMarkerPlacement;
  opacity?: number;
};

function observeDevicePixelRatio(onChange: () => void) {
  let mediaQuery: MediaQueryList;

  const subscribe = () => {
    mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mediaQuery.addEventListener("change", handleChange);
  };
  const handleChange = () => {
    mediaQuery.removeEventListener("change", handleChange);
    onChange();
    subscribe();
  };

  subscribe();
  return () => mediaQuery.removeEventListener("change", handleChange);
}

export interface BaseGameTimeSliderProps extends ReplaySeekSliderProps {
  backgroundEnable?: boolean;

  events: EventType[];
  difficulties: number[];
  disabled?: boolean;
  /** The stretch of the map the lane shows instead of the whole map. */
  section?: TimelineSection;
  /** When each note starts and ends: a faint tick each, in a section only. */
  noteTimes?: readonly number[];
  /** A right-click on the lane: the time under the pointer, and how many milliseconds a few pixels are. */
  onSectionAt?: (timeMs: number, nearMs: number) => void;
  /** A right-drag across the lane: the two times it went between. */
  onSectionDrag?: (fromMs: number, toMs: number) => void;
  /** The longest stretch a right-drag may choose: the band that follows the drag stops there. */
  sectionDragLimitMs?: number;
  /** Alt and the wheel over the lane: how many times as long the lane's stretch should be, around which time. */
  onSectionZoom?: (factor: number, anchorMs: number) => void;
  /** The `Full map` button. */
  onSectionExit?: () => void;
}

// Less movement than this between the right button going down and up is a click, not a drag.
const SECTION_DRAG_THRESHOLD_PX = 5;
// An error this near a right-click counts as pointed at.
const SECTION_NEAR_PX = 8;
// One notch of the wheel with Alt makes the lane's stretch this many times as long, or as short.
const SECTION_ZOOM_STEP = 1.25;
// Every note gets a tick in a section; they are drawn first, so an error's mark covers its own note.
const NOTE_TICK = { color: "rgb(255, 255, 255)", opacity: 0.26, markerWidth: 1, markerHeight: 5, placement: "above" as const, tooltip: "Notes" };

const sectionLabel = {
  position: "absolute",
  bottom: "5px",
  zIndex: 2,
  pointerEvents: "none",
  fontFamily: REWIND_FONTS.mono,
  fontSize: 10.5,
  lineHeight: 1,
  fontVariantNumeric: "tabular-nums",
  color: REWIND_COLORS.textTertiary,
  textShadow: `0 0 3px ${REWIND_COLORS.dock}, 0 0 3px ${REWIND_COLORS.dock}`,
} as const;

function drawPlaybarEvents(canvas: HTMLCanvasElement, eventTypes: EventType[], view: TimelineSection) {
  const resizeAndRender = () => {
    const width = Math.max(1, canvas.parentElement?.clientWidth ?? canvas.clientWidth);
    const height = PLAYBAR_EVENT_CANVAS_HEIGHT;
    const resolution = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * resolution);
    canvas.height = Math.round(height * resolution);
    canvas.style.width = "100%";
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(resolution, 0, 0, resolution, 0, 0);
    context.clearRect(0, 0, width, height);
    const eventLineHeight = height / Math.max(1, eventTypes.length);
    eventTypes.forEach((eventType, index) => {
      context.fillStyle = eventType.color;
      context.globalAlpha = eventType.opacity ?? 0.7;
      const markerWidth = Math.min(width, Math.max(0.5, eventType.markerWidth ?? 1));
      const requestedHeight = Math.min(height, eventType.markerHeight ?? eventLineHeight);
      const markerBounds = eventType.placement
        ? calculatePlaybarMarkerBounds(eventType.placement, requestedHeight)
        : { top: index * eventLineHeight, height: requestedHeight };
      for (const timing of eventType.timings) {
        // A lane that shows a stretch of the map has only that stretch's marks.
        if (timing < view.startMs || timing > view.endMs) continue;
        context.fillRect(
          playbarMarkerLeftIn(timing, view, width, markerWidth),
          markerBounds.top,
          markerWidth,
          markerBounds.height,
        );
      }
    });
    context.globalAlpha = 1;
  };

  const destroy = () => {
    const context = canvas.getContext("2d");
    if (context) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  resizeAndRender();
  return { destroy, resizeAndRender };
}

const PlaybarEventsCanvas = styled("canvas")`
  //background: aqua;
  position: absolute;
  height: ${PLAYBAR_EVENT_CANVAS_HEIGHT}px;
  width: 100%;
  top: 0;
  left: 0;
  z-index: 2;
  pointer-events: none;
`;

const DifficultyCanvas = styled("canvas")`
  //position: absolute;
  //top: 0;
  //left: 0;
  //transform: translate(0, -100%);
  //background: aqua;
`;

function drawDifficulty(canvas: HTMLCanvasElement, data: number[]) {
  const chart = new Chart(canvas, {
    type: "line",
    options: {
      animation: false,
      maintainAspectRatio: false,
      elements: { point: { radius: 0 } },
      scales: { x: { display: false }, y: { display: false } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    },
    data: {
      labels: data.map(() => ""),
      datasets: [{ data, fill: true, borderWidth: 0, backgroundColor: "rgba(255, 255, 255, 0.08)", tension: 0.5 }],
    },
  });
  chart.draw();
  return chart;
}

export function BaseGameTimeSlider(props: BaseGameTimeSliderProps) {
  const { duration, currentTime, playback, playbackRate = 1, onChange, events, difficulties, disabled } = props;
  const { section, noteTimes, onSectionAt, onSectionDrag, onSectionZoom, onSectionExit, sectionDragLimitMs } = props;

  const lane = useRef<HTMLDivElement | null>(null);
  const eventsCanvas = useRef<HTMLCanvasElement | null>(null);
  const difficultyCanvas = useRef<HTMLCanvasElement | null>(null);

  // What the lane spans: the section, or the whole map.
  const viewStart = section ? section.startMs : 0;
  const viewEnd = section ? section.endMs : duration;
  const drawnEvents = useMemo(
    () => (section && noteTimes && noteTimes.length > 0 ? [{ ...NOTE_TICK, timings: noteTimes as number[] }, ...events] : events),
    [section, noteTimes, events],
  );
  // The difficulty graph has one value per equal slice of the map: a section shows its own slices.
  const drawnDifficulties = useMemo(() => {
    if (!section || !(duration > 0) || difficulties.length === 0) return difficulties;
    const from = Math.floor((section.startMs / duration) * difficulties.length);
    const to = Math.ceil((section.endMs / duration) * difficulties.length);
    return difficulties.slice(Math.max(0, from), Math.max(from + 1, to));
  }, [section, duration, difficulties]);

  useEffect(() => {
    const canvas = eventsCanvas.current;
    if (!canvas) return;

    const drawing = drawPlaybarEvents(canvas, drawnEvents, { startMs: viewStart, endMs: viewEnd });
    const resizeObserver = new ResizeObserver(drawing.resizeAndRender);
    const container = canvas.parentElement;
    if (container) resizeObserver.observe(container);
    const stopObservingDevicePixelRatio = observeDevicePixelRatio(drawing.resizeAndRender);

    return () => {
      resizeObserver.disconnect();
      stopObservingDevicePixelRatio();
      drawing.destroy();
    };
  }, [drawnEvents, viewStart, viewEnd]);

  /** The map time under a pointer position on the lane. */
  const timeAt = useCallback(
    (clientX: number) => {
      const rect = lane.current?.getBoundingClientRect();
      const across = rect && rect.width > 0 ? Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) : 0;
      return viewStart + across * (viewEnd - viewStart);
    },
    [viewStart, viewEnd],
  );

  // The right button picks what the lane shows: a click the default section there, a drag that stretch.
  const pickable = !disabled && onSectionAt !== undefined && onSectionDrag !== undefined;
  const [picking, setPicking] = useState<{ from: number; to: number } | undefined>(undefined);
  const endPicking = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => endPicking.current?.(), []);
  const onMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 2 || !pickable || !lane.current) return;
    event.preventDefault();
    const rect = lane.current.getBoundingClientRect();
    const startX = event.clientX;
    const inLane = (clientX: number) => Math.min(Math.max(clientX - rect.left, 0), rect.width);
    // The band shows what the drag will choose, so it stops at the longest stretch.
    const limitPx = sectionDragLimitMs !== undefined && viewEnd > viewStart ? (sectionDragLimitMs / (viewEnd - viewStart)) * rect.width : Infinity;
    const move = (moved: MouseEvent) => {
      const from = inLane(startX);
      const to = inLane(moved.clientX);
      setPicking({ from, to: from + Math.sign(to - from) * Math.min(Math.abs(to - from), limitPx) });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      endPicking.current = undefined;
      setPicking(undefined);
    };
    const up = (released: MouseEvent) => {
      stop();
      if (Math.abs(released.clientX - startX) < SECTION_DRAG_THRESHOLD_PX)
        onSectionAt?.(timeAt(startX), (SECTION_NEAR_PX / Math.max(1, rect.width)) * (viewEnd - viewStart));
      else onSectionDrag?.(timeAt(startX), timeAt(released.clientX));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    endPicking.current = stop;
  };

  // Alt and the wheel make the lane's stretch longer or shorter, as they do the key overlay's.
  useEffect(() => {
    const element = lane.current;
    if (!element || disabled || !onSectionZoom) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.altKey) return;
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      onSectionZoom(delta > 0 ? SECTION_ZOOM_STEP : 1 / SECTION_ZOOM_STEP, timeAt(event.clientX));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [disabled, onSectionZoom, timeAt]);

  useEffect(() => {
    const canvas = difficultyCanvas.current;
    if (!canvas) return;

    const chart = drawDifficulty(canvas, drawnDifficulties);
    return () => {
      chart.destroy();
    };
  }, [difficultyCanvas, drawnDifficulties]);

  return (
    <Box
      ref={lane}
      onMouseDown={onMouseDown}
      onContextMenu={(event) => {
        if (pickable) event.preventDefault();
      }}
      sx={{ position: "relative", width: "100%", height: PLAYBAR_EVENT_CANVAS_HEIGHT }}
    >
      <Box sx={{ position: "absolute", left: 0, top: "6px", width: "100%", height: "18px", pointerEvents: "none" }}>
        <DifficultyCanvas ref={difficultyCanvas} />
      </Box>
      <PlaybarEventsCanvas ref={eventsCanvas} />
      <ReplaySeekSlider
        duration={duration}
        currentTime={currentTime}
        playback={playback}
        playbackRate={playbackRate}
        onChange={onChange}
        disabled={disabled}
        range={section}
      />
      {picking && (
        <Box
          aria-hidden
          data-testid="timeline-section-pick"
          style={{ left: Math.min(picking.from, picking.to), width: Math.abs(picking.to - picking.from) }}
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            zIndex: 4,
            pointerEvents: "none",
            backgroundColor: "rgba(245, 244, 241, 0.1)",
            boxShadow: "inset 1px 0 0 rgba(245, 244, 241, 0.5), inset -1px 0 0 rgba(245, 244, 241, 0.5)",
          }}
        />
      )}
      {section && (
        <>
          <Box component="span" data-testid="timeline-section-start" sx={{ ...sectionLabel, left: 0 }}>
            {formatGameTime(section.startMs)}
          </Box>
          <Box component="span" data-testid="timeline-section-end" sx={{ ...sectionLabel, right: 0 }}>
            {formatGameTime(section.endMs)}
          </Box>
          {/* The whole map as a line along the lane's bottom edge, with the stretch the lane shows lit. */}
          <Box
            aria-hidden
            data-testid="timeline-coverage"
            sx={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "2px", zIndex: 2, pointerEvents: "none", backgroundColor: "rgba(255, 255, 255, 0.08)" }}
          >
            <Box
              data-testid="timeline-coverage-section"
              style={{
                left: `${(section.startMs / Math.max(1, duration)) * 100}%`,
                width: `${((section.endMs - section.startMs) / Math.max(1, duration)) * 100}%`,
              }}
              sx={{ position: "absolute", top: 0, bottom: 0, minWidth: "2px", backgroundColor: "rgba(245, 244, 241, 0.55)" }}
            />
          </Box>
          {onSectionExit && (
            <ButtonBase
              onClick={onSectionExit}
              title="Back to the whole map (Esc)"
              sx={{
                position: "absolute",
                top: 0,
                right: 0,
                zIndex: 4,
                padding: "2px 6px",
                borderRadius: "4px",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 500,
                lineHeight: 1.2,
                color: REWIND_COLORS.textSecondary,
                backgroundColor: REWIND_COLORS.dock,
                "&:hover": { color: "#fff" },
              }}
            >
              Full map
            </ButtonBase>
          )}
        </>
      )}
    </Box>
  );
}
