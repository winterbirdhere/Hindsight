import { Box, ButtonBase, Menu, MenuItem, Slider } from "@mui/material";
import { ReactNode, useId, useRef, useState } from "react";
import { preventPointerFocus } from "../../utils/focus";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";

/**
 * The settings controls of the 3a inspector (docs/design/rewind-3a/addon-1, mock lines 202 and 241). Every one keeps
 * a visible keyboard focus ring and an accessible name, and none keeps focus after a pointer press, so Space and the
 * arrow keys keep driving playback.
 *
 * Keyboard: Enter always activates a control. While a replay is loaded Space belongs to play/pause
 * (`usePlaybackSpace` captures it at the window), so it works on these controls only while no replay is loaded.
 *
 * Width: the inspector is 240 to 440 px wide. Rows that hold a label and a control wrap the control onto its own line
 * (right-aligned) when both do not fit; at 340 px they stay on one line, as in the mock. Nothing here scrolls or
 * overflows sideways. A control therefore has to fit 200 px, the narrowest panel less its padding: a `Segmented` of
 * more than three or four short options does not, and a `Stepper` takes its place.
 */

/** The mock's section divider (a hair softer than `REWIND_COLORS.hairline`). */
const SECTION_HAIRLINE = "inset 0 -1px 0 rgba(255,255,255,0.08)";
/** Slider rail, and the off colour of a hollow dot: the mock's literals, which have no token. */
const SLIDER_RAIL = "rgba(255,255,255,0.14)";
const HOLLOW_DOT = "#6a675f";
/** The knob of an on switch: the page ink, darker than any surface token. */
const SWITCH_KNOB_ON = "#17181c";
/** Switch and segmented selected faces, as in `RulesetSwitch`. */
const SELECTED_FACE_SHADOW = "inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 3px rgba(0,0,0,0.5)";

const DISABLED_OPACITY = 0.4;
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)";

const labelSx = { fontFamily: REWIND_FONTS.ui, fontSize: 13, lineHeight: "18px", color: REWIND_COLORS.textBright } as const;

/**
 * A label with its control on the right. When they do not fit on one line the control wraps under the label (a flex
 * item wraps by its natural width, so the label is never squeezed below its own width), kept on the right.
 */
const wrappingRowSx = { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "12px", rowGap: "2px" } as const;
const rowLabelSx = { ...labelSx, flex: "1 1 auto", overflowWrap: "break-word" } as const;
const rowControlSx = { flex: "none", maxWidth: "100%", ml: "auto" } as const;

/**
 * A titled group of settings with a hairline under it (none under the `last` one). `variant="toggles"` is the tighter
 * section of text toggles (padding 10/20/8); the default `"rows"` is the section of switch, slider and value rows
 * (padding 14/20/10).
 */
export function SettingsSection({
  label,
  children,
  last,
  variant = "rows",
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
  variant?: "rows" | "toggles";
}) {
  const labelId = useId();
  const toggles = variant === "toggles";
  return (
    <Box
      role="group"
      aria-labelledby={labelId}
      sx={{
        flex: "none",
        display: "flex",
        flexDirection: "column",
        gap: toggles ? "4px" : 0,
        p: toggles ? "10px 20px 8px" : "14px 20px 10px",
        boxShadow: last ? "none" : SECTION_HAIRLINE,
      }}
    >
      <Box
        component="span"
        id={labelId}
        sx={{
          fontFamily: REWIND_FONTS.mono,
          fontWeight: 500,
          fontSize: 11,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: REWIND_COLORS.textTertiary,
          mb: toggles ? "2px" : "4px",
        }}
      >
        {label}
      </Box>
      {children}
    </Box>
  );
}

/** A wrapping row of `TextToggle`s. */
export function ToggleRow({ children }: { children: ReactNode }) {
  return <Box sx={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", py: "2px" }}>{children}</Box>;
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" focusable="false" style={{ display: "block" }}>
      <polyline
        points="2,6.5 5,9 10,3"
        style={{ fill: "none", stroke: REWIND_COLORS.textPrimary, strokeWidth: 1.8 }}
      />
    </svg>
  );
}

/**
 * A text toggle (`role="checkbox"`): a check when on and a hollow dot when off, or, with a `color`, a 3 × 12 px bar
 * in that colour (dimmed to 30 % when off). A disabled toggle dims as a whole (mark and label). It is a span-based
 * button: Enter toggles it, and so does Space while no replay is loaded. A label wider than the row is clipped with an
 * ellipsis rather than overflowing.
 */
export function TextToggle({
  label,
  checked,
  onChange,
  disabled,
  color,
}: {
  label: string;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <ButtonBase
      component="span"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      onMouseDown={preventPointerFocus}
      sx={{
        height: 28,
        maxWidth: "100%",
        gap: "7px",
        justifyContent: "flex-start",
        fontFamily: REWIND_FONTS.ui,
        fontWeight: 500,
        fontSize: 13,
        whiteSpace: "nowrap",
        color: checked ? REWIND_COLORS.textPrimary : REWIND_COLORS.textDim,
        "&:hover": { color: REWIND_COLORS.white },
        "&.Mui-disabled": { opacity: DISABLED_OPACITY },
        "&.Mui-focusVisible": REWIND_FOCUS_RING,
      }}
    >
      {color ? (
        <Box
          component="span"
          data-mark="bar"
          sx={{ width: 3, height: 12, borderRadius: "1px", backgroundColor: color, opacity: checked ? 1 : 0.3 }}
        />
      ) : (
        <Box component="span" sx={{ width: 10, display: "grid", placeItems: "center" }}>
          {checked ? (
            <CheckMark />
          ) : (
            <Box
              component="span"
              data-mark="dot"
              sx={{ width: 6, height: 6, borderRadius: "50%", boxShadow: `inset 0 0 0 1.3px ${HOLLOW_DOT}` }}
            />
          )}
        </Box>
      )}
      <Box component="span" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </Box>
    </ButtonBase>
  );
}

/**
 * A labelled on/off switch row (`role="switch"`): the whole row is the control, the optional `hint` is its
 * description; a long label or hint wraps beside the switch. Enter toggles it, and so does Space while no replay is
 * loaded.
 */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
  focusOnPointer = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  /** Let non-viewer surfaces keep the browser's normal pointer-to-keyboard focus continuity. */
  focusOnPointer?: boolean;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <ButtonBase
      component="div"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      onMouseDown={focusOnPointer ? undefined : preventPointerFocus}
      sx={{
        width: "100%",
        minHeight: 38,
        py: "4px",
        gap: "12px",
        justifyContent: "flex-start",
        textAlign: "left",
        "&.Mui-disabled": { opacity: DISABLED_OPACITY },
        "&.Mui-focusVisible [data-switch-track]": REWIND_FOCUS_RING,
      }}
    >
      <Box component="span" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" }}>
        <Box component="span" id={labelId} sx={{ ...labelSx, lineHeight: "normal", overflowWrap: "anywhere" }}>
          {label}
        </Box>
        {hint && (
          <Box
            component="span"
            id={hintId}
            sx={{
              fontFamily: REWIND_FONTS.ui,
              fontSize: 12,
              // Not inherited: CssBaseline's 1.5 would make the hint about 18 px tall, the design's is about 15.
              lineHeight: "normal",
              color: REWIND_COLORS.textTertiary,
              textWrap: "pretty",
              overflowWrap: "anywhere",
            }}
          >
            {hint}
          </Box>
        )}
      </Box>
      <Box
        component="span"
        data-switch-track=""
        sx={{
          flex: "none",
          position: "relative",
          width: 30,
          height: 18,
          borderRadius: "9px",
          backgroundColor: checked ? REWIND_COLORS.focus : REWIND_COLORS.controlActive,
          boxShadow: checked ? "none" : "inset 0 0 0 1px rgba(255,255,255,0.12)",
        }}
      >
        <Box
          component="span"
          sx={{
            position: "absolute",
            top: 2,
            left: checked ? 14 : 2,
            width: 14,
            height: 14,
            borderRadius: "50%",
            backgroundColor: checked ? SWITCH_KNOB_ON : REWIND_COLORS.textSoft,
            transition: "left 120ms ease-out",
            [REDUCED_MOTION]: { transition: "none" },
          }}
        />
      </Box>
    </ButtonBase>
  );
}

const POINTER_END_EVENTS = new Set(["mouseup", "touchend", "pointerup"]);

/**
 * A labelled slider (120 px track) with its value as `${value}%`. It restyles MUI's `Slider`, so the keyboard keeps
 * working, and it lets go of focus after a pointer drag (not after a key press). `dense` is the 32 px row. When the
 * label and the 170 px control do not fit on one line, the control wraps under the label.
 */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  disabled,
  dense,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(next: number): void;
  disabled?: boolean;
  dense?: boolean;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const thumbRing = `0 0 0 3px ${REWIND_COLORS.surface}`;
  return (
    <Box
      sx={{
        ...wrappingRowSx,
        minHeight: dense ? 32 : 38,
        py: dense ? 0 : "4px",
        opacity: disabled ? DISABLED_OPACITY : 1,
      }}
    >
      <Box component="span" sx={rowLabelSx}>
        {label}
      </Box>
      <Box sx={{ ...rowControlSx, display: "flex", alignItems: "center", gap: "10px" }}>
        <Slider
          ref={rootRef}
          aria-label={label}
          getAriaValueText={(current) => `${current}%`}
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          size="small"
          onChange={(_, next) => onChange(Array.isArray(next) ? next[0] : next)}
          onChangeCommitted={(event) => {
            // A pointer drag leaves focus on the thumb: release it. A key press (a `change` event) keeps it.
            if (!POINTER_END_EVENTS.has((event as Event).type)) return;
            const active = document.activeElement;
            if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
          }}
          sx={{
            width: 120,
            height: 14,
            p: "6px 0",
            "@media (pointer: coarse)": { p: "6px 0" },
            color: REWIND_COLORS.focus,
            "& .MuiSlider-rail": {
              height: 2,
              borderRadius: 0,
              opacity: 1,
              backgroundColor: SLIDER_RAIL,
            },
            "& .MuiSlider-track": {
              height: 2,
              border: 0,
              borderRadius: 0,
              backgroundColor: REWIND_COLORS.focus,
            },
            "& .MuiSlider-thumb": {
              width: 12,
              height: 12,
              backgroundColor: REWIND_COLORS.textPrimary,
              boxShadow: thumbRing,
              "&::before": { display: "none" },
              "&:hover, &.Mui-active, &.Mui-focusVisible": { boxShadow: thumbRing },
              "&.Mui-focusVisible": { ...REWIND_FOCUS_RING, outlineOffset: 3 },
            },
            "&.Mui-disabled": { color: REWIND_COLORS.focus },
            "&.Mui-disabled .MuiSlider-thumb": { backgroundColor: REWIND_COLORS.textPrimary, boxShadow: thumbRing },
          }}
        />
        <Box
          component="span"
          aria-hidden="true"
          sx={{
            width: 40,
            textAlign: "right",
            fontFamily: REWIND_FONTS.mono,
            fontWeight: 500,
            fontSize: 12.5,
            lineHeight: "18px",
            fontVariantNumeric: "tabular-nums",
            color: REWIND_COLORS.textPrimary,
          }}
        >
          {`${value}%`}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * A segmented switch: a `role="group"` of buttons, the selected one `aria-pressed`. With a `width` it fills that many
 * pixels with equal segments (26 px high); without, it is as wide as its labels (24 px high).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  width,
  disabled,
  focusOnPointer = false,
  selectionAppearance = "neutral",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
  width?: number;
  /** The buttons take no input; the selected one stays marked. Dim the row with `ValueRow`'s `disabled`. */
  disabled?: boolean;
  /** Viewer controls leave Space to playback by default; other surfaces can opt into native focus. */
  focusOnPointer?: boolean;
  /** Library choices use an accent outline; viewer settings retain their neutral selected face. */
  selectionAppearance?: "neutral" | "accent";
}) {
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        flex: "none",
        width,
        maxWidth: "100%",
        display: "grid",
        gridTemplateColumns: width ? `repeat(${options.length}, minmax(0, 1fr))` : `repeat(${options.length}, auto)`,
        p: "2px",
        borderRadius: "7px",
        backgroundColor: REWIND_COLORS.inset,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <ButtonBase
            key={option.value}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              if (!selected && !disabled) onChange(option.value);
            }}
            onMouseDown={focusOnPointer ? undefined : preventPointerFocus}
            sx={{
              height: width ? 26 : 24,
              px: width ? 0 : "10px",
              borderRadius: "5px",
              fontFamily: REWIND_FONTS.ui,
              fontSize: 12.5,
              fontWeight: selected && selectionAppearance === "accent" ? 600 : 500,
              whiteSpace: "nowrap",
              color: selected ? REWIND_COLORS.textPrimary : REWIND_COLORS.textSecondary,
              backgroundColor: selected ? REWIND_COLORS.controlActive : "transparent",
              boxShadow: selected
                ? selectionAppearance === "accent"
                  ? `inset 0 0 0 1px ${REWIND_COLORS.accent}, inset 0 -2px 0 ${REWIND_COLORS.accent}`
                  : SELECTED_FACE_SHADOW
                : "none",
              "&:hover": { color: REWIND_COLORS.textPrimary },
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

/**
 * A label on the left and its control on the right, 32 px high at least. When they do not fit on one line (for
 * example the 190 px `Segmented` below 300 px) the control wraps under the label, right-aligned. A `disabled` row
 * dims as a whole; disabling the control itself is the control's own job. `roomy` is for a section of switch and
 * slider rows, which have no gap between them: the row is 38 px with 4 px above and below, like a slider row, so that
 * a control wrapped under its label does not sit as near the next row's label as its own.
 */
export function ValueRow({
  label,
  children,
  disabled,
  roomy,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  roomy?: boolean;
}) {
  return (
    <Box sx={{ ...wrappingRowSx, minHeight: roomy ? 38 : 32, py: roomy ? "4px" : undefined, opacity: disabled ? DISABLED_OPACITY : 1 }}>
      <Box component="span" sx={rowLabelSx}>
        {label}
      </Box>
      <Box sx={{ ...rowControlSx, display: "flex", justifyContent: "flex-end" }}>{children}</Box>
    </Box>
  );
}

const stepperEndSx = {
  width: 26,
  height: 28,
  color: REWIND_COLORS.textSecondary,
  "&:hover": { color: REWIND_COLORS.textPrimary },
  "&.Mui-disabled": { color: REWIND_COLORS.textQuaternary },
  "&.Mui-focusVisible": REWIND_FOCUS_RING,
} as const;

/**
 * One value out of an ordered list, in the form of the dock's speed stepper: one down, the value, one up. The value
 * opens the whole list. It is three buttons however many values there are, about 104 px wide, so it fits the narrowest
 * panel on one line where a `Segmented` of the same values would be cut off. Use it inside a `ValueRow`.
 */
export function Stepper<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(next: T): void;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const index = options.findIndex((option) => option.value === value);
  const shown = index >= 0 ? options[index].label : String(value);
  const choose = (next: number) => {
    if (!disabled && options[next] && next !== index) onChange(options[next].value);
  };
  return (
    <Box
      role="group"
      aria-label={label}
      sx={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        borderRadius: "6px",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.16)",
        fontFamily: REWIND_FONTS.mono,
        fontSize: 12.5,
      }}
    >
      <ButtonBase
        aria-label={`${label}: previous`}
        disabled={disabled || index <= 0}
        onClick={() => choose(index - 1)}
        onMouseDown={preventPointerFocus}
        sx={stepperEndSx}
      >
        −
      </ButtonBase>
      <ButtonBase
        aria-label={`${label}: ${shown}`}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={(event) => setAnchor(event.currentTarget)}
        onMouseDown={preventPointerFocus}
        sx={{
          // As wide as the widest value here ("0.75×"), so the control does not change size as it steps.
          minWidth: 52,
          px: "4px",
          height: 28,
          color: REWIND_COLORS.textPrimary,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          "&.Mui-focusVisible": REWIND_FOCUS_RING,
        }}
      >
        {shown}
      </ButtonBase>
      <ButtonBase
        aria-label={`${label}: next`}
        disabled={disabled || index < 0 || index >= options.length - 1}
        onClick={() => choose(index + 1)}
        onMouseDown={preventPointerFocus}
        sx={stepperEndSx}
      >
        +
      </ButtonBase>
      <Menu open={Boolean(anchor)} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {options.map((option, position) => (
          <MenuItem
            key={option.value}
            selected={position === index}
            onClick={() => {
              choose(position);
              setAnchor(null);
            }}
          >
            {option.label}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}
