import { useObservable } from "rxjs-hooks";
import { useCommonManagers } from "../../providers/TheaterProvider";
import { HOLD_SPEEDS } from "../../services/common/playbar";
import { SCROLL_STEPS, type ScrollStep } from "../../services/common/playback-steps";
import { SettingsSection, SliderRow, Stepper, SwitchRow, ValueRow } from "./controls";

const SCROLL_STEP_OPTIONS = SCROLL_STEPS.map((value) => ({ value, label: value === "auto" ? "Auto" : value }));
const HOLD_SPEED_OPTIONS = HOLD_SPEEDS.map((value) => ({ value: String(value), label: `${value}×` }));

/** The Playback tab: replay and analysis cursors, beatmap background dim and stats shade, the steps and the held speed, and the timeline's difficulty graph. */
export function PlaybackTab() {
  const { replayCursorSettingsStore, analysisCursorSettingsStore, beatmapBackgroundSettingsStore, playbarSettingsStore } =
    useCommonManagers();
  const replayCursor = useObservable(() => replayCursorSettingsStore.settings$, replayCursorSettingsStore.settings);
  const analysisCursor = useObservable(
    () => analysisCursorSettingsStore.settings$,
    analysisCursorSettingsStore.settings,
  );
  const background = useObservable(
    () => beatmapBackgroundSettingsStore.settings$,
    beatmapBackgroundSettingsStore.settings,
  );
  const playbar = useObservable(() => playbarSettingsStore.settings$, playbarSettingsStore.settings);

  return (
    <>
      <SettingsSection label="Replay cursor">
        <SwitchRow
          label="Show cursor"
          checked={replayCursor.enabled}
          onChange={(next) => replayCursorSettingsStore.changeSettings((s) => (s.enabled = next))}
        />
        <SwitchRow
          label="Smooth trail"
          checked={replayCursor.smoothCursorTrail}
          disabled={!replayCursor.enabled}
          onChange={(next) => replayCursorSettingsStore.changeSettings((s) => (s.smoothCursorTrail = next))}
        />
        <SliderRow
          label="Size"
          value={Math.round(replayCursor.scale * 100)}
          min={10}
          max={200}
          disabled={!replayCursor.enabled}
          onChange={(next) => replayCursorSettingsStore.changeSettings((s) => (s.scale = next / 100))}
        />
      </SettingsSection>
      <SettingsSection label="Analysis cursor">
        <SwitchRow
          label="Show analysis cursor"
          hint="Marks where each press landed."
          checked={analysisCursor.enabled}
          onChange={(next) => analysisCursorSettingsStore.setEnabled(next)}
        />
      </SettingsSection>
      <SettingsSection label="Beatmap background">
        <SliderRow
          label="Dim"
          value={Math.round(background.dim * 100)}
          min={0}
          max={100}
          onChange={(next) => beatmapBackgroundSettingsStore.setDim(next / 100)}
        />
        <SwitchRow
          label="Shade behind stats"
          hint="Darkens the left edge behind the stats. Applies to exported clips too."
          checked={background.statsShade}
          onChange={(next) => beatmapBackgroundSettingsStore.setStatsShade(next)}
        />
      </SettingsSection>
      <SettingsSection label="Steps and speed">
        <ValueRow label="Scroll step" roomy>
          <Stepper<ScrollStep>
            label="Scroll step"
            value={playbar.scrollStep}
            options={SCROLL_STEP_OPTIONS}
            onChange={(next) => playbarSettingsStore.changeSettings((s) => (s.scrollStep = next))}
          />
        </ValueRow>
        <ValueRow label="Speed while holding Q" roomy>
          <Stepper
            label="Speed while holding Q"
            value={String(playbar.holdSpeed)}
            options={HOLD_SPEED_OPTIONS}
            onChange={(next) => playbarSettingsStore.changeSettings((s) => (s.holdSpeed = Number(next)))}
          />
        </ValueRow>
      </SettingsSection>
      <SettingsSection label="Timeline" last>
        <SwitchRow
          label="Difficulty graph"
          checked={playbar.difficultyGraphEnabled}
          onChange={(next) => playbarSettingsStore.changeSettings((s) => (s.difficultyGraphEnabled = next))}
        />
      </SettingsSection>
    </>
  );
}
