import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Subscription } from "rxjs";
import { skip } from "rxjs/operators";
import { useObservable } from "rxjs-hooks";
import { useInspector } from "../providers/InspectorProvider";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { sanitizeClipSpeed } from "../services/analysis/clip-export-settings";
import {
  enterClipPreview,
  followClipRange,
  leaveClipPreview,
  toggleClipPreview,
  type TransportSnapshot,
} from "../services/manager/clip-preview-transport";
import { normalizeClipRange, type ClipRange } from "../services/manager/clip-range";

/**
 * The export range as the inspector stores it, resolved against the replay: no range is the whole replay, and a stored
 * range is clamped to the replay's current duration. `playbackRate` is the replay's rate times the clock's speed; during
 * an export session the clock's speed is the clip's speed.
 */
export function useClipExportRange(): {
  range: ClipRange;
  setRange(next: ClipRange): void;
  durationMs: number;
  playbackRate: number;
} {
  const { gameClock } = useAnalysisApp();
  const { exportRange, setExportRange } = useInspector();
  const durationMs = useObservable(() => gameClock.durationInMs$, gameClock.durationInMs);
  const baseRate = useObservable(() => gameClock.baseRate$, gameClock.baseRate);
  const speed = useObservable(() => gameClock.speed$, gameClock.speed);
  const range = useMemo(() => normalizeClipRange(exportRange, durationMs), [exportRange, durationMs]);
  const setRange = useCallback(
    (next: ClipRange) => setExportRange(normalizeClipRange(next, durationMs)),
    [setExportRange, durationMs],
  );
  return { range, setRange, durationMs, playbackRate: baseRate * speed };
}

/** The clip preview toggle during an export session, the ordinary clock toggle otherwise; nothing while the recorder is busy. */
export function useTransportToggle(): () => void {
  const { gameClock, clipRecorder } = useAnalysisApp();
  const { exportSession } = useInspector();
  const { range } = useClipExportRange();
  return useCallback(() => {
    if (clipRecorder?.isBusy) return;
    if (exportSession) toggleClipPreview(gameClock, range);
    else gameClock.toggle();
  }, [gameClock, clipRecorder, exportSession, range]);
}

/**
 * While an export session is open the dock's transport previews the clip: playback is bounded to the range and runs at
 * the clip's own speed, which lives in the saved clip store (like resolution and frame rate): the clock takes it on
 * entering, and a speed chosen during the session is written back at once. The viewer's position, speed and play state
 * come back when the session ends. Mounted once, in the analyzer shell.
 *
 * A session belongs to the replay it was entered on. The hook acts on the clock only while that same replay is still
 * the primary one; once it is not (cleared, replaced, load in progress) the viewer's snapshot is dropped, the session
 * is ended (closeMode, no range; retried when the inspector is unlocked) and the new or cleared clock is never given
 * the old replay's boundary, speed, position or play state. The clip speed is not part of that: another replay keeps it.
 */
export function useClipExportTransport(): void {
  const { gameClock, gameSimulator, clipRecorder, clipExportSettingsStore } = useAnalysisApp();
  const { exportSession, locked, closeMode, setExportRange } = useInspector();
  const { range, durationMs } = useClipExportRange();

  // What the callbacks need to read without re-subscribing: the newest committed values.
  const latest = useRef({ range, exportSession, locked, closeMode, setExportRange });
  useLayoutEffect(() => {
    latest.current = { range, exportSession, locked, closeMode, setExportRange };
  });

  /** The viewer's transport and the replay it was taken on, kept from entering until leaving; null while no preview runs. */
  const snapshot = useRef<{ transport: TransportSnapshot; replay: unknown } | null>(null);
  /** The range the clock is currently bounded to. */
  const followed = useRef<ClipRange>(range);
  /** Writes the clock's speed to the clip store while a session is open; null when no session is listening. */
  const speedListener = useRef<Subscription | null>(null);
  /** The primary replay when the open session started (undefined when there was none). */
  const sessionReplay = useRef<unknown>(undefined);
  /** The primary replay as of the last check, to notice a replay change in any inspector mode. */
  const knownReplay = useRef<unknown>(gameSimulator.getPrimaryReplay());
  /** A new replay's range reset (and session close) that the inspector has not yet accepted, e.g. while locked. */
  const resetPending = useRef(false);

  /** Stops copying the clock's speed to the store. Always before the viewer's speed goes back on the clock. */
  const stopListening = useCallback(() => {
    speedListener.current?.unsubscribe();
    speedListener.current = null;
  }, []);

  const leave = useCallback(
    (resume: boolean) => {
      const entered = snapshot.current;
      if (!entered) return;
      snapshot.current = null;
      stopListening();
      const restore = () => {
        const replay = gameSimulator.getPrimaryReplay();
        // Another replay owns the clock now: give it nothing of the old one.
        if (!replay || replay !== entered.replay) return;
        leaveClipPreview(gameClock, entered.transport, resume);
      };
      if (!clipRecorder.isBusy) {
        restore();
        return;
      }
      // The recorder owns the transport until it reports its outcome, which it does after its own restore.
      let done = false;
      const subscription = clipRecorder.state$.subscribe(() => {
        if (done || clipRecorder.isBusy) return;
        done = true;
        restore();
        // Not yet assigned only on the synchronous first emission, which is busy and returned above.
        subscription.unsubscribe();
      });
    },
    [gameClock, gameSimulator, clipRecorder, stopListening],
  );

  /** Compares identities (never trusts one emission to arrive in time) and ends a session that lost its replay. */
  const reconcile = useCallback(() => {
    const replay = gameSimulator.getPrimaryReplay();
    const current = latest.current;
    if (replay !== knownReplay.current) {
      knownReplay.current = replay;
      resetPending.current = true;
    }
    if (current.exportSession && replay !== sessionReplay.current) {
      snapshot.current = null;
      stopListening();
      resetPending.current = true;
    }
    if (resetPending.current && !current.locked) {
      resetPending.current = false;
      if (current.exportSession) current.closeMode();
      current.setExportRange(null);
    }
  }, [gameSimulator, stopListening]);

  // Teardown restores position and settings but must not restart playback.
  useEffect(() => () => leave(false), [leave]);

  // Entering and leaving follow the session, not the inspector's mode: Settings opened from Export stays in it.
  useEffect(() => {
    if (exportSession) {
      const replay = gameSimulator.getPrimaryReplay();
      sessionReplay.current = replay;
      if (snapshot.current || !replay || clipRecorder.isBusy) return;
      followed.current = latest.current.range;
      const stored = sanitizeClipSpeed(clipExportSettingsStore.settings.speed);
      snapshot.current = { transport: enterClipPreview(gameClock, latest.current.range, stored), replay };
      // A speed chosen from now on (the stepper, the up and down arrows) is the clip's speed. The first value is the one just set, and
      // clearing the replay resets the clock to 1x with the old replay still primary: that drops the playback
      // boundary, which a live preview always has, so it is not a choice. Nothing is written while the recorder is busy.
      speedListener.current?.unsubscribe();
      speedListener.current = gameClock.speed$.pipe(skip(1)).subscribe((speed) => {
        if (clipRecorder.isBusy || gameClock.playbackBoundaryInMs === undefined) return;
        if (sanitizeClipSpeed(speed) !== speed || speed === clipExportSettingsStore.settings.speed) return;
        clipExportSettingsStore.changeSettings((draft) => {
          draft.speed = speed;
        });
      });
    } else {
      leave(true);
    }
  }, [exportSession, gameClock, gameSimulator, clipRecorder, clipExportSettingsStore, leave]);

  // An edited range moves the bound and shows the bound that moved.
  useEffect(() => {
    const entered = snapshot.current;
    if (!exportSession || !entered) return;
    if (gameSimulator.getPrimaryReplay() !== entered.replay) {
      snapshot.current = null;
      stopListening();
      return;
    }
    const previous = followed.current;
    if (previous.startMs === range.startMs && previous.endMs === range.endMs) return;
    followed.current = range;
    if (clipRecorder.isBusy) return;
    followClipRange(gameClock, previous, range);
  }, [exportSession, range, gameClock, gameSimulator, clipRecorder, stopListening]);

  // Another replay is another clip. Checked on every replay event (and once more after it, since the simulator emits
  // before it drops the old replay), whenever the duration changes (a cleared clock) and whenever the lock lifts.
  useEffect(() => {
    let disposed = false;
    const subscription = gameSimulator.replayEvents$.subscribe(() => {
      reconcile();
      queueMicrotask(() => {
        if (!disposed) reconcile();
      });
    });
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [gameSimulator, reconcile]);
  useEffect(() => {
    reconcile();
  }, [reconcile, exportSession, locked, durationMs]);
}
