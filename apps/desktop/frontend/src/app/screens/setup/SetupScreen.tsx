import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Box } from "@mui/material";
import username from "username";
import { useNavigate } from "react-router-dom";
import { frontendAPI } from "../../api";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_FONTS } from "../../styles/tokens";
import { checkOsuFolder, OsuFolderChecks, osuFolderReady } from "../../services/setup/osu-folder-checks";
import { SetupHelp } from "./SetupHelp";

const CHECK_DELAY_MS = 200;

interface CheckResult {
  path: string;
  checks: OsuFolderChecks;
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
      <polyline points="2,6.5 5,9 10,3" fill="none" stroke={REWIND_COLORS.judgement100} strokeWidth="1.6" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
      <path d="M3 3 L9 9 M9 3 L3 9" fill="none" stroke={REWIND_COLORS.judgementMiss} strokeWidth="1.6" />
    </svg>
  );
}

/** A 4 px dot in the 12 px icon slot: information, neither a pass nor a failure. */
function NeutralDot() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="6" cy="6" r="2" fill="#6a675f" />
    </svg>
  );
}

function CheckRow({ ok, neutral = false, children }: { ok: boolean; neutral?: boolean; children: React.ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: 12.5,
        color: neutral ? "#a8a59e" : ok ? REWIND_COLORS.textMuted : "#ffb3bd",
      }}
    >
      {neutral ? <NeutralDot /> : ok ? <CheckIcon /> : <CrossIcon />}
      {children}
    </Box>
  );
}

async function userNameOrEmpty(): Promise<string> {
  try {
    return (await username()) ?? "";
  } catch {
    return "";
  }
}

export function SetupScreen() {
  const [path, setPath] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButton = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const analyzer = useAnalysisApp();
  // Every text change and every started check takes a new number; only the newest check may publish its result.
  const newest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const runCheck = useCallback(async (candidate: string) => {
    const request = ++newest.current;
    const checks = await checkOsuFolder(candidate, await userNameOrEmpty());
    if (mounted.current && request === newest.current) setResult({ path: candidate, checks });
  }, []);

  const changePath = useCallback(
    (next: string, immediately: boolean) => {
      if (!mounted.current) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      ++newest.current;
      setPath(next);
      setResult(null);
      // Only the trimmed text is ever checked or saved; the field keeps what the user typed.
      const candidate = next.trim();
      if (candidate === "") return;
      if (immediately) void runCheck(candidate);
      else timer.current = setTimeout(() => void runCheck(candidate), CHECK_DELAY_MS);
    },
    [runCheck],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const browse = useCallback(() => {
    void frontendAPI.selectDirectory(path.trim()).then((selected: string | null) => {
      if (selected !== null) changePath(selected, true);
    });
  }, [changePath, path]);

  const trimmedPath = path.trim();
  const current = result !== null && result.path === trimmedPath ? result.checks : null;
  const ready = current !== null && osuFolderReady(current);
  const invalid = current !== null && !ready;

  const confirm = useCallback(() => {
    if (!ready) return;
    analyzer.osuFolderService.setOsuFolder(trimmedPath);
    navigate("/app/analyzer");
  }, [analyzer.osuFolderService, navigate, trimmedPath, ready]);

  return (
    <Box
      onKeyDown={(event: React.KeyboardEvent) => {
        if (event.key === "Escape" && helpOpen) {
          event.preventDefault();
          setHelpOpen(false);
          helpButton.current?.focus();
        }
      }}
      sx={{
        height: "100vh",
        boxSizing: "border-box",
        p: "24px",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        bgcolor: REWIND_COLORS.bg,
        color: REWIND_COLORS.textPrimary,
        fontFamily: REWIND_FONTS.ui,
        fontSize: 13,
        lineHeight: 1.4,
      }}
    >
      <Box
        sx={{
          width: "100%",
          maxWidth: 440,
          my: "auto",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: "18px",
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <Box component="h1" sx={{ m: 0, fontSize: 22, fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
            Where is osu! installed?
          </Box>
          <Box component="span" sx={{ fontSize: 13.5, color: REWIND_COLORS.textSecondary, textWrap: "pretty" }}>
            Hindsight reads beatmaps from Songs and watches Replays for new plays. It never writes to this folder.
          </Box>
        </Box>

        {/* One column with no gap of its own: the checks add their 18 px only while rows are shown. */}
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Box
              component="input"
              type="text"
              aria-label="osu! folder"
              aria-invalid={invalid ? "true" : undefined}
              placeholder="Choose your osu! folder"
              spellCheck={false}
              autoComplete="off"
              value={path}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => changePath(event.target.value, false)}
              onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter") confirm();
              }}
              sx={{
                flex: 1,
                minWidth: 0,
                height: 36,
                boxSizing: "border-box",
                p: "0 12px",
                border: 0,
                borderRadius: "6px",
                bgcolor: REWIND_COLORS.inset,
                boxShadow: `inset 0 0 0 1px ${invalid ? REWIND_COLORS.judgementMiss : "rgba(255,255,255,0.14)"}`,
                color: REWIND_COLORS.textPrimary,
                fontFamily: REWIND_FONTS.mono,
                fontSize: 13,
                textOverflow: "ellipsis",
                "&::placeholder": { color: REWIND_COLORS.textDim, opacity: 1 },
                "&:focus-visible": REWIND_FOCUS_RING,
              }}
            />
            <Box
              component="button"
              type="button"
              onClick={browse}
              sx={{
                height: 32,
                p: "0 14px",
                border: 0,
                borderRadius: "6px",
                cursor: "pointer",
                whiteSpace: "nowrap",
                bgcolor: REWIND_COLORS.control,
                boxShadow: REWIND_COLORS.controlEdge,
                color: REWIND_COLORS.textBright,
                fontFamily: REWIND_FONTS.ui,
                fontSize: 13,
                fontWeight: 500,
                "&:hover": { bgcolor: REWIND_COLORS.controlActive, color: REWIND_COLORS.white },
                "&:focus-visible": REWIND_FOCUS_RING,
              }}
            >
              Browse…
            </Box>
          </Box>

          {/* Always mounted so assistive technology announces the rows when they appear. */}
          <Box
            role="status"
            sx={{ display: "flex", flexDirection: "column", gap: "6px", mt: current === null ? 0 : "18px" }}
          >
            {current !== null && (
              <>
                <CheckRow ok={current.songs}>{current.songs ? "Songs folder found" : "No Songs folder here"}</CheckRow>
                {/* Replays is optional: replay files can still be opened without the folder. */}
                <CheckRow ok={current.replays} neutral={!current.replays}>
                  {current.replays
                    ? "Replays folder found"
                    : "No Replays folder here. You can still open replay files."}
                </CheckRow>
                {!current.core && <CheckRow ok={false}>osu!.db, scores.db or the Skins folder is missing</CheckRow>}
              </>
            )}
          </Box>
        </Box>

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            mt: "6px",
            pt: "18px",
            boxShadow: `inset 0 1px 0 ${REWIND_COLORS.hairline}`,
          }}
        >
          <Box
            component="button"
            type="button"
            ref={helpButton}
            aria-expanded={helpOpen}
            aria-controls={helpOpen ? "setup-help" : undefined}
            onClick={() => setHelpOpen((open) => !open)}
            sx={{
              p: 0,
              border: 0,
              background: "none",
              cursor: "pointer",
              fontFamily: REWIND_FONTS.ui,
              fontSize: 13,
              color: REWIND_COLORS.accentSoft,
              textDecoration: "none",
              "&:hover": { color: REWIND_COLORS.white, textDecoration: "underline" },
              "&:focus-visible": REWIND_FOCUS_RING,
            }}
          >
            Setup help
          </Box>
          <Box sx={{ flex: 1 }} />
          <Box
            component="button"
            type="button"
            disabled={!ready}
            onClick={confirm}
            sx={{
              height: 36,
              p: "0 16px",
              border: 0,
              borderRadius: "6px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              bgcolor: "#f2f1ee",
              color: "#17181c",
              fontFamily: REWIND_FONTS.ui,
              fontSize: 13.5,
              fontWeight: 600,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.4), 0 2px 8px rgba(0,0,0,0.4)",
              "&:hover": { bgcolor: REWIND_COLORS.white },
              "&:focus-visible": REWIND_FOCUS_RING,
              "&:disabled": { opacity: 0.4, cursor: "default", bgcolor: "#f2f1ee" },
            }}
          >
            Continue
          </Box>
        </Box>
        {helpOpen && <SetupHelp />}
      </Box>
    </Box>
  );
}
