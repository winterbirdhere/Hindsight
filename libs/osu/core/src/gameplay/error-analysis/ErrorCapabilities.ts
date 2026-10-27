import { Beatmap } from "../../beatmap/Beatmap";
import { OsuClassicMods } from "../../mods/Mods";

/** Facets describe prepared model support, never original-client verification. */
export function errorCapabilities(map: Beatmap, profile: string) {
  const native = new Set([
    "NM",
    "NF",
    "EZ",
    "TD",
    "HD",
    "HR",
    "SD",
    "DT",
    "NC",
    "HT",
    "DC",
    "FL",
    "PF",
    "RX",
    "AP",
    "SO",
    "AT",
    "CL",
    "DA",
    "V2",
    "SV2",
  ]);
  const reasons: string[] = [];
  if (!["stable", "lazer"].includes(profile)) reasons.push("unknown-profile");
  if (map.appliedMods.some((mod) => !(OsuClassicMods as readonly string[]).includes(mod)))
    reasons.push("unknown-legacy-mod");
  if (map.lazerMods.some((mod) => !native.has(mod.acronym))) reasons.push("unknown-native-mechanics-mod");
  if (!Number.isFinite(map.gameClockRate) || map.gameClockRate <= 0) reasons.push("invalid-clock-rate");
  const has = (legacy: string, acronym: string) =>
    (map.appliedMods as readonly string[]).includes(legacy) || map.lazerMods.some((m) => m.acronym === acronym);
  const automatic = has("AUTO_PLAY", "AT"),
    relax = has("RELAX", "RX"),
    autopilot = has("AUTO_PILOT", "AP");
  const supported = reasons.length ? ("unsupported" as const) : ("supported" as const);
  return {
    version: 2 as const,
    profile,
    scoring: supported,
    geometry: supported,
    tracking: supported,
    tapping: automatic || relax ? ("automated" as const) : ("manual" as const),
    aim: automatic || autopilot ? ("automated" as const) : ("manual" as const),
    spinner: automatic || has("SPUN_OUT", "SO") ? ("automated" as const) : ("manual" as const),
    input: has("TOUCH_DEVICE", "TD") ? ("logical-touch-actions" as const) : ("logical-actions" as const),
    scoreV2: has("SCORE_V2", "V2") || map.lazerMods.some((m) => m.acronym === "SV2"),
    classicHeadAccuracy: !(map.lazerModSettings.classic?.noSliderHeadAccuracy ?? false),
    classicNoteLock: map.lazerModSettings.classic?.classicNoteLock ?? false,
    reasons,
  };
}
