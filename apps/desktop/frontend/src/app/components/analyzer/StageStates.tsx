import { Box } from "@mui/material";
import { useState } from "react";
import { useOpenReplay } from "../../hooks/open-replay";
import {
  loadFraction,
  loadStepRows,
  type LoadStepRow,
  type ReplayLoadState,
} from "../../services/manager/replay-load-state";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { RewindLogo } from "../logo/RewindLogo";
import { GhostButton, GlowButton } from "./GlowButton";

const COLUMN = { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" } as const;

function Heading({ title, body }: { title: string; body?: string }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "6px", alignItems: "center" }}>
      <Box
        component="h2"
        sx={{
          m: 0,
          font: `600 22px/1.2 ${REWIND_FONTS.ui}`,
          letterSpacing: "-0.01em",
          color: REWIND_COLORS.textPrimary,
        }}
      >
        {title}
      </Box>
      {body && (
        <Box component="span" sx={{ fontSize: 13.5, color: REWIND_COLORS.textSecondary, textWrap: "pretty", overflowWrap: "anywhere" }}>
          {body}
        </Box>
      )}
    </Box>
  );
}

/** 7d: no replay is open. */
export function StageEmpty() {
  const { open, disabled, shortcut } = useOpenReplay();
  return (
    <Box sx={{ ...COLUMN, gap: "18px", maxWidth: 420 }}>
      <Box sx={{ mb: "6px", display: "flex" }}>
        <RewindLogo size={92} />
      </Box>
      <Heading
        title="No replay open"
        body="Drop an .osr file anywhere in this window, or open one from your Replays folder."
      />
      <GlowButton
        aria-label="Open replay"
        aria-keyshortcuts={shortcut}
        disabled={disabled}
        onClick={() => void open()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <svg width="16" height="14" viewBox="0 0 14 12" aria-hidden>
          <rect x="1" y="1" width="5" height="3" rx="0.8" fill={REWIND_COLORS.accentSoft} />
          <rect
            x="1"
            y="3"
            width="12"
            height="8"
            rx="1.2"
            fill="none"
            stroke={REWIND_COLORS.accentSoft}
            strokeWidth="1.4"
          />
        </svg>
        Open replay
        <Box component="span" sx={{ font: `500 12px ${REWIND_FONTS.mono}`, color: REWIND_COLORS.textSecondary }}>
          {shortcut}
        </Box>
      </GlowButton>
      <Box component="span" sx={{ fontSize: 12.5, color: REWIND_COLORS.textTertiary, textWrap: "pretty" }}>
        In osu!, press F2 on a score or fail screen to send the replay here.
      </Box>
    </Box>
  );
}

function RowMark({ status }: { status: LoadStepRow["status"] }) {
  if (status === "done") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        <polyline
          points="2,6.5 5,9 10,3"
          style={{ fill: "none", stroke: REWIND_COLORS.judgement100, strokeWidth: 1.6 }}
        />
      </svg>
    );
  }
  if (status === "active") {
    return (
      <Box
        component="span"
        sx={{ width: 8, height: 8, borderRadius: "50%", boxShadow: `inset 0 0 0 1.5px ${REWIND_COLORS.textPrimary}` }}
      />
    );
  }
  return <Box component="span" sx={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: "#6a675f" }} />;
}

const ROW_STYLE: Record<LoadStepRow["status"], { color: string; fontWeight: number }> = {
  done: { color: REWIND_COLORS.textSecondary, fontWeight: 400 },
  active: { color: REWIND_COLORS.textPrimary, fontWeight: 500 },
  pending: { color: REWIND_COLORS.textDim, fontWeight: 400 },
};

/** 7e: the replay is loading; the map's background shows blurred behind the steps once it is known. */
export function StageLoading({ state }: { state: ReplayLoadState }) {
  const [failedBackground, setFailedBackground] = useState<string | undefined>();
  const percent = Math.round(loadFraction(state) * 100);
  const background = state.backgroundUrl !== failedBackground ? state.backgroundUrl : undefined;
  return (
    <Box sx={{ position: "absolute", inset: 0, overflow: "hidden", display: "grid", placeItems: "center" }}>
      {background && (
        <Box
          component="img"
          alt=""
          src={background}
          onError={() => setFailedBackground(background)}
          sx={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: "blur(18px) saturate(0.6)",
            transform: "scale(1.08)",
          }}
        />
      )}
      {/* Heavier than the mock's 0.72: the mock blurred an already dimmed capture, the app blurs the raw background. */}
      <Box data-testid="loading-veil" sx={{ position: "absolute", inset: 0, backgroundColor: "rgba(11,11,13,0.86)" }} />
      <Box sx={{ position: "relative", width: 300, display: "flex", flexDirection: "column", gap: "16px" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <Box component="span" sx={{ font: `600 18px ${REWIND_FONTS.ui}`, color: REWIND_COLORS.textPrimary }}>
            Loading replay
          </Box>
          <Box
            role="progressbar"
            aria-label="Loading replay"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            sx={{ height: 2, backgroundColor: "rgba(255,255,255,0.13)" }}
          >
            <Box sx={{ width: `${percent}%`, height: 2, backgroundColor: REWIND_COLORS.textPrimary }} />
          </Box>
        </Box>
        <Box
          component="ol"
          sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "9px" }}
        >
          {loadStepRows(state).map((row) => (
            <Box
              component="li"
              key={row.label}
              data-status={row.status}
              aria-current={row.status === "active" ? "step" : undefined}
              sx={{
                display: "grid",
                gridTemplateColumns: "14px minmax(0, 1fr)",
                alignItems: "center",
                gap: "10px",
                fontSize: 13,
                ...ROW_STYLE[row.status],
              }}
            >
              <Box component="span" sx={{ display: "grid", placeItems: "center" }}>
                <RowMark status={row.status} />
              </Box>
              {row.label}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/** 7f: the replay could not be loaded. */
export function StageError({ state }: { state: ReplayLoadState }) {
  const { open, disabled } = useOpenReplay();
  const failure = state.failure;
  const notFound = failure?.kind === "beatmap-not-found";
  const beatmapUrl =
    failure?.kind === "beatmap-not-found" && failure.lookup === "found" ? failure.beatmapUrl : undefined;
  const title = notFound ? "Beatmap not found" : "Replay couldn't be loaded";
  let body: string | undefined;
  if (failure?.kind === "other") body = failure.message;
  else if (beatmapUrl) body = "It isn't in your Songs folder.";
  else if (failure?.lookup === "unavailable") body = "It isn't in your Songs folder and Hindsight couldn't check online.";
  else if (failure) body = "It isn't in your Songs folder and couldn't be found online.";
  const openAnother = (Button: typeof GlowButton | typeof GhostButton) => (
    <Button disabled={disabled} onClick={() => void open()} onKeyDown={(event) => event.stopPropagation()}>
      Open another replay
    </Button>
  );
  return (
    <Box sx={{ ...COLUMN, gap: "22px", maxWidth: 440 }}>
      <RewindLogo variant="broken" size={104} />
      <Heading title={title} body={body} />
      <Box sx={{ display: "flex", gap: "6px", alignItems: "center" }}>
        {beatmapUrl ? (
          <>
            <GlowButton href={beatmapUrl}>
              Find beatmap on osu! web
              <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
                <path
                  d="M3 1.5 H9.5 V8 M9.5 1.5 L1.5 9.5"
                  style={{ fill: "none", stroke: REWIND_COLORS.accentSoft, strokeWidth: 1.5 }}
                />
              </svg>
            </GlowButton>
            {openAnother(GhostButton)}
          </>
        ) : (
          openAnother(GlowButton)
        )}
      </Box>
    </Box>
  );
}
