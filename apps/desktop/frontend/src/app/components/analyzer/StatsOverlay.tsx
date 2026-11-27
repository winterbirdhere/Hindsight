import { Box } from "@mui/material";
import { Fragment } from "react";
import { useObservable } from "rxjs-hooks";
import { useReadoutModel } from "../../hooks/readout";
import { useCommonManagers } from "../../providers/TheaterProvider";
import { STATS_OVERLAY } from "../../screens/analyzer/analyzer-layout";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

const Divider = () => <Box data-divider sx={{ height: "1px", backgroundColor: REWIND_COLORS.statDivider }} />;
const mono = (weight: number, size: number) => ({ fontFamily: REWIND_FONTS.mono, fontWeight: weight, fontSize: size }) as const;
// With the shade the text needs only a soft shadow. Without it the art can be any colour: a tight dark edge on every
// side, then a soft halo.
const SHADED_TEXT_SHADOW = "0 1px 3px rgba(0,0,0,0.85)";
const OUTLINED_TEXT_SHADOW = "0 0 2px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95), 0 1px 4px rgba(0,0,0,0.9), 0 0 12px rgba(0,0,0,0.6)";

/** Live stats in the art margin left of the playfield (README §4.1). The live stage reserves its strip; the shell hides it only when the stage is under 460 px wide. */
export function StatsOverlay() {
  const model = useReadoutModel();
  const { beatmapBackgroundSettingsStore } = useCommonManagers();
  const { statsShade } = useObservable(() => beatmapBackgroundSettingsStore.settings$, beatmapBackgroundSettingsStore.settings);
  if (!model) return null;
  // Without the shade the grey labels go one step brighter.
  const quiet = statsShade ? REWIND_COLORS.textSecondary : REWIND_COLORS.textBright;
  const { performance, rows, judgements } = model;
  const groups = [
    performance && (performance.pp !== undefined || performance.stars !== undefined) && (
      <Box key="performance" sx={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {performance.pp !== undefined && (
          <Box component="span" sx={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
            <Box component="span" sx={{ fontSize: 32, fontWeight: 300, lineHeight: 1, letterSpacing: "-0.04em" }}>
              {performance.pp}
            </Box>
            <Box component="span" sx={{ ...mono(400, 13), color: quiet }}>
              pp
            </Box>
          </Box>
        )}
        {performance.stars !== undefined && (
          <Box component="span" sx={{ ...mono(500, 15), color: REWIND_COLORS.star }}>{`★ ${performance.stars}`}</Box>
        )}
      </Box>
    ),
    rows.length > 0 && (
      <Box key="rows" sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {rows.map((row) => (
          <Box key={row.key} component="span" sx={{ display: "flex", flexDirection: "column", gap: "1px" }}>
            <Box component="span" sx={{ fontSize: 11.5, color: quiet }}>
              {row.label}
            </Box>
            <Box component="span" sx={mono(500, 17)}>
              {row.value}
              {row.suffix && (
                <Box component="span" sx={{ fontSize: 12, color: quiet }}>
                  {row.suffix}
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    ),
    judgements.length > 0 && (
      <Box key="judgements" sx={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: "7px", alignItems: "baseline" }}>
        {judgements.map((row) => (
          <Fragment key={row.key}>
            <Box component="span" sx={{ fontWeight: 600, fontSize: row.key === "sliderBreak" || row.key === "sliderEnd" ? 12.5 : 13, color: row.color }}>
              {row.label}
            </Box>
            <Box component="span" sx={mono(500, 16)}>
              {row.count}
            </Box>
          </Fragment>
        ))}
      </Box>
    ),
  ].filter(Boolean);
  return (
    <>
      {statsShade && <Box
        aria-hidden
        data-testid="stats-scrim"
        sx={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 150,
          zIndex: 1,
          pointerEvents: "none",
          background: "linear-gradient(90deg, rgba(12,12,14,0.8), rgba(12,12,14,0.55) 72%, rgba(12,12,14,0))",
        }}
      />}
      <Box
        component="aside"
        aria-label="Replay stats"
        sx={{
          position: "absolute",
          left: STATS_OVERLAY.left,
          top: STATS_OVERLAY.top,
          width: STATS_OVERLAY.width,
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
          gap: "13px",
          pointerEvents: "none",
          color: REWIND_COLORS.textPrimary,
          lineHeight: "normal",
          fontVariantNumeric: "tabular-nums",
          textShadow: statsShade ? SHADED_TEXT_SHADOW : OUTLINED_TEXT_SHADOW,
        }}
      >
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <Divider />}
            {group}
          </Fragment>
        ))}
      </Box>
    </>
  );
}
