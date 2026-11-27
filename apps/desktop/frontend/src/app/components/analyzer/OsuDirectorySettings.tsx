import { Box, ButtonBase, type ButtonBaseProps } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useObservable } from "rxjs-hooks";
import { frontendAPI } from "../../api";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { preventPointerFocus } from "../../utils/focus";

/** A read-only path: 34 px at least, selectable, and a long path wraps instead of being cut. */
const fieldSx = {
  flex: 1,
  minWidth: 0,
  minHeight: 34,
  display: "flex",
  alignItems: "center",
  px: "10px",
  py: "6px",
  borderRadius: "7px",
  backgroundColor: REWIND_COLORS.inset,
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
  fontFamily: REWIND_FONTS.mono,
  fontSize: 12.5,
  lineHeight: "18px",
  color: REWIND_COLORS.textPrimary,
  overflowWrap: "anywhere",
  userSelect: "text",
} as const;

const hintSx = {
  fontFamily: REWIND_FONTS.ui,
  fontSize: 12,
  lineHeight: "16px",
  color: REWIND_COLORS.textTertiary,
  textWrap: "pretty",
} as const;

/** A 34 px button of the folder block: `raised` is the control face, the default is quiet text. Also the Export panel's `Change…`. */
export function FolderButton({ raised, sx, ...props }: ButtonBaseProps & { raised?: boolean }) {
  return (
    <ButtonBase
      {...props}
      onMouseDown={preventPointerFocus}
      sx={[
        {
          flex: "none",
          height: 34,
          px: "12px",
          borderRadius: "7px",
          fontFamily: REWIND_FONTS.ui,
          fontSize: 12.5,
          fontWeight: 500,
          whiteSpace: "nowrap",
          color: raised ? REWIND_COLORS.textBright : REWIND_COLORS.textSecondary,
          backgroundColor: raised ? REWIND_COLORS.control : "transparent",
          boxShadow: raised ? REWIND_COLORS.controlEdge : "none",
          "&:hover": {
            backgroundColor: raised ? REWIND_COLORS.controlActive : "rgba(255,255,255,0.06)",
            color: REWIND_COLORS.white,
          },
          "&.Mui-focusVisible": REWIND_FOCUS_RING,
          "&.Mui-disabled": { opacity: 0.4 },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  );
}

export function OsuDirectorySettings() {
  const { osuFolderService } = useAnalysisApp();
  const settings = useObservable(() => osuFolderService.settings$, osuFolderService.settings);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "choosing" | "checking" | "restarting" | "restart-failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const chooseFolder = async () => {
    setError(null);
    setPhase("choosing");
    try {
      const folder = await frontendAPI.selectDirectory(candidate ?? settings.osuStablePath);
      if (!mounted.current || typeof folder !== "string" || !folder) return;
      setPhase("checking");
      const valid = await osuFolderService.isValidOsuFolder(folder);
      if (!mounted.current) return;
      if (!valid) {
        setCandidate(null);
        setError("Select an osu!stable folder containing osu!.db, scores.db and Skins.");
        return;
      }
      setCandidate(folder === settings.osuStablePath ? null : folder);
    } catch {
      if (mounted.current) setError("Could not open or check the folder. Try again.");
    } finally {
      if (mounted.current) setPhase("idle");
    }
  };

  const applyFolder = async () => {
    if (!candidate) return;
    const retryingRestart = phase === "restart-failed";
    setError(null);
    setPhase("restarting");
    let saved = retryingRestart;
    try {
      // Persist before relaunch; the generic settings store normally debounces writes.
      if (!retryingRestart) osuFolderService.setOsuFolder(candidate);
      saved = true;
      await frontendAPI.reboot();
    } catch {
      if (!mounted.current) return;
      setError(
        saved
          ? "Folder saved. Hindsight could not restart. Retry or close and reopen Hindsight to finish applying the change."
          : "Could not save this folder. Check available storage and try again.",
      );
      setPhase(saved ? "restart-failed" : "idle");
    }
  };

  const restartFailed = phase === "restart-failed";
  const busy = phase !== "idle" && !restartFailed;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "8px", py: "6px", minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
        <Box sx={{ ...fieldSx, ...(settings.osuStablePath ? {} : { color: REWIND_COLORS.textDim }) }}>
          {settings.osuStablePath || "Not selected"}
        </Box>
        <FolderButton raised disabled={busy || restartFailed} onClick={() => void chooseFolder()}>
          {phase === "checking" ? "Checking folder…" : "Change…"}
        </FolderButton>
      </Box>
      <Box component="span" sx={hintSx}>
        Hindsight restarts to apply a new folder.
      </Box>
      {candidate && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: "6px", pt: "4px" }}>
          <Box component="span" sx={{ ...hintSx, fontWeight: 500 }}>
            New folder
          </Box>
          <Box sx={{ display: "flex" }}>
            <Box sx={fieldSx}>{candidate}</Box>
          </Box>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <FolderButton raised disabled={busy} onClick={() => void applyFolder()}>
              {phase === "restarting" ? "Restarting Hindsight…" : restartFailed ? "Retry restart" : "Apply and restart"}
            </FolderButton>
            {!restartFailed && (
              <FolderButton
                raised
                disabled={busy}
                onClick={() => {
                  setCandidate(null);
                  setError(null);
                }}
              >
                Cancel
              </FolderButton>
            )}
          </Box>
        </Box>
      )}
      {error && (
        <Box role="alert" sx={{ ...hintSx, color: REWIND_COLORS.judgementMiss }}>
          {error}
        </Box>
      )}
    </Box>
  );
}
