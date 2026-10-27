import { PersistentService } from "../core/service";
import { injectable } from "inversify";
import { JSONSchemaType } from "ajv";
import { SCROLL_STEPS, type ScrollStep } from "./playback-steps";

/** The speeds the hold-to-slow key can play at. */
export const HOLD_SPEEDS = [0.25, 0.5, 0.75] as const;

export interface PlaybarSettings {
  difficultyGraphEnabled: boolean;
  /** What one notch of the wheel moves the playhead by. The arrow keys move a fixed 30 ms, whatever this is. */
  scrollStep: ScrollStep;
  /** The speed of the overview while Q is held. */
  holdSpeed: number;
}

export const DEFAULT_PLAY_BAR_SETTINGS: PlaybarSettings = Object.freeze({
  difficultyGraphEnabled: true,
  scrollStep: "auto",
  holdSpeed: 0.5,
});

export const PlaybarSettingsSchema: JSONSchemaType<PlaybarSettings> = {
  type: "object",
  properties: {
    difficultyGraphEnabled: { type: "boolean", default: DEFAULT_PLAY_BAR_SETTINGS.difficultyGraphEnabled },
    scrollStep: { type: "string", enum: [...SCROLL_STEPS], default: DEFAULT_PLAY_BAR_SETTINGS.scrollStep },
    holdSpeed: { type: "number", enum: [...HOLD_SPEEDS], default: DEFAULT_PLAY_BAR_SETTINGS.holdSpeed },
  },
  required: [],
};

@injectable()
export class PlaybarSettingsStore extends PersistentService<PlaybarSettings> {
  key = "playbar";
  schema = PlaybarSettingsSchema;

  getDefaultValue(): PlaybarSettings {
    return DEFAULT_PLAY_BAR_SETTINGS;
  }
}
