import { Box, SvgIcon, Tooltip, Typography } from "@mui/material";
import type { FullMapPerformance } from "../../services/analysis/performance/PerformanceTimelineService";
import { REPLAY_STATS_STAR_PATH } from "../../services/analysis/replay-stats-design";
import { REWIND_COLORS, REWIND_FOCUS_RING } from "../../styles/tokens";
import { FullMapHoverCard, fullMapHoverCardSlotProps } from "./FullMapHoverCard";
import { fullMapBig, fullMapLabel, fullMapStat, fullMapUnit, fullMapValue } from "./full-map-styles";

/** The small print of a stat: what a value could not be, or what it stands for. */
const noteStyle = { color: REWIND_COLORS.textTertiary, fontSize: 12, lineHeight: 1.4 };
function Star({ size = 16, marginRight }: { size?: number | string; marginRight?: string }) {
  return (
    <SvgIcon aria-hidden="true" sx={{ fontSize: size, marginRight }}>
      <path d={REPLAY_STATS_STAR_PATH} />
    </SvgIcon>
  );
}
const fallback: FullMapPerformance = {
  status: "unavailable",
  description: "Performance values are unavailable for this replay mode",
};

export function FullMapPerformanceSummary({
  performance = fallback,
  failed = false,
  metric = "both",
}: {
  performance?: FullMapPerformance;
  failed?: boolean;
  metric?: "pp" | "sr" | "both";
}) {
  const metricLabel = metric === "pp" ? "PP" : metric === "sr" ? "SR" : "PP and SR";
  const statusHeading = performance.status === "loading" ? metricLabel : `${metricLabel} unavailable`;
  const { breakdown } = performance;
  const pp = performance.pp?.toFixed(2) ?? "—";
  // What the PP's own tooltip holds: the peak on the way, and the same play as a full combo.
  const ppExtras = [
    { key: "peak", label: "Peak", value: performance.peakPp },
    { key: "fc", label: "If FC", value: performance.fullComboPp },
  ].filter((extra): extra is { key: string; label: string; value: number } => extra.value !== undefined && Number.isFinite(extra.value));
  // The longer of the two is the whole bar.
  const ppExtraMax = Math.max(0, ...ppExtras.map(({ value }) => value));
  const ppValue = (
    <Typography
      aria-label={`Replay PP ${pp}`}
      {...(ppExtras.length > 0 ? { tabIndex: 0 } : {})}
      sx={{ ...fullMapBig, color: REWIND_COLORS.textPrimary, "&:focus-visible": REWIND_FOCUS_RING }}
    >
      {pp}
      <Box component="span" sx={{ ...fullMapUnit, fontSize: 15 }}>
        pp
      </Box>
    </Typography>
  );
  // Use the extension's truncated total so the displayed components add up exactly.
  const sr = (breakdown?.total ?? Math.floor(((performance.sr ?? 0) + Number.EPSILON) * 100) / 100).toFixed(2);
  const components = breakdown
    ? [
        { key: "aim", label: "Aim", value: breakdown.aim },
        { key: "speed", label: "Speed", value: breakdown.speed },
        { key: "reading", label: "Reading", value: breakdown.reading },
        { key: "flashlight", label: "Flashlight", value: breakdown.flashlight },
      ].filter(({ key, value }) => key !== "flashlight" || value > 0)
    : [];
  const componentMax = Math.max(0, ...components.map(({ value }) => value));

  return (
    <Box
      component="section"
      aria-label={
        metric === "both"
          ? "Replay performance and map difficulty"
          : metric === "pp"
          ? "Replay performance"
          : "Map difficulty"
      }
      sx={{
        display: "flex",
        alignItems: "flex-start",
        flexWrap: "wrap",
        gap: "12px 24px",
      }}
    >
      {performance.status !== "ready" ? (
        // As tall as a ready stat, so the row does not change height when the numbers arrive: a dash where the value
        // would be, and the sentence on the label's line, cut short at the stat's width with all of it on hover.
        <Box role="status" sx={{ ...fullMapStat, maxWidth: 240 }}>
          <Typography
            aria-hidden="true"
            sx={{ ...(metric === "sr" ? fullMapValue : fullMapBig), color: REWIND_COLORS.textTertiary }}
          >
            —
          </Typography>
          <Box
            title={`${statusHeading} · ${performance.description}`}
            sx={{
              ...fullMapLabel,
              textTransform: "none",
              letterSpacing: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <Box component="span" sx={{ color: REWIND_COLORS.textPrimary, fontWeight: 600 }}>
              {statusHeading}
            </Box>
            {" · "}
            <span>{performance.description}</span>
          </Box>
        </Box>
      ) : (
        <>
          {metric !== "sr" && (
            <Box sx={{ ...fullMapStat, flex: "0 0 auto" }}>
              {ppExtras.length === 0 ? (
                ppValue
              ) : (
                <Tooltip
                  arrow
                  describeChild
                  slotProps={fullMapHoverCardSlotProps}
                  title={
                    <FullMapHoverCard
                      rows={ppExtras.map(({ label, value }) => ({
                        label,
                        value: value.toFixed(2),
                        unit: "pp",
                        share: ppExtraMax > 0 ? value / ppExtraMax : undefined,
                      }))}
                    />
                  }
                >
                  {ppValue}
                </Tooltip>
              )}
              <Box component="span" sx={fullMapLabel}>
                PERFORMANCE
              </Box>
              {failed && <Typography sx={noteStyle}>Achieved before replay ended</Typography>}
            </Box>
          )}
          {metric !== "pp" && (
            <Box sx={{ ...fullMapStat, flex: "0 0 auto" }}>
              <Tooltip
                arrow
                describeChild
                slotProps={fullMapHoverCardSlotProps}
                title={
                  breakdown ? (
                    <FullMapHoverCard
                      rows={components.map(({ label, value }) => ({
                        label,
                        value: value.toFixed(2),
                        share: componentMax > 0 ? value / componentMax : undefined,
                      }))}
                    />
                  ) : (
                    "SR breakdown unavailable"
                  )
                }
              >
                <Typography
                  tabIndex={0}
                  aria-label={`Full-map SR ${sr} stars`}
                  sx={{ ...fullMapValue, color: REWIND_COLORS.star, "&:focus-visible": REWIND_FOCUS_RING }}
                >
                  {/* Inline, so the star sits on the number's baseline and the row's values stay aligned. */}
                  <Star size="0.62em" marginRight="0.35em" />
                  {sr}
                </Typography>
              </Tooltip>
              <Box component="span" sx={fullMapLabel}>
                STAR RATING
              </Box>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
