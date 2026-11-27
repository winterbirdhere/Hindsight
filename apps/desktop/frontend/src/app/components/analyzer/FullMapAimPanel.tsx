import { Box } from "@mui/material";
import { useMemo } from "react";
import type { FullMapAimPoint, FullMapAimScatter } from "../../services/analysis/full-map-aim-scatter";
import { REWIND_COLORS } from "../../styles/tokens";
import { finite } from "./full-map-format";
import {
  FULL_MAP_HEAD_HEIGHT,
  fullMapPanel,
  fullMapPanelFoot,
  fullMapPanelHead,
  fullMapSectionLabel,
  inSmallWindow,
} from "./full-map-styles";

/** The room the plot has around the circle's edge (radius 1), so a hit a little outside it still shows. */
const VIEW_EXTENT = 1.35;
const VIEW_BOX = `${-VIEW_EXTENT} ${-VIEW_EXTENT} ${VIEW_EXTENT * 2} ${VIEW_EXTENT * 2}`;
const DOT_RADIUS = 0.022;
/** A missed note's ring is a little larger than a hit's dot, and an outline so it never hides what is under it. */
const RING_RADIUS = 0.05;
/** A ring is drawn no further out than this, along its own direction: past it the cursor was simply elsewhere. */
const RING_MAX_DISTANCE = 1.3;
/** Half the length of the mean's cross, in radii. */
const MEAN_ARM = 0.06;
/** A mean under half a percent of a radius is on neither side. */
const MEAN_MIN_PERCENT = 0.5;

/** What the head, the foot's two lines and the two gaps between them take of the panel's height, as set below. */
const FOOT_LINE_HEIGHT = 17;
/** The ring caption's line is kept even when empty, so the plot is the same size for every replay and ruleset. */
const FOOT_LINES = 2;
const PANEL_GAP = 10;
/** The band's height less all of that is the plot's side: the plot is as wide as the band is tall. */
const PLOT_SIDE = `calc(100cqh - ${FULL_MAP_HEAD_HEIGHT + FOOT_LINE_HEIGHT * FOOT_LINES + PANEL_GAP * 2}px)`;
/** The plot's side where the band stacks and has no height of its own. */
const SMALL_WINDOW_PLOT_SIDE = 280;

// Drawn in this order: the best hits first, so the rarer 100s and 50s are not buried.
const VERDICTS = [
  { verdict: "GREAT", color: REWIND_COLORS.judgement300 },
  { verdict: "OK", color: REWIND_COLORS.judgement100 },
  { verdict: "MEH", color: REWIND_COLORS.judgement50 },
] as const;

/** A circle as two arcs, drawn from its left point. */
const circleArcs = (radius: number) =>
  `a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
const DOT_ARCS = circleArcs(DOT_RADIUS);
const RING_ARCS = circleArcs(RING_RADIUS);

/** One path of small discs, a subpath each. Built with a loop: a spread of ten thousand points would overflow the stack. */
function dotsPath(points: readonly FullMapAimPoint[]): string {
  const parts: string[] = [];
  for (const point of points) parts.push(`M${(point.x - DOT_RADIUS).toFixed(3)} ${point.y.toFixed(3)}${DOT_ARCS}`);
  return parts.join("");
}

type MissPoint = FullMapAimScatter["misses"][number];

/** One path of rings, a subpath each. A ring past the clamp keeps its direction and sits at the clamp. */
function ringsPath(misses: readonly MissPoint[]): string {
  const parts: string[] = [];
  for (const miss of misses) {
    const distance = Math.hypot(miss.x, miss.y);
    const scale = distance > RING_MAX_DISTANCE ? RING_MAX_DISTANCE / distance : 1;
    parts.push(`M${(miss.x * scale - RING_RADIUS).toFixed(3)} ${(miss.y * scale).toFixed(3)}${RING_ARCS}`);
  }
  return parts.join("");
}

/** The mean's cross, as the name says it: along the movement first, then across it. */
function meanClause(mean: { x: number; y: number }): string {
  const along =
    Math.abs(mean.x) * 100 >= MEAN_MIN_PERCENT
      ? { percent: Math.round(Math.abs(mean.x) * 100), side: mean.x > 0 ? "ahead" : "behind" }
      : null;
  const across =
    Math.abs(mean.y) * 100 >= MEAN_MIN_PERCENT
      ? { percent: Math.round(Math.abs(mean.y) * 100), side: mean.y > 0 ? "right" : "left" }
      : null;
  const parts = [along, across]
    .filter((part): part is NonNullable<typeof part> => part !== null)
    // Only the first figure says what it is a percentage of.
    .map((part, index) =>
      index === 0 ? `${part.percent}% of a radius ${part.side}` : `${part.percent}% ${part.side}`,
    );
  return parts.length ? `mean ${parts.join(" and ")} of the path` : "mean at the centre";
}

/** The misses with the cursor on the note (a radius or less from the centre, before any clamp) and off it. */
function missClause(misses: readonly MissPoint[]): string {
  if (misses.length === 0) return "";
  const on = misses.filter((miss) => Math.hypot(miss.x, miss.y) <= 1).length;
  return `, ${misses.length} ${misses.length === 1 ? "miss" : "misses"}: ${on} with the cursor on the note, ${
    misses.length - on
  } off it`;
}

function accessibleName(count: number, mean: { x: number; y: number } | null, misses: readonly MissPoint[]): string {
  const hits = `${count} ${count === 1 ? "hit" : "hits"} around the circle's centre`;
  return `Aim: ${hits}${mean ? `, ${meanClause(mean)}` : ""}${missClause(misses)}`;
}

const lineStyle = { stroke: REWIND_COLORS.hairline, strokeWidth: 1, vectorEffect: "non-scaling-stroke" } as const;

/**
 * Every successful circle / slider-head hit at the cursor's place on its circle, turned so the movement runs to the
 * right, and a ring for every missed note at the cursor's place when it was due. It must sit inside a size container
 * (`container-type: size`), which sizes the square: the plot's side is `100cqh` less the panel's own parts.
 */
export function FullMapAimPanel({ aim }: { aim: FullMapAimScatter }) {
  const { points } = aim;
  // A mean that is not a number is neither drawn nor named.
  const mean = aim.mean && finite(aim.mean.x) && finite(aim.mean.y) ? aim.mean : null;
  // A point that is not a number would put `NaN` into the path and spoil every dot after it.
  const dots = useMemo(() => {
    const drawable = points.filter((point) => finite(point.x) && finite(point.y));
    return VERDICTS.map(({ verdict, color }) => {
      const ofVerdict = drawable.filter((point) => point.verdict === verdict);
      return { verdict, color, count: ofVerdict.length, d: dotsPath(ofVerdict) };
    });
  }, [points]);
  const drawnCount = dots.reduce((total, dot) => total + dot.count, 0);
  const rings = useMemo(() => aim.misses.filter((miss) => finite(miss.x) && finite(miss.y)), [aim.misses]);
  // No hit to draw: a bare circle would read as perfect aim, and rings alone as aim evidence they are not.
  const drawable = drawnCount > 0;
  // The foot is two lines, the movement caption always the lower one; the ring line above it may be blank.
  // The visible text is short enough for a square a few hundred pixels wide and never carries a count; the hover
  // text is the full sentences, with the counts.
  const showRingLine = rings.length > 0 || aim.omittedMissCount > 0;
  const missCount = aim.omittedMissCount;
  const hitCount = aim.omittedCount;
  const footLines = [
    {
      text: "Rings: cursor at each miss",
      title: `Rings show where the cursor was when each missed note was due.${
        missCount > 0 ? ` ${missCount} ${missCount === 1 ? "miss" : "misses"} could not be placed.` : ""
      }`,
      shown: showRingLine,
    },
    {
      text: "Movement runs left to right",
      title: `Offsets are turned so the movement into each note runs left to right.${
        hitCount > 0
          ? ` ${hitCount} ${hitCount === 1 ? "hit without a direction is" : "hits without a direction are"} left out.`
          : ""
      }`,
      shown: true,
    },
  ].map((line) => (line.shown ? line : { ...line, text: "", title: "" }));

  return (
    <Box component="section" aria-label="Aim" sx={{ ...fullMapPanel, gap: `${PANEL_GAP}px` }}>
      <Box sx={fullMapPanelHead}>
        <Box component="h2" sx={{ ...fullMapSectionLabel, m: 0 }}>
          AIM
        </Box>
      </Box>
      {aim.available && drawable ? (
        <>
          <Box
            data-testid="aim-plot"
            sx={{
              position: "relative",
              width: PLOT_SIDE,
              height: PLOT_SIDE,
              ...inSmallWindow({ width: SMALL_WINDOW_PLOT_SIDE, height: SMALL_WINDOW_PLOT_SIDE }),
            }}
          >
            <svg
              role="img"
              aria-label={accessibleName(drawnCount, mean, rings)}
              viewBox={VIEW_BOX}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                display: "block",
                overflow: "visible",
              }}
            >
              <circle
                r={1}
                fill={REWIND_COLORS.inset}
                stroke="rgba(255,255,255,0.45)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
              <circle r={0.5} fill="none" {...lineStyle} />
              <path d="M-1 0H1M0 -1V1" fill="none" {...lineStyle} />
              {dots.map((dot) => (
                <path
                  key={dot.verdict}
                  data-testid={`aim-dots-${dot.verdict}`}
                  data-count={dot.count}
                  d={dot.d}
                  fill={dot.color}
                  fillOpacity={0.7}
                />
              ))}
              {rings.length > 0 ? (
                <path
                  data-testid="aim-misses"
                  data-count={rings.length}
                  d={ringsPath(rings)}
                  fill="none"
                  stroke={REWIND_COLORS.judgementMiss}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {mean ? (
                <path
                  data-testid="aim-mean"
                  d={`M${(mean.x - MEAN_ARM).toFixed(3)} ${mean.y.toFixed(3)}h${MEAN_ARM * 2}M${mean.x.toFixed(3)} ${(
                    mean.y - MEAN_ARM
                  ).toFixed(3)}v${MEAN_ARM * 2}`}
                  fill="none"
                  stroke={REWIND_COLORS.textPrimary}
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
            </svg>
          </Box>
          <Box
            sx={{
              ...fullMapPanelFoot,
              // Lines the width of the plot, not wider: the captions do not widen the column.
              display: "block",
              width: 0,
              minWidth: "100%",
              lineHeight: `${FOOT_LINE_HEIGHT}px`,
            }}
          >
            {footLines.map((line, index) => (
              <Box
                key={index}
                title={line.title || undefined}
                sx={{ height: FOOT_LINE_HEIGHT, overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {line.text}
              </Box>
            ))}
          </Box>
        </>
      ) : (
        <Box role="status" sx={{ alignSelf: "center", maxWidth: 240, color: REWIND_COLORS.textTertiary }}>
          {aim.available
            ? "No hit had usable cursor evidence."
            : (aim.unavailableReason ?? "Aim positions are unavailable.")}
        </Box>
      )}
    </Box>
  );
}
