import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import { summarizeReplayEvents } from "../../services/analysis/replay-events";
import {
  DEFAULT_REPLAY_DISPLAY_SETTINGS,
  type ReplayDisplaySettings,
} from "../../services/analysis/replay-display-settings";
import { REWIND_COLORS } from "../../styles/tokens";
import type { BaseGameTimeSliderProps } from "./BaseGameTimeSlider";

/** Mark sizes from the 3a mock: errors above the rail, 100/50 and slider ends below. */
export const TIMELINE_MARKS = {
  miss: { width: 2, height: 15 },
  sliderBreak: { width: 1.5, height: 11 },
  meh: { width: 1.5, height: 14 },
  ok: { width: 1, height: 10 },
  sliderEnd: { width: 1, height: 10 },
} as const;

type Marker = BaseGameTimeSliderProps["events"][number];
const marker = (
  color: string,
  timings: number[],
  tooltip: string,
  size: { width: number; height: number },
  placement: "above" | "below",
): Marker => ({ color, timings, tooltip, markerWidth: size.width, markerHeight: size.height, placement, opacity: 1 });

/** Taller type first, shorter drawn on top, so co-located types both stay visible (spec §7.1). */
export function buildTimelineMarkerGroups(
  replayEvents: ReplayAnalysisEvent[],
  rulesetFocus: ReplayAnalysisRuleset,
  displaySettings: Pick<
    ReplayDisplaySettings,
    | "timeline100Enabled"
    | "timeline50Enabled"
    | "timelineMissEnabled"
    | "timelineSliderBreakEnabled"
    | "timelineSliderTickEnabled"
    | "timelineSliderEndEnabled"
  > = DEFAULT_REPLAY_DISPLAY_SETTINGS,
): BaseGameTimeSliderProps["events"] {
  const { timings } = summarizeReplayEvents(replayEvents, rulesetFocus);
  const groups: Marker[] = [];
  if (displaySettings.timelineMissEnabled)
    groups.push(marker(REWIND_COLORS.judgementMiss, timings.miss, "Misses", TIMELINE_MARKS.miss, "above"));
  if (rulesetFocus === "stable" && displaySettings.timelineSliderBreakEnabled)
    groups.push(
      marker(REWIND_COLORS.sliderBreak, timings.sliderBreak, "Slider Breaks", TIMELINE_MARKS.sliderBreak, "above"),
    );
  if (rulesetFocus === "lazer" && displaySettings.timelineSliderTickEnabled)
    groups.push(
      marker(
        REWIND_COLORS.sliderBreak,
        timings.lazerSliderTickMiss,
        "Slider Tick misses",
        TIMELINE_MARKS.sliderBreak,
        "above",
      ),
    );
  if (displaySettings.timeline50Enabled)
    groups.push(marker(REWIND_COLORS.judgement50, timings.meh, "50s", TIMELINE_MARKS.meh, "below"));
  if (displaySettings.timeline100Enabled)
    groups.push(marker(REWIND_COLORS.judgement100, timings.ok, "100s", TIMELINE_MARKS.ok, "below"));
  if (displaySettings.timelineSliderEndEnabled)
    groups.push(
      marker(
        REWIND_COLORS.sliderEnd,
        rulesetFocus === "stable" ? timings.stableSliderEndMiss : timings.lazerSliderEndMiss,
        "SliderEnd misses",
        TIMELINE_MARKS.sliderEnd,
        "below",
      ),
    );
  return groups;
}
