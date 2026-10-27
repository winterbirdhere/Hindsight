import { GameState, Slider, SliderCheckPoint } from "@osujs/core";

/**
 * Slider-ball visibility is half-open: it is present from the slider start but
 * removed at the exact end timestamp so the plain body cap remains visible.
 */
export function sliderBallVisibleAt(slider: Slider, currentTime: number): boolean {
  return slider.startTime <= currentTime && currentTime < slider.endTime;
}

/**
 * Returns only checkpoint information already resolved at the rendered time.
 * The final replay state must not be consulted here because doing so would make
 * a future hit/miss visible after seeking back before the checkpoint.
 */
export function sliderCheckpointVisualHit(
  checkpoint: SliderCheckPoint,
  currentTime: number,
  currentState: GameState | undefined,
): boolean | null {
  const judgement = currentState?.checkPointVerdict[checkpoint.id];
  if (currentTime < (judgement?.judgementTime ?? checkpoint.hitTime)) return null;
  return judgement?.hit ?? null;
}
