import { Box, IconButton, Modal } from "@mui/material";
import { forwardRef, Fragment, useEffect, useReducer, useRef, useState, type CSSProperties, type HTMLAttributes } from "react";
import { useObservable } from "rxjs-hooks";
import { useCommonManagers } from "../../providers/TheaterProvider";
import type { ScrollStep } from "../../services/common/playback-steps";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { keyboardSx, ShortcutsKeyboard } from "./ShortcutsKeyboard";
import {
  BINDINGS,
  computeHighlight,
  GROUP_COLORS,
  GROUP_ORDER,
  GROUP_TITLES,
  modifierOf,
  noteLabel,
  type Binding,
  type LiveState,
} from "./shortcuts-map";

/** The dialog's width; a narrower window scales the whole dialog down instead of reflowing it. */
const DIALOG_WIDTH = 980;
/** Space kept at each side of the dialog. */
const WINDOW_MARGIN = 16;
/** How long a turn of the wheel or a press of the right button stays lit. */
const FLASH_MS = 320;
const MIN_SCALE = 0.3;

type Action =
  | { type: "down"; code: string }
  | { type: "up"; code: string }
  | { type: "blur" }
  | { type: "hoverKey"; code: string | undefined }
  | { type: "hoverRow"; row: string | undefined }
  | { type: "flash"; code: string | undefined };

function reduce(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "down":
      return {
        ...state,
        pressed: state.pressed.includes(action.code) ? state.pressed : [...state.pressed, action.code],
        heldMod: modifierOf(action.code) ?? state.heldMod,
      };
    case "up":
      return {
        ...state,
        pressed: state.pressed.filter((code) => code !== action.code),
        heldMod: modifierOf(action.code) === state.heldMod ? undefined : state.heldMod,
      };
    case "blur":
      // A key let go while another window has the focus never reports its release.
      return { ...state, pressed: [], heldMod: undefined };
    case "hoverKey": {
      const modifier = action.code ? modifierOf(action.code) : undefined;
      return { ...state, hoverMod: modifier, hoverKey: modifier ? undefined : action.code };
    }
    case "hoverRow":
      return { ...state, hoverRow: action.row };
    case "flash":
      return { ...state, flash: action.code };
  }
}

const NO_KEYS: ReadonlySet<string> = new Set();

const heading = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  m: "0 0 6px",
  pl: "8px",
  fontFamily: REWIND_FONTS.mono,
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--g)",
  "&::before": { content: '""', width: 8, height: 8, backgroundColor: "var(--g)" },
} as const;

const rowSx = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
  height: 30,
  p: "0 6px 0 8px",
  boxShadow: "inset 2px 0 0 transparent",
  transition: "background-color 70ms, opacity 70ms",
  "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  "&[data-hot=true]": {
    backgroundColor: "color-mix(in srgb, var(--g) 17%, transparent)",
    boxShadow: "inset 2px 0 0 var(--g)",
  },
  "&[data-hot=true] kbd": { boxShadow: "inset 0 0 0 1px var(--g)" },
} as const;

const capSx = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: 22,
  height: 21,
  p: "0 5px",
  borderRadius: "2px",
  backgroundColor: REWIND_COLORS.inset,
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.24)",
  fontFamily: REWIND_FONTS.mono,
  fontSize: 11,
  fontWeight: 500,
  color: REWIND_COLORS.white,
} as const;

/** A row of the list: what it does and the keycaps that do it. */
function Row({
  binding,
  label,
  hot,
  onHover,
}: {
  binding: Binding;
  label: string;
  hot: boolean;
  onHover: (row: string | undefined) => void;
}) {
  return (
    <Box
      data-row={binding.row}
      data-hot={hot ? "true" : "false"}
      onMouseEnter={() => onHover(binding.row)}
      onMouseLeave={() => onHover(undefined)}
      sx={rowSx}
    >
      <Box component="span" data-part="action" sx={{ fontSize: 13.5, color: REWIND_COLORS.textPrimary, whiteSpace: "nowrap" }}>
        {label}
      </Box>
      <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: "3px", whiteSpace: "nowrap" }}>
        {binding.caps.map((cap, index) => (
          <Fragment key={index}>
            {cap.kind === "key" ? (
              <Box component="kbd" sx={capSx}>
                {cap.text}
              </Box>
            ) : cap.kind === "plus" ? (
              <Box
                component="span"
                sx={{ m: "0 1px", fontFamily: REWIND_FONTS.mono, fontSize: 11.5, fontWeight: 500, color: REWIND_COLORS.textSecondary }}
              >
                +
              </Box>
            ) : (
              <Box component="span" sx={{ width: 7 }} />
            )}
          </Fragment>
        ))}
      </Box>
    </Box>
  );
}

const CloseGlyph = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

type BoxProps = { onClose: () => void; scrollStep?: ScrollStep } & Omit<HTMLAttributes<HTMLDivElement>, "onClick">;

/**
 * The Keyboard shortcuts dialog: a drawn keyboard and mouse with the keys that take part in a shortcut lit in their
 * group's colour, and the same shortcuts as a list of four columns under it. While it is open, pressing a key, holding
 * Ctrl, Shift or Alt, turning the wheel or pointing at a key or a row lights what belongs to it. It only shows: it
 * never runs a shortcut, and the app's own handlers already leave a dialog's keys alone.
 */
export const HelpBox = forwardRef<HTMLDivElement, BoxProps>(function HelpBox({ onClose, scrollStep = "auto", ...rest }, ref) {
  const [live, dispatch] = useReducer(reduce, { pressed: [] });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const flash = (code: string) => {
      clearTimeout(flashTimer.current);
      dispatch({ type: "flash", code });
      flashTimer.current = setTimeout(() => dispatch({ type: "flash", code: undefined }), FLASH_MS);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Nothing scrolls under a Space or an arrow key; a button keeps its keys, so Close works from the keyboard.
      const onButton = event.target instanceof Element && event.target.closest("button");
      if (!onButton && (event.code === "Space" || event.code.startsWith("Arrow"))) event.preventDefault();
      dispatch({ type: "down", code: event.code });
    };
    const onKeyUp = (event: KeyboardEvent) => dispatch({ type: "up", code: event.code });
    const onBlur = () => dispatch({ type: "blur" });
    const onWheel = () => flash("Wheel");
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 2) flash("MouseRight");
    };
    const onResize = () => setWindowWidth(window.innerWidth);
    // On the way down, as the app's own shortcuts are, so a key is seen whatever stops it later.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
      clearTimeout(flashTimer.current);
    };
  }, []);

  const highlight = computeHighlight(live);
  const down = live.pressed.length > 0 ? new Set(live.pressed) : NO_KEYS;
  const scale = Math.max(MIN_SCALE, Math.min(1, (windowWidth - 2 * WINDOW_MARGIN) / DIALOG_WIDTH));

  return (
    <Box
      {...rest}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      // F12 shows its key here and takes no screenshot; everywhere else in the app it does (see `hooks/screenshot`).
      data-screenshot-blocked=""
      data-layer={highlight.layer ? "true" : "false"}
      data-scale={String(scale)}
      // The space around the dialog is the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      sx={{
        position: "fixed",
        inset: 0,
        overflowY: "auto",
        display: "flex",
        p: `${WINDOW_MARGIN}px`,
        outline: "none",
        "&[data-layer=true] [data-row]:not([data-hot=true])": { opacity: 0.32 },
        ...keyboardSx,
      }}
    >
      <Box
        // Scaled as a whole, not reflowed: the layout box shrinks with it, so there is no horizontal scrollbar.
        style={{ zoom: scale } as CSSProperties}
        sx={{
          width: DIALOG_WIDTH,
          flex: "none",
          m: "auto",
          backgroundColor: REWIND_COLORS.surface,
          borderRadius: "4px",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.14), 0 24px 60px rgba(0,0,0,0.6)",
          fontFamily: REWIND_FONTS.ui,
          color: REWIND_COLORS.textPrimary,
          userSelect: "none",
        }}
      >
        <Box component="header" sx={{ display: "flex", alignItems: "center", gap: "16px", height: 50, p: "0 16px 0 22px" }}>
          <Box component="h1" sx={{ m: 0, fontSize: 15.5, fontWeight: 600 }}>
            Keyboard shortcuts
          </Box>
          <Box component="span" sx={{ ml: "auto", fontSize: 12.5, color: REWIND_COLORS.textSecondary }}>
            Press a key, or hold {["Ctrl", "Shift", "Alt"].map((name, index) => (
              <Fragment key={name}>
                {index > 0 ? (index === 2 ? " or " : ", ") : ""}
                <Box component="b" sx={{ fontFamily: REWIND_FONTS.mono, fontSize: 11.5, fontWeight: 500, color: REWIND_COLORS.white }}>
                  {name}
                </Box>
              </Fragment>
            ))}
          </Box>
          <IconButton
            aria-label="Close"
            onClick={onClose}
            sx={{
              width: 28,
              height: 28,
              borderRadius: "3px",
              color: REWIND_COLORS.textBright,
              "&:hover": { color: REWIND_COLORS.white, backgroundColor: "rgba(255,255,255,0.08)" },
            }}
          >
            <CloseGlyph />
          </IconButton>
        </Box>
        <ShortcutsKeyboard
          highlight={highlight}
          down={down}
          onHover={(code) => dispatch({ type: "hoverKey", code })}
        />
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(4, auto)",
            justifyContent: "space-between",
            columnGap: "20px",
            p: "18px 22px 20px",
          }}
        >
          {GROUP_ORDER.map((group) => (
            <Box component="section" key={group} style={{ "--g": GROUP_COLORS[group] } as CSSProperties}>
              <Box component="h2" sx={heading}>
                {GROUP_TITLES[group]}
              </Box>
              {BINDINGS.filter((binding) => binding.group === group).map((binding) => (
                <Row
                  key={binding.row}
                  binding={binding}
                  label={binding.row === "note" ? noteLabel(scrollStep) : binding.label}
                  hot={highlight.rows.has(binding.row)}
                  onHover={(row) => dispatch({ type: "hoverRow", row })}
                />
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
});

/** The dialog with the Scroll step setting (Settings → Playback), which names the wheel's row, read from the app. */
const ConnectedHelpBox = forwardRef<HTMLDivElement, Omit<BoxProps, "scrollStep">>(function ConnectedHelpBox(props, ref) {
  const { playbarSettingsStore } = useCommonManagers();
  const playbar = useObservable(() => playbarSettingsStore.settings$, playbarSettingsStore.settings);
  return <HelpBox {...props} ref={ref} scrollStep={playbar.scrollStep} />;
});

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HelpModalDialog(props: HelpModalProps) {
  const { isOpen, onClose } = props;

  return (
    <Modal open={isOpen} onClose={onClose}>
      <ConnectedHelpBox onClose={onClose} />
    </Modal>
  );
}
