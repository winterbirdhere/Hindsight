import { float32_mul, Position, Vec2 } from "@osujs/math";

// Shared with evidence; never resize the prepared map itself.
export function stableGameplayRadius(radius: number): number {
  return float32_mul(radius, 1.00041);
}
export function nativeWithinHitRadius(a: Position, b: Position, radius: number): boolean {
  return Vec2.withinDistance(a, b, Math.fround(radius));
}

// Vector2 stores float coordinates, but Stable's .NET Framework x86 runtime
// retains extended intermediates in this comparison. Rounding every operation
// introduces false hits. Keep this separate from shared/native Lazer geometry.
function stableDistanceSquared(a: Position, b: Position): number {
  const dx = Math.fround(a.x) - Math.fround(b.x);
  const dy = Math.fround(a.y) - Math.fround(b.y);
  return dx * dx + dy * dy;
}

function stableRadiusSquared(radius: number): number {
  const rounded = Math.fround(radius);
  return rounded * rounded;
}

export function stableWithinHitRadius(a: Position, b: Position, radius: number): boolean {
  return stableDistanceSquared(a, b) <= stableRadiusSquared(radius);
}

export function stableWithinTrackingRadius(a: Position, b: Position, radius: number): boolean {
  // Slider tracking uses a strict comparison, unlike a circle/head hit test.
  return stableDistanceSquared(a, b) < stableRadiusSquared(radius);
}
