// https://github.com/ppy/osu-framework/blob/master/osu.Framework/Graphics/Transforms/DefaultEasingFunction.cs
export enum Easing {
  LINEAR,
  OUT,
  OUT_QUINT,
  OUT_ELASTIC,
  OUT_ELASTIC_HALF,
  IN_CUBIC,
  IN,
}

const elastic_const = (2 * Math.PI) / 0.3;
const elastic_const2 = 0.3 / 4;
// Constants used to fix elastic curves to start/end at 0/1.
const elastic_offset_full = Math.pow(2, -11);
const elastic_offset_half = Math.pow(2, -10) * Math.sin((0.5 - elastic_const2) * elastic_const);

export function applyEasing(t: number, easing: Easing): number {
  switch (easing) {
    case Easing.LINEAR:
      return t;
    case Easing.OUT:
      return t * (2 - t);
    case Easing.OUT_QUINT:
      return --t * t * t * t * t + 1;
    case Easing.OUT_ELASTIC:
      return Math.pow(2, -10 * t) * Math.sin((t - elastic_const2) * elastic_const) + 1 - elastic_offset_full * t;
    case Easing.OUT_ELASTIC_HALF:
      return Math.pow(2, -10 * t) * Math.sin((0.5 * t - elastic_const2) * elastic_const) + 1 - elastic_offset_half * t;
    case Easing.IN_CUBIC:
      return t * t * t;
    case Easing.IN:
      return t * t;
  }
  return t;
}

export function applyInterpolation(
  time: number,
  startTime: number,
  endTime: number,
  valA: number,
  valB: number,
  easing = Easing.LINEAR,
): number {
  // Or floatEqual ...
  if (startTime >= endTime) {
    console.error("startTime should be less than endTime");
    return valA; // or throw Error?
  }
  const p = applyEasing((time - startTime) / (endTime - startTime), easing);
  return (valB - valA) * p + valA;
}

/**
 * Linear interpolation
 * @param start start value
 * @param final final value
 * @param amount number between 0 and 1
 */
export function lerp(start: number, final: number, amount: number) {
  return start + (final - start) * amount;
}
