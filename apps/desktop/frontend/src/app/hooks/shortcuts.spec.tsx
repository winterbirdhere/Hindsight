import "reflect-metadata";
import { Button, Slider } from "@mui/material";
import { act, fireEvent, render as renderWithoutInspector, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { BehaviorSubject } from "rxjs";
import { InspectorProvider, useInspector } from "../providers/InspectorProvider";
import { useAnalysisApp, useCommonManagers } from "../providers/TheaterProvider";
import { GameplayClock } from "../services/common/game/GameplayClock";
import type { ReplayLoadState } from "../services/manager/replay-load-state";
import { HelpModalDialog } from "../components/analyzer/HelpModal";
import { useShortcuts } from "./shortcuts";
import { useGameClockControls } from "./game-clock";
import { useModControls } from "./mods";
import { usePlaybackSteps } from "./playback-steps";

jest.mock("./game-clock", () => ({ useGameClockControls: jest.fn() }));
jest.mock("./mods", () => ({ useModControls: jest.fn() }));
jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn(), useCommonManagers: jest.fn() }));
// The steps themselves are tested with their hook; here a key only has to ask for the right one.
jest.mock("./playback-steps", () => ({ usePlaybackSteps: jest.fn(), usePlaybackWheel: jest.fn() }));

let inspector: ReturnType<typeof useInspector>;
function InspectorProbe() {
  inspector = useInspector();
  return null;
}

/** The transport shortcut reads the inspector, so every fixture mounts under its provider. */
function render(ui: ReactElement) {
  return renderWithoutInspector(
    <InspectorProvider>
      <InspectorProbe />
      {ui}
    </InspectorProvider>,
  );
}

const space = { key: " ", code: "Space", keyCode: 32, which: 32 };

function Harness({ onClick = jest.fn() }: { onClick?: () => void }) {
  useShortcuts();
  return (
    <>
      <Button onClick={onClick} onKeyDown={(event) => event.stopPropagation()}>
        Playback speed
      </Button>
      <Slider aria-label="Range" defaultValue={50} onKeyDown={(event) => event.stopPropagation()} />
      <input aria-label="Time" />
      <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Notes" />
      <div role="dialog" aria-label="Export clip">
        <button>Export</button>
        <Slider aria-label="Clip preview position" defaultValue={50} />
      </div>
      <div role="menu">
        <button role="menuitem">Loop settings</button>
      </div>
      <div className="MuiModal-root" role="presentation">
        <button>Settings tab</button>
      </div>
    </>
  );
}

function setup(initial: ReplayLoadState = { phase: "ready" }) {
  const loadState$ = new BehaviorSubject<ReplayLoadState>(initial);
  const controls = {
    toggleClock: jest.fn(),
    seekForward: jest.fn(),
    seekBackward: jest.fn(),
    increaseSpeed: jest.fn(),
    decreaseSpeed: jest.fn(),
  };
  // Space now goes through the transport toggle, which outside an export session is the clock's own toggle.
  const gameClock = new GameplayClock();
  gameClock.durationInMs = 2_000;
  jest.spyOn(gameClock, "toggle").mockImplementation(controls.toggleClock);
  jest
    .mocked(useAnalysisApp)
    .mockReturnValue({ scenarioManager: { loadState$ }, gameClock, clipRecorder: { isBusy: false } } as never);
  const setHidden = jest.fn();
  const playbarSettings = { difficultyGraphEnabled: true, scrollStep: "auto", holdSpeed: 0.5 };
  jest
    .mocked(useCommonManagers)
    .mockReturnValue({ playbarSettingsStore: { settings: playbarSettings, settings$: new BehaviorSubject(playbarSettings) } } as never);
  // A step is reported through the old seek mocks: 30 stands for a nudge, 16 for a note, 1 for a frame, 1000 for a bar.
  const step = jest.fn((kind: "nudge" | "note" | "frame" | "bar", direction: 1 | -1) =>
    (direction > 0 ? controls.seekForward : controls.seekBackward)(
      kind === "nudge" ? 30 : kind === "note" ? 16 : kind === "frame" ? 1 : 1000,
    ),
  );
  jest.mocked(usePlaybackSteps).mockReturnValue({ step });
  jest.mocked(useGameClockControls).mockReturnValue(controls as never);
  jest.mocked(useModControls).mockReturnValue({ hidden: false, flashlight: false, setHidden });
  return { ...controls, setHidden, loadState$, gameClock, step, playbarSettings };
}
it("leaves library keys alone while its loaded viewer remains mounted but hidden", () => {
  const controls=setup();const app=jest.mocked(useAnalysisApp).getMockImplementation()?.();
  jest.mocked(useAnalysisApp).mockReturnValue({...app,isViewerVisible:()=>false} as never);render(<Harness />);
  expect(fireEvent.keyDown(document.body,space)).toBe(true);fireEvent.keyUp(document.body,space);
  fireEvent.keyDown(document.body,{key:"ArrowRight",code:"ArrowRight",ctrlKey:true});fireEvent.keyDown(document.body,{key:"q",code:"KeyQ"});
  expect(controls.toggleClock).not.toHaveBeenCalled();expect(controls.step).not.toHaveBeenCalled();expect(controls.gameClock.isPlaying).toBe(false);
});

it("plays and pauses with Space on a focused toolbar button without activating that button", () => {
  const { toggleClock } = setup();
  const onClick = jest.fn();
  render(<Harness onClick={onClick} />);
  const button = screen.getByRole("button", { name: "Playback speed" });
  act(() => button.focus());
  expect(fireEvent.keyDown(button, space)).toBe(false);
  expect(fireEvent.keyUp(button, space)).toBe(false);
  expect(toggleClock).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button);

  fireEvent.keyDown(button, space);
  fireEvent.keyUp(button, space);
  expect(toggleClock).toHaveBeenCalledTimes(2);
});

describe("Space in an export session", () => {
  it("Space previews the clip during an export session", () => {
    const { toggleClock, gameClock } = setup();
    const seekTo = jest.spyOn(gameClock, "seekTo");
    const start = jest.spyOn(gameClock, "start");
    render(<Harness />);
    act(() => {
      inspector.openExport();
      inspector.setExportRange({ startMs: 500, endMs: 1_500 });
    });
    act(() => gameClock.seekTo(1_500));
    seekTo.mockClear();

    // The playhead is at the range end: the preview starts again from the range start, bounded at its end.
    expect(fireEvent.keyDown(document.body, space)).toBe(false);
    fireEvent.keyUp(document.body, space);
    expect(seekTo).toHaveBeenCalledWith(500);
    expect(start).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(gameClock.playbackBoundaryInMs).toBe(1_500);
    expect(gameClock.isPlaying).toBe(true);
    expect(toggleClock).not.toHaveBeenCalled();

    // A second press pauses the preview.
    fireEvent.keyDown(document.body, space);
    fireEvent.keyUp(document.body, space);
    expect(gameClock.isPlaying).toBe(false);
    expect(toggleClock).not.toHaveBeenCalled();
  });

  it("Space still toggles the clock outside an export session", () => {
    const { toggleClock, gameClock } = setup();
    const start = jest.spyOn(gameClock, "start");
    render(<Harness />);
    act(() => {
      inspector.openExport();
      inspector.setExportRange({ startMs: 500, endMs: 1_500 });
    });
    act(() => inspector.closeMode());

    fireEvent.keyDown(document.body, space);
    fireEvent.keyUp(document.body, space);
    expect(toggleClock).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(gameClock.playbackBoundaryInMs).toBeUndefined();
  });
});

it("handles Space on the timeline while preserving its arrow keys and the replay surface shortcuts", () => {
  const { toggleClock, seekForward } = setup();
  render(<Harness />);
  const range = screen.getByRole("slider", { name: "Range" });
  expect(range.tagName).toBe("INPUT");
  expect(range.getAttribute("type")).toBe("range");
  act(() => range.focus());
  fireEvent.keyDown(range, space);
  fireEvent.keyUp(range, space);
  fireEvent.keyDown(range, { key: "ArrowRight", keyCode: 39, which: 39 });
  fireEvent.keyUp(range, { key: "ArrowRight", keyCode: 39, which: 39 });
  expect(toggleClock).toHaveBeenCalledTimes(1);
  expect(seekForward).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, space);
  fireEvent.keyUp(document.body, space);
  fireEvent.keyDown(document.body, { key: "ArrowRight", keyCode: 39, which: 39 });
  fireEvent.keyUp(document.body, { key: "ArrowRight", keyCode: 39, which: 39 });
  expect(toggleClock).toHaveBeenCalledTimes(2);
  expect(seekForward).toHaveBeenCalledWith(30);
});

it("leaves Space to text editing, dialogs and menus", () => {
  const { toggleClock } = setup();
  render(<Harness />);
  for (const target of [
    screen.getByRole("textbox", { name: "Time" }),
    screen.getByRole("textbox", { name: "Notes" }),
    screen.getByRole("button", { name: "Export" }),
    screen.getByRole("slider", { name: "Clip preview position" }),
    screen.getByRole("menuitem"),
    screen.getByRole("button", { name: "Settings tab" }),
  ]) {
    expect(fireEvent.keyDown(target, space)).toBe(true);
    expect(fireEvent.keyUp(target, space)).toBe(true);
  }
  expect(toggleClock).not.toHaveBeenCalled();
});

it.each(["surface", "toolbar", "timeline"])("steps one frame with Ctrl and an arrow key, with focus on the %s", (focus) => {
  const { seekBackward, seekForward } = setup();
  render(<Harness />);
  const target =
    focus === "toolbar"
      ? screen.getByRole("button", { name: "Playback speed" })
      : focus === "timeline"
      ? screen.getByRole("slider", { name: "Range" })
      : document.body;
  act(() => target.focus());
  for (const [key, keyCode, seek] of [
    ["ArrowLeft", 37, seekBackward],
    ["ArrowRight", 39, seekForward],
  ] as const) {
    const event = { key, code: key, keyCode, which: keyCode, ctrlKey: true };
    const allowedDefault = fireEvent.keyDown(target, event);
    fireEvent.keyUp(target, event);
    expect(seek.mock.calls).toEqual([[1]]);
    expect(allowedDefault).toBe(false);
  }
});

it("leaves the Ctrl frame-step keys to editors, dialogs and menus", () => {
  const { seekBackward, seekForward } = setup();
  render(<Harness />);
  for (const target of [
    screen.getByRole("textbox", { name: "Time" }),
    screen.getByRole("textbox", { name: "Notes" }),
    screen.getByRole("button", { name: "Export" }),
    screen.getByRole("slider", { name: "Clip preview position" }),
    screen.getByRole("menuitem"),
    screen.getByRole("button", { name: "Settings tab" }),
  ]) {
    for (const [key, keyCode] of [
      ["ArrowLeft", 37],
      ["ArrowRight", 39],
    ] as const) {
      const event = { key, code: key, keyCode, which: keyCode, ctrlKey: true };
      expect(fireEvent.keyDown(target, event)).toBe(true);
      fireEvent.keyUp(target, event);
    }
  }
  expect(seekBackward).not.toHaveBeenCalled();
  expect(seekForward).not.toHaveBeenCalled();
});

it("steps a frame with Ctrl and the arrow keys only, not with A / D on any layout, and stops on unmount", () => {
  const { seekBackward, seekForward } = setup();
  const { unmount } = render(<Harness />);
  const backward = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, ctrlKey: true };
  const forward = { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, ctrlKey: true };
  // The letters that used to alias the arrows, as typed on a Latin layout and on a Cyrillic one.
  const aliases = [
    { key: "a", code: "KeyA", keyCode: 65, which: 65, ctrlKey: true },
    { key: "d", code: "KeyD", keyCode: 68, which: 68, ctrlKey: true },
    { key: "ф", code: "KeyA", keyCode: 65, which: 65, ctrlKey: true },
    { key: "в", code: "KeyD", keyCode: 68, which: 68, ctrlKey: true },
  ];
  for (const alias of aliases) {
    // Not taken over either: Ctrl+A and Ctrl+D keep their default.
    expect(fireEvent.keyDown(document.body, alias)).toBe(true);
    fireEvent.keyUp(document.body, alias);
  }
  expect(seekBackward).not.toHaveBeenCalled();
  expect(seekForward).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, backward);
  fireEvent.keyDown(document.body, { ...backward, repeat: true });
  fireEvent.keyUp(document.body, backward);
  fireEvent.keyDown(document.body, forward);
  fireEvent.keyUp(document.body, forward);
  expect(seekBackward.mock.calls).toEqual([[1], [1]]);
  expect(seekForward.mock.calls).toEqual([[1]]);
  unmount();
  fireEvent.keyDown(document.body, backward);
  fireEvent.keyDown(document.body, forward);
  expect(seekBackward).toHaveBeenCalledTimes(2);
  expect(seekForward).toHaveBeenCalledTimes(1);
});

it("toggles once per press, ignores modified Space, and removes its listener on unmount", () => {
  const { toggleClock } = setup();
  const { unmount } = render(<Harness />);
  fireEvent.keyDown(document.body, { ...space, ctrlKey: true });
  fireEvent.keyUp(document.body, { ...space, ctrlKey: true });
  expect(toggleClock).not.toHaveBeenCalled();

  fireEvent.keyDown(document.body, space);
  fireEvent.keyDown(document.body, { ...space, repeat: true });
  fireEvent.keyDown(document.body, { ...space, repeat: true });
  fireEvent.keyUp(document.body, space);
  expect(toggleClock).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document.body, space);
  fireEvent.blur(window);
  fireEvent.keyDown(document.body, space);
  fireEvent.keyUp(document.body, space);
  expect(toggleClock).toHaveBeenCalledTimes(3);
  unmount();
  fireEvent.keyDown(document.body, space);
  fireEvent.keyUp(document.body, space);
  expect(toggleClock).toHaveBeenCalledTimes(3);
});

const keys = {
  arrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 },
  shiftArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, shiftKey: true },
  ctrlArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, ctrlKey: true },
  arrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 },
  arrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38 },
  arrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40 },
  f: { key: "f", code: "KeyF", keyCode: 70, which: 70 },
};

function press(event: Record<string, unknown>, target: Element = document.body) {
  fireEvent.keyDown(target, event);
  fireEvent.keyUp(target, event);
}

describe("without a loaded replay", () => {
  it.each(["idle", "loading", "failed"] as const)("Space does not start playback while %s", (phase) => {
    const { toggleClock } = setup({ phase });
    render(<Harness />);
    press(space);
    expect(toggleClock).not.toHaveBeenCalled();
  });

  it.each(["idle", "loading", "failed"] as const)("an arrow key does not seek while %s", (phase) => {
    const { seekBackward, seekForward } = setup({ phase });
    render(<Harness />);
    for (const event of [keys.arrowRight, keys.arrowLeft, keys.shiftArrowLeft, keys.ctrlArrowLeft]) press(event);
    expect(seekBackward).not.toHaveBeenCalled();
    expect(seekForward).not.toHaveBeenCalled();
  });

  it.each(["idle", "loading", "failed"] as const)("the speed keys do not change speed while %s", (phase) => {
    const { increaseSpeed, decreaseSpeed } = setup({ phase });
    render(<Harness />);
    for (const event of [keys.arrowUp, keys.arrowDown]) press(event);
    expect(increaseSpeed).not.toHaveBeenCalled();
    expect(decreaseSpeed).not.toHaveBeenCalled();
  });

  it.each(["idle", "loading", "failed"] as const)("F does not toggle Hidden while %s", (phase) => {
    const { setHidden } = setup({ phase });
    render(<Harness />);
    press(keys.f);
    expect(setHidden).not.toHaveBeenCalled();
  });

  it.each(["idle", "loading", "failed"] as const)("Ctrl+Arrow is not swallowed while %s", (phase) => {
    setup({ phase });
    render(<Harness />);
    expect(fireEvent.keyDown(document.body, keys.ctrlArrowLeft)).toBe(true);
  });

  it("Space is left for a focused button when no replay is loaded", () => {
    const { toggleClock } = setup({ phase: "idle" });
    const onClick = jest.fn();
    render(<Harness onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Playback speed" });
    act(() => button.focus());
    expect(fireEvent.keyDown(button, space)).toBe(true);
    expect(fireEvent.keyUp(button, space)).toBe(true);
    expect(toggleClock).not.toHaveBeenCalled();
  });

  it("acts again once the replay is ready, without re-mounting", () => {
    const { toggleClock, seekForward, increaseSpeed, setHidden, loadState$ } = setup({ phase: "loading" });
    render(<Harness />);
    for (const event of [space, keys.arrowRight, keys.arrowUp, keys.f]) press(event);
    expect(toggleClock).not.toHaveBeenCalled();
    expect(seekForward).not.toHaveBeenCalled();
    expect(increaseSpeed).not.toHaveBeenCalled();
    expect(setHidden).not.toHaveBeenCalled();

    act(() => loadState$.next({ phase: "ready" }));
    for (const event of [space, keys.arrowRight, keys.arrowUp, keys.f]) press(event);
    expect(toggleClock).toHaveBeenCalledTimes(1);
    expect(seekForward).toHaveBeenCalledWith(30);
    expect(increaseSpeed).toHaveBeenCalledTimes(1);
    expect(setHidden).toHaveBeenCalledWith(true);

    act(() => loadState$.next({ phase: "idle" }));
    press(space);
    expect(toggleClock).toHaveBeenCalledTimes(1);
  });
});

describe("steps", () => {
  it("asks for a nudge with an arrow key, a frame with Ctrl and a bar with Shift", () => {
    const { step } = setup();
    render(<Harness />);
    const shift = { key: "Shift", code: "ShiftLeft", keyCode: 16, which: 16, shiftKey: true };
    press({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 });
    press({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 });
    press({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, ctrlKey: true });
    // The hotkeys library follows the modifier's own key as well as the event's flag.
    fireEvent.keyDown(document.body, shift);
    press({ key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, shiftKey: true });
    press({ key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37, shiftKey: true });
    fireEvent.keyUp(document.body, { ...shift, shiftKey: false });
    expect(step.mock.calls).toEqual([
      ["nudge", 1],
      ["nudge", -1],
      ["frame", -1],
      ["bar", 1],
      ["bar", -1],
    ]);
  });
});

describe("with the Keyboard shortcuts dialog open", () => {
  const q = { key: "q", code: "KeyQ", keyCode: 81, which: 81 };

  it("runs none of the listed shortcuts on the replay behind it, whatever has the focus", () => {
    const { toggleClock, step, increaseSpeed, decreaseSpeed, setHidden, gameClock } = setup();
    const hold = jest.spyOn(gameClock, "holdSpeed");
    render(
      <>
        <Harness />
        <HelpModalDialog isOpen onClose={() => undefined} />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const targets = [
      dialog,
      within(dialog).getByRole("button", { name: "Close" }),
      dialog.firstElementChild as Element,
      // The modal's own root, where the focus can rest.
      dialog.parentElement as Element,
    ];
    for (const target of targets) {
      // Space (a window handler), Q (held), the arrows and F (the hotkeys), and Ctrl + arrows (a window handler).
      const events = [
        space,
        q,
        keys.f,
        keys.arrowUp,
        keys.arrowDown,
        keys.arrowLeft,
        keys.arrowRight,
        keys.shiftArrowLeft,
        keys.ctrlArrowLeft,
        { ...keys.ctrlArrowLeft, key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39 },
      ];
      for (const event of events) press(event, target);
    }
    expect(toggleClock).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(increaseSpeed).not.toHaveBeenCalled();
    expect(decreaseSpeed).not.toHaveBeenCalled();
    expect(setHidden).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it("does not swallow Escape, which closes the dialog", () => {
    setup();
    const onClose = jest.fn();
    render(
      <>
        <Harness />
        <HelpModalDialog isOpen onClose={onClose} />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" })).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the keys to the app once it is closed", () => {
    const { toggleClock } = setup();
    const view = render(
      <>
        <Harness />
        <HelpModalDialog isOpen onClose={() => undefined} />
      </>,
    );
    press(space, screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
    expect(toggleClock).not.toHaveBeenCalled();
    view.rerender(
      <InspectorProvider>
        <InspectorProbe />
        <Harness />
        <HelpModalDialog isOpen={false} onClose={() => undefined} />
      </InspectorProvider>,
    );
    press(space);
    expect(toggleClock).toHaveBeenCalledTimes(1);
  });
});

describe("W / A / S / D", () => {
  const letter = (key: string) => ({
    key,
    code: "Key" + key.toUpperCase(),
    keyCode: key.toUpperCase().charCodeAt(0),
    which: key.toUpperCase().charCodeAt(0),
  });
  const withModifiers = (event: Record<string, unknown>) => [
    event,
    { ...event, ctrlKey: true },
    { ...event, shiftKey: true },
    { ...event, key: String(event.key).toUpperCase(), shiftKey: true },
  ];

  it("A and D no longer nudge, step a frame or a bar, alone, with Ctrl or with Shift", () => {
    const { step, seekBackward, seekForward } = setup();
    render(<Harness />);
    for (const key of ["a", "d"]) for (const event of withModifiers(letter(key))) press(event);
    expect(step).not.toHaveBeenCalled();
    expect(seekBackward).not.toHaveBeenCalled();
    expect(seekForward).not.toHaveBeenCalled();
  });

  it("W and S no longer change the speed, alone, with Ctrl or with Shift", () => {
    const { increaseSpeed, decreaseSpeed } = setup();
    render(<Harness />);
    for (const key of ["w", "s"]) for (const event of withModifiers(letter(key))) press(event);
    expect(increaseSpeed).not.toHaveBeenCalled();
    expect(decreaseSpeed).not.toHaveBeenCalled();
  });

  it("the arrow keys still do what they did", () => {
    const { step, increaseSpeed, decreaseSpeed } = setup();
    render(<Harness />);
    for (const event of [keys.arrowUp, keys.arrowDown, keys.arrowLeft, keys.arrowRight]) press(event);
    expect(increaseSpeed).toHaveBeenCalledTimes(1);
    expect(decreaseSpeed).toHaveBeenCalledTimes(1);
    expect(step.mock.calls).toEqual([
      ["nudge", -1],
      ["nudge", 1],
    ]);
  });
});

describe("holding Q", () => {
  const q = { key: "q", code: "KeyQ", keyCode: 81, which: 81 };

  it("plays at the held speed while the key is down and gives the viewer's speed back when it is let go", () => {
    const { gameClock } = setup();
    gameClock.setSpeed(1.5);
    render(<Harness />);
    fireEvent.keyDown(document.body, q);
    expect(gameClock.speed).toBe(0.5);
    // The key repeats while it is held.
    fireEvent.keyDown(document.body, { ...q, repeat: true });
    expect(gameClock.speed).toBe(0.5);
    fireEvent.keyUp(document.body, q);
    expect(gameClock.speed).toBe(1.5);
  });

  it("reads the speed from the settings at each press, and is the same key on another layout", () => {
    const { gameClock, playbarSettings } = setup();
    render(<Harness />);
    playbarSettings.holdSpeed = 0.25;
    // On AZERTY the key in Q's place types an "a".
    fireEvent.keyDown(document.body, { key: "a", code: "KeyQ" });
    expect(gameClock.speed).toBe(0.25);
    fireEvent.keyUp(document.body, { key: "a", code: "KeyQ" });
    expect(gameClock.speed).toBe(1);
  });

  it("gives the speed back when the window loses focus, and when the shortcuts go away", () => {
    const { gameClock } = setup();
    const view = render(<Harness />);
    fireEvent.keyDown(document.body, q);
    fireEvent.blur(window);
    expect(gameClock.speed).toBe(1);
    fireEvent.keyDown(document.body, q);
    view.unmount();
    expect(gameClock.speed).toBe(1);
  });

  it("lets a speed chosen during the hold stay", () => {
    const { gameClock } = setup();
    render(<Harness />);
    fireEvent.keyDown(document.body, q);
    gameClock.setSpeed(0.75);
    fireEvent.keyUp(document.body, q);
    expect(gameClock.speed).toBe(0.75);
  });

  it("does nothing in a text field, with a modifier, without a replay, or while something plays to its own boundary", () => {
    const { gameClock, loadState$ } = setup();
    render(<Harness />);
    fireEvent.keyDown(screen.getByLabelText("Time"), q);
    fireEvent.keyDown(document.body, { ...q, ctrlKey: true });
    fireEvent.keyDown(document.body, { ...q, shiftKey: true });
    expect(gameClock.speed).toBe(1);
    // An incident replay or a clip preview has set a boundary and borrowed the speed.
    gameClock.setPlaybackBoundary(1_500);
    fireEvent.keyDown(document.body, q);
    expect(gameClock.speed).toBe(1);
    gameClock.setPlaybackBoundary(undefined);
    act(() => loadState$.next({ phase: "loading" }));
    fireEvent.keyDown(document.body, q);
    expect(gameClock.speed).toBe(1);
  });

  it("does nothing while a clip is exporting", () => {
    const { gameClock } = setup();
    render(<Harness />);
    jest.mocked(useAnalysisApp).mock.results.slice(-1)[0].value.clipRecorder.isBusy = true;
    fireEvent.keyDown(document.body, q);
    expect(gameClock.speed).toBe(1);
  });
});
