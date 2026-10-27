import { Blueprint } from "../blueprint/Blueprint";
import { BeatmapDifficulty } from "./BeatmapDifficulty";
import { HitCircleSettings, HitObjectSettings, SliderSettings, SpinnerSettings } from "../blueprint/HitObjectSettings";
import { ControlPointInfo } from "./ControlPoints/ControlPointInfo";
import { HitCircle } from "../hitobjects/HitCircle";
import { BeatmapDifficultyAdjuster, ModSettings, OsuClassicMod } from "../mods/Mods";
import { modifyStackingPosition } from "../mods/StackingMod";
import { generateSliderCheckpoints } from "../hitobjects/slider/SliderCheckPointGenerator";
import { SliderCheckPointDescriptor } from "../hitobjects/slider/SliderCheckPointDescriptor";
import { SliderPath } from "../hitobjects/slider/SliderPath";
import { TimingControlPoint } from "./ControlPoints/TimingControlPoint";
import { Slider } from "../hitobjects/Slider";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";
import { Beatmap } from "./Beatmap";
import { stableOverallDifficultyFor } from "../gameplay/StableDifficulty";
import { Spinner } from "../hitobjects/Spinner";
import { approachRateToApproachDuration, circleSizeToScale, Position } from "@osujs/math";
import { OsuHitObject } from "../hitobjects/Types";
import { HardRockMod } from "../mods/HardRockMod";
import { LazerMod, resolveLazerModSettings } from "../mods/LazerMods";
import { PathControlPoint } from "../hitobjects/slider/PathControlPoint";
import { HitSampleInfo } from "../audio/HitSampleInfo";
import { SampleControlPoint } from "./ControlPoints/SampleControlPoint";
import { StableSliderTiming, stableSliderTimingParameters } from "../gameplay/StableSliderTiming";

function copyPosition({ x, y }: Position): Position {
  return { x, y };
}

function resolvedSamples(samples: readonly HitSampleInfo[], samplePoint: SampleControlPoint): HitSampleInfo[] {
  const suffix = samplePoint.customSampleBank >= 2 ? String(samplePoint.customSampleBank) : null;
  return samples.map(
    (sample) =>
      new HitSampleInfo(
        sample.name,
        sample.bank ?? samplePoint.sampleBank,
        sample.suffix ?? suffix,
        sample.volume || samplePoint.sampleVolume,
        sample.customFilename,
        sample.customSampleBank || samplePoint.customSampleBank,
      ),
  );
}

function createHitCircle(
  id: string,
  hitCircleSettings: HitCircleSettings,
  controlPointInfo: ControlPointInfo,
  beatmapDifficulty: BeatmapDifficulty,
): HitCircle {
  const hitCircle = new HitCircle();
  hitCircle.id = id;
  hitCircle.position = copyPosition(hitCircleSettings.position);
  hitCircle.unstackedPosition = copyPosition(hitCircleSettings.position);
  hitCircle.hitTime = hitCircleSettings.time;
  hitCircle.scale = circleSizeToScale(beatmapDifficulty.circleSize);
  hitCircle.approachDuration = approachRateToApproachDuration(beatmapDifficulty.approachRate);
  hitCircle.samples = resolvedSamples(hitCircleSettings.samples, controlPointInfo.samplePointAt(hitCircle.hitTime));
  return hitCircle;
}

function createSliderCheckPoint(slider: Slider, id: string, descriptor: SliderCheckPointDescriptor) {
  const checkPoint = new SliderCheckPoint(slider);
  const { time, spanStartTime, spanIndex, spanProgress } = descriptor;
  checkPoint.id = id;
  checkPoint.offset = slider.path.positionAt(spanProgress);
  checkPoint.type = descriptor.type;
  checkPoint.hitTime = time;
  checkPoint.spanIndex = spanIndex;
  checkPoint.spanStartTime = spanStartTime;
  checkPoint.spanProgress = spanProgress;
  if (descriptor.type === "TICK") {
    const samplePoint = sliderSamplePoint(slider, time);
    checkPoint.samples = [
      new HitSampleInfo(
        "slidertick",
        samplePoint.sampleBank,
        samplePoint.customSampleBank >= 2 ? String(samplePoint.customSampleBank) : null,
        samplePoint.sampleVolume,
        null,
        samplePoint.customSampleBank,
      ),
    ];
  } else {
    const edgeIndex = descriptor.type === "REPEAT" ? spanIndex + 1 : slider.spanCount;
    checkPoint.samples = slider.nodeSamples[edgeIndex]?.map((sample) => ({ ...sample })) ?? [];
  }
  return checkPoint;
}

function sliderSamplePoint(slider: Slider, time: number): SampleControlPoint {
  return slider.sampleControlPointInfo?.samplePointAt(time) ?? SampleControlPoint.DEFAULT;
}

function createSliderCheckPoints(slider: Slider): SliderCheckPoint[] {
  const checkPoints: SliderCheckPoint[] = [];
  let checkpointIndex = 0;
  for (const e of generateSliderCheckpoints(
    slider.startTime,
    slider.spanDuration,
    slider.velocity,
    slider.tickDistance,
    slider.path.distance,
    slider.spanCount,
    slider.legacyLastTickOffset,
  )) {
    const id = `${slider.id}/${checkpointIndex++}`;
    checkPoints.push(createSliderCheckPoint(slider, id, e));
  }
  return checkPoints;
}

function copyPathPoints(pathPoints: PathControlPoint[]) {
  return pathPoints.map(({ type, offset }) => ({
    type,
    offset: copyPosition(offset),
  }));
}

function createSlider(
  index: number,
  sliderSettings: SliderSettings,
  controlPointInfo: ControlPointInfo,
  difficulty: BeatmapDifficulty,
  beatmapVersion: number,
): Slider {
  const approachDuration = approachRateToApproachDuration(difficulty.approachRate);
  const scale = circleSizeToScale(difficulty.circleSize);
  const hitTime = sliderSettings.time;
  const timingPoint: TimingControlPoint = controlPointInfo.timingPointAt(hitTime);
  const difficultyPoint = controlPointInfo.difficultyPointAt(hitTime);
  const scoringDistance = Slider.BASE_SCORING_DISTANCE * difficulty.sliderMultiplier * difficultyPoint.speedMultiplier;
  const sliderId = index.toString();

  const head = new HitCircle();
  head.id = `${index.toString()}/HEAD`;
  head.unstackedPosition = copyPosition(sliderSettings.position);
  head.position = copyPosition(sliderSettings.position);
  head.hitTime = sliderSettings.time;
  head.approachDuration = approachDuration;
  head.scale = scale;
  head.sliderId = sliderId;

  const slider = new Slider(head);
  slider.id = sliderId;
  slider.repeatCount = sliderSettings.repeatCount;
  slider.legacyLastTickOffset = sliderSettings.legacyLastTickOffset;
  slider.velocity = scoringDistance / timingPoint.beatLength;
  slider.stableTiming = stableSliderTimingParameters(difficulty, timingPoint, difficultyPoint);
  slider.tickDistance = (scoringDistance / difficulty.sliderTickRate) * sliderSettings.tickDistanceMultiplier;
  // Before v8, inherited slider velocity changed duration but not tick spacing.
  // Native Lazer's legacy decoder preserves that grid, as Stable does below.
  if (beatmapVersion < 8) slider.tickDistance /= difficultyPoint.speedMultiplier;
  slider.path = new SliderPath(copyPathPoints(sliderSettings.pathPoints), sliderSettings.length);
  slider.sampleControlPointInfo = controlPointInfo;
  slider.nodeSamples = Array.from({ length: slider.spanCount + 1 }, (_, edgeIndex) => {
    const edgeTime = slider.startTime + edgeIndex * slider.spanDuration;
    return resolvedSamples(
      sliderSettings.nodeSamples[edgeIndex] ?? sliderSettings.samples,
      controlPointInfo.samplePointAt(edgeTime),
    );
  });
  slider.loopSamples = resolvedSamples(sliderSettings.loopSamples, controlPointInfo.samplePointAt(slider.startTime));
  slider.head.samples = slider.nodeSamples[0]?.map((sample) => ({ ...sample })) ?? [];
  slider.checkPoints = createSliderCheckPoints(slider);
  return slider;
}

function createSpinner(
  id: string,
  settings: SpinnerSettings,
  controlPointInfo: ControlPointInfo,
  difficulty: BeatmapDifficulty,
) {
  const spinner = new Spinner();
  spinner.id = id;
  spinner.startTime = settings.time;
  spinner.duration = settings.duration;
  spinner.approachDuration = approachRateToApproachDuration(difficulty.approachRate);
  spinner.fadeInDuration = 400 * Math.min(1, spinner.approachDuration / 450);
  spinner.samples = resolvedSamples(settings.samples, controlPointInfo.samplePointAt(spinner.endTime));
  spinner.applyLazerDefaults(difficulty.overallDifficulty);
  return spinner;
}

function createStaticHitObject(
  index: number,
  hitObjectSetting: HitObjectSettings,
  controlPointInfo: ControlPointInfo,
  beatmapDifficulty: BeatmapDifficulty,
  beatmapVersion: number,
): OsuHitObject {
  switch (hitObjectSetting.type) {
    case "HIT_CIRCLE":
      return createHitCircle(
        index.toString(),
        hitObjectSetting as HitCircleSettings,
        controlPointInfo,
        beatmapDifficulty,
      );
    case "SLIDER":
      return createSlider(
        index,
        hitObjectSetting as SliderSettings,
        controlPointInfo,
        beatmapDifficulty,
        beatmapVersion,
      );
    case "SPINNER":
      return createSpinner(index.toString(), hitObjectSetting as SpinnerSettings, controlPointInfo, beatmapDifficulty);
  }
  throw new Error("Type not recognized...");
}

// Mutates the hitObject combo index values
function assignComboIndex(bluePrintSettings: HitObjectSettings[], hitObjects: OsuHitObject[]) {
  let comboSetIndex = -1,
    withinSetIndex = 0;
  for (let i = 0; i < hitObjects.length; i++) {
    const { newCombo, comboSkip, type } = bluePrintSettings[i];
    const hitObject = hitObjects[i]; // change 'const' -> 'let' for better readability

    if (i === 0 || newCombo || type === "SPINNER") {
      comboSetIndex += comboSkip + 1;
      withinSetIndex = 0;
    }

    // Spinners do not have comboSetIndex or withinComboSetIndex
    if (hitObject instanceof HitCircle) {
      hitObject.comboSetIndex = comboSetIndex;
      hitObject.withinComboSetIndex = withinSetIndex++;
    } else if (hitObject instanceof Slider) {
      hitObject.head.comboSetIndex = comboSetIndex;
      hitObject.head.withinComboSetIndex = withinSetIndex++;
    }
  }
}

// There should only be one, otherwise ...
function findDifficultyApplier(mods: OsuClassicMod[]): BeatmapDifficultyAdjuster {
  for (const m of mods) {
    const adjuster = ModSettings[m].difficultyAdjuster;
    if (adjuster !== undefined) {
      return adjuster;
    }
  }
  return (d: BeatmapDifficulty) => d; // The identity function
}

interface BeatmapBuilderOptions {
  addStacking: boolean;
  mods: OsuClassicMod[];
  lazerMods?: readonly LazerMod[];
}

const defaultBeatmapBuilderOptions: BeatmapBuilderOptions = {
  addStacking: true,
  mods: [],
};

/**
 * Builds the beatmap from the given blueprint and options.
 *
 * It DOES not perform a check on the given subset of mods. So if you enter half-time and double time at the same time,
 * then this might return bad results.
 *
 * @param {Blueprint} bluePrint
 * @param {Object} options
 * @param {boolean} options.addStacking whether to apply setting or not (by default true)
 */
export function buildBeatmap(bluePrint: Blueprint, options?: Partial<BeatmapBuilderOptions>): Beatmap {
  const { beatmapVersion, stackLeniency } = bluePrint.blueprintInfo;
  const { mods, addStacking, lazerMods = [] } = { ...defaultBeatmapBuilderOptions, ...options };
  const lazerSettings = resolveLazerModSettings(lazerMods);
  // DA is incompatible with HR/EZ in lazer. Its explicit values override the
  // original map, and must be in place before size, preempt and stacking.
  const applicableMods = lazerSettings.difficultyAdjust
    ? mods.filter((mod) => mod !== "HARD_ROCK" && mod !== "EASY")
    : mods;

  const finalDifficulty = {
    ...findDifficultyApplier(applicableMods)(bluePrint.defaultDifficulty),
    ...lazerSettings.difficultyAdjust,
  };

  const hitObjects: OsuHitObject[] = bluePrint.hitObjectSettings.map((setting, index) =>
    createStaticHitObject(index, setting, bluePrint.controlPointInfo, finalDifficulty, beatmapVersion),
  );
  for (const object of hitObjects) {
    if (object instanceof Slider) object.stableGeometryVersion = beatmapVersion;
  }

  assignComboIndex(bluePrint.hitObjectSettings, hitObjects);

  if (applicableMods.includes("HARD_ROCK")) {
    HardRockMod.flipVertically(hitObjects);
  }

  if (addStacking) {
    modifyStackingPosition(hitObjects, stackLeniency, beatmapVersion);
  }

  for (const object of hitObjects) {
    if (!(object instanceof Slider)) continue;
    object.stableCheckPoints = new StableSliderTiming(object).checkPoints;
    for (const point of object.stableCheckPoints) {
      if (object.checkPoints.includes(point)) continue;
      // Extra source ticks use their source position/time, with the same sample
      // resolution as shared checkpoints. Existing native objects stay intact.
      point.samples = createSliderCheckPoint(object, point.id, {
        type: point.type,
        time: point.hitTime,
        spanIndex: point.spanIndex,
        spanStartTime: point.spanStartTime,
        spanProgress: point.spanProgress,
      }).samples;
    }
  }

  return new Beatmap(
    hitObjects,
    finalDifficulty,
    applicableMods,
    bluePrint.controlPointInfo,
    bluePrint.blueprintInfo.samplesMatchPlaybackRate,
    bluePrint.blueprintInfo.storyboardSamples,
    bluePrint.blueprintInfo.breakPeriods,
    lazerMods,
    stableOverallDifficultyFor(
      lazerSettings.difficultyAdjust?.overallDifficulty ?? bluePrint.defaultDifficulty.overallDifficulty,
      applicableMods,
    ),
  );
}
