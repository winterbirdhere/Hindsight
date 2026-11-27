import { Box } from "@mui/material";
import type { CSSProperties } from "react";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import {
  BOARD_HEIGHT,
  BOARD_KEYS,
  BOARD_WIDTH,
  GROUP_COLORS,
  KEY_GAP,
  KEY_UNIT,
  MOUSE_PARTS,
  rowTop,
  USED_KEYS,
  type Highlight,
} from "./shortcuts-map";

const EDGE = "rgba(255,255,255,0.06)";
const USED_EDGE = "rgba(255,255,255,0.22)";
const MOUSE_EDGE = "rgba(255,255,255,0.16)";

/** The styles of the drawing, keyed by the data attributes the keys carry; the dialog's root marks a layer. */
export const keyboardSx = {
  "& [data-kind=key]": {
    position: "absolute",
    height: KEY_UNIT - KEY_GAP,
    display: "grid",
    placeItems: "center",
    borderRadius: "3px",
    backgroundColor: REWIND_COLORS.surface,
    boxShadow: `inset 0 0 0 1px ${EDGE}`,
    fontFamily: REWIND_FONTS.mono,
    fontSize: 12,
    fontWeight: 500,
    color: REWIND_COLORS.white,
    transition: "background-color 70ms, transform 50ms",
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  },
  "& [data-kind=key][data-used=true]": {
    backgroundColor: REWIND_COLORS.control,
    boxShadow: `inset 0 0 0 1px ${USED_EDGE}, inset 0 -3px 0 var(--g)`,
    cursor: "default",
  },
  "& [data-kind=key][data-hot=true]": {
    backgroundColor: "var(--hot)",
    boxShadow: "none",
    color: REWIND_COLORS.inset,
  },
  "& [data-kind=key][data-down=true]": {
    transform: "translateY(2px)",
    "@media (prefers-reduced-motion: reduce)": { transform: "none" },
  },
  "&[data-layer=true] [data-kind=key][data-used=true]:not([data-hot=true])": {
    backgroundColor: REWIND_COLORS.surface,
    boxShadow: `inset 0 0 0 1px ${EDGE}`,
    color: REWIND_COLORS.textQuaternary,
  },
  "& [data-kind=mouse]": {
    fill: REWIND_COLORS.surface,
    stroke: MOUSE_EDGE,
    strokeWidth: 1,
    transition: "fill 70ms",
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  },
  "& [data-kind=mouse][data-used=true]": { fill: REWIND_COLORS.control, stroke: "var(--g)", strokeWidth: 1.5 },
  "& [data-kind=mouse][data-hot=true]": { fill: "var(--hot)", stroke: "var(--hot)" },
  "&[data-layer=true] [data-kind=mouse][data-used=true]:not([data-hot=true])": {
    fill: REWIND_COLORS.surface,
    stroke: MOUSE_EDGE,
    strokeWidth: 1,
  },
} as const;

interface Handlers {
  /** The pointer is over (or has left) a key or a part of the mouse. */
  onHover: (code: string | undefined) => void;
}

/** What a drawn part says about itself: its code, whether it takes part in a shortcut, and how it is lit now. */
function partAttributes(code: string, group: keyof typeof GROUP_COLORS | undefined, highlight: Highlight, down: ReadonlySet<string>) {
  const hot = highlight.keys.get(code);
  return {
    "data-code": code,
    "data-used": group ? "true" : "false",
    "data-group": group,
    "data-hot": hot ? "true" : "false",
    "data-down": down.has(code) ? "true" : "false",
    style: { ...(group ? { "--g": GROUP_COLORS[group] } : {}), ...(hot ? { "--hot": hot } : {}) } as CSSProperties,
  };
}

/** The mouse: a body, a right button and a wheel. */
function Mouse({ highlight, down, onHover }: Handlers & { highlight: Highlight; down: ReadonlySet<string> }) {
  const part = (code: string) => ({
    ...partAttributes(code, MOUSE_PARTS[code], highlight, down),
    "data-kind": "mouse",
    onMouseEnter: () => onHover(code),
    onMouseLeave: () => onHover(undefined),
  });
  return (
    <svg width="112" height="178" viewBox="0 0 112 178" style={{ flex: "none", overflow: "visible" }}>
      <path data-kind="mouse" d="M6 66 Q6 6 56 6 Q106 6 106 66 V122 Q106 172 56 172 Q6 172 6 122 Z" />
      <path data-kind="mouse" d="M6 74 V66 Q6 6 54 6 V74 Z" />
      <path {...part("MouseRight")} d="M58 6 Q106 6 106 66 V74 H58 Z" />
      <rect {...part("Wheel")} x="47" y="22" width="18" height="36" rx="9" />
    </svg>
  );
}

/**
 * A drawn keyboard (75% layout) and mouse. Only the keys that take part in a shortcut carry a legend and a bar in their
 * group's colour; every other key is a blank dim cap. The whole drawing is hidden from assistive technology: the list
 * below it is what is read.
 */
export function ShortcutsKeyboard({
  highlight,
  down,
  onHover,
}: Handlers & { highlight: Highlight; down: ReadonlySet<string> }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        m: "0 22px",
        p: "20px 26px 20px 20px",
        backgroundColor: REWIND_COLORS.inset,
        borderRadius: "3px",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      <Box sx={{ position: "relative", flex: "none", width: BOARD_WIDTH, height: BOARD_HEIGHT }}>
        {BOARD_KEYS.map(({ code, x, row, width }) => {
          const used = USED_KEYS[code];
          const { style, ...attributes } = partAttributes(code, used?.group, highlight, down);
          return (
            <div
              key={code}
              data-kind="key"
              {...attributes}
              style={{
                ...style,
                left: x * KEY_UNIT,
                top: rowTop(row),
                width: width * KEY_UNIT - KEY_GAP,
              }}
              onMouseEnter={() => onHover(code)}
              onMouseLeave={() => onHover(undefined)}
            >
              {used?.legend}
            </div>
          );
        })}
      </Box>
      <Mouse highlight={highlight} down={down} onHover={onHover} />
    </Box>
  );
}
