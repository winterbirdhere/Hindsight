import { useCallback, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { useAnalysisApp, useCommonManagers } from "../providers/TheaterProvider";
import { useTransportToggle } from "./clip-export";
import { useGameClockControls } from "./game-clock";
import { useModControls } from "./mods";
import { usePlaybackSteps, usePlaybackWheel } from "./playback-steps";

// TODO: Configurable

// The playhead moves in four sizes of step (see `playback-steps`): the wheel steps a note; the arrow keys a 30 ms
// nudge, with Ctrl a frame and with Shift a bar.

const leftKeys = ["left"];
const rightKeys = ["right"];

const upKeys = ["up"];
const downKeys = ["down"];

const generateKeyComboSimple = (keys: string[]) => keys.join(", ");
const generateKeyCombo = (modifier = "", keys: string[]) => keys.map((k) => `${modifier}+${k}`).join(", ");

const shortcutOptions = {
  filter: (event: KeyboardEvent) =>
    !event.defaultPrevented &&
    !(
      event.target instanceof Element &&
      event.target.closest(
        "button, a[href], [role=slider], [role=button], [role=menuitem], [role=tab], [role=switch], [role=checkbox], [role=combobox], [role=dialog], .MuiModal-root",
      )
    ),
  // Arrow keys keep their native behavior in focused controls.
  filterPreventDefault: false,
};

function isEditingOrInDialog(event: KeyboardEvent) {
  return (
    event.target instanceof Element &&
    event.target.closest(
      'input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], dialog, [role="dialog"], [role="menu"], .MuiModal-root',
    )
  );
}

function useFrameStepKeys(stepFrame: (direction: 1 | -1) => void, isReplayLoaded: () => boolean) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !isReplayLoaded() ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented ||
        isEditingOrInDialog(event)
      )
        return;
      const key = event.key.toLowerCase();
      const backward = key === "arrowleft";
      const forward = key === "arrowright";
      if (!backward && !forward) return;
      // Capture before focused toolbar/timeline controls swallow the shortcut
      // or apply the slider's ordinary 16 ms step.
      event.preventDefault();
      event.stopPropagation();
      stepFrame(backward ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [stepFrame, isReplayLoaded]);
}

/**
 * Holding Q plays the overview at the `Speed while holding Q` setting; letting go gives the viewer's speed back. It
 * leaves alone a clip export and anything that plays to a boundary of its own (an incident replay, a clip preview).
 */
function useHoldSlow(isReplayLoaded: () => boolean) {
  const { gameClock, clipRecorder } = useAnalysisApp();
  const { playbarSettingsStore } = useCommonManagers();
  useEffect(() => {
    // The key's place on the keyboard, so that it is the same key on every layout.
    const isHoldKey = (event: KeyboardEvent) => event.code === "KeyQ" || (!event.code && event.key.toLowerCase() === "q");
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHoldKey(event) || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      if (!isReplayLoaded() || isEditingOrInDialog(event)) return;
      if (clipRecorder?.isBusy || gameClock.controlsLocked || gameClock.playbackBoundaryInMs !== undefined) return;
      gameClock.holdSpeed(playbarSettingsStore.settings.holdSpeed);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isHoldKey(event)) gameClock.releaseSpeed();
    };
    // A key let go while another window has the focus never reports its release.
    const onBlur = () => gameClock.releaseSpeed();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      gameClock.releaseSpeed();
    };
  }, [gameClock, clipRecorder, playbarSettingsStore, isReplayLoaded]);
}

function usePlaybackSpace(toggleTransport: () => void, isReplayLoaded: () => boolean) {
  useEffect(() => {
    let spacePressed = false;
    const isSpace = (event: KeyboardEvent) => event.code === "Space" || event.key === " ";
    const onKeyDown = (event: KeyboardEvent) => {
      // Without a loaded replay Space is left alone, so it still activates a focused button.
      if (!isReplayLoaded()) return;
      if (!isSpace(event) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing)
        return;
      if (isEditingOrInDialog(event)) return;

      // Run before toolbar/timeline handlers. Space always plays or pauses here,
      // and must not also activate the focused button (Enter still does).
      event.preventDefault();
      event.stopPropagation();
      if (!spacePressed && !event.repeat) toggleTransport();
      spacePressed = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSpace(event) || !spacePressed) return;
      spacePressed = false;
      // MUI also activates some focused controls on keyup.
      event.preventDefault();
      event.stopPropagation();
    };
    const onBlur = () => {
      spacePressed = false;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [toggleTransport, isReplayLoaded]);
}

// TODO: Get platform from AppInfo, so that we can also support MacOS (currently they are hardcoded for Windows/Linux)
export function useShortcuts() {
  const analyzer = useAnalysisApp();
  const { scenarioManager } = analyzer;
  const { increaseSpeed, decreaseSpeed } = useGameClockControls();
  const { step } = usePlaybackSteps();
  const { setHidden, hidden } = useModControls();
  // The clip preview's toggle during an export session, the clock's own otherwise.
  const toggleTransport = useTransportToggle();

  // Read at key-press time so a handler never acts on a stale load state. Every shortcut here acts on the loaded
  // replay (clock, speed, mods), so none of them does anything until a replay is ready.
  const isReplayLoaded = useCallback(
    () => analyzer.isViewerVisible?.() !== false && scenarioManager.loadState$.getValue().phase === "ready",
    [analyzer, scenarioManager],
  );
  const whenLoaded = useCallback(
    (action: () => void) => () => {
      if (isReplayLoaded()) action();
    },
    [isReplayLoaded],
  );

  useHotkeys(generateKeyComboSimple(upKeys), whenLoaded(increaseSpeed), shortcutOptions, [increaseSpeed, whenLoaded]);
  useHotkeys(generateKeyComboSimple(downKeys), whenLoaded(decreaseSpeed), shortcutOptions, [decreaseSpeed, whenLoaded]);
  usePlaybackSpace(toggleTransport, isReplayLoaded);
  const stepFrame = useCallback((direction: 1 | -1) => step("frame", direction), [step]);
  useFrameStepKeys(stepFrame, isReplayLoaded);
  usePlaybackWheel(step, isReplayLoaded);
  useHoldSlow(isReplayLoaded);

  useHotkeys(
    generateKeyCombo("shift", leftKeys),
    whenLoaded(() => step("bar", -1)),
    shortcutOptions,
    [step, whenLoaded],
  );
  useHotkeys(
    generateKeyCombo("shift", rightKeys),
    whenLoaded(() => step("bar", 1)),
    shortcutOptions,
    [step, whenLoaded],
  );
  useHotkeys(
    generateKeyComboSimple(leftKeys),
    whenLoaded(() => step("nudge", -1)),
    shortcutOptions,
    [step, whenLoaded],
  );
  useHotkeys(
    generateKeyComboSimple(rightKeys),
    whenLoaded(() => step("nudge", 1)),
    shortcutOptions,
    [step, whenLoaded],
  );

  useHotkeys(
    "f",
    whenLoaded(() => setHidden(!hidden)),
    shortcutOptions,
    [hidden, setHidden, whenLoaded],
  );
}
