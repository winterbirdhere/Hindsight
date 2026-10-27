import { useAnalysisApp } from "../providers/TheaterProvider";
import { useObservable } from "rxjs-hooks";
import { useCallback } from "react";

export function useModControls() {
  const { modSettingsService, clipRecorder } = useAnalysisApp();

  const modSettings = useObservable(() => modSettingsService.modSettings$, { flashlight: false, hidden: false });
  const setHidden = useCallback(
    (value: boolean) => {
      if (!clipRecorder?.isBusy) modSettingsService.setHidden(value);
    },
    [modSettingsService, clipRecorder],
  );

  return { ...modSettings, setHidden };
}
