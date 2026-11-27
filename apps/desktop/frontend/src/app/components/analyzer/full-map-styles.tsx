import { Box, ButtonBase } from "@mui/material";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";

/** The type and panel styles the Full-map analysis page's panels share (the mock's `.stat`, `.panel`, `.segmented`). */

/** One figure of the result row: its value, then its name beneath. */
export const fullMapStat = { display: "flex", flexDirection: "column", gap: "9px", whiteSpace: "nowrap" } as const;

/** The name under a stat's value. */
export const fullMapLabel = {
  fontFamily: REWIND_FONTS.mono,
  fontSize: 10.5,
  fontWeight: 500,
  lineHeight: "normal",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: REWIND_COLORS.textTertiary,
} as const;

/**
 * The height of a panel's head: the name's line. It is fixed, not "normal", so the four panels' names sit on one
 * line and the aim plot can be sized from it.
 */
export const FULL_MAP_HEAD_HEIGHT = 14;

/** The name at the head of a panel. */
export const fullMapSectionLabel = { ...fullMapLabel, fontSize: 11, lineHeight: `${FULL_MAP_HEAD_HEIGHT}px` } as const;

/** The mock's step before the result row wraps: a narrower gap, and the figures a size down. */
export const NARROW_RESULT_ROW = "@media (max-width: 1180px)";

/** The leading values of the result row. */
export const fullMapBig = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 42,
  fontWeight: 300,
  lineHeight: 0.9,
  letterSpacing: "-0.04em",
  fontVariantNumeric: "tabular-nums",
  [NARROW_RESULT_ROW]: { fontSize: 34 },
} as const;

/** The other values of the result row. */
export const fullMapValue = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 28,
  fontWeight: 300,
  lineHeight: 0.9,
  letterSpacing: "-0.03em",
  fontVariantNumeric: "tabular-nums",
  [NARROW_RESULT_ROW]: { fontSize: 24 },
} as const;

/** The unit after a value, inside the value's own element. */
export const fullMapUnit = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 13,
  fontWeight: 400,
  letterSpacing: 0,
  color: REWIND_COLORS.textSecondary,
  marginLeft: "5px",
} as const;

/** A panel: its head, a body that takes the room left, and its foot. */
export const fullMapPanel = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  gap: "10px",
  minWidth: 0,
  minHeight: 0,
} as const;

/** A panel's head: its name, and what belongs beside the name at the right. */
export const fullMapPanelHead = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "16px",
  whiteSpace: "nowrap",
} as const;

/** A panel's foot: a line of small print under its body. */
export const fullMapPanelFoot = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  fontSize: 12,
  color: REWIND_COLORS.textSecondary,
  whiteSpace: "nowrap",
} as const;

/** The height of a panel head's text button: taller than the head's name line (see `FULL_MAP_HEAD_HEIGHT`). */
export const FULL_MAP_TEXT_BUTTON_HEIGHT = 22;

/** A quiet text button for a panel's head. */
export const fullMapTextButton = {
  flexShrink: 0,
  height: FULL_MAP_TEXT_BUTTON_HEIGHT,
  px: "6px",
  borderRadius: "5px",
  fontFamily: REWIND_FONTS.ui,
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: "nowrap",
  color: REWIND_COLORS.textSecondary,
  "&:hover": { color: REWIND_COLORS.textPrimary },
  "&.Mui-focusVisible": REWIND_FOCUS_RING,
} as const;

/**
 * The same rules for both small windows: one under 1100 px wide, and one under 700 px high. There the page stacks
 * and scrolls, so a panel that otherwise takes the room it is given needs a height of its own.
 */
export function inSmallWindow<Style extends object>(style: Style) {
  return { "@media (max-width: 1099px)": style, "@media (max-height: 699px)": style };
}

/** The height of the small segmented switch, its 2px padding included. It is made for a panel's head. */
export const FULL_MAP_SMALL_SEGMENTED_HEIGHT = 20;

/** Segmented selected face, as in `RulesetSwitch`. */
const SELECTED_FACE_SHADOW = "inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.5)";

/**
 * A segmented switch: a `role="group"` of buttons, the selected one `aria-pressed`. A disabled option takes no input;
 * choosing the selected one again changes nothing. `size="small"` is a 20px control for a panel's head (see
 * `FULL_MAP_SMALL_SEGMENTED_HEIGHT`).
 */
export function FullMapSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (next: T) => void;
  size?: "small";
}) {
  const small = size === "small";
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        flexShrink: 0,
        display: "grid",
        gridAutoFlow: "column",
        p: "2px",
        borderRadius: small ? "6px" : "7px",
        backgroundColor: REWIND_COLORS.inset,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        ...(small && {
          boxSizing: "border-box",
          height: FULL_MAP_SMALL_SEGMENTED_HEIGHT,
          // Centred on the head's name line; the part beyond it is taken out of the margin, so the head stays as tall
          // as the other panels' and the name does not move down (as the Judgements head's buttons do).
          alignSelf: "center",
          my: `${(FULL_MAP_HEAD_HEIGHT - FULL_MAP_SMALL_SEGMENTED_HEIGHT) / 2}px`,
        }),
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <ButtonBase
            key={option.value}
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            onMouseDown={preventPointerFocus}
            sx={{
              height: small ? FULL_MAP_SMALL_SEGMENTED_HEIGHT - 4 : 24,
              px: small ? "8px" : "10px",
              borderRadius: small ? "4px" : "5px",
              fontFamily: REWIND_FONTS.ui,
              fontSize: small ? 11.5 : 12.5,
              fontWeight: 500,
              whiteSpace: "nowrap",
              color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSecondary,
              backgroundColor: selected ? REWIND_COLORS.controlActive : "transparent",
              boxShadow: selected ? SELECTED_FACE_SHADOW : "none",
              "&:hover": { color: REWIND_COLORS.textPrimary },
              "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
              "&.Mui-focusVisible": REWIND_FOCUS_RING,
            }}
          >
            {option.label}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
