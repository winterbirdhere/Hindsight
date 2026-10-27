import { Subscription, type Observable } from "rxjs";
import type { GameplayClock } from "../../services/common/game/GameplayClock";

export interface TimelinePlayback {
  gameClock: GameplayClock;
  frameRendered$: Observable<void>;
}

/** Follow completed replay frames without advancing the simulation clock from the UI. */
export function observeTimelinePlayback(playback: TimelinePlayback, update: () => void) {
  const { gameClock, frameRendered$ } = playback;
  const subscription = new Subscription();
  subscription.add(
    frameRendered$.subscribe(() => {
      // Offline export can render faster than the screen. The locked, covered
      // transport does not need to consume React work for every exported frame.
      if (!gameClock.controlsLocked) update();
    }),
  );
  // These also work while paused or with the renderer stopped.
  subscription.add(gameClock.seeked$.subscribe(update));
  subscription.add(gameClock.playbackRate$.subscribe(update));
  subscription.add(gameClock.durationInMs$.subscribe(update));
  subscription.add(gameClock.isPlaying$.subscribe(update));
  return () => subscription.unsubscribe();
}
