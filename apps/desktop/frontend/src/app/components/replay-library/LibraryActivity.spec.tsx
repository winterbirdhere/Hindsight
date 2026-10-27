import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Box } from "@mui/material";
import { LibraryActivity, LibraryActivityLane, libraryActivityModel } from "./LibraryActivity";
import { libraryRefinementSx } from "./library-refinement-style";
import type { LibraryViewSources } from "./library-view-types";
import type { LibraryAnalysisActivity } from "../../../../../shared/replay-library-metrics";

const work = (patch: Partial<LibraryAnalysisActivity> = {}): LibraryAnalysisActivity => ({ unit: "work-items", mode: "bg", queued: 0, awaitingInputs: 0, deferred: 0, failed: 0, running: 0, held: 0, retiring: 0, userPaused: false, viewerHold: false, batteryHold: false, resumePending: false, ...patch });
function sources(patch: Partial<LibraryAnalysisActivity> = {}): LibraryViewSources {
  return { analysis: { mode: "bg", workers: 1, userPaused: false, pauseOnBattery: true }, status: {
    replayCount: 5, updateMode: "auto", sources: [{ sourceId: "s", kind: "stable", enabled: true, directory: "fixture", observations: 5, state: "complete", update: { active: false, pending: false, stopped: false } }],
    rebuild: { state: "idle", observations: 0, mapErrors: {} }, importRecovery: { state: "complete", completed: 0, failed: 0, failures: [] },
    analysis: work(patch), indexMaintenance: { ready: true, state: "idle", pending: 0 },
  } };
}
it.each([
  [{ running: 2 }, "Library ready", "calm"], [{ queued: 8 }, "Library ready", "calm"],
  [{ awaitingInputs: 99 }, "Library ready", "calm"], [{ userPaused: true, held: 2 }, "Calculations paused", "paused"],
  [{ viewerHold: true }, "Waiting for the viewer", "paused"], [{ batteryHold: true }, "Waiting for external power", "paused"],
  [{ resumePending: true }, "Calculations resuming", "paused"], [{ retiring: 1 }, "Stopping calculations", "paused"],
  [{ held: 1 }, "Calculations waiting", "paused"], [{ deferred: 8 }, "Calculations deferred", "paused"],
  [{ mode: "off", running: 1 }, "Deep analysis Off", "calm"], [{ mode: "off" }, "Deep analysis Off", "idle"],
  [{ mode: "demand" }, "Library ready", "idle"], [{ failed: 5 }, "Library ready", "warning"],
  [{ error: "worker" }, "Analysis needs attention", "broken"], [{}, "Library up to date", "complete"],
] as const)("keeps %j truthful without a calculation percentage", (patch, title, lane) => {
  const model = libraryActivityModel(sources(patch));
  expect(model).toMatchObject({ title, lane });
  expect(model.total).toBeUndefined();
  render(<LibraryActivityLane model={model} />);
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
});
it("uses only positive real source phase totals, never replay counts", () => {
  const state = sources();
  if (!state.status) throw new Error("fixture");
  state.status.sources[0] = { ...state.status.sources[0], state: "scanning", progress: { phase: "reading-map-metadata", unit: "map-records", completed: 12, total: 30 } };
  const model = libraryActivityModel(state);
  expect(model).toMatchObject({ completed: 12, total: 30, detail: "12 of 30 map records" });
  const rendered = render(<LibraryActivityLane model={model} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("12");
  state.status.sources[0].progress = { phase: "checking-replays", unit: "source-records", completed: 0, total: 0 };
  rendered.rerender(<LibraryActivityLane model={libraryActivityModel(state)} />);
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
});
it("shows status loading before an unconfirmed Off setting, then unavailable without inventing work", () => {
  const state = sources(); if (!state.status) throw new Error("fixture");
  state.status.analysis = undefined;
  expect(libraryActivityModel(state).title).toBe("Analysis status unavailable");
  state.analysis.mode = "off"; state.analysisLoading = true;
  expect(libraryActivityModel(state).title).toBe("Reading analysis status…");
});
it("keeps first-page loading distinct from a ready source snapshot", () => {
  expect(libraryActivityModel(sources(), true).title).toBe("Loading your library");
  expect(libraryActivityModel(sources(), false).title).toBe("Library up to date");
});
it("uses only the browsable All count in completion and idle totals", () => {
  const state = sources(); if (!state.status) throw new Error("fixture");
  state.status.replayCount = 10;
  expect(libraryActivityModel(state, false, true, 6).detail).toBe("6 replays listed");
  expect(libraryActivityModel(state, false, false, 6).detail).toBe("6 replays");
  expect(libraryActivityModel(state, false, true).detail).not.toMatch(/\d+ replays/);
  expect(libraryActivityModel(state, false, false).detail).not.toMatch(/\d+ replays/);
  expect(libraryActivityModel(state, false, false, 0).detail).toBe("0 replays");
});
it("retains source and calculation problems, disjoint counts, focus and first Escape", () => {
  const state = sources({ running: 2, held: 3, retiring: 4, queued: 5, awaitingInputs: 6, deferred: 7, failed: 8 });
  if (!state.status) throw new Error("fixture");
  state.status.sources[0].state = "error";
  const parentEscape = jest.fn();
  const rendered = render(<div onKeyDown={parentEscape}><LibraryActivity sources={state} onOpenSources={jest.fn()} /></div>);
  expect(screen.getByRole("button", { name: "Show library problems" }).textContent).toContain("1 source · 8 failed");
  expect(screen.queryByText("Running")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Library activity details" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab", shiftKey: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  for (const label of ["Running", "Held", "Stopping", "Queued", "Awaiting input preparation", "Deferred", "Failed"]) expect(within(dialog).getByText(label)).toBeTruthy();
  expect(dialog.textContent).toContain("calculation jobs, not replays");
  parentEscape.mockClear();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Library activity details" }));
  expect(parentEscape).not.toHaveBeenCalled();
  rendered.rerender(<LibraryActivity sources={sources({ failed: 8 })} onOpenSources={jest.fn()} />);
  expect(screen.getByRole("button", { name: "Show library problems" }).textContent).toContain("8 failed");
});
it("does not call queued or held work calculating when deep analysis is Off", () => {
  expect(libraryActivityModel(sources({ mode: "off", queued: 5 })).detail).toBe("Other metric calculations are waiting");
  expect(libraryActivityModel(sources({ mode: "off", queued: 5, userPaused: true })).detail).toBe("Other calculation work is held");
});
it("seeds motion at its displayed position and never moves backward when a denominator grows", () => {
  const originalRaf = window.requestAnimationFrame, originalCancel = window.cancelAnimationFrame;
  let frame: FrameRequestCallback | undefined;
  window.requestAnimationFrame = jest.fn(callback => { frame = callback; return 1; });
  window.cancelAnimationFrame = jest.fn();
  try {
    const model = { title: "Checking", detail: "12 of 30 records", lane: "active" as const, phase: "same-phase", completed: 12, total: 30 };
    const rendered = render(<LibraryActivityLane model={model} />);
    const record = rendered.container.querySelector('.lib-activity-record') as HTMLElement;
    expect(parseFloat(record.style.left)).toBe(36);
    act(() => frame?.(performance.now() + 16));
    expect(parseFloat(record.style.left)).toBeGreaterThanOrEqual(36);
    rendered.rerender(<LibraryActivityLane model={{ ...model, total: 60 }} />);
    expect(parseFloat(record.style.left)).toBeGreaterThanOrEqual(36);
    act(() => frame?.(performance.now() + 32));
    expect(parseFloat(record.style.left)).toBeGreaterThanOrEqual(36);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuemax")).toBe("60");
    rendered.unmount();
  } finally { window.requestAnimationFrame = originalRaf; window.cancelAnimationFrame = originalCancel; }
});
it("has no animation loop or streaks under reduced motion while retaining real progress", () => {
  const media = window.matchMedia, raf = window.requestAnimationFrame;
  window.matchMedia = jest.fn(() => ({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() } as unknown as MediaQueryList));
  window.requestAnimationFrame = jest.fn();
  try {
    const rendered = render(<LibraryActivityLane model={{ title: "Checking", detail: "45 of 100 records", lane: "active", completed: 45, total: 100 }} />);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(rendered.container.querySelector('.lib-activity-streak')).toBeNull();
    expect((rendered.container.querySelector('.lib-activity-record') as HTMLElement).style.left).toBe("40.5px");
    rendered.unmount();
  } finally { window.matchMedia = media; window.requestAnimationFrame = raf; }
});
it("suppresses unused automatic missing lazer and disabled source warnings", () => {
  const state = sources(); if (!state.status) throw new Error("fixture");
  state.status.sources.push({ ...state.status.sources[0], sourceId: "l", kind: "lazer", state: "error", configuration: "automatic", hasIndexHistory: false, failureReason: "source-missing" });
  state.status.sources.push({ ...state.status.sources[0], sourceId: "disabled", enabled: false, state: "error" });
  render(<LibraryActivity sources={state} onOpenSources={jest.fn()} />);
  expect(screen.queryByRole("button", { name: "Show library problems" })).toBeNull();
});
it("celebrates only an observed source-work completion once, independent of calculation count updates", () => {
  jest.useFakeTimers();
  const state = sources({ running: 1 });
  const rendered = render(<LibraryActivity sources={state} onOpenSources={jest.fn()} />);
  expect(screen.queryByText("Sources checked")).toBeNull();
  const scanning = sources({ running: 1 }); if (!scanning.status) throw new Error("fixture");
  scanning.status.sources[0].state = "scanning";
  rendered.rerender(<LibraryActivity sources={scanning} onOpenSources={jest.fn()} />);
  rendered.rerender(<LibraryActivity sources={state} onOpenSources={jest.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Sources checked");
  act(() => jest.advanceTimersByTime(1500));
  rendered.rerender(<LibraryActivity sources={sources({ running: 2 })} onOpenSources={jest.fn()} />);
  act(() => jest.advanceTimersByTime(901));
  expect(screen.getByRole("status").textContent).toBe("Library ready");
  jest.useRealTimers();
});
it("outside close returns focus and does not activate the underlying source action", () => {
  const openSources = jest.fn();
  render(<LibraryActivity sources={sources()} onOpenSources={openSources} />);
  fireEvent.click(screen.getByRole("button", { name: "Library activity details" }));
  fireEvent.click(screen.getByRole("button", { name: "Close library activity details" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Library activity details" }));
  expect(openSources).not.toHaveBeenCalled();
});
it("stops the frame loop while the document is hidden and on unmount", () => {
  const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = jest.fn(() => 42); window.cancelAnimationFrame = jest.fn();
  try {
    const rendered = render(<LibraryActivityLane model={{ title: "Library ready", detail: "Metrics still calculating", lane: "calm" }} />);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    (window.requestAnimationFrame as jest.Mock).mockClear();
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    rendered.unmount();
  } finally { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel; }
});
it("keeps a visible completion check after settled background work and stops its frame loop", () => {
  jest.useFakeTimers();
  const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = jest.fn(() => 42); window.cancelAnimationFrame = jest.fn();
  try {
    const rendered = render(<Box sx={libraryRefinementSx}><LibraryActivity sources={sources({ running: 1 })} listedCount={5} onOpenSources={jest.fn()} /></Box>);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
    (window.requestAnimationFrame as jest.Mock).mockClear();
    rendered.rerender(<Box sx={libraryRefinementSx}><LibraryActivity sources={sources()} listedCount={5} onOpenSources={jest.fn()} /></Box>);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    const lane = screen.getByRole("progressbar");
    const mark = lane.querySelector(".lib-activity-complete"), record = lane.querySelector(".lib-activity-record");
    if (!mark || !record) throw new Error("Expected the completion mark and record");
    expect(getComputedStyle(mark).opacity).toBe("1");
    expect(getComputedStyle(record).opacity).toBe("0");
    expect(lane.getAttribute("aria-valuetext")).toBe("Library up to date. 5 replays");
    expect(lane.hasAttribute("aria-valuenow")).toBe(false);
    expect(lane.querySelector(".lib-activity-streak")).toBeNull();
    act(() => jest.advanceTimersByTime(3000));
    expect(getComputedStyle(mark).opacity).toBe("1");
    expect(screen.getByRole("status").textContent).toBe("Library up to date");
    rendered.unmount();
  } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel; jest.useRealTimers(); }
});
it("shows a warning for failed work and neutral information when completion evidence is absent", () => {
  const rendered = render(<Box sx={libraryRefinementSx}><LibraryActivity sources={sources({ failed: 5 })} onOpenSources={jest.fn()} /></Box>);
  const lane = screen.getByRole("progressbar");
  const warning = lane.querySelector(".lib-activity-outcome-warning"), complete = lane.querySelector(".lib-activity-complete");
  if (!warning || !complete) throw new Error("Expected separate warning and completion marks");
  expect(getComputedStyle(warning).opacity).toBe("1");
  expect(getComputedStyle(complete).opacity).toBe("0");
  expect(lane.getAttribute("aria-valuetext")).toBe("Library ready. Some metric values remain unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Show library problems" }));
  expect(within(screen.getByRole("dialog")).getByText("Failed")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  const unsettled = sources(); if (!unsettled.status) throw new Error("fixture");
  unsettled.status.sources[0].state = "idle";
  rendered.rerender(<Box sx={libraryRefinementSx}><LibraryActivity sources={unsettled} listedCount={5} onOpenSources={jest.fn()} /></Box>);
  const info = lane.querySelector(".lib-activity-ready");
  if (!info) throw new Error("Expected the neutral information mark");
  expect(getComputedStyle(info).opacity).toBe("1");
  expect(getComputedStyle(warning).opacity).toBe("0");
  expect(getComputedStyle(complete).opacity).toBe("0");
  expect(lane.getAttribute("aria-valuetext")).toBe("Library ready. 5 replays");
  expect(screen.queryByRole("button", { name: "Show library problems" })).toBeNull();
});
it("does not run completion animation on mount or after returning from hidden under reduced motion", () => {
  const media = window.matchMedia, raf = window.requestAnimationFrame;
  window.matchMedia = jest.fn(() => ({ matches: true, addEventListener: jest.fn(), removeEventListener: jest.fn() } as unknown as MediaQueryList));
  window.requestAnimationFrame = jest.fn();
  try {
    const rendered = render(<LibraryActivityLane model={libraryActivityModel(sources())} />);
    expect(screen.getByRole("progressbar").classList.contains("lib-lane-complete")).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(rendered.container.querySelector(".lib-activity-streak")).toBeNull();
    rendered.unmount();
  } finally { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); window.matchMedia = media; window.requestAnimationFrame = raf; }
});
