import { Box } from "@mui/material";
import { useObservable } from "rxjs-hooks";
import { useReplayLoadState } from "../../hooks/replay-load-state";
import { useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { REWIND_COLORS, REWIND_FOCUS_RING, REWIND_LAYOUT } from "../../styles/tokens";
import { GameTimeSlider } from "./GameTimeSlider";
import { PlayButton, TimeReadout } from "./TimeReadout";
import { SpeedStepper } from "./SpeedStepper";
import { AudioButton, HiddenButton, SettingsButton } from "./DockIconButtons";
import { ReplayActions } from "./ReplayActions";

export function Dock() {
  const analyzer = useAnalysisApp();
  const clipState = useObservable(() => analyzer.clipRecorder.state$, analyzer.clipRecorder.state$.value);
  const busy = ["preparing", "recording", "rendering", "saving"].includes(clipState.status);
  const ready = useReplayLoadState().phase === "ready";
  // While Export is open the transport previews the clip, which has its own length and speed: no speed, audio or Hidden.
  const { exportSession } = useInspector();
  return (
    <Box
      component="fieldset"
      disabled={busy}
      sx={{
        border: 0,
        m: 0,
        px: "16px",
        py: 0,
        minWidth: 0,
        height: REWIND_LAYOUT.dockHeight,
        boxSizing: "border-box",
        lineHeight: 1.4,
        display: "grid",
        gridTemplateRows: `${REWIND_LAYOUT.timelineRowHeight}px ${REWIND_LAYOUT.transportRowHeight}px`,
        backgroundColor: REWIND_COLORS.dock,
        boxShadow: `inset 0 1px 0 ${REWIND_COLORS.hairline}`,
      }}
    >
      {/* 50 px lane: difficulty graph above the rail at y 25, error marks above it, 100/50 marks below. */}
      <Box data-playback-wheel sx={{ position: "relative", minWidth: 0 }}>
        <GameTimeSlider disabled={busy || !ready} />
      </Box>
      {/* One keyboard focus ring for every transport control (MUI ButtonBase sets outline: 0). */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "14px",
          minWidth: 0,
          fontSize: 13,
          color: REWIND_COLORS.textBright,
          "& .Mui-focusVisible": REWIND_FOCUS_RING,
        }}
      >
        {/* A fieldset cannot be `display: contents` in Chromium, so the group is its own flex row. */}
        <Box
          component="fieldset"
          disabled={!ready}
          sx={{
            border: 0,
            m: 0,
            p: 0,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: "14px",
            opacity: ready ? 1 : 0.38,
            pointerEvents: ready ? undefined : "none",
          }}
        >
          <PlayButton />
          <TimeReadout />
          {!exportSession && (
            <>
              <SpeedStepper />
              <AudioButton />
              <HiddenButton />
            </>
          )}
        </Box>
        <Box sx={{ flex: 1 }} />
        <ReplayActions replayReady={ready} settings={<SettingsButton />} />
      </Box>
    </Box>
  );
}
