/**
 * Shows the statistics
 */

import { GameState, LazerJudgement } from "./GameState";
import { HitObjectType, SliderCheckPointType } from "../hitobjects/Types";
import { MainHitObjectVerdict } from "./Verdicts";
import { Beatmap } from "../beatmap/Beatmap";
import { HitCircle } from "../hitobjects/HitCircle";
import { Slider } from "../hitobjects/Slider";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";

export interface GameplayInfo {
  accuracy: number;
  // osu!stable: 300, 100, 50, 0
  // osu!lazer:  300, 100, 50, 25, 10, 0 (or something like that, small ticks are from sliders and count towards acc)
  verdictCounts: number[];
  score: number;
  currentCombo: number;
  maxComboSoFar: number;
}

/** COMBO **/

interface ReplayComboInformation {
  currentCombo: number;
  maxComboSoFar: number;
}

export function stableComboAfterJudgement(
  currentCombo: number,
  type: HitObjectType | SliderCheckPointType,
  hit: boolean,
): number {
  switch (type) {
    case "HIT_CIRCLE":
    case "TICK":
    case "REPEAT":
    case "SPINNER":
      currentCombo = hit ? currentCombo + 1 : 0;
      break;

    case "LAST_LEGACY_TICK":
      // Slider ends do not break the combo, but they can increase them
      currentCombo += hit ? 1 : 0;
      break;

    case "SLIDER":
      // For sliders there is no combo update
      break;
  }

  return currentCombo;
}

function updateComboInfo(combo: ReplayComboInformation, type: HitObjectType | SliderCheckPointType, hit: boolean) {
  const currentCombo = stableComboAfterJudgement(combo.currentCombo, type, hit);
  return { currentCombo, maxComboSoFar: Math.max(combo.maxComboSoFar, currentCombo) };
}

/** ACC **/

/**
 * Returns a number between 0 and 1 using osu!stable accuracy logic.
 * Also returns undefined if there is no count
 *
 * @param count counts of 300, 100, 50, 0 (in this order)
 */
export function osuStableAccuracy(count: number[]): number | undefined {
  if (count.length !== 4) {
    return undefined;
  }
  const JudgementScores = [300, 100, 50, 0];

  let perfect = 0,
    actual = 0;
  for (let i = 0; i < count.length; i++) {
    actual += JudgementScores[i] * count[i];
    perfect += JudgementScores[0] * count[i];
  }

  if (perfect === 0) {
    return undefined;
  }

  return actual / perfect;
}

/** SCORE **/

interface EvaluationOption {
  scoringSystem: "ScoreV1" | "ScoreV2";
  // maybe beatmap difficulty -> since they are required for score v1 calc
}

//https://osu.ppy.sh/wiki/en/Score/ScoreV1

const defaultEvaluationOptions = {
  scoringSystem: "ScoreV1",
} as EvaluationOption;

type StableVerdictCount = Record<MainHitObjectVerdict, number>;

export const defaultGameplayInfo: GameplayInfo = Object.freeze({
  currentCombo: 0,
  maxComboSoFar: 0,
  verdictCounts: [0, 0, 0, 0],
  accuracy: 0,
  score: 0,
});

/**
 * Calculating: Count, Accuracy, Combo, MaxCombo
 * The one who is calling this has to make sure that slider heads are not considered in case they are using osu!stable
 * calculation.
 */
export class GameplayInfoEvaluator {
  options: EvaluationOption;
  judgedObjectsIndex: number;
  comboInfo: ReplayComboInformation;
  verdictCount: StableVerdictCount;

  constructor(private beatmap: Beatmap, options?: Partial<EvaluationOption>) {
    this.options = { ...defaultEvaluationOptions, ...options };
    this.comboInfo = { maxComboSoFar: 0, currentCombo: 0 };
    this.verdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
    this.judgedObjectsIndex = 0;
    // TODO: Do some initialization for calculating ScoreV2 (like max score)
  }

  evaluateHitObject(hitObjectType: HitObjectType, verdict: MainHitObjectVerdict, isSliderHead?: boolean) {
    this.comboInfo = updateComboInfo(this.comboInfo, hitObjectType, verdict !== "MISS");
    if (!isSliderHead) {
      this.verdictCount[verdict] += 1;
    }
  }

  evaluateSliderCheckpoint(hitObjectType: SliderCheckPointType, hit: boolean) {
    this.comboInfo = updateComboInfo(this.comboInfo, hitObjectType, hit);
  }

  countAsArray() {
    return (["GREAT", "OK", "MEH", "MISS"] as const).map((v) => this.verdictCount[v]);
  }

  evaluateReplayState(replayState: GameState): GameplayInfo {
    // Assume something like seeking backwards happened at reevaluate
    if (this.judgedObjectsIndex >= replayState.judgedObjects.length + 1) {
      this.comboInfo = { maxComboSoFar: 0, currentCombo: 0 };
      this.verdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
      this.judgedObjectsIndex = 0;
    }

    while (this.judgedObjectsIndex < replayState.judgedObjects.length) {
      const id = replayState.judgedObjects[this.judgedObjectsIndex++];
      const hitObject = this.beatmap.getHitObject(id);
      if (hitObject instanceof SliderCheckPoint) {
        const hit = replayState.checkPointVerdict[hitObject.id].hit;
        this.evaluateSliderCheckpoint(hitObject.type, hit);
      } else if (hitObject instanceof HitCircle) {
        const verdict = replayState.hitCircleVerdict[id].type;
        const isSliderHead = hitObject.sliderId !== undefined;
        this.evaluateHitObject(hitObject.type, verdict, isSliderHead);
      } else if (hitObject instanceof Slider) {
        const verdict = replayState.sliderVerdict[hitObject.id];
        this.evaluateHitObject(hitObject.type, verdict);
      } else {
        const verdict = replayState.spinnerVerdict[hitObject.id].type;
        this.evaluateHitObject("SPINNER", verdict);
      }
    }

    const counts = this.countAsArray();
    return {
      score: 0,
      verdictCounts: counts,
      accuracy: osuStableAccuracy(counts) ?? 1.0,
      currentCombo: this.comboInfo.currentCombo,
      maxComboSoFar: this.comboInfo.maxComboSoFar,
    };
  }
}

const lazerBasicScore: Record<MainHitObjectVerdict, number> = {
  GREAT: 300,
  OK: 100,
  MEH: 50,
  MISS: 0,
};

/** Native lazer combo and weighted-accuracy evaluation for osu!standard. */
export class LazerGameplayInfoEvaluator {
  private judgementIndex = 0;
  private comboInfo: ReplayComboInformation = { maxComboSoFar: 0, currentCombo: 0 };
  private verdictCount: StableVerdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
  private actualAccuracyPoints = 0;
  private maximumAccuracyPoints = 0;

  private reset(): void {
    this.judgementIndex = 0;
    this.comboInfo = { maxComboSoFar: 0, currentCombo: 0 };
    this.verdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
    this.actualAccuracyPoints = 0;
    this.maximumAccuracyPoints = 0;
  }

  private updateCombo(hit: boolean, missBreaksCombo = true): void {
    if (hit) this.comboInfo.currentCombo++;
    else if (missBreaksCombo) this.comboInfo.currentCombo = 0;
    this.comboInfo.maxComboSoFar = Math.max(this.comboInfo.maxComboSoFar, this.comboInfo.currentCombo);
  }

  private evaluateJudgement(judgement: LazerJudgement): void {
    switch (judgement.result) {
      case "GREAT":
      case "OK":
      case "MEH":
      case "MISS":
        this.verdictCount[judgement.result]++;
        this.actualAccuracyPoints += lazerBasicScore[judgement.result];
        this.maximumAccuracyPoints += 300;
        this.updateCombo(judgement.result !== "MISS");
        break;
      case "LARGE_TICK_HIT":
        this.actualAccuracyPoints += 30;
        this.maximumAccuracyPoints += 30;
        this.updateCombo(true);
        break;
      case "LARGE_TICK_MISS":
        this.maximumAccuracyPoints += 30;
        this.updateCombo(false);
        break;
      case "SMALL_TICK_HIT":
        this.actualAccuracyPoints += 10;
        this.maximumAccuracyPoints += 10;
        // Classic tails affect accuracy; the parent awards the final combo.
        break;
      case "SMALL_TICK_MISS":
        this.maximumAccuracyPoints += 10;
        break;
      case "SLIDER_TAIL_HIT":
        this.actualAccuracyPoints += 150;
        this.maximumAccuracyPoints += 150;
        this.updateCombo(true);
        break;
      case "IGNORE_MISS":
        this.maximumAccuracyPoints += 150;
        // Native lazer's tail miss affects accuracy but not combo.
        this.updateCombo(false, false);
        break;
    }
  }

  evaluateReplayState(replayState: GameState): GameplayInfo {
    if (this.judgementIndex > replayState.lazerJudgements.length) this.reset();
    while (this.judgementIndex < replayState.lazerJudgements.length) {
      this.evaluateJudgement(replayState.lazerJudgements[this.judgementIndex++]);
    }

    return {
      score: 0,
      verdictCounts: (["GREAT", "OK", "MEH", "MISS"] as const).map((result) => this.verdictCount[result]),
      accuracy: this.maximumAccuracyPoints === 0 ? 1 : this.actualAccuracyPoints / this.maximumAccuracyPoints,
      currentCombo: this.comboInfo.currentCombo,
      maxComboSoFar: this.comboInfo.maxComboSoFar,
    };
  }
}
