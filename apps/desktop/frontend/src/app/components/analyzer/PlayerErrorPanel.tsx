import { Typography } from "@mui/material";
import { memo } from "react";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ReplayDisplaySettings } from "../../services/analysis/replay-display-settings";
import { REWIND_COLORS } from "../../styles/tokens";
import { presentCause } from "./error-cause-presentation";

export interface PlayerErrorCauseProps {
  /** The navigator owns current replay/profile and exact scoring-event scope. */
  mechanisms: readonly ComponentMechanism[];
  displayMode?: ReplayDisplaySettings["errorCauseDisplay"];
  /** "row" is the quiet one-line form; only the selected row announces itself. */
  variant?: "toolbar" | "row";
  announce?: boolean;
}

/** Presentation only: reject unranked diagnoses without selecting their first causes. */
export const PlayerErrorCause = memo(function PlayerErrorCause({
  mechanisms,
  displayMode = "concise",
  variant = "toolbar",
  announce = false,
}: PlayerErrorCauseProps) {
  const presentation = presentCause(mechanisms, displayMode);
  if (!presentation) return null;
  const { labels: distinctLabels, detail } = presentation;
  const row = variant === "row";
  const announced = !row || announce;
  return (
    <Typography
      component="span"
      role={announced ? "status" : undefined}
      aria-label={announced ? "Error cause" : undefined}
      sx={
        row
          ? { display: "block", fontSize: 11.5, fontWeight: 400, color: announce ? REWIND_COLORS.textSecondary : REWIND_COLORS.textTertiary }
          : { fontSize: 14, fontWeight: 600, color: "#c5cbd5" }
      }
    >
      {distinctLabels.join(" · ")}
      {detail?.phrase ? ` · ${detail.phrase}` : ""}
      {detail?.metric ? ` · ${Math.round(detail.metric.value)} ${detail.metric.unit}` : ""}
    </Typography>
  );
});
