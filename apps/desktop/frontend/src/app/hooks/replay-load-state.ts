import { useObservable } from "rxjs-hooks";
import { useAnalysisApp } from "../providers/TheaterProvider";
import type { ReplayLoadState } from "../services/manager/replay-load-state";

/** The replay load state the stage, inspector and dock draw from. */
export function useReplayLoadState(): ReplayLoadState {
  const app = useAnalysisApp();
  return useObservable(() => app.scenarioManager.loadState$, app.scenarioManager.loadState$.getValue());
}
