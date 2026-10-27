import type { DisplayTarget } from "../../providers/InspectorProvider";
import type { ReplayDisplayToggleKey } from "../../services/analysis/replay-display-settings";
import { REWIND_COLORS } from "../../styles/tokens";

export type DisplaySectionId = "timing" | "performance" | "liveResults" | "timelineMarks" | "gameplayHud" | "cursors";

export interface DisplayToggleSpec {
  key: ReplayDisplayToggleKey;
  label: string;
  /** The judgement colour bar shown in place of the check; absent for plain toggles. */
  color?: string;
  /** Offered to this target only; absent when both targets show the toggle. */
  target?: DisplayTarget;
}

/** The sections the Display tab shows for a target, in order: the clip has cursors and no timeline. */
export function displaySections(target: DisplayTarget): DisplaySectionId[] {
  return target === "clip"
    ? ["timing", "performance", "liveResults", "gameplayHud", "cursors"]
    : ["timing", "performance", "liveResults", "timelineMarks", "gameplayHud"];
}

const RESULT_LABELS = [
  { label: "100", color: REWIND_COLORS.judgement100 },
  { label: "50", color: REWIND_COLORS.judgement50 },
  { label: "Miss", color: REWIND_COLORS.judgementMiss },
  { label: "Slider break", color: REWIND_COLORS.sliderBreak },
  { label: "Slider tick", color: REWIND_COLORS.sliderBreak },
  { label: "Slider end", color: REWIND_COLORS.sliderEnd },
] as const;

function resultToggles(keys: readonly ReplayDisplayToggleKey[]): readonly DisplayToggleSpec[] {
  return RESULT_LABELS.map(({ label, color }, index) => ({ key: keys[index], label, color }));
}

/** The toggles of each section, in display order. Cursors live on `ClipExportSettings` itself, not here. */
export const DISPLAY_TOGGLES: Record<Exclude<DisplaySectionId, "cursors">, readonly DisplayToggleSpec[]> = {
  timing: [
    { key: "keyOverlapEnabled", label: "Key overlay" },
    { key: "unstableRateEnabled", label: "UR" },
    { key: "timingBiasEnabled", label: "Bias" },
    { key: "hitErrorBarEnabled", label: "UR bar" },
  ],
  performance: [
    { key: "performancePointsEnabled", label: "PP" },
    { key: "starRatingEnabled", label: "Star rating" },
    // The clip's Combo row (largest combo so far / the map's maximum); the viewer has no such row. Not the HUD's "Combo".
    { key: "maxComboEnabled", label: "Max combo", target: "clip" },
  ],
  liveResults: resultToggles([
    "liveResult100Enabled",
    "liveResult50Enabled",
    "liveResultMissEnabled",
    "liveResultSliderBreakEnabled",
    "liveResultSliderTickEnabled",
    "liveResultSliderEndEnabled",
  ]),
  timelineMarks: resultToggles([
    "timeline100Enabled",
    "timeline50Enabled",
    "timelineMissEnabled",
    "timelineSliderBreakEnabled",
    "timelineSliderTickEnabled",
    "timelineSliderEndEnabled",
  ]),
  gameplayHud: [
    { key: "currentComboEnabled", label: "Combo" },
    { key: "accuracyEnabled", label: "Accuracy" },
  ],
};

/** The toggles of a section that a target shows: those with no target of their own, and those for this one. */
export function displayToggles(
  section: Exclude<DisplaySectionId, "cursors">,
  target: DisplayTarget,
): readonly DisplayToggleSpec[] {
  return DISPLAY_TOGGLES[section].filter((toggle) => toggle.target === undefined || toggle.target === target);
}
