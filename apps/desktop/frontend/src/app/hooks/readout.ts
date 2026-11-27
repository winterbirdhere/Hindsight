import { useObservable } from "rxjs-hooks";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { useGameClockTime } from "./game-clock";
import { readoutAt } from "../services/analysis/readout-source";
import type { ReadoutIdentity, ReadoutModel } from "../services/analysis/readout-model";
import type { ReplayDisplaySettings } from "../services/analysis/replay-display-settings";

/** Everything the readout depends on except the playback clock; returns the current display settings. */
function useReadoutSources(): ReplayDisplaySettings {
  const app = useAnalysisApp();
  useObservable(() => app.performanceTimeline.changed$, 0);
  useObservable(() => app.gameSimulator.rulesetFocus$, "stable");
  useObservable(() => app.gameSimulator.replayEvents$, []);
  useObservable(() => app.scenarioManager.scenario$, app.scenarioManager.scenario$.getValue());
  return useObservable(() => app.replayDisplaySettingsStore.settings$, app.replayDisplaySettingsStore.settings);
}

/** Re-evaluates at the HUD cadence and whenever the replay, ruleset, performance or settings change. */
export function useReadoutModel(): ReadoutModel | undefined {
  const app = useAnalysisApp();
  useGameClockTime(15);
  const settings = useReadoutSources();
  return readoutAt(app, settings);
}

/**
 * Map, player and mods only. It follows the same sources as `useReadoutModel` but not the clock,
 * so a component that shows nothing but the identity does not re-render at the HUD cadence.
 */
export function useReadoutIdentity(): ReadoutIdentity | undefined {
  const app = useAnalysisApp();
  const settings = useReadoutSources();
  return readoutAt(app, settings)?.identity;
}
