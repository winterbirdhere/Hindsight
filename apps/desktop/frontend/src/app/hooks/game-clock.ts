import { useCallback, useState } from "react";
import { useObservable } from "rxjs-hooks";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { ALLOWED_SPEEDS } from "../utils/constants";
import { useInterval } from "./interval";

export function useGameClock() {
  const analyzer = useAnalysisApp();
  return analyzer.gameClock;
}

// TODO: FLOATING POINT EQUALITY ALERT
const speedIndex = (speed: number) => ALLOWED_SPEEDS.indexOf(speed);
const nextSpeed = (speed: number) => ALLOWED_SPEEDS[Math.min(ALLOWED_SPEEDS.length - 1, speedIndex(speed) + 1)];
const prevSpeed = (speed: number) => ALLOWED_SPEEDS[Math.max(0, speedIndex(speed) - 1)];

export function useGameClockControls() {
  const analyzer = useAnalysisApp();
  const clock = analyzer.gameClock;
  const canControl = useCallback(() => !analyzer.clipRecorder?.isBusy, [analyzer]);

  const isPlaying = useObservable(() => clock.isPlaying$, false);
  const duration = useObservable(() => clock.durationInMs$, 0);
  const speed = useObservable(() => clock.speed$, 1.0);
  const baseRate = useObservable(() => clock.baseRate$, 1.0);

  const toggleClock = useCallback(() => {
    if (canControl()) clock.toggle();
  }, [clock, canControl]);
  const start = useCallback(() => {
    if (canControl()) clock.start();
  }, [clock, canControl]);
  const pause = useCallback(() => {
    if (canControl()) clock.pause();
  }, [clock, canControl]);
  const seekTo = useCallback(
    (timeInMs: number) => {
      if (canControl()) clock.seekTo(timeInMs);
    },
    [clock, canControl],
  );

  const setSpeed = useCallback(
    (x: number) => {
      if (canControl()) clock.setSpeed(x);
    },
    [clock, canControl],
  );
  const increaseSpeed = useCallback(() => {
    if (canControl()) clock.setSpeed(nextSpeed(clock.speed));
  }, [clock, canControl]);
  const decreaseSpeed = useCallback(() => {
    if (canControl()) clock.setSpeed(prevSpeed(clock.speed));
  }, [clock, canControl]);

  const seekForward = useCallback(
    (timeInMs: number) => {
      if (canControl()) clock.seekTo(clock.timeElapsedInMs + timeInMs);
    },
    [clock, canControl],
  );
  const seekBackward = useCallback(
    (timeInMs: number) => {
      if (canControl()) clock.seekTo(clock.timeElapsedInMs - timeInMs);
    },
    [clock, canControl],
  );

  return {
    isPlaying,
    duration,
    speed,
    baseRate,
    // Actions
    setSpeed,
    increaseSpeed,
    decreaseSpeed,
    toggleClock,
    start,
    pause,
    seekTo,
    seekForward,
    seekBackward,
  };
}

// 60FPS by default
export function useGameClockTime(fps = 60) {
  const gameClock = useGameClock();
  const [time, setTime] = useState(0);
  useInterval(() => {
    setTime(gameClock.timeElapsedInMs);
  }, 1000 / fps);
  return time;
}
