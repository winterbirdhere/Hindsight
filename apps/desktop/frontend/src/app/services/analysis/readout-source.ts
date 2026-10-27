import type { GameSimulator } from "../common/game/GameSimulator";
import type { GameplayClock } from "../common/game/GameplayClock";
import type { ScenarioManager } from "../manager/ScenarioManager";
import type { PerformanceTimelineService } from "./performance/PerformanceTimelineService";
import { buildReadoutModel, type ReadoutModel, type ReadoutSettings } from "./readout-model";

export interface ReadoutSourceDeps {
  scenarioManager: Pick<ScenarioManager, "getBeatmapMetadata">;
  gameSimulator: Pick<
    GameSimulator,
    "getPrimaryReplay" | "getRulesetFocus" | "getCurrentInfo" | "getCurrentScoreStats" | "getCurrentTimingStats"
  >;
  performanceTimeline: Pick<PerformanceTimelineService, "at">;
  gameClock: Pick<GameplayClock, "timeElapsedInMs">;
}

export function readoutAt(deps: ReadoutSourceDeps, settings: ReadoutSettings): ReadoutModel | undefined {
  const replay = deps.gameSimulator.getPrimaryReplay();
  if (!replay) return undefined;
  const ruleset = deps.gameSimulator.getRulesetFocus();
  return buildReadoutModel({
    metadata: deps.scenarioManager.getBeatmapMetadata(),
    player: replay.player,
    mods: replay.mods,
    lazerMods: replay.lazerMods,
    ruleset,
    info: deps.gameSimulator.getCurrentInfo(),
    stats: deps.gameSimulator.getCurrentScoreStats(),
    performance: deps.performanceTimeline.at(ruleset, deps.gameClock.timeElapsedInMs),
    timing: deps.gameSimulator.getCurrentTimingStats(),
    settings,
  });
}
