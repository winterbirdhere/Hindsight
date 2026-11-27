import { injectable } from "inversify";
import type { JSONSchemaType } from "ajv";
import { PersistentService } from "../core/service";
import {
  DEFAULT_REPLAY_DISPLAY_SETTINGS,
  ReplayDisplaySettings,
  ReplayDisplaySettingsSchema,
} from "./replay-display-settings";
import type { ClipExportOptions, ClipExportWidth, ClipExportFrameRate } from "../manager/clip-export-types";
import { ALLOWED_SPEEDS } from "../../utils/constants";

export interface ClipExportSettings {
  width: ClipExportWidth;
  fps: ClipExportFrameRate;
  audio: boolean;
  /** The clip's playback speed, remembered across sessions and replays; read through `sanitizeClipSpeed`. */
  speed: number;
  /** Where the save dialog opens; empty means the system Videos folder. */
  saveFolder: string;
  displaySettings: ReplayDisplaySettings;
  /** Legacy: read only by the settings migration. */
  showHitErrorBar: boolean;
  showReplayCursor: boolean;
  showAnalysisCursor: boolean;
  showComparisonCursor: boolean;
}

export const DEFAULT_CLIP_EXPORT_SETTINGS: Readonly<ClipExportSettings> = Object.freeze({
  width: 1920,
  fps: 60,
  audio: true,
  speed: 1,
  saveFolder: "",
  displaySettings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS },
  showHitErrorBar: true,
  showReplayCursor: true,
  showAnalysisCursor: false,
  showComparisonCursor: false,
});

export const ClipExportSettingsSchema: JSONSchemaType<ClipExportSettings> = {
  type: "object",
  properties: {
    width: { type: "number", enum: [1920, 2560, 3840], default: 1920 },
    fps: { type: "number", enum: [60, 120, 144, 240], default: 60 },
    audio: { type: "boolean", default: true },
    // No bounds here: an old or odd saved value must load, and is read through `sanitizeClipSpeed`.
    speed: { type: "number", default: 1 },
    // Any string loads; the main process decides whether the folder is usable.
    saveFolder: { type: "string", default: "" },
    displaySettings: { ...ReplayDisplaySettingsSchema, default: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS } },
    showHitErrorBar: { type: "boolean", default: true },
    showReplayCursor: { type: "boolean", default: true },
    showAnalysisCursor: { type: "boolean", default: false },
    showComparisonCursor: { type: "boolean", default: false },
  },
  required: [],
};

/** The value when it is one of the speeds the steppers offer, 1 otherwise. */
export function sanitizeClipSpeed(value: unknown): number {
  return typeof value === "number" && ALLOWED_SPEEDS.includes(value) ? value : 1;
}

@injectable()
export class ClipExportSettingsStore extends PersistentService<ClipExportSettings> {
  key = "clip-export";
  schema = ClipExportSettingsSchema;

  getDefaultValue(): ClipExportSettings {
    return { ...DEFAULT_CLIP_EXPORT_SETTINGS, displaySettings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS } };
  }
}

/** Clip preferences are independent from the viewer and are snapshotted per recording. */
export function clipAppearanceOptions(
  settings: ClipExportSettings,
): Pick<
  ClipExportOptions,
  | "preset"
  | "showKeys"
  | "showTiming"
  | "showStats"
  | "displaySettings"
  | "showHitErrorBar"
  | "showReplayCursor"
  | "showAnalysisCursor"
  | "showComparisonCursor"
> {
  const display = settings.displaySettings;
  return {
    preset: "analysis",
    showKeys: display.keyOverlapEnabled,
    showTiming: display.unstableRateEnabled || display.timingBiasEnabled,
    showStats:
      display.performancePointsEnabled ||
      display.starRatingEnabled ||
      display.maxComboEnabled ||
      display.liveResult100Enabled ||
      display.liveResult50Enabled ||
      display.liveResultMissEnabled ||
      display.liveResultSliderBreakEnabled ||
      display.liveResultSliderTickEnabled ||
      display.liveResultSliderEndEnabled,
    // The clip's own display settings as the store holds them; a copy, so a recording is a snapshot.
    displaySettings: { ...display },
    showHitErrorBar: display.hitErrorBarEnabled,
    showReplayCursor: settings.showReplayCursor,
    showAnalysisCursor: settings.showAnalysisCursor,
    showComparisonCursor: settings.showComparisonCursor,
  };
}
