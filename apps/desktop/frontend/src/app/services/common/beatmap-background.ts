import { injectable } from "inversify";
import { BehaviorSubject } from "rxjs";
import { Texture } from "pixi.js";
import { PersistentService } from "../core/service";
import { JSONSchemaType } from "ajv";

export interface BeatmapBackgroundSettings {
  // Whether it should be rendered or not. Temporarily disabling with this flag gives a better UX than setting the dim
  // to 100% since the user can retain the old value.
  enabled: boolean;
  // dim = 1 - alpha
  dim: number;
  // Whether the art's left edge is darkened behind the stats, in the viewer and in exported clips alike. Without it
  // the stats are outlined instead.
  statsShade: boolean;
}

export const DEFAULT_BEATMAP_BACKGROUND_SETTINGS: BeatmapBackgroundSettings = Object.freeze({
  dim: 0.8,
  enabled: true,
  statsShade: false,
});
export const BeatmapBackgroundSettingsSchema: JSONSchemaType<BeatmapBackgroundSettings> = {
  type: "object",
  properties: {
    dim: { type: "number", default: DEFAULT_BEATMAP_BACKGROUND_SETTINGS.dim },
    enabled: { type: "boolean", default: DEFAULT_BEATMAP_BACKGROUND_SETTINGS.enabled },
    statsShade: { type: "boolean", default: DEFAULT_BEATMAP_BACKGROUND_SETTINGS.statsShade },
  },
  required: [],
};

@injectable()
export class BeatmapBackgroundSettingsStore extends PersistentService<BeatmapBackgroundSettings> {
  key = "beatmap-background";
  schema = BeatmapBackgroundSettingsSchema;

  // TODO: Move?
  texture$ = new BehaviorSubject<Texture>(Texture.EMPTY);

  getDefaultValue(): BeatmapBackgroundSettings {
    return DEFAULT_BEATMAP_BACKGROUND_SETTINGS;
  }

  get texture() {
    return this.texture$.getValue();
  }

  setDim(dim: number) {
    this.settings$.next({ ...this.settings, dim });
  }

  setEnabled(enabled: boolean) {
    this.settings$.next({ ...this.settings, enabled });
  }

  setStatsShade(statsShade: boolean) {
    this.settings$.next({ ...this.settings, statsShade });
  }
}
