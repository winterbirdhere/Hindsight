import { Slider } from "../hitobjects/Slider";
import { AllHitObjects, OsuHitObject } from "../hitobjects/Types";
import { OsuClassicMod } from "../mods/Mods";
import { drainSteps } from "./CooperativeSteps";
export { drainSteps, drainStepsAsync, stableSortSteps } from "./CooperativeSteps";

export function normalizeHitObjects(hitObjects: OsuHitObject[]): Record<string, AllHitObjects> {
  return drainSteps(normalizeHitObjectsSteps(hitObjects));
}

export function* normalizeHitObjectsSteps(hitObjects: OsuHitObject[]): Generator<void,Record<string,AllHitObjects>,void> {
  const hitObjectById: Record<string, AllHitObjects> = {};
  let work=0;
  for(const h of hitObjects) {
    if(++work%256===0)yield;
    hitObjectById[h.id] = h;
    if (h instanceof Slider) {
      hitObjectById[h.head.id] = h.head;
      for (const c of h.checkPoints) {
        if(++work%256===0)yield;
        hitObjectById[c.id] = c;
      }
      for (const c of h.stableCheckPoints ?? []) {
        if(++work%256===0)yield;
        // Semantic matches retain the native object; only source-only IDs add
        // entries so native lookups can never receive retimed replacement data.
        if (hitObjectById[c.id] === undefined) hitObjectById[c.id] = c;
      }
    }
  }
  return hitObjectById;
}

export function determineDefaultPlaybackSpeed(mods: OsuClassicMod[]) {
  for (let i = 0; i < mods.length; i++) {
    if (mods[i] === "DOUBLE_TIME" || mods[i] === "NIGHT_CORE") return 1.5;
    if (mods[i] === "HALF_TIME") return 0.75;
  }
  return 1.0;
}
