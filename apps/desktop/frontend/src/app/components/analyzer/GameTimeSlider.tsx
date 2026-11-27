import { Box } from "@mui/material";
import { useCallback, useMemo } from "react";
import { useObservable } from "rxjs-hooks";
import { BaseGameTimeSlider } from "./BaseGameTimeSlider";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { useGameClockControls } from "../../hooks/game-clock";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { buildTimelineMarkerGroups } from "./timeline-markers";
import { ClipRangeOverlay } from "./ClipRangeOverlay";
import { useClipExportRange } from "../../hooks/clip-export";
import { useInspector } from "../../providers/InspectorProvider";
import { useTimelineSection } from "../../hooks/timeline-section";
import { MAX_DRAG_SECTION_MS } from "../../services/common/timeline-section";

const EMPTY_DIFFICULTIES: number[] = [];

export function GameTimeSlider({ disabled = false }: { disabled?: boolean }) {
  const { seekTo, duration, baseRate } = useGameClockControls();
  const analyzer = useAnalysisApp();
  const { gameSimulator, gameClock, replayDisplaySettingsStore } = analyzer;
  const { playbarSettingsStore } = useCommonManagers();
  const { exportSession, mode } = useInspector();
  const { range, setRange, durationMs } = useClipExportRange();
  const replayEvents = useObservable(() => gameSimulator.replayEvents$, []);
  const rulesetFocus = useObservable(() => gameSimulator.rulesetFocus$, "stable");
  const difficulties = useObservable(() => gameSimulator.difficulties$, []);
  const playbarSettings = useObservable(() => playbarSettingsStore.settings$, DEFAULT_PLAY_BAR_SETTINGS);
  const displaySettings = useObservable(
    () => replayDisplaySettingsStore.settings$,
    replayDisplaySettingsStore.settings,
  );

  const events = useMemo(
    () => buildTimelineMarkerGroups(replayEvents, rulesetFocus, displaySettings),
    [replayEvents, rulesetFocus, displaySettings],
  );

  // The lane can show one stretch of the map instead of all of it (right-click, right-drag, Alt and the wheel; Esc
  // or `Full map` to go back). Not while it is the export range picker, and Esc only while the inspector is at rest.
  const errorTimes = useMemo(
    () =>
      events
        .filter((group) => group.placement === "above")
        .flatMap((group) => group.timings)
        .sort((a, b) => a - b),
    [events],
  );
  const zoom = useTimelineSection({ enabled: !exportSession && !disabled, escape: mode === "incidents", errorTimes });

  // During an export session the timeline is the range picker: a seek stays inside the clip's range.
  const handleSeek = useCallback(
    (value: number) => seekTo(exportSession ? Math.min(range.endMs, Math.max(range.startMs, value)) : value),
    [seekTo, exportSession, range],
  );

  return (
    // The lane box is the containing block of the range overlay, so its percentages refer to the lane.
    <Box sx={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
      <BaseGameTimeSlider
        backgroundEnable
        duration={duration}
        currentTime={gameClock.timeElapsedInMs}
        playback={analyzer}
        playbackRate={baseRate}
        onChange={handleSeek}
        events={events}
        difficulties={playbarSettings.difficultyGraphEnabled ? difficulties : EMPTY_DIFFICULTIES}
        disabled={disabled}
        section={zoom.section}
        noteTimes={zoom.noteTimes}
        {...(exportSession
          ? {}
          : {
              onSectionAt: zoom.showAt,
              onSectionDrag: zoom.showDrag,
              onSectionZoom: zoom.zoom,
              onSectionExit: zoom.exit,
              sectionDragLimitMs: MAX_DRAG_SECTION_MS,
            })}
      />
      {exportSession && (
        <ClipRangeOverlay range={range} durationMs={durationMs} locked={disabled} onChange={setRange} />
      )}
    </Box>
  );
}
