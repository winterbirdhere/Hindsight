import { ButtonBase, type ButtonBaseProps } from "@mui/material";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";

const FOCUS_RING = { outline: `2px solid ${REWIND_COLORS.focus}`, outlineOffset: 3 } as const;

const GLOW_SHADOW =
  "inset 0 0 0 1px rgba(255,122,160,.55), inset 0 1px 0 rgba(255,255,255,.08), 0 0 0 5px rgba(255,84,104,.07), 0 10px 30px rgba(255,84,104,.18)";
const GLOW_SHADOW_HOVER =
  "inset 0 0 0 1px rgba(255,150,180,.8), inset 0 1px 0 rgba(255,255,255,.1), 0 0 0 6px rgba(255,84,104,.1), 0 10px 34px rgba(255,84,104,.26)";

/** The pink-glow primary button of the stage states (README §8). With `href` it is a link to an external page. */
export function GlowButton({ href, sx, ...props }: ButtonBaseProps & { href?: string }) {
  const link = href ? { href, target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <ButtonBase
      disableRipple
      {...link}
      {...props}
      sx={[
        {
          height: 44,
          px: "20px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          borderRadius: "10px",
          backgroundColor: "#1c1d22",
          color: REWIND_COLORS.white,
          font: `600 14px ${REWIND_FONTS.ui}`,
          whiteSpace: "nowrap",
          boxShadow: GLOW_SHADOW,
          "&:hover": { backgroundColor: "#23242a", boxShadow: GLOW_SHADOW_HOVER },
          "&.Mui-focusVisible": FOCUS_RING,
          "&.Mui-disabled": { opacity: 0.4, pointerEvents: "none" },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}

/** The quiet secondary action next to a `GlowButton`. */
export function GhostButton({ sx, ...props }: ButtonBaseProps) {
  return (
    <ButtonBase
      disableRipple
      {...props}
      sx={[
        {
          height: 44,
          px: "16px",
          display: "flex",
          alignItems: "center",
          borderRadius: "10px",
          backgroundColor: "transparent",
          color: REWIND_COLORS.textMuted,
          font: `500 14px ${REWIND_FONTS.ui}`,
          whiteSpace: "nowrap",
          "&:hover": { backgroundColor: "rgba(255,255,255,0.06)", color: REWIND_COLORS.white },
          "&.Mui-focusVisible": FOCUS_RING,
          "&.Mui-disabled": { opacity: 0.4, pointerEvents: "none" },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}
