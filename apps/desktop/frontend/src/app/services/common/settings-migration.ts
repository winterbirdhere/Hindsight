import { DEFAULT_HIT_ERROR_BAR_SCALE, HIT_ERROR_LEGACY_KEY, sanitizeUrBarScale } from "./hit-error-bar";

export const SETTINGS_MIGRATION_KEY = "settings-migration";
export const SETTINGS_MIGRATION_VALUE = "3a-display-1";

const VIEWER_KEY = "replay-display";
const CLIP_KEY = "clip-export";

const COUNTER_RESULT_KEYS = ["liveResult100Enabled", "liveResult50Enabled", "liveResultMissEnabled"] as const;
const SLIDER_RESULT_KEYS = [
  "liveResultSliderBreakEnabled",
  "liveResultSliderTickEnabled",
  "liveResultSliderEndEnabled",
] as const;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The parsed object, `null` when the key is absent, `undefined` when it holds anything else. */
function readObject(storage: Pick<Storage, "getItem">, key: string): PlainObject | null | undefined {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function setIfAbsent(target: PlainObject, key: string, value: unknown): void {
  if (target[key] === undefined) target[key] = value;
}

/** A hidden group becomes its individual keys hidden; keys that already exist are kept. */
function migrateGroupedResults(display: PlainObject): void {
  if (display.judgementCountsEnabled === false) {
    for (const key of COUNTER_RESULT_KEYS) setIfAbsent(display, key, false);
  }
  if (display.sliderJudgementsEnabled === false) {
    for (const key of SLIDER_RESULT_KEYS) setIfAbsent(display, key, false);
  }
}

/**
 * One-time upgrade of saved display settings to the 3a keys. Nothing is deleted; the marker is written last,
 * so a failed run is retried on the next start.
 */
export function migrateSettings(storage: Pick<Storage, "getItem" | "setItem">): void {
  try {
    if (storage.getItem(SETTINGS_MIGRATION_KEY) === SETTINGS_MIGRATION_VALUE) return;

    const legacyBar = readObject(storage, HIT_ERROR_LEGACY_KEY);
    const legacyEnabled =
      isPlainObject(legacyBar) && typeof legacyBar.enabled === "boolean" ? legacyBar.enabled : undefined;
    const legacyScale =
      isPlainObject(legacyBar) && sanitizeUrBarScale(legacyBar.scale) === legacyBar.scale
        ? (legacyBar.scale as number)
        : undefined;

    // Viewer store
    const viewer = readObject(storage, VIEWER_KEY);
    if (viewer !== undefined) {
      const next: PlainObject = viewer ?? {};
      const before = JSON.stringify(next);
      migrateGroupedResults(next);
      if (legacyEnabled !== undefined) setIfAbsent(next, "hitErrorBarEnabled", legacyEnabled);
      if (legacyScale !== undefined) setIfAbsent(next, "hitErrorBarScale", legacyScale);
      if (JSON.stringify(next) !== before) storage.setItem(VIEWER_KEY, JSON.stringify(next));
    }

    // Clip store: clips keep the UR bar size they were rendered with (the old viewer size).
    const clip = readObject(storage, CLIP_KEY);
    if (clip === null) {
      if (legacyScale !== undefined && legacyScale !== DEFAULT_HIT_ERROR_BAR_SCALE) {
        storage.setItem(CLIP_KEY, JSON.stringify({ displaySettings: { hitErrorBarScale: legacyScale } }));
      }
    } else if (clip !== undefined) {
      const hasDisplay = Object.prototype.hasOwnProperty.call(clip, "displaySettings");
      const display = hasDisplay ? clip.displaySettings : {};
      if (isPlainObject(display)) {
        const before = JSON.stringify(clip);
        migrateGroupedResults(display);
        if (typeof clip.showHitErrorBar === "boolean") setIfAbsent(display, "hitErrorBarEnabled", clip.showHitErrorBar);
        if (legacyScale !== undefined) setIfAbsent(display, "hitErrorBarScale", legacyScale);
        const next: PlainObject = { ...clip, displaySettings: display };
        if (JSON.stringify(next) !== before) storage.setItem(CLIP_KEY, JSON.stringify(next));
      }
    }

    storage.setItem(SETTINGS_MIGRATION_KEY, SETTINGS_MIGRATION_VALUE);
  } catch (error) {
    console.warn("Could not migrate saved display settings; it will be retried on the next start.", error);
  }
}
