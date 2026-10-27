import { Beatmap, GameState, isSlider, ReplayAnalysisRuleset } from "@osujs/core";

export function theoreticalMaxCombo(beatmap: Beatmap, ruleset: ReplayAnalysisRuleset = "stable"): number {
  let combo = 0;
  for (const hitObject of beatmap.hitObjects) {
    combo += isSlider(hitObject)
      ? 1 + (ruleset === "stable" ? hitObject.stableCheckPoints ?? hitObject.checkPoints : hitObject.checkPoints).length
      : 1;
  }
  return combo;
}

export function replayTimingHits(beatmap: Beatmap, state: GameState,
  excludedHitObjectIds: ReadonlySet<string> = new Set()): [number, number, boolean][] {
  const hits: [number, number, boolean][] = [];
  for (const id of state.judgedObjects) {
    if (excludedHitObjectIds.has(id)) continue;
    const object = beatmap.getHitObject(id);
    if (object?.type !== "HIT_CIRCLE") continue;
    const verdict = state.hitCircleVerdict[id];
    if (!verdict) continue;
    const circle = beatmap.getHitCircle(id);
    hits.push([verdict.judgementTime, verdict.judgementTime - circle.hitTime, verdict.type !== "MISS"]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits;
}
