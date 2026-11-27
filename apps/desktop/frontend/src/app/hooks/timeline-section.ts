import { useCallback, useEffect, useMemo, useState } from "react";
import { skip, Subscription } from "rxjs";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { defaultSection, dragSection, pageSection, zoomSection, type TimelineSection } from "../services/common/timeline-section";
import { useGameClockControls } from "./game-clock";
import { noteTimesOf, timingPointsOf } from "./playback-steps";

const NO_NOTES: readonly number[] = [];
// Esc belongs to whatever is open or being typed in before it belongs to the timeline.
const ESC_TAKEN_BY_TARGET = 'input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';
const ESC_TAKEN_BY_OPEN = '[role="dialog"], [role="menu"], [role="listbox"], .MuiModal-root';

/**
 * The stretch of the map the timeline lane shows instead of the whole map, and what changes it: a right-click (the
 * default section around the point), a right-drag (that stretch), Alt and the wheel (longer or shorter), Esc or the
 * `Full map` button (the whole map again). The section holds the playhead. Playback that runs off its end starts it
 * again from its start, so a section plays over and over; a seek to somewhere else takes the section along, by pages.
 * `enabled` is false while the lane is something else (the export range picker) or has no replay.
 */
export function useTimelineSection(options: { enabled: boolean; escape: boolean; errorTimes: readonly number[] }) {
  const { enabled, escape, errorTimes } = options;
  const analyzer = useAnalysisApp();
  const { gameClock, gameSimulator } = analyzer;
  const { seekTo, duration } = useGameClockControls();
  const [section, setSection] = useState<TimelineSection | undefined>(undefined);
  const zoomed = section !== undefined;

  // Another replay, or a lane that is something else now: the whole map again.
  useEffect(() => setSection(undefined), [duration, enabled]);

  useEffect(() => {
    if (!section) return;
    const page = () => setSection((current) => current && pageSection(current, gameClock.timeElapsedInMs, gameClock.durationInMs));
    // An incident replay or a clip preview plays to an end of its own; the section does not take it back.
    const playsToItsOwnEnd = () => gameClock.playbackBoundaryInMs !== undefined;
    const subscription = new Subscription();
    let restart: ReturnType<typeof setTimeout> | undefined;
    // Playback that runs off the section's end plays the section again.
    subscription.add(
      analyzer.frameRendered$.subscribe(() => {
        if (gameClock.controlsLocked || !gameClock.isPlaying || gameClock.timeElapsedInMs <= section.endMs) return;
        if (playsToItsOwnEnd()) page();
        else seekTo(section.startMs);
      }),
    );
    // At the end of the map the clock stops by itself before any frame is past it, and puts the playhead on the
    // end after saying so: the last section starts again once it has.
    subscription.add(
      gameClock.isPlaying$.pipe(skip(1)).subscribe((playing) => {
        const atMapEnd = section.endMs >= gameClock.durationInMs - 1 && gameClock.timeElapsedInMs >= section.endMs - 1;
        if (playing || !atMapEnd || playsToItsOwnEnd()) return;
        restart = setTimeout(() => {
          seekTo(section.startMs);
          gameClock.start();
        }, 0);
      }),
    );
    // A seek to somewhere else takes the section along, by pages.
    subscription.add(gameClock.seeked$.subscribe(page));
    return () => {
      subscription.unsubscribe();
      clearTimeout(restart);
    };
  }, [section, analyzer, gameClock, seekTo]);

  const exit = useCallback(() => setSection(undefined), []);
  useEffect(() => {
    if (!zoomed || !escape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(ESC_TAKEN_BY_TARGET)) return;
      if (document.querySelector(ESC_TAKEN_BY_OPEN)) return;
      setSection(undefined);
    };
    // Heard on the way down, before the control with the focus: the timeline's slider, the dock's buttons and the
    // incident rows keep their keys to themselves, and the focus is on one of them after any click.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [zoomed, escape]);

  const showAt = useCallback(
    (timeMs: number, nearMs: number) => {
      if (!enabled) return;
      const next = defaultSection(timeMs, {
        timingPoints: timingPointsOf(gameSimulator.getPrimaryBeatmap?.()),
        errorTimes,
        durationMs: gameClock.durationInMs,
        nearMs,
      });
      // The playhead goes to the point, and the lane shows what is around it.
      seekTo(timeMs);
      setSection(next);
    },
    [enabled, gameSimulator, gameClock, errorTimes, seekTo],
  );

  const showDrag = useCallback(
    (fromMs: number, toMs: number) => {
      if (!enabled) return;
      const next = dragSection(fromMs, toMs, gameClock.durationInMs);
      const time = gameClock.timeElapsedInMs;
      // A stretch chosen elsewhere takes the playhead to its start.
      if (next && (time < next.startMs || time > next.endMs)) seekTo(next.startMs);
      setSection(next);
    },
    [enabled, gameClock, seekTo],
  );

  const zoom = useCallback(
    (factor: number, anchorMs: number) => {
      if (!enabled) return;
      setSection((current) => {
        const time = gameClock.timeElapsedInMs;
        const next = zoomSection(current, factor, anchorMs, gameClock.durationInMs);
        // Around the pointer, unless that would leave the playhead outside: then around the playhead.
        return next && (time < next.startMs || time > next.endMs) ? zoomSection(current, factor, time, gameClock.durationInMs) : next;
      });
    },
    [enabled, gameClock],
  );

  // The notes get a tick each in a section, where there is room for them.
  const noteTimes = useMemo(
    () => (zoomed ? noteTimesOf(gameSimulator.getPrimaryBeatmap?.()) : NO_NOTES),
    // The length stands for the replay: another map has another one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoomed, gameSimulator, duration],
  );

  return { section, noteTimes, showAt, showDrag, zoom, exit };
}
