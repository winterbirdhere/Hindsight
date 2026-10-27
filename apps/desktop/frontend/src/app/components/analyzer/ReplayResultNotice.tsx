import { Box, Tooltip } from "@mui/material";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import type { ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import { replayResultDifferences } from "../../services/analysis/replay-result-differences";
import { REWIND_COLORS, REWIND_FOCUS_RING } from "../../styles/tokens";
import { fullMapHoverCardSlotProps } from "./FullMapHoverCard";
import { FULL_MAP_HEAD_HEIGHT } from "./full-map-styles";

export interface ReplayResultNoticeProps {
  validation: ReplaySimulationValidation;
  sourceRuleset: ReplayAnalysisRuleset;
  ruleset: ReplayAnalysisRuleset;
}

/** The three lines of the note's card: what is known, the cause that is only possible, and which counts the analysis uses. */
function SavedScoreCard({ sourceRuleset }: { sourceRuleset: ReplayAnalysisRuleset }) {
  return (
    <Box sx={{ maxWidth: 250, fontSize: 12.5, lineHeight: 1.4 }}>
      <Box sx={{ color: REWIND_COLORS.white, fontWeight: 600 }}>Cause not confirmed</Box>
      <Box sx={{ color: REWIND_COLORS.textBright, fontWeight: 400 }}>
        {sourceRuleset === "stable"
          ? "Possibly a resume keypress read as an early tap."
          : "Possibly missing replay data or a simulation error."}
      </Box>
      <Box sx={{ color: REWIND_COLORS.textBright, fontWeight: 400, mt: "6px" }}>Analysis uses Hindsight’s counts.</Box>
    </Box>
  );
}

/**
 * Says in the Judgements head that the saved score is not Hindsight's, when the page shows both side by side. It is
 * a line of quiet text with a hover card, on hover and on keyboard focus; the counts themselves are the page's columns.
 */
export function ReplayResultNotice({ validation, sourceRuleset, ruleset }: ReplayResultNoticeProps) {
  const { differences } = replayResultDifferences(validation);
  // A different ruleset is an intentional reconstruction, not a saved-data mismatch.
  if (sourceRuleset !== ruleset || !differences.length) return null;

  return (
    <Tooltip
      arrow
      describeChild
      placement="bottom-end"
      slotProps={fullMapHoverCardSlotProps}
      title={<SavedScoreCard sourceRuleset={sourceRuleset} />}
    >
      <Box
        component="span"
        role="note"
        aria-label="Saved score differs"
        tabIndex={0}
        sx={{
          fontSize: 12,
          fontWeight: 500,
          // The head's line, so the head is as tall as the other panels'.
          lineHeight: `${FULL_MAP_HEAD_HEIGHT}px`,
          whiteSpace: "nowrap",
          color: REWIND_COLORS.textSecondary,
          "&:focus-visible": REWIND_FOCUS_RING,
        }}
      >
        Saved score differs
      </Box>
    </Tooltip>
  );
}
