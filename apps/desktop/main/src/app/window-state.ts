import type { BrowserWindow, Rectangle } from "electron";
import type { EventEmitter } from "events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export const WINDOW_STATE_FILE = "window-state.json";
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 600;
const SAVE_DELAY_MS = 500;

export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

export interface RestoredWindowState {
  state: WindowState;
  minWidth: number;
  minHeight: number;
}

function validBounds(value: unknown): value is Rectangle {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Rectangle;
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
  );
}

function copyBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

export function readWindowState(file: string): WindowState | undefined {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data?.version !== 1 || typeof data.maximized !== "boolean" || !validBounds(data.bounds)) return undefined;
    return { bounds: copyBounds(data.bounds), maximized: data.maximized };
  } catch {
    // Missing, corrupt or inaccessible preferences must not prevent startup.
    return undefined;
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, bounds: state.bounds, maximized: state.maximized }), "utf8");
  renameSync(temporary, file);
}

function overlap(a: Rectangle, b: Rectangle): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  );
}

/** All Electron display and window rectangles here are logical DIP coordinates. */
export function restoreWindowState(
  saved: WindowState | undefined,
  workAreas: readonly Rectangle[],
  primaryWorkArea: Rectangle,
): RestoredWindowState {
  const primary = validBounds(primaryWorkArea)
    ? primaryWorkArea
    : { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  let area = primary;
  let visibleArea = 0;
  if (saved) {
    for (const display of workAreas.filter(validBounds)) {
      const intersection = overlap(saved.bounds, display);
      if (intersection > visibleArea) {
        visibleArea = intersection;
        area = display;
      }
    }
  }
  const minWidth = Math.min(MIN_WIDTH, area.width);
  const minHeight = Math.min(MIN_HEIGHT, area.height);
  const width = Math.round(Math.min(area.width, Math.max(minWidth, saved?.bounds.width ?? DEFAULT_WIDTH)));
  const height = Math.round(Math.min(area.height, Math.max(minHeight, saved?.bounds.height ?? DEFAULT_HEIGHT)));
  const centerX = area.x + (area.width - width) / 2;
  const centerY = area.y + (area.height - height) / 2;
  const x = Math.round(
    saved && visibleArea > 0 ? Math.max(area.x, Math.min(saved.bounds.x, area.x + area.width - width)) : centerX,
  );
  const y = Math.round(
    saved && visibleArea > 0 ? Math.max(area.y, Math.min(saved.bounds.y, area.y + area.height - height)) : centerY,
  );
  return { state: { bounds: { x, y, width, height }, maximized: saved?.maximized ?? true }, minWidth, minHeight };
}

type TrackedWindow = Pick<
  BrowserWindow,
  "getNormalBounds" | "isMaximized" | "isMinimized" | "isFullScreen" | "isDestroyed"
> &
  Pick<EventEmitter, "on" | "removeListener">;

/** Capture events immediately; coalesce disk writes and flush before native close. */
export function trackWindowState(
  window: TrackedWindow,
  initial: WindowState,
  persist: (state: WindowState) => void,
  previouslySaved?: WindowState,
): () => void {
  let state = { bounds: copyBounds(initial.bounds), maximized: initial.maximized };
  let saved = previouslySaved ? JSON.stringify(previouslySaved) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const capture = () => {
    // Minimized/fullscreen transitions can temporarily change isMaximized; retain
    // the last normal/maximized state. getNormalBounds never captures a maximized size.
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const bounds = window.getNormalBounds();
    if (validBounds(bounds)) state = { bounds: copyBounds(bounds), maximized: window.isMaximized() };
  };
  const save = () => {
    const serialized = JSON.stringify(state);
    if (serialized === saved) return;
    try {
      persist({ bounds: { ...state.bounds }, maximized: state.maximized });
      saved = serialized;
    } catch (error) {
      console.warn("Could not save window state", error);
    }
  };
  const changed = () => {
    if (disposed) return;
    capture();
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      save();
    }, SAVE_DELAY_MS);
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    capture();
    save();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    for (const event of changeEvents) window.removeListener(event, changed);
    window.removeListener("close", flush);
    window.removeListener("closed", closed);
  };
  const closed = () => {
    flush();
    dispose();
  };
  const changeEvents = [
    "move",
    "resize",
    "maximize",
    "unmaximize",
    "minimize",
    "restore",
    "leave-full-screen",
  ] as const;
  for (const event of changeEvents) window.on(event, changed);
  window.on("close", flush);
  window.on("closed", closed);
  return dispose;
}
