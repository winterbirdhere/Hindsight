/** Duration-weighted map tempo; identical clipping, precision and ties to the viewer footer. */
export interface TempoPoint { time: number; beatLength: number }
type TempoDurations = Map<number, { duration: number; firstIndex: number }>;

function tempoDurations(points: readonly TempoPoint[], durationMs: number | null): TempoDurations {
  const mapEnd = durationMs !== null && durationMs > 0 ? durationMs : points[points.length - 1].time;
  const durations: TempoDurations = new Map();
  points.forEach((point, index) => {
    const roundedBeatLength = Math.round(point.beatLength * 1000) / 1000;
    const startTime = index === 0 ? 0 : Math.max(0, Math.min(mapEnd, point.time));
    const nextTime = index + 1 < points.length ? points[index + 1].time : mapEnd;
    const endTime = Math.max(startTime, Math.min(mapEnd, nextTime));
    const existing = durations.get(roundedBeatLength);
    if (existing) existing.duration += endTime - startTime;
    else durations.set(roundedBeatLength, { duration: endTime - startTime, firstIndex: index });
  });
  return durations;
}

function selectTempo(durations: TempoDurations) {
  let selected: { beatLength: number; duration: number; firstIndex: number } | null = null;
  for (const [beatLength, value] of durations) {
    if (
      selected === null ||
      value.duration > selected.duration ||
      (value.duration === selected.duration && value.firstIndex < selected.firstIndex)
    ) {
      selected = { beatLength, ...value };
    }
  }
  return selected;
}

export function dominantBeatLength(
  timingPoints: readonly TempoPoint[] | undefined,
  durationMs: number | null,
): number | null {
  if (!timingPoints || timingPoints.length === 0) return null;
  const points = timingPoints
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.beatLength) && point.beatLength > 0)
    .sort((left, right) => left.time - right.time);
  if (points.length === 0) return null;
  return selectTempo(tempoDurations(points, durationMs))?.beatLength ?? null;
}

/** Sufficient exact certificate, not a guessed end time. Each grouped duration is
 * monotone in a positive horizon. If the lower winner already beats every rival's
 * upper duration (including earliest ties), no intermediate horizon can change it.
 * Two linear reductions and one bounded sort avoid pairwise boundary sampling. */
export function invariantDominantBeatLength(
  timingPoints: readonly TempoPoint[] | undefined,
  lowerHorizon: number,
  upperHorizon: number,
): number | null {
  if (!timingPoints?.length || timingPoints.length > 8192 ||
    !Number.isFinite(lowerHorizon) || !Number.isFinite(upperHorizon) || lowerHorizon <= 0 || upperHorizon < lowerHorizon ||
    timingPoints.some(point => !Number.isFinite(point.time) || !Number.isFinite(point.beatLength) || point.beatLength <= 0)) return null;
  const points = [...timingPoints].sort((left, right) => left.time - right.time);
  const selected = selectTempo(tempoDurations(points, lowerHorizon));
  if (!selected || selected.beatLength <= 0 || !Number.isFinite(selected.duration)) return null;
  for (const [beatLength, value] of tempoDurations(points, upperHorizon)) {
    if (!Number.isFinite(value.duration)) return null;
    if (beatLength !== selected.beatLength && (value.duration > selected.duration ||
      value.duration === selected.duration && value.firstIndex < selected.firstIndex)) return null;
  }
  return selected.beatLength;
}
