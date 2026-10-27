import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { useCommonManagers } from "../../providers/TheaterProvider";
import type { ScrollStep } from "../../services/common/playback-steps";
import { NUDGE_STEP_MS } from "../../services/common/playback-steps";
import { HelpModalDialog } from "./HelpModal";

jest.mock("../../providers/TheaterProvider", () => ({ useCommonManagers: jest.fn() }));

let scrollStep$: BehaviorSubject<{ scrollStep: ScrollStep }>;
let view: ReturnType<typeof render>;

function open(onClose: () => void = () => undefined) {
  scrollStep$ = new BehaviorSubject<{ scrollStep: ScrollStep }>({ scrollStep: "auto" });
  jest.mocked(useCommonManagers).mockReturnValue({
    playbarSettingsStore: { settings$: scrollStep$, get settings() { return scrollStep$.getValue(); } },
  } as never);
  view = render(<HelpModalDialog isOpen onClose={onClose} />);
  return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
}

const keyOf = (dialog: HTMLElement, code: string) => dialog.querySelector(`[data-code="${code}"]`) as HTMLElement;
const rowOf = (dialog: HTMLElement, id: string) => dialog.querySelector(`[data-row="${id}"]`) as HTMLElement;
const hot = (element: Element) => element.getAttribute("data-hot") === "true";
const hotKeys = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll("[data-code]")).filter(hot).map((element) => element.getAttribute("data-code"));
const hotRows = (dialog: HTMLElement) =>
  Array.from(dialog.querySelectorAll("[data-row]")).filter(hot).map((element) => element.getAttribute("data-row"));
const caps = (row: HTMLElement) => Array.from(row.querySelectorAll("kbd")).map((cap) => cap.textContent);
const actionOf = (row: HTMLElement) => row.querySelector("[data-part=action]")?.textContent;

const down = (code: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { code, key: code, ...init });
const up = (code: string, init: KeyboardEventInit = {}) => fireEvent.keyUp(window, { code, key: code, ...init });

afterEach(() => jest.useRealTimers());

describe("the dialog", () => {
  it("is named Keyboard shortcuts, with that heading, a hint and a Close button, and nothing else around the content", () => {
    const dialog = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeTruthy();
    expect(dialog.textContent).toContain("Press a key, or hold Ctrl, Shift or Alt");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
    // No footer: no version, no credit, no links, no Discord; no Help icon and no divider.
    expect(dialog.textContent).not.toMatch(/based on rewind|osu! university|abstrakt|hindsight \d|discord/i);
    expect(dialog.querySelectorAll("a, hr")).toHaveLength(0);
    expect(dialog.querySelector('[data-testid="HelpIcon"]')).toBeNull();
    expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  });

  it("calls onClose from the Close button, and on Escape without swallowing it", () => {
    const onClose = jest.fn();
    const dialog = open(onClose);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const notPrevented = fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(notPrevented).toBe(true);
  });

  it("draws the keyboard and the mouse hidden from assistive technology, and keeps the list readable", () => {
    const dialog = open();
    const well = keyOf(dialog, "Space").closest("[aria-hidden=true]") as HTMLElement;
    expect(well).not.toBeNull();
    expect(well.contains(keyOf(dialog, "Wheel"))).toBe(true);
    expect(well.contains(rowOf(dialog, "play"))).toBe(false);
    expect(rowOf(dialog, "play").closest("[aria-hidden=true]")).toBeNull();
  });
});

describe("the list", () => {
  const ROWS: Array<[string, string, string[]]> = [
    ["play", "Play / pause", ["Space"]],
    ["speed", "Slower / faster", ["↓", "↑"]],
    ["slow", "Slow while held", ["Q"]],
    ["nudge", `${NUDGE_STEP_MS} ms`, ["←", "→"]],
    ["note", "One note", ["Wheel"]],
    ["frame", "One frame", ["Ctrl", "←", "→", "Wheel"]],
    ["bar", "One bar", ["Shift", "←", "→", "Wheel"]],
    ["zoom", "Zoom here", ["Right-click"]],
    ["stretch", "Pick a stretch", ["Right-drag"]],
    ["length", "Longer / shorter", ["Alt", "Wheel"]],
    ["whole", "Whole map", ["Esc"]],
    ["open", "Open replay", ["F2"]],
    ["hidden", "Hidden on / off", ["F"]],
    ["shot", "Screenshot", ["F12"]],
  ];

  it.each(ROWS)("has the row %s: %s with its keycaps", (id, action, keycaps) => {
    const dialog = open();
    const row = rowOf(dialog, id);
    expect(actionOf(row)).toBe(action);
    expect(caps(row)).toEqual(keycaps);
  });

  it("sets the rows in four columns, one per group, each headed by its name", () => {
    const dialog = open();
    const groups = Array.from(dialog.querySelectorAll("section")).map((section) => [
      section.querySelector("h2")?.textContent,
      Array.from(section.querySelectorAll("[data-row]")).map((row) => row.getAttribute("data-row")),
    ]);
    expect(groups).toEqual([
      ["Playback", ["play", "speed", "slow"]],
      ["Step back / forward", ["nudge", "note", "frame", "bar"]],
      ["Timeline", ["zoom", "stretch", "length", "whole"]],
      ["Replay", ["open", "hidden", "shot"]],
    ]);
  });

  it("has no W, A, S or D anywhere: not in the list, and no lit or lettered key for them", () => {
    const dialog = open();
    for (const cap of Array.from(dialog.querySelectorAll("kbd"))) expect(cap.textContent).not.toMatch(/^[wasd]$/i);
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
      const key = keyOf(dialog, code);
      expect([code, key.textContent, key.getAttribute("data-used")]).toEqual([code, "", "false"]);
    }
    expect(dialog.textContent).not.toMatch(/\bA \/ D\b|\bW \/ S\b/);
  });

  it("follows the Scroll step setting in the wheel's row: One note for Auto, the chosen step otherwise", () => {
    const dialog = open();
    expect(actionOf(rowOf(dialog, "note"))).toBe("One note");
    act(() => scrollStep$.next({ scrollStep: "1/4" }));
    expect(actionOf(rowOf(dialog, "note"))).toBe("1/4");
    act(() => scrollStep$.next({ scrollStep: "auto" }));
    expect(actionOf(rowOf(dialog, "note"))).toBe("One note");
  });
});

describe("the keyboard", () => {
  it("lights only the keys that take part in a shortcut, and gives each its legend", () => {
    const dialog = open();
    const lit = Array.from(dialog.querySelectorAll("[data-used=true]")).map((element) => [
      element.getAttribute("data-code"),
      element.textContent,
      element.getAttribute("data-group"),
    ]);
    expect(lit).toEqual(
      expect.arrayContaining([
        ["Escape", "Esc", "timeline"],
        ["F12", "F12", "replay"],
        ["KeyQ", "Q", "playback"],
        ["KeyF", "F", "replay"],
        ["F2", "F2", "replay"],
        ["Space", "Space", "playback"],
        ["ArrowUp", "↑", "playback"],
        ["ArrowDown", "↓", "playback"],
        ["ArrowLeft", "←", "step"],
        ["ArrowRight", "→", "step"],
        ["ControlLeft", "Ctrl", "mod"],
        ["ControlRight", "Ctrl", "mod"],
        ["ShiftLeft", "Shift", "mod"],
        ["ShiftRight", "Shift", "mod"],
        ["AltLeft", "Alt", "mod"],
        ["AltRight", "Alt", "mod"],
        ["Wheel", "", "step"],
        ["MouseRight", "", "timeline"],
      ]),
    );
    expect(lit).toHaveLength(18);
    // Every other key is a blank cap.
    expect(keyOf(dialog, "KeyZ").textContent).toBe("");
    expect(keyOf(dialog, "KeyO").getAttribute("data-used")).toBe("false");
    expect(keyOf(dialog, "KeyO").textContent).toBe("");
    expect(keyOf(dialog, "F5").textContent).toBe("");
    expect(dialog.querySelectorAll("[data-code]").length).toBeGreaterThanOrEqual(78);
  });
});

describe("live highlighting", () => {
  it("lights the key and its row while a key is down, shifts the key, and clears on release", () => {
    const dialog = open();
    expect(hotKeys(dialog)).toEqual([]);
    down("Space");
    expect(hotKeys(dialog)).toEqual(["Space"]);
    expect(keyOf(dialog, "Space").getAttribute("data-down")).toBe("true");
    expect(hotRows(dialog)).toEqual(["play"]);
    expect(dialog.getAttribute("data-layer")).toBe("false");
    up("Space");
    expect(hotKeys(dialog)).toEqual([]);
    expect(hotRows(dialog)).toEqual([]);
    expect(keyOf(dialog, "Space").getAttribute("data-down")).toBe("false");
  });

  it("lights nothing for a key that has no shortcut, W A S D included", () => {
    const dialog = open();
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "KeyZ", "KeyO"]) {
      down(code);
      expect([code, hotKeys(dialog), hotRows(dialog)]).toEqual([code, [], []]);
      up(code);
    }
  });

  it("lights every arrow-key row and only the Open replay row for F2", () => {
    const dialog = open();
    down("ArrowLeft");
    expect(hotRows(dialog)).toEqual(["nudge", "frame", "bar"]);
    up("ArrowLeft");
    down("F2");
    expect(hotRows(dialog)).toEqual(["open"]);
    expect(hotKeys(dialog)).toEqual(["F2"]);
  });

  it("holds a layer while Control is down: only the keys and rows it takes part in stay lit", () => {
    const dialog = open();
    down("ControlLeft", { ctrlKey: true });
    expect(dialog.getAttribute("data-layer")).toBe("true");
    expect(hotRows(dialog)).toEqual(["frame"]);
    expect(hotKeys(dialog).sort()).toEqual(
      ["ArrowLeft", "ArrowRight", "ControlLeft", "ControlRight", "Wheel"].sort(),
    );
    up("ControlLeft");
    expect(dialog.getAttribute("data-layer")).toBe("false");
    expect(hotRows(dialog)).toEqual([]);
    expect(hotKeys(dialog)).toEqual([]);
  });

  it.each([
    ["Shift", "ShiftRight", ["bar"]],
    ["Alt", "AltLeft", ["length"]],
  ])("holds a layer for %s", (_name, code, rows) => {
    const dialog = open();
    down(code);
    expect(dialog.getAttribute("data-layer")).toBe("true");
    expect(hotRows(dialog)).toEqual(rows);
    up(code);
    expect(dialog.getAttribute("data-layer")).toBe("false");
  });

  it("narrows the layer to the key pressed while the modifier is held", () => {
    const dialog = open();
    down("ControlLeft");
    down("ArrowLeft");
    expect(hotRows(dialog)).toEqual(["frame"]);
    expect(hotKeys(dialog).sort()).toEqual(["ArrowLeft", "ControlLeft", "ControlRight"]);
  });

  it("ends the layer and the pressed keys when the window loses the focus", () => {
    const dialog = open();
    down("ControlLeft");
    down("Space");
    expect(dialog.getAttribute("data-layer")).toBe("true");
    fireEvent.blur(window);
    expect(dialog.getAttribute("data-layer")).toBe("false");
    expect(hotKeys(dialog)).toEqual([]);
    expect(hotRows(dialog)).toEqual([]);
  });

  it("lights a row's keys when it is hovered, with its modifier key, and the rows of a hovered key", () => {
    const dialog = open();
    fireEvent.mouseEnter(rowOf(dialog, "speed"));
    expect(hotRows(dialog)).toEqual(["speed"]);
    expect(hotKeys(dialog).sort()).toEqual(["ArrowDown", "ArrowUp"]);
    fireEvent.mouseLeave(rowOf(dialog, "speed"));
    expect(hotKeys(dialog)).toEqual([]);

    fireEvent.mouseEnter(rowOf(dialog, "open"));
    expect(hotKeys(dialog)).toEqual(["F2"]);
    fireEvent.mouseLeave(rowOf(dialog, "open"));

    fireEvent.mouseEnter(keyOf(dialog, "KeyF"));
    expect(hotRows(dialog)).toEqual(["hidden"]);
    fireEvent.mouseLeave(keyOf(dialog, "KeyF"));
    expect(hotRows(dialog)).toEqual([]);
  });

  it("makes hovering a modifier key a layer too", () => {
    const dialog = open();
    fireEvent.mouseEnter(keyOf(dialog, "AltRight"));
    expect(dialog.getAttribute("data-layer")).toBe("true");
    expect(hotRows(dialog)).toEqual(["length"]);
    fireEvent.mouseLeave(keyOf(dialog, "AltRight"));
    expect(dialog.getAttribute("data-layer")).toBe("false");
  });

  it("flashes the wheel and its rows for a moment when the wheel turns, and the right button when it is pressed", () => {
    jest.useFakeTimers();
    const dialog = open();
    fireEvent.wheel(window, { deltaY: 100 });
    expect(hot(keyOf(dialog, "Wheel"))).toBe(true);
    expect(hotRows(dialog)).toEqual(["note", "frame", "bar", "length"]);
    act(() => void jest.advanceTimersByTime(400));
    expect(hotKeys(dialog)).toEqual([]);
    expect(hotRows(dialog)).toEqual([]);

    fireEvent.mouseDown(window, { button: 2 });
    expect(hot(keyOf(dialog, "MouseRight"))).toBe(true);
    expect(hotRows(dialog)).toEqual(["zoom", "stretch"]);
    act(() => void jest.advanceTimersByTime(400));
    expect(hotKeys(dialog)).toEqual([]);
    // The left button is not a shortcut.
    fireEvent.mouseDown(window, { button: 0 });
    expect(hotKeys(dialog)).toEqual([]);
  });

  it("matches by the physical key (event.code), not by what the layout types", () => {
    const dialog = open();
    fireEvent.keyDown(window, { code: "KeyF", key: "а" });
    expect(hot(keyOf(dialog, "KeyF"))).toBe(true);
    expect(hotRows(dialog)).toEqual(["hidden"]);
  });

  it("stops listening when it closes", () => {
    const dialog = open();
    const removed = jest.spyOn(window, "removeEventListener");
    view.unmount();
    const types = removed.mock.calls.map(([type]) => type);
    for (const type of ["keydown", "keyup", "wheel", "mousedown", "blur"]) expect(types).toContain(type);
    removed.mockRestore();
    // Nothing is left to react to the keys.
    expect(() => down("Space")).not.toThrow();
    expect(dialog.isConnected).toBe(false);
  });
});

describe("the dialog only shows", () => {
  it("prevents the default of Space and the arrows (nothing scrolls), but not on a button, and never on Escape", () => {
    const dialog = open();
    for (const code of ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect([code, fireEvent.keyDown(dialog, { code, key: code })]).toEqual([code, false]);
    }
    const close = within(dialog).getByRole("button", { name: "Close" });
    for (const code of ["Space", "ArrowLeft", "Enter"]) {
      expect([code, fireEvent.keyDown(close, { code, key: code })]).toEqual([code, true]);
    }
    expect(fireEvent.keyDown(dialog, { code: "Escape", key: "Escape" })).toBe(true);
    expect(fireEvent.keyDown(dialog, { code: "KeyQ", key: "q" })).toBe(true);
  });

  it("still lights a key pressed on the Close button", () => {
    const dialog = open();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Close" }), { code: "Space", key: " " });
    expect(hot(keyOf(dialog, "Space"))).toBe(true);
  });
});

describe("F12", () => {
  it("lights its key here and marks the dialog as the one place that takes no screenshot", () => {
    const dialog = open();
    expect(dialog.hasAttribute("data-screenshot-blocked")).toBe(true);
    down("F12");
    expect(hot(keyOf(dialog, "F12"))).toBe(true);
    expect(hotRows(dialog)).toEqual(["shot"]);
  });
});

describe("size", () => {
  const resize = (width: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    fireEvent(window, new Event("resize"));
  };
  const original = window.innerWidth;
  afterEach(() => resize(original));

  it("is 980px wide, at full size when the window leaves 16px each side, and whole at 1000px", () => {
    resize(1012);
    const dialog = open();
    expect(dialog.getAttribute("data-scale")).toBe("1");
    expect(getComputedStyle(dialog.firstElementChild as Element).width).toBe("980px");
    // At 1000px it is scaled by a hair, so that all of it shows.
    resize(1000);
    expect(Number(dialog.getAttribute("data-scale"))).toBeCloseTo(968 / 980, 4);
  });

  it("scales the whole dialog down to fit the window less 32px, and back", () => {
    resize(800);
    const dialog = open();
    expect(Number(dialog.getAttribute("data-scale"))).toBeCloseTo((800 - 32) / 980, 4);
    resize(500);
    expect(Number(dialog.getAttribute("data-scale"))).toBeCloseTo((500 - 32) / 980, 4);
    resize(1400);
    expect(dialog.getAttribute("data-scale")).toBe("1");
  });
});
