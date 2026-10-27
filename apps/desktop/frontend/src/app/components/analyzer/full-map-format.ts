/** How the Full-map analysis page writes its numbers. A value it does not have is a dash, never a zero. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
export function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function formatPercent(value: number | null, digits = 2): string {
  return finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}
export function formatMetric(value: number | null, digits = 1): string {
  return finite(value) ? value.toFixed(digits) : "—";
}
export function formatSignedMilliseconds(value: number | null): string {
  return finite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)} ms` : "—";
}
/** A signed offset to one decimal, no unit: `+31.0`, `-18.0`, `0.0`. */
export function formatSignedOffset(value: number): string {
  return finite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)}` : "—";
}
/** Index of the first item at or after `time` in a list sorted by time (the length when there is none). */
function lowerBoundByTime(items: ReadonlyArray<{ readonly time: number }>, time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}
/** Index of the item nearest `time` in a list sorted by time; the earlier one on a tie; -1 for an empty list. */
export function nearestIndexByTime(items: ReadonlyArray<{ readonly time: number }>, time: number): number {
  if (items.length === 0) return -1;
  const after = lowerBoundByTime(items, time);
  if (after === 0) return 0;
  if (after === items.length) return items.length - 1;
  return time - items[after - 1].time <= items[after].time - time ? after - 1 : after;
}
/** Index of the last item at or before `time` in a list sorted by time; -1 when there is none. */
export function lastIndexAtOrBefore(items: ReadonlyArray<{ readonly time: number }>, time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
export function formatWindow(value: number | null): string {
  return finite(value) ? `±${value.toFixed(1)}ms` : "—";
}
/** At most two decimals, trailing zeros dropped (0, 2, 2.38), as the pp algorithm's own count is read. */
export function formatEffectiveMiss(value: number | null | undefined): string {
  return finite(value) && value >= 0 ? String(Number(value.toFixed(2))) : "—";
}
export function formatDifficulty(value: number | null): string {
  return finite(value) ? value.toFixed(Number.isInteger(value) ? 0 : 1) : "—";
}
export function formatDuration(value: number | null): string {
  if (!finite(value) || value < 0) return "—";
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}.${Math.floor(value % 1000)
    .toString()
    .padStart(3, "0")}`;
}
