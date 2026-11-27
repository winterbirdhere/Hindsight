import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { FullMapMarks } from "../../services/analysis/full-map-analysis-view-model";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { TIMELINE_MARKS } from "./timeline-markers";

export const FULL_MAP_TIMING_COLORS = { EARLY: "#6fcadd", LATE: "#d990aa" } as const;
const CYAN = FULL_MAP_TIMING_COLORS.EARLY;
const PINK = FULL_MAP_TIMING_COLORS.LATE;
const PURPLE = "#d45cff";
const UR_TRACE = REWIND_COLORS.textPrimary;
const GRID = REWIND_COLORS.hairlineSoft;
const MUTED_TEXT = REWIND_COLORS.textTertiary;
const STRONG_TEXT = REWIND_COLORS.textPrimary;
/** The plot is a well in the page; labels around it sit on the page itself. */
const PLOT_BACKGROUND = REWIND_COLORS.inset;
const PLOT_RADIUS = 6;
const PAGE_BACKGROUND = REWIND_COLORS.surface;
/** The time labels and the value labels of the axes. */
const CHART_AXIS_FONT = 12;
const CHART_MICRO_FONT = 14;
const CHART_ANNOTATION_FONT = 14;

/** The hit windows in the colours of the Timing panel's strip. */
const DEFAULT_WINDOW_COLORS = [
  REWIND_COLORS.hitWindow300,
  REWIND_COLORS.hitWindow100,
  REWIND_COLORS.hitWindow50,
] as const;

/**
 * The lane of the map's marks under a time chart's plot: the replay timeline's rail and marks (their sizes are
 * `TIMELINE_MARKS`), with 2px of air above the tallest error and below the tallest 100 / 50.
 */
const MARKS_RAIL_HEIGHT = 2;
const MARKS_LANE_AIR = 2;
const MARKS_ABOVE_HEIGHT = Math.max(TIMELINE_MARKS.miss.height, TIMELINE_MARKS.sliderBreak.height);
const MARKS_BELOW_HEIGHT = Math.max(TIMELINE_MARKS.meh.height, TIMELINE_MARKS.ok.height);
const MARKS_LANE_HEIGHT = MARKS_LANE_AIR + MARKS_ABOVE_HEIGHT + MARKS_RAIL_HEIGHT + MARKS_BELOW_HEIGHT + MARKS_LANE_AIR;
/** The replay timeline's rail. */
const MARKS_RAIL = "rgba(255, 255, 255, 0.13)";
/** Errors stand on the rail; 100s and 50s hang under it. Taller first, shorter drawn on top, as on the timeline. */
const MARK_KINDS = [
  { kind: "miss", color: REWIND_COLORS.judgementMiss, above: true },
  { kind: "sliderBreak", color: REWIND_COLORS.sliderBreak, above: true },
  { kind: "meh", color: REWIND_COLORS.judgement50, above: false },
  { kind: "ok", color: REWIND_COLORS.judgement100, above: false },
] as const;

/**
 * The room around a time chart's plot. The value labels are on the left; the window labels and the overall value are
 * on the right (five or six characters of 12px text, 6px from the plot); the Early label and peak callout are above.
 */
const PLOT_LEFT = 80;
const PLOT_TOP = 36;
const PLOT_RIGHT_MARGIN = 56;
/** Under the plot (and its lane): the time labels, and nothing else. */
const PLOT_BOTTOM_MARGIN = 18;
/** A tick from the axis, then the time label: its text top is 6px under the axis (a 12px figure is 8.5px tall). */
const TIME_TICK_LENGTH = 4;
const TIME_LABEL_BASELINE = 14.5;
/**
 * The hit-error chart's Early and Late labels stand inside the plot's left corners (baselines this far from its top
 * and bottom edges), and the latest hit's value stands on the same baseline as Late.
 */
const EARLY_LABEL_BASELINE = 16;
const LATE_LABEL_INSET = 8;
/** A press that moved this far before its release was a drag, not a click. */
const CLICK_SLOP_PX = 4;

export interface FullMapTimingSample {
  /** Map time in milliseconds. */
  time: number;
  /** Ruleset-native hit error. Negative is Early; positive is Late. */
  offsetMs: number;
}

export interface FullMapTimingWindow {
  /** Symmetric half-window in the same timing basis as the plotted samples. */
  radiusMs: number;
  /** Optional judgement label, for example "300" or "50". */
  label?: string;
  color?: string;
}

interface ChartFrameProps {
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/** A second measure for the tooltip: what the other graph shows at the selected time. */
export interface FullMapChartCompanion {
  label: string;
  value: string;
  unit?: string;
}

interface TimeChartProps extends ChartFrameProps {
  /** The map's marks, drawn in a lane under the plot on the chart's own time scale. */
  marks?: FullMapMarks;
  /**
   * The other measure at a map time, as a second line in the tooltip. Called with the selected point's time only;
   * nothing is drawn when it returns nothing.
   */
  companion?: (timeMs: number) => FullMapChartCompanion | undefined;
  /** Called with the map time of a point that is clicked, or chosen with Enter. */
  onActivate?: (timeMs: number) => void;
}

export interface TimingOverTimeChartProps extends TimeChartProps {
  samples: readonly FullMapTimingSample[];
  /** Absolute map time of the first non-spinner object, not the first successful hit. */
  startTime?: number;
  /** Absolute map time of the chart's end in milliseconds. */
  duration: number;
  hitWindows: readonly FullMapTimingWindow[];
}

export interface FullMapHistogramBin {
  startMs: number;
  endMs: number;
  count: number;
}

export type FullMapTimingBias = "early" | "late" | "neutral" | "unavailable";

export interface TimingDistributionChartProps extends ChartFrameProps {
  /** Histogram values must already be binned from the same samples used for UR. */
  bins: readonly FullMapHistogramBin[];
  meanOffsetMs: number | null;
  standardDeviationMs: number | null;
  /** Fractions in the inclusive 0..1 range. */
  earlyRatio: number | null;
  lateRatio: number | null;
  bias: FullMapTimingBias;
}

export interface FullMapAverageUrPoint {
  time: number;
  unstableRate: number;
  sampleCount: number;
}

export interface AverageUrOverTimeChartProps extends TimeChartProps {
  points: readonly FullMapAverageUrPoint[];
  /** Fallback axis start when no valid UR points exist; otherwise the first point's map time is used. */
  startTime?: number;
  /** Absolute map time of the chart's end in milliseconds. */
  duration: number;
  overallUr: number | null;
  /** Selects rolling point-in-time UR or cumulative average UR semantics. */
  mode?: "current" | "average";
  /** Highest point in the selected series, shown as a compact numeric callout. */
  peak?: FullMapAverageUrPoint | null;
}

export interface MetricSparklineProps extends ChartFrameProps {
  /** Values should be real samples or deterministic, pre-binned aggregates. */
  values: readonly number[];
  color?: string;
  /** Optional zero/reference line included in the plotted range. */
  baseline?: number;
}

export interface MetricSparkBarsProps extends ChartFrameProps {
  /** Values should be real samples or deterministic, pre-binned aggregates. */
  values: readonly number[];
  color?: string;
  negativeColor?: string;
}

interface Point {
  x: number;
  y: number;
}

/** One line of a chart tooltip: a left text (the time in mono, or a name), and a value with an optional unit. */
interface ChartTooltipLine {
  left: string;
  mono?: boolean;
  value: string;
  unit?: string;
}

interface ChartTooltipProps {
  id: string;
  lines: readonly ChartTooltipLine[];
  accessibleLabel: string;
  point: Point;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  color?: string;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chartTimeDomain(startTime: number, duration: number, observedEnd: number) {
  // A last object at time zero is a real endpoint, not a request to use the hit time.
  const end = isFiniteNumber(duration) && duration >= 0 ? duration : observedEnd;
  const start = isFiniteNumber(startTime) ? clamp(startTime, 0, end) : 0;
  const span = end - start;
  return {
    start,
    end,
    span,
    ticks: span > 0 ? Array.from({ length: 5 }, (_, index) => start + (span * index) / 4) : [start],
  };
}

function chartId(prefix: string, reactId: string): string {
  return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function niceCeiling(value: number): number {
  if (!isFiniteNumber(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function linePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function areaPath(points: readonly Point[], baselineY: number): string {
  if (points.length === 0) return "";
  return `${linePath(points)} L${points[points.length - 1].x.toFixed(2)},${baselineY.toFixed(2)} L${points[0].x.toFixed(
    2,
  )},${baselineY.toFixed(2)} Z`;
}

function formatTime(time: number): string {
  const totalSeconds = Math.max(0, Math.floor(time / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatSignedNumber(value: number, fractionDigits = 0): string {
  if (!isFiniteNumber(value)) return "—";
  const rounded = Math.abs(value).toFixed(fractionDigits);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${rounded}`;
}

function formatSignedMilliseconds(value: number, fractionDigits = 0): string {
  return isFiniteNumber(value) ? `${formatSignedNumber(value, fractionDigits)}ms` : "—";
}

/** What a screen reader hears of a companion line: "hit error +31.0 ms". A UR value is not followed by its unit. */
function companionSpeech(companion: FullMapChartCompanion): string {
  const unit = companion.unit && companion.unit !== "UR" ? ` ${companion.unit}` : "";
  return `, ${companion.label.toLowerCase()} ${companion.value}${unit}`;
}

function formatRatio(value: number | null): string {
  return value !== null && isFiniteNumber(value) ? `${(clamp(value, 0, 1) * 100).toFixed(1)}%` : "—";
}

function chartStyle(style: CSSProperties | undefined, minHeight: number): CSSProperties {
  return {
    display: "block",
    width: "100%",
    height: "auto",
    minHeight,
    overflow: "visible",
    ...style,
  };
}

/**
 * One SVG unit per CSS pixel keeps labels readable at every panel height. A marks lane is taken from the plot's
 * height, so what is under the plot stays where it is. Both charts use it, so their plots have the same edges.
 */
function useTimeChartFrame(laneHeight = 0) {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 1840, height: 230 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0)
        return;
      setSize((previous) =>
        Math.abs(previous.width - bounds.width) > 0.1 || Math.abs(previous.height - bounds.height) > 0.1
          ? { width: bounds.width, height: bounds.height }
          : previous,
      );
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const laneBottom = size.height - PLOT_BOTTOM_MARGIN;
  return {
    ref,
    ...size,
    plotLeft: PLOT_LEFT,
    plotRight: size.width - PLOT_RIGHT_MARGIN,
    plotTop: PLOT_TOP,
    plotBottom: laneBottom - laneHeight,
    /** Where the room under the plot begins: the plot's own bottom when there is no lane. */
    laneBottom,
  };
}

function timeChartStyle(style: CSSProperties | undefined): CSSProperties {
  return {
    ...chartStyle(undefined, 180),
    height: 230,
    fontFamily: REWIND_FONTS.ui,
    fontVariantNumeric: "tabular-nums",
    ...style,
  };
}

/**
 * Tells a click from the end of a drag, and from a tap. A tap only selects, as it always did: opening the replay
 * from a touch that meant to read a value would be a jump nobody asked for.
 */
function useChartClick() {
  const press = useRef<{ x: number; y: number; touch: boolean } | null>(null);
  return {
    notePress: (event: ReactPointerEvent<SVGSVGElement>) => {
      press.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === "touch" };
    },
    isClick: (event: ReactMouseEvent<SVGSVGElement>) => {
      const start = press.current;
      press.current = null;
      if (event.button !== 0 || start?.touch) return false;
      return !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < CLICK_SLOP_PX;
    },
  };
}

interface MapMarksLaneProps {
  marks: FullMapMarks;
  /** The chart's own time range: a mark outside it is drawn at the nearest edge. */
  timeStart: number;
  timeEnd: number;
  plotLeft: number;
  plotRight: number;
  top: number;
}

/** The replay timeline's marks on the chart's time axis. Decoration: the page's tables carry the counts. */
const MapMarksLane = memo(function MapMarksLane({
  marks,
  timeStart,
  timeEnd,
  plotLeft,
  plotRight,
  top,
}: MapMarksLaneProps) {
  const railTop = top + MARKS_LANE_AIR + MARKS_ABOVE_HEIGHT;
  const span = timeEnd - timeStart || 1;
  return (
    <g data-testid="map-marks-lane" aria-hidden="true" pointerEvents="none">
      <rect
        data-testid="map-marks-rail"
        x={plotLeft}
        y={railTop}
        width={plotRight - plotLeft}
        height={MARKS_RAIL_HEIGHT}
        fill={MARKS_RAIL}
      />
      {MARK_KINDS.map(({ kind, color, above }) => {
        const times = marks[kind];
        const { width: markWidth, height } = TIMELINE_MARKS[kind];
        // Touching the rail: errors end at its top edge, 100s and 50s start at its bottom edge.
        const y = above ? railTop - height : railTop + MARKS_RAIL_HEIGHT;
        // A map can have thousands of 100s: one path, and one box for the marks that share a pixel.
        const boxes: string[] = [];
        let count = 0;
        let previousX: number | undefined;
        for (let index = 0; index < times.length; index++) {
          const time = times[index];
          if (!isFiniteNumber(time)) continue;
          count++;
          // A graph that starts at its first measured point must not lose the misses before it.
          const x =
            Math.round(plotLeft + ((clamp(time, timeStart, timeEnd) - timeStart) / span) * (plotRight - plotLeft)) -
            markWidth / 2;
          if (x === previousX) continue;
          previousX = x;
          boxes.push(`M${x},${y}h${markWidth}v${height}h-${markWidth}z`);
        }
        return count > 0 ? (
          <path key={kind} data-testid={`map-marks-${kind}`} data-count={count} d={boxes.join("")} fill={color} />
        ) : null;
      })}
    </g>
  );
});

/** A time label hung under the axis (the lane's bottom edge, or the plot's) on a short tick. */
function TimeTick({
  x,
  axisY,
  anchor,
  label,
}: {
  x: number;
  axisY: number;
  anchor: "start" | "middle" | "end";
  label: string;
}) {
  return (
    <>
      <line
        data-testid="time-axis-tick"
        x1={x}
        y1={axisY}
        x2={x}
        y2={axisY + TIME_TICK_LENGTH}
        stroke={REWIND_COLORS.hairline}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={x}
        y={axisY + TIME_LABEL_BASELINE}
        fill={MUTED_TEXT}
        fontSize={CHART_AXIS_FONT}
        fontWeight={500}
        textAnchor={anchor}
      >
        {label}
      </text>
    </>
  );
}

function annotationAnchor(x: number, left: number, right: number): "start" | "middle" | "end" {
  if (x < left + 70) return "start";
  if (x > right - 70) return "end";
  return "middle";
}

function pointerViewBoxPoint(event: ReactMouseEvent<SVGSVGElement>, viewBoxWidth: number, viewBoxHeight: number): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.width > 0 && bounds.height > 0) {
    const scale = Math.min(bounds.width / viewBoxWidth, bounds.height / viewBoxHeight);
    const horizontalInset = (bounds.width - viewBoxWidth * scale) / 2;
    const verticalInset = (bounds.height - viewBoxHeight * scale) / 2;
    return {
      x: clamp((event.clientX - bounds.left - horizontalInset) / scale, 0, viewBoxWidth),
      y: clamp((event.clientY - bounds.top - verticalInset) / scale, 0, viewBoxHeight),
    };
  }
  return { x: event.clientX, y: event.clientY };
}

/** Only the plot, and the marks lane under it, opens the replay: not a label or a margin. */
function isOverPlot(point: Point, plotLeft: number, plotRight: number, plotTop: number, bottom: number): boolean {
  return point.x >= plotLeft && point.x <= plotRight && point.y >= plotTop && point.y <= bottom;
}

function nearestPointIndex(points: readonly Point[], x: number): number | null {
  if (points.length === 0) return null;
  let nearest = 0;
  for (let index = 1; index < points.length; index++) {
    if (Math.abs(points[index].x - x) < Math.abs(points[nearest].x - x)) nearest = index;
  }
  return nearest;
}

function keyboardPointIndex(
  event: ReactKeyboardEvent<SVGSVGElement>,
  currentIndex: number | null,
  pointCount: number,
): number | null | undefined {
  if (pointCount === 0) return null;
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowUp":
      event.preventDefault();
      return Math.max(0, (currentIndex ?? 0) - 1);
    case "ArrowRight":
    case "ArrowDown":
      event.preventDefault();
      return Math.min(pointCount - 1, (currentIndex ?? -1) + 1);
    case "Home":
      event.preventDefault();
      return 0;
    case "End":
      event.preventDefault();
      return pointCount - 1;
    case "Escape":
      event.preventDefault();
      return null;
    default:
      return undefined;
  }
}

// The tooltip is the page's hover card (see `FullMapHoverCard`) drawn in SVG. The SVG cannot be measured before it is
// drawn, so its width comes from a per-character estimate: 0.6 em for the mono time and the tabular figures, 0.56 em
// for Geist words.
const TIP_PAD_X = 11;
const TIP_PAD_TOP = 8;
const TIP_PAD_BOTTOM = 9;
const TIP_LINE = 17;
const TIP_ROW_GAP = 5;
const TIP_COLUMN_GAP = 22;
const TIP_VALUE_FONT = 13.5;
const TIP_UNIT_FONT = 11.5;
const TIP_UNIT_GAP = 3;
const TIP_EDGE = "rgba(255,255,255,0.22)";

function tooltipLineWidth(line: ChartTooltipLine): number {
  const left = line.left.length * (line.mono ? 12 * 0.6 : 12.5 * 0.56);
  const unit = line.unit ? TIP_UNIT_GAP + line.unit.length * TIP_UNIT_FONT * 0.6 : 0;
  return left + TIP_COLUMN_GAP + line.value.length * TIP_VALUE_FONT * 0.6 + unit;
}

function ChartTooltip({
  id,
  lines,
  accessibleLabel,
  point,
  plotLeft,
  plotRight,
  plotTop,
  plotBottom,
  color = UR_TRACE,
}: ChartTooltipProps) {
  const content = lines.reduce((widest, line) => Math.max(widest, tooltipLineWidth(line)), 0);
  const tooltipWidth = Math.min(content + TIP_PAD_X * 2, plotRight - plotLeft);
  const tooltipHeight = TIP_PAD_TOP + lines.length * TIP_LINE + (lines.length - 1) * TIP_ROW_GAP + TIP_PAD_BOTTOM;
  const tooltipX = clamp(point.x - tooltipWidth / 2, plotLeft, plotRight - tooltipWidth);
  const tooltipY = point.y - tooltipHeight - 12 >= plotTop ? point.y - tooltipHeight - 12 : point.y + 12;
  const lineEndY = tooltipY < point.y ? tooltipY + tooltipHeight : tooltipY;

  return (
    <g id={id} role="tooltip" aria-label={accessibleLabel} data-testid="chart-value-tooltip" pointerEvents="none">
      <line
        x1={point.x}
        y1={plotTop}
        x2={point.x}
        y2={plotBottom}
        stroke={color}
        strokeOpacity={0.2}
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1={point.x}
        y1={point.y}
        x2={point.x}
        y2={lineEndY}
        stroke={color}
        strokeOpacity={0.72}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={point.x} cy={point.y} r={3} fill={PLOT_BACKGROUND} stroke={color} strokeWidth={1.5} />
      <rect
        x={tooltipX}
        y={tooltipY}
        width={tooltipWidth}
        height={tooltipHeight}
        rx={2}
        fill={REWIND_COLORS.inset}
        stroke={TIP_EDGE}
        style={{ filter: "drop-shadow(0 6px 18px rgba(0,0,0,0.6))" }}
      />
      {lines.flatMap((line, index) => {
        const baseline = tooltipY + TIP_PAD_TOP + index * (TIP_LINE + TIP_ROW_GAP) + 13;
        return [
          <text
            key={`left-${index}`}
            x={tooltipX + TIP_PAD_X}
            y={baseline}
            fill={REWIND_COLORS.textBright}
            fontFamily={line.mono ? REWIND_FONTS.mono : REWIND_FONTS.ui}
            fontSize={line.mono ? 12 : 12.5}
            fontWeight={line.mono ? 500 : 400}
            textAnchor="start"
          >
            {line.left}
          </text>,
          <text
            key={`right-${index}`}
            x={tooltipX + tooltipWidth - TIP_PAD_X}
            y={baseline}
            fill={REWIND_COLORS.white}
            textAnchor="end"
          >
            <tspan fontSize={TIP_VALUE_FONT} fontWeight={600} fill={REWIND_COLORS.white}>
              {line.value}
            </tspan>
            {line.unit ? (
              <tspan dx={TIP_UNIT_GAP} fontSize={TIP_UNIT_FONT} fontWeight={400} fill={REWIND_COLORS.textBright}>
                {line.unit}
              </tspan>
            ) : null}
          </text>,
        ];
      })}
    </g>
  );
}

function timingSampleAnnotation(
  sample: FullMapTimingSample,
  point: Point,
  plotLeft: number,
  plotRight: number,
  plotTop: number,
  plotBottom: number,
  kind: "earliest" | "latest",
) {
  // The earliest hit's value stands above the plot. The latest hit's stands inside it, on the floor: clipped outliers
  // can cross it, so it has a halo in the plot's colour.
  const above = kind === "earliest";
  const label = formatSignedMilliseconds(sample.offsetMs);
  const y = above ? plotTop - 14 : plotBottom - LATE_LABEL_INSET;
  // A point as low as the text would be under it: the text then moves to the side of the point.
  const beside = !above && point.y >= y - CHART_ANNOTATION_FONT - 4;
  const anchor = annotationAnchor(point.x, plotLeft, plotRight);
  const textAnchor = beside && anchor === "middle" ? (point.x <= (plotLeft + plotRight) / 2 ? "start" : "end") : anchor;
  const labelWidth = label.length * CHART_ANNOTATION_FONT * 0.65;
  const leftExtent = textAnchor === "start" ? 0 : textAnchor === "middle" ? labelWidth / 2 : labelWidth;
  const rightExtent = labelWidth - leftExtent;
  const x = clamp(
    point.x + (textAnchor === "start" ? 10 : textAnchor === "end" ? -10 : 0),
    plotLeft + 60 + leftExtent,
    plotRight - rightExtent - 4,
  );
  const color = sample.offsetMs <= 0 ? CYAN : PINK;
  return (
    <g key={kind} aria-label={`${above ? "Earliest" : "Latest"} hit ${label}`}>
      <line
        x1={point.x}
        y1={point.y}
        x2={
          beside
            ? x + (textAnchor === "start" ? -3 : 3)
            : x + (textAnchor === "start" ? labelWidth / 2 : textAnchor === "end" ? -labelWidth / 2 : 0)
        }
        // Below, the leader ends at the text's top (or its side), so it never leaves the plot.
        y2={above ? y + 6 : beside ? y - 4 : y - CHART_ANNOTATION_FONT - 3}
        stroke={color}
        strokeOpacity={0.4}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={point.x} cy={point.y} r={2.5} fill={color} />
      <text
        x={x}
        y={y}
        fill={color}
        fontSize={CHART_ANNOTATION_FONT}
        fontWeight={600}
        textAnchor={textAnchor}
        paintOrder="stroke"
        stroke={above ? PAGE_BACKGROUND : PLOT_BACKGROUND}
        strokeWidth={3}
        strokeLinejoin="round"
      >
        {label}
      </text>
    </g>
  );
}

function isPlottableTimingSample(sample: FullMapTimingSample): boolean {
  return isFiniteNumber(sample.time) && sample.time >= 0 && isFiniteNumber(sample.offsetMs);
}

/** Large hit-error chart. Negative errors are intentionally plotted above zero as Early. */
export function TimingOverTimeChart({
  samples,
  startTime = 0,
  duration,
  hitWindows,
  marks,
  onActivate,
  companion,
  ariaLabel = "Timing error over time",
  className,
  style,
}: TimingOverTimeChartProps) {
  const reactId = useId();
  const lineGradientId = chartId("timing-line", reactId);
  const tooltipId = chartId("timing-tooltip", reactId);
  const plotClipId = chartId("timing-clip", reactId);
  const [selectedSampleIndex, setSelectedSampleIndex] = useState<number | null>(null);
  const click = useChartClick();

  // The lane belongs to a drawn graph: with nothing to plot the chart is its one line of text.
  const hasSamples = useMemo(() => samples.some(isPlottableTimingSample), [samples]);
  const showMarks = marks !== undefined && hasSamples;
  const { ref, width, height, plotLeft, plotRight, plotTop, plotBottom, laneBottom } = useTimeChartFrame(
    showMarks ? MARKS_LANE_HEIGHT : 0,
  );
  const windowLabelX = plotRight + 8;

  const {
    safeSamples,
    safeWindows,
    offsetRange,
    centerY,
    timeDomain,
    xForTime,
    yForOffset,
    plottedSamples,
    samplePath,
    timeTicks,
    offsetTicks,
    earliestIndex,
    latestIndex,
  } = useMemo(() => {
    const safeSamples = samples
      .filter(isPlottableTimingSample)
      .slice()
      .sort((left, right) => left.time - right.time);
    const validWindows = hitWindows
      .filter((window) => isFiniteNumber(window.radiusMs) && window.radiusMs > 0)
      .map((window) => ({ ...window, radiusMs: Math.abs(window.radiusMs) }))
      .sort((left, right) => left.radiusMs - right.radiusMs);

    const observedDuration = safeSamples.reduce((maximum, sample) => Math.max(maximum, sample.time), 0);
    const timeDomain = chartTimeDomain(startTime, duration, observedDuration);
    // Use the actual outer hit window, not a padded range or a hardcoded OD value.
    // Keep outliers in the data but clip their geometry instead of pinning them to
    // the window boundary and making them look like in-window hits.
    const outerWindow = validWindows.find((window) => window.label === "50") ?? validWindows[validWindows.length - 1];
    const offsetRange =
      outerWindow?.radiusMs ??
      Math.max(
        20,
        niceCeiling(safeSamples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample.offsetMs)), 1)),
      );
    // With nothing plotted the chart is its plot and one sentence: no bands, labels or scales for data that is not there.
    const hasData = safeSamples.length > 0;
    const safeWindows = hasData ? validWindows.filter((window) => window.radiusMs <= offsetRange) : [];
    const centerY = (plotTop + plotBottom) / 2;
    const xForTime = (time: number) =>
      plotLeft +
      ((clamp(time, timeDomain.start, timeDomain.end) - timeDomain.start) / (timeDomain.span || 1)) *
        (plotRight - plotLeft);
    const yForOffset = (offset: number) => centerY + (offset / offsetRange) * ((plotBottom - plotTop) / 2);
    const plottedSamples = safeSamples.map((sample) => ({ x: xForTime(sample.time), y: yForOffset(sample.offsetMs) }));
    const samplePath = linePath(plottedSamples);
    const timeTicks = hasData ? timeDomain.ticks : [];
    const offsetTicks = hasData ? [-offsetRange, -offsetRange / 2, 0, offsetRange / 2, offsetRange] : [];
    const earliestIndex = safeSamples.reduce<number | null>(
      (result, sample, index) =>
        Math.abs(sample.offsetMs) <= offsetRange && (result === null || sample.offsetMs < safeSamples[result].offsetMs)
          ? index
          : result,
      null,
    );
    const latestIndex = safeSamples.reduce<number | null>(
      (result, sample, index) =>
        Math.abs(sample.offsetMs) <= offsetRange && (result === null || sample.offsetMs > safeSamples[result].offsetMs)
          ? index
          : result,
      null,
    );
    return {
      safeSamples,
      safeWindows,
      offsetRange,
      centerY,
      timeDomain,
      xForTime,
      yForOffset,
      plottedSamples,
      samplePath,
      timeTicks,
      offsetTicks,
      earliestIndex,
      latestIndex,
    };
  }, [samples, hitWindows, startTime, duration, plotLeft, plotRight, plotTop, plotBottom]);
  const activeSampleIndex =
    selectedSampleIndex !== null && selectedSampleIndex < safeSamples.length ? selectedSampleIndex : null;
  const activeSample = activeSampleIndex === null ? null : safeSamples[activeSampleIndex];
  // Asked for the selected point only, and outside every memo above: a new function is not new data.
  const activeCompanion = activeSample && companion ? companion(activeSample.time) : undefined;
  const activeSamplePoint =
    activeSampleIndex === null
      ? null
      : {
          x: plottedSamples[activeSampleIndex].x,
          y: clamp(plottedSamples[activeSampleIndex].y, plotTop, plotBottom),
        };

  const selectNearestChartValue = (event: ReactPointerEvent<SVGSVGElement>) => {
    setSelectedSampleIndex(nearestPointIndex(plottedSamples, pointerViewBoxPoint(event, width, height).x));
  };
  const selectChartValueByKeyboard = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Enter" && onActivate && activeSample) {
      event.preventDefault();
      onActivate(activeSample.time);
      return;
    }
    const nextIndex = keyboardPointIndex(event, activeSampleIndex, safeSamples.length);
    if (nextIndex !== undefined) setSelectedSampleIndex(nextIndex);
  };
  // The click opens the sample the pointer selects there, the one its tooltip is showing.
  const activateNearestChartValue = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!click.isClick(event)) return;
    const pointer = pointerViewBoxPoint(event, width, height);
    if (!isOverPlot(pointer, plotLeft, plotRight, plotTop, showMarks ? plotBottom + MARKS_LANE_HEIGHT : plotBottom))
      return;
    const index = nearestPointIndex(plottedSamples, pointer.x);
    if (index !== null) onActivate?.(safeSamples[index].time);
  };

  return (
    <svg
      ref={ref}
      height={230}
      className={className}
      style={timeChartStyle(style)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      aria-describedby={activeSample ? tooltipId : undefined}
      tabIndex={safeSamples.length > 0 ? 0 : undefined}
      onFocus={() => {
        if (activeSampleIndex !== null) return;
        if (safeSamples.length > 0) setSelectedSampleIndex(0);
      }}
      onBlur={() => {
        setSelectedSampleIndex(null);
      }}
      onKeyDown={selectChartValueByKeyboard}
      onPointerDown={(event) => {
        click.notePress(event);
        selectNearestChartValue(event);
      }}
      onPointerMove={selectNearestChartValue}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") {
          setSelectedSampleIndex(null);
        }
      }}
      onClick={onActivate ? activateNearestChartValue : undefined}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <clipPath id={plotClipId}>
          <rect x={plotLeft} y={plotTop} width={plotRight - plotLeft} height={plotBottom - plotTop} rx={PLOT_RADIUS} />
        </clipPath>
        <linearGradient id={lineGradientId} x1="0" y1={plotTop} x2="0" y2={plotBottom} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={CYAN} />
          <stop offset="0.5" stopColor={CYAN} />
          <stop offset="0.5" stopColor={PINK} />
          <stop offset="1" stopColor={PINK} />
        </linearGradient>
      </defs>

      <rect
        data-testid="timing-plot-area"
        x={plotLeft}
        y={plotTop}
        width={plotRight - plotLeft}
        height={plotBottom - plotTop}
        rx={PLOT_RADIUS}
        fill={PLOT_BACKGROUND}
      />

      {/* The bands fill the plot to its edges, so they take its rounded corners. */}
      <g clipPath={`url(#${plotClipId})`}>
        {safeWindows.flatMap((window, windowIndex) => {
          const innerRadius = windowIndex === 0 ? 0 : safeWindows[windowIndex - 1].radiusMs;
          const color =
            window.color ?? DEFAULT_WINDOW_COLORS[Math.min(windowIndex, DEFAULT_WINDOW_COLORS.length - 1)] ?? CYAN;
          const fillOpacity = [0.08, 0.06, 0.045][Math.min(windowIndex, 2)];
          const earlyOuterY = yForOffset(-window.radiusMs);
          const earlyInnerY = yForOffset(-innerRadius);
          const lateInnerY = yForOffset(innerRadius);
          const lateOuterY = yForOffset(window.radiusMs);
          const bands =
            windowIndex === 0
              ? [{ side: "both", y: earlyOuterY, height: lateOuterY - earlyOuterY }]
              : [
                  { side: "early", y: earlyOuterY, height: earlyInnerY - earlyOuterY },
                  { side: "late", y: lateInnerY, height: lateOuterY - lateInnerY },
                ];
          return bands.map((band) => (
            <rect
              data-testid="timing-window-band"
              data-window-label={window.label}
              data-window-side={band.side}
              key={`${window.label ?? "window"}-${windowIndex}-${band.side}`}
              x={plotLeft}
              y={band.y}
              width={plotRight - plotLeft}
              height={Math.max(0, band.height)}
              fill={color}
              fillOpacity={fillOpacity}
              pointerEvents="none"
            />
          ));
        })}
      </g>

      {offsetTicks.map((offset) => {
        const y = yForOffset(offset);
        return (
          <g key={`offset-${offset}`}>
            {offset === 0 ? (
              <line
                x1={plotLeft}
                y1={y}
                x2={plotRight}
                y2={y}
                stroke={MUTED_TEXT}
                strokeOpacity={0.45}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <text
              x={plotLeft - 11}
              y={y + 4}
              fill={MUTED_TEXT}
              fontSize={CHART_AXIS_FONT}
              fontWeight={500}
              textAnchor="end"
            >
              {offset === 0 ? "0" : `${offset > 0 ? "+" : ""}${Number(offset.toFixed(2))}`}
            </text>
          </g>
        );
      })}

      {safeWindows.flatMap((window, windowIndex) => {
        const innerRadius = windowIndex === 0 ? 0 : safeWindows[windowIndex - 1].radiusMs;
        const color =
          window.color ?? DEFAULT_WINDOW_COLORS[Math.min(windowIndex, DEFAULT_WINDOW_COLORS.length - 1)] ?? CYAN;
        // The 300 band spans zero continuously, so it only needs one label.
        return (window.label === "300" ? [0] : [-1, 1]).map((direction) => {
          const centerOffset = direction * ((innerRadius + window.radiusMs) / 2);
          return window.label ? (
            <text
              data-testid="timing-window-label"
              key={`${window.label}-${direction}`}
              x={windowLabelX}
              y={yForOffset(centerOffset)}
              fill={color}
              fillOpacity={1}
              fontSize={CHART_MICRO_FONT}
              fontWeight={500}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {window.label}
            </text>
          ) : null;
        });
      })}

      {timeTicks.map((time, index) => (
        <TimeTick
          key={`time-${index}`}
          x={xForTime(time)}
          axisY={laneBottom}
          anchor={index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"}
          label={formatTime(time)}
        />
      ))}

      {showMarks ? (
        <MapMarksLane
          marks={marks}
          timeStart={timeDomain.start}
          timeEnd={timeDomain.end}
          plotLeft={plotLeft}
          plotRight={plotRight}
          top={plotBottom}
        />
      ) : null}

      {plottedSamples.length > 0 ? (
        <>
          <g clipPath={`url(#${plotClipId})`} data-testid="timing-clipped-series">
            <path
              data-testid="timing-sample-line"
              d={samplePath}
              fill="none"
              stroke={`url(#${lineGradientId})`}
              strokeWidth={1.25}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
          {/* In the plot's left corners, over its bands and its line. */}
          <text
            x={plotLeft + 8}
            y={plotTop + EARLY_LABEL_BASELINE}
            fill={CYAN}
            fontSize={CHART_MICRO_FONT}
            fontWeight={500}
            textAnchor="start"
            paintOrder="stroke"
            stroke={PLOT_BACKGROUND}
            strokeWidth={3}
            strokeLinejoin="round"
          >
            Early
          </text>
          <text
            x={plotLeft + 8}
            y={plotBottom - LATE_LABEL_INSET}
            fill={PINK}
            fontSize={CHART_MICRO_FONT}
            fontWeight={500}
            textAnchor="start"
            paintOrder="stroke"
            stroke={PLOT_BACKGROUND}
            strokeWidth={3}
            strokeLinejoin="round"
          >
            Late
          </text>
          {earliestIndex !== null
            ? timingSampleAnnotation(
                safeSamples[earliestIndex],
                plottedSamples[earliestIndex],
                plotLeft,
                plotRight,
                plotTop,
                plotBottom,
                "earliest",
              )
            : null}
          {latestIndex !== null && latestIndex !== earliestIndex
            ? timingSampleAnnotation(
                safeSamples[latestIndex],
                plottedSamples[latestIndex],
                plotLeft,
                plotRight,
                plotTop,
                plotBottom,
                "latest",
              )
            : null}
        </>
      ) : (
        <text x={(plotLeft + plotRight) / 2} y={centerY + 4} fill={MUTED_TEXT} fontSize={16} textAnchor="middle">
          No valid timing samples
        </text>
      )}

      <rect
        data-testid="timing-interaction-layer"
        x={plotLeft}
        y={plotTop}
        width={plotRight - plotLeft}
        height={plotBottom - plotTop}
        fill="transparent"
        pointerEvents="all"
        style={{ touchAction: "pan-y", cursor: onActivate ? "pointer" : undefined }}
      />
      {showMarks && onActivate ? (
        <rect
          data-testid="map-marks-hit-area"
          x={plotLeft}
          y={plotBottom}
          width={plotRight - plotLeft}
          height={MARKS_LANE_HEIGHT}
          fill="transparent"
          pointerEvents="all"
          style={{ touchAction: "pan-y", cursor: "pointer" }}
        />
      ) : null}
      {activeSample && activeSamplePoint ? (
        <ChartTooltip
          id={tooltipId}
          lines={[
            {
              left: formatTime(activeSample.time),
              mono: true,
              value: formatSignedNumber(activeSample.offsetMs, 1),
              unit: "ms",
            },
            ...(activeCompanion
              ? [{ left: activeCompanion.label, value: activeCompanion.value, unit: activeCompanion.unit }]
              : []),
          ]}
          accessibleLabel={`Timing error ${formatSignedMilliseconds(activeSample.offsetMs, 1)} at ${formatTime(
            activeSample.time,
          )}${Math.abs(activeSample.offsetMs) > offsetRange ? ", outside displayed hit window" : ""}${
            activeCompanion ? companionSpeech(activeCompanion) : ""
          }`}
          point={activeSamplePoint}
          plotLeft={plotLeft}
          plotRight={plotRight}
          plotTop={plotTop}
          plotBottom={plotBottom}
          color={activeSample.offsetMs <= 0 ? CYAN : PINK}
        />
      ) : null}
    </svg>
  );
}

function biasLabel(bias: FullMapTimingBias): string {
  switch (bias) {
    case "early":
      return "Early bias";
    case "late":
      return "Late bias";
    case "neutral":
      return "Centered";
    default:
      return "Unavailable";
  }
}

/** Histogram of the exact sample population used by the headline UR calculation. */
export function TimingDistributionChart({
  bins,
  meanOffsetMs,
  standardDeviationMs,
  earlyRatio,
  lateRatio,
  bias,
  ariaLabel = "Timing distribution",
  className,
  style,
}: TimingDistributionChartProps) {
  const reactId = useId();
  const cyanGlowId = chartId("distribution-cyan-glow", reactId);
  const pinkGlowId = chartId("distribution-pink-glow", reactId);
  const tooltipId = chartId("distribution-tooltip", reactId);
  const [selectedBinIndex, setSelectedBinIndex] = useState<number | null>(null);
  const width = 720;
  const height = 260;
  const plotLeft = 48;
  const plotRight = 482;
  const plotTop = 32;
  const plotBottom = 205;
  const statsLeft = 522;

  const safeBins = bins
    .filter(
      (bin) => isFiniteNumber(bin.startMs) && isFiniteNumber(bin.endMs) && isFiniteNumber(bin.count) && bin.count >= 0,
    )
    .map((bin) => ({
      startMs: Math.min(bin.startMs, bin.endMs),
      endMs: Math.max(bin.startMs, bin.endMs),
      count: bin.count,
    }))
    .sort((left, right) => left.startMs - right.startMs);
  const safeMean = meanOffsetMs !== null && isFiniteNumber(meanOffsetMs) ? meanOffsetMs : null;
  const safeDeviation =
    standardDeviationMs !== null && isFiniteNumber(standardDeviationMs) && standardDeviationMs >= 0
      ? standardDeviationMs
      : null;
  const maximumAbsoluteOffset = Math.max(
    safeBins.reduce((maximum, bin) => Math.max(maximum, Math.abs(bin.startMs), Math.abs(bin.endMs)), 1),
    safeMean === null ? 0 : Math.abs(safeMean) + (safeDeviation ?? 0),
  );
  const offsetRange = niceCeiling(maximumAbsoluteOffset);
  const countMaximum = safeBins.reduce((maximum, bin) => Math.max(maximum, bin.count), 1);
  const xForOffset = (offset: number) =>
    plotLeft + ((clamp(offset, -offsetRange, offsetRange) + offsetRange) / (offsetRange * 2)) * (plotRight - plotLeft);
  const yForCount = (count: number) =>
    plotBottom - (clamp(count, 0, countMaximum) / countMaximum) * (plotBottom - plotTop);
  const ticks = [-offsetRange, -offsetRange / 2, 0, offsetRange / 2, offsetRange];
  const deviationStart = safeMean !== null && safeDeviation !== null ? xForOffset(safeMean - safeDeviation) : null;
  const deviationEnd = safeMean !== null && safeDeviation !== null ? xForOffset(safeMean + safeDeviation) : null;
  const meanX = safeMean === null ? null : xForOffset(safeMean);
  const plottedBins = safeBins.map((bin) => ({
    x: xForOffset((bin.startMs + bin.endMs) / 2),
    y: yForCount(bin.count),
  }));
  const activeBinIndex = selectedBinIndex !== null && selectedBinIndex < safeBins.length ? selectedBinIndex : null;
  const activeBin = activeBinIndex === null ? null : safeBins[activeBinIndex];
  const activeBinPoint = activeBinIndex === null ? null : plottedBins[activeBinIndex];

  const selectNearestBin = (event: ReactPointerEvent<SVGSVGElement>) => {
    setSelectedBinIndex(nearestPointIndex(plottedBins, pointerViewBoxPoint(event, width, height).x));
  };
  const selectBinByKeyboard = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const nextIndex = keyboardPointIndex(event, activeBinIndex, safeBins.length);
    if (nextIndex !== undefined) setSelectedBinIndex(nextIndex);
  };

  return (
    <svg
      className={className}
      style={chartStyle(style, 180)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      aria-describedby={activeBin ? tooltipId : undefined}
      tabIndex={safeBins.length > 0 ? 0 : undefined}
      onFocus={() => setSelectedBinIndex((current) => (current !== null && current < safeBins.length ? current : 0))}
      onBlur={() => setSelectedBinIndex(null)}
      onKeyDown={selectBinByKeyboard}
      onPointerDown={selectNearestBin}
      onPointerMove={selectNearestBin}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setSelectedBinIndex(null);
      }}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{ariaLabel}</title>
      <defs>
        <filter id={cyanGlowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={pinkGlowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {[0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = plotBottom - ratio * (plotBottom - plotTop);
        return (
          <line
            key={ratio}
            x1={plotLeft}
            y1={y}
            x2={plotRight}
            y2={y}
            stroke={GRID}
            strokeDasharray="2 6"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      {deviationStart !== null && deviationEnd !== null ? (
        <rect
          x={Math.min(deviationStart, deviationEnd)}
          y={plotTop}
          width={Math.abs(deviationEnd - deviationStart)}
          height={plotBottom - plotTop}
          fill={PURPLE}
          opacity={0.08}
        />
      ) : null}

      {safeBins.map((bin, index) => {
        const start = xForOffset(bin.startMs);
        const end = xForOffset(bin.endMs);
        const middle = (bin.startMs + bin.endMs) / 2;
        const color = middle < 0 ? CYAN : middle > 0 ? PINK : PURPLE;
        const barY = yForCount(bin.count);
        return (
          <rect
            data-testid="timing-histogram-bin"
            key={`${bin.startMs}-${bin.endMs}-${index}`}
            x={start + 0.75}
            y={barY}
            width={Math.max(1, end - start - 1.5)}
            height={Math.max(0, plotBottom - barY)}
            rx={1.5}
            fill={color}
            fillOpacity={0.82}
            filter={`url(#${middle < 0 ? cyanGlowId : pinkGlowId})`}
          />
        );
      })}

      {safeBins.length === 0 ? (
        <text
          x={(plotLeft + plotRight) / 2}
          y={(plotTop + plotBottom) / 2}
          fill={MUTED_TEXT}
          fontSize={13}
          textAnchor="middle"
        >
          No timing distribution available
        </text>
      ) : null}

      <line
        x1={plotLeft}
        y1={plotBottom}
        x2={plotRight}
        y2={plotBottom}
        stroke="rgba(219, 230, 255, 0.45)"
        vectorEffect="non-scaling-stroke"
      />
      {ticks.map((offset) => {
        const x = xForOffset(offset);
        return (
          <g key={offset}>
            <line x1={x} y1={plotBottom} x2={x} y2={plotBottom + 5} stroke={GRID} vectorEffect="non-scaling-stroke" />
            <text x={x} y={plotBottom + 20} fill={MUTED_TEXT} fontSize={10} textAnchor="middle">
              {offset > 0 ? `+${Math.round(offset)}` : Math.round(offset)}
            </text>
          </g>
        );
      })}
      <text x={plotLeft} y={plotTop - 10} fill={CYAN} fontSize={11} textAnchor="start">
        Early
      </text>
      <text x={xForOffset(0)} y={plotTop - 10} fill={STRONG_TEXT} fontSize={11} textAnchor="middle">
        0
      </text>
      <text x={plotRight} y={plotTop - 10} fill={PINK} fontSize={11} textAnchor="end">
        Late
      </text>

      {meanX !== null ? (
        <g aria-label={`Mean timing offset ${formatSignedMilliseconds(safeMean as number, 1)}`}>
          <line
            x1={meanX}
            y1={plotTop - 3}
            x2={meanX}
            y2={plotBottom + 2}
            stroke="#f5e9ff"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={meanX} cy={plotTop - 3} r={3} fill="#f5e9ff" />
        </g>
      ) : null}

      <text x={statsLeft} y={57} fill={MUTED_TEXT} fontSize={11} letterSpacing={0.6}>
        MEAN
      </text>
      <text
        x={statsLeft}
        y={83}
        fill={safeMean !== null && safeMean < 0 ? CYAN : safeMean !== null && safeMean > 0 ? PINK : PURPLE}
        fontSize={24}
        fontWeight={500}
      >
        {safeMean === null ? "—" : formatSignedMilliseconds(safeMean, 1)}
      </text>
      <text x={statsLeft} y={104} fill={MUTED_TEXT} fontSize={11}>
        {biasLabel(bias)}
      </text>
      <text x={statsLeft} y={141} fill={MUTED_TEXT} fontSize={11} letterSpacing={0.6}>
        STD. DEVIATION
      </text>
      <text x={statsLeft} y={165} fill="#c6a7ef" fontSize={18}>
        {safeDeviation === null ? "—" : `${safeDeviation.toFixed(1)} ms`}
      </text>
      <text x={plotLeft} y={246} fill={CYAN} fontSize={11}>
        Early {formatRatio(earlyRatio)}
      </text>
      <text x={plotRight} y={246} fill={PINK} fontSize={11} textAnchor="end">
        Late {formatRatio(lateRatio)}
      </text>
      <rect
        data-testid="distribution-interaction-layer"
        x={plotLeft}
        y={plotTop}
        width={plotRight - plotLeft}
        height={plotBottom - plotTop}
        fill="transparent"
        pointerEvents="all"
        style={{ touchAction: "pan-y" }}
      />
      {activeBin && activeBinPoint ? (
        <ChartTooltip
          id={tooltipId}
          lines={[
            {
              left: formatSignedMilliseconds((activeBin.startMs + activeBin.endMs) / 2, 1),
              value: String(activeBin.count),
              unit: activeBin.count === 1 ? "hit" : "hits",
            },
          ]}
          accessibleLabel={`Timing bin ${formatSignedMilliseconds(activeBin.startMs, 1)} to ${formatSignedMilliseconds(
            activeBin.endMs,
            1,
          )}, ${activeBin.count} ${activeBin.count === 1 ? "hit" : "hits"}`}
          point={activeBinPoint}
          plotLeft={plotLeft}
          plotRight={plotRight}
          plotTop={plotTop}
          plotBottom={plotBottom}
          color={(activeBin.startMs + activeBin.endMs) / 2 < 0 ? CYAN : PINK}
        />
      ) : null}
    </svg>
  );
}

function isPlottableUrPoint(point: FullMapAverageUrPoint): boolean {
  return (
    isFiniteNumber(point.time) &&
    point.time >= 0 &&
    isFiniteNumber(point.unstableRate) &&
    point.unstableRate >= 0 &&
    isFiniteNumber(point.sampleCount) &&
    point.sampleCount >= 2
  );
}

/** Unstable-rate chart for either a rolling window or the cumulative map average. */
export function AverageUrOverTimeChart({
  points,
  startTime = 0,
  duration,
  overallUr,
  mode = "average",
  peak,
  marks,
  onActivate,
  companion,
  ariaLabel,
  className,
  style,
}: AverageUrOverTimeChartProps) {
  const isAverageMode = mode === "average";
  const resolvedAriaLabel =
    ariaLabel ?? (isAverageMode ? "Average unstable rate over time" : "Unstable rate over time");
  const seriesTestId = isAverageMode ? "average-ur" : "current-ur";
  const reactId = useId();
  const tooltipId = chartId("average-ur-tooltip", reactId);
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const click = useChartClick();
  // As in the hit-error chart: no lane under a graph that has nothing to draw.
  const hasPoints = useMemo(() => points.some(isPlottableUrPoint), [points]);
  const showMarks = marks !== undefined && hasPoints;
  const { ref, width, height, plotLeft, plotRight, plotTop, plotBottom, laneBottom } = useTimeChartFrame(
    showMarks ? MARKS_LANE_HEIGHT : 0,
  );

  const {
    safePoints,
    safeOverall,
    timeDomain,
    xForTime,
    yForUr,
    plottedPoints,
    urPath,
    urAreaPath,
    timeTicks,
    urTicks,
    safePeak,
  } = useMemo(() => {
    const safePoints = points
      .filter(isPlottableUrPoint)
      .slice()
      .sort((left, right) => left.time - right.time);
    const safeOverall = overallUr !== null && isFiniteNumber(overallUr) && overallUr >= 0 ? overallUr : null;
    const observedDuration = safePoints.reduce((maximum, point) => Math.max(maximum, point.time), 0);
    // UR needs two successful timing samples. Start at the first measured value
    // instead of leaving an unexplained gap or backfilling unmeasured UR.
    const timeDomain = chartTimeDomain(safePoints[0]?.time ?? startTime, duration, observedDuration);
    const urRange = niceCeiling(
      safePoints.reduce((maximum, point) => Math.max(maximum, point.unstableRate), Math.max(1, safeOverall ?? 0)),
    );
    const xForTime = (time: number) =>
      plotLeft +
      ((clamp(time, timeDomain.start, timeDomain.end) - timeDomain.start) / (timeDomain.span || 1)) *
        (plotRight - plotLeft);
    const yForUr = (unstableRate: number) =>
      plotBottom - (clamp(unstableRate, 0, urRange) / urRange) * (plotBottom - plotTop);
    const plottedPoints = safePoints.map((point) => ({ x: xForTime(point.time), y: yForUr(point.unstableRate) }));
    const urPath = linePath(plottedPoints);
    const urAreaPath = areaPath(plottedPoints, plotBottom);
    // With nothing plotted the chart is its plot and one sentence: no scales for data that is not there.
    const timeTicks = safePoints.length > 0 ? timeDomain.ticks : [];
    const urTicks = safePoints.length > 0 ? Array.from({ length: 5 }, (_, index) => (urRange * index) / 4) : [];
    const safePeak =
      peak &&
      isFiniteNumber(peak.time) &&
      peak.time >= 0 &&
      isFiniteNumber(peak.unstableRate) &&
      peak.unstableRate >= 0 &&
      isFiniteNumber(peak.sampleCount) &&
      peak.sampleCount >= 2
        ? peak
        : safePoints.reduce<FullMapAverageUrPoint | null>(
            (highest, point) => (highest === null || point.unstableRate > highest.unstableRate ? point : highest),
            null,
          );
    return {
      safePoints,
      safeOverall,
      timeDomain,
      xForTime,
      yForUr,
      plottedPoints,
      urPath,
      urAreaPath,
      timeTicks,
      urTicks,
      safePeak,
    };
  }, [points, overallUr, startTime, duration, peak, plotLeft, plotRight, plotTop, plotBottom]);
  const activePointIndex =
    selectedPointIndex !== null && selectedPointIndex < safePoints.length ? selectedPointIndex : null;
  const activePoint = activePointIndex === null ? null : safePoints[activePointIndex];
  const activePlottedPoint = activePointIndex === null ? null : plottedPoints[activePointIndex];
  // Asked for the selected point only, and outside every memo above: a new function is not new data.
  const activeCompanion = activePoint && companion ? companion(activePoint.time) : undefined;
  const peakPoint = safePeak ? { x: xForTime(safePeak.time), y: yForUr(safePeak.unstableRate) } : null;
  const peakLabel = safePeak?.unstableRate.toFixed(1) ?? "";
  const peakLabelHalfWidth = (peakLabel.length * CHART_ANNOTATION_FONT * 0.65) / 2;
  const peakLabelX = peakPoint
    ? clamp(peakPoint.x, plotLeft + peakLabelHalfWidth + 4, plotRight - peakLabelHalfWidth - 4)
    : 0;
  // The SVG's top margin is reserved for this callout. Clamping it inside the
  // plot pushes it onto the curve when the peak almost reaches the axis ceiling.
  const peakLabelY = plotTop - 14;

  const selectNearestAveragePoint = (event: ReactPointerEvent<SVGSVGElement>) => {
    setSelectedPointIndex(nearestPointIndex(plottedPoints, pointerViewBoxPoint(event, width, height).x));
  };
  const selectAveragePointByKeyboard = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Enter" && onActivate && activePoint) {
      event.preventDefault();
      onActivate(activePoint.time);
      return;
    }
    const nextIndex = keyboardPointIndex(event, activePointIndex, safePoints.length);
    if (nextIndex !== undefined) setSelectedPointIndex(nextIndex);
  };
  // The click opens the point the pointer selects there, the one its tooltip is showing.
  const activateNearestAveragePoint = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!click.isClick(event)) return;
    const pointer = pointerViewBoxPoint(event, width, height);
    if (!isOverPlot(pointer, plotLeft, plotRight, plotTop, showMarks ? plotBottom + MARKS_LANE_HEIGHT : plotBottom))
      return;
    const index = nearestPointIndex(plottedPoints, pointer.x);
    if (index !== null) onActivate?.(safePoints[index].time);
  };
  // Named by its value in the right margin, at the rule's height: the curve never runs through it there. The peak's
  // callout is clamped inside the plot, so it cannot reach the margin.
  const overallY = safeOverall === null ? null : yForUr(safeOverall);

  return (
    <svg
      ref={ref}
      height={230}
      className={className}
      style={timeChartStyle(style)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={resolvedAriaLabel}
      aria-describedby={activePoint ? tooltipId : undefined}
      tabIndex={safePoints.length > 0 ? 0 : undefined}
      onFocus={() =>
        setSelectedPointIndex((current) => (current !== null && current < safePoints.length ? current : 0))
      }
      onBlur={() => setSelectedPointIndex(null)}
      onKeyDown={selectAveragePointByKeyboard}
      onPointerDown={(event) => {
        click.notePress(event);
        selectNearestAveragePoint(event);
      }}
      onPointerMove={selectNearestAveragePoint}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") setSelectedPointIndex(null);
      }}
      onClick={onActivate ? activateNearestAveragePoint : undefined}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect
        data-testid={`${seriesTestId}-plot-area`}
        x={plotLeft}
        y={plotTop}
        width={plotRight - plotLeft}
        height={plotBottom - plotTop}
        rx={PLOT_RADIUS}
        fill={PLOT_BACKGROUND}
      />
      {urTicks.map((value, index) => {
        const y = yForUr(value);
        return (
          <g key={value}>
            {/* The plot's own edges stand for the lowest and highest line. */}
            {index > 0 && index < urTicks.length - 1 ? (
              <line x1={plotLeft} y1={y} x2={plotRight} y2={y} stroke={GRID} vectorEffect="non-scaling-stroke" />
            ) : null}
            <text
              x={plotLeft - 10}
              y={y + 4}
              fill={MUTED_TEXT}
              fontSize={CHART_AXIS_FONT}
              fontWeight={500}
              textAnchor="end"
            >
              {Math.round(value)}
            </text>
          </g>
        );
      })}
      {timeTicks.map((time, index) => {
        const x = xForTime(time);
        return (
          <g key={`time-${index}`}>
            {index > 0 && index < timeTicks.length - 1 ? (
              <line x1={x} y1={plotTop} x2={x} y2={plotBottom} stroke={GRID} vectorEffect="non-scaling-stroke" />
            ) : null}
            <TimeTick
              x={x}
              axisY={laneBottom}
              anchor={index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"}
              label={formatTime(time)}
            />
          </g>
        );
      })}

      {hasPoints && safeOverall !== null && overallY !== null ? (
        <>
          <line
            x1={plotLeft}
            y1={overallY}
            x2={plotRight}
            y2={overallY}
            stroke={MUTED_TEXT}
            strokeOpacity={0.7}
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
          <text
            data-testid="overall-ur-value"
            aria-label={`Overall unstable rate ${safeOverall.toFixed(1)}`}
            x={plotRight + 6}
            y={overallY}
            fill={REWIND_COLORS.textSecondary}
            fontSize={CHART_AXIS_FONT}
            fontWeight={500}
            textAnchor="start"
            dominantBaseline="central"
          >
            {safeOverall.toFixed(1)}
          </text>
        </>
      ) : null}

      {showMarks ? (
        <MapMarksLane
          marks={marks}
          timeStart={timeDomain.start}
          timeEnd={timeDomain.end}
          plotLeft={plotLeft}
          plotRight={plotRight}
          top={plotBottom}
        />
      ) : null}

      {plottedPoints.length > 0 ? (
        <>
          <path d={urAreaPath} fill={UR_TRACE} fillOpacity={0.035} />
          <path
            data-testid={`${seriesTestId}-line`}
            d={urPath}
            fill="none"
            stroke={UR_TRACE}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {plottedPoints.length === 1 ? (
            <circle
              data-testid={`${seriesTestId}-point`}
              cx={plottedPoints[0].x}
              cy={plottedPoints[0].y}
              r={2.5}
              fill={UR_TRACE}
            />
          ) : null}
        </>
      ) : (
        <text
          x={(plotLeft + plotRight) / 2}
          y={(plotTop + plotBottom) / 2}
          fill={MUTED_TEXT}
          fontSize={16}
          textAnchor="middle"
        >
          {isAverageMode ? "No average UR samples" : "No UR samples"}
        </text>
      )}

      {safePeak && peakPoint ? (
        <g
          aria-label={`Highest ${isAverageMode ? "average " : "rolling "}unstable rate ${safePeak.unstableRate.toFixed(
            1,
          )} at ${formatTime(safePeak.time)}`}
        >
          <line
            x1={peakPoint.x}
            y1={peakPoint.y}
            x2={peakLabelX}
            y2={peakLabelY + 6}
            stroke={UR_TRACE}
            strokeOpacity={0.4}
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={peakPoint.x} cy={peakPoint.y} r={2.5} fill={UR_TRACE} />
          <text
            data-testid={`peak-${seriesTestId}-value`}
            x={peakLabelX}
            y={peakLabelY}
            fill={UR_TRACE}
            fontSize={CHART_ANNOTATION_FONT}
            fontWeight={600}
            textAnchor="middle"
            paintOrder="stroke"
            stroke={PAGE_BACKGROUND}
            strokeWidth={3}
            strokeLinejoin="round"
          >
            {peakLabel}
          </text>
        </g>
      ) : null}

      <rect
        data-testid={`${seriesTestId}-interaction-layer`}
        x={plotLeft}
        y={plotTop}
        width={plotRight - plotLeft}
        height={plotBottom - plotTop}
        fill="transparent"
        pointerEvents="all"
        style={{ touchAction: "pan-y", cursor: onActivate ? "pointer" : undefined }}
      />
      {showMarks && onActivate ? (
        <rect
          data-testid="map-marks-hit-area"
          x={plotLeft}
          y={plotBottom}
          width={plotRight - plotLeft}
          height={MARKS_LANE_HEIGHT}
          fill="transparent"
          pointerEvents="all"
          style={{ touchAction: "pan-y", cursor: "pointer" }}
        />
      ) : null}
      {activePoint && activePlottedPoint ? (
        <ChartTooltip
          id={tooltipId}
          lines={[
            {
              left: formatTime(activePoint.time),
              mono: true,
              value: activePoint.unstableRate.toFixed(1),
              unit: "UR",
            },
            ...(activeCompanion
              ? [{ left: activeCompanion.label, value: activeCompanion.value, unit: activeCompanion.unit }]
              : []),
          ]}
          accessibleLabel={`${
            isAverageMode
              ? `Average unstable rate ${activePoint.unstableRate.toFixed(1)} through ${
                  activePoint.sampleCount
                } hits at ${formatTime(activePoint.time)}`
              : `Unstable rate ${activePoint.unstableRate.toFixed(1)} over the last ${
                  activePoint.sampleCount
                } hits at ${formatTime(activePoint.time)}`
          }${activeCompanion ? companionSpeech(activeCompanion) : ""}`}
          point={activePlottedPoint}
          plotLeft={plotLeft}
          plotRight={plotRight}
          plotTop={plotTop}
          plotBottom={plotBottom}
          color={UR_TRACE}
        />
      ) : null}
    </svg>
  );
}

export function MetricSparkline({
  values,
  color = PURPLE,
  baseline,
  ariaLabel = "Metric trend",
  className,
  style,
}: MetricSparklineProps) {
  const reactId = useId();
  const gradientId = chartId("sparkline-area", reactId);
  const glowId = chartId("sparkline-glow", reactId);
  const width = 240;
  const height = 48;
  const padding = 4;
  const safeValues = values.filter(isFiniteNumber);
  const safeBaseline = baseline !== undefined && isFiniteNumber(baseline) ? baseline : undefined;
  const minimum = safeValues.reduce(
    (minimum, value) => Math.min(minimum, value),
    safeBaseline ?? Number.POSITIVE_INFINITY,
  );
  const maximum = safeValues.reduce(
    (maximum, value) => Math.max(maximum, value),
    safeBaseline ?? Number.NEGATIVE_INFINITY,
  );
  const range = isFiniteNumber(maximum - minimum) && maximum !== minimum ? maximum - minimum : 1;
  const yForValue = (value: number) => height - padding - ((value - minimum) / range) * (height - padding * 2);
  const points = safeValues.map((value, index) => ({
    x: safeValues.length === 1 ? width / 2 : padding + (index / (safeValues.length - 1)) * (width - padding * 2),
    y: yForValue(value),
  }));
  const baselineY = safeBaseline === undefined ? height - padding : yForValue(safeBaseline);

  return (
    <svg
      className={className}
      style={chartStyle(style, 30)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <title>{safeValues.length > 0 ? ariaLabel : `${ariaLabel}: unavailable`}</title>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2={height} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={color} stopOpacity={0.3} />
          <stop offset="1" stopColor={color} stopOpacity={0.01} />
        </linearGradient>
        <filter id={glowId} x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <line
        x1={padding}
        y1={baselineY}
        x2={width - padding}
        y2={baselineY}
        stroke={color}
        strokeOpacity={0.2}
        vectorEffect="non-scaling-stroke"
      />
      {points.length > 0 ? (
        <>
          <path d={areaPath(points, baselineY)} fill={`url(#${gradientId})`} />
          <path
            data-testid="metric-sparkline"
            d={linePath(points)}
            fill="none"
            stroke={color}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${glowId})`}
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </svg>
  );
}

export function MetricSparkBars({
  values,
  color = CYAN,
  negativeColor = PINK,
  ariaLabel = "Metric distribution",
  className,
  style,
}: MetricSparkBarsProps) {
  const width = 240;
  const height = 48;
  const padding = 4;
  const safeValues = values.filter(isFiniteNumber);
  const hasNegative = safeValues.some((value) => value < 0);
  const hasPositive = safeValues.some((value) => value > 0);
  const hasBothSigns = hasNegative && hasPositive;
  const maximumAbsoluteValue = safeValues.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 1);
  const baselineY = hasBothSigns ? height / 2 : hasNegative ? padding : height - padding;
  const drawableHeight = hasBothSigns ? height / 2 - padding : height - padding * 2;
  const slotWidth = safeValues.length > 0 ? (width - padding * 2) / safeValues.length : width - padding * 2;

  return (
    <svg
      className={className}
      style={chartStyle(style, 30)}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <title>{safeValues.length > 0 ? ariaLabel : `${ariaLabel}: unavailable`}</title>
      <line
        x1={padding}
        y1={baselineY}
        x2={width - padding}
        y2={baselineY}
        stroke="rgba(255,255,255,0.2)"
        vectorEffect="non-scaling-stroke"
      />
      {safeValues.map((value, index) => {
        const barHeight = (Math.abs(value) / maximumAbsoluteValue) * drawableHeight;
        const negative = value < 0;
        return (
          <rect
            data-testid="metric-spark-bar"
            key={index}
            x={padding + index * slotWidth + slotWidth * 0.15}
            y={negative ? baselineY : baselineY - barHeight}
            width={Math.max(0.8, slotWidth * 0.7)}
            height={barHeight}
            rx={Math.min(1.5, slotWidth * 0.25)}
            fill={negative ? negativeColor : color}
            opacity={0.86}
          />
        );
      })}
    </svg>
  );
}
