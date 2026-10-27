import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import { useLayoutEffect, useRef } from "react";
import { formatGameTime } from "@osujs/math";
import { BaseCurrentTime, GameCurrentTimeHandle } from "./BaseCurrentTime";
import { useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { useClipExportRange, useTransportToggle } from "../../hooks/clip-export";
import { useGameClockControls } from "../../hooks/game-clock";
import { clipElapsedSeconds, clipVideoSeconds, formatClipTime } from "../../services/manager/clip-range";
import { preventPointerFocus } from "../../utils/focus";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { observeTimelinePlayback } from "./timeline-playback";
import { PauseIcon, PlayIcon } from "./icons";

export function CurrentTime() {
  const analyzer = useAnalysisApp();
  const timeRef = useRef<GameCurrentTimeHandle>(null);

  useLayoutEffect(
    () =>
      observeTimelinePlayback(analyzer, () =>
        timeRef.current?.updateTime(analyzer.gameClock.timeElapsedInMs / analyzer.gameClock.baseRate),
      ),
    [analyzer],
  );

  return (
    <Box
      title="Elapsed replay time at the modded rate"
      // 8ch fits "0:00.000" in the mono face exactly; longer maps grow by one character.
      sx={{ minWidth: "8ch", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
    >
      <BaseCurrentTime ref={timeRef} />
    </Box>
  );
}

export function Duration() {
  const { duration, baseRate } = useGameClockControls();
  return (
    <Typography
      variant="inherit"
      title="Replay duration at the modded rate"
      sx={{ fontVariantNumeric: "tabular-nums" }}
    >
      {formatGameTime(duration / baseRate)}
    </Typography>
  );
}

/**
 * The dock's readout in an export session. It leads with the map time under the playhead, the same time the replay's
 * own readout shows and the Export panel's Start and End are typed in: a readout that began at 0:00 with the clip
 * made a player type clip times into fields that take map times. The time into the clip and the clip's length at the
 * playback rate follow, smaller. All of it is minutes and seconds. The two times that move are written straight into
 * their elements per frame, like `CurrentTime`, so the dock does not re-render with the playhead; the clip's length
 * only changes with the range or the rate.
 */
export function ClipTimeReadout() {
  const analyzer = useAnalysisApp();
  const { range, playbackRate } = useClipExportRange();
  const { duration } = useGameClockControls();
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<HTMLSpanElement>(null);

  const elapsedText = (timeMs: number) => formatGameTime(clipElapsedSeconds(timeMs, range, playbackRate) * 1000, true);
  useLayoutEffect(
    () =>
      observeTimelinePlayback(analyzer, () => {
        const timeMs = analyzer.gameClock.timeElapsedInMs;
        const elapsed = formatGameTime(clipElapsedSeconds(timeMs, range, playbackRate) * 1000, true);
        // The raw map time, as the range fields have it.
        const map = formatGameTime(timeMs, true);
        if (elapsedRef.current && elapsedRef.current.textContent !== elapsed) elapsedRef.current.textContent = elapsed;
        if (mapRef.current && mapRef.current.textContent !== map) mapRef.current.textContent = map;
      }),
    [analyzer, range, playbackRate],
  );

  // Wide enough for "m:ss.mmm" up to the replay's and the clip's own length, so nothing after them moves.
  const clipSeconds = clipVideoSeconds(range, playbackRate);
  const widthFor = (seconds: number) => `${(Number.isFinite(seconds) ? String(Math.floor(Math.max(0, seconds) / 60)).length : 1) + 7}ch`;

  return (
    <Box
      role="group"
      aria-label="Clip time"
      sx={{
        display: "flex",
        alignItems: "baseline",
        flexShrink: 0,
        fontFamily: REWIND_FONTS.mono,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "pre",
      }}
    >
      <Box
        component="span"
        ref={mapRef}
        title="Map time under the playhead, as Start and End are typed"
        sx={{ minWidth: widthFor(duration / 1000), fontSize: 16, color: REWIND_COLORS.textPrimary, fontVariantNumeric: "tabular-nums" }}
      >
        {formatGameTime(analyzer.gameClock.timeElapsedInMs, true)}
      </Box>
      <Box
        component="span"
        title="Time into the clip, and the clip's length"
        sx={{ ml: "14px", fontSize: 12.5, color: REWIND_COLORS.textTertiary }}
      >
        {"clip "}
        <Box component="span" ref={elapsedRef} sx={{ display: "inline-block", minWidth: widthFor(clipSeconds) }}>
          {elapsedText(analyzer.gameClock.timeElapsedInMs)}
        </Box>
        {` / ${formatClipTime(clipSeconds * 1000)}`}
      </Box>
    </Box>
  );
}

export function PlayButton() {
  const { isPlaying } = useGameClockControls();
  const toggleTransport = useTransportToggle();

  return (
    <Tooltip title={isPlaying ? "Pause" : "Play"}>
      <IconButton
        aria-label={isPlaying ? "Pause replay" : "Play replay"}
        onClick={() => toggleTransport()}
        onMouseDown={preventPointerFocus}
        sx={{
          width: 30,
          height: 30,
          p: 0,
          borderRadius: "50%",
          background: "linear-gradient(180deg, #f4f3f0, #d8d6d0)",
          color: "#17181c",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6), 0 2px 8px rgba(0,0,0,0.5)",
          "&:hover": { background: "#ffffff" },
        }}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </IconButton>
    </Tooltip>
  );
}

export function TimeReadout() {
  const { exportSession } = useInspector();
  if (exportSession) return <ClipTimeReadout />;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "baseline",
        fontFamily: REWIND_FONTS.mono,
        fontSize: 16,
        color: REWIND_COLORS.textPrimary,
      }}
    >
      <CurrentTime />
      <Box sx={{ display: "flex", alignItems: "baseline", color: REWIND_COLORS.textTertiary, fontSize: 13, whiteSpace: "pre" }}>
        <Box component="span">{" / "}</Box>
        <Duration />
      </Box>
    </Box>
  );
}
