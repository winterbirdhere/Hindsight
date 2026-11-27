import { useEffect } from "react";
import { useObservable } from "rxjs-hooks";
import { useErrorNavigation } from "../../hooks/error-navigation";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { analysisAttributedTaps, analysisCauseKind } from "../../services/analysis/attributed-taps";
import { errorMarks, errorOutlineTargets, type MissTrailSource } from "../../services/common/error-outline";

/**
 * Tells the renderer which errors to outline on the playfield and to colour in the key overlay: the inspected error
 * with its incident, or every error, by the viewer's `Error outline` setting. With `Miss trail` on, each comes with
 * the replay's cursor samples around it and the taps the miss analysis attributes to its object. It also says which
 * error is inspected, which keeps its trail when a later error appears. The key overlay's marks are every error's,
 * by their own `Key overlay error marks` setting, whatever the outline is set to. It draws nothing itself.
 */
export function ErrorOutlineBridge() {
  const { gameSimulator, errorOutlineStore, replayDisplaySettingsStore } = useAnalysisApp();
  const { errors, incidents, selectedIndex, ruleset, replayingSpeed } = useErrorNavigation();
  const events = useObservable(() => gameSimulator.replayEvents$, gameSimulator.replayEvents$.getValue());
  const session = useObservable(() => gameSimulator.missExplanations$, gameSimulator.missExplanations$.value);
  const settings = useObservable(() => replayDisplaySettingsStore.settings$, replayDisplaySettingsStore.settings);
  // An incident replay is an explicit request to look at that incident: its rings and trail show whatever is set,
  // and only its own, so All narrows to it for as long as it plays.
  const replaying = replayingSpeed !== undefined;
  const mode = replaying ? "selected" : settings.errorOutline;
  const missTrailEnabled = replaying || settings.missTrailEnabled;
  const { tapNumbersEnabled } = settings;
  // All does not depend on the inspection, so inspecting something does not rebuild every ring.
  const inspected = mode === "selected" ? selectedIndex : -1;

  useEffect(() => {
    const beatmap = gameSimulator.getPrimaryBeatmap();
    const frames = gameSimulator.getPrimaryReplay()?.frames;
    const clockRate = beatmap?.gameClockRate ?? 1;
    const trail: MissTrailSource | undefined =
      missTrailEnabled && frames
        ? {
            frames,
            clockRate,
            labels: tapNumbersEnabled,
            // The analysis decides which taps belong to an error; with none ready there are none to show.
            taps: (error) => analysisAttributedTaps(error, events, ruleset, session),
            // And whether the cursor's path has anything to do with the error.
            causeKind: (error) => analysisCauseKind(error, events, ruleset, session),
          }
        : undefined;
    errorOutlineStore.setTargets(
      errorOutlineTargets({ mode, errors, incidents, selectedIndex: inspected, events, ruleset, beatmap, clockRate, trail }),
    );
  }, [
    errorOutlineStore,
    gameSimulator,
    mode,
    errors,
    incidents,
    inspected,
    events,
    ruleset,
    session,
    missTrailEnabled,
    tapNumbersEnabled,
  ]);

  const { keyOverlayErrorMarksEnabled } = settings;
  useEffect(() => {
    errorOutlineStore.setMarks(keyOverlayErrorMarksEnabled ? errorMarks(errors, gameSimulator.getPrimaryBeatmap()) : new Map());
  }, [errorOutlineStore, gameSimulator, errors, keyOverlayErrorMarksEnabled]);

  const inspectedErrorId = errors[selectedIndex]?.id;
  useEffect(() => errorOutlineStore.setInspected(inspectedErrorId), [errorOutlineStore, inspectedErrorId]);

  useEffect(
    () => () => {
      errorOutlineStore.setTargets([]);
      errorOutlineStore.setMarks(new Map());
      errorOutlineStore.setInspected(undefined);
    },
    [errorOutlineStore],
  );

  return null;
}
