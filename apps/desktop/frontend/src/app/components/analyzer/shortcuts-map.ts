import { REWIND_COLORS } from "../../styles/tokens";
import { NUDGE_STEP_MS, type ScrollStep } from "../../services/common/playback-steps";

/**
 * Every shortcut the Keyboard shortcuts dialog shows, in one table. The lit keys, the list and the live highlighting
 * are all read from it, so they cannot disagree. Keys are named by `KeyboardEvent.code`: the picture follows the
 * physical key, whatever the layout types. `Wheel` and `MouseRight` are the two parts of the drawn mouse.
 */

export type ShortcutGroup = "playback" | "step" | "timeline" | "replay";
/** The groups' colours, and the neutral one of the modifier keys. */
export type KeyGroup = ShortcutGroup | "mod";
export type Modifier = "Control" | "Shift" | "Alt";

export const GROUP_COLORS: Readonly<Record<KeyGroup, string>> = {
  playback: REWIND_COLORS.key1,
  step: REWIND_COLORS.judgement300,
  timeline: REWIND_COLORS.sliderBreak,
  replay: REWIND_COLORS.key2,
  mod: REWIND_COLORS.textPrimary,
};

export const GROUP_TITLES: Readonly<Record<ShortcutGroup, string>> = {
  playback: "Playback",
  step: "Step back / forward",
  timeline: "Timeline",
  replay: "Replay",
};

export const GROUP_ORDER: readonly ShortcutGroup[] = ["playback", "step", "timeline", "replay"];

export const MODIFIER_CODES: Readonly<Record<Modifier, readonly string[]>> = {
  Control: ["ControlLeft", "ControlRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Alt: ["AltLeft", "AltRight"],
};

export const modifierOf = (code: string): Modifier | undefined =>
  (Object.keys(MODIFIER_CODES) as Modifier[]).find((modifier) => MODIFIER_CODES[modifier].includes(code));

/** One piece of a row's keycaps: a key, a plus between a modifier and what it changes, or a gap between two ways. */
export type Cap = { kind: "key"; text: string } | { kind: "plus" } | { kind: "or" };
const key = (text: string): Cap => ({ kind: "key", text });
const PLUS: Cap = { kind: "plus" };
const OR: Cap = { kind: "or" };

export interface Binding {
  /** The row's id. */
  row: string;
  group: ShortcutGroup;
  label: string;
  /** The keys (or mouse parts) the row is bound to. */
  keys: readonly string[];
  /** The modifier the row needs, if any. */
  mod?: Modifier;
  caps: readonly Cap[];
}

/** The wheel's row steps by the Scroll step setting: a note for Auto, otherwise the chosen division as the setting shows it. */
export const noteLabel = (scrollStep: ScrollStep): string => (scrollStep === "auto" ? "One note" : scrollStep);

export const BINDINGS: readonly Binding[] = [
  { row: "play", group: "playback", label: "Play / pause", keys: ["Space"], caps: [key("Space")] },
  { row: "speed", group: "playback", label: "Slower / faster", keys: ["ArrowDown", "ArrowUp"], caps: [key("↓"), key("↑")] },
  { row: "slow", group: "playback", label: "Slow while held", keys: ["KeyQ"], caps: [key("Q")] },
  { row: "nudge", group: "step", label: `${NUDGE_STEP_MS} ms`, keys: ["ArrowLeft", "ArrowRight"], caps: [key("←"), key("→")] },
  { row: "note", group: "step", label: noteLabel("auto"), keys: ["Wheel"], caps: [key("Wheel")] },
  {
    row: "frame",
    group: "step",
    label: "One frame",
    mod: "Control",
    keys: ["ArrowLeft", "ArrowRight", "Wheel"],
    caps: [key("Ctrl"), PLUS, key("←"), key("→"), OR, key("Wheel")],
  },
  {
    row: "bar",
    group: "step",
    label: "One bar",
    mod: "Shift",
    keys: ["ArrowLeft", "ArrowRight", "Wheel"],
    caps: [key("Shift"), PLUS, key("←"), key("→"), OR, key("Wheel")],
  },
  { row: "zoom", group: "timeline", label: "Zoom here", keys: ["MouseRight"], caps: [key("Right-click")] },
  { row: "stretch", group: "timeline", label: "Pick a stretch", keys: ["MouseRight"], caps: [key("Right-drag")] },
  { row: "length", group: "timeline", label: "Longer / shorter", mod: "Alt", keys: ["Wheel"], caps: [key("Alt"), PLUS, key("Wheel")] },
  { row: "whole", group: "timeline", label: "Whole map", keys: ["Escape"], caps: [key("Esc")] },
  { row: "open", group: "replay", label: "Open replay", keys: ["F2"], caps: [key("F2")] },
  { row: "hidden", group: "replay", label: "Hidden on / off", keys: ["KeyF"], caps: [key("F")] },
  { row: "shot", group: "replay", label: "Screenshot", keys: ["F12"], caps: [key("F12")] },
];

/** The keys that take part in a shortcut: code -> the legend drawn on the cap and the group it is lit in. */
export const USED_KEYS: Readonly<Record<string, { legend: string; group: KeyGroup }>> = {
  Escape: { legend: "Esc", group: "timeline" },
  F2: { legend: "F2", group: "replay" },
  F12: { legend: "F12", group: "replay" },
  KeyQ: { legend: "Q", group: "playback" },
  KeyF: { legend: "F", group: "replay" },
  Space: { legend: "Space", group: "playback" },
  ArrowUp: { legend: "↑", group: "playback" },
  ArrowDown: { legend: "↓", group: "playback" },
  ArrowLeft: { legend: "←", group: "step" },
  ArrowRight: { legend: "→", group: "step" },
  ShiftLeft: { legend: "Shift", group: "mod" },
  ShiftRight: { legend: "Shift", group: "mod" },
  ControlLeft: { legend: "Ctrl", group: "mod" },
  ControlRight: { legend: "Ctrl", group: "mod" },
  AltLeft: { legend: "Alt", group: "mod" },
  AltRight: { legend: "Alt", group: "mod" },
};

/** The two drawn parts of the mouse that take part in a shortcut, and the group each is lit in. */
export const MOUSE_PARTS: Readonly<Record<string, KeyGroup>> = { Wheel: "step", MouseRight: "timeline" };

// ---- the drawn keyboard (75% layout) ------------------------------------------------------------------------------

/** One key pitch and the gap between two keys, in px. */
export const KEY_UNIT = 40;
export const KEY_GAP = 4;

export interface PlacedKey {
  code: string;
  /** Left edge, row and width, in key units. */
  x: number;
  row: number;
  width: number;
}

const letters = (text: string): Array<[string, number]> => text.split("").map((letter) => ["Key" + letter, 1]);
// Each row: [code, width in units], or a number for a gap.
const ROWS: ReadonlyArray<ReadonlyArray<[string, number] | number>> = [
  [["Escape", 1], 1, ["F1", 1], ["F2", 1], ["F3", 1], ["F4", 1], 0.5, ["F5", 1], ["F6", 1], ["F7", 1], ["F8", 1], 0.5, ["F9", 1], ["F10", 1], ["F11", 1], ["F12", 1]],
  [["Backquote", 1], ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((digit): [string, number] => ["Digit" + digit, 1]), ["Minus", 1], ["Equal", 1], ["Backspace", 2]],
  [["Tab", 1.5], ...letters("QWERTYUIOP"), ["BracketLeft", 1], ["BracketRight", 1], ["Backslash", 1.5]],
  [["CapsLock", 1.75], ...letters("ASDFGHJKL"), ["Semicolon", 1], ["Quote", 1], ["Enter", 2.25]],
  [["ShiftLeft", 2.25], ...letters("ZXCVBNM"), ["Comma", 1], ["Period", 1], ["Slash", 1], ["ShiftRight", 2.75]],
  [["ControlLeft", 1.25], ["MetaLeft", 1.25], ["AltLeft", 1.25], ["Space", 6.25], ["AltRight", 1.25], ["MetaRight", 1.25], ["ContextMenu", 1.25], ["ControlRight", 1.25]],
];

export const BOARD_KEYS: readonly PlacedKey[] = [
  ...ROWS.flatMap((row, index) => {
    let x = 0;
    const placed: PlacedKey[] = [];
    for (const item of row) {
      if (typeof item === "number") x += item;
      else {
        placed.push({ code: item[0], x, row: index, width: item[1] });
        x += item[1];
      }
    }
    return placed;
  }),
  // The arrow cluster, in the bottom right.
  { code: "ArrowUp", x: 16.5, row: 4, width: 1 },
  { code: "ArrowLeft", x: 15.5, row: 5, width: 1 },
  { code: "ArrowDown", x: 16.5, row: 5, width: 1 },
  { code: "ArrowRight", x: 17.5, row: 5, width: 1 },
];

/** A little air under the function row. */
export const rowTop = (row: number): number => row * KEY_UNIT + (row > 0 ? 10 : 0);
export const BOARD_WIDTH = 18.5 * KEY_UNIT - KEY_GAP;
export const BOARD_HEIGHT = rowTop(5) + KEY_UNIT - KEY_GAP;

// ---- what is lit ----------------------------------------------------------------------------------------------------

export interface LiveState {
  /** A modifier key held down. */
  heldMod?: Modifier;
  /** A modifier key under the pointer. */
  hoverMod?: Modifier;
  hoverKey?: string;
  hoverRow?: string;
  /** The codes of the keys held down, in the order they went down. */
  pressed: readonly string[];
  /** The mouse part that has just moved or been pressed. */
  flash?: string;
}

export interface Highlight {
  /** A modifier is held or hovered: only what it takes part in stays lit. */
  layer: boolean;
  rows: ReadonlySet<string>;
  /** Code -> the colour it is lit in; null for a key that has no shortcut and so only shows as pressed. */
  keys: ReadonlyMap<string, string | null>;
}

/**
 * What to light for a state. A modifier (held or hovered) makes a layer: only the rows that need it, and their keys.
 * A key (pressed, hovered or just flashed) narrows that to the rows it takes part in. With neither, a hovered row
 * lights its own keys and its modifier.
 */
export function computeHighlight(state: LiveState): Highlight {
  const mod = state.heldMod ?? state.hoverMod;
  const key = state.hoverKey ?? state.pressed.find((code) => !modifierOf(code)) ?? state.flash;
  const rows = new Set<string>();
  const keys = new Map<string, string | null>();
  const lightModifier = (modifier: Modifier) => {
    for (const code of MODIFIER_CODES[modifier]) keys.set(code, GROUP_COLORS.mod);
  };

  if (state.hoverRow && !mod && !key) {
    const binding = BINDINGS.find((candidate) => candidate.row === state.hoverRow);
    if (binding) {
      rows.add(binding.row);
      for (const code of binding.keys) keys.set(code, GROUP_COLORS[binding.group]);
      if (binding.mod) lightModifier(binding.mod);
    }
  } else if (mod || key) {
    const candidates = mod ? BINDINGS.filter((binding) => binding.mod === mod) : BINDINGS;
    const matches = key ? candidates.filter((binding) => binding.keys.includes(key)) : candidates;
    for (const binding of matches) {
      rows.add(binding.row);
      for (const code of binding.keys) if (!key || code === key) keys.set(code, GROUP_COLORS[binding.group]);
    }
    if (mod) lightModifier(mod);
    else if (matches.length === 1 && matches[0].mod) lightModifier(matches[0].mod);
    if (key && !keys.has(key)) keys.set(key, null);
  }
  return { layer: Boolean(mod), rows, keys };
}
