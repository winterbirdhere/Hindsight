import { BeatmapDifficulty } from "../beatmap/BeatmapDifficulty";

/** The native mod representation in a lazer replay's extended score metadata. */
export interface LazerMod {
  acronym: string;
  settings?: Readonly<Record<string, unknown>>;
}

export interface LazerClassicSettings {
  noSliderHeadAccuracy: boolean;
  classicNoteLock: boolean;
  alwaysPlayTailSample: boolean;
  fadeHitCircleEarly: boolean;
  classicHealth: boolean;
}

export type LazerDifficultyAdjust = Partial<
  Pick<BeatmapDifficulty, "circleSize" | "approachRate" | "overallDifficulty" | "drainRate">
>;

export interface ResolvedLazerModSettings {
  clockRate?: number;
  adjustPitch?: boolean;
  difficultyAdjust?: LazerDifficultyAdjust;
  classic?: LazerClassicSettings;
}

function finiteSetting(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined;
}

const booleanSetting = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

/**
 * Resolve osu!standard settings using osu!lazer's native defaults. Omitted
 * settings are defaults, not false/zero. Unknown mod data remains on Beatmap.
 * Source: ppy/osu 48c4800e3ae4ee752452cdff83bd3787ccf3105f, Rulesets/Mods.
 */
export function resolveLazerModSettings(lazerMods: readonly LazerMod[] = []): ResolvedLazerModSettings {
  const resolved: ResolvedLazerModSettings = {};
  const rate = lazerMods.find((mod) => ["DT", "NC", "HT", "DC"].includes(mod.acronym));
  if (rate) {
    const faster = rate.acronym === "DT" || rate.acronym === "NC";
    const value = finiteSetting(rate.settings?.speed_change, faster ? 1.01 : 0.5, faster ? 2 : 0.99);
    resolved.clockRate = value === undefined ? (faster ? 1.5 : 0.75) : Math.round(value * 100) / 100;
    resolved.adjustPitch =
      rate.acronym === "NC" || rate.acronym === "DC" || booleanSetting(rate.settings?.adjust_pitch, false);
  }

  const difficulty = lazerMods.find((mod) => mod.acronym === "DA");
  if (difficulty) {
    resolved.difficultyAdjust = {};
    const fields = {
      circle_size: "circleSize",
      approach_rate: "approachRate",
      overall_difficulty: "overallDifficulty",
      drain_rate: "drainRate",
    } as const;
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
      // DifficultyBindable deliberately accepts extended limits during replay
      // deserialization, even before the extended_limits setting is applied.
      const value = finiteSetting(difficulty.settings?.[key], key === "approach_rate" ? -10 : 0, 11);
      if (value !== undefined) resolved.difficultyAdjust[fields[key]] = value;
    }
  }

  const classic = lazerMods.find((mod) => mod.acronym === "CL");
  if (classic) {
    resolved.classic = {
      noSliderHeadAccuracy: booleanSetting(classic.settings?.no_slider_head_accuracy, true),
      classicNoteLock: booleanSetting(classic.settings?.classic_note_lock, true),
      alwaysPlayTailSample: booleanSetting(classic.settings?.always_play_tail_sample, true),
      fadeHitCircleEarly: booleanSetting(classic.settings?.fade_hit_circle_early, true),
      classicHealth: booleanSetting(classic.settings?.classic_health, true),
    };
  }
  return resolved;
}
