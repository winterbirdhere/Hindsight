import { Box, ButtonBase, type ButtonBaseProps } from "@mui/material";
import { KeyboardEvent, MouseEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { frontendAPI } from "../../api";
import { useAppInfo } from "../../hooks/app-info";
import { useInspector } from "../../providers/InspectorProvider";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";
import { OsuDirectorySettings } from "../analyzer/OsuDirectorySettings";
import { SettingsSection } from "./controls";

const RESET_BORDER = "inset 0 0 0 1px rgba(255,112,130,0.5)";
const RESET_TEXT = "#ff8594";
const RESET_HOVER = "rgba(255,84,104,0.1)";

/** How far, in px and per axis, a click may be from the one that opened the question and still count as the same spot. */
const POINTER_SLOP = 4;

const QUESTION = "Clear every preference, including the osu! folder?";
const RESTART_FAILED = "Settings were cleared. Hindsight could not restart; close and reopen it.";
const CLEAR_FAILED = "Could not clear the saved settings. Try again.";

type ResetView = "idle" | "confirming" | "restarting" | "restart-failed";
type FocusTarget = "reset" | "cancel" | "confirm";

/**
 * What happens after the settings were cleared outlives the row: closing Settings, leaving the tab or pressing Esc
 * must not hide a pending or failed restart, so this state is module-level and the row only reads it.
 */
type RestartStage = "idle" | "restarting" | "restart-failed";
let restartStage: RestartStage = "idle";
const restartListeners = new Set<() => void>();
function setRestartStage(next: RestartStage) {
  if (restartStage === next) return;
  restartStage = next;
  restartListeners.forEach((listener) => listener());
}
function subscribeRestartStage(listener: () => void) {
  restartListeners.add(listener);
  return () => {
    restartListeners.delete(listener);
  };
}
const getRestartStage = () => restartStage;

/** Test-only: forget a pending or failed restart so specs stay independent. */
export function resetGeneralTabStateForTests() {
  setRestartStage("idle");
}

/** A 30 px button of the reset row: `danger` is the red outline, `neutral` the raised control face. */
function ResetButton({ tone, sx, ...props }: ButtonBaseProps & { tone: "danger" | "neutral" }) {
  const danger = tone === "danger";
  return (
    <ButtonBase
      {...props}
      onMouseDown={preventPointerFocus}
      sx={[
        {
          flex: "none",
          maxWidth: "100%",
          height: 30,
          px: "12px",
          borderRadius: "6px",
          fontFamily: REWIND_FONTS.ui,
          fontSize: 12.5,
          fontWeight: 500,
          whiteSpace: "nowrap",
          color: danger ? RESET_TEXT : REWIND_COLORS.textBright,
          backgroundColor: danger ? "transparent" : REWIND_COLORS.control,
          boxShadow: danger ? RESET_BORDER : REWIND_COLORS.controlEdge,
          "&:hover": {
            backgroundColor: danger ? RESET_HOVER : REWIND_COLORS.controlActive,
            color: danger ? RESET_TEXT : REWIND_COLORS.white,
          },
          "&.Mui-focusVisible": REWIND_FOCUS_RING,
          "&.Mui-disabled": { opacity: 0.4 },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}

const rowSx = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px 12px",
  minHeight: 38,
  py: "4px",
} as const;
const textSlotSx = { flex: "1 1 160px", minWidth: 0 } as const;
/** The buttons keep to the right edge and wrap, under each other if need be, instead of overflowing sideways. */
const buttonsSx = {
  flex: "0 1 auto",
  minWidth: 0,
  maxWidth: "100%",
  marginLeft: "auto",
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: "8px",
} as const;
const alertSx = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 12,
  lineHeight: "16px",
  color: REWIND_COLORS.judgementMiss,
  textWrap: "pretty",
} as const;

/**
 * "Reset all settings". The first click asks, in place of the row and without a dialog; only the confirmation
 * clears `localStorage` and restarts. Whether the question is open is local, so leaving the tab forgets it. A pending
 * or failed restart is not: it lives in the module store, reappears when the tab is reopened, and a failure brings
 * Settings back to this tab. A failed restart keeps the settings cleared, says so, and retries only the restart.
 */
function ResetRow() {
  const { openSettings } = useInspector();
  const stage = useSyncExternalStore(subscribeRestartStage, getRestartStage);
  const [asking, setAsking] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const questionId = useId();
  const resetRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const focusTarget = useRef<FocusTarget | null>(null);
  /** Where the pointer was when it opened the question: a click that has not moved from there cannot confirm. */
  const openedAt = useRef<{ x: number; y: number } | null>(null);

  const view: ResetView = stage !== "idle" ? stage : asking ? "confirming" : "idle";

  // Move focus deliberately when the row swaps: into the question, back to the row, or onto the retry.
  useEffect(() => {
    const target = focusTarget.current;
    focusTarget.current = null;
    const element =
      target === "reset"
        ? resetRef.current
        : target === "cancel"
        ? cancelRef.current
        : target === "confirm"
        ? confirmRef.current
        : null;
    element?.focus();
  }, [view]);

  const ask = (event: MouseEvent<HTMLElement>) => {
    // A pointer click (detail 1 or more) remembers where it landed; a keyboard activation (detail 0) remembers nothing.
    openedAt.current = event.detail >= 1 ? { x: event.clientX, y: event.clientY } : null;
    focusTarget.current = "cancel";
    setClearFailed(false);
    setAsking(true);
  };
  const cancel = () => {
    openedAt.current = null;
    focusTarget.current = "reset";
    setClearFailed(false);
    setAsking(false);
  };

  const confirm = async () => {
    if (restartStage === "restarting") return;
    const retryingRestart = restartStage === "restart-failed";
    setClearFailed(false);
    setRestartStage("restarting");
    if (!retryingRestart) {
      try {
        localStorage.clear();
      } catch {
        // Nothing was cleared: ask again, with the safe button focused. The view does not change in this batch, so
        // the focus effect would not run: move focus now, off the destructive button the keyboard just used.
        cancelRef.current?.focus();
        setClearFailed(true);
        setRestartStage("idle");
        return;
      }
    }
    try {
      await frontendAPI.reboot();
    } catch {
      focusTarget.current = "confirm";
      setRestartStage("restart-failed");
      // The user may have left this tab or closed Settings meanwhile: bring the notice into view.
      openSettings({ tab: "general" });
    }
  };

  // The second click of a double-click on `Reset and restart` (detail 2 or more) can land on this button, because the
  // row swaps during the first click. It never confirms; keyboard activation (Enter, detail 0) and a fresh click do.
  const onConfirmClick = (event: MouseEvent<HTMLElement>) => {
    if (event.detail > 1) return;
    // The first confirm only (not the retry of a failed restart, where the settings are already cleared): a pointer
    // click within 4 px of the click that opened the question is the same click made twice, whatever the layout.
    const origin = openedAt.current;
    if (
      restartStage === "idle" &&
      origin &&
      event.detail >= 1 &&
      Math.abs(event.clientX - origin.x) <= POINTER_SLOP &&
      Math.abs(event.clientY - origin.y) <= POINTER_SLOP
    )
      return;
    void confirm();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    // Inside this group Esc never closes Settings: it withdraws the question, and while a restart is pending or
    // failed it does nothing, so the notice cannot be dismissed by accident.
    event.preventDefault();
    event.stopPropagation();
    if (view === "confirming") cancel();
  };

  if (view === "idle") {
    return (
      <Box sx={rowSx}>
        <Box component="span" sx={{ ...textSlotSx, display: "flex", flexDirection: "column", gap: "1px" }}>
          <Box
            component="span"
            sx={{ fontFamily: REWIND_FONTS.ui, fontSize: 13, lineHeight: "18px", color: REWIND_COLORS.textBright }}
          >
            Reset all settings
          </Box>
          <Box
            component="span"
            sx={{
              fontFamily: REWIND_FONTS.ui,
              fontSize: 12,
              lineHeight: "16px",
              color: REWIND_COLORS.textTertiary,
              textWrap: "pretty",
            }}
          >
            Clears every preference and restarts Hindsight.
          </Box>
        </Box>
        <ResetButton ref={resetRef} tone="danger" onClick={ask} sx={{ marginLeft: "auto" }}>
          Reset and restart
        </ResetButton>
      </Box>
    );
  }

  const failed = view === "restart-failed";
  const restarting = view === "restarting";
  return (
    <Box
      role="group"
      aria-label="Confirm reset"
      aria-describedby={failed ? undefined : questionId}
      onKeyDown={onKeyDown}
      sx={rowSx}
    >
      {failed ? (
        <Box key="restart-alert" role="alert" sx={{ ...textSlotSx, ...alertSx }}>
          {RESTART_FAILED}
        </Box>
      ) : (
        <Box
          key="question"
          id={questionId}
          sx={{
            ...textSlotSx,
            fontFamily: REWIND_FONTS.ui,
            fontSize: 13,
            lineHeight: "18px",
            color: REWIND_COLORS.textPrimary,
            textWrap: "pretty",
          }}
        >
          {QUESTION}
        </Box>
      )}
      <Box sx={buttonsSx}>
        {/* The confirm button comes first and Cancel last: the group keeps to the right edge, so Cancel takes the place
            `Reset and restart` had, also when the buttons wrap, and a double-click cannot land on the destructive one. */}
        <ResetButton ref={confirmRef} tone="danger" disabled={restarting} onClick={onConfirmClick}>
          {restarting ? "Restarting Hindsight…" : failed ? "Retry restart" : "Yes, reset and restart"}
        </ResetButton>
        {!failed && (
          <ResetButton ref={cancelRef} tone="neutral" disabled={restarting} onClick={cancel}>
            Cancel
          </ResetButton>
        )}
      </Box>
      {clearFailed && (
        <Box key="clear-alert" role="alert" sx={{ ...alertSx, flex: "1 1 100%" }}>
          {CLEAR_FAILED}
        </Box>
      )}
    </Box>
  );
}

/** The General tab: the osu! folder, saved preference reset, and app identity. */
export function GeneralTab() {
  const version = useAppInfo().appVersion?.trim();
  return (
    <>
      <SettingsSection label="osu! folder">
        <OsuDirectorySettings />
      </SettingsSection>
      <SettingsSection label="Reset">
        <ResetRow />
      </SettingsSection>
      <SettingsSection label="About" last>
        <Box sx={{
          fontFamily: REWIND_FONTS.ui,
          fontSize: 13,
          lineHeight: "18px",
          color: REWIND_COLORS.textSecondary,
          userSelect: "text",
          overflowWrap: "anywhere",
        }}>
          <Box component="p" sx={{ m: "4px 0", color: REWIND_COLORS.textBright, fontWeight: 500 }}>
            {version ? `Hindsight ${version}` : "Hindsight · Version unavailable"}
          </Box>
          <Box component="p" sx={{ m: "0 0 6px" }}>Based on Rewind by abstrakt.</Box>
          <Box component="p" sx={{ m: 0 }}>
            Source code: MIT. Bundled dependencies and assets use separate licences.
          </Box>
        </Box>
      </SettingsSection>
    </>
  );
}
