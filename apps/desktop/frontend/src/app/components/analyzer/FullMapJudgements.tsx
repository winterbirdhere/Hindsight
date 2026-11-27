import { Box, Tooltip } from "@mui/material";
import { type ReactNode, useRef } from "react";
import type { FullMapAnalysisViewModel } from "../../services/analysis/full-map-analysis-view-model";
import type { FullMapPerformance } from "../../services/analysis/performance/PerformanceTimelineService";
import { replayResultDifferences } from "../../services/analysis/replay-result-differences";
import type { ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import { thinScrollbar } from "../../styles/scrollbar";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { AnalysisSliderLabels } from "../../utils/constants";
import { ReplayResultNotice } from "./ReplayResultNotice";
import { FullMapHoverCard, fullMapHoverCardSlotProps } from "./FullMapHoverCard";
import { finite, formatEffectiveMiss, formatPercent } from "./full-map-format";
import { fullMapLabel, fullMapPanel, fullMapPanelHead, fullMapSectionLabel, inSmallWindow } from "./full-map-styles";

const HAIRLINE_BELOW = `inset 0 -1px 0 ${REWIND_COLORS.hairlineSoft}`;
/** Name, count, share; with the saved score beside Rewind's, a column for each count. */
const COLUMNS = "minmax(0, 1fr) auto 76px";
const COMPARISON_COLUMNS = "minmax(0, 1fr) 56px 56px 76px";

const countStyle = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 17,
  fontWeight: 500,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
} as const;
const shareStyle = {
  fontSize: 13,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  color: REWIND_COLORS.textTertiary,
} as const;
const columnNameStyle = { ...fullMapLabel, textAlign: "right" } as const;
/** A row is an equal share of the panel's height, but never shorter or taller than this. */
const ROW_MIN_HEIGHT = 26;
const ROW_MAX_HEIGHT = 56;

/** One line of the list. To add a row, add one of these where it belongs in `rows`. */
interface JudgementRow {
  /** Names the row's region, e.g. `MISS: 1`. */
  name: string;
  label: string;
  color: string;
  /** Written as given: a whole number, or already formatted text (a dash when it is not known). */
  count: number | string;
  /**
   * Given (even as `null`, when unknown) for the four judgements: they have a share and, in a comparison, the saved
   * count beside Rewind's. Left out for a row that is only a count.
   */
  share?: number | null;
  saved?: number;
  savedTitle?: string;
  /** Makes the row focusable and shows this card on hover and on focus. */
  tooltip?: ReactNode;
}

/**
 * Whether the saved score can be set beside Rewind's: only in the replay's own ruleset (another ruleset is a
 * reconstruction, not a disagreement), and only when the two differ.
 */
export function canCompareSavedScore(
  viewModel: FullMapAnalysisViewModel,
  replayValidation: ReplaySimulationValidation | undefined,
): boolean {
  return (
    viewModel.summary.ruleset === viewModel.sourceRuleset &&
    replayResultDifferences(replayValidation).differences.length > 0
  );
}

/** Every judgement by result: the four shares as one bar, then a row each, the slider metrics last. */
export function FullMapJudgements({
  viewModel,
  replayValidation,
  performance,
}: {
  viewModel: FullMapAnalysisViewModel;
  replayValidation?: ReplaySimulationValidation;
  /** Where the official pp algorithm's effective miss count comes from. */
  performance?: FullMapPerformance;
}) {
  const { summary, resultPercentages } = viewModel;
  // The count of each row that has a card: the card points at it, not at the middle of the row.
  const countCells = useRef<Record<string, HTMLElement | null>>({});
  const { postFailureMissCount } = replayResultDifferences(replayValidation);
  // The saved score is set beside Hindsight's whenever the two differ; there is nothing to switch on.
  const comparing = canCompareSavedScore(viewModel, replayValidation);
  const stable = summary.ruleset === "stable";
  // Only the count of a finished PP calculation; while it loads, or if it failed, there is no number to show. The
  // Miss row explains it on hover, and only when there is a miss and a number to explain.
  const effectiveMiss = performance?.status === "ready" ? performance.effectiveMissCount : undefined;
  const showEffectiveMiss = summary.judgements.countMiss > 0 && finite(effectiveMiss) && effectiveMiss >= 0;
  const rows: JudgementRow[] = [
    {
      name: "300",
      label: "300",
      color: REWIND_COLORS.judgement300,
      count: summary.judgements.count300,
      share: resultPercentages.count300,
      saved: replayValidation?.expectedCounts?.[0],
    },
    {
      name: "100",
      label: "100",
      color: REWIND_COLORS.judgement100,
      count: summary.judgements.count100,
      share: resultPercentages.count100,
      saved: replayValidation?.expectedCounts?.[1],
    },
    {
      name: "50",
      label: "50",
      color: REWIND_COLORS.judgement50,
      count: summary.judgements.count50,
      share: resultPercentages.count50,
      saved: replayValidation?.expectedCounts?.[2],
    },
    {
      name: "MISS",
      label: "Miss",
      color: REWIND_COLORS.judgementMiss,
      count: summary.judgements.countMiss,
      share: resultPercentages.countMiss,
      saved: replayValidation?.expectedCounts?.[3],
      savedTitle:
        postFailureMissCount === undefined ? undefined : `Saved includes ${postFailureMissCount} misses after failure.`,
      tooltip: showEffectiveMiss ? (
        <FullMapHoverCard rows={[{ label: "Effective miss", value: formatEffectiveMiss(effectiveMiss) }]} />
      ) : undefined,
    },
    {
      name: viewModel.sliderMetric.label,
      label: stable ? AnalysisSliderLabels.SLIDER_BREAK : AnalysisSliderLabels.SLIDER_TICK_MISS,
      color: REWIND_COLORS.sliderBreak,
      count: viewModel.sliderMetric.value,
    },
    {
      name: "SLIDER END",
      label: AnalysisSliderLabels.SLIDER_END_MISS,
      color: REWIND_COLORS.sliderEnd,
      count: viewModel.sliderEndMissCount,
    },
  ];
  const shares = [
    { key: "300", share: resultPercentages.count300, color: REWIND_COLORS.judgement300 },
    { key: "100", share: resultPercentages.count100, color: REWIND_COLORS.judgement100 },
    { key: "50", share: resultPercentages.count50, color: REWIND_COLORS.judgement50 },
    { key: "miss", share: resultPercentages.countMiss, color: REWIND_COLORS.judgementMiss },
  ];
  const columns = comparing ? COMPARISON_COLUMNS : COLUMNS;

  return (
    <Box
      component="section"
      aria-label="Judgements"
      sx={{ ...fullMapPanel, gridTemplateRows: "auto minmax(0, 1fr)", ...inSmallWindow({ minHeight: 260 }) }}
    >
      {/* The column is narrower than its head can be: the note goes under the label rather than runs out of it. */}
      <Box sx={{ ...fullMapPanelHead, flexWrap: "wrap", rowGap: "4px" }}>
        {/* At the head's top, where the other panels' names are, whatever the note beside it does to the head. */}
        <Box component="h2" sx={{ ...fullMapSectionLabel, m: 0, alignSelf: "flex-start" }}>
          JUDGEMENTS
        </Box>
        {comparing && replayValidation && (
          <Box sx={{ minWidth: 0, ml: "auto" }}>
            <ReplayResultNotice
              validation={replayValidation}
              ruleset={summary.ruleset}
              sourceRuleset={viewModel.sourceRuleset}
            />
          </Box>
        )}
      </Box>
      {/* The rows share the height the panel has. If it is less than they need, they scroll rather than run into what is below. */}
      <Box
        sx={{
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          // The panel's 10px and 4px more: the first thing (the bar, or the first row or the compare header when
          // there is none) starts 14px under the head.
          pt: "4px",
          overflowY: "auto",
          ...thinScrollbar,
          ...inSmallWindow({ overflowY: "visible" }),
        }}
      >
        {/* A bar of four parts is only true when all four shares are known. */}
        {shares.every(({ share }) => finite(share)) ? (
          <Box
            data-testid="judgement-share"
            aria-hidden="true"
            sx={{
              display: "flex",
              flex: "none",
              height: 6,
              // 12px above the first row or the compare header.
              m: "0 0 12px",
              borderRadius: "3px",
              overflow: "hidden",
              backgroundColor: REWIND_COLORS.inset,
            }}
          >
            {shares.map(({ key, share, color }) => (
              <Box key={key} sx={{ flex: `0 0 ${(share ?? 0) * 100}%`, backgroundColor: color }} />
            ))}
          </Box>
        ) : null}
        {/* Without a comparison the columns are self-evident; with one, they need their names. */}
        {comparing && (
          <Box
            aria-hidden="true"
            sx={{ display: "grid", flex: "none", gridTemplateColumns: columns, alignItems: "baseline", mb: "2px" }}
          >
            <span />
            <Box sx={columnNameStyle}>Saved</Box>
            <Box sx={columnNameStyle}>Hindsight</Box>
            <Box title="Share of Hindsight judgements" sx={columnNameStyle}>
              Share
            </Box>
          </Box>
        )}
        {rows.map((row, index) => {
          const judgement = row.share !== undefined;
          const region = (
            <Box
              component="section"
              key={row.name}
              aria-label={
                comparing && judgement
                  ? `${row.name}: saved ${row.saved ?? "unavailable"}, Hindsight ${row.count}`
                  : `${row.name}: ${row.count}`
              }
              {...(row.tooltip ? { tabIndex: 0 } : {})}
              sx={{
                // An equal share of the column with the content centred; no padding, the height is the share.
                flex: "1 1 0",
                minHeight: ROW_MIN_HEIGHT,
                maxHeight: ROW_MAX_HEIGHT,
                display: "flex",
                alignItems: "center",
                boxShadow: index === rows.length - 1 ? "none" : HAIRLINE_BELOW,
                // Inside the scrolling list an outer outline would be cut off.
                "&:focus-visible": { ...REWIND_FOCUS_RING, outlineOffset: -2 },
              }}
            >
              <Box sx={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: columns, alignItems: "baseline" }}>
                <Box
                  component="span"
                  sx={{
                    display: "flex",
                    alignItems: "baseline",
                    columnGap: "10px",
                    minWidth: 0,
                    // A row with no saved count lets its name run under that column.
                    gridColumn: comparing && !judgement ? "span 2" : undefined,
                  }}
                >
                  <Box
                    component="span"
                    data-testid="result-row-label"
                    sx={{
                      flexShrink: 0,
                      color: row.color,
                      fontSize: judgement ? 15 : 14,
                      fontWeight: 600,
                    }}
                  >
                    {row.label}
                  </Box>
                </Box>
                {comparing && judgement && (
                  <Box
                    component="span"
                    title={row.savedTitle}
                    // A saved count that is Hindsight's is quiet; the ones that differ stand out.
                    {...(row.saved !== undefined && row.saved !== row.count ? { "data-differs": "true" } : {})}
                    sx={
                      row.saved !== undefined && row.saved !== row.count
                        ? { ...countStyle, color: REWIND_COLORS.white, fontWeight: 600 }
                        : { ...countStyle, color: REWIND_COLORS.textTertiary, fontWeight: 400 }
                    }
                  >
                    {row.saved ?? "—"}
                  </Box>
                )}
                <Box
                  component="span"
                  data-testid="result-row-count"
                  ref={row.tooltip ? (cell: HTMLElement | null) => void (countCells.current[row.name] = cell) : undefined}
                  sx={countStyle}
                >
                  {row.count}
                </Box>
                {judgement ? (
                  <Box component="span" data-testid="result-row-percentage" sx={shareStyle}>
                    {formatPercent(row.share ?? null)}
                  </Box>
                ) : null}
              </Box>
            </Box>
          );
          return row.tooltip ? (
            <Tooltip
              key={row.name}
              arrow
              describeChild
              // The whole row is the target; the card sits under the count (Rewind's, beside the saved one).
              placement="bottom"
              slotProps={{
                ...fullMapHoverCardSlotProps,
                popper: { anchorEl: () => countCells.current[row.name] as HTMLElement },
              }}
              title={row.tooltip}
            >
              {region}
            </Tooltip>
          ) : (
            region
          );
        })}
      </Box>
    </Box>
  );
}
