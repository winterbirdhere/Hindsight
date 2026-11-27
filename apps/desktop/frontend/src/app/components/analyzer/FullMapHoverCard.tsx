import { Box, tooltipClasses } from "@mui/material";
import { Fragment } from "react";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

/** One line of a hover card: a label, a value with an optional unit, and an optional share (0..1) drawn as a bar. */
export interface FullMapHoverCardRow {
  label: string;
  value: string;
  unit?: string;
  share?: number;
}

const EDGE = "rgba(255,255,255,0.22)";
const BAR_TRACK = "rgba(255,255,255,0.14)";
const BAR_FILL = "rgba(245,244,241,0.6)";

/**
 * The surface of every hover card on the Full-map page, as a Tooltip's `slotProps`: near black, opaque, 2px corners
 * with a 1px edge, as wide as its content. It replaces the default tooltip's grey, padding and width cap. The theme
 * gives every Tooltip an arrow, so the arrow takes the card's fill and edge too; a card's Tooltip sets `arrow`
 * itself, so it does not depend on the theme.
 */
export const fullMapHoverCardSlotProps = {
  tooltip: {
    sx: {
      backgroundColor: REWIND_COLORS.inset,
      color: REWIND_COLORS.white,
      borderRadius: "2px",
      boxShadow: `inset 0 0 0 1px ${EDGE}, 0 6px 18px rgba(0,0,0,0.6)`,
      padding: "8px 11px 9px",
      maxWidth: "none",
      fontFamily: REWIND_FONTS.ui,
      fontSize: 12.5,
      fontWeight: 400,
      lineHeight: "normal",
    },
  },
  arrow: {
    sx: {
      // The pseudo-element paints the arrow with currentColor.
      color: REWIND_COLORS.inset,
      "&::before": { boxShadow: `inset 0 0 0 1px ${EDGE}` },
      // 1px into the card, so the card's own edge does not run along the arrow's base. `translate`, because Popper
      // owns the arrow's `transform`.
      translate: "0 1px",
      [`.${tooltipClasses.popper}[data-popper-placement*="top"] &`]: { translate: "0 -1px" },
    },
  },
} as const;

const isShare = (share: number | undefined): share is number => share !== undefined && Number.isFinite(share);

/**
 * A hover card: labels and values in two columns. A row with a share gets a 2px bar under it, but only when at least
 * two rows have one: a lone bar compares nothing. There is no sentence of explanation in a card.
 */
export function FullMapHoverCard({ rows }: { rows: readonly FullMapHoverCardRow[] }) {
  const bars = rows.filter((row) => isShare(row.share)).length >= 2;
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "auto auto",
        columnGap: "22px",
        rowGap: "5px",
        alignItems: "baseline",
      }}
    >
      {rows.map((row) => (
        <Fragment key={row.label}>
          <Box
            component="span"
            sx={{
              fontFamily: REWIND_FONTS.ui,
              fontSize: 12.5,
              fontWeight: 400,
              color: REWIND_COLORS.textBright,
              whiteSpace: "nowrap",
            }}
          >
            {row.label}
          </Box>
          <Box
            component="span"
            sx={{
              justifySelf: "end",
              textAlign: "right",
              fontFamily: REWIND_FONTS.ui,
              fontSize: 13.5,
              fontWeight: 600,
              color: REWIND_COLORS.white,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
            }}
          >
            {row.value}
            {row.unit ? (
              <Box
                component="span"
                sx={{
                  fontSize: 11.5,
                  fontWeight: 400,
                  color: REWIND_COLORS.textBright,
                  marginLeft: "3px",
                  letterSpacing: 0,
                }}
              >
                {row.unit}
              </Box>
            ) : null}
          </Box>
          {bars && isShare(row.share) ? (
            <Box
              data-testid="hover-card-bar"
              aria-hidden="true"
              sx={{
                gridColumn: "1 / -1",
                height: 2,
                backgroundColor: BAR_TRACK,
                marginBottom: "5px",
                "&:last-child": { marginBottom: 0 },
              }}
            >
              <Box
                sx={{
                  height: "100%",
                  width: `${Math.min(1, Math.max(0, row.share)) * 100}%`,
                  backgroundColor: BAR_FILL,
                }}
              />
            </Box>
          ) : null}
        </Fragment>
      ))}
    </Box>
  );
}
