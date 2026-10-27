import { Box } from "@mui/material";
import type { FullMapTimingSummary, HitErrorHistogramBin } from "../../services/analysis/full-map-analysis";
import type { FullMapHitWindowReferences } from "../../services/analysis/full-map-analysis-view-model";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { FULL_MAP_TIMING_COLORS } from "./FullMapAnalysisCharts";
import {
  clamp,
  finite,
  formatPercent,
  formatSignedMilliseconds,
  formatWindow,
  formatDifficulty,
} from "./full-map-format";
import {
  fullMapPanel,
  fullMapPanelFoot,
  fullMapPanelHead,
  fullMapSectionLabel,
  inSmallWindow,
} from "./full-map-styles";

/** The bars: the page's ink at a little over half strength, so the zero line reads over them. */
const BAR_COLOR = "rgba(245,244,241,0.55)";
/** Room above the bars for the mean's callout. */
const CALLOUT_ROOM = 28;
const STRIP_GAP = 4;
const STRIP_HEIGHT = 4;
const EDGE_GAP = 5;
const EDGE_HEIGHT = 14;
/** From the plot's bottom edge up to the bars' floor. */
const BELOW_BARS = STRIP_GAP + STRIP_HEIGHT + EDGE_GAP + EDGE_HEIGHT;

interface Windows {
  great: number;
  ok: number;
  meh: number;
}
interface DrawnBin extends HitErrorHistogramBin {
  index: number;
  left: number;
  width: number;
}

/** The three windows when they can carry a plot: numbers, in order, and wider than nothing. */
function usableWindows(hitWindows: FullMapHitWindowReferences): Windows | null {
  const { greatMs: great, okMs: ok, mehMs: meh } = hitWindows;
  return hitWindows.available && finite(great) && finite(ok) && finite(meh) && great <= ok && ok <= meh && meh > 0
    ? { great, ok, meh }
    : null;
}

/**
 * A whole number of milliseconds without a decimal, anything else with one; a true minus sign, not a hyphen.
 * Rate mods leave noise like 75.00000000001, so the value is rounded to what it prints before it is judged whole.
 */
function formatEdge(ms: number): string {
  const rounded = Number(ms.toFixed(1));
  if (rounded === 0) return "0";
  return `${rounded < 0 ? "−" : "+"}${Math.abs(rounded).toFixed(Number.isInteger(rounded) ? 0 : 1)}`;
}

const edgeStyle = {
  position: "absolute",
  top: 0,
  fontFamily: REWIND_FONTS.ui,
  fontSize: 11,
  fontWeight: 400,
  lineHeight: `${EDGE_HEIGHT}px`,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  color: REWIND_COLORS.textTertiary,
} as const;
const footValueStyle = {
  color: REWIND_COLORS.textPrimary,
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
} as const;

function DistributionPlot({
  bins,
  total,
  tallest,
  windows,
  meanOffsetMs,
}: {
  bins: DrawnBin[];
  total: number;
  tallest: number;
  windows: Windows;
  meanOffsetMs: number | null;
}) {
  const { great, ok, meh } = windows;
  const at = (ms: number) => 50 + (ms / meh) * 50;
  const outerWidth = ((meh - ok) / (meh * 2)) * 100;
  const middleWidth = ((ok - great) / (meh * 2)) * 100;
  const centreWidth = (great / meh) * 100;
  const mean = finite(meanOffsetMs) ? meanOffsetMs : null;
  const meanPosition = mean === null ? 50 : clamp(at(mean), 0, 100);
  // A mean that rounds to 0.0 is the zero line itself: one line, in the line's own colour.
  const meanIsZero = mean !== null && Math.abs(mean) < 0.05;
  const meanColor = meanIsZero
    ? REWIND_COLORS.textPrimary
    : mean !== null && mean < 0
    ? FULL_MAP_TIMING_COLORS.EARLY
    : FULL_MAP_TIMING_COLORS.LATE;
  // Near either edge the callout hangs inward from the mean instead of being centred on it.
  const calloutSide = meanPosition <= 14 ? "start" : meanPosition >= 86 ? "end" : "centre";
  const edges = [-meh, -ok, -great, 0, great, ok, meh];

  return (
    <Box
      data-testid="ur-bar-visual"
      sx={{
        position: "relative",
        display: "grid",
        gridTemplateRows: "minmax(0, 1fr) auto auto",
        boxSizing: "border-box",
        minHeight: 0,
        pt: `${CALLOUT_ROOM}px`,
      }}
    >
      {mean !== null ? (
        <Box
          data-testid="ur-average-offset-callout"
          sx={{
            position: "absolute",
            zIndex: 3,
            top: 0,
            left: `${meanPosition}%`,
            transform:
              calloutSide === "start" ? "none" : calloutSide === "end" ? "translateX(-100%)" : "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: calloutSide === "start" ? "flex-start" : calloutSide === "end" ? "flex-end" : "center",
            color: meanColor,
            pointerEvents: "none",
          }}
        >
          <Box component="span" sx={{ fontSize: 13, fontWeight: 600, lineHeight: "18px", whiteSpace: "nowrap" }}>
            Mean {meanIsZero ? "0.0 ms" : formatSignedMilliseconds(mean)}
          </Box>
          <Box
            data-testid="ur-average-offset-pointer"
            sx={{
              width: 0,
              height: 0,
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderTop: `5px solid ${meanColor}`,
            }}
          />
        </Box>
      ) : null}
      <Box
        data-testid="ur-hit-distribution"
        role="img"
        aria-label={`Hit-error distribution from ${total} successful hits`}
        sx={{ position: "relative", minHeight: 0 }}
      >
        {bins.map((bin) => (
          <Box
            data-testid="ur-distribution-bin"
            data-count={bin.count}
            data-start-ms={bin.startMs}
            data-end-ms={bin.endMs}
            key={`${bin.startMs}-${bin.endMs}-${bin.index}`}
            title={`${formatSignedMilliseconds(bin.startMs)} to ${formatSignedMilliseconds(bin.endMs)} · ${bin.count} ${
              bin.count === 1 ? "hit" : "hits"
            }`}
            sx={{ position: "absolute", bottom: 0, borderRadius: 0, backgroundColor: BAR_COLOR }}
            // Each bin's own geometry is inline: one class for all of them, not one per bin.
            style={{
              left: `${bin.left}%`,
              width: `${bin.width}%`,
              height: `${(bin.count / tallest) * 100}%`,
              minHeight: bin.count > 0 ? 1 : 0,
            }}
          />
        ))}
      </Box>
      <Box data-testid="ur-timing-bar" sx={{ display: "flex", height: STRIP_HEIGHT, mt: `${STRIP_GAP}px` }}>
        {[
          { key: "early-50", width: outerWidth, color: REWIND_COLORS.hitWindow50, level: "50" },
          { key: "early-100", width: middleWidth, color: REWIND_COLORS.hitWindow100, level: "100" },
          { key: "300", width: centreWidth, color: REWIND_COLORS.hitWindow300, level: "300" },
          { key: "late-100", width: middleWidth, color: REWIND_COLORS.hitWindow100, level: "100" },
          { key: "late-50", width: outerWidth, color: REWIND_COLORS.hitWindow50, level: "50" },
        ].map((segment) => (
          <Box
            data-testid={`ur-window-${segment.level}`}
            key={segment.key}
            sx={{ flex: `0 0 ${segment.width}%`, height: "100%", backgroundColor: segment.color }}
          />
        ))}
      </Box>
      <Box
        data-testid="ur-window-edges"
        aria-hidden="true"
        sx={{ position: "relative", height: EDGE_HEIGHT, mt: `${EDGE_GAP}px` }}
      >
        {edges.map((ms, index) => (
          <Box
            component="span"
            key={index}
            sx={ms === 0 ? { ...edgeStyle, fontWeight: 600, color: REWIND_COLORS.textPrimary } : edgeStyle}
            // The outermost two stay inside the plot; the rest are centred on their edge.
            style={{
              left: `${at(ms)}%`,
              transform: index === 0 ? "none" : index === edges.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {formatEdge(ms)}
          </Box>
        ))}
      </Box>
      {/* The perfect hit time is the axis of the whole plot: it starts above the bars and runs on through the strip. */}
      <Box
        data-testid="ur-zero-offset-marker"
        role="img"
        aria-label="Perfect timing at 0 ms"
        sx={{
          position: "absolute",
          zIndex: 2,
          left: "50%",
          top: CALLOUT_ROOM - 8,
          bottom: EDGE_GAP + EDGE_HEIGHT - 2,
          width: "2px",
          backgroundColor: REWIND_COLORS.textPrimary,
          transform: "translateX(-1px)",
          pointerEvents: "none",
        }}
      />
      {mean !== null && !meanIsZero ? (
        <Box
          data-testid="ur-average-offset-marker"
          aria-hidden="true"
          sx={{
            position: "absolute",
            zIndex: 2,
            left: `${meanPosition}%`,
            top: CALLOUT_ROOM - 4,
            bottom: BELOW_BARS,
            width: "1px",
            backgroundColor: meanColor,
            transform: "translateX(-0.5px)",
            pointerEvents: "none",
          }}
        />
      ) : null}
    </Box>
  );
}

/**
 * Every timed hit at once, by how early or late it was: bars over the hit windows, centred on the perfect hit time.
 * `rulesetLabel` and `od` only name the panel for a screen reader; the page's header and footer show them.
 */
export function FullMapTimingDistribution({
  timing,
  hitWindows,
  rulesetLabel,
  od,
}: {
  timing: FullMapTimingSummary;
  hitWindows: FullMapHitWindowReferences;
  rulesetLabel: string;
  od: number | null;
}) {
  const windows = usableWindows(hitWindows);
  const bins: DrawnBin[] = [];
  let total = 0;
  let tallest = 1;
  if (windows) {
    const { meh } = windows;
    timing.histogram.bins.forEach((bin, index) => {
      // `clamp` would turn an infinite edge into the window's own, so the edges are checked first.
      if (!Number.isFinite(bin.startMs) || !Number.isFinite(bin.endMs) || !Number.isFinite(bin.count)) return;
      // A bin reaching past the widest window is cut at its edge; one wholly outside has no width left.
      const left = 50 + (clamp(bin.startMs, -meh, meh) / meh) * 50;
      const width = 50 + (clamp(bin.endMs, -meh, meh) / meh) * 50 - left;
      if (!(width > 0)) return;
      bins.push({ ...bin, index, left, width });
      total += bin.count;
      tallest = Math.max(tallest, bin.count);
    });
  }
  const nothingToPlot = !windows ? "Timing windows unavailable" : total === 0 ? "No timing samples" : null;

  return (
    <Box
      component="section"
      aria-label={
        windows && !nothingToPlot
          ? `Hit-error distribution, ${rulesetLabel}, OD ${formatDifficulty(od)}, 300 ${formatWindow(
              windows.great,
            )}, 100 ${formatWindow(windows.ok)}, 50 ${formatWindow(
              windows.meh,
            )}, ${total} successful hits in the distribution`
          : "Hit-error distribution unavailable"
      }
      sx={{ ...fullMapPanel, ...inSmallWindow({ minHeight: 260 }) }}
    >
      <Box sx={fullMapPanelHead}>
        <Box component="h2" sx={{ ...fullMapSectionLabel, m: 0 }}>
          TIMING
        </Box>
      </Box>
      {windows && !nothingToPlot ? (
        <>
          <DistributionPlot
            bins={bins}
            total={total}
            tallest={tallest}
            windows={windows}
            meanOffsetMs={timing.meanOffsetMs}
          />
          <Box sx={fullMapPanelFoot}>
            <Box component="span" sx={{ color: FULL_MAP_TIMING_COLORS.EARLY }}>
              {"Early "}
              <Box component="strong" sx={footValueStyle}>
                {formatPercent(timing.earlyPercentage, 1)}
              </Box>
            </Box>
            <Box component="span" sx={{ display: "flex", gap: "16px", fontVariantNumeric: "tabular-nums" }}>
              <Box component="span" sx={{ color: REWIND_COLORS.hitWindow300 }}>
                300
              </Box>{" "}
              <Box component="span" sx={{ color: REWIND_COLORS.hitWindow100 }}>
                100
              </Box>{" "}
              <Box component="span" sx={{ color: REWIND_COLORS.hitWindow50 }}>
                50
              </Box>{" "}
              <Box component="span" sx={{ color: REWIND_COLORS.textTertiary }}>
                hit windows, ms
              </Box>
            </Box>
            <Box component="span" sx={{ color: FULL_MAP_TIMING_COLORS.LATE }}>
              <Box component="strong" sx={footValueStyle}>
                {formatPercent(timing.latePercentage, 1)}
              </Box>
              {" Late"}
            </Box>
          </Box>
        </>
      ) : (
        <Box role="status" sx={{ alignSelf: "center", color: REWIND_COLORS.textTertiary }}>
          {nothingToPlot}
        </Box>
      )}
    </Box>
  );
}
