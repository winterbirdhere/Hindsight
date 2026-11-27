import { Box, ListSubheader, Menu, MenuItem } from "@mui/material";
import { memo, useCallback, useState } from "react";
import { useGameClockTime } from "../../hooks/game-clock";
import { type MemberLabel, summarizeIncident } from "../../services/analysis/incident-summary";
import type { DensityBin, Incident } from "../../services/analysis/incidents";
import type { ReplayError } from "../../services/analysis/replay-events";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { ERROR_TYPE_COLOR, splitErrorTime } from "./incident-format";

const BIN_COLOR: Record<DensityBin["tone"], string> = {
  empty: "rgba(255,255,255,0.12)",
  miss: REWIND_COLORS.judgementMiss,
  break: REWIND_COLORS.sliderBreak,
};

/** A raised sheet one step above the inspector surface, so the chooser reads as a small slice of the incidents list. */
const CHOOSER_SURFACE = "#22232a";

/** The only part that moves with the clock: a 2 px mark. */
function DensityPlayhead({ duration }: { duration: number }) {
  const currentTime = useGameClockTime(15);
  const playhead = duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  return (
    <Box
      aria-hidden
      data-density-playhead
      style={{ left: `${playhead}%` }}
      sx={{ position: "absolute", bottom: "1px", width: 2, ml: "-0.5px", height: 18, backgroundColor: REWIND_COLORS.textPrimary, pointerEvents: "none" }}
    />
  );
}

const DensityBins = memo(function DensityBins({
  bins,
  onPick,
}: {
  bins: readonly DensityBin[];
  onPick(bin: DensityBin, element: HTMLElement): void;
}) {
  return (
    <>
      {bins.map((bin, index) => (
        <Box
          key={index}
          aria-hidden
          data-density-bin
          onClick={bin.leadIndices.length ? (event) => onPick(bin, event.currentTarget) : undefined}
          sx={{
            flex: 1,
            // The whole column is the hit target; the bar itself is drawn at the bottom.
            height: "100%",
            display: "flex",
            alignItems: "flex-end",
            cursor: bin.leadIndices.length ? "pointer" : "default",
          }}
        >
          {/* A px string: in `sx` a bare 1 (an empty bin) would be 100 %, not 1 px. */}
          <Box data-density-bar sx={{ width: "100%", height: `${bin.height}px`, backgroundColor: BIN_COLOR[bin.tone] }} />
        </Box>
      ))}
    </>
  );
});

interface DensityBarProps {
  bins: readonly DensityBin[];
  incidents: readonly Incident[];
  errors: readonly ReplayError[];
  labelOf(errorIndex: number): MemberLabel;
  duration: number;
  baseRate: number;
  onSelect(incidentIndex: number): void;
}

/**
 * Incidents per stretch of the map. A bin with one incident selects it; a bin with several opens a chooser,
 * so nothing is picked for the user. Only a click acts: hovering does nothing.
 */
export function DensityBar({ bins, incidents, errors, labelOf, duration, baseRate, onSelect }: DensityBarProps) {
  const [chooser, setChooser] = useState<{ anchor: HTMLElement; leadIndices: number[]; open: boolean } | null>(null);
  const incidentOfLead = useCallback(
    (leadIndex: number) => incidents.findIndex((incident) => incident.leadIndex === leadIndex),
    [incidents],
  );
  const pick = useCallback(
    (bin: DensityBin, anchor: HTMLElement) => {
      if (bin.leadIndices.length === 1) onSelect(incidentOfLead(bin.leadIndices[0]));
      else setChooser({ anchor, leadIndices: bin.leadIndices, open: true });
    },
    [incidentOfLead, onSelect],
  );
  const close = () => setChooser((current) => (current ? { ...current, open: false } : current));
  // A regrouping may have dissolved a lead while the chooser is open; such an entry is dropped.
  const choices = (chooser?.leadIndices ?? []).map(incidentOfLead).filter((incidentIndex) => incidentIndex >= 0);

  return (
    <Box
      title="Incidents per stretch of the map"
      sx={{ position: "relative", height: 22, display: "flex", alignItems: "flex-end", gap: "1px", boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.14)" }}
    >
      <DensityBins bins={bins} onPick={pick} />
      <DensityPlayhead duration={duration} />
      <Menu
        open={Boolean(chooser?.open)}
        anchorEl={chooser?.anchor}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        PaperProps={{
          sx: {
            // Below the narrowest inspector (240 px), so the chooser fits beside the window's right edge.
            minWidth: 224,
            maxWidth: "calc(100vw - 16px)",
            borderRadius: "8px",
            backgroundColor: CHOOSER_SURFACE,
            backgroundImage: "none",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1), 0 12px 32px rgba(0,0,0,0.5)",
          },
        }}
        MenuListProps={{ "aria-label": "Incidents here", dense: true, sx: { py: "4px" } }}
      >
        {/* ListSubheader is skipped by MUI's list highlight, so the first real item takes focus. */}
        <ListSubheader
          disableSticky
          sx={{
            px: "14px",
            pt: "6px",
            pb: "4px",
            fontFamily: REWIND_FONTS.mono,
            fontWeight: 500,
            fontSize: 10.5,
            lineHeight: "16px",
            letterSpacing: "0.08em",
            backgroundColor: "transparent",
            color: REWIND_COLORS.textTertiary,
          }}
        >
          {choices.length === 1 ? "1 INCIDENT HERE" : `${choices.length} INCIDENTS HERE`}
        </ListSubheader>
        {choices.map((incidentIndex, position) => {
          const incident = incidents[incidentIndex];
          const summary = summarizeIncident(incident, labelOf);
          const bar = `inset 3px 0 0 ${ERROR_TYPE_COLOR[errors[incident.leadIndex].type]}`;
          return (
            <MenuItem
              key={incident.id}
              onClick={() => {
                close();
                onSelect(incidentIndex);
              }}
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                gap: "2px",
                py: "8px",
                px: "14px",
                minHeight: 0,
                whiteSpace: "normal",
                boxShadow: position < choices.length - 1 ? `${bar}, inset 0 -1px 0 ${REWIND_COLORS.hairlineSoft}` : bar,
                "&:hover, &.Mui-focusVisible": { backgroundColor: "rgba(255,255,255,0.06)" },
                "&.Mui-focusVisible": { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: -2 },
              }}
            >
              <Box component="span" sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "16px" }}>
                <Box component="span" sx={{ minWidth: 0, fontWeight: 600, fontSize: 13.5, lineHeight: "18px", color: REWIND_COLORS.textPrimary }}>
                  {summary.causeChain}
                </Box>
                <Box component="span" sx={{ flex: "none", fontFamily: REWIND_FONTS.mono, fontSize: 12, color: REWIND_COLORS.textSoft }}>
                  {splitErrorTime(errors[incident.leadIndex].time / baseRate).join("")}
                </Box>
              </Box>
              <Box component="span" sx={{ fontSize: 12, lineHeight: "16px", color: REWIND_COLORS.textSecondary }}>
                {summary.typeChain}
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
}
