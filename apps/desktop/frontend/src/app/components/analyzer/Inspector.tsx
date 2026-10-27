import { Box } from "@mui/material";
import { useReplayLoadState } from "../../hooks/replay-load-state";
import { useInspector } from "../../providers/InspectorProvider";
import { REWIND_COLORS } from "../../styles/tokens";
import { ExportPanel } from "../export/ExportPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { IncidentBlock } from "./IncidentBlock";
import { IncidentsList } from "./IncidentsList";
import { InspectorHeader } from "./InspectorHeader";
import { InspectorPlaceholder } from "./InspectorPlaceholder";

/**
 * The inspector column: the incidents, or Settings or the Export panel in their place. Each replaces the header and the
 * incidents or the loading placeholder alike, in every load phase.
 */
export function Inspector() {
  const loadState = useReplayLoadState();
  const { mode } = useInspector();
  const ready = loadState.phase === "ready";
  return (
    <Box
      component="aside"
      aria-label="Inspector"
      sx={{
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        backgroundColor: REWIND_COLORS.surface,
        boxShadow: `inset 1px 0 0 ${REWIND_COLORS.hairline}`,
        color: REWIND_COLORS.textPrimary,
        fontSize: 13,
        lineHeight: 1.4,
        overflow: "hidden",
      }}
    >
      {mode === "settings" ? (
        <SettingsPanel />
      ) : mode === "export" ? (
        <ExportPanel />
      ) : (
        <>
          <InspectorHeader />
          {ready ? (
            <>
              <IncidentBlock />
              <IncidentsList />
            </>
          ) : (
            <InspectorPlaceholder state={loadState} />
          )}
        </>
      )}
    </Box>
  );
}
