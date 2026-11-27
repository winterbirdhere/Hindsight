import { Position } from "@osujs/math";
import { normalizeHitObjectsSteps, drainSteps, drainStepsAsync, stableSortSteps } from "../utils";
import { GameState, HitCircleMissReason, LazerNotelockEvidence, StableNotelockEvidence } from "./GameState";
import { Slider } from "../hitobjects/Slider";
import { HitCircle } from "../hitobjects/HitCircle";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";
import { stableComboAfterJudgement } from "./GameplayInfo";
import { MainHitObjectVerdict } from "./Verdicts";
import { AllHitObjects, HitObjectType, isSpinner, OsuHitObject, SliderCheckPointType } from "../hitobjects/Types";

/**
 * ReplayAnalysisEvents are point of interests for the user.
 *
 */

export type GameplayAnalysisEventType =
  | "HitObjectJudgement"
  | "CheckpointJudgement"
  | "SliderEndJudgement"
  | "SliderComponentMiss"
  | "SliderBreak";

export type ReplayAnalysisRuleset = "stable" | "lazer";

// Where and when to display these events
interface DisplayBase {
  type: GameplayAnalysisEventType;
  time: number;
  position: Position;

  /** Deterministic within a ruleset simulation, when available. */
  eventId?: string;
  ruleset?: ReplayAnalysisRuleset;

  /** The beatmap time belonging to the judged object or nested component. */
  objectTime?: number;

  /** The time at which the ruleset resolved the judgement. */
  judgementTime?: number;
}

// TODO: Export
type HitObjectVerdict = MainHitObjectVerdict;

export type NotelockCause =
  | ({ kind: "STABLE_BLOCKED_VALID_PRESS" } & StableNotelockEvidence)
  | ({ kind: "LAZER_BLOCKED_VALID_PRESS" } & LazerNotelockEvidence);

// Those events are to be displayed on the screen

export interface HitObjectJudgement extends DisplayBase {
  type: "HitObjectJudgement";
  verdict: HitObjectVerdict;
  /** False for Classic slider heads: timing still contributes to hitsounds and UR. */
  affectsAccuracy?: boolean;
  /** Evaluator evidence for a missed circle/head, when it is explicitly known. */
  missReason?: HitCircleMissReason;
  /** Ruleset-owned causal evidence that this canonical miss was caused by notelock. */
  notelockCause?: NotelockCause;
  hitObjectId: string;
  // Because people might want to prefer not showing slider head judgements
  // In Lazer they are shown
  isSliderHead?: boolean;
}

export interface CheckpointJudgement extends DisplayBase {
  type: "CheckpointJudgement";
  eventId: string;
  ruleset: ReplayAnalysisRuleset;
  objectTime: number;
  judgementTime: number;
  checkpointId: string;
  sliderId: string;
  checkpointType: SliderCheckPointType;
  hit: boolean;
  // Usually not the causing factor of a slider break
  isLastTick?: boolean;
  /** Actual slider end time for Stable's earlier legacy last tick. */
  sliderEndTime?: number;
}

export type SliderBreakComponentType = "HEAD" | Exclude<SliderCheckPointType, "LAST_LEGACY_TICK">;
export type StableSliderBreakComponentType = SliderBreakComponentType;
export type LazerSliderComponentMissType = Exclude<SliderCheckPointType, "LAST_LEGACY_TICK"> | "HEAD" | "TAIL";

/**
 * Native lazer's actual SliderEnd result. Stable's legacy tail is deliberately
 * not represented by this event because it has different scoring semantics.
 */
export interface SliderEndJudgement extends DisplayBase {
  type: "SliderEndJudgement";
  eventId: string;
  ruleset: "lazer";
  objectTime: number;
  judgementTime: number;
  sliderId: string;
  componentId: string;
  hit: boolean;
}

/**
 * A missed native-lazer slider component.
 *
 * These outcomes affect native-lazer scoring, but they are not Stable
 * sliderbreaks and must never be included in an SB count. In particular, an
 * actual tail IgnoreMiss affects lazer accuracy without resetting combo.
 */
export interface SliderComponentMiss extends DisplayBase {
  type: "SliderComponentMiss";
  eventId: string;
  ruleset: "lazer";
  objectTime: number;
  judgementTime: number;
  sliderId: string;
  componentId: string;
  componentType: LazerSliderComponentMissType;
}

/**
 * An explicit combo-breaking Stable slider component judgement.
 *
 * Stable slider tails are intentionally excluded because missing one does not
 * reset combo. The whole-slider verdict is also not enough to infer a break.
 * Further missed components while combo is already zero are not new breaks.
 */
export interface SliderBreak extends DisplayBase {
  type: "SliderBreak";
  eventId: string;
  ruleset: "stable";
  objectTime: number;
  judgementTime: number;
  sliderId: string;
  componentId: string;
  componentType: SliderBreakComponentType;
}

export type ReplayAnalysisEvent =
  | HitObjectJudgement
  | CheckpointJudgement
  | SliderEndJudgement
  | SliderComponentMiss
  | SliderBreak;

// Type predicates
export const isHitObjectJudgement = (h: ReplayAnalysisEvent): h is HitObjectJudgement =>
  h.type === "HitObjectJudgement";

export const isNotelockMiss = (
  event: ReplayAnalysisEvent,
): event is HitObjectJudgement & { verdict: "MISS"; notelockCause: NotelockCause } =>
  event.type === "HitObjectJudgement" &&
  event.affectsAccuracy !== false &&
  event.verdict === "MISS" &&
  event.notelockCause !== undefined;

export const isSliderBreak = (event: ReplayAnalysisEvent): event is SliderBreak => event.type === "SliderBreak";

export const isSliderComponentMiss = (event: ReplayAnalysisEvent): event is SliderComponentMiss =>
  event.type === "SliderComponentMiss";

export const isSliderEndJudgement = (event: ReplayAnalysisEvent): event is SliderEndJudgement =>
  event.type === "SliderEndJudgement";

const rulesetEventId = (ruleset: ReplayAnalysisRuleset, kind: string, componentId: string) =>
  `${ruleset}:${kind}:${componentId}`;

function* sortEventsChronologically(events: ReplayAnalysisEvent[]): Generator<void,void,void> {
  yield* stableSortSteps(events,(a, b) => {
    const timeDifference = a.time - b.time;
    if (timeDifference !== 0) return timeDifference;
    return (a.eventId ?? "").localeCompare(b.eventId ?? "");
  });
}

function* stableComboBreakingComponents(gameState: GameState, objects: Record<string, AllHitObjects>): Generator<void,Set<string>,void> {
  const components = new Set<string>();
  let combo = 0;
  let work=0;

  // Use the evaluator's judgement order, including circles and spinners. Object
  // times alone cannot order an expired slider head against overlapping ticks.
  for (const id of gameState.judgedObjects) {
    if(++work%256===0)yield;
    const object = objects[id];
    if (object instanceof Slider) continue;

    let hit: boolean;
    let comboType: HitObjectType | SliderCheckPointType;
    let isSliderComponent = false;
    if (object instanceof SliderCheckPoint) {
      hit = gameState.checkPointVerdict[id].hit;
      comboType = object.type;
      isSliderComponent = true;
    } else if (object instanceof HitCircle) {
      hit = gameState.hitCircleVerdict[id].type !== "MISS";
      comboType = object.type;
      isSliderComponent = object.sliderId !== undefined;
    } else if (isSpinner(object)) {
      hit = gameState.spinnerVerdict[id].type !== "MISS";
      comboType = "SPINNER";
    } else {
      continue;
    }

    const nextCombo = stableComboAfterJudgement(combo, comboType, hit);
    if (isSliderComponent && combo > 0 && nextCombo === 0) components.add(id);
    combo = nextCombo;
  }

  return components;
}

// This is osu!stable style and is also only recommended for offline processing.
// In the future, where something like online replay streaming is implemented, this implementation will ofc be too slow.
export function retrieveEvents(
  gameState: GameState,
  hitObjects: OsuHitObject[],
  ruleset: ReplayAnalysisRuleset = "stable",
) {
  return drainSteps(retrieveEventsSteps(gameState,hitObjects,ruleset));
}
export function retrieveEventsAsync(gameState:GameState,hitObjects:OsuHitObject[],ruleset:ReplayAnalysisRuleset,
  checkpoint:()=>Promise<void>):Promise<ReplayAnalysisEvent[]> {
  return drainStepsAsync(retrieveEventsSteps(gameState,hitObjects,ruleset),checkpoint);
}
function* retrieveEventsSteps(gameState:GameState,hitObjects:OsuHitObject[],ruleset:ReplayAnalysisRuleset):Generator<void,ReplayAnalysisEvent[],void> {
  const events: ReplayAnalysisEvent[] = [];
  const dict = yield* normalizeHitObjectsSteps(hitObjects);
  const stableBreakComponents =
    ruleset === "stable" ? yield* stableComboBreakingComponents(gameState, dict) : new Set<string>();
  const classicHeads = new Set<string>();
  const classicSliderJudgements = new Map<string,GameState["lazerJudgements"][number]>();
  let work=0;
  for(const judgement of gameState.lazerJudgements){
    if(++work%256===0)yield;
    if(ruleset==="lazer"&&judgement.kind==="SLIDER_HEAD"&&
      (judgement.result==="LARGE_TICK_HIT"||judgement.result==="LARGE_TICK_MISS"))classicHeads.add(judgement.hitObjectId);
    if(judgement.kind==="SLIDER")classicSliderJudgements.set(judgement.hitObjectId,judgement);
  }

  // HitCircle judgements (SliderHeads included and indicated)
  for (const id in gameState.hitCircleVerdict) {
    if(++work%256===0)yield;
    const state = gameState.hitCircleVerdict[id];
    const hitCircle = dict[id] as HitCircle;
    const isSliderHead = hitCircle.sliderId !== undefined;
    const verdict = state.type;
    if (classicHeads.has(id)) {
      if (verdict === "MISS") {
        events.push({
          type: "SliderComponentMiss",
          time: state.judgementTime,
          eventId: rulesetEventId("lazer", "slider-component-miss", id),
          ruleset: "lazer",
          objectTime: hitCircle.hitTime,
          judgementTime: state.judgementTime,
          sliderId: hitCircle.sliderId as string,
          componentId: id,
          componentType: "HEAD",
          position: hitCircle.position,
        });
      }
    }
    const stableEvidence = ruleset === "stable" && !isSliderHead ? gameState.stableNotelockEvidence[id] : undefined;
    const lazerEvidence =
      ruleset === "lazer" && verdict === "MISS" && state.missReason === "TIME_EXPIRED"
        ? gameState.lazerNotelockEvidence[id]
        : undefined;
    const notelockCause: NotelockCause | undefined =
      verdict !== "MISS"
        ? undefined
        : stableEvidence
        ? { kind: "STABLE_BLOCKED_VALID_PRESS", ...stableEvidence }
        : lazerEvidence
        ? { kind: "LAZER_BLOCKED_VALID_PRESS", ...lazerEvidence }
        : undefined;
    events.push({
      type: "HitObjectJudgement",
      time: state.judgementTime,
      eventId: rulesetEventId(ruleset, "hit-object-judgement", id),
      ruleset,
      objectTime: hitCircle.hitTime,
      judgementTime: state.judgementTime,
      hitObjectId: id,
      position: hitCircle.position,
      verdict,
      ...(classicHeads.has(id) ? { affectsAccuracy: false } : {}),
      missReason: verdict === "MISS" ? state.missReason : undefined,
      notelockCause,
      isSliderHead,
    });

    const wholeSliderMissed = isSliderHead && gameState.sliderVerdict[hitCircle.sliderId as string] === "MISS";
    if (isSliderHead && verdict === "MISS" && !wholeSliderMissed && stableBreakComponents.has(id)) {
      events.push({
        type: "SliderBreak",
        time: state.judgementTime,
        eventId: rulesetEventId("stable", "slider-break", id),
        ruleset: "stable",
        objectTime: hitCircle.hitTime,
        judgementTime: state.judgementTime,
        sliderId: hitCircle.sliderId as string,
        componentId: id,
        componentType: "HEAD",
        position: hitCircle.position,
      });
    }
  }

  for (const hitObject of hitObjects) {
    if(++work%256===0)yield;
    if (!(hitObject instanceof Slider)) continue;

    const slider = hitObject;
    const verdict = gameState.sliderVerdict[slider.id];

    // Only Classic's proportional slider result is a scoring parent in lazer.
    const classicJudgement = ruleset === "lazer" ? classicSliderJudgements.get(slider.id) : undefined;
    if ((ruleset === "stable" || classicJudgement) && verdict !== undefined) {
      const stableEvidence = verdict === "MISS" ? gameState.stableNotelockEvidence[slider.head.id] : undefined;
      const lazerEvidence = verdict === "MISS" ? gameState.lazerNotelockEvidence[slider.head.id] : undefined;
      const judgementTime =
        classicJudgement?.judgementTime ?? gameState.sliderJudgementTime?.[slider.id] ?? slider.endTime;
      events.push({
        type: "HitObjectJudgement",
        time: judgementTime,
        eventId: rulesetEventId(ruleset, "hit-object-judgement", slider.id),
        ruleset,
        objectTime: classicJudgement?.objectTime ?? slider.startTime,
        judgementTime,
        hitObjectId: slider.id,
        position: slider.endPosition,
        verdict,
        notelockCause:
          ruleset === "stable" && stableEvidence
            ? { kind: "STABLE_BLOCKED_VALID_PRESS", ...stableEvidence }
            : ruleset === "lazer" && lazerEvidence
            ? { kind: "LAZER_BLOCKED_VALID_PRESS", ...lazerEvidence }
            : undefined,
      });
    }

    // CheckpointEvents
    for (const point of ruleset === "stable" ? slider.stableCheckPoints ?? slider.checkPoints : slider.checkPoints) {
      if(++work%256===0)yield;
      if (ruleset === "lazer" && point.type === "LAST_LEGACY_TICK") continue;
      const checkPointState = gameState.checkPointVerdict[point.id];

      // An absent state means the checkpoint was not processed, not that it was missed.
      if (checkPointState === undefined) continue;

      const isLastTick = point.type === "LAST_LEGACY_TICK";
      const judgementTime = checkPointState.judgementTime ?? point.hitTime;
      events.push({
        type: "CheckpointJudgement",
        time: judgementTime,
        eventId: rulesetEventId(ruleset, "checkpoint-judgement", point.id),
        ruleset,
        objectTime: point.hitTime,
        judgementTime,
        checkpointId: point.id,
        sliderId: slider.id,
        checkpointType: point.type,
        position: point.position,
        hit: checkPointState.hit,
        isLastTick,
        ...(isLastTick
          ? {
              sliderEndTime:
                ruleset === "stable" ? gameState.sliderJudgementTime?.[slider.id] ?? slider.endTime : slider.endTime,
            }
          : {}),
      });

      if (ruleset === "lazer" && !checkPointState.hit && point.type !== "LAST_LEGACY_TICK") {
        events.push({
          type: "SliderComponentMiss",
          time: judgementTime,
          eventId: rulesetEventId("lazer", "slider-component-miss", point.id),
          ruleset: "lazer",
          objectTime: point.hitTime,
          judgementTime,
          sliderId: slider.id,
          componentId: point.id,
          componentType: point.type,
          position: point.position,
        });
      }

      const comboBreakingType = point.type === "TICK" || point.type === "REPEAT" ? point.type : undefined;
      const isComboBreakingMiss =
        stableBreakComponents.has(point.id) && comboBreakingType !== undefined && verdict !== "MISS";
      if (isComboBreakingMiss && comboBreakingType) {
        events.push({
          type: "SliderBreak",
          time: judgementTime,
          eventId: rulesetEventId("stable", "slider-break", point.id),
          ruleset: "stable",
          objectTime: point.hitTime,
          judgementTime,
          sliderId: slider.id,
          componentId: point.id,
          componentType: comboBreakingType,
          position: point.position,
        });
      }
    }

    const tailState = gameState.sliderTailVerdict[slider.id];
    if (ruleset === "lazer" && tailState) {
      const judgementTime = tailState.judgementTime ?? slider.endTime;
      const componentId = `${slider.id}/TAIL`;
      events.push({
        type: "SliderEndJudgement",
        time: judgementTime,
        eventId: rulesetEventId("lazer", "slider-end-judgement", componentId),
        ruleset: "lazer",
        objectTime: slider.endTime,
        judgementTime,
        sliderId: slider.id,
        componentId,
        hit: tailState.hit,
        position: slider.endPosition,
      });
      if (!tailState.hit) {
        events.push({
          type: "SliderComponentMiss",
          time: judgementTime,
          eventId: rulesetEventId("lazer", "slider-component-miss", componentId),
          ruleset: "lazer",
          objectTime: slider.endTime,
          judgementTime,
          sliderId: slider.id,
          componentId,
          componentType: "TAIL",
          position: slider.endPosition,
        });
      }
    }
  }

  for (const hitObject of hitObjects) {
    if(++work%256===0)yield;
    if (!isSpinner(hitObject)) continue;
    const state = gameState.spinnerVerdict[hitObject.id];
    if (!state) continue;
    events.push({
      type: "HitObjectJudgement",
      time: state.judgementTime,
      eventId: rulesetEventId(ruleset, "hit-object-judgement", hitObject.id),
      ruleset,
      objectTime: hitObject.endTime,
      judgementTime: state.judgementTime,
      hitObjectId: hitObject.id,
      position: { x: 256, y: 192 },
      verdict: state.type,
    });
  }

  yield* sortEventsChronologically(events);
  return events;
}
