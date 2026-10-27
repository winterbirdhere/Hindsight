import { Position, Vec2 } from "@osujs/math";
import { Beatmap } from "../beatmap/Beatmap";
import { RELAX_LENIENCY } from "../mods/Mods";
import { OsuAction } from "../replays/Replay";
import { GameState, NOT_PRESSING } from "./GameState";

/** Legacy RX files omit automatic presses. Modern lazer files already record them. */
export function legacyRelaxActionsAt(
  beatmap: Beatmap,
  state: GameState,
  position: Position,
  time: number,
  lateHitWindow: number,
): OsuAction[] {
  let requiresHit = false;
  let requiresHold = false;
  for (const id of state.aliveHitCircleIds) {
    const circle = beatmap.getHitCircle(id);
    if (circle.sliderId !== undefined && time > beatmap.getSlider(circle.sliderId).endTime) continue;
    const offset = time - circle.hitTime;
    if (
      offset >= -RELAX_LENIENCY &&
      offset <= lateHitWindow &&
      Vec2.withinDistance(position, circle.position, Math.fround(circle.radius))
    )
      requiresHit = true;
  }
  for (const id of state.aliveSliderIds) {
    const slider = beatmap.getSlider(id);
    if (time < slider.startTime - RELAX_LENIENCY || time > slider.endTime) continue;
    const tracking = state.sliderBodyState.get(id)?.isTracking ?? false;
    const progress = slider.duration === 0 ? 1 : Math.max(0, Math.min(1, (time - slider.startTime) / slider.duration));
    if (
      Vec2.withinDistance(position, slider.ballPositionAt(progress), Math.fround(slider.radius * (tracking ? 2.4 : 1)))
    ) {
      requiresHold = true;
    }
  }
  for (const id of state.aliveSpinnerIds) {
    const spinner = beatmap.getSpinner(id);
    if (time <= spinner.endTime && spinner.spinsRequired > 0) requiresHold = true;
  }

  const held = state.pressingSince.findIndex((since) => since !== NOT_PRESSING);
  if (requiresHit || (requiresHold && held < 0)) {
    // OsuModRelax releases before a fresh hit and alternates, starting on right.
    const action = state.lazerRelaxLastAction === OsuAction.rightButton ? OsuAction.leftButton : OsuAction.rightButton;
    state.lazerRelaxLastAction = action;
    state.lazerRelaxLastStateChangeTime = time;
    return [action];
  }
  if (held >= 0 && (requiresHold || time - (state.lazerRelaxLastStateChangeTime ?? time) <= 50)) {
    return [held as OsuAction];
  }
  if (held >= 0) state.lazerRelaxLastStateChangeTime = time;
  return [];
}
