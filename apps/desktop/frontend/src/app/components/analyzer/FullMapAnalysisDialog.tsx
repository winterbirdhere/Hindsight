import { Close } from "@mui/icons-material";
import { Box, ButtonBase, Dialog } from "@mui/material";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { FullMapAnalysisViewModel } from "../../services/analysis/full-map-analysis-view-model";
import type { ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import { ReplayModIcons } from "./ReplayModIcons";
import { FullMapAimPanel } from "./FullMapAimPanel";
import { FullMapErrorCauses } from "./FullMapErrorCauses";
import { FullMapPerformanceSummary } from "./FullMapPerformanceSummary";
import type { FullMapPerformance } from "../../services/analysis/performance/PerformanceTimelineService";
import {
  AverageUrOverTimeChart,
  TimingOverTimeChart,
  type FullMapChartCompanion,
} from "./FullMapAnalysisCharts";
import { FullMapJudgements, canCompareSavedScore } from "./FullMapJudgements";
import { FullMapTimingDistribution } from "./FullMapTimingDistribution";
import type { FullMapErrorCauses as ErrorCauses } from "./full-map-error-causes";
import {
  finite,
  formatDifficulty,
  formatDuration,
  formatMetric,
  formatSignedOffset,
  lastIndexAtOrBefore,
  nearestIndexByTime,
} from "./full-map-format";
import {
  FullMapSegmented,
  NARROW_RESULT_ROW,
  fullMapBig,
  fullMapLabel,
  fullMapSectionLabel,
  fullMapStat,
  fullMapUnit,
  fullMapValue,
  inSmallWindow,
} from "./full-map-styles";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { thinScrollbar } from "../../styles/scrollbar";
import { preventPointerFocus } from "../../utils/focus";

export interface FullMapAnalysisDialogProps {
  open: boolean;
  viewModel: FullMapAnalysisViewModel;
  replayValidation?: ReplaySimulationValidation;
  performance?: FullMapPerformance;
  /** How many errors had an Aim, Tapping or Notelock cause; without it the panel says the analysis is unavailable. */
  errorCauses?: ErrorCauses;
  canSwitchRuleset: boolean;
  onSwitchRuleset: (target: ReplayAnalysisRuleset) => void;
  /** Open the replay at a time of the map. */
  onOpenReplayAt?: (timeMs: number) => void;
  onClose: () => void;
}

const RULESET_OPTIONS = [
  { value: "stable", label: "Stable" },
  { value: "lazer", label: "Lazer" },
] as const;

/** The one graph over the map: the unstable rate of the last 50 hits, or each hit's error. */
const GRAPH_OPTIONS = [
  { value: "unstableRate", label: "Unstable rate · 50 hits" },
  { value: "hitError", label: "Hit error" },
] as const;
type Graph = typeof GRAPH_OPTIONS[number]["value"];

const NO_ERROR_CAUSES: ErrorCauses = { status: "unavailable", reason: "unavailable" };

const HAIRLINE_BELOW = `inset 0 -1px 0 ${REWIND_COLORS.hairlineSoft}`;
const HAIRLINE_ABOVE = `inset 0 1px 0 ${REWIND_COLORS.hairlineSoft}`;

/** One figure of the result row: its value, and its name in caps beneath. */
function ResultStat({
  label,
  labelTitle,
  name,
  children,
}: {
  label: string;
  labelTitle?: string;
  /** Names the whole stat, for the one whose value alone does not say what it is. */
  name?: string;
  children: ReactNode;
}) {
  return (
    <Box aria-label={name} sx={fullMapStat}>
      {children}
      <Box component="span" title={labelTitle} sx={fullMapLabel}>
        {label}
      </Box>
    </Box>
  );
}

function FooterFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span>
      {label}{" "}
      <Box
        component="strong"
        sx={{ ml: "2px", color: REWIND_COLORS.textPrimary, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </Box>
    </span>
  );
}

export function FullMapAnalysisDialog({
  open,
  viewModel,
  replayValidation,
  performance,
  errorCauses = NO_ERROR_CAUSES,
  canSwitchRuleset,
  onSwitchRuleset,
  onOpenReplayAt,
  onClose,
}: FullMapAnalysisDialogProps) {
  const [graph, setGraph] = useState<Graph>("unstableRate");
  const { summary, footer, hitWindows, context } = viewModel;
  // The saved max combo is set beside Hindsight's when the saved score is shown beside it and the two combos differ.
  const savedMaxCombo = replayValidation?.expectedMaxCombo;
  const comparing =
    canCompareSavedScore(viewModel, replayValidation) &&
    typeof savedMaxCombo === "number" &&
    Number.isFinite(savedMaxCombo) &&
    savedMaxCombo !== summary.maxComboObtained;
  // Named only when the page shows the ruleset the replay was not played in.
  const reconstructionLabel =
    summary.ruleset === viewModel.sourceRuleset
      ? undefined
      : `${summary.ruleset === "stable" ? "Stable" : "Lazer"} reconstruction`;
  const meanOffset = summary.timing.meanOffsetMs;
  // A mean that rounds to 0.0 is on neither side.
  const meanOffsetSide = !finite(meanOffset) || Math.abs(meanOffset) < 0.05 ? null : meanOffset > 0 ? "late" : "early";
  const meanOffsetValue = !finite(meanOffset)
    ? "—"
    : meanOffsetSide
    ? `${meanOffset > 0 ? "+" : ""}${meanOffset.toFixed(1)}`
    : "0.0";
  const meanOffsetUnit = !finite(meanOffset) ? undefined : meanOffsetSide ? `ms ${meanOffsetSide}` : "ms";
  const accuracy = finite(summary.accuracy) ? (summary.accuracy * 100).toFixed(2) : undefined;
  const failed = viewModel.completionStatus === "failed";
  const grade = viewModel.grade ?? "—";
  // Failed grades need a readable foreground on the neutral dark surface.
  const gradeColor = grade === "F" ? "#c5cad3" : viewModel.rankColor ?? REWIND_COLORS.textTertiary;
  const maxCombo = finite(summary.maxComboObtained) ? summary.maxComboObtained : "—";
  const mapMaxCombo = finite(summary.mapMaxCombo) ? summary.mapMaxCombo : undefined;
  // The artist and its dash are set quieter than the title, so the name is kept in two parts.
  const titleLabel = [context?.title, context?.difficulty ? `[${context.difficulty}]` : undefined]
    .filter(Boolean)
    .join(" ");
  const artistLabel = context?.artist ? `${context.artist}${context.title ? " - " : " "}` : "";
  const mapLabel = `${artistLabel}${titleLabel}`.trim();
  // The page opens on the unstable rate, and each ruleset starts there again.
  useEffect(() => {
    if (open) setGraph("unstableRate");
  }, [open, summary.ruleset]);
  // The same array while the windows are the same: a new one each render would redo the hit-error chart's work.
  const { available: windowsAvailable, greatMs, okMs, mehMs } = hitWindows;
  // What each graph's hover card adds: the other graph's measure at that time. The series are sorted by time, so each
  // is a binary search, and the functions change only with their data.
  const timingSamples = summary.timing.samples;
  const urPoints = summary.timing.urOverTime;
  const hitErrorAt = useCallback(
    (timeMs: number): FullMapChartCompanion | undefined => {
      const sample = timingSamples[nearestIndexByTime(timingSamples, timeMs)];
      return sample && finite(sample.offsetMs)
        ? { label: "Hit error", value: formatSignedOffset(sample.offsetMs), unit: "ms" }
        : undefined;
    },
    [timingSamples],
  );
  const unstableRateAt = useCallback(
    (timeMs: number): FullMapChartCompanion | undefined => {
      const point = urPoints[lastIndexAtOrBefore(urPoints, timeMs)];
      return point && finite(point.unstableRate)
        ? { label: "Unstable rate", value: point.unstableRate.toFixed(1), unit: "UR" }
        : undefined;
    },
    [urPoints],
  );
  const hitWindowLines = useMemo(
    () =>
      windowsAvailable && finite(greatMs) && finite(okMs) && finite(mehMs)
        ? [
            { radiusMs: greatMs, label: "300", color: REWIND_COLORS.hitWindow300 },
            { radiusMs: okMs, label: "100", color: REWIND_COLORS.hitWindow100 },
            { radiusMs: mehMs, label: "50", color: REWIND_COLORS.hitWindow50 },
          ]
        : [],
    [windowsAvailable, greatMs, okMs, mehMs],
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen
      aria-labelledby="full-map-analysis-title"
      PaperProps={{
        sx: {
          // One fixed page: the head, the result, the panels in the room left, and the foot. The one column is never
          // wider than the page, so a row with too much in it cannot push the close control off the edge.
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: "auto auto minmax(0, 1fr) auto",
          boxSizing: "border-box",
          p: "0 28px",
          overflow: "hidden",
          backgroundColor: REWIND_COLORS.surface,
          backgroundImage: "none",
          color: REWIND_COLORS.textPrimary,
          fontFamily: REWIND_FONTS.ui,
          fontSize: 13,
          lineHeight: 1.4,
          "& button:focus-visible, & svg[tabindex]:focus-visible": REWIND_FOCUS_RING,
          "& ::selection": { backgroundColor: REWIND_COLORS.controlActive, color: REWIND_COLORS.white },
          ...thinScrollbar,
          // Too small for one page: the panels' row is as tall as what is in it, at least, and the page scrolls.
          ...inSmallWindow({ gridTemplateRows: "auto auto minmax(min-content, 1fr) auto", overflowY: "auto" }),
        },
      }}
    >
      <Box
        component="header"
        sx={{ display: "flex", alignItems: "center", gap: "14px", height: 56, minWidth: 0, boxShadow: HAIRLINE_BELOW }}
      >
        <Box
          id="full-map-analysis-title"
          component="h1"
          sx={{ m: 0, fontSize: 15.5, fontWeight: 600, whiteSpace: "nowrap" }}
        >
          Full-map analysis
        </Box>
        {mapLabel ? (
          <Box
            title={mapLabel}
            sx={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 15.5,
              fontWeight: 500,
            }}
          >
            {artistLabel ? (
              <Box component="span" sx={{ color: REWIND_COLORS.textSecondary, fontWeight: 400 }}>
                {artistLabel}
              </Box>
            ) : null}
            {titleLabel}
          </Box>
        ) : null}
        {context?.player ? (
          <Box component="span" sx={{ color: REWIND_COLORS.textBright, whiteSpace: "nowrap" }}>
            {context.player}
          </Box>
        ) : null}
        <ReplayModIcons mods={viewModel.mods} />
        <Box sx={{ flex: 1 }} />
        {reconstructionLabel ? (
          <Box component="span" sx={{ color: REWIND_COLORS.textTertiary, fontSize: 12, whiteSpace: "nowrap" }}>
            {reconstructionLabel}
          </Box>
        ) : null}
        <FullMapSegmented
          label="Analysis ruleset"
          value={summary.ruleset}
          options={RULESET_OPTIONS.map((option) => ({
            ...option,
            disabled: !canSwitchRuleset && option.value !== summary.ruleset,
          }))}
          onChange={onSwitchRuleset}
        />
        <ButtonBase
          aria-label="Close full-map analysis"
          onClick={onClose}
          onMouseDown={preventPointerFocus}
          sx={{
            flexShrink: 0,
            width: 28,
            height: 28,
            borderRadius: "6px",
            color: REWIND_COLORS.textBright,
            "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.08)" },
          }}
        >
          <Close sx={{ fontSize: 16 }} />
        </ButtonBase>
      </Box>

      <Box
        component="section"
        aria-label="Result"
        sx={{
          display: "flex",
          alignItems: "baseline",
          gap: "52px",
          p: "26px 0 20px",
          boxShadow: HAIRLINE_BELOW,
          // No overflow: hidden as in the mock: it would clip the star rating without a word.
          [NARROW_RESULT_ROW]: { gap: "32px" },
          ...inSmallWindow({ flexWrap: "wrap", rowGap: "20px" }),
        }}
      >
        <ResultStat name={`Rank ${grade}${failed ? ", failed replay" : ""}`} label={failed ? "RANK · FAILED" : "RANK"}>
          <Box sx={{ ...fullMapBig, fontWeight: 600, letterSpacing: "-0.02em", color: gradeColor }}>{grade}</Box>
        </ResultStat>
        <ResultStat label="ACCURACY">
          <Box aria-label={`Accuracy ${accuracy === undefined ? "—" : `${accuracy}%`}`} sx={fullMapBig}>
            {accuracy === undefined ? (
              "—"
            ) : (
              <>
                {accuracy}
                <Box component="span" sx={{ ...fullMapUnit, fontSize: 15 }}>
                  %
                </Box>
              </>
            )}
          </Box>
        </ResultStat>
        <FullMapPerformanceSummary metric="pp" performance={performance} failed={failed} />
        <FullMapPerformanceSummary metric="sr" performance={performance} />
        <ResultStat
          label="MAX COMBO"
          labelTitle={mapMaxCombo === undefined ? undefined : `Map maximum: ${mapMaxCombo}`}
        >
          {comparing ? (
            <Box
              component="section"
              aria-label={`Max combo: saved ${savedMaxCombo ?? "unavailable"}, Hindsight ${
                summary.maxComboObtained ?? "unavailable"
              }`}
              sx={fullMapValue}
            >
              <Box component="span" sx={{ ...fullMapUnit, marginLeft: 0 }}>
                {"Saved "}
              </Box>
              {savedMaxCombo ?? "—"}
              <Box component="span" sx={{ ...fullMapUnit, marginLeft: 0 }}>
                {" · Hindsight "}
              </Box>
              {maxCombo}
            </Box>
          ) : (
            <Box
              aria-label={`Max combo ${maxCombo}${mapMaxCombo === undefined ? "" : ` / ${mapMaxCombo}`}`}
              sx={fullMapValue}
            >
              {maxCombo}
              {mapMaxCombo === undefined ? null : (
                <Box component="span" sx={fullMapUnit}>
                  / {mapMaxCombo}
                </Box>
              )}
            </Box>
          )}
        </ResultStat>
        <ResultStat label="UR">
          <Box aria-label={`Overall UR ${formatMetric(summary.timing.unstableRate)}`} sx={fullMapValue}>
            {formatMetric(summary.timing.unstableRate)}
          </Box>
        </ResultStat>
        <ResultStat label="MEAN OFFSET">
          <Box
            aria-label={`Mean offset ${meanOffsetValue}${meanOffsetUnit ? ` ${meanOffsetUnit}` : ""}`}
            sx={fullMapValue}
          >
            {meanOffsetValue}
            {meanOffsetUnit ? (
              <Box component="span" sx={fullMapUnit}>
                {meanOffsetUnit}
              </Box>
            ) : null}
          </Box>
        </ResultStat>
      </Box>

      {/* Two rows, as in the mock: the band of panels above, and the one graph over the map below. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateRows: "minmax(200px, 52%) minmax(0, 1fr)",
          gap: "20px",
          minHeight: 0,
          p: "18px 0 14px",
          // Stacked, each row is as tall as what is in it and the page scrolls.
          ...inSmallWindow({ gridTemplateRows: "auto auto" }),
        }}
      >
        <Box
          sx={{
            display: "grid",
            // The aim square is as wide as the band is tall, so the first column takes its width from the plot.
            // Judgements is a fixed width: its rows need no more, and the room goes to Timing and Error causes.
            gridTemplateColumns: "auto minmax(0, 1fr) 340px minmax(240px, 0.62fr)",
            gap: "36px",
            minWidth: 0,
            minHeight: 0,
            // The aim panel sizes its plot in this band's height units.
            containerType: "size",
            [NARROW_RESULT_ROW]: { gap: "24px", gridTemplateColumns: "auto minmax(0, 1fr) 300px minmax(0, 0.6fr)" },
            // The band's panels stack when the window is small, and the band is as tall as they are.
            ...inSmallWindow({ gridTemplateColumns: "minmax(0, 1fr)", gap: "20px", containerType: "normal" }),
          }}
        >
          <FullMapAimPanel aim={viewModel.aim} />
          <FullMapTimingDistribution
            timing={summary.timing}
            hitWindows={hitWindows}
            rulesetLabel={summary.ruleset === "stable" ? "Stable" : "Lazer"}
            od={footer.od}
          />
          <FullMapJudgements
            viewModel={viewModel}
            replayValidation={replayValidation}
            performance={performance}
          />
          <FullMapErrorCauses
            causes={errorCauses}
            sourceRulesetLabel={viewModel.sourceRuleset === "stable" ? "Stable" : "Lazer"}
          />
        </Box>
        <Box
          component="section"
          aria-label="Over the map"
          sx={{
            display: "grid",
            // Its head, then the graph in the room left.
            gridTemplateRows: "auto minmax(0, 1fr)",
            gap: "8px",
            minWidth: 0,
            minHeight: 0,
            // Stacked, a row is as tall as what is in it, so the graph needs a height of its own.
            ...inSmallWindow({ minHeight: 300 }),
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: "14px", minWidth: 0 }}>
            <Box component="h2" sx={{ ...fullMapSectionLabel, m: 0, whiteSpace: "nowrap" }}>
              OVER THE MAP
            </Box>
            <FullMapSegmented label="Graph" value={graph} options={GRAPH_OPTIONS} onChange={setGraph} />
            <Box sx={{ flex: 1 }} />
            {onOpenReplayAt ? (
              <Box
                component="span"
                sx={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: REWIND_COLORS.textTertiary,
                  fontSize: 12,
                }}
              >
                Click the graph to open the replay there
              </Box>
            ) : null}
          </Box>
          <Box
            sx={{
              position: "relative",
              minWidth: 0,
              minHeight: 0,
              // The graph is as large as its box, whatever height the box is given.
              "& > svg": { position: "absolute", inset: 0, width: "100%", height: "100%" },
            }}
          >
            {graph === "unstableRate" ? (
              <AverageUrOverTimeChart
                points={summary.timing.urOverTime}
                startTime={summary.startTime}
                duration={viewModel.chartEndTimeMs}
                overallUr={summary.timing.unstableRate}
                mode="current"
                peak={summary.timing.peakUr}
                marks={viewModel.marks}
                onActivate={onOpenReplayAt}
                companion={hitErrorAt}
                style={{ height: "100%" }}
              />
            ) : (
              <TimingOverTimeChart
                samples={summary.timing.samples}
                startTime={summary.startTime}
                duration={viewModel.chartEndTimeMs}
                hitWindows={hitWindowLines}
                marks={viewModel.marks}
                onActivate={onOpenReplayAt}
                companion={unstableRateAt}
                style={{ height: "100%" }}
              />
            )}
          </Box>
        </Box>
      </Box>
      <Box
        component="footer"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "22px",
          height: 40,
          minWidth: 0,
          overflow: "hidden",
          boxShadow: HAIRLINE_ABOVE,
          color: REWIND_COLORS.textTertiary,
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
      >
        <FooterFact label="Length" value={formatDuration(footer.durationMs)} />
        <FooterFact label="Circles" value={footer.hitCircleCount ?? "—"} />
        <FooterFact label="Sliders" value={footer.sliderCount ?? "—"} />
        <FooterFact label="BPM" value={finite(footer.bpm) ? Math.round(footer.bpm) : "—"} />
        <FooterFact label="CS" value={formatDifficulty(footer.cs)} />
        <FooterFact label="AR" value={formatDifficulty(footer.ar)} />
        <FooterFact label="OD" value={formatDifficulty(footer.od)} />
        <FooterFact label="HP" value={formatDifficulty(footer.hp)} />
        <Box sx={{ flex: 1 }} />
        {summary.timing.available ? (
          <span>
            {summary.timing.sampleCount} timed {summary.timing.sampleCount === 1 ? "hit" : "hits"}
          </span>
        ) : null}
      </Box>
    </Dialog>
  );
}
