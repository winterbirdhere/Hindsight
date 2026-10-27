import { Box } from "@mui/material";
import { ReactNode } from "react";
import { useObservable } from "rxjs-hooks";
import { DisplayTarget, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type {
  ErrorOutlineMode,
  KeyOverlayLength,
  ReplayDisplaySettings,
  ReplayDisplayToggleKey,
} from "../../services/analysis/replay-display-settings";
import { UR_BAR_PERCENT, urBarPercentToScale, urBarScaleToPercent } from "../../services/common/hit-error-bar";
import { REWIND_COLORS, REWIND_FONTS } from "../../styles/tokens";
import { Segmented, SettingsSection, SliderRow, TextToggle, ToggleRow, ValueRow } from "./controls";
import { DisplaySectionId, displaySections, displayToggles } from "./display-rows";

const TARGET_OPTIONS: ReadonlyArray<{ value: DisplayTarget; label: string }> = [
  { value: "viewer", label: "Viewer" },
  { value: "clip", label: "Exported clip" },
];
const ERROR_CAUSE_OPTIONS: ReadonlyArray<{ value: ReplayDisplaySettings["errorCauseDisplay"]; label: string }> = [
  { value: "concise", label: "Concise" },
  { value: "brief", label: "Brief" },
];
const ERROR_OUTLINE_OPTIONS: ReadonlyArray<{ value: ErrorOutlineMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "selected", label: "Selected" },
  { value: "all", label: "All" },
];
const KEY_OVERLAY_LENGTH_OPTIONS: ReadonlyArray<{ value: KeyOverlayLength; label: string }> = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" },
];
const SECTION_LABELS: Record<DisplaySectionId, string> = {
  timing: "Timing",
  performance: "Performance",
  liveResults: "Live results",
  timelineMarks: "Timeline marks",
  gameplayHud: "Gameplay HUD",
  cursors: "Cursors",
};
type CursorKey = "showReplayCursor" | "showAnalysisCursor" | "showComparisonCursor";
const CURSOR_TOGGLES: ReadonlyArray<{ key: CursorKey; label: string }> = [
  { key: "showReplayCursor", label: "Replay" },
  { key: "showAnalysisCursor", label: "Analysis" },
  { key: "showComparisonCursor", label: "Comparison" },
];

/**
 * The Display tab (design 17a): which readouts the live viewer shows, or which the exported clip draws. The switch
 * on top only chooses which of the two separate stores is edited; nothing is copied between them, and the stage
 * keeps showing the viewer's settings.
 */
export function DisplayTab() {
  const analyzer = useAnalysisApp();
  const { displayTarget, setDisplayTarget } = useInspector();
  const { replayDisplaySettingsStore: viewerStore, clipExportSettingsStore: clipStore } = analyzer;
  const viewerSettings = useObservable(() => viewerStore.settings$, viewerStore.settings);
  const clipSettings = useObservable(() => clipStore.settings$, clipStore.settings);
  const comparison = useObservable(
    () => analyzer.gameSimulator.replayComparison$,
    analyzer.gameSimulator.replayComparison$.value,
  );

  const clip = displayTarget === "clip";
  const settings: ReplayDisplaySettings = clip ? clipSettings.displaySettings : viewerSettings;
  const edit = (change: (draft: ReplayDisplaySettings) => void) => {
    if (clip) clipStore.changeSettings((draft) => change(draft.displaySettings));
    else viewerStore.changeSettings(change);
  };
  const setToggle = (key: ReplayDisplayToggleKey, next: boolean) => edit((draft) => void (draft[key] = next));

  const sections = displaySections(displayTarget);
  const lastSection = sections[sections.length - 1];

  const toggles = (section: Exclude<DisplaySectionId, "cursors">) => (
    <ToggleRow>
      {displayToggles(section, displayTarget).map(({ key, label, color }) => (
        <TextToggle
          key={key}
          label={label}
          color={color}
          checked={settings[key]}
          onChange={(next) => setToggle(key, next)}
        />
      ))}
    </ToggleRow>
  );

  const extras: Partial<Record<DisplaySectionId, ReactNode>> = {
    timing: (
      <>
        <ValueRow label="Key overlay length" disabled={!settings.keyOverlapEnabled}>
          <Segmented
            label="Key overlay length"
            value={settings.keyOverlayLength}
            options={KEY_OVERLAY_LENGTH_OPTIONS}
            disabled={!settings.keyOverlapEnabled}
            onChange={(next) => edit((draft) => void (draft.keyOverlayLength = next))}
          />
        </ValueRow>
        {/* The viewer's key overlay colours the marks of missed and broken objects; a clip never does. */}
        {!clip && (
          <ToggleRow>
            <TextToggle
              label="Key overlay error marks"
              checked={settings.keyOverlayErrorMarksEnabled}
              disabled={!settings.keyOverlapEnabled}
              onChange={(next) => setToggle("keyOverlayErrorMarksEnabled", next)}
            />
          </ToggleRow>
        )}
        <SliderRow
          dense
          label="UR bar size"
          // A saved size outside the range shows its real percentage; the knob rests at the nearest end.
          value={urBarScaleToPercent(settings.hitErrorBarScale)}
          min={UR_BAR_PERCENT.min}
          max={UR_BAR_PERCENT.max}
          step={UR_BAR_PERCENT.step}
          disabled={!settings.hitErrorBarEnabled}
          onChange={(next) => edit((draft) => void (draft.hitErrorBarScale = urBarPercentToScale(next)))}
        />
      </>
    ),
    performance: clip ? null : (
      <ValueRow label="Error cause detail">
        <Segmented
          label="Error cause detail"
          value={settings.errorCauseDisplay}
          options={ERROR_CAUSE_OPTIONS}
          onChange={(next) => edit((draft) => void (draft.errorCauseDisplay = next))}
        />
      </ValueRow>
    ),
    // The rings on the playfield belong to the viewer; a clip never draws them.
    gameplayHud: clip ? null : (
      <>
        <ValueRow label="Error outline">
          <Segmented
            label="Error outline"
            value={settings.errorOutline}
            options={ERROR_OUTLINE_OPTIONS}
            onChange={(next) => edit((draft) => void (draft.errorOutline = next))}
          />
        </ValueRow>
        {/* What goes with a ring: the cursor's path and the object's own taps, then the number beside each tap. */}
        <ToggleRow>
          <TextToggle
            label="Miss trail"
            checked={settings.missTrailEnabled}
            disabled={settings.errorOutline === "off"}
            onChange={(next) => setToggle("missTrailEnabled", next)}
          />
          <TextToggle
            label="Tap numbers"
            checked={settings.tapNumbersEnabled}
            disabled={settings.errorOutline === "off" || !settings.missTrailEnabled}
            onChange={(next) => setToggle("tapNumbersEnabled", next)}
          />
        </ToggleRow>
      </>
    ),
    timelineMarks: (
      <Box
        component="p"
        sx={{
          m: 0,
          pt: "4px",
          fontFamily: REWIND_FONTS.ui,
          fontSize: 12,
          lineHeight: "17px",
          color: REWIND_COLORS.textTertiary,
          textWrap: "pretty",
        }}
      >
        Breaks apply to Stable, ticks to Lazer, ends to both.
      </Box>
    ),
  };

  return (
    <>
      <Box sx={{ flex: "none", p: "12px 20px", boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.08)" }}>
        <ValueRow label="Settings for">
          <Segmented
            label="Settings for"
            value={displayTarget}
            options={TARGET_OPTIONS}
            onChange={setDisplayTarget}
            width={190}
          />
        </ValueRow>
      </Box>
      {sections.map((section) => (
        <SettingsSection key={section} label={SECTION_LABELS[section]} variant="toggles" last={section === lastSection}>
          {section === "cursors" ? (
            <ToggleRow>
              {CURSOR_TOGGLES.map(({ key, label }) => (
                <TextToggle
                  key={key}
                  label={label}
                  checked={clipSettings[key]}
                  // Comparison has nothing to draw until a comparison is loaded; its saved choice stays as it is.
                  disabled={key === "showComparisonCursor" && comparison.status !== "READY"}
                  onChange={(next) => clipStore.changeSettings((draft) => void (draft[key] = next))}
                />
              ))}
            </ToggleRow>
          ) : (
            toggles(section)
          )}
          {extras[section]}
        </SettingsSection>
      ))}
    </>
  );
}
