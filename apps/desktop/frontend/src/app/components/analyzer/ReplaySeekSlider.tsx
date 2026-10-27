import { Slider } from "@mui/material";
import { formatGameTime } from "@osujs/math";
import { useCallback, useLayoutEffect, useState } from "react";
import { observeTimelinePlayback, type TimelinePlayback } from "./timeline-playback";
import { REWIND_COLORS } from "../../styles/tokens";

export interface ReplaySeekSliderProps {
  /** Map milliseconds; used directly when there is no live playback source. */
  currentTime: number;
  duration: number;
  playback?: TimelinePlayback;
  playbackRate?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** The stretch of the map the slider spans; the whole map when absent. */
  range?: { startMs: number; endMs: number };
}

const sliderStyle = {
  position: "absolute",
  // Above the events canvas (z-index 2) so the playhead knob paints over the marks, as in the mock.
  zIndex: 3,
  left: 0,
  // Centre of the 2 px rail at y 25–27 of the 50 px lane.
  top: "26px",
  transform: "translate(0, -50%)",
  padding: "8px 0",
  height: 2,
  "& .MuiSlider-rail": { backgroundColor: "rgba(255, 255, 255, 0.13)", opacity: 1 },
  "& .MuiSlider-track": { border: "none", backgroundColor: "rgba(242, 241, 238, 0.62)", transition: "none" },
  "& .MuiSlider-thumb": {
    width: 9,
    height: 9,
    backgroundColor: REWIND_COLORS.textPrimary,
    boxShadow: `0 0 0 2px ${REWIND_COLORS.dock}`,
    transition: "none",
    "&:before": { boxShadow: "none" },
    "&:hover, &.Mui-focusVisible": {
      boxShadow: `0 0 0 2px ${REWIND_COLORS.dock}, 0 0 0 6px rgba(245, 244, 241, 0.14)`,
    },
    "&.Mui-active": { width: 11, height: 11 },
  },
};
const valueLabelFormat = (value: number) => formatGameTime(value);

/** Only the moving slider re-renders per frame; charts and surrounding controls stay outside it. */
export function ReplaySeekSlider({
  currentTime,
  duration,
  playback,
  playbackRate = 1,
  onChange,
  disabled,
  range,
}: ReplaySeekSliderProps) {
  const [frameTime, setFrameTime] = useState(() => playback?.gameClock.timeElapsedInMs ?? currentTime);
  useLayoutEffect(() => {
    if (!playback) return;
    return observeTimelinePlayback(playback, () => setFrameTime(playback.gameClock.timeElapsedInMs));
  }, [playback]);
  const scale = useCallback((mapTime: number) => mapTime / playbackRate, [playbackRate]);

  return (
    <Slider
      aria-label="Replay timeline"
      disabled={disabled}
      onKeyDown={(event) => event.stopPropagation()}
      size="small"
      sx={sliderStyle}
      value={playback ? frameTime : currentTime}
      scale={scale}
      onChange={(_, value) => onChange(value as number)}
      getAriaValueText={valueLabelFormat}
      valueLabelFormat={valueLabelFormat}
      valueLabelDisplay="auto"
      // A stretch of the map is a few seconds across the whole lane: a drag there moves by the millisecond.
      step={range ? 1 : 16}
      min={range ? range.startMs : 0}
      max={range ? range.endMs : duration}
    />
  );
}
