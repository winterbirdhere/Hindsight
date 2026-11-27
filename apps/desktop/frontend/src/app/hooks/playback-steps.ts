import { isHitCircle, type Beatmap } from "@osujs/core";
import { useCallback, useEffect, useRef } from "react";
import { skip, Subscription } from "rxjs";
import { useAnalysisApp, useCommonManagers } from "../providers/TheaterProvider";
import { barStep, frameStep, noteStep, nudgeStep, type StepDirection, type StepMap } from "../services/common/playback-steps";

/**
 * A step while the replay plays holds playback: each step then lands where it should, from a still frame. Playback
 * goes on this long after the last step.
 */
export const STEP_RESUME_MS = 500;

/** The four sizes of a step: the wheel (a note), an arrow key alone (a nudge), with Ctrl, and with Shift. */
export type StepKind = "nudge" | "note" | "frame" | "bar";

interface StepSource {
  beatmap: Beatmap | undefined;
  frames: readonly { time: number }[] | undefined;
}

/** When each note of a beatmap starts and ends, in order. */
export function noteTimesOf(beatmap: Beatmap | undefined): number[] {
  const times: number[] = [];
  for (const object of beatmap?.hitObjects ?? []) {
    if (isHitCircle(object)) times.push(object.hitTime);
    else times.push(object.startTime, object.endTime);
  }
  return times.filter(Number.isFinite).sort((a, b) => a - b);
}

/** A beatmap's timing points, in order: where each starts, its beat and how many beats its bar has. */
export function timingPointsOf(beatmap: Beatmap | undefined): StepMap["timingPoints"] {
  return (beatmap?.controlPointInfo?.timingPoints?.list ?? [])
    .filter((point) => Number.isFinite(point.time) && point.beatLength > 0)
    .map((point) => ({ time: point.time, beatLength: point.beatLength, beatsPerBar: Number(point.timeSignature) }))
    .sort((a, b) => a.time - b.time);
}

/** What the steps of one beatmap and replay are measured on. */
function stepMapOf({ beatmap, frames }: StepSource, durationMs: number): StepMap {
  return {
    noteTimes: noteTimesOf(beatmap),
    timingPoints: timingPointsOf(beatmap),
    frameTimes: (frames ?? []).map((frame) => frame.time).sort((a, b) => a - b),
    durationMs,
  };
}

/**
 * Moves the playhead by a nudge, a note, a frame or a bar (see `services/common/playback-steps`). Only the note step
 * (the wheel) follows the viewer's `Scroll step` setting. Nothing moves while a clip export owns the clock.
 *
 * Stepping while the replay plays is one gesture: the first step pauses, the rest move a still frame, and playback
 * goes on `STEP_RESUME_MS` after the last. If the viewer plays, pauses or seeks some other way meanwhile, that
 * stands and nothing resumes. Stepping out of an incident replay or a clip preview leaves it paused.
 */
export function usePlaybackSteps() {
  const { gameSimulator, gameClock, clipRecorder } = useAnalysisApp();
  const { playbarSettingsStore } = useCommonManagers();
  // Built once for a beatmap and replay, and again when either or the length changes.
  const cached = useRef<{ source: StepSource; map: StepMap } | undefined>(undefined);

  // While playback is held for stepping: the timer that lets it go on, and how to call the hold off.
  const held = useRef<{ timer: ReturnType<typeof setTimeout>; release(): void } | undefined>(undefined);
  const ownSeek = useRef(false);
  useEffect(() => () => held.current?.release(), []);

  const step = useCallback(
    (kind: StepKind, direction: StepDirection) => {
      if (clipRecorder?.isBusy) return;
      if (gameClock.isPlaying) {
        // Something that plays to an end of its own is ended by the pause and is not taken up again.
        const resumes = gameClock.playbackBoundaryInMs === undefined;
        gameClock.pause();
        if (resumes) {
          const subscription = new Subscription();
          const release = () => {
            subscription.unsubscribe();
            if (held.current) clearTimeout(held.current.timer);
            held.current = undefined;
          };
          // The viewer plays or seeks some other way: theirs to decide from here.
          subscription.add(gameClock.isPlaying$.pipe(skip(1)).subscribe(release));
          subscription.add(gameClock.seeked$.subscribe(() => void (ownSeek.current || release())));
          held.current = { timer: setTimeout(() => undefined, 0), release };
        }
      }
      const source: StepSource = { beatmap: gameSimulator.getPrimaryBeatmap(), frames: gameSimulator.getPrimaryReplay()?.frames };
      const durationMs = gameClock.durationInMs;
      const known = cached.current;
      if (!known || known.source.beatmap !== source.beatmap || known.source.frames !== source.frames || known.map.durationMs !== durationMs)
        cached.current = { source, map: stepMapOf(source, durationMs) };
      const map = (cached.current as { map: StepMap }).map;
      const time = gameClock.timeElapsedInMs;
      const target =
        kind === "nudge"
          ? nudgeStep(time, direction, map)
          : kind === "frame"
            ? frameStep(time, direction, map)
            : kind === "bar"
              ? barStep(time, direction, map)
              : noteStep(time, direction, playbarSettingsStore.settings.scrollStep, map);
      ownSeek.current = true;
      gameClock.seekTo(target);
      ownSeek.current = false;
      const hold = held.current;
      if (hold) {
        clearTimeout(hold.timer);
        hold.timer = setTimeout(() => {
          hold.release();
          gameClock.start();
        }, STEP_RESUME_MS);
      }
    },
    [gameSimulator, gameClock, clipRecorder, playbarSettingsStore],
  );
  return { step };
}

// One notch of an ordinary wheel, in the pixels a wheel event reports.
const NOTCH_PIXELS = 100;
// A free-spinning wheel reports many notches at once; this many steps at most come of one event.
const MAX_STEPS_PER_EVENT = 8;
// Small deltas (a touchpad) add up to a notch, unless the scrolling paused this long or turned round.
const CARRY_RESET_MS = 300;

/**
 * The wheel steps the playhead, as it does in the osu! editor: a note for each notch, a frame with Ctrl, a bar with
 * Shift. Only over the stage and the timeline (`data-playback-wheel`); everything else scrolls as usual. Alt and the
 * wheel is left to the key overlay, which zooms with it.
 */
export function usePlaybackWheel(step: (kind: StepKind, direction: StepDirection) => void, isReplayLoaded: () => boolean) {
  useEffect(() => {
    let carried = 0;
    let lastAt = 0;
    const onWheel = (event: WheelEvent) => {
      if (!isReplayLoaded() || event.altKey || event.metaKey || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || !event.target.closest("[data-playback-wheel]")) return;
      // A dialog is in front of the stage, whatever it is drawn inside.
      if (event.target.closest('[role="dialog"], .MuiModal-root')) return;
      // With Shift held the browser turns the wheel sideways.
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      // Ctrl and the wheel would zoom the page otherwise.
      event.preventDefault();
      const pixels = event.deltaMode === 1 ? delta * 40 : event.deltaMode === 2 ? delta * 800 : delta;
      let steps: number;
      if (Math.abs(pixels) >= NOTCH_PIXELS / 2) {
        // A wheel: whole notches, whatever size this mouse reports for one.
        steps = Math.max(1, Math.round(Math.abs(pixels) / NOTCH_PIXELS));
        carried = 0;
      } else {
        if (Math.sign(pixels) !== Math.sign(carried) || event.timeStamp - lastAt > CARRY_RESET_MS) carried = 0;
        carried += pixels;
        steps = Math.floor(Math.abs(carried) / NOTCH_PIXELS);
        carried -= Math.sign(carried) * steps * NOTCH_PIXELS;
      }
      lastAt = event.timeStamp;
      const kind: StepKind = event.ctrlKey ? "frame" : event.shiftKey ? "bar" : "note";
      // Wheel down goes forward in time.
      const direction: StepDirection = pixels > 0 ? 1 : -1;
      for (let count = Math.min(steps, MAX_STEPS_PER_EVENT); count > 0; count--) step(kind, direction);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [step, isReplayLoaded]);
}
