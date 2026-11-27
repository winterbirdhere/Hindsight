import { JSONSchemaType } from "ajv";
import { injectable } from "inversify";
import { PersistentService } from "../core/service";

/** How long the key overlay's roll is: a longer one shows more time at the same scale. */
export type KeyOverlayLength = "short" | "medium" | "long";

/** Which errors get a ring on the playfield: none, the inspected one with its incident, or every one. */
export type ErrorOutlineMode = "off" | "selected" | "all";

export interface ReplayDisplaySettings {
  /** "compact" is the saved key for the display style named Minimal. */
  statsStyle: "classic" | "compact";
  errorCauseDisplay: "concise" | "brief";
  /** Viewer only: an exported clip never draws the outline. */
  errorOutline: ErrorOutlineMode;
  /** Viewer only: with a ring, the cursor's path and the taps the analysis attributes to the object. */
  missTrailEnabled: boolean;
  /** Viewer only: the number beside each of those taps, its timing or how far outside the circle it landed. */
  tapNumbersEnabled: boolean;
  keyOverlapEnabled: boolean;
  keyOverlayLength: KeyOverlayLength;
  /** The key overlay colours the object marks of misses and slider breaks. Its own switch: not tied to the error outline. */
  keyOverlayErrorMarksEnabled: boolean;
  unstableRateEnabled: boolean;
  timingBiasEnabled: boolean;
  performancePointsEnabled: boolean;
  starRatingEnabled: boolean;
  /** Legacy: replaced by the liveResult* keys; read only by the pre-Phase-4 clip renderer. */
  judgementCountsEnabled: boolean;
  /** Legacy preference retained for existing saved settings; overlays no longer show max combo. */
  maxComboEnabled: boolean;
  /** Legacy: replaced by the liveResult* keys; read only by the pre-Phase-4 clip renderer. */
  sliderJudgementsEnabled: boolean;
  currentComboEnabled: boolean;
  accuracyEnabled: boolean;
  timeline100Enabled: boolean;
  timeline50Enabled: boolean;
  timelineMissEnabled: boolean;
  timelineSliderBreakEnabled: boolean;
  timelineSliderTickEnabled: boolean;
  timelineSliderEndEnabled: boolean;
  liveResult100Enabled: boolean;
  liveResult50Enabled: boolean;
  liveResultMissEnabled: boolean;
  liveResultSliderBreakEnabled: boolean;
  liveResultSliderTickEnabled: boolean;
  liveResultSliderEndEnabled: boolean;
  hitErrorBarEnabled: boolean;
  /** Raw scale; the UI shows it as a percentage of 2.0. */
  hitErrorBarScale: number;
}

export type ReplayDisplayToggleKey = {
  [Key in keyof ReplayDisplaySettings]: ReplayDisplaySettings[Key] extends boolean ? Key : never;
}[keyof ReplayDisplaySettings];

export const DEFAULT_REPLAY_DISPLAY_SETTINGS: ReplayDisplaySettings = Object.freeze({
  statsStyle: "classic",
  errorCauseDisplay: "concise",
  errorOutline: "off",
  missTrailEnabled: true,
  tapNumbersEnabled: false,
  keyOverlapEnabled: true,
  keyOverlayLength: "medium",
  keyOverlayErrorMarksEnabled: true,
  unstableRateEnabled: true,
  timingBiasEnabled: true,
  performancePointsEnabled: true,
  starRatingEnabled: true,
  judgementCountsEnabled: true,
  maxComboEnabled: true,
  sliderJudgementsEnabled: true,
  currentComboEnabled: true,
  accuracyEnabled: true,
  timeline100Enabled: true,
  timeline50Enabled: true,
  timelineMissEnabled: true,
  timelineSliderBreakEnabled: true,
  timelineSliderTickEnabled: true,
  timelineSliderEndEnabled: false,
  liveResult100Enabled: true,
  liveResult50Enabled: true,
  liveResultMissEnabled: true,
  liveResultSliderBreakEnabled: true,
  liveResultSliderTickEnabled: true,
  liveResultSliderEndEnabled: true,
  hitErrorBarEnabled: true,
  hitErrorBarScale: 2.0,
});

/** The per-result live readout switches, in display order. */
export const LIVE_RESULT_KEYS: readonly ReplayDisplayToggleKey[] = Object.freeze([
  "liveResult100Enabled",
  "liveResult50Enabled",
  "liveResultMissEnabled",
  "liveResultSliderBreakEnabled",
  "liveResultSliderTickEnabled",
  "liveResultSliderEndEnabled",
] as const);

export const ReplayDisplaySettingsSchema: JSONSchemaType<ReplayDisplaySettings> = {
  type: "object",
  properties: {
    statsStyle: { type: "string", enum: ["classic", "compact"], default: DEFAULT_REPLAY_DISPLAY_SETTINGS.statsStyle },
    errorCauseDisplay: {
      type: "string",
      enum: ["concise", "brief"],
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.errorCauseDisplay,
    },
    errorOutline: {
      type: "string",
      enum: ["off", "selected", "all"],
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.errorOutline,
    },
    missTrailEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.missTrailEnabled },
    tapNumbersEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.tapNumbersEnabled },
    keyOverlapEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.keyOverlapEnabled },
    keyOverlayErrorMarksEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.keyOverlayErrorMarksEnabled },
    keyOverlayLength: {
      type: "string",
      enum: ["short", "medium", "long"],
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.keyOverlayLength,
    },
    unstableRateEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.unstableRateEnabled },
    timingBiasEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timingBiasEnabled },
    performancePointsEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.performancePointsEnabled,
    },
    starRatingEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.starRatingEnabled },
    judgementCountsEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.judgementCountsEnabled },
    maxComboEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.maxComboEnabled },
    sliderJudgementsEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.sliderJudgementsEnabled,
    },
    currentComboEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.currentComboEnabled },
    accuracyEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.accuracyEnabled },
    timeline100Enabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timeline100Enabled },
    timeline50Enabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timeline50Enabled },
    timelineMissEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timelineMissEnabled },
    timelineSliderBreakEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timelineSliderBreakEnabled,
    },
    timelineSliderTickEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timelineSliderTickEnabled,
    },
    timelineSliderEndEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.timelineSliderEndEnabled,
    },
    liveResult100Enabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResult100Enabled },
    liveResult50Enabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResult50Enabled },
    liveResultMissEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResultMissEnabled },
    liveResultSliderBreakEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResultSliderBreakEnabled,
    },
    liveResultSliderTickEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResultSliderTickEnabled,
    },
    liveResultSliderEndEnabled: {
      type: "boolean",
      default: DEFAULT_REPLAY_DISPLAY_SETTINGS.liveResultSliderEndEnabled,
    },
    hitErrorBarEnabled: { type: "boolean", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.hitErrorBarEnabled },
    hitErrorBarScale: { type: "number", default: DEFAULT_REPLAY_DISPLAY_SETTINGS.hitErrorBarScale },
  },
  required: [],
};

@injectable()
export class ReplayDisplaySettingsStore extends PersistentService<ReplayDisplaySettings> {
  key = "replay-display";
  schema = ReplayDisplaySettingsSchema;

  getDefaultValue(): ReplayDisplaySettings {
    return DEFAULT_REPLAY_DISPLAY_SETTINGS;
  }
}
