import type { LazerMod, SpinnerState } from "@osujs/core";

const MAX_STABLE_SCORE = 0x7fffffff;

/**
 * Raw spin awards, excluding the final 300/100/50 judgement. Stable awards
 * 1100 on each positive even offset beyond required + 3, otherwise 100 on each
 * ordinary even half-turn. Neither award changes combo or receives mod scaling.
 * The caller must supply faithfully simulated Stable counts (including SO).
 * OsuLegacyScoreSimulator.cs:102-113,149-155 at
 * ebaf7e9910ef3755308dec2c7950d916aabc545b confirms this award branch.
 * Use actual retained counts, not the simulator's ideal maximum spins.
 */
export function stableSpinnerSpinScore(
  state?: Pick<SpinnerState, "stableScoredHalfTurns" | "stableRequiredHalfTurns">,
): number | undefined {
  const halfTurns = state?.stableScoredHalfTurns;
  const required = state?.stableRequiredHalfTurns;
  if (
    halfTurns === undefined ||
    required === undefined ||
    !Number.isSafeInteger(halfTurns) ||
    !Number.isSafeInteger(required) ||
    halfTurns < 0 ||
    required < 0 ||
    halfTurns > MAX_STABLE_SCORE ||
    required > MAX_STABLE_SCORE
  )
    return undefined;
  const bonusCount = Math.max(0, Math.floor((halfTurns - required - 3) / 2));
  // With odd requirements the 1100 replaces an ordinary 100 award; with
  // even requirements it occurs on an otherwise non-scoring odd half-turn.
  const score = 100 * Math.floor(halfTurns / 2) + bonusCount * (required % 2 === 1 ? 1000 : 1100);
  return score <= MAX_STABLE_SCORE ? score : undefined;
}

/** A resolved Stable judgement, in the evaluator's original processing order. */
export interface StableLegacyScoreEvent {
  objectIndex: number;
  combo: "increment" | "reset" | "none";
  baseScore: 0 | 10 | 30 | 50 | 100 | 300;
  applyComboMultiplier: boolean;
  /** Raw spin awards included once before the spinner's final grade. */
  spinnerSpinScore?: number;
  /** Missing or unsupported Stable spinner rotation state. */
  unsupportedSpinner?: boolean;
}

export type LegacyScoreUnavailableReason = "spinner-bonus-unavailable" | "unsupported-mods" | "work-limit";

interface LegacyScoreCache {
  earliestEventForObject: number[];
  latestEventForObject: number[];
  comboAfter: Float64Array;
  scoreAfter: Float64Array;
  multipliers: number[];
}

const MAX_DIFFICULTY_MULTIPLIER = 10;
const MAX_REPROCESSED_EVENTS = 2_000_000;
const deferredIndex=Symbol("deferred-score-index");
function finishSteps<T>(steps:Generator<void,T>):T {let result=steps.next();while(!result.done)result=steps.next();return result.value;}

/** Stable multiplies these in this order; mod input order must not change rounding. */
function legacyModMultiplier(mods: readonly LazerMod[]): number | undefined {
  const acronyms = new Set(mods.map((mod) => mod.acronym));
  const supported = new Set(["NF", "EZ", "HT", "HD", "HR", "DT", "NC", "FL", "SO", "SD", "PF", "CL", "TD"]);
  if (mods.some((mod) => !supported.has(mod.acronym))) return undefined;
  if ((acronyms.has("DT") || acronyms.has("NC")) && acronyms.has("HT")) return undefined;
  if (acronyms.has("EZ") && acronyms.has("HR")) return undefined;
  for (const mod of mods) {
    if (mod.acronym !== "DT" && mod.acronym !== "NC" && mod.acronym !== "HT") continue;
    const rate = mod.settings?.speed_change;
    if (rate !== undefined && rate !== (mod.acronym === "HT" ? 0.75 : 1.5)) return undefined;
  }

  let multiplier = 1;
  if (acronyms.has("NF")) multiplier *= 0.5;
  if (acronyms.has("EZ")) multiplier *= 0.5;
  if (acronyms.has("HT")) multiplier *= 0.3;
  if (acronyms.has("HD")) multiplier *= 1.06;
  if (acronyms.has("HR")) multiplier *= 1.06;
  if (acronyms.has("DT") || acronyms.has("NC")) multiplier *= 1.12;
  if (acronyms.has("FL")) multiplier *= 1.12;
  if (acronyms.has("SO")) multiplier *= 0.9;
  return multiplier;
}

/**
 * Reconstructs ScoreV1 while retaining the original judgement order.
 * The official engine selects its integer LegacyScoreBaseMultiplier from the
 * returned table, so its decimal/x87 difficulty rounding remains authoritative.
 *
 * Each ordinary object extends the cache once. An overlapping object can insert
 * earlier events, in which case only that affected suffix is recomputed. A work
 * bound keeps deliberately extreme overlap maps from monopolising the renderer.
 *
 * Formula: osu.Game.Rulesets.Osu/Difficulty/OsuLegacyScoreSimulator.cs:160-171
 * at 1032a7c31581513c8be751e46f0940e1c95ed252, checked against installed Stable's
 * actual score update. See LEGACY_SCORE.md for provenance and limitations.
 */
export class StableLegacyScoreLookup {
  private readonly cache?: LegacyScoreCache;
  private passedObjects = 0;
  private lastEvent = -1;
  private processedEvents = 0;
  private unsupported = false;
  private reason?: LegacyScoreUnavailableReason;

  constructor(private readonly events: readonly StableLegacyScoreEvent[], mods: readonly LazerMod[],defer?:typeof deferredIndex) {
    const multiplier = legacyModMultiplier(mods);
    if (multiplier === undefined) {
      this.reason = "unsupported-mods";
    } else {
      const multipliers = Array.from({ length: MAX_DIFFICULTY_MULTIPLIER + 1 }, (_, i) => i * multiplier);
      this.cache = {
        earliestEventForObject: [],
        latestEventForObject: [],
        comboAfter: new Float64Array(events.length),
        scoreAfter: new Float64Array(events.length * multipliers.length),
        multipliers,
      };
    }

    if(defer!==deferredIndex)finishSteps(this.indexSteps());
  }

  /** Library callers retain this continuation at cooperative worker checkpoints. Viewer construction stays synchronous. */
  static *createSteps(events:readonly StableLegacyScoreEvent[],mods:readonly LazerMod[]):Generator<void,StableLegacyScoreLookup> {
    const lookup=new StableLegacyScoreLookup(events,mods,deferredIndex);yield* lookup.indexSteps();return lookup;
  }

  private *indexSteps():Generator<void,void> {
    // Validate the input even when reconstruction is unavailable, without
    // allocating score buffers or populating indexes that cannot be queried.
    const cache = this.cache;
    for(let index=0;index<this.events.length;index++) {
      if(index%256===0)yield;const event=this.events[index];
      if (!Number.isSafeInteger(event.objectIndex) || event.objectIndex < 0) {
        throw new Error("Stable score events require non-negative object indices");
      }
      if (!cache) continue;
      if (cache.earliestEventForObject[event.objectIndex] === undefined) {
        cache.earliestEventForObject[event.objectIndex] = index;
      }
      cache.latestEventForObject[event.objectIndex] = index;
    }
  }

  get unavailableReason(): LegacyScoreUnavailableReason | undefined {
    return this.reason;
  }

  /** Call with non-decreasing completed prefix lengths. Returned arrays are independent snapshots. */
  scoresAtPrefix(passedObjects: number): readonly number[] | undefined {
    return finishSteps(this.scoresAtPrefixSteps(passedObjects));
  }

  /** The original ordered suffix algorithm, with resumable boundaries inside expensive overlap work. */
  *scoresAtPrefixSteps(passedObjects:number):Generator<void,readonly number[]|undefined> {
    if (!Number.isSafeInteger(passedObjects) || passedObjects < this.passedObjects) {
      throw new Error("Stable score prefixes must be non-decreasing non-negative integers");
    }
    const cache = this.cache;
    if (this.reason !== undefined || !cache) return undefined;

    const previousLastEvent = this.lastEvent;
    let firstChangedEvent = Infinity;
    for (let objectIndex = this.passedObjects; objectIndex < passedObjects; objectIndex++) {
      if((objectIndex-this.passedObjects+1)%256===0)yield;
      firstChangedEvent = Math.min(firstChangedEvent, cache.earliestEventForObject[objectIndex] ?? Infinity);
      this.lastEvent = Math.max(this.lastEvent, cache.latestEventForObject[objectIndex] ?? -1);
    }
    this.passedObjects = passedObjects;
    if (this.lastEvent > previousLastEvent) {
      firstChangedEvent = Math.min(firstChangedEvent, previousLastEvent + 1);
    }

    if (firstChangedEvent <= this.lastEvent) {
      this.processedEvents += this.lastEvent - firstChangedEvent + 1;
      if (this.processedEvents > MAX_REPROCESSED_EVENTS) {
        this.reason = "work-limit";
        return undefined;
      }
      const width = cache.multipliers.length;
      let combo = firstChangedEvent === 0 ? 0 : cache.comboAfter[firstChangedEvent - 1];
      const scores = Array.from({ length: width }, (_, i) =>
        firstChangedEvent === 0 ? 0 : cache.scoreAfter[(firstChangedEvent - 1) * width + i],
      );
      for (let index = firstChangedEvent; index <= this.lastEvent; index++) {
        if((index-firstChangedEvent+1)%256===0)yield;
        const event = this.events[index];
        if (event.objectIndex < passedObjects) {
          if (
            event.unsupportedSpinner ||
            (event.spinnerSpinScore !== undefined &&
              (!Number.isSafeInteger(event.spinnerSpinScore) ||
                event.spinnerSpinScore < 0 ||
                event.spinnerSpinScore > MAX_STABLE_SCORE))
          ) {
            this.unsupported = true;
            break;
          }
          const comboBefore = Math.max(0, combo - 1);
          const scoreUnits = Math.trunc(event.baseScore / 25);
          for (let i = 0; i < width; i++) {
            scores[i] +=
              (event.spinnerSpinScore ?? 0) +
              event.baseScore +
              (event.applyComboMultiplier ? Math.trunc(comboBefore * (scoreUnits * cache.multipliers[i])) : 0);
            cache.scoreAfter[index * width + i] = scores[i];
          }
          if (event.combo === "increment") combo++;
          else if (event.combo === "reset") combo = 0;
        } else {
          for (let i = 0; i < width; i++) cache.scoreAfter[index * width + i] = scores[i];
        }
        cache.comboAfter[index] = combo;
      }
    }
    if (this.unsupported) {
      this.reason = "spinner-bonus-unavailable";
      return undefined;
    }
    if (this.lastEvent < 0) return cache.multipliers.map(() => 0);
    const offset = this.lastEvent * cache.multipliers.length;
    return Array.from(cache.scoreAfter.subarray(offset, offset + cache.multipliers.length));
  }
}
