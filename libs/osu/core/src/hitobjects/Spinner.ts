import { HasId, HasSpawnTime } from "./Properties";
import { HitSampleInfo } from "../audio/HitSampleInfo";

/**
 * Logic:
 *
 * * Assumption is that the user can't spin more than 8 times per second `max_rotations_per_second=8`.
 * * "MaxSpinsPossible" "MinSpinsNeeded"
 *
 *
 * Then there are like "MaxSpinsPossible" spinner ticks generated (???) which have a start time of [0, d, 2d, ...,
 * maxSpinsPossible * d] where d is the duration of one spin.
 *
 * 100% min spinned -> GREAT
 * > 90%-> OK
 * > 75% -> MEH
 * otherwise miss
 * requires gameClock playRate
 *
 *
 *                 if (HitObject.SpinsRequired == 0)
 // some spinners are so short they can't require an integer spin count.
 // these become implicitly hit.
 return 1;
 * SPM count is calculated as follows:
 *
 * First define a time window spm_count_duration = 595ms for example then find out how much you have spinned at t
 * compared to t - spm_count_duration.
 *
 * This is done by keeping track with a queue of (t, total_rotation) by most people
 *
 */
// Sources: https://github.com/itdelatrisu/opsu/blob/master/src/itdelatrisu/opsu/objects/Spinner.java
// https://github.com/McKay42/McOsu/blob/master/src/App/Osu/OsuSpinner.cpp
// https://github.com/ppy/osu/blob/master/osu.Game.Rulesets.Osu/Objects/Drawables/DrawableSpinner.cs

function diffRange(difficulty: number, min: number, mid: number, max: number) {
  if (difficulty > 5) return mid + ((max - mid) * (difficulty - 5)) / 5;
  if (difficulty < 5) return mid - ((mid - min) * (5 - difficulty)) / 5;

  return mid;
}

export class Spinner implements HasId, HasSpawnTime {
  id = "";
  startTime = 0;
  duration = 0;
  /** AR-derived time before the spinner becomes active. */
  approachDuration = 600;
  /** osu!'s hitobject fade-in time, shortened only when preempt is below AR10. */
  fadeInDuration = 400;
  spinsRequired = 1;
  maximumBonusSpins = 1;
  samples: HitSampleInfo[] = [];

  /** Applies the current native-lazer spinner requirement calculation. */
  applyLazerDefaults(overallDifficulty: number): void {
    const clearRpm = diffRange(overallDifficulty, 90, 150, 225);
    const completeRpm = diffRange(overallDifficulty, 250, 380, 430);
    const secondsDuration = this.duration / 1000;
    const durationError = 0.0001;

    this.spinsRequired = Math.floor((clearRpm / 60) * secondsDuration + durationError);
    this.maximumBonusSpins = Math.max(
      0,
      Math.floor((completeRpm / 60) * secondsDuration + durationError) - this.spinsRequired - 2,
    );
  }

  // The spinner fades in before it can be interacted with at [startTime, endTime].
  get spawnTime(): number {
    return this.startTime - this.approachDuration;
  }

  get endTime(): number {
    return this.startTime + this.duration;
  }

  get type() {
    return "SPINNER";
  }
}
