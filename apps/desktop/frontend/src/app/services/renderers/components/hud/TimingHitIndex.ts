import { standardDeviation } from "simple-statistics";

type TimingHit = readonly [judgementTime: number, offset: number, hit: boolean];

/** Snapshot of one replacement-only, chronologically sorted simulator collection. */
export class TimingHitIndex {
  private readonly times: number[] = [];
  private readonly offsets: number[] = [];
  private readonly successful: boolean[] = [];
  private readonly counts: number[] = [0];
  private readonly means: number[] = [0];
  private readonly deviations: number[] = [0];
  private readonly maximumOffsets: number[] = [0];
  private readonly formattedRates = new Map<number, string>();
  readonly successfulOffsets: readonly number[];

  constructor(hits: readonly TimingHit[], gameClockRate: number, private readonly urMultiplier: number) {
    const successfulOffsets: number[] = [];
    this.successfulOffsets = successfulOffsets;
    let sum = 0;
    let correction = 0;
    let origin = 0;
    let shiftedMean = 0;
    let squaredDeviations = 0;
    let maximumOffset = 0;
    for (const [time, offset, hit] of hits) {
      this.times.push(time);
      this.offsets.push(offset);
      this.successful.push(hit);
      if (hit) {
        const value = offset / gameClockRate;
        successfulOffsets.push(value);
        const count = this.successfulOffsets.length;
        // Same compensated summation and operation order as simple-statistics.mean.
        if (count === 1) {
          sum = value;
          origin = value;
        } else {
          const transition = sum + value;
          correction += Math.abs(sum) >= Math.abs(value) ? sum - transition + value : value - transition + sum;
          sum = transition;
        }
        // Welford around a fixed origin also retains small spreads around large biases.
        const shifted = value - origin;
        const delta = shifted - shiftedMean;
        shiftedMean += delta / count;
        squaredDeviations += delta * (shifted - shiftedMean);
        maximumOffset = Math.max(maximumOffset, Math.abs(value));
        this.means.push((sum + correction) / count);
        this.deviations.push(Math.sqrt(Math.max(0, squaredDeviations) / count));
        this.maximumOffsets.push(maximumOffset);
      }
      this.counts.push(this.successfulOffsets.length);
    }
  }

  /** Upper bound includes every judgement at the playhead, including tied times. */
  prefixEnd(time: number): number {
    let low = 0;
    let high = this.times.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.times[middle] <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  sampleCount(prefixEnd: number): number {
    return this.counts[prefixEnd];
  }

  mean(count: number): number {
    return this.means[count];
  }

  unstableRate(count: number): string {
    if (count === 0) return "—";
    const cached = this.formattedRates.get(count);
    if (cached !== undefined) return cached;
    let rate = this.deviations[count] * 10 * this.urMultiplier;
    // Incremental and two-pass variance can differ by a few ulps. Near a display
    // rounding boundary use the original calculation once for this prefix. The
    // conservative bound also covers extreme offsets with tiny relative spread.
    const tolerance =
      Number.EPSILON * 128 * count * Math.max(1, this.maximumOffsets[count]) * 10 * Math.abs(this.urMultiplier);
    const roundingDistance = Math.abs(rate * 10 - Math.floor(rate * 10) - 0.5) / 10;
    if (!Number.isFinite(rate) || roundingDistance <= tolerance) {
      rate = standardDeviation(this.successfulOffsets.slice(0, count)) * 10 * this.urMultiplier;
    }
    const formatted = rate.toFixed(1);
    this.formattedRates.set(count, formatted);
    return formatted;
  }

  recent(time: number, prefixEnd: number): Array<{ timeAgo: number; offset: number; miss: boolean }> {
    const result: Array<{ timeAgo: number; offset: number; miss: boolean }> = [];
    let low = 0;
    let high = prefixEnd;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      // Use the original subtraction order at the inclusive boundary: tiny
      // negative judgement times can round to exactly 10000 ms of age.
      if (time - this.times[middle] > 10000) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < prefixEnd; index++) {
      result.push({ timeAgo: time - this.times[index], offset: this.offsets[index], miss: !this.successful[index] });
    }
    return result;
  }
}
