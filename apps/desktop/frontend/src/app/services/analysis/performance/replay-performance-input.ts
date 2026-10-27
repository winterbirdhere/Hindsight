import { fullComboPerformanceState } from "@rewind/osu-performance/states";
import {
  Beatmap,
  GameState,
  HitCircle,
  LazerMod,
  MainHitObjectVerdict,
  OsuClassicMod,
  OsuHitObject,
  Slider,
  SliderCheckPoint,
} from "@osujs/core";
import type {
  CumulativePerformanceState,
  PerformanceMode,
  PerformanceStatistics,
  ReplayPerformanceInput,
} from "@rewind/osu-performance/types";
import { StableLegacyScoreLookup, StableLegacyScoreEvent, stableSpinnerSpinScore } from "@rewind/osu-performance/legacy-score";
import { normalizePerformanceMods } from "@rewind/osu-performance/mods";
import { isLazerReplay, OsuReplay } from "../../../model/OsuReplay";

export type { CumulativePerformanceState, PerformanceMode, PerformanceStatistics, ReplayPerformanceInput };

type ComboChange = "increment" | "reset" | "none";

/** Canonical order is retained even when objects overlap in time. */
export interface PerformanceJudgement {
  sourceId: string;
  objectIndex: number;
  time: number;
  combo: ComboChange;
  result?: keyof PerformanceStatistics;
  /** Stable ScoreV1 inputs, evaluated before the combo transition. */
  baseScore?: 0 | 10 | 30 | 50 | 100 | 300;
  applyComboMultiplier?: boolean;
  /** Raw spin/bonus points reconstructed from the Stable half-turn state. */
  spinnerSpinScore?: number;
  unsupportedSpinner?: boolean;
}

export function emptyPerformanceStatistics(): PerformanceStatistics {
  return {
    great: 0,
    ok: 0,
    meh: 0,
    miss: 0,
    large_tick_hit: 0,
    large_tick_miss: 0,
    small_tick_hit: 0,
    small_tick_miss: 0,
    slider_tail_hit: 0,
    slider_tail_miss: 0,
  };
}

const BASIC_RESULT: Record<MainHitObjectVerdict, keyof PerformanceStatistics> = {
  GREAT: "great",
  OK: "ok",
  MEH: "meh",
  MISS: "miss",
};

const STABLE_BASE_SCORE: Record<MainHitObjectVerdict, 0 | 50 | 100 | 300> = {
  GREAT: 300,
  OK: 100,
  MEH: 50,
  MISS: 0,
};

const MOD_ACRONYM: Record<OsuClassicMod, string> = {
  TOUCH_DEVICE: "TD",
  EASY: "EZ",
  HALF_TIME: "HT",
  NO_FAIL: "NF",
  HARD_ROCK: "HR",
  SUDDEN_DEATH: "SD",
  PERFECT: "PF",
  DOUBLE_TIME: "DT",
  NIGHT_CORE: "NC",
  HIDDEN: "HD",
  FLASH_LIGHT: "FL",
  AUTO_PLAY: "AT",
  AUTO_PILOT: "AP",
  RELAX: "RX",
  SPUN_OUT: "SO",
  SCORE_V2: "V2",
};

function performanceMods(replay: OsuReplay, mode: PerformanceMode): LazerMod[] {
  const source: readonly LazerMod[] = replay.lazerMods ?? replay.mods.map((mod) => ({ acronym: MOD_ACRONYM[mod] }));
  return normalizePerformanceMods(source, mode);
}

function finishSteps<T>(steps:Generator<void,T>):T {let result=steps.next();while(!result.done)result=steps.next();return result.value;}
function* objectIndices(beatmap: Beatmap): Generator<void,Map<string, number>> {
  const indices = new Map<string, number>();
  let work=0;
  for(let index=0;index<beatmap.hitObjects.length;index++) {
    if(work++%256===0)yield;const object=beatmap.hitObjects[index];
    indices.set(object.id, index);
    if (object instanceof Slider) {
      indices.set(object.head.id, index);
      for (const checkpoint of object.checkPoints) {if(work++%256===0)yield;indices.set(checkpoint.id, index);}
      for (const checkpoint of object.stableCheckPoints ?? []) {if(work++%256===0)yield;indices.set(checkpoint.id, index);}
    }
  }
  return indices;
}

/** Use simulation order, never the display/error event list. */
export function performanceJudgements(
  beatmap: Beatmap,
  state: GameState,
  mode: PerformanceMode,
): PerformanceJudgement[] {
  return finishSteps(performanceJudgementSteps(beatmap,state,mode));
}
function* performanceJudgementSteps(beatmap:Beatmap,state:GameState,mode:PerformanceMode):Generator<void,PerformanceJudgement[]> {
  const indices = yield* objectIndices(beatmap);let work=0;
  const events: PerformanceJudgement[] = [];
  if (mode !== "stable") {
    for (const judgement of state.lazerJudgements) {
      if(work++%256===0)yield;
      const objectIndex = indices.get(judgement.hitObjectId);
      if (objectIndex === undefined) continue;
      const result =
        judgement.result === "IGNORE_MISS"
          ? "slider_tail_miss"
          : (judgement.result.toLowerCase() as keyof PerformanceStatistics);
      const combo: ComboChange =
        result === "small_tick_hit" || result === "small_tick_miss" || result === "slider_tail_miss"
          ? "none"
          : result === "miss" || result === "large_tick_miss"
          ? "reset"
          : "increment";
      events.push({
        sourceId: judgement.hitObjectId,
        objectIndex,
        time: judgement.judgementTime,
        combo,
        result,
      });
    }
    return events;
  }

  for (const id of state.judgedObjects) {
    if(work++%256===0)yield;
    const objectIndex = indices.get(id);
    if (objectIndex === undefined) continue;
    const object = beatmap.getHitObject(id);
    if (object instanceof SliderCheckPoint) {
      const judgement = state.checkPointVerdict[id];
      if (!judgement) continue;
      events.push({
        sourceId: id,
        objectIndex,
        time: judgement.judgementTime ?? object.hitTime,
        combo: judgement.hit ? "increment" : object.type === "LAST_LEGACY_TICK" ? "none" : "reset",
        baseScore: judgement.hit ? (object.type === "TICK" ? 10 : 30) : 0,
        applyComboMultiplier: false,
      });
    } else if (object instanceof HitCircle) {
      const judgement = state.hitCircleVerdict[id];
      if (!judgement) continue;
      events.push({
        sourceId: id,
        objectIndex,
        time: judgement.judgementTime,
        combo: judgement.type === "MISS" ? "reset" : "increment",
        ...(object.sliderId === undefined ? { result: BASIC_RESULT[judgement.type] } : {}),
        baseScore:
          object.sliderId === undefined ? STABLE_BASE_SCORE[judgement.type] : judgement.type === "MISS" ? 0 : 30,
        applyComboMultiplier: object.sliderId === undefined,
      });
    } else if (object instanceof Slider) {
      const verdict = state.sliderVerdict[id];
      if (verdict === undefined) continue;
      events.push({
        sourceId: id,
        objectIndex,
        time: state.sliderJudgementTime?.[id] ?? object.endTime,
        combo: "none",
        result: BASIC_RESULT[verdict],
        baseScore: STABLE_BASE_SCORE[verdict],
        applyComboMultiplier: true,
      });
    } else {
      const judgement = state.spinnerVerdict[id];
      if (!judgement) continue;
      // Stable Spun Out rotation is not reconstructed by this evaluator.
      const spinnerSpinScore = beatmap.appliedMods.includes("SPUN_OUT")
        ? undefined
        : stableSpinnerSpinScore(state.spinnerState.get(id));
      events.push({
        sourceId: id,
        objectIndex,
        time: judgement.judgementTime,
        combo: judgement.type === "MISS" ? "reset" : "increment",
        result: BASIC_RESULT[judgement.type],
        baseScore: STABLE_BASE_SCORE[judgement.type],
        applyComboMultiplier: true,
        ...(spinnerSpinScore === undefined ? { unsupportedSpinner: true } : { spinnerSpinScore }),
      });
    }
  }
  return events;
}

interface ComboSummary {
  prefix: number;
  suffix: number;
  maximum: number;
  noReset: boolean;
}

const EMPTY_COMBO: ComboSummary = { prefix: 0, suffix: 0, maximum: 0, noReset: true };

function mergeCombo(left: ComboSummary, right: ComboSummary): ComboSummary {
  return {
    prefix: left.noReset ? left.prefix + right.prefix : left.prefix,
    suffix: right.noReset ? left.suffix + right.suffix : right.suffix,
    maximum: Math.max(left.maximum, right.maximum, left.suffix + right.prefix),
    noReset: left.noReset && right.noReset,
  };
}

/** Insert newly included objects without changing their original gameplay order. */
class PrefixComboTree {
  private readonly size: number;
  // Allocate only visited branches; a large replay must not synchronously fill
  // the entire tree before the cooperative prefix traversal can yield.
  private readonly nodes: (ComboSummary | undefined)[] = [];

  constructor(eventCount: number) {
    this.size = 2 ** Math.ceil(Math.log2(Math.max(1, eventCount)));
  }

  include(index: number, change: ComboChange): void {
    if (change === "none") return;
    let node = this.size + index;
    this.nodes[node] =
      change === "increment"
        ? { prefix: 1, suffix: 1, maximum: 1, noReset: true }
        : { prefix: 0, suffix: 0, maximum: 0, noReset: false };
    while (node > 1) {
      node = Math.floor(node / 2);
      this.nodes[node] = mergeCombo(this.nodes[node * 2] ?? EMPTY_COMBO, this.nodes[node * 2 + 1] ?? EMPTY_COMBO);
    }
  }

  get maximum(): number {
    return this.nodes[1]?.maximum ?? 0;
  }
}

function objectCompletionTime(object: OsuHitObject, state: GameState, mode: PerformanceMode): number {
  if (mode === "stable" && object instanceof Slider) return state.sliderJudgementTime?.[object.id] ?? object.endTime;
  // A circle is complete when its judgement resolves, including early hits and
  // early misses. Waiting for nominal hitTime delays an already observed result.
  return object instanceof HitCircle
    ? state.hitCircleVerdict[object.id]?.judgementTime ?? object.hitTime
    : object.endTime;
}

function objectIsComplete(object: OsuHitObject, state: GameState): boolean {
  if (object instanceof HitCircle) return state.hitCircleVerdict[object.id] !== undefined;
  if (object instanceof Slider) return state.sliderVerdict[object.id] !== undefined;
  return state.spinnerVerdict[object.id] !== undefined;
}

const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * The combo of a perfect play, from this play's judgements: every one that adds to the combo, and every one that
 * would have if it had been hit. A reset is a miss of such a judgement. Among those that changed nothing, Stable's
 * missed last slider tick (a slider part, so it has no result of its own) and Lazer's missed slider tail would have
 * counted; a small tick and a Stable slider's own result never do.
 */
export function fullComboMaxCombo(events: readonly PerformanceJudgement[], mode: PerformanceMode): number {
  return finishSteps(fullComboMaxComboSteps(events,mode));
}
function* fullComboMaxComboSteps(events:readonly PerformanceJudgement[],mode:PerformanceMode):Generator<void,number> {
  let combo = 0,work=0;
  for (const event of events) {
    if(work++%256===0)yield;
    if (event.combo !== "none") combo++;
    else if (mode === "stable" ? event.result === undefined : event.result === "slider_tail_miss") combo++;
  }
  return combo;
}

/**
 * The final state of the same play as a full combo, as "PP if FC" is commonly meant: every miss counts as hit (a
 * missed note as a 300), the 100s and 50s stay, and the combo is the whole map's. The real play's score is left out,
 * as a full combo would have had another; the engine then uses its combo-based estimate.
 */
export { fullComboPerformanceState } from "@rewind/osu-performance/states";

function sourceBasicCounts(replay: OsuReplay, mode: PerformanceMode): number[] | undefined {
  if ((mode !== "stable") !== isLazerReplay(replay)) return undefined;
  const native = mode !== "stable" ? replay.lazerScoreMetadata?.statistics : undefined;
  const header = replay.statistics;
  const basic = native
    ? [native.great ?? 0, native.ok ?? 0, native.meh ?? 0, native.miss ?? 0]
    : header
    ? [header.count300, header.count100, header.count50, header.countMiss]
    : undefined;
  return basic?.every(validCount) ? basic : undefined;
}

/**
 * Timed osu! attributes correspond to complete top-level objects in start order.
 * Do not mix a slider head from a later prefix with earlier difficulty attributes.
 * Construction costs O(j log j + n); playback needs only a binary search.
 */
export function buildReplayPerformanceInput(input:ReplayPerformanceSource):ReplayPerformanceInput {
  return finishSteps(buildReplayPerformanceSteps(input));
}
/** Library-only cooperative consumption of the same ordered construction used by the viewer. */
export async function buildReplayPerformanceInputAsync(input:ReplayPerformanceSource,checkpoint:()=>Promise<void>):Promise<ReplayPerformanceInput> {
  const steps=buildReplayPerformanceSteps(input);let result=steps.next();
  while(!result.done){await checkpoint();result=steps.next();}return result.value;
}
interface ReplayPerformanceSource {
  beatmap:Beatmap;replay:OsuReplay;state:GameState;mode:PerformanceMode;finalReplayTime?:number;
  /** The caller already stopped simulation at the replay's actual scoring endpoint. */
  stateIsScoringBounded?:boolean;
}
function* buildReplayPerformanceSteps({
  beatmap,
  replay,
  state,
  mode,
  finalReplayTime = replay.frames[replay.frames.length - 1]?.time ?? 0,
  stateIsScoringBounded = false,
}:ReplayPerformanceSource):Generator<void,ReplayPerformanceInput> {
  const events = yield* performanceJudgementSteps(beatmap, state, mode);
  const eventIndices:number[][]=[];
  for(let index=0;index<beatmap.hitObjects.length;index++){if(index%256===0)yield;eventIndices.push([]);}
  for(let index=0;index<events.length;index++){if(index%256===0)yield;eventIndices[events[index].objectIndex].push(index);}
  const combo = new PrefixComboTree(events.length);
  const mods = performanceMods(replay, mode);
  let legacyScore:StableLegacyScoreLookup|undefined;
  if(mode==="stable"){
    const scoreEvents:StableLegacyScoreEvent[]=[];
    for(let index=0;index<events.length;index++){if(index%256===0)yield;const event=events[index];
      scoreEvents.push({...event,baseScore:event.baseScore??0,applyComboMultiplier:event.applyComboMultiplier??false});}
    // PP evaluates Relax judgements with the remaining mod configuration.
    legacyScore=yield* StableLegacyScoreLookup.createSteps(scoreEvents,mods.filter(mod=>mod.acronym!=="RX"));
  }
  const statistics = emptyPerformanceStatistics();
  const states: CumulativePerformanceState[] = [];
  const limitations: string[] = [];
  // A source header may omit the fatal judgement. Once scoring has already
  // stopped at its endpoint, every completed result in that state is evidence.
  const sourceObjectLimit = stateIsScoringBounded
    ? undefined
    : sourceBasicCounts(replay, mode)?.reduce((sum, count) => sum + count, 0);
  let time = Number.NEGATIVE_INFINITY;

  let work=0;
  for (let objectIndex = 0; objectIndex < beatmap.hitObjects.length; objectIndex++) {
    if(work++%256===0)yield;
    if (sourceObjectLimit !== undefined && objectIndex >= sourceObjectLimit) break;
    const object = beatmap.hitObjects[objectIndex];
    if (!objectIsComplete(object, state)) break;
    let completionTime = Math.max(time, objectCompletionTime(object, state, mode));
    for (const index of eventIndices[objectIndex]) {if(work++%256===0)yield;completionTime = Math.max(completionTime, events[index].time);}
    if (completionTime > finalReplayTime) break;
    time = completionTime;
    for (const index of eventIndices[objectIndex]) {
      if(work++%256===0)yield;
      const event = events[index];
      if (event.result) statistics[event.result]++;
      combo.include(index, event.combo);
    }
    const legacyScoreByDifficultyMultiplier = legacyScore?yield* legacyScore.scoresAtPrefixSteps(objectIndex + 1):undefined;
    states.push({
      time,
      passedObjects: objectIndex + 1,
      maxCombo: combo.maximum,
      statistics: { ...statistics },
      ...(legacyScoreByDifficultyMultiplier ? { legacyScoreByDifficultyMultiplier } : {}),
    });
  }

  if (states.length > 0) {
    // Completion changes only the time/status; every result remains reconstructed.
    states.push({ ...states[states.length - 1], time: finalReplayTime, isFinal: true });
  }
  if (legacyScore?.unavailableReason) {
    limitations.push(
      legacyScore.unavailableReason === "spinner-bonus-unavailable"
        ? "Exact Stable spinner bonus data is unavailable; Stable PP uses osu!'s combo-based estimate."
        : legacyScore.unavailableReason === "work-limit"
        ? "Stable PP uses osu!'s combo-based estimate on this heavily overlapping map."
        : "This configuration uses osu!'s combo-based estimate for Stable PP.",
    );
  }
  if (beatmap.hitObjects.length > 0 && states[states.length - 1]?.passedObjects !== beatmap.hitObjects.length) {
    limitations.push(
      "The replay ends before every object is complete; PP stops at the completed prefix while SR continues through the beatmap.",
    );
  }
  // Only a replay that completed every object says what a full combo of the map would have held.
  const final = states[states.length - 1];
  const complete = beatmap.hitObjects.length > 0 && final?.passedObjects === beatmap.hitObjects.length;
  return {
    mode,
    states,
    finalReplayTime,
    limitations,
    mods,
    ...(complete ? { fullComboState: fullComboPerformanceState(final, yield* fullComboMaxComboSteps(events, mode)) } : {}),
  };
}
