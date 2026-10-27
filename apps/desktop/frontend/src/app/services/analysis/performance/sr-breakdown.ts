type RawSrBreakdown = {
  total: number;
  aim: number;
  speed: number;
  reading: number;
  flashlight: number;
  sliderFactor: number;
};

export type AdditiveSrBreakdown = {
  total: number;
  aim: number;
  speed: number;
  reading: number;
  flashlight: number;
  sliderAim: number;
};

// ppy/osu b11d0d87824f33984587438074f3791ce06b159b difficulty combination constants.
const PERFORMANCE_BASE_MULTIPLIER = 1.12;
const PERFORMANCE_NORM_EXPONENT = 1.1;
const AIM_AND_HARMONIC_MULTIPLIER = 4;
const COMPONENT_COUNT = 4;

export function decomposeStarRating(raw: RawSrBreakdown): AdditiveSrBreakdown {
  const totalHundredths = floorToHundredths(raw.total);
  const rawComponents = [finiteNonNegative(raw.aim), finiteNonNegative(raw.speed), finiteNonNegative(raw.reading), 0];
  const nonFlashlightHundredths =
    finiteNonNegative(raw.flashlight) > 0
      ? Math.min(totalHundredths, floorToHundredths(calculateNonFlashlightStars(rawComponents)))
      : totalHundredths;
  // Preserve the official raw SR component proportions for a player-facing split.
  // Using the nonlinear combination weights as percentages greatly exaggerates
  // whichever component is largest.
  const componentHundredths = allocateIntegerUnits(nonFlashlightHundredths, rawComponents);
  // Flashlight is shown as its incremental effect so enabling it never redistributes
  // SR away from Aim, Speed, or Reading.
  componentHundredths[3] = totalHundredths - nonFlashlightHundredths;
  const sliderFactor = clamp(finiteNonNegative(raw.sliderFactor), 0, 1);
  // SliderFactor directly describes the non-slider share of AimDifficulty.
  const sliderShare = 1 - sliderFactor;
  const sliderAimHundredths = Math.min(
    componentHundredths[0],
    Math.max(0, Math.round(componentHundredths[0] * sliderShare)),
  );
  return {
    total: totalHundredths / 100,
    aim: componentHundredths[0] / 100,
    speed: componentHundredths[1] / 100,
    reading: componentHundredths[2] / 100,
    flashlight: componentHundredths[3] / 100,
    sliderAim: sliderAimHundredths / 100,
  };
}

function cubicPerformance(value: number): number {
  return AIM_AND_HARMONIC_MULTIPLIER * Math.pow(finiteNonNegative(value), 3);
}

function calculateNonFlashlightStars(components: number[]): number {
  const normSum = components.reduce((sum, component) => {
    const performance = cubicPerformance(component);
    return sum + (performance > 0 ? Math.pow(performance, PERFORMANCE_NORM_EXPONENT) : 0);
  }, 0);
  const basePerformance = Math.pow(normSum, 1 / PERFORMANCE_NORM_EXPONENT);
  return Math.cbrt(basePerformance * PERFORMANCE_BASE_MULTIPLIER);
}

function allocateIntegerUnits(total: number, weights: number[]): number[] {
  const result = new Array<number>(COMPONENT_COUNT).fill(0);

  if (total <= 0) {
    return result;
  }

  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  if (weightTotal <= 0) {
    result[0] = total;
    return result;
  }

  const exact = weights.map((weight) => (total * weight) / weightTotal);

  for (let index = 0; index < COMPONENT_COUNT; index += 1) {
    result[index] = Math.floor(exact[index]);
  }

  const remainder = total - result.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exact
    .map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  for (let index = 0; index < remainder; index += 1) {
    result[remainderOrder[index].index] += 1;
  }

  return result;
}

function floorToHundredths(value: number): number {
  return Math.floor((finiteNonNegative(value) + Number.EPSILON) * 100);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
