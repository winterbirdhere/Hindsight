import { Box } from "@mui/material";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";

const BAR = "rgba(255,255,255,0.07)";

const sectionLabel = {
  fontFamily: REWIND_FONTS.mono,
  fontWeight: 500,
  fontSize: 11,
  letterSpacing: "0.08em",
  color: REWIND_COLORS.textTertiary,
} as const;

/** A decorative outline bar; static on purpose (no shimmer). */
function Bar({ width, height }: { width: string; height: number }) {
  return <Box aria-hidden="true" component="span" sx={{ display: "block", width, height, borderRadius: "3px", backgroundColor: BAR }} />;
}

function LoadingRow() {
  return (
    <Box sx={{ p: "12px 18px", display: "flex", flexDirection: "column", gap: "8px", boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairlineSoft}` }}>
      <Bar width="45%" height={11} />
      <Bar width="70%" height={9} />
    </Box>
  );
}

/** What fills the inspector below its header until a replay is ready (README §4.2, cards 7d, 7e, 7f). */
export function InspectorPlaceholder({ state }: { state: ReplayLoadState }) {
  if (state.phase === "idle") {
    return (
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center", p: "0 32px 60px" }}>
        <Box component="span" sx={{ fontSize: 13, lineHeight: 1.5, color: REWIND_COLORS.textTertiary, textAlign: "center", textWrap: "pretty" }}>
          The map, player and incidents appear here once a replay is open.
        </Box>
      </Box>
    );
  }
  if (state.phase === "loading") {
    return (
      <Box aria-busy="true" sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Box sx={{ p: "18px", display: "flex", flexDirection: "column", gap: "14px", boxShadow: `inset 0 -1px 0 ${REWIND_COLORS.hairline}` }}>
          <Box component="span" sx={sectionLabel}>
            ERRORS
          </Box>
          <Bar width="60%" height={22} />
          <Bar width="80%" height={12} />
          <Box
            aria-hidden="true"
            sx={{ height: 56, backgroundColor: "rgba(255,255,255,0.04)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)" }}
          />
        </Box>
        <Box sx={{ p: "12px 18px 6px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Box component="span" sx={{ fontWeight: 600, fontSize: 13.5 }}>
            Incidents
          </Box>
          <Box component="span" sx={{ fontSize: 12, color: REWIND_COLORS.textTertiary }}>
            Waiting for simulation
          </Box>
        </Box>
        <LoadingRow />
        <LoadingRow />
        <LoadingRow />
      </Box>
    );
  }
  return (
    <Box sx={{ p: "18px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <Box component="span" sx={sectionLabel}>
        ERRORS
      </Box>
      <Box component="span" sx={{ fontSize: 13, color: REWIND_COLORS.textSecondary }}>
        Nothing to show until the replay loads.
      </Box>
    </Box>
  );
}
