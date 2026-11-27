import { useObservable } from "rxjs-hooks";
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { useAnalysisApp } from "../providers/TheaterProvider";
import type { ReplayLoadState } from "../services/manager/replay-load-state";
import type { LibraryViewState } from "../services/library/library-view-state";

export const ReplayOpeningContext = createContext<LibraryViewState | null>(null);
const PREFLIGHT_LOADING: ReplayLoadState = Object.freeze({ phase: "loading", step: "read-replay" });

/** The replay load state the stage, inspector and dock draw from. */
export function useReplayLoadState(): ReplayLoadState {
  const app = useAnalysisApp();
  const opening = useContext(ReplayOpeningContext);
  const subscribe = useCallback((notify: () => void) => {
    const subscription = opening?.state$.subscribe(notify);
    return () => subscription?.unsubscribe();
  }, [opening]);
  const getOpening = useCallback(() => opening?.snapshot().openingId ?? null, [opening]);
  const openingId = useSyncExternalStore(subscribe, getOpening, getOpening);
  const raw = useObservable(() => app.scenarioManager.loadState$, app.scenarioManager.loadState$.getValue());
  // Preflight has no raw loading publication by design. Draw the existing loading
  // presentation until the actual opener publishes its own progress or settles.
  return openingId && raw.phase !== "loading" ? PREFLIGHT_LOADING : raw;
}
