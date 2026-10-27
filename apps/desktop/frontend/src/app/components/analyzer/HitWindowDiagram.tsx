import { Box } from "@mui/material";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { hitWindowsForOD } from "@osujs/math";
import { stableHitWindowsForOD } from "../../../../../../../libs/osu/core/src/gameplay/StableDifficulty";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { buildHitWindowDiagram } from "./hit-window-diagram";

const SEGMENT_COLOR = { "50": REWIND_COLORS.hitWindow50, "100": REWIND_COLORS.hitWindow100, "300": REWIND_COLORS.hitWindow300 } as const;

/**
 * Where the press landed in the real hit windows (README §4.1). No key label: the cause carries timing only.
 * `ruleset` is the profile the cause was computed for, not whatever is focused now.
 */
export function HitWindowDiagram({ offsetMs, ruleset }: { offsetMs: number; ruleset: ReplayAnalysisRuleset }) {
  const analyzer = useAnalysisApp();
  // `getBeatmap()` returns a placeholder map when nothing is loaded; without a replay there are no real windows to draw.
  if (!analyzer.gameSimulator.getPrimaryReplay()) return null;
  const beatmap = analyzer.getBeatmap();
  const windows =
    ruleset === "lazer"
      ? hitWindowsForOD(beatmap.difficulty.overallDifficulty, true)
      : stableHitWindowsForOD(beatmap.stableOverallDifficulty);
  const model = buildHitWindowDiagram(offsetMs, windows, beatmap.gameClockRate);
  if (!model) return null;
  return (
    <Box
      role="img"
      aria-label={`Hit window, press ${model.label}`}
      sx={{ position: "relative", height: 56, backgroundColor: REWIND_COLORS.bg, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}
    >
      <Box aria-hidden sx={{ position: "absolute", left: "14%", right: "14%", top: 19, height: 6, display: "flex" }}>
        {model.segments.map((segment, index) => (
          <Box key={index} sx={{ flex: segment.flex, backgroundColor: SEGMENT_COLOR[segment.kind] }} />
        ))}
      </Box>
      <Box aria-hidden sx={{ position: "absolute", left: "50%", top: 10, width: 2, ml: "-1px", height: 24, backgroundColor: REWIND_COLORS.white }} />
      <Box
        aria-hidden
        sx={{ position: "absolute", left: `${model.markPercent}%`, top: 9, width: 3, ml: "-1.5px", height: 26, backgroundColor: REWIND_COLORS.pressMark }}
      />
      <Box
        component="span"
        sx={{
          position: "absolute",
          left: `${model.markPercent}%`,
          top: 38,
          // Keep the label inside the box at both ends of the band.
          transform: `translateX(-${model.markPercent}%)`,
          fontFamily: REWIND_FONTS.mono,
          fontWeight: 500,
          fontSize: 11,
          color: REWIND_COLORS.textPrimary,
          whiteSpace: "nowrap",
        }}
      >
        {model.label}
      </Box>
    </Box>
  );
}
