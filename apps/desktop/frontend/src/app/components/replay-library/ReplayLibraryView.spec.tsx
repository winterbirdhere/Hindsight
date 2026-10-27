import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { unstable_styleFunctionSx as styleFunctionSx } from "@mui/system";
import { Subject } from "rxjs";
import {
  LIBRARY_FILTER_FIELDS,
  LIBRARY_SORTS,
  type LibraryQueryDetail,
  type LibraryQueryItem,
} from "../../../../../shared/library-query";
import { LibraryCombo, LibraryReplayCard, libraryGradeColor } from "./LibraryReplay";
import { LibraryAnalysisStatus } from "./LibrarySources";
import { libraryActivityModel } from "./LibraryActivity";
import { ReplayLibraryView, libraryLayoutRows, libraryReanchorScroll, libraryCurrentBand, libraryBandRailLabel } from "./ReplayLibraryView";
import type { ReplayLibraryViewProps } from "./library-view-types";
import { FILTER_LABELS } from "./LibraryFilters";
import { LibraryPopover } from "./library-view-controls";
import { libraryViewSx } from "./library-view-style";
import { libraryRefinementSx } from "./library-refinement-style";
import { rewindTheme } from "../../styles/theme";
import { LibraryUiCoordinator } from "../../services/library/library-ui-coordinator";
import { LibraryQueryClient } from "../../services/library/library-query-client";
import type { LibraryImportSummary, LibraryRequest } from "../../../../../shared/replay-library";
import type { LibraryAnalysisActivity } from "../../../../../shared/replay-library-metrics";

function item(patch: Partial<LibraryQueryItem> = {}): LibraryQueryItem {
  return {
    id: "fixture-score",
    title: "Fixture map",
    artist: "Fixture artist",
    difficulty: "Three circles",
    mapper: "Fixture mapper",
    player: "Fixture player",
    mods: ["HD"],
    grade: "S",
    status: "ranked",
    completion: "passed",
    recordingClient: "unknown",
    fullCombo: null,
    perfectCombo: null,
    favourite: false,
    review: "not-reviewed",
    isNew: false,
    sourceKinds: ["stable"],
    collectionIds: [],
    collectionCount: 0,
    analysis: "none",
    analysisError: null,
    available: true,
    values: {
      pp: 150,
      peak: null,
      fc: null,
      acc: 100,
      combo: 3,
      miss: 0,
      ur: null,
      sr: 1.4,
      bpm: 120,
      len: 30,
      date: 1700000000000,
      mapStars: 1.4,
      bias: null,
      incidents: null,
      sliderBreaks: null,
    },
    band: { key: "100", label: "100–200 pp" },
    ...patch,
  };
}
function props(patch: Partial<ReplayLibraryViewProps> = {}): ReplayLibraryViewProps {
  return {
    query: { sort: "pp", direction: "desc" },
    page: { items: [item()], total: 1, analysisExcluded: 0 },
    selected: null,
    collections: [
      { id: "parent", name: "Practice", parentId: null, paletteIndex: 0, sequence: 0, count: 3, childCount: 1 },
      { id: "child", name: "Warmup", parentId: "parent", paletteIndex: 0, sequence: 1, count: 2 },
    ],
    view: "grid",
    sidebarShown: true,
    sources: {
      status: {
        replayCount: 1,
        updateMode: "auto",
        sources: [
          {
            sourceId: "stable-source",
            kind: "stable",
            directory: "D:/synthetic-fixture",
            enabled: true,
            observations: 1,
            state: "complete",
            update: { active: false, pending: false, stopped: false },
          },
        ],
        rebuild: { state: "idle", observations: 0, mapErrors: {} },
        importRecovery: { state: "complete", completed: 0, failed: 0, failures: [] },
      },
      analysis: { mode: "off", userPaused: false, workers: 1, pauseOnBattery: true },
    },
    onQueryChange: jest.fn(),
    onSelect: jest.fn(),
    onOpen: jest.fn(),
    onOpenReplayFile: jest.fn(),
    onReturnToViewer: jest.fn(),
    onRevealFile: jest.fn(),
    onViewChange: jest.fn(),
    onSidebarChange: jest.fn(),
    onPreview: jest.fn(async () => ({ count: 1, analysisExcluded: 0 })),
    onFacets: jest.fn(async () => ({ items: [] })),
    onReview: jest.fn(),
    onFavourite: jest.fn(),
    onMembership: jest.fn(),
    onCollectionCreate: jest.fn(),
    onCollectionRename: jest.fn(),
    onCollectionDelete: jest.fn(),
    onSourceAction: jest.fn(),
    onLocateStable: jest.fn(),
    onAnalysisSettings: jest.fn(),
    ...patch,
  };
}
describe("maximum speed control consistency", () => {
  it("marks the current choice consistently across all Library setting segments", () => {
    render(<ReplayLibraryView {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    for (const name of ["Find new replays", "Deep analysis mode", "Analysis threads"]) {
      const group = screen.getByRole("group", { name });
      const selected = within(group).getByRole("button", { pressed: true });
      expect(getComputedStyle(selected).boxShadow).toContain("#ff7aa0");
      for (const other of within(group).getAllByRole("button", { pressed: false })) {
        expect(getComputedStyle(other).boxShadow).not.toContain("#ff7aa0");
      }
    }
  });
  it("keeps layout and source selection visible while preserving grade colors", () => {
    const initial = props();
    const rendered = render(<ReplayLibraryView {...initial} />);
    const grid = screen.getByRole("button", { name: "Grid view" });
    const list = screen.getByRole("button", { name: "List view" });
    const sources = screen.getByRole("group", { name: "Quick source filter" });
    const all = within(sources).getByRole("button", { name: /^All/ });
    const stable = within(sources).getByRole("button", { name: /^osu! local/ });
    expect(getComputedStyle(grid).boxShadow).toContain("#ff7aa0");
    expect(getComputedStyle(all).boxShadow).toContain("#ff7aa0");
    fireEvent.click(list);
    expect(initial.onViewChange).toHaveBeenLastCalledWith("list");
    fireEvent.click(stable);
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ ...initial.query, cursor: undefined, filters: [{ field: "source", values: ["stable"] }] });
    rendered.rerender(<ReplayLibraryView {...initial} view="list" query={{ ...initial.query, filters: [{ field: "source", values: ["stable"] }] }} />);
    expect(getComputedStyle(grid).boxShadow).not.toContain("#ff7aa0");
    expect(getComputedStyle(all).boxShadow).not.toContain("#ff7aa0");
    expect(getComputedStyle(list).boxShadow).toContain("#ff7aa0");
    expect(getComputedStyle(stable).boxShadow).toContain("#ff7aa0");
    const grade = screen.getByRole("button", { name: "Grade S" });
    expect(getComputedStyle(grade).boxShadow).toContain("currentColor");
    expect(getComputedStyle(grade).boxShadow).not.toContain("#ff7aa0");
  });
  it("visibly marks the current review option without merging selection and keyboard focus", () => {
    const replay = item({ review: "reviewed" });
    const initial = props({ selected: { item: replay, mapIdentity: "map", metrics: [] } });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Reviewed" }));
    const menu = screen.getByRole("dialog", { name: "Review state" });
    const selected = within(menu).getByRole("button", { name: "Reviewed", pressed: true });
    const other = within(menu).getByRole("button", { name: "Not reviewed", pressed: false });
    expect(getComputedStyle(selected).boxShadow).toContain("#ff7aa0");
    expect(getComputedStyle(other).boxShadow).not.toContain("#ff7aa0");
    act(() => other.focus());
    expect(document.activeElement).toBe(other);
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(other);
    expect(initial.onReview).toHaveBeenCalledWith(replay.id, "not-reviewed");
  });
  it("keeps applied filters compact with separate, accessible edit and removal targets", () => {
    const initial = props({ query: { filters: [{ field: "source", values: ["stable"] }] } });
    render(<ReplayLibraryView {...initial} />);
    const remove = screen.getByRole("button", { name: "Remove Source filter" });
    const chip = remove.parentElement as HTMLElement;
    const edit = within(chip).getAllByRole("button").find(button => button !== remove) as HTMLElement;
    expect(getComputedStyle(chip).padding).toBe("0px");
    expect(getComputedStyle(chip).maxWidth).toBe("100%");
    expect(getComputedStyle(edit).minHeight).toBe("28px");
    expect(getComputedStyle(remove).minWidth).toBe("28px");
    expect(getComputedStyle(edit.firstElementChild as Element).textOverflow).toBe("ellipsis");
    act(() => edit.focus());
    expect(document.activeElement).toBe(edit);
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "Source" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Source" }), { key: "Escape" });
    act(() => remove.focus());
    fireEvent.click(remove);
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ ...initial.query, cursor: undefined, filters: [] });
  });
});
describe("throughput list feedback", () => {
  it("allows native pointer focus on Library settings and retains keyboard focus after applying them", () => {
    const initial = props();
    const rendered = render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const worker = within(screen.getByRole("group", { name: "Analysis threads" })).getByRole("button", { name: "2" });
    const faster = screen.getByRole("switch", { name: "Maximum speed" });
    for (const control of [worker, faster]) {
      // A cancelled mousedown prevents Chromium from moving focus from the prior panel command.
      expect(fireEvent.mouseDown(control, { button: 0 })).toBe(true);
    }
    act(() => worker.focus());
    fireEvent.click(worker);
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...initial.sources.analysis, workers: 2 });
    const analysis = { ...initial.sources.analysis, workers: 2 as const };
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, analysis }} />);
    expect(document.activeElement).toBe(worker);
    act(() => faster.focus());
    fireEvent.keyDown(faster, { key: "Enter" });
    fireEvent.keyUp(faster, { key: "Enter" });
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...analysis, fasterProcessing: true });
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, analysis: { ...analysis, fasterProcessing: true } }} />);
    expect(document.activeElement).toBe(faster);
    fireEvent.keyDown(faster, { key: " " });
    fireEvent.keyUp(faster, { key: " " });
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...analysis, fasterProcessing: false });
  });
  it.each([undefined, false, true])("restores the separate faster-processing switch (%s) and submits explicit choices without changing workers", (saved) => {
    const base = props();
    const analysis = { ...base.sources.analysis, ...(saved === undefined ? {} : { fasterProcessing: saved }) };
    const initial = props({ sources: { ...base.sources, analysis } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const control = screen.getByRole("switch", { name: "Maximum speed" });
    expect(control.getAttribute("aria-checked")).toBe(String(saved === true));
    const hint = document.getElementById(control.getAttribute("aria-describedby") as string)?.textContent;
    expect(hint).toMatch(/CPU and memory/);
    expect(hint).toMatch(/selected analysis threads/);
    expect(hint).toMatch(/viewer still takes priority/);
    expect(hint).toMatch(/Off by default/);
    act(() => control.focus());
    expect(document.activeElement).toBe(control);
    fireEvent.keyDown(control, { key: "Enter" });
    const fasterProcessing = saved !== true;
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...analysis, fasterProcessing });
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, analysis: { ...analysis, fasterProcessing } }} />);
    expect(control.getAttribute("aria-checked")).toBe(String(fasterProcessing));
    fireEvent.click(within(screen.getByRole("group", { name: "Analysis threads" })).getByRole("button", { name: "4" }));
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...analysis, fasterProcessing, workers: 4 });
    fireEvent.click(control);
    expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...analysis, fasterProcessing: !fasterProcessing });
  });
  it("retains keyboard focus on the sort header while its changed query has an empty pending page", () => {
    const initial = props({ view: "list", initialLoading: false,
      bands: [{ key: "100", label: "100–200 pp", count: 1, anchorId: "fixture-score" }] });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const header = screen.getByRole("button", { name: "PP" });
    header.focus();
    fireEvent.click(header);
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ sort: "pp", direction: "asc", cursor: undefined });
    // Host uses an empty page while LibraryViewState awaits the newly ordered SQL result.
    rendered.rerender(<ReplayLibraryView {...initial} query={{ sort: "pp", direction: "asc" }}
      page={{ items: [], total: 0, analysisExcluded: 0 }} bands={[]} loading />);
    expect(screen.getByRole("button", { name: "PP" })).toBe(header);
    expect(document.activeElement).toBe(header);
    expect(screen.queryByRole("row", { name: "Fixture map, Fixture player" })).toBeNull();
    expect(rendered.container.querySelector(".lib-empty")).toBeNull();
    expect(within(screen.getByRole("table", { name: "Replays" })).getByText("Loading replays…")).toBeTruthy();
    const railSlot = rendered.container.querySelector(".lib-rail");
    expect(railSlot).not.toBeNull();
    expect(getComputedStyle(railSlot as Element).visibility).toBe("hidden");
    expect(screen.queryByRole("navigation", { name: "Jump to replay band" })).toBeNull();
    rendered.rerender(<ReplayLibraryView {...initial} query={{ sort: "pp", direction: "asc" }} />);
    expect(screen.getByRole("button", { name: "PP" })).toBe(header);
    expect(document.activeElement).toBe(header);
    fireEvent.click(header);
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ sort: "pp", direction: "desc", cursor: undefined });
  });
  it("preserves the list overflow boundary while the page and its bands settle independently", () => {
    const initial = props({ view: "list", initialLoading: false, scrollLeft: 516,
      bands: [{ key: "100", label: "100–200 pp", count: 1, anchorId: "fixture-score" }] });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const header = screen.getByRole("button", { name: "PP" });
    const scroller = rendered.container.querySelector(".lib-list-scroll");
    const rail = screen.getByRole("navigation", { name: "Jump to replay band" });
    const railBasis = getComputedStyle(rail).flexBasis;
    const railWidth = getComputedStyle(rail).width;
    header.focus();
    const expectReservedBoundary = () => {
      const reserved = rendered.container.querySelector(".lib-rail");
      // Chromium clamps scrollLeft when this slot disappears and the scrollport
      // widens. jsdom has no layout; assert the real slot survives each published
      // state, including page-ready/loading=false before the bands response.
      expect(reserved).not.toBeNull();
      expect(getComputedStyle(reserved as Element).flexBasis).toBe(railBasis);
      expect(getComputedStyle(reserved as Element).width).toBe(railWidth);
      expect(getComputedStyle(reserved as Element).visibility).toBe("hidden");
      expect(screen.queryByRole("navigation", { name: "Jump to replay band" })).toBeNull();
      expect(rendered.container.querySelector(".lib-list-scroll")).toBe(scroller);
      expect(document.activeElement).toBe(header);
    };
    // Coordinator first invalidates bands, before the changed page is published.
    rendered.rerender(<ReplayLibraryView {...initial} bands={[]} />);
    expectReservedBoundary();
    rendered.rerender(<ReplayLibraryView {...initial} query={{ sort: "pp", direction: "asc" }}
      page={{ items: [], total: 0, analysisExcluded: 0 }} bands={[]} loading />);
    expectReservedBoundary();
    // The SQL page finishes before refreshBands, so loading is already false.
    rendered.rerender(<ReplayLibraryView {...initial} query={{ sort: "pp", direction: "asc" }}
      bands={[]} loading={false} />);
    expectReservedBoundary();
    expect(screen.queryByText("Loading replays…")).toBeNull();
    expect(screen.getByRole("row", { name: "Fixture map, Fixture player" })).toBeTruthy();
    rendered.rerender(<ReplayLibraryView {...initial} query={{ sort: "pp", direction: "asc" }} />);
    expect(getComputedStyle(screen.getByRole("navigation", { name: "Jump to replay band" })).width).toBe(railWidth);
    expect(document.activeElement).toBe(header);
    // A completed empty result needs neither a header nor a phantom rail.
    rendered.rerender(<ReplayLibraryView {...initial} page={{ items: [], total: 0, analysisExcluded: 0 }}
      bands={[]} loading={false} />);
    expect(rendered.container.querySelector(".lib-rail")).toBeNull();
  });
  it("toggles the active header repeatedly and shares effective defaults with the toolbar", () => {
    const initial = props({ view: "list", query: { search: "literal", scope: { kind: "favourites" },
      filters: [{ field: "source", values: ["stable"] }], cursor: "old-cursor" } });
    render(<Controlled initial={initial} />);
    const header = (name: string) => screen.getByRole("button", { name });
    fireEvent.click(header("PP"));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ ...initial.query, sort: "pp", direction: "asc", cursor: undefined });
    expect(screen.getByRole("button", { name: "Reverse sort direction" }).textContent).toContain("Low to high");
    fireEvent.click(header("PP"));
    expect(screen.getByRole("columnheader", { name: "PP" }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(header("UR"));
    expect((screen.getByRole("combobox", { name: "Sort replays" }) as HTMLSelectElement).value).toBe("ur");
    expect(screen.getByRole("columnheader", { name: "UR" }).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(header("UR"));
    expect(screen.getByRole("columnheader", { name: "UR" }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort replays" }), { target: { value: "title" } });
    expect(screen.getByRole("columnheader", { name: "Replay" }).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: "Reverse sort direction" }));
    expect(screen.getByRole("columnheader", { name: "Replay" }).getAttribute("aria-sort")).toBe("descending");
    for (const name of ["Grade", "Mods", "Save"]) expect(within(screen.getByRole("columnheader", { name })).queryByRole("button")).toBeNull();
    header("Replay").focus();
    expect(document.activeElement).toBe(header("Replay"));
    expect(header("Replay").tagName).toBe("BUTTON");
    expect(initial.onOpen).not.toHaveBeenCalled();
    expect(initial.onAnalysisSettings).not.toHaveBeenCalled();
  });
  it("uses shared header and row cell alignment with readable headers and larger bounded mods", () => {
    render(<ReplayLibraryView {...props({ view: "list", page: { items: [item({ mods: ["HD", "HR", "DT", "FL"] })], total: 1, analysisExcluded: 0 } })} />);
    const header = screen.getByRole("columnheader", { name: "Accuracy" });
    const row = screen.getByRole("row", { name: "Fixture map, Fixture player" });
    const value = within(row).getByText("100.00");
    expect(getComputedStyle(header).textAlign).toBe("right");
    expect(getComputedStyle(value).textAlign).toBe("right");
    expect(getComputedStyle(header).padding).toBe(getComputedStyle(value).padding);
    expect(parseFloat(getComputedStyle(within(header).getByRole("button")).fontSize)).toBeGreaterThanOrEqual(12);
    const mods = within(row).getByRole("group", { name: "Mods: HD, HR, DT, FL" });
    expect(within(mods).getByText("+2")).toBeTruthy();
    const badges = within(mods).getAllByRole("img");
    expect(badges).toHaveLength(2);
    expect(parseFloat(getComputedStyle(badges[0]).height)).toBeGreaterThanOrEqual(22);
    expect(getComputedStyle(row).minHeight).toBe("54px");
    expect(getComputedStyle(header.parentElement as Element).gridTemplateColumns).toBe(getComputedStyle(row).gridTemplateColumns);
  });
  it("retains a visible selected worker face inside the Library and reflects restored settings", () => {
    const initial = props();
    const rendered = render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const group = screen.getByRole("group", { name: "Analysis threads" });
    const one = within(group).getByRole("button", { name: "1" });
    const four = within(group).getByRole("button", { name: "4" });
    expect(one.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(one).backgroundColor).not.toBe(getComputedStyle(four).backgroundColor);
    expect(getComputedStyle(one).boxShadow).toContain("#ff7aa0");
    for (const workers of [4, 2, 1] as const) {
      const button = within(group).getByRole("button", { name: String(workers) });
      fireEvent.click(button);
      expect(initial.onAnalysisSettings).toHaveBeenLastCalledWith({ ...initial.sources.analysis, workers });
      rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, analysis: { ...initial.sources.analysis, workers } }} />);
      expect(within(group).getAllByRole("button", { pressed: true })).toEqual([button]);
    }
    act(() => four.focus());
    expect(document.activeElement).toBe(four);
  });
  it.each([1680, 1100, 800])("keeps header, values and band in one horizontal content width at %ipx with details open", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    const replay = item({ title: "A deliberately long replay title that must truncate within its column", mods: ["HD", "HR", "DT"] });
    const initial = props({ view: "list", page: { items: [replay], total: 1, analysisExcluded: 0 },
      selected: { item: replay, mapIdentity: "map", metrics: [] }, onScrollLeftChange: jest.fn() });
    render(<ReplayLibraryView {...initial} />);
    const table = screen.getByRole("table", { name: "Replays" });
    expect(table.getAttribute("aria-rowcount")).toBe("-1");
    const row = within(table).getByRole("row", { name: `${replay.title}, ${replay.player}` });
    const heading = within(table).getByRole("columnheader", { name: "Replay" });
    const scroller = row.closest(".lib-list-scroll") as HTMLElement;
    expect(heading.closest(".lib-list-scroll")).toBe(scroller);
    expect(screen.getByText("100–200 pp").closest(".lib-list-content")).toBe(table);
    expect(getComputedStyle(row).gridTemplateColumns).toBe(getComputedStyle(heading.parentElement as Element).gridTemplateColumns);
    expect(getComputedStyle(table).minWidth).toBe(getComputedStyle(row).minWidth);
    fireEvent.scroll(scroller, { target: { scrollLeft: 320 } });
    expect(initial.onScrollLeftChange).toHaveBeenLastCalledWith(320);
    expect(document.getElementById(row.getAttribute("aria-describedby") as string)?.textContent).toBe("Replay 1");
  });
});
describe("visual refinement", () => {
  it.each([
    { name: "missing Peak", peak: null, fullCombo: null, completion: "passed", sort: "pp", lower: true },
    { name: "lower Peak", peak: 100, fullCombo: null, completion: "passed", sort: "pp", lower: true },
    { name: "confirmed FC in Peak sort", peak: 200, fullCombo: true, completion: "passed", sort: "peak", lower: true },
    { name: "unconfirmed FC with a real Peak", peak: 200, fullCombo: null, completion: "passed", sort: "pp", lower: false },
    { name: "If FC secondary", peak: null, fullCombo: true, completion: "passed", sort: "fc", lower: false },
    { name: "UR secondary", peak: null, fullCombo: null, completion: "passed", sort: "ur", lower: false },
    { name: "failed primary Peak", peak: 200, fullCombo: false, completion: "failed", sort: "pp", lower: true },
  ] as const)("PP alignment: lowers only the empty-secondary case for $name", ({ peak, fullCombo, completion, sort, lower }) => {
    const replay = item({ fullCombo, perfectCombo: true, completion,
      values: { ...item().values, pp: completion === "failed" ? null : 150, peak, fc: 999, ur: 90 } });
    const initial = props({ query: { sort }, page: { items: [replay], total: 1, analysisExcluded: 0 } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const pp = rendered.container.querySelector(".lib-card-pp") as HTMLElement;
    const secondary = rendered.container.querySelector(".lib-card-secondary") as HTMLElement;
    expect(getComputedStyle(pp).transform).toBe(lower ? "translateY(18px)" : "");
    expect(secondary.textContent === "").toBe(lower);
    expect(getComputedStyle(secondary).minHeight).toBe("12px");
    expect(getComputedStyle(pp.parentElement as Element).rowGap).toBe("6px");
    expect(getComputedStyle(rendered.container.querySelector(".lib-card-accuracy") as Element).transform).toBe("");
    expect(getComputedStyle(rendered.container.querySelector(".lib-card-combo") as Element).transform).toBe("");
    expect(pp.textContent).toBe(completion === "failed" ? "200pp peak" : "150pp");
    expect(replay.values.peak).toBe(peak);
  });
  it("emits and renders activity streaks as one pixel rather than a full lane height", () => {
    const css = styleFunctionSx({ sx: libraryRefinementSx, theme: rewindTheme }) as Record<string, Record<string, unknown>>;
    expect(css["& .lib-activity-streak"].height).toBe("1px");
    const initial = props();
    const rendered = render(<ReplayLibraryView {...initial} sources={{ ...initial.sources,
      status: { ...fixtureStatus(initial.sources), analysis: analysisActivity({ running: 1 }) } }} />);
    const streak = rendered.container.querySelector(".lib-activity-streak");
    expect(streak).not.toBeNull();
    expect(getComputedStyle(streak as Element).height).toBe("1px");
  });
  it("uses the coherent All count for activity, independently of disabled-source and filtered totals", () => {
    const initial = props();
    const state = { ...initial.sources, analysis: { ...initial.sources.analysis, mode: "bg" as const }, status: { ...fixtureStatus(initial.sources), replayCount: 10, analysis: analysisActivity() } };
    const rendered = render(<ReplayLibraryView {...initial} query={{ search: "filtered" }} page={{ ...initial.page, total: 2 }} scopeCounts={{ all: 6 }} sources={state} />);
    const activity = screen.getByRole("region", { name: "Library activity" });
    expect(within(activity).getByText("6 replays")).toBeTruthy();
    expect(activity.textContent).not.toMatch(/10 replays|2 replays/);
    rendered.rerender(<ReplayLibraryView {...initial} scopeCounts={{}} sources={state} />);
    expect(activity.textContent).not.toMatch(/\d+ replays/);
  });
  it("finds the current virtual band from complete row geometry rather than mounted headings", () => {
    const items = Array.from({ length: 40 }, (_, i) => item({ id: String(i), band: i < 20 ? { key: "high", label: "500+ pp" } : { key: "low", label: "400–500 pp" } }));
    const rows = libraryLayoutRows(items, 2, "grid");
    const next = rows.find(row => row.bandKey === "low");
    if (!next) throw new Error("fixture");
    expect(libraryCurrentBand(rows, next.top + 200 - 141, 200)).toBe("high");
    expect(libraryCurrentBand(rows, next.top + 200 - 140, 200)).toBe("low");
    expect(libraryBandRailLabel("400–500 pp")).toBe("400–500");
    expect(libraryBandRailLabel("9.00–9.99★")).toBe("9.00–9.99");
    expect(libraryBandRailLabel("No PP data")).toBe("No PP data");
  });
  it("requests actual visible artwork before the mounted overscan above it", () => {
    const onVisibleReplays = jest.fn();
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `priority-${i}` }));
    render(<ReplayLibraryView {...props({ page: { items, total: 12, analysisExcluded: 0 }, scrollTop: 500, onVisibleReplays })} />);
    const requested = onVisibleReplays.mock.calls[onVisibleReplays.mock.calls.length - 1][0] as string[];
    expect(requested[0]).toBe("priority-1");
    expect(requested.indexOf("priority-0")).toBeGreaterThan(requested.indexOf("priority-2"));
    const mounted = within(screen.getByRole("listbox", { name: "Replays" })).getAllByRole("option").map(node => node.getAttribute("data-replay-id"));
    expect([...requested].sort()).toEqual(mounted.sort());
  });
  it("jumps a loaded band to its heading without eagerly publishing the smooth target", () => {
    const first = item(), next = item({ id: "next", band: { key: "next", label: "Under 100 pp" } });
    const initial = props({ page: { items: [first, next], total: 2, analysisExcluded: 0 }, bands: [
      { ...first.band, count: 1, anchorId: first.id }, { ...next.band, count: 1, anchorId: next.id },
    ], onJumpBand: jest.fn(), onScrollTopChange: jest.fn() });
    render(<ReplayLibraryView {...initial} />);
    const main = screen.getByRole("main"), scrollTo = jest.fn();
    main.scrollTo = scrollTo;
    fireEvent.click(screen.getByRole("button", { name: "Jump to Under 100 pp, 1 replay" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 432, behavior: "smooth" });
    expect(initial.onScrollTopChange).not.toHaveBeenCalled();
    expect(initial.onJumpBand).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Jump to Under 100 pp, 1 replay" }).getAttribute("aria-current")).toBe("true");
  });
  it("keeps remote band jumps on the service path and marks them current only after reveal", () => {
    const first = item(), next = item({ id: "remote", band: { key: "remote", label: "Under 100 pp" } });
    const initial = props({ bands: [{ ...first.band, count: 1, anchorId: first.id }, { ...next.band, count: 1, anchorId: next.id }], onJumpBand: jest.fn() });
    const rendered = render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Jump to Under 100 pp, 1 replay" }));
    expect(initial.onJumpBand).toHaveBeenCalledWith("remote");
    expect(screen.getByRole("button", { name: "Jump to Under 100 pp, 1 replay" }).hasAttribute("aria-current")).toBe(false);
    rendered.rerender(<ReplayLibraryView {...initial} page={{ items: [next], total: 2, analysisExcluded: 0 }} pageStart={1} revealRequest={{ id: next.id, position: 1, sequence: 1 }} />);
    expect(screen.getByRole("main").scrollTop).toBe(0);
    expect(screen.getByRole("button", { name: "Jump to Under 100 pp, 1 replay" }).getAttribute("aria-current")).toBe("true");
  });
  it("does not use a repeated local band heading as the global band anchor", () => {
    const first = item();
    const initial = props({ bands: [{ ...first.band, count: 30, anchorId: "not-in-window" }], pageStart: 20, onJumpBand: jest.fn() });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Jump to 100–200 pp, 30 replays" }));
    expect(initial.onJumpBand).toHaveBeenCalledWith("100");
  });
  it.each(["grid", "list"] as const)("hides displayed Peak for confirmed FC in %s without mutating values", view => {
    const replay = item({ fullCombo: true, values: { ...item().values, peak: 987, fc: 999 } });
    const initial = props({ view, page: { items: [replay], total: 1, analysisExcluded: 0 } });
    const rendered = render(<ReplayLibraryView {...initial} query={{ sort: "peak" }} />);
    expect(within(rendered.container.querySelector('[data-replay-id]') as HTMLElement).queryByText(/987/)).toBeNull();
    expect(replay.values.peak).toBe(987);
    rendered.rerender(<ReplayLibraryView {...initial} selected={{ item: replay, metrics: [], provenance: [], recentPlays: [] } as unknown as LibraryQueryDetail} />);
    const details = rendered.container.querySelector('.lib-panel') as HTMLElement;
    expect(within(details).queryByText("987")).toBeNull();
    expect(within(details).getByText("999")).toBeTruthy();
  });
  it("retains Peak for unconfirmed FC despite perfect combo and zero misses", () => {
    const replay = item({ perfectCombo: true, fullCombo: null, values: { ...item().values, peak: 987 } });
    render(<LibraryReplayCard item={replay} selected={false} onSelect={jest.fn()} onOpen={jest.fn()} onSave={jest.fn()} />);
    expect(screen.getByText("987")).toBeTruthy();
    expect(screen.getByText("PEAK")).toBeTruthy();
  });
  it("hides a lower Peak on cards and keeps the separate unit and relative date", () => {
    const replay = item({ values: { ...item().values, peak: 100, date: Date.now() - 7 * 86400000 } });
    render(<LibraryReplayCard item={replay} selected={false} onSelect={jest.fn()} onOpen={jest.fn()} onSave={jest.fn()} />);
    expect(screen.queryByText(/peak/i)).toBeNull();
    expect(screen.getByText("pp").className).toBe("lib-pp-unit");
    expect(screen.getByText("1w ago").title).toBe(new Date(replay.values.date as number).toLocaleString());
  });
  it("names text filters as the same filters and applies explicitly", () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "Search replays" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit filters as text…" }));
    expect(screen.getByText("Edit the same search and filters using text instead of the filter controls.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Query text" }), { target: { value: "miss:0" } });
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(initial.onQueryChange).toHaveBeenCalledTimes(1);
  });
});
it("offers the existing replay-file action when no replay is loaded, independently of library contents", () => {
  const initial = props();
  const rendered = render(<ReplayLibraryView {...initial} />);
  const open = screen.getByRole("button", { name: "Open replay" });
  expect(open.getAttribute("aria-keyshortcuts")).toBe("F2");
  expect(within(open).getByText("F2")).toBeTruthy();
  fireEvent.click(open);
  expect(initial.onOpenReplayFile).toHaveBeenCalledTimes(1);
  expect(initial.onSourceAction).not.toHaveBeenCalled();
  expect(initial.onOpen).not.toHaveBeenCalled();
  rendered.rerender(<ReplayLibraryView {...initial} page={{ items: [], total: 0, analysisExcluded: 0 }} />);
  expect(screen.getByRole("button", { name: "Open replay" })).toBeTruthy();
  rendered.rerender(<ReplayLibraryView {...initial} nowPlaying={{ id: "loaded", title: "Loaded replay" }} />);
  expect(screen.queryByRole("button", { name: "Open replay" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Loaded replay in the viewer" }));
  expect(initial.onReturnToViewer).toHaveBeenCalledTimes(1);
});
it("manual feedback: passive refresh does not disable the deliberate Load more action", () => {
  const onLoadMore = jest.fn();
  render(<ReplayLibraryView {...props({
    page: { items: [item()], total: 200, next: "next-page", analysisExcluded: 0 },
    loading: true,
    onLoadMore,
  })} />);
  const button = screen.getByRole("button", { name: "Load more replays" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  expect(onLoadMore).toHaveBeenCalledTimes(1);
});
it("manual feedback status: separates the complete filter directory from quick suggestions", async () => {
  render(<ReplayLibraryView {...props()} />);
  fireEvent.focus(screen.getByRole("textbox", { name: "Search replays" }));
  const directory = screen.getByRole("group", { name: "All filters" });
  expect(directory.contains(screen.getByRole("button", { name: "Star rating" }))).toBe(false);
  const browse = within(directory).getByRole("button", { name: "Browse all filters" });
  expect(within(directory).getByText("20 filters for beatmap, replay, analysis and library")).toBeTruthy();
  fireEvent.click(browse);
  await flush();
  expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
});
it("manual feedback footer: keeps the directory separator compact in the actual MUI theme", () => {
  const css = styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<string, Record<string, unknown>>;
  const footer = css["& .lib-all-filters"];
  expect(footer.marginTop).toBe("10px");
  expect(footer.paddingTop).toBe("10px");
  expect(footer.borderTop).toContain("1px solid");
});
it.each([
  { phase: "reading-map-metadata" as const, unit: "map-records" as const, completed: 0, expected: "Reading beatmap data", count: "0 map records read" },
  { phase: "checking-replays" as const, unit: "replay-observations" as const, completed: 1, expected: "Checking replay records", count: "1 record checked" },
  { phase: "checking-replays" as const, unit: "source-records" as const, completed: 12, total: 20, expected: "Checking source records", count: "12 of 20 source records checked" },
  { phase: "committing" as const, unit: "source-records" as const, completed: 20, total: 20, expected: "Saving source index", count: "20 of 20 source records checked" },
])("manual feedback status: explains $phase with actual $unit and no invented percent", progress => {
  const initial = props(), status = fixtureStatus(initial.sources);
  const next = { ...status, sources: [{ ...status.sources[0], state: "scanning" as const, progress }] };
  const rendered = render(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: next }} />);
  fireEvent.click(screen.getByRole("button", { name: "Sources" }));
  expect(screen.getByRole("dialog", { name: "Sources" }).querySelector(".lib-section > strong")?.textContent).toContain(progress.expected);
  const count = within(screen.getByRole("dialog", { name: "Sources" })).getByText(progress.count, { exact: false });
  expect(count.closest('[role="status"]')).toBeNull();
  expect(rendered.container.querySelector("progress")).toBeNull();
  expect(screen.queryByText("Source check complete")).toBeNull();
  expect(screen.getByText("Fixture map")).toBeTruthy();
});
it("manual feedback status: separates source completion from optional analysis and query maintenance", () => {
  const initial = props(), status = fixtureStatus(initial.sources);
  const sources = { ...initial.sources, analysis: { ...initial.sources.analysis, mode: "bg" as const },
    status: { ...status, analysis: analysisActivity({ running: 1, queued: 12 }),
      indexMaintenance: { state: "idle" as const, ready: true, pending: 0 } } };
  const rendered = render(<ReplayLibraryView {...initial} sources={sources} />);
  expect(screen.getByRole("status", { name: "Library activity" }).textContent).toBe("Library ready");
  expect(screen.getByText("Metrics still calculating")).toBeTruthy();
  expect(screen.queryByText("1 running")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Library activity details" }));
  expect(screen.getByRole("dialog", { name: "Library activity details" }).textContent).toContain("Running1Queued12");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...sources,
    status: { ...sources.status, indexMaintenance: { state: "running", ready: false, pending: 2 } },
  }} />);
  expect(screen.getByRole("status", { name: "Library activity" }).textContent).toBe("Preparing library results");
});
function analysisActivity(patch: Partial<LibraryAnalysisActivity> = {}): LibraryAnalysisActivity {
  return { unit: "work-items", mode: "bg", running: 0, queued: 0, awaitingInputs: 0, deferred: 0, failed: 0,
    held: 0, retiring: 0, userPaused: false, viewerHold: false, batteryHold: false, resumePending: false, ...patch };
}
it.each<{ activity: Partial<LibraryAnalysisActivity>; title: string }>([
  { activity: { running: 2 }, title: "Calculating metrics" },
  { activity: { queued: 7 }, title: "Calculations queued" },
  { activity: { awaitingInputs: 8 }, title: "Calculations awaiting preparation" },
  { activity: { userPaused: true, held: 1, queued: 7 }, title: "Deep analysis paused" },
  { activity: { viewerHold: true, held: 1, queued: 7 }, title: "Analysis waiting for viewer" },
  { activity: { batteryHold: true, held: 1, queued: 7 }, title: "Analysis waiting for external power" },
  { activity: { resumePending: true, held: 1 }, title: "Analysis resuming" },
  { activity: { mode: "off", retiring: 1, queued: 7 }, title: "Deep analysis Off" },
  { activity: { retiring: 1 }, title: "Stopping calculations" },
  { activity: { held: 1 }, title: "Calculations waiting" },
  { activity: { failed: 3 }, title: "Some calculations failed" },
  { activity: { deferred: 6 }, title: "Calculations deferred" },
  { activity: { error: "Worker unavailable", queued: 7 }, title: "Analysis needs attention" },
  { activity: {}, title: "No calculations queued" },
  { activity: { mode: "demand" }, title: "Analysis on demand" },
])("analysis activity: reports $title from real scheduler state", ({ activity, title }) => {
  const initial = props();
  render(<LibraryAnalysisStatus sources={{ ...initial.sources,
    status: { ...fixtureStatus(initial.sources), analysis: analysisActivity(activity) } }} />);
  const region = screen.getByRole("region", { name: "Analysis activity" });
  expect(within(region).getByText(title)).toBeTruthy();
  expect(region.querySelector("progress, [role='progressbar']")).toBeNull();
  expect(region.textContent).not.toMatch(/\d\s*%|all.*complete|all.*analysed/i);
});
it("analysis activity: updates work counts quietly and distinguishes work items from replay coverage", () => {
  const initial = props();
  const sources = { ...initial.sources,
    status: { ...fixtureStatus(initial.sources), replayCount: 1,
      analysis: analysisActivity({ running: 2, queued: 11, awaitingInputs: 8, deferred: 3, failed: 4 }) } };
  const rendered = render(<LibraryAnalysisStatus sources={sources} />);
  const activity = screen.getByRole("region", { name: "Analysis activity" });
  for (const text of ["2 running", "11 queued", "8 awaiting input preparation", "3 deferred", "4 failed"])
    expect(within(activity).getByText(text)).toBeTruthy();
  expect(activity.textContent).toContain("Calculations");
  expect(activity.textContent).not.toMatch(/of 1|\/ 1|\d+ replays/);
  const announcement = screen.getAllByRole("status").find(node => node.textContent === "Calculating metrics");
  expect(announcement).toBeDefined();
  expect(announcement?.classList.contains("lib-sr")).toBe(true);
  expect(within(activity).getByText("11 queued").closest('[role="status"], [aria-live]')).toBeNull();
  rendered.rerender(<LibraryAnalysisStatus sources={{ ...sources,
    status: { ...sources.status, analysis: analysisActivity({ running: 1, queued: 9 }) } }} />);
  expect(within(activity).getByText("9 queued")).toBeTruthy();
  expect(announcement?.textContent).toBe("Calculating metrics");
  rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...sources, status: { ...sources.status, analysis: analysisActivity({ running: 1, queued: 9 }) } }} />);
  fireEvent.click(screen.getByRole("button", { name: "Sources" }));
  const dialogActivity = within(screen.getByRole("dialog", { name: "Sources" })).getByRole("region", { name: "Analysis activity" });
  expect(within(dialogActivity).getByText("9 queued")).toBeTruthy();
  expect(screen.getAllByRole("status", { name: "Analysis activity" })).toHaveLength(1);
  expect(screen.queryByRole("progressbar", { name: "Deep analysis progress" })).toBeNull();
});
it("analysis activity: does not infer queued work from missing values or an enabled background setting", () => {
  const initial = props();
  const rendered = render(<LibraryAnalysisStatus sources={{ ...initial.sources,
    analysis: { ...initial.sources.analysis, mode: "bg" } }} />);
  const activity = screen.getByRole("region", { name: "Analysis activity" });
  expect(within(activity).getByText("Analysis status unavailable")).toBeTruthy();
  expect(activity.textContent).not.toMatch(/Calculating metrics|Calculations queued|all.*complete/i);
  rendered.rerender(<LibraryAnalysisStatus sources={{ ...initial.sources, analysisLoading: true }} />);
  expect(within(activity).getByText("Reading analysis status…")).toBeTruthy();
  expect(within(activity).queryByText("Deep analysis Off")).toBeNull();
});
it("analysis activity: keeps active non-deep calculations visible when deep analysis is Off", () => {
  const initial = props();
  render(<LibraryAnalysisStatus sources={{ ...initial.sources,
    status: { ...fixtureStatus(initial.sources), analysis: analysisActivity({ mode: "off", running: 1, queued: 3 }) } }} />);
  const activity = screen.getByRole("region", { name: "Analysis activity" });
  expect(within(activity).getByText("Deep analysis Off")).toBeTruthy();
  expect(within(activity).getByText("1 running")).toBeTruthy();
  expect(within(activity).getByText("3 queued")).toBeTruthy();
  expect(activity.textContent).toContain("Other metric calculations can still run.");
});
it("manual feedback review: mounts the phase announcement with the existing visually hidden style", () => {
  const rendered = render(<ReplayLibraryView {...props()} />);
  const announcement = Array.from(rendered.container.querySelectorAll('[role="status"]'))
    .find(node => node.textContent === "Deep analysis Off");
  expect(announcement).toBeDefined();
  if (!announcement) throw new Error("Expected source phase announcement");
  expect(announcement.classList.contains("lib-sr")).toBe(true);
  const style = getComputedStyle(announcement);
  expect(style.position).toBe("absolute");
  expect(style.width).toBe("1px");
  expect(style.height).toBe("1px");
  expect(style.overflow).toBe("hidden");
});
function Controlled({ initial }: { initial: ReplayLibraryViewProps }) {
  const [selected, setSelected] = useState<LibraryQueryDetail | null>(initial.selected);
  const [query, setQuery] = useState(initial.query);
  const [myNames, setMyNames] = useState(initial.myNames);
  const saveMyNames = initial.onSaveMyNames;
  return (
    <ReplayLibraryView
      {...initial}
      query={query}
      selected={selected}
      myNames={myNames}
      onSaveMyNames={
        saveMyNames &&
        (async (names) => {
          const saved = await saveMyNames(names);
          setMyNames({ names: saved });
          return saved;
        })
      }
      onSelect={(id) => {
        initial.onSelect(id);
        setSelected(
          id
            ? {
                item: initial.page.items.find((row) => row.id === id) ?? initial.page.items[0],
                mapIdentity: "map",
                metrics: [],
              }
            : null,
        );
      }}
      onQueryChange={(next) => {
        initial.onQueryChange(next);
        setQuery(next);
      }}
    />
  );
}
function fixtureStatus(sources: ReplayLibraryViewProps["sources"]) {
  if (!sources.status) throw new Error("Expected fixture status");
  return sources.status;
}
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1680 });
});

describe("same-map row identity and accessible text", () => {
  it.each([
    {
      player: "Synthetic QA Recorded Player With A Deliberately Long Name For Truncation And Accessible Full Name Verification 0123456789",
      pp: 10000,
      name: "Synthetic QA Recorded Player With A Deliberately Long Name For Truncation And Accessible Full Name Verification 0123456789 10,000 pp",
    },
    { player: "Short", pp: 0, name: "Short 0 pp" },
    { player: null, pp: null, name: "Unknown player —" },
  ])("preserves the full accessible name and selects its own replay ($name)", ({ player, pp, name }) => {
    const otherPlay = item({ id: "same-map-other", player, values: { ...item().values, pp } });
    const initial = props({
      selected: { item: item(), mapIdentity: "same-map", metrics: [] },
      sameMap: { items: [otherPlay], total: 1 },
    });
    render(<ReplayLibraryView {...initial} />);
    const button = screen.getByRole("button", { name });
    fireEvent.click(button);
    expect(initial.onSelect).toHaveBeenCalledTimes(1);
    expect(initial.onSelect).toHaveBeenCalledWith("same-map-other");
    expect(initial.onOpen).not.toHaveBeenCalled();
  });
});

describe("modal Tab continuation from a restored external bookmark", () => {
  it.each([
    { delayed: false, shiftKey: false },
    { delayed: false, shiftKey: true },
    { delayed: true, shiftKey: false },
    { delayed: true, shiftKey: true },
  ])("recaptures actual bookmark keydown (delayed=$delayed, backward=$shiftKey)", ({ delayed, shiftKey }) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props({
      view: "list",
      page: { items: [item(), item({ id: "second", title: "Second map" })], total: 2, analysisExcluded: 0 },
    });
    const rendered = render(delayed ? <ReplayLibraryView {...initial} /> : <Controlled initial={initial} />);
    const anchor = screen.getByRole("button", { name: "Add Fixture map to collection" });
    fireEvent.click(anchor);
    if (delayed)
      rendered.rerender(
        <ReplayLibraryView {...initial} selected={{ item: initial.page.items[0], mapIdentity: "map", metrics: [] }} />,
      );
    const popover = screen.getByRole("dialog", { name: "Save to" });
    expect(popover.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    const panel = screen.getByRole("dialog", { name: "Replay details Fixture map" });
    expect(document.activeElement).toBe(anchor);
    expect(panel.contains(anchor)).toBe(false);
    // Dispatch on the real external event target. JSDOM does not perform default
    // Tab navigation; the companion Chromium check covers that default action.
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    act(() => anchor.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const buttons = within(panel).getAllByRole("button").filter((button) => !(button as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(shiftKey ? buttons[buttons.length - 1] : buttons[0]);
    expect(initial.onOpen).not.toHaveBeenCalled();
    expect(initial.onFavourite).not.toHaveBeenCalled();
    expect(initial.onMembership).not.toHaveBeenCalled();
  });

  it("lets only the top Sources dialog recapture outside Tab, then resumes details after dismissal", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props({ selected: { item: item(), mapIdentity: "map", metrics: [] } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const panel = screen.getByRole("dialog", { name: "Replay details Fixture map" });
    const outside = screen.getByRole("button", { name: "Sources" });
    fireEvent.click(outside);
    const sources = screen.getByRole("dialog", { name: "Sources" });
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(document.activeElement).toBe(within(sources).getByRole("button", { name: "Close Sources" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab", shiftKey: true });
    expect(sources.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(within(sources).getByRole("button", { name: "Close Sources" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(document.activeElement).toBe(outside);
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(panel.contains(document.activeElement)).toBe(true);
    rendered.unmount();
    const ordinary = document.createElement("button");
    document.body.append(ordinary);
    ordinary.focus();
    expect(fireEvent.keyDown(ordinary, { key: "Tab" })).toBe(true);
    ordinary.remove();
  });

  it("respects a prevented outside Tab instead of taking focus from another control", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<ReplayLibraryView {...props({ selected: { item: item(), mapIdentity: "map", metrics: [] } })} />);
    const outside = screen.getByRole("button", { name: "Sources" });
    outside.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => outside.dispatchEvent(event));
    expect(document.activeElement).toBe(outside);
  });
  it("ignores hidden or inert top dialogs when choosing the active modal", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<ReplayLibraryView {...props({ selected: { item: item(), mapIdentity: "map", metrics: [] } })} />);
    const outside = screen.getByRole("button", { name: "Sources" });
    fireEvent.click(outside);
    const sources = screen.getByRole("dialog", { name: "Sources" });
    const panel = screen.getByRole("dialog", { name: "Replay details Fixture map" });
    for (const attribute of ["hidden", "inert"]) {
      sources.setAttribute(attribute, "");
      outside.focus();
      fireEvent.keyDown(outside, { key: "Tab" });
      expect(panel.contains(document.activeElement)).toBe(true);
      sources.removeAttribute(attribute);
    }
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(sources.contains(document.activeElement)).toBe(true);
  });

  it("resumes overlay-sidebar Tab after its collection menu restores an outside opener", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    render(<ReplayLibraryView {...props()} />);
    const outside = screen.getByRole("button", { name: "Show library sidebar" });
    fireEvent.click(outside);
    const sidebar = screen.getByRole("dialog", { name: "Library views" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Options for Practice" }));
    const menu = document.querySelector(".lib-popover") as HTMLElement;
    expect(menu.contains(document.activeElement)).toBe(true);
    const buttons = within(menu).getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(within(sidebar).getByRole("button", { name: "Options for Practice" }));
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(sidebar.contains(document.activeElement)).toBe(true);
  });
});

describe("Sources opener restoration and counted labels", () => {
  const panelProps = () => {
    const selected = { item: item(), metrics: [], mapIdentity: "map" } as unknown as LibraryQueryDetail;
    return props({ selected, openError: { replayId: selected.item.id, reason: "exact-map-unavailable", message: "verified missing map" } });
  };
  const nextFrame = () => act(() => { jest.advanceTimersByTime(20); });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    { name: "header", initial: () => props(), label: "Sources" },
    { name: "source notice", initial: () => props({ sources: { ...props().sources, error: "source action failed" } }), label: "Open Sources" },
    { name: "empty library", initial: () => props({ page: { items: [], total: 0, analysisExcluded: 0 } }), label: "Open Sources" },
    { name: "analysis settings", initial: () => props({ page: { ...props().page, resultExcluded: { unknownOutcome: 0, missingBreakEvidence: 1 } } }), label: "Analysis settings" },
    { name: "missing-map panel", initial: panelProps, label: "Open Sources" },
  ])("returns Sources focus to the actual connected $name opener", ({ initial, label, name }) => {
    render(<ReplayLibraryView {...initial()} />);
    nextFrame();
    const opener = screen.getByRole("button", { name: name === "source notice" ? "Library activity details" : label });
    opener.focus();
    fireEvent.click(opener);
    if (name === "source notice") fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    nextFrame();
    expect(screen.queryByRole("dialog", { name: "Sources" })).toBeNull();
    expect(opener.isConnected).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to the header when the actual Sources opener was removed", () => {
    const initial = panelProps();
    const rendered = render(<ReplayLibraryView {...initial} />);
    const opener = screen.getByRole("button", { name: "Open Sources" });
    opener.focus();
    fireEvent.click(opener);
    rendered.rerender(<ReplayLibraryView {...initial} selected={null} openError={undefined} />);
    expect(opener.isConnected).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    nextFrame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sources" }));
  });

  it("does not let a queued close steal focus from a reopened Sources dialog", () => {
    render(<ReplayLibraryView {...panelProps()} />);
    const opener = screen.getByRole("button", { name: "Open Sources" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const currentDialog = screen.getByRole("dialog", { name: "Sources" });
    expect(currentDialog.contains(document.activeElement)).toBe(true);
    nextFrame();
    expect(currentDialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(currentDialog, { key: "Escape" });
    nextFrame();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sources" }));
  });

  it("cancels deferred Sources restoration on unmount without moving focus elsewhere", () => {
    const rendered = render(<ReplayLibraryView {...panelProps()} />);
    nextFrame();
    const opener = screen.getByRole("button", { name: "Open Sources" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    rendered.unmount();
    const nextScreenControl = document.createElement("button");
    document.body.append(nextScreenControl);
    nextScreenControl.focus();
    try {
      expect(jest.getTimerCount()).toBe(0);
      nextFrame();
      expect(document.activeElement).toBe(nextScreenControl);
    } finally {
      nextScreenControl.remove();
    }
  });

  it.each([
    { count: 0, label: "0 replays" },
    { count: 1, label: "1 replay" },
    { count: 2, label: "2 replays" },
  ])("uses the correct heading noun for $count indexed replays", ({ count, label }) => {
    const replay = item();
    render(<ReplayLibraryView {...props({ page: { items: count ? [replay] : [], total: count, analysisExcluded: 0 } })} />);
    expect(screen.getByRole("heading", { name: "Library", level: 1 }).nextElementSibling?.textContent).toBe(label);
  });

  it.each([
    { count: 1, plays: "1 play", replays: "1 replay", hint: "PP is known for 0 of 1 replay here; the rest are listed last." },
    { count: 2, plays: "2 plays", replays: "2 replays", hint: "PP is known for 0 of 2 replays here; the rest are listed last." },
  ])("uses the correct band, hint and tooltip nouns for $count replays", ({ count, plays, replays, hint }) => {
    const replay = item({ values: { ...item().values, pp: null }, band: { key: "unknown", label: "No PP data" } });
    const rendered = render(<ReplayLibraryView {...props({
      page: { items: [replay], total: count, analysisExcluded: 0 },
      bands: [{ key: "unknown", label: "No PP data", count, anchorId: replay.id }],
    })} />);
    expect(rendered.container.querySelector(".lib-band .lib-mono")?.textContent).toBe(plays);
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Jump to No PP data, ${replays}` }).title).toBe(`Jump to No PP data, ${replays}`);
  });

  it.each([
    { count: 0, label: "Remove Result: Passed · 0 replays" },
    { count: 1, label: "Remove Result: Passed · 1 replay" },
    { count: 2, label: "Remove Result: Passed · 2 replays" },
  ])("uses the correct passive removal count noun for $count replays", async ({ count, label }) => {
    render(<ReplayLibraryView {...props({
      query: { sort: "pp", direction: "desc", filters: [{ field: "result", values: ["passed"] }] },
      page: { items: [], total: 0, analysisExcluded: 0 },
      onPreview: async () => ({ count, analysisExcluded: 0 }),
    })} />);
    await flush();
    expect(screen.getByRole("button", { name: label }).hasAttribute("disabled")).toBe(false);
  });
});

describe("live-session layout and settlement regressions", () => {
  it("keeps PP band geometry and visible artwork IDs stable during idle refresh loading", () => {
    const replay = item({ band: { key: "unknown", label: "No PP data" } });
    const initial = props({
      page: {
        items: Array.from({ length: 40 }, (_, i) => ({ ...replay, id: `unknown-${i}` })),
        total: 100,
        analysisExcluded: 0,
        revision: "r1",
      },
      view: "list",
      bands: [
        { key: "known", label: "Under 300 pp", count: 2, anchorId: "known" },
        { key: "unknown", label: "No PP data", count: 98, anchorId: replay.id },
      ],
      onVisibleReplays: jest.fn(),
    });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const band = screen.getByText(/PP is known for/).closest(".lib-band") as HTMLElement;
    const height = band.style.height;
    const cards = within(screen.getByRole("table", { name: "Replays" })).getAllByRole("row", { name: /Fixture map/ });
    // Initial measured viewport settlement can change the virtual window once.
    // Only the subsequent idle refresh must leave its artwork demand unchanged.
    (initial.onVisibleReplays as jest.Mock).mockClear();
    rendered.rerender(<ReplayLibraryView {...initial} loading updating />);
    expect(screen.getByText(/PP is known for/).closest(".lib-band")).toBe(band);
    expect(band.style.height).toBe(height);
    const retained = within(screen.getByRole("table", { name: "Replays" })).getAllByRole("row", { name: /Fixture map/ });
    expect(retained).toHaveLength(cards.length);
    retained.forEach((card, i) => expect(card).toBe(cards[i]));
    expect(initial.onVisibleReplays).not.toHaveBeenCalled();
  });
  it("keeps completed removal actions stable and usable while a newer count batch is held", async () => {
    const pending: Array<(value: { count: number; analysisExcluded: number }) => void> = [];
    const preview = jest
      .fn()
      .mockResolvedValueOnce({ count: 11, analysisExcluded: 0 })
      .mockResolvedValueOnce({ count: 22, analysisExcluded: 0 })
      .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const initial = props({
      query: {
        filters: [
          { field: "result", values: ["passed"] },
          { field: "playedon", values: ["stable"] },
        ],
      },
      page: { items: [], total: 0, analysisExcluded: 0, revision: "r1" },
      onPreview: preview,
    });
    const rendered = render(<ReplayLibraryView {...initial} />);
    await flush();
    await flush();
    expect(screen.getByRole("button", { name: /Remove Result: Passed · 11 replays$/ })).toBeTruthy();
    rendered.rerender(<ReplayLibraryView {...initial} page={{ ...initial.page, revision: "r2" }} />);
    await flush();
    const refreshing = screen.getByRole("button", { name: /Remove Result: Passed · 11 replays$/ });
    refreshing.focus();
    expect((refreshing as HTMLButtonElement).disabled).toBe(false);
    for (const state of [{ loading: true }, { updating: true }, {}]) {
      rendered.rerender(<ReplayLibraryView {...initial} page={{ ...initial.page, revision: "r2" }} {...state} />);
      expect(screen.getByRole("button", { name: /Remove Result: Passed · 11 replays$/ })).toBe(refreshing);
      expect(document.activeElement).toBe(refreshing);
      expect((refreshing as HTMLButtonElement).disabled).toBe(false);
    }
    fireEvent.click(refreshing);
    expect(initial.onQueryChange).toHaveBeenCalledWith({
      ...initial.query,
      cursor: undefined,
      filters: [{ field: "playedon", values: ["stable"] }],
    });
    expect(screen.queryByText(/Checking/)).toBeNull();
    await act(async () => pending[0]({ count: 33, analysisExcluded: 0 }));
    await flush();
    expect(screen.queryByRole("button", { name: /Remove Result: Passed · 33 replays/ })).toBeNull();
    await act(async () => pending[1]({ count: 44, analysisExcluded: 0 }));
    await flush();
    expect(screen.getByRole("button", { name: /Remove Result: Passed · 33 replays$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove Played on: Stable · 44 replays$/ })).toBeTruthy();
  });
  it("dismisses My names with Escape from its focused input without persisting the draft", async () => {
    const save = jest.fn(async (names: string[]) => names);
    render(<Controlled initial={props({ myNames: { names: ["WinterBird"] }, onSaveMyNames: save })} />);
    fireEvent.click(screen.getByRole("button", { name: "Player Everyone" }));
    fireEvent.click(screen.getByRole("button", { name: /Manage my names/i }));
    const dialog = screen.getByRole("dialog", { name: "My names" });
    const input = within(dialog).getByRole("textbox");
    input.focus();
    fireEvent.change(input, { target: { value: "unsaved-long-draft" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "My names" })).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText("unsaved-long-draft")).toBeNull();
  });
  it.each(["query", "editor", "unmount"])(
    "fences an in-flight removal count when the %s changes with the real preview lane",
    async (change) => {
      jest.useFakeTimers();
      let finish!: (value: { count: number; analysisExcluded: number }) => void;
      const request = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ count: 7, analysisExcluded: 0 });
      const client = new LibraryQueryClient({ request }, { previewDelayMs: 0 });
      const initial = props({
        query: {
          filters: [
            { field: "result", values: ["passed"] },
            { field: "playedon", values: ["stable"] },
          ],
        },
        page: { items: [], total: 0, analysisExcluded: 0, revision: "r1" },
        onPreview: (query, draft) => client.preview(query, draft),
      });
      const rendered = render(<ReplayLibraryView {...initial} loading />);
      const settle = async () => {
        for (let cycle = 0; cycle < 5; cycle++)
          await act(async () => {
            jest.advanceTimersByTime(0);
            for (let turn = 0; turn < 10; turn++) await Promise.resolve();
          });
      };
      try {
        await settle();
        expect(request).not.toHaveBeenCalled();
        rendered.rerender(<ReplayLibraryView {...initial} />);
        await settle();
        expect(request).toHaveBeenCalledTimes(1);
        if (change === "query")
          rendered.rerender(<ReplayLibraryView {...initial} query={{ ...initial.query, search: "new query" }} />);
        if (change === "editor") fireEvent.click(screen.getByRole("button", { name: "Result: Passed" }));
        if (change === "unmount") rendered.unmount();
        await settle();
        await act(async () => finish({ count: 99, analysisExcluded: 0 }));
        await settle();
        expect(screen.queryByText(/99 (matching )?replays/)).toBeNull();
        if (change === "unmount") {
          expect(screen.queryByRole("button", { name: /Remove Result/ })).toBeNull();
          expect(request).toHaveBeenCalledTimes(1);
        } else if (change === "editor") {
          expect(within(screen.getByRole("dialog", { name: "Result" })).getByText("7 matching replays")).toBeTruthy();
          expect(request).toHaveBeenCalledTimes(2);
          expect(request.mock.calls[1][0].draft).toEqual({ field: "result", values: ["passed"] });
        } else {
          expect(screen.getByRole("button", { name: /Remove Result: Passed · 7 replays/ })).toBeTruthy();
          expect(screen.getByRole("button", { name: /Remove Played on: Stable · 7 replays/ })).toBeTruthy();
          expect(request).toHaveBeenCalledTimes(3);
        }
      } finally {
        rendered.unmount();
        client.dispose();
        jest.useRealTimers();
      }
    },
  );
  it("keeps filter removal usable when its passive count is unavailable", async () => {
    const preview = jest.fn().mockRejectedValueOnce(new Error("count unavailable")).mockResolvedValueOnce(undefined);
    const initial = props({
      query: {
        filters: [
          { field: "result", values: ["passed"] },
          { field: "playedon", values: ["stable"] },
        ],
      },
      page: { items: [], total: 0, analysisExcluded: 0 },
      onPreview: preview,
    });
    render(<ReplayLibraryView {...initial} />);
    await flush();
    await flush();
    expect(
      screen
        .getAllByRole("button", { name: /Remove .* · Count unavailable/ })
        .every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Remove Result: Passed · Count unavailable/ }));
    expect(initial.onQueryChange).toHaveBeenCalledWith({
      ...initial.query,
      cursor: undefined,
      filters: [{ field: "playedon", values: ["stable"] }],
    });
    expect(screen.queryByText(/Checking…/)).toBeNull();
  });
  it("settles serial removal previews during continuous real-client coordinator revisions without pulsing controls", async () => {
    jest.useFakeTimers();
    const changes$ = new Subject<{ revision: number; ready: boolean; resourceRevision: string }>();
    const initial = props(),
      previewRequests: LibraryRequest[] = [];
    let revision = "stable-r1",
      previewOffset = 0,
      holdPreview = false;
    let finishPreview!: () => void;
    const request = jest.fn(async (input: LibraryRequest): Promise<unknown> => {
      if (input.method === "query-preview") {
        previewRequests.push(input);
        if (holdPreview)
          await new Promise<void>((resolve) => {
            finishPreview = resolve;
          });
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          count: (input.query?.filters?.[0]?.field === "playedon" ? 11 : 22) + previewOffset,
          analysisExcluded: 0,
        };
      }
      if (input.method === "query-page") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { items: [], total: 0, analysisExcluded: 0, revision };
      }
      if (["query-bands", "query-facets", "query-collections"].includes(input.method))
        return { items: [], total: 0, revision };
      if (input.method === "status") return initial.sources.status;
      if (input.method === "analysis-settings") return initial.sources.analysis;
      if (input.method === "query-player-names") return { names: [] };
      throw new Error(`Unexpected request ${input.method}`);
    });
    const coordinator = new LibraryUiCoordinator(
      { request, changes$, setViewerVisible: jest.fn() },
      { navigate: jest.fn(), openReplay: jest.fn(async () => undefined) },
    );
    const advance = async (ms: number) => {
      for (let time = 0; time < ms; time += 5)
        await act(async () => {
          jest.advanceTimersByTime(5);
          for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        });
    };
    function Connected() {
      const state = useSyncExternalStore(
        (notify) => {
          const sub = coordinator.view.state$.subscribe(notify);
          return () => sub.unsubscribe();
        },
        () => coordinator.view.snapshot(),
      );
      const auxiliary = useSyncExternalStore(
        (notify) => {
          const sub = coordinator.state$.subscribe(notify);
          return () => sub.unsubscribe();
        },
        () => coordinator.snapshot(),
      );
      return (
        <ReplayLibraryView
          {...initial}
          query={state.query}
          page={state.page ?? { items: [], total: 0, analysisExcluded: 0 }}
          loading={state.loading || !state.page}
          updating={state.updating || auxiliary.updating}
          onPreview={(query, draft) => coordinator.query.preview(query, draft)}
        />
      );
    }
    coordinator.connect();
    let rendered: ReturnType<typeof render> | undefined;
    try {
      const entering = coordinator.enterLibrary();
      await advance(100);
      await entering;
      const committing = coordinator.commitQuery({
        filters: [
          { field: "result", values: ["passed"] },
          { field: "playedon", values: ["stable"] },
        ],
      });
      await advance(100);
      await committing;
      rendered = render(<Connected />);
      for (let cycle = 0; cycle < 10; cycle++) {
        act(() => changes$.next({ revision: cycle + 1, ready: true, resourceRevision: "same-artwork" }));
        await advance(100);
      }
      expect(screen.getByRole("button", { name: /Remove Result: Passed · 11 replays/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Remove Played on: Stable · 22 replays/ })).toBeTruthy();
      expect(previewRequests).toHaveLength(2);
      revision = "stable-r2";
      previewOffset = 22;
      holdPreview = true;
      act(() => changes$.next({ revision: 11, ready: true, resourceRevision: "same-artwork" }));
      await advance(250);
      expect(previewRequests).toHaveLength(3);
      const retained = screen.getByRole("button", { name: /Remove Result: Passed · 11 replays$/ });
      retained.focus();
      for (let cycle = 12; cycle < 16; cycle++) {
        revision = `stable-r${cycle}`;
        act(() => changes$.next({ revision: cycle, ready: true, resourceRevision: "same-artwork" }));
        await advance(100);
        expect(screen.getByRole("button", { name: /Remove Result: Passed · 11 replays$/ })).toBe(retained);
        expect((retained as HTMLButtonElement).disabled).toBe(false);
        expect(document.activeElement).toBe(retained);
        expect(rendered.container.querySelector(".lib-activity-title")?.textContent).toBe("Deep analysis Off");
        expect(screen.queryByText("Updating library")).toBeNull();
      }
      expect(previewRequests).toHaveLength(3);
      expect(screen.queryByText(/Checking/)).toBeNull();
      holdPreview = false;
      await act(async () => finishPreview());
      // Revisions keep advancing more frequently than a two-preview batch can finish.
      // Same-query work must complete and publish; it cannot wait for global idleness.
      for (let cycle = 16; cycle < 23; cycle++) {
        revision = `stable-r${cycle}`;
        act(() => changes$.next({ revision: cycle, ready: true, resourceRevision: "same-artwork" }));
        await advance(100);
        expect(screen.queryByText("Updating library")).toBeNull();
      }
      expect(screen.getByRole("button", { name: /Remove Result: Passed · 33 replays$/ })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Remove Played on: Stable · 44 replays$/ })).toBeTruthy();
      expect(previewRequests.length).toBeGreaterThanOrEqual(4);
      expect(previewRequests.length).toBeLessThanOrEqual(8);
      expect(
        request.mock.calls.every(
          ([input]) => input.method.startsWith("query-") || ["status", "analysis-settings"].includes(input.method),
        ),
      ).toBe(true);
    } finally {
      rendered?.unmount();
      coordinator.dispose();
      jest.useRealTimers();
    }
  });
  it("keeps the anchored popover scroll viewport above the client bottom after resizing", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () => ({ bottom: 270, left: 400 } as DOMRect);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 760 });
    const rendered = render(
      <LibraryPopover title="My names" anchor={anchor} onClose={jest.fn()}>
        <input data-initial-focus />
        <div style={{ height: 1200 }} />
        <button>Save names</button>
      </LibraryPopover>,
    );
    const dialog = screen.getByRole("dialog", { name: "My names" });
    try {
      expect(dialog.style.top).toBe("277px");
      expect(dialog.style.maxHeight).toBe("475px");
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      fireEvent(window, new Event("resize"));
      expect(Number.parseFloat(dialog.style.top) + Number.parseFloat(dialog.style.maxHeight)).toBe(492);
      expect(
        (styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<string, Record<string, unknown>>)[
          "& .lib-popover"
        ].overflow,
      ).toBe("auto");
      const footer = within(dialog).getByRole("button", { name: "Save names" });
      footer.focus();
      expect(document.activeElement).toBe(footer);
    } finally {
      rendered.unmount();
      expect(document.activeElement).toBe(anchor);
      anchor.remove();
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    }
  });
  it("emits the fifteen intended pixel spaces and radii through the installed application MUI theme", () => {
    const css = styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<string, Record<string, unknown>>;
    const expected = [
      ["& ::-webkit-scrollbar-thumb", "borderRadius", "5px"],
      ["& .lib-source-notice", "marginTop", "14px"],
      ["& .lib-problem", "borderRadius", "6px"],
      ["& .lib-problem", "padding", "10px"],
      ["& .lib-problem details", "marginTop", "8px"],
      ["& .lib-file-unavailable", "borderRadius", "3px"],
      ["& .lib-removal-suggestions", "marginBottom", "12px"],
      ["& .lib-name-row", "gap", "8px"],
      ["& .lib-name-row", "borderRadius", "5px"],
      ["& .lib-filter-footer", "marginTop", "16px"],
      ["& .lib-filter-footer", "paddingTop", "12px"],
      ["& .lib-search-suggestions", "borderRadius", "10px"],
      ["& .lib-search-suggestions", "padding", "12px"],
      ["& .lib-band-with-hint", "gap", "4px"],
      ["& .lib-judgement-counts", "marginTop", "14px"],
    ];
    expect(expected.map(([selector, property]) => css[selector][property])).toEqual(expected.map((row) => row[2]));
    expect(css["& .lib-header"].gap).toBe("18px");
    expect(css["& .lib-stat-value, & .lib-stat-value > .lib-mono"].fontSize).toBe(17);
  });
  it("keeps the hinted PP divider one pixel tall instead of growing down its column", () => {
    const css = styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<string, Record<string, unknown>>;
    const divider = { ...css["& .lib-band::after"], ...css["& .lib-band-with-hint::after"] };
    expect(divider).toMatchObject({ height: "1px", flex: "0 0 1px" });
    expect(css["& .lib-band-with-hint"].flexDirection).toBe("column");
  });
  it("explains confirmed exact-map absence on replay actions without presenting a query failure", () => {
    const selected = { item: item(), metrics: [], mapIdentity: "map" } as unknown as LibraryQueryDetail;
    const initial = props({ selected, openError: { replayId: selected.item.id, reason: "exact-map-unavailable", message: "verified missing map" } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    expect(screen.getByRole("button", { name: /Open in viewer/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Full-map analysis" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Show in folder" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/The exact beatmap for this replay isn't available/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
    const card = rendered.container.querySelector("[data-replay-id]") as HTMLElement;
    fireEvent.keyDown(card, { key: "Enter" }); fireEvent.doubleClick(card);
    expect(initial.onOpen).not.toHaveBeenCalled();
    rendered.rerender(<ReplayLibraryView {...initial} openError={undefined} />);
    expect(screen.getByRole("button", { name: /Open in viewer/ }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    expect(initial.onOpen).toHaveBeenCalledWith(selected.item.id, { fullMap: true });
  });
  it("keeps unclassified opening errors retryable with Details and does not infer a missing map from metrics", () => {
    const selected = { item: item({ values: { ...item().values, pp: null, sr: null } }), metrics: [], mapIdentity: null } as unknown as LibraryQueryDetail;
    render(<ReplayLibraryView {...props({ selected, openError: { replayId: selected.item.id, message: "raw opening failure" } })} />);
    expect(screen.getByText("The replay couldn't be opened.")).toBeTruthy();
    expect(screen.getByText("raw opening failure").closest("details")?.open).toBe(false);
    expect(screen.getByRole("button", { name: /Open in viewer/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
  });
  it.each([
    ["complete", "Source check complete"],
    ["stopped", "Scan stopped"],
    ["queued", "Library check queued"],
    ["scanning", "Checking sources"],
    ["waiting-for-viewer", "Waiting for viewer"],
    ["error", "Source needs attention"],
  ] as const)("keeps the %s source header stable through passive query refreshes", (sourceState, expected) => {
    const initial = props(),
      status = fixtureStatus(initial.sources);
    const sources = {
      ...initial.sources,
      status: { ...status, sources: [{ ...status.sources[0], state: sourceState }] },
    };
    const rendered = render(<ReplayLibraryView {...initial} sources={sources} />);
    const header = rendered.container.querySelector(".lib-activity-title");
    for (const state of [{ loading: true }, { updating: true }, { loading: true, updating: true }, {}]) {
      rendered.rerender(<ReplayLibraryView {...initial} sources={sources} {...state} />);
      expect(header?.textContent).toBe(libraryActivityModel(sources).title);
      expect(screen.getByText("Fixture map")).toBeTruthy();
    }
  });
  it("preserves rebuild failure and result error truth while background reads are pending", () => {
    const initial = props(),
      status = fixtureStatus(initial.sources);
    const rendered = render(
      <ReplayLibraryView
        {...initial}
        updating
        error="bounded query failure"
        sources={{
          ...initial.sources,
          status: { ...status, rebuild: { ...status.rebuild, state: "error", error: "bounded rebuild failure" } },
        }}
      />,
    );
    expect(rendered.container.querySelector(".lib-activity-title")?.textContent).toBe("Rebuild didn't finish");
    expect(screen.getByRole("alert").textContent).toContain("bounded query failure");
    expect(screen.getByRole("button", { name: "Refresh results" })).toBeTruthy();
  });
  it("reports a stopped partial index without claiming completion, and preserves status precedence", () => {
    const initial = props(),
      status = fixtureStatus(initial.sources);
    const sources = {
      ...initial.sources,
      status: { ...status, sources: [{ ...status.sources[0], state: "stopped" as const }] },
    };
    const rendered = render(<ReplayLibraryView {...initial} sources={sources} />);
    expect(rendered.container.querySelector(".lib-activity-title")?.textContent).toBe("Scan stopped");
    expect(screen.queryByText("Source check complete")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const expectStatus = (text: string) => {
      expect(rendered.container.querySelector(".lib-activity-title")).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Sources" }).querySelector(".lib-section > strong")?.textContent).toBe(text);
    };
    expectStatus("Scan stopped");
    expect(screen.queryByText("Library ready")).toBeNull();
    expect(screen.getByText("Fixture map")).toBeTruthy();
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{
          ...sources,
          status: {
            ...sources.status,
            sources: [...sources.status.sources, { ...status.sources[0], sourceId: "second", state: "scanning" }],
          },
        }}
      />,
    );
    expectStatus("Checking sources");
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{
          ...sources,
          status: {
            ...sources.status,
            sources: [
              ...sources.status.sources,
              { ...status.sources[0], sourceId: "second", state: "error", error: "unclassified" },
            ],
          },
        }}
      />,
    );
    expectStatus("Source needs attention");
    rendered.rerender(<ReplayLibraryView {...initial} />);
    expectStatus("Source check complete");
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{ ...initial.sources, status: { ...status, rebuild: { ...status.rebuild, state: "stopped" } } }}
      />,
    );
    expectStatus("Scan stopped");
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{
          ...sources,
          status: {
            ...sources.status,
            sources: sources.status.sources.map((source) => ({ ...source, enabled: false })),
          },
        }}
      />,
    );
    expectStatus("Library ready");
  });
  it.each([1279.333374, 1279.666626, 1280])(
    "uses matching CSS and modal boundaries at fractional width %s",
    (cssWidth) => {
      const original = window.matchMedia;
      // The native/innerWidth integer can disagree with CSS's fractional viewport.
      Object.defineProperty(window, "innerWidth", { configurable: true, value: Math.round(cssWidth) });
      window.matchMedia = jest.fn(
        (query: string) =>
          ({
            matches: query.includes("1280") ? cssWidth < 1280 : false,
            media: query,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
          } as unknown as MediaQueryList),
      );
      const initial = props({ selected: { item: item(), mapIdentity: "map", metrics: [] } });
      const rendered = render(<ReplayLibraryView {...initial} />);
      try {
        const panel = rendered.container.querySelector(".lib-panel");
        expect(panel?.getAttribute("aria-modal")).toBe(cssWidth < 1280 ? "true" : null);
        const css = styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<
          string,
          Record<string, Record<string, unknown>>
        >;
        expect(css["@media not all and (min-width: 1280px)"]?.["& .lib-panel"].position).toBe("fixed");
        expect(window.matchMedia).toHaveBeenCalledWith("not all and (min-width: 1280px)");
      } finally {
        rendered.unmount();
        window.matchMedia = original;
      }
    },
  );
  it("uses the same fractional sidebar boundary and preserves the inclusive 760px compact rule", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    window.matchMedia = jest.fn(
      (query: string) =>
        ({
          matches: query.includes("900") || query.includes("1280"),
          media: query,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        } as unknown as MediaQueryList),
    );
    const rendered = render(<ReplayLibraryView {...props()} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show library sidebar" }));
      expect(screen.getByRole("dialog", { name: "Library views" })).toBeTruthy();
      const css = styleFunctionSx({ sx: libraryViewSx, theme: rewindTheme }) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(css["@media not all and (min-width: 900px)"]?.["& .lib-sidebar"].position).toBe("fixed");
      expect(css["& .lib-header-status"]["@media not all and (min-width: 900px)"].display).toBe("none");
      expect(css["@media (max-width: 760px)"]?.["& .lib-rail, & .lib-hide-small"].display).toBe("none");
    } finally {
      rendered.unmount();
      window.matchMedia = original;
    }
  });
});

describe("closeout source and availability states", () => {
  it("keeps unclassified result errors behind Details and refreshes explicitly", () => {
    const initial = props({ error: "unclassified query failure" });
    render(<ReplayLibraryView {...initial} />);
    expect(screen.getByText("Library results couldn't be read.")).toBeTruthy();
    expect(screen.getByText("unclassified query failure").closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    expect(initial.onQueryChange).toHaveBeenCalledWith(initial.query);
  });
  it("does not let retained dirty intent or an unused import bucket mask terminal failed or healthy empty sources", () => {
    const initial = props(),
      status = fixtureStatus(initial.sources),
      retainedUpdate = Object.freeze({ active: false, pending: true, stopped: false }),
      failed = { ...status.sources[0], state: "error" as const, error: "unknown", observations: 0, update: retainedUpdate },
      emptyImport = {
        ...failed,
        sourceId: "imported",
        kind: "imported" as const,
        state: "idle" as const,
        error: undefined,
        hasIndexHistory: false,
        update: { active: false, pending: false, stopped: false },
      };
    const rendered = render(
      <ReplayLibraryView
        {...initial}
        page={{ items: [], total: 0, analysisExcluded: 0 }}
        sources={{ ...initial.sources, status: { ...status, replayCount: 0, sources: [failed, emptyImport] } }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Hindsight can't read your sources" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Preparing your replay library" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show library problems" }).textContent).toContain("1 source");
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        page={{ items: [], total: 0, analysisExcluded: 0 }}
        sources={{
          ...initial.sources,
          status: {
            ...status,
            replayCount: 0,
            sources: [failed, emptyImport, {
              ...failed, sourceId: "healthy", kind: "replays", state: "complete", error: undefined,
              update: { active: false, pending: false, stopped: false },
            }],
          },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "No replays found" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Preparing your replay library" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show library problems" }).textContent).toContain("1 source");
    expect(failed.update).toBe(retainedUpdate);
    expect(retainedUpdate).toEqual({ active: false, pending: true, stopped: false });
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each([
    ["automatic", false, "No replays found", false],
    ["configured", false, "Hindsight can't read your sources", true],
    ["automatic", true, "Hindsight can't read your sources", true],
  ] as const)("classifies a dirty missing native source with %s configuration and history=%s", (configuration, hasIndexHistory, heading, notice) => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    const status = fixtureStatus(initial.sources);
    const native = {
      ...status.sources[0], sourceId: "native", kind: "lazer" as const, observations: 0,
      state: "error" as const, configuration, hasIndexHistory, failureReason: "source-missing" as const,
      error: "missing native data", update: { active: false, pending: true, stopped: false },
    };
    const healthy = { ...status.sources[0], observations: 0 };
    const rendered = render(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources: notice ? [native] : [native, healthy],
    } }} />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(!!screen.queryByRole("button", { name: "Show library problems" })).toBe(notice);
    expect(screen.queryByRole("heading", { name: "Preparing your replay library" })).toBeNull();
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources: [native, healthy],
    } }} />);
    expect(screen.getByRole("heading", { name: "No replays found" })).toBeTruthy();
    expect(!!screen.queryByRole("button", { name: "Show library problems" })).toBe(notice);
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("keeps a healthy empty Replays source visible despite another terminal dirty failure", () => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    const status = fixtureStatus(initial.sources);
    const failed = {
      ...status.sources[0], observations: 0, state: "error" as const, error: "read failed",
      update: { active: false, pending: true, stopped: false },
    };
    render(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources: [failed, {
        ...status.sources[0], sourceId: "healthy-replays", kind: "replays", observations: 0,
      }],
    } }} />);
    expect(screen.getByRole("heading", { name: "No replays found" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show library problems" }).textContent).toContain("1 source");
    expect(screen.queryByRole("heading", { name: "Preparing your replay library" })).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("explains a majority unknown PP band using complete current counts and changes to date sort", () => {
    const replay = item({ band: { key: "unknown", label: "No PP data" } }),
      initial = props({
        page: { items: [replay], total: 2747, analysisExcluded: 0 },
        bands: [
          { key: "known", label: "Under 300 pp", count: 2, anchorId: "known" },
          { key: "unknown", label: "No PP data", count: 2745, anchorId: replay.id },
        ],
      });
    const rendered = render(<ReplayLibraryView {...initial} />);
    expect(screen.getByText("PP is known for 2 of 2,747 replays here; the rest are listed last.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sort by date played" }));
    expect(initial.onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ sort: "date", direction: "desc" }));
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        page={{ ...initial.page, total: 4 }}
        bands={[
          { key: "known", label: "Under 300 pp", count: 2, anchorId: "known" },
          { key: "unknown", label: "No PP data", count: 2, anchorId: replay.id },
        ]}
      />,
    );
    expect(screen.queryByText(/PP is known for/)).toBeNull();
  });
  it("shows the actual import summary once and clears it when Sources closes", async () => {
    const initial = props({
      onSourceAction: jest.fn(async () => ({
        added: 3,
        alreadyImported: 2,
        failed: 1,
        failures: [{ path: "C:/owned/unreadable.osr", error: "unclassified raw failure" }],
        truncatedFailures: false,
      })),
    });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Import replays…" }));
    await flush();
    const summary = screen.getByText("Imported 3 replays. 2 were already in your library. 1 couldn't be imported.");
    expect(summary.getAttribute("role")).toBe("status");
    expect(screen.getByText("unreadable.osr · Couldn't import this file.")).toBeTruthy();
    expect(screen.getByText("unclassified raw failure").closest("details")?.open).toBe(false);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    expect(screen.queryByText(/Imported 3 replays/)).toBeNull();
  });
  it("keeps the import status mounted before completion and clears each attempt without moving focus", async () => {
    let finish: ((summary: LibraryImportSummary) => void) | undefined;
    const initial = props({
      onSourceAction: jest.fn(() => new Promise<LibraryImportSummary>((resolve) => { finish = resolve; })),
    });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    const region = within(dialog).queryByRole("status", { name: "Replay import" });
    expect(region).not.toBeNull();
    if (!region) throw new Error("Expected the empty import live region before completion");
    expect(region.textContent).toBe("");
    expect(region.closest('[hidden],[aria-hidden="true"]')).toBeNull();
    const retainedFocus = within(dialog).getByRole("button", { name: "Close Sources" });
    const summary: LibraryImportSummary = {
      added: 0, alreadyImported: 1, failed: 1,
      failures: [{ path: "C:/owned/corrupt.osr", error: "Invalid replay" }],
      truncatedFailures: false,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import replays…" }));
      await flush();
      expect(within(dialog).getByRole("status", { name: "Replay import" })).toBe(region);
      expect(region.textContent).toBe("");
      retainedFocus.focus();
      const complete = finish;
      await act(async () => complete?.(summary));
      expect(within(dialog).getByRole("status", { name: "Replay import" })).toBe(region);
      expect(region.textContent).toBe("Imported 0 replays. 1 was already in your library. 1 couldn't be imported.");
      expect(within(dialog).getAllByText(/Imported 0 replays/)).toHaveLength(1);
      expect(document.activeElement).toBe(retainedFocus);
    }
    fireEvent.keyDown(dialog, { key: "Escape" });
    await flush();
    expect(region.isConnected).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    const reopened = within(screen.getByRole("dialog", { name: "Sources" })).getByRole("status", { name: "Replay import" });
    expect(reopened).not.toBe(region);
    expect(reopened.textContent).toBe("");
  });
  it("uses singular wording for one imported and one duplicate replay", async () => {
    render(<ReplayLibraryView {...props({ onSourceAction: jest.fn(async () => ({ added: 1, alreadyImported: 1, failed: 0, failures: [], truncatedFailures: false })) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" })); await flush();
    fireEvent.click(screen.getByRole("button", { name: "Import replays…" })); await flush();
    expect(within(screen.getByRole("dialog", { name: "Sources" })).getByRole("status", { name: "Replay import" }).textContent).toContain("Imported 1 replay. 1 was already in your library.");
    expect(screen.getByText("1 duplicate replay was already in your library.")).toBeTruthy();
  });
  it("treats only a never-configured missing automatic native source as quiet Not found", async () => {
    const initial = props(),
      status = fixtureStatus(initial.sources),
      native = {
        ...status.sources[0],
        kind: "lazer" as const,
        state: "error" as const,
        configuration: "automatic" as const,
        hasIndexHistory: false,
        failureReason: "source-missing" as const,
        error: "raw missing database",
      };
    const rendered = render(
      <ReplayLibraryView {...initial} sources={{ ...initial.sources, status: { ...status, sources: [native] } }} />,
    );
    expect(screen.queryByRole("button", { name: "Show library problems" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    expect(screen.getByText("Not found")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    await flush();
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{ ...initial.sources, status: { ...status, sources: [{ ...native, hasIndexHistory: true }] } }}
      />,
    );
    expect(screen.getByRole("button", { name: "Show library problems" })).toBeTruthy();
  });
  const failedSources = () => {
    const initial = props();
    const status = fixtureStatus(initial.sources);
    return {
      ...initial.sources,
      status: {
        ...status,
        replayCount: 0,
        sources: status.sources.map((source) => ({
          ...source,
          state: "error" as const,
          error: "EUNKNOWN private diagnostic",
          observations: 0,
        })),
      },
    };
  };
  it("distinguishes unreadable sources from an empty healthy library and exposes diagnostics only in Details", async () => {
    render(
      <ReplayLibraryView
        {...props({ page: { items: [], total: 0, analysisExcluded: 0 }, sources: failedSources() })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Hindsight can't read your sources" })).toBeTruthy();
    expect(screen.queryByText("No replays found")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Open Sources" })[0]);
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    expect(within(dialog).getByText("Couldn't read this source")).toBeTruthy();
    const detail = within(dialog).getByText("EUNKNOWN private diagnostic").closest("details");
    expect(detail).toBeTruthy();
    expect(detail?.open).toBe(false);
    expect(within(dialog).queryByText(/moved|deleted|can't be opened until/)).toBeNull();
  });
  it("keeps indexed rows available while a source fails and clears its notice after recovery", () => {
    const initial = props({ sources: failedSources() }),
      rendered = render(<ReplayLibraryView {...initial} />);
    expect(within(screen.getByRole("listbox", { name: "Replays" })).getByRole("option")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show library problems" })).toBeTruthy();
    expect(screen.queryByText("FILE UNAVAILABLE")).toBeNull();
    rendered.rerender(<ReplayLibraryView {...props()} />);
    expect(screen.queryByRole("button", { name: "Show library problems" })).toBeNull();
  });
  it("shows a failed rebuild without promising previous-index safety", async () => {
    const source = props().sources;
    render(
      <ReplayLibraryView
        {...props({
          sources: {
            ...source,
            status: {
              ...fixtureStatus(source),
              rebuild: { state: "error", observations: 0, mapErrors: {}, error: "raw rebuild diagnostic" },
            },
          },
        })}
      />,
    );
    expect(screen.getByRole("status", { name: "Library activity" }).textContent).toBe("Rebuild didn't finish");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    expect(screen.getByText("The last rebuild didn't finish.")).toBeTruthy();
    expect(screen.getByText("raw rebuild diagnostic").closest("details")?.open).toBe(false);
    expect(screen.queryByText(/previous index|nothing was lost|collections are safe/i)).toBeNull();
  });
  it("keeps failed rebuild Details in the forward and backward modal focus boundary", async () => {
    const initial = props();
    if (!initial.sources.status) throw new Error("Expected source fixture");
    initial.sources.status.rebuild = {
      state: "error",
      observations: 0,
      mapErrors: {},
      error: "raw rebuild diagnostic",
    };
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    const rebuild = within(dialog).getByRole("button", { name: "Rebuild index…" });
    const details = within(dialog).getByText("Details");
    const close = within(dialog).getByRole("button", { name: "Close Sources" });
    rebuild.focus();
    // The browser's next native Tab target is Summary; the trap must not wrap early.
    expect(fireEvent.keyDown(rebuild, { key: "Tab" })).toBe(true);
    details.focus();
    expect(document.activeElement).toBe(details);
    expect(fireEvent.keyDown(details, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(details);
  });
  it("reports ordinary source action errors without inferring a disconnected service", async () => {
    const initial = props();
    initial.sources.error = "Library import recovery is pending";
    render(<ReplayLibraryView {...initial} />);
    expect(screen.queryByText(/can't reach its library service/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await flush();
    expect(screen.getByText("The library action didn't finish.")).toBeTruthy();
    expect(screen.getByText(initial.sources.error).closest("details")?.open).toBe(false);
    expect(screen.queryByText(/can't reach its library service/i)).toBeNull();
  });
  it("presents an import rejection in its dedicated block and clears it on a later attempt", async () => {
    const onSourceAction = jest
      .fn()
      .mockRejectedValueOnce(new Error("Library import recovery is pending"))
      .mockResolvedValueOnce({ added: 1, alreadyImported: 0, failed: 0, failures: [], truncatedFailures: false });
    render(<ReplayLibraryView {...props({ onSourceAction })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Import replays…" }));
    await flush();
    expect(screen.getByText("The import didn't finish.")).toBeTruthy();
    expect(screen.getByText("Library import recovery is pending").closest("details")?.open).toBe(false);
    expect(screen.queryByText(/can't reach its library service/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import replays…" }));
    await flush();
    expect(screen.queryByText("The import didn't finish.")).toBeNull();
    expect(
      screen.getByText("Imported 1 replay. 0 were already in your library. 0 couldn't be imported."),
    ).toBeTruthy();
  });
  it("labels unavailable grid/list files and never opens them with Enter or double click", async () => {
    const replay = item({ available: false });
    const initial = props({ page: { items: [replay], total: 1, analysisExcluded: 0 } });
    const rendered = render(<Controlled initial={initial} />);
    expect(screen.getByText("FILE UNAVAILABLE")).toBeTruthy();
    const card = within(screen.getByRole("listbox", { name: "Replays" })).getByRole("option");
    fireEvent.keyDown(card, { key: "Enter" });
    await flush();
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.doubleClick(card);
    expect(initial.onOpen).not.toHaveBeenCalled();
    for (const name of ["Open in viewer", "Full-map analysis", "Show in folder"]) {
      const button = screen.getByRole("button", { name: new RegExp(name) }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-describedby")).toBeTruthy();
    }
    rendered.unmount();
    render(<ReplayLibraryView {...props({ ...initial, view: "list" })} />);
    expect(screen.getByText("FILE UNAVAILABLE")).toBeTruthy();
  });
  it("hides list columns for an empty view and shows actual first-index counts", () => {
    const initial = props();
    const status = fixtureStatus(initial.sources);
    render(
      <ReplayLibraryView
        {...props({
          view: "list",
          page: { items: [], total: 0, analysisExcluded: 0 },
          sources: {
            ...initial.sources,
            status: {
              ...status,
              sources: status.sources.map((source) => ({ ...source, state: "scanning", observations: 17 })),
            },
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accuracy" })).toBeNull();
    expect(screen.getAllByText(/17 records read/).length).toBeGreaterThan(0);
  });
  it("uses passive per-filter removal previews and rejects stale counts", async () => {
    let stale: ((value: { count: number; analysisExcluded: number }) => void) | undefined;
    const preview = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stale = resolve;
          }),
      )
      .mockResolvedValue({ count: 7, analysisExcluded: 0 });
    const initial = props({
      query: { filters: [{ field: "miss", op: "atMost", a: 0, b: null }] },
      page: { items: [], total: 0, analysisExcluded: 0 },
      onPreview: preview,
    });
    const rendered = render(<ReplayLibraryView {...initial} />);
    await flush();
    expect(preview).toHaveBeenCalledWith({ filters: [], cursor: undefined });
    rendered.rerender(
      <ReplayLibraryView {...initial} query={{ filters: [{ field: "ur", op: "atMost", a: 80, b: null }] }} />,
    );
    await flush();
    await act(async () => stale?.({ count: 99, analysisExcluded: 0 }));
    const suggestion = screen.getByRole("button", { name: /Remove UR: ≤ 80 · 7 replays/ });
    fireEvent.click(suggestion);
    expect(initial.onQueryChange).toHaveBeenCalledWith({ filters: [], cursor: undefined });
    expect(screen.queryByText(/99 replays/)).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("describes missing data without declaring every replay unanalysed", () => {
    render(
      <ReplayLibraryView
        {...props({
          page: { items: [item()], total: 1, analysisExcluded: 1200 },
          query: { filters: [{ field: "len", min: 0, max: 120 }] },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove Length filter" })).toBeTruthy();
    expect(screen.getByText(/1,200 replays lack data needed.*Filtering doesn't start analysis\./)).toBeTruthy();
    expect(screen.queryByText(/aren't analysed yet/)).toBeNull();
  });
});

describe("closeout twenty-filter addendum", () => {
  it.each([
    {
      term: "a",
      labels: [
        "Star rating",
        "Accuracy",
        "Date played",
        "Ranked status",
        "Mapper",
        "Grade",
        "Player",
        "Played on",
        "Timing bias",
        "Review state",
        "Analysis state",
      ],
    },
    { term: "at", labels: ["Star rating", "Date played", "Ranked status", "Review state", "Analysis state"] },
  ])("keeps unrestricted directory matches for $term independently of search typeahead", async ({ term, labels }) => {
    render(<ReplayLibraryView {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Find a filter" }), { target: { value: term } });
    await flush();
    const matches = within(dialog)
      .getAllByRole("button")
      .filter((button) => button.classList.contains("lib-menu-item"));
    expect(matches.map((button) => button.textContent).sort()).toEqual([...labels].sort());
  });
  it("dismisses search suggestions before a retained replay panel", async () => {
    const initial = props({ selected: { item: item(), metrics: [], mapIdentity: "map" } });
    render(<Controlled initial={initial} />);
    const input = screen.getByRole("textbox", { name: "Search replays" });
    fireEvent.focus(input);
    const suggestion = screen.getByRole("button", { name: "Star rating" });
    suggestion.focus();
    fireEvent.keyDown(suggestion, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("button", { name: "Browse all filters" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Replay details Fixture map" })).toBeTruthy();
    expect(initial.onSelect).not.toHaveBeenCalled();
  });
  it("consumes fc only when choosing the Result editor and never suggests Incidents", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    const input = screen.getByRole("textbox", { name: "Search replays" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "fc" } });
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ search: "fc" }));
    fireEvent.click(screen.getByRole("button", { name: "Result" }));
    expect(screen.getByRole("dialog", { name: "Result" })).toBeTruthy();
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ search: "" }));
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /^FC/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "", filters: [{ field: "result", values: ["fc"] }] }),
    );
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "incidents>=3" } });
    await flush();
    expect(screen.queryByRole("button", { name: "Incidents" })).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("explicitly converts typed syntax into chips while preserving residual search and unrelated filters", async () => {
    const initial = props({
      query: {
        sort: "pp",
        filters: [
          { field: "grade", values: ["S"] },
          { field: "result", values: ["failed"] },
        ],
      },
    });
    render(<Controlled initial={initial} />);
    const input = screen.getByRole("textbox", { name: "Search replays" });
    const text = "ANiMA result:passed playedon:stable,unknown";
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: text } });
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: text, filters: initial.query.filters }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Turn these into 2 filters/ }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: "ANiMA",
        filters: [
          { field: "grade", values: ["S"] },
          { field: "result", values: ["passed"] },
          { field: "playedon", values: ["stable", "unknown"] },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Result: Passed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Played on: Stable, Unknown" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn these into/ })).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("retains unrelated and quoted words when choosing a field suggestion", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    const input = screen.getByRole("textbox", { name: "Search replays" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ANiMA "fc replay" result' } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Result" }));
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'ANiMA "fc replay"' }));
  });
  it.each(['"result:passed"', "result:invalid", 'player:"unfinished'])(
    "keeps %s literal and offers no invalid conversion",
    async (text) => {
      const initial = props();
      render(<Controlled initial={initial} />);
      const input = screen.getByRole("textbox", { name: "Search replays" });
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: text } });
      await flush();
      expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ search: text }));
      expect(screen.queryByRole("button", { name: /Turn (this|these) into/ })).toBeNull();
    },
  );
  it("chooses several recording clients and removes the unrestricted Played on filter", async () => {
    const initial = props({
      onFacets: jest.fn(async () => ({
        items: [
          { value: "stable", count: 5 },
          { value: "lazer", count: 3 },
          { value: "unknown", count: 2 },
        ],
      })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Played on" }));
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Stable/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Unknown/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ field: "playedon", values: ["stable", "unknown"] }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Played on: Stable, Unknown" }));
    await flush();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Stable/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Unknown/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: [] }));
  });
  it("retains an ordinary proven FC without map max and does not present absent names as inferred identity", () => {
    render(
      <ReplayLibraryView
        {...props({
          page: { items: [item({ fullCombo: true, perfectCombo: null })], total: 1, analysisExcluded: 0 },
          query: { filters: [{ field: "player", values: [], me: true }] },
          myNames: { names: [] },
        })}
      />,
    );
    expect(screen.getByText("FC", { selector: "span" })).toBeTruthy();
    expect(screen.queryByTitle("Perfect combo")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Player: Me · no names" })).toHaveLength(2);
  });
  it("has twenty directory filters, no Incidents, and single-choice Result with All removing it", async () => {
    const initial = props({
      onFacets: jest.fn(async (field) => ({
        items:
          field === "result"
            ? [
                { value: "all", count: 19 },
                { value: "passed", count: 15 },
                { value: "fc", count: 3 },
                { value: "failed", count: 2 },
                { value: "unknown", count: 2 },
              ]
            : [],
      })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    await flush();
    expect(LIBRARY_FILTER_FIELDS).toHaveLength(20);
    expect(screen.queryByRole("button", { name: "Incidents" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a filter" }), { target: { value: "incident" } });
    expect(screen.queryByRole("button", { name: /Incidents/ })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a filter" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Result/ }));
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /^FC/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ field: "result", values: ["fc"] }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Result: FC" }));
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: [] }));
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("saves only explicitly entered Me names and keeps the literal player me independent", async () => {
    const initial = props({
      myNames: { names: [] },
      onSaveMyNames: jest.fn(async (names) => names),
      onFacets: jest.fn(async () => ({
        items: [
          { value: "me", count: 2 },
          { value: "lark_old", count: 3 },
        ],
      })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Player Everyone" }));
    await flush();
    expect(screen.getByText(/Hindsight doesn't guess/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up Me" }));
    const input = screen.getByRole("textbox", { name: "Add a name" });
    fireEvent.change(input, { target: { value: "lark_old" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Save and use Me" }));
    await flush();
    expect(initial.onSaveMyNames).toHaveBeenCalledWith(["lark_old"]);
    fireEvent.click(screen.getByRole("checkbox", { name: /^me\b/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ field: "player", values: ["me"], me: true }] }),
    );
    expect(screen.getAllByRole("button", { name: 'Player: Me, "me"' })).toHaveLength(2);
  });
  it.each([0, 1, 2])("uses the correct replay noun for the Player Me count %i", async (count) => {
    const initial = props({
      myNames: { names: ["Recorder"] },
      onSaveMyNames: jest.fn(async (names) => names),
      onPreview: jest.fn(async () => ({ count, analysisExcluded: 0 })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Player Everyone" }));
    await flush();
    const me = screen.getByRole("checkbox", { name: "Me" });
    expect(me.closest("label")?.textContent).toContain(`${count} ${count === 1 ? "replay" : "replays"}`);
    expect(me.closest("label")?.textContent).not.toContain("1 replays");
    expect(initial.onSaveMyNames).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each([5, 100])("keeps Me named separately from its complete long alias description and resolved count (%i names)", async (count) => {
    const names = ["WinterBird", "WinterBird01", "[Clouddi]", "Osu727", "long".repeat(64),
      ...Array.from({ length: count - 5 }, (_, i) => `Former name ${i}`)];
    let resolveCount!: (value: { count: number; analysisExcluded: number }) => void;
    const initial = props({
      myNames: { names },
      onSaveMyNames: jest.fn(async (value) => value),
      onPreview: jest.fn(() => new Promise((resolve) => { resolveCount = resolve; })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Player Everyone" }));
    await flush();
    const me = screen.getByRole("checkbox", { name: "Me" }) as HTMLInputElement;
    const description = () => (me.getAttribute("aria-describedby") ?? "").split(" ")
      .map(id => document.getElementById(id)?.textContent).join(" ");
    expect(description()).toContain(names.join(", "));
    expect(description()).toContain("—");
    await act(async () => resolveCount({ count: 7614, analysisExcluded: 0 }));
    expect(description()).toContain("7,614 replays");
    fireEvent.click(me);
    expect(me.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Manage my names" }));
    expect(screen.getByRole("button", { name: `Remove name ${names[4]}` })).toBeTruthy();
    expect(initial.onSaveMyNames).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("offers local mod icons as named native checkbox choices including Relax", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Mods" });
    const hidden = within(dialog).getByRole("checkbox", { name: "Hidden (HD)" }) as HTMLInputElement;
    const relax = within(dialog).getByRole("checkbox", { name: "Relax (RX)" }) as HTMLInputElement;
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(13);
    for (const name of ["Double Time (DT)", "Nightcore (NC)", "Sudden Death (SD)", "Perfect (PF)"])
      expect(within(dialog).getByRole("checkbox", { name })).toBeTruthy();
    for (const input of [hidden, relax]) {
      expect(input.tagName).toBe("INPUT");
      expect(input.type).toBe("checkbox");
      expect(input.tabIndex).toBe(0);
      const icon = input.closest("label")?.querySelector("img");
      expect(icon?.getAttribute("src")).toMatch(/^data:image\//);
      expect(icon?.getAttribute("alt")).toBe("");
    }
    act(() => relax.focus());
    fireEvent.click(relax);
    expect(document.activeElement).toBe(relax);
    expect(relax.checked).toBe(true);
    fireEvent.click(hidden);
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: [{ field: "mods", mode: "includes", match: "all", mods: ["RX", "HD"] }],
    }));
  });
  it.each(["hover", "focus"])("shows the full mod name on icon %s without changing selection", async (trigger) => {
    render(<Controlled initial={props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    const relax = screen.getByRole("checkbox", { name: "Relax (RX)" }) as HTMLInputElement;
    const label = relax.closest("label");
    if (!label) throw new Error("Expected the mod choice label");
    if (trigger === "hover") fireEvent.mouseOver(label);
    else act(() => relax.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Relax (RX)");
    expect(relax.checked).toBe(false);
  });
  it.each([0, 1, 2])("uses the correct replay noun throughout My names for count %i", async (count) => {
    const initial = props({
      myNames: { names: ["Recorder"] },
      onSaveMyNames: jest.fn(async (names) => names),
      onPreview: jest.fn(async () => ({ count, analysisExcluded: 0 })),
      onFacets: jest.fn(async () => ({ items: [{ value: "Candidate", count }] })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Player Everyone" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Manage my names" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "My names" });
    const copy = `${count} ${count === 1 ? "replay" : "replays"}`;
    const recorder = within(dialog).getByText("Recorder").closest(".lib-name-row");
    expect(recorder?.textContent).toContain(copy);
    expect(recorder?.textContent).not.toContain("1 replays");
    expect(within(dialog).getByText(`Me would match ${copy}`)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Add a name" }), {
      target: { value: "Candidate" },
    });
    await flush();
    expect(within(dialog).getByRole("button", { name: `Candidate ${copy}` })).toBeTruthy();
    expect(initial.onSaveMyNames).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("uses recording-client provenance and explains unavailable Result evidence without queuing", () => {
    const replay = item({
      sourceKinds: ["lazer"],
      recordingClient: "stable",
      completion: null,
      perfectCombo: true,
      fullCombo: true,
    });
    render(
      <ReplayLibraryView
        {...props({
          selected: { item: replay, metrics: [], mapIdentity: null },
          query: { filters: [{ field: "result", values: ["fc"] }] },
          page: {
            items: [replay],
            total: 1,
            analysisExcluded: 0,
            resultExcluded: { unknownOutcome: 2, missingBreakEvidence: 3 },
          },
        })}
      />,
    );
    expect(screen.getByText("STABLE")).toBeTruthy();
    expect(screen.queryByText("FC", { selector: "span" })).toBeNull();
    expect(screen.getAllByTitle("Perfect combo").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Result: Unknown" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Analysis settings" })).toBeTruthy();
  });
});

describe("ReplayLibraryView v34 controlled view", () => {
  it("keeps the toolbar at rest when indexing changes the bounded window's absolute position", () => {
    const geometry = jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return { top: this.classList.contains("lib-results") ? 220 : 0 } as DOMRect;
      });
    try {
      const initial = props({ pageStart: 0, onScrollTopChange: jest.fn() });
      const rendered = render(<ReplayLibraryView {...initial} />);
      const main = screen.getByRole("main", { name: "Replay library" });
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
      rendered.rerender(<ReplayLibraryView {...initial} pageStart={64} page={{ ...initial.page, items: [item()] }} />);
      expect(main.scrollTop).toBe(0);
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search replays" }));
      expect(initial.onScrollTopChange).not.toHaveBeenCalledWith(220);
    } finally {
      geometry.mockRestore();
    }
  });
  it("does not replay an explicit reveal after the user scrolls back to the toolbar during indexing", () => {
    const items = Array.from({ length: 8 }, (_, n) => item({ id: `reveal-${n}` }));
    const initial = props({
      view: "list",
      page: { items, total: 8, analysisExcluded: 0 },
      revealRequest: { id: "reveal-5", position: 5, sequence: 1 },
    });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const main = screen.getByRole("main", { name: "Replay library" });
    expect(main.scrollTop).toBeGreaterThan(0);
    fireEvent.scroll(main, { target: { scrollTop: 0 } });
    rendered.rerender(<ReplayLibraryView {...initial} page={{ ...initial.page, items: [...items] }} />);
    expect(main.scrollTop).toBe(0);
  });
  it("keeps every list metric in the same cell with and without mod badges", () => {
    const initial = props({
      view: "list",
      page: {
        items: [item({ id: "modded", title: "Modded" }), item({ id: "no-mods", title: "No mods", mods: [] })],
        total: 2,
        analysisExcluded: 0,
      },
    });
    render(<ReplayLibraryView {...initial} />);
    for (const name of [/Modded,/, /No mods,/]) {
      const cells = screen.getByRole("row", { name }).children;
      expect(cells).toHaveLength(15);
      expect(cells[7].textContent).toBe("100.00");
      expect(cells[13].getAttribute("title")).toBe(new Date(1700000000000).toLocaleString());
    }
  });
  it("explains an empty Recent scope and offers existing replays instead of source onboarding", () => {
    const initial = props({
      query: { scope: { kind: "recent" } },
      page: { items: [], total: 0, analysisExcluded: 0 },
      scopeCounts: { all: 2770, recent: 0 },
    });
    render(<ReplayLibraryView {...initial} />);
    expect(screen.getByRole("heading", { name: "No recent replays" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Sources" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Browse all replays" }));
    expect(initial.onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "all" } }));
  });
  it.each([
    ["scanning", "Indexing your replay library"],
    ["queued", "Preparing your replay library"],
    ["waiting-for-viewer", "Library indexing is waiting"],
  ] as const)("describes an empty %s source truthfully before its first replay arrives", (state, heading) => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    if (!initial.sources.status) throw new Error("Expected fixture status");
    initial.sources.status.replayCount = 0;
    initial.sources.status.sources[0].state = state;
    initial.sources.status.sources[0].update = { active: true, pending: true, stopped: false };
    const rendered = render(<ReplayLibraryView {...initial} />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.queryByText(/Connect osu! stable/)).toBeNull();
    expect(screen.queryByText("Your replay library starts here")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search replays" })).toBeTruthy();
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...initial.sources.status,
      sources: [{ ...initial.sources.status.sources[0], state: "error", error: "scan failed",
        update: { active: false, pending: true, stopped: false } }],
    } }} />);
    expect(screen.getByRole("heading", { name: "Hindsight can't read your sources" })).toBeTruthy();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each([
    ["scanning", "Indexing your replay library"],
    ["queued", "Preparing your replay library"],
    ["waiting-for-viewer", "Library indexing is waiting"],
  ] as const)("keeps genuine %s rebuild work ahead of terminal source failures", (state, heading) => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    const status = fixtureStatus(initial.sources);
    const sources = status.sources.map((source) => ({ ...source, state: "error" as const, error: "scan failed",
      update: { active: false, pending: true, stopped: false } }));
    const rendered = render(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources, rebuild: { ...status.rebuild, state },
    } }} />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    rendered.rerender(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources, rebuild: { ...status.rebuild, state: "error", error: "rebuild failed" },
    } }} />);
    expect(screen.getByRole("heading", { name: "Hindsight can't read your sources" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Library activity" }).textContent).toBe("Rebuild didn't finish");
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each(["idle", "complete", "stopped"] as const)("does not label inactive dirty %s intent as queued work", (state) => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    const status = fixtureStatus(initial.sources);
    render(<ReplayLibraryView {...initial} sources={{ ...initial.sources, status: {
      ...status, replayCount: 0, sources: [{ ...status.sources[0], state,
        update: { active: false, pending: true, stopped: state === "stopped" } }],
    } }} />);
    expect(screen.getByRole("heading", { name: "No replays found" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Preparing your replay library" })).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each(["unknown-status", "loading", "updating"] as const)("retains initial Reading while %s", (state) => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    render(<ReplayLibraryView {...initial} loading={state === "loading"} updating={state === "updating"}
      sources={state === "unknown-status" ? { ...initial.sources, status: null } : initial.sources} />);
    expect(screen.getByRole("heading", { name: "Reading your replay library" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your replay library starts here" })).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("reserves source onboarding for an idle library without a connected source", () => {
    const initial = props({ page: { items: [], total: 0, analysisExcluded: 0 } });
    if (!initial.sources.status) throw new Error("Expected fixture status");
    initial.sources.status.replayCount = 0;
    const rendered = render(<ReplayLibraryView {...initial} />);
    expect(screen.getByRole("heading", { name: "No replays found" })).toBeTruthy();
    expect(screen.queryByText(/Connect osu! stable/)).toBeNull();
    rendered.rerender(
      <ReplayLibraryView
        {...initial}
        sources={{ ...initial.sources, status: { ...initial.sources.status, sources: [] } }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your replay library starts here" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Sources" })).toBeTruthy();
  });
  it("keeps the empty Recent action and focus stable through updating and reading refreshes", () => {
    const initial = props({ query: { scope: { kind: "recent" } }, page: { items: [], total: 0, analysisExcluded: 0 } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const button = screen.getByRole("button", { name: "Browse all replays" });
    button.focus();
    for (const state of [{ updating: true }, { loading: true }, { updating: false, loading: false }]) {
      rendered.rerender(<ReplayLibraryView {...initial} {...state} />);
      expect(screen.getByRole("button", { name: "Browse all replays" })).toBe(button);
      expect(document.activeElement).toBe(button);
      const status = screen.queryByText(/^(Updating indexed results|Reading indexed replays)/);
      if (status) expect(window.getComputedStyle(status).position).toBe("absolute");
    }
    fireEvent.click(button);
    expect(initial.onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: "all" } }));
  });
  it("names the loaded replay's zero playhead and displays its existing artwork", () => {
    render(
      <ReplayLibraryView
        {...props({
          nowPlaying: { id: "current", title: "Loaded replay", position: "0:00", artUrl: "blob:viewer-art" },
        })}
      />,
    );
    const chip = screen.getByRole("button", { name: "Back to Loaded replay in the viewer, at 0:00" });
    expect(chip.textContent).toContain("open in viewer · 0:00");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe("blob:viewer-art");
  });
  it("distinguishes failed artwork and strip verification from an unanalysed replay without inventing media", () => {
    const resource = {
      artUrl: undefined,
      artworkError: "Artwork could not be verified",
      stripError: "Cached error strip could not be verified",
    };
    render(
      <LibraryReplayCard
        item={item()}
        resource={resource}
        selected={false}
        onSelect={jest.fn()}
        onOpen={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Artwork unavailable" }).getAttribute("title")).toBe(
      "Artwork could not be verified",
    );
    expect(screen.queryByText("Artwork unavailable")).toBeNull();
    expect(screen.getByLabelText("Error strip unavailable").getAttribute("title")).toBe(
      "Cached error strip could not be verified",
    );
    expect(screen.getByText("Not analysed")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Replay judgement error strip" })).toBeNull();
  });
  it("shows an independent strip failure while artwork is pending, then reports known artwork absence", () => {
    const resource = { artworkPending: true, stripError: "Cached error strip could not be verified" };
    const initial = props({ selected: { item: item(), mapIdentity: "map", metrics: [] }, resources: { "fixture-score": resource } });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const panel = screen.getByRole("complementary", { name: "Replay details Fixture map" });
    expect(within(panel).getByLabelText("Error strip unavailable")).toBeTruthy();
    expect(within(panel).queryByRole("img", { name: "Artwork unavailable" })).toBeNull();
    rendered.rerender(<ReplayLibraryView {...initial} resources={{ "fixture-score": { stripError: resource.stripError } }} />);
    expect(within(panel).getByRole("img", { name: "Artwork unavailable" })).toBeTruthy();
  });
  it.each(["grid", "list"] as const)(
    "uses a neutral %s artwork slot for a failed image and retries only a changed URI",
    (view) => {
      const initial = props({ view, resources: { "fixture-score": { artUrl: "blob:first-art" } } });
      const rendered = render(<ReplayLibraryView {...initial} />);
      const replay = screen.getByRole(view === "list" ? "row" : "option", { name: "Fixture map, Fixture player" });
      const image = replay.querySelector<HTMLImageElement>('img[src="blob:first-art"]');
      if (!image) throw new Error("Expected the requested artwork element");
      expect(window.getComputedStyle(image).visibility).toBe("hidden");
      fireEvent.load(image);
      expect(window.getComputedStyle(image).visibility).toBe("visible");
      fireEvent.error(image);
      expect(replay.querySelector('img[src="blob:first-art"]')).toBeNull();
      expect(within(replay).getByRole("img", { name: "Artwork unavailable" }).getAttribute("title")).toBe(
        "Artwork could not be displayed.",
      );
      rendered.rerender(
        <ReplayLibraryView {...initial} resources={{ "fixture-score": { artUrl: "blob:first-art" } }} />,
      );
      expect(replay.querySelector('img[src="blob:first-art"]')).toBeNull();
      rendered.rerender(
        <ReplayLibraryView {...initial} resources={{ "fixture-score": { artUrl: "blob:replacement-art" } }} />,
      );
      const replacement = replay.querySelector<HTMLImageElement>('img[src="blob:replacement-art"]');
      if (!replacement) throw new Error("Expected a new artwork URI to be tried");
      expect(within(replay).queryByRole("img", { name: "Artwork unavailable" })).toBeNull();
      fireEvent.load(replacement);
      expect(window.getComputedStyle(replacement).visibility).toBe("visible");
      expect(initial.onOpen).not.toHaveBeenCalled();
    },
  );
  it("retains verification failure details in the panel's neutral artwork fallback", () => {
    const initial = props({
      selected: { item: item(), mapIdentity: "map", metrics: [] },
      resources: { "fixture-score": { artUrl: "blob:rejected-art", artworkError: "Artwork could not be verified" } },
    });
    const rendered = render(<ReplayLibraryView {...initial} />);
    const panel = screen.getByRole("complementary", { name: "Replay details Fixture map" });
    expect(panel.querySelector('img[src="blob:rejected-art"]')).toBeNull();
    expect(within(panel).getByRole("img", { name: "Artwork unavailable" }).getAttribute("title")).toBe(
      "Artwork could not be verified",
    );
    expect(within(panel).getAllByText("Not analysed").length).toBeGreaterThan(0);
    rendered.rerender(
      <ReplayLibraryView {...initial} resources={{ "fixture-score": { artUrl: "blob:rejected-art" } }} />,
    );
    expect(panel.querySelector('img[src="blob:rejected-art"]')).toBeNull();
    expect(within(panel).getByRole("img", { name: "Artwork unavailable" }).getAttribute("title")).toBe(
      "Artwork could not be verified",
    );
  });
  it("starts unselected, retains literal search and exposes exactly the settled twelve sorts with analysis Off", () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    expect(screen.queryByRole("complementary", { name: /Replay details/ })).toBeNull();
    const sort = screen.getByRole("combobox", { name: "Sort replays" });
    expect(within(sort).getAllByRole("option")).toHaveLength(12);
    expect(Object.keys(LIBRARY_SORTS)).toHaveLength(12);
    fireEvent.change(screen.getByRole("textbox", { name: "Search replays" }), { target: { value: "ur:50 HD" } });
    expect(initial.onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ search: "ur:50 HD" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search replays" }), { key: "Enter" });
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.change(sort, { target: { value: "ur" } });
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "ur", direction: "asc" }));
  });
  it.each(["grid", "list"] as const)("selects on click, keeps second click selected, opens only selected-item Enter or double-click in %s", (view) => {
    const initial = props({ view });
    render(<Controlled initial={initial} />);
    const card = screen.getByRole(view === "list" ? "row" : "option", { name: "Fixture map, Fixture player" });
    fireEvent.click(card);
    fireEvent.click(card);
    expect(initial.onSelect).toHaveBeenCalledTimes(2);
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(initial.onOpen).toHaveBeenCalledWith("fixture-score");
    fireEvent.doubleClick(card);
    expect(initial.onOpen).toHaveBeenCalledTimes(2);
  });
  it("selects unselected Enter, and bookmark actions never open a replay", () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.keyDown(screen.getByRole("option", { name: "Fixture map, Fixture player" }), { key: "Enter" });
    expect(initial.onSelect).toHaveBeenCalledWith("fixture-score");
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add Fixture map to collection" }));
    expect(screen.getByRole("dialog", { name: "Save to" })).toBeTruthy();
    expect(initial.onOpen).not.toHaveBeenCalled();
  });
  it("offers nineteen GUI filters, previews without commit and replaces the same field on Apply", async () => {
    const initial = props({ query: { sort: "ur", filters: [{ field: "ur", op: "atMost", a: 200, b: null }] } });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Find a filter" }));
    expect(LIBRARY_FILTER_FIELDS).toHaveLength(20);
    expect(screen.queryByText("Error cause")).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filters" })).getByRole("button", { name: /^UR/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Value" }), { target: { value: "100" } });
    await flush();
    expect(initial.onPreview).toHaveBeenLastCalledWith(initial.query, { field: "ur", op: "atMost", a: 100, b: null });
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    expect(initial.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ field: "ur", op: "atMost", a: 100, b: null }] }),
    );
  });
  it("keeps unknown FC separate from zero misses and colors perfect combo without changing ordinary FC", () => {
    const { rerender } = render(<LibraryCombo item={item()} />);
    expect(screen.queryByText("FC")).toBeNull();
    expect(screen.queryByTitle("Perfect combo")).toBeNull();
    rerender(<LibraryCombo item={item({ fullCombo: true, perfectCombo: false })} />);
    expect(screen.getByText("FC")).toBeTruthy();
    expect(screen.queryByTitle("Perfect combo")).toBeNull();
    rerender(<LibraryCombo item={item({ fullCombo: true, perfectCombo: true })} />);
    expect(screen.getByTitle("Perfect combo")).toBeTruthy();
    expect(libraryGradeColor(item({ grade: "F" }))).toBe("#c5cad3");
  });
  it("renders only supplied NEW and real analysis states, preserves unknown metrics with Off", () => {
    const initial = props({
      page: {
        items: [item({ analysis: "failed", analysisError: "resource-unavailable", isNew: true })],
        total: 1,
        analysisExcluded: 2,
      },
      view: "list",
    });
    render(<ReplayLibraryView {...initial} />);
    expect(screen.getByText("NEW")).toBeTruthy();
    expect(screen.getAllByTitle("Analysis failed").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 replays lack data/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Sort replays" }).hasAttribute("disabled")).toBe(false);
  });
  it("provides all four sources, explicit import only, and real settings callbacks", async () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    for (const label of [
      "osu! stable · local scores",
      "osu! stable · Replays folder",
      "osu!lazer",
      "Imported in Hindsight",
    ])
      expect(within(dialog).getByText(label)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Import replays…" }));
    await flush();
    expect(initial.onSourceAction).toHaveBeenCalledWith({ method: "import-replays" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Locate osu!lazer…" }));
    expect(initial.onSourceAction).toHaveBeenCalledWith({ method: "locate-lazer" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Background" }));
    expect(initial.onAnalysisSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: "bg" }));
    expect(screen.queryByText("Add a folder")).toBeNull();
    expect(screen.queryByText("Pause while playing")).toBeNull();
  });
  it("keeps direct parent membership independent from its child and creation saves to the selected replay", () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Fixture map to collection" }));
    const menu = screen.getByRole("dialog", { name: "Save to" });
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Practice" }));
    expect(initial.onMembership).toHaveBeenCalledTimes(1);
    expect(initial.onMembership).toHaveBeenCalledWith("fixture-score", "parent", true);
    expect((within(menu).getByRole("checkbox", { name: "Practice › Warmup" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(menu).getByRole("button", { name: "New collection…" }));
    const name = within(menu).getByRole("textbox", { name: "New collection name" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Review later" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(initial.onCollectionCreate).toHaveBeenCalledWith("Review later", null, "fixture-score");
  });
  it("confirms parent deletion and never sends replay deletion", () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText(/Its 1 sub-collections go too/)).toBeTruthy();
    expect(screen.getByText(/no replay files are deleted/)).toBeTruthy();
    expect(initial.onCollectionDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete collection" }));
    expect(initial.onCollectionDelete).toHaveBeenCalledWith("parent");
  });
  it("starts narrow sidebar closed without rewriting docked preference, then traps focus and closes by scope", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    expect(screen.queryByRole("dialog", { name: "Library views" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show library sidebar" }));
    const dialog = screen.getByRole("dialog", { name: "Library views" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Recent/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.queryByRole("dialog", { name: "Library views" })).toBeNull();
    expect(initial.onSidebarChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show library sidebar" }));
  });
  it("uses modal details below1280, focuses Close and dismisses the innermost menu first", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("option", { name: "Fixture map, Fixture player" }));
    const dialog = screen.getByRole("dialog", { name: "Replay details Fixture map" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close replay details" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Not reviewed" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Review state" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Review state" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Replay details Fixture map" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Replay details Fixture map" })).toBeNull();
  });
  it("windows bounded query pages and keeps band heights/order deterministic", () => {
    const items = Array.from({ length: 128 }, (_, n) =>
      item({
        id: `row-${n}`,
        title: `Map ${n}`,
        band: { key: n < 64 ? "upper" : "lower", label: n < 64 ? "Upper band" : "Lower band" },
      }),
    );
    const layout = libraryLayoutRows(items, 3, "grid");
    expect(layout.filter((row) => row.label).map((row) => row.label)).toEqual(["Upper band", "Lower band"]);
    expect(layout.flatMap((row) => row.items).map((row) => row.item.id)).toEqual(items.map((row) => row.id));
    const initial = props({ page: { items, total: 100000, analysisExcluded: 0 }, pageStart: 512 });
    render(<ReplayLibraryView {...initial} />);
    const cards = within(screen.getByRole("listbox", { name: "Replays" })).getAllByRole("option");
    expect(cards.length).toBeLessThan(20);
    expect(cards[0].getAttribute("aria-posinset")).toBe("513");
  });
  it("has no preview/copy side effects when rendering cards from source observations", () => {
    const initial = props();
    render(
      <LibraryReplayCard
        item={item()}
        selected={false}
        onSelect={initial.onSelect as () => void}
        onOpen={initial.onReturnToViewer}
        onSave={() => undefined}
      />,
    );
    expect(initial.onPreview).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("makes each of the nineteen settled editors reachable", async () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    for (const field of LIBRARY_FILTER_FIELDS) {
      const chooser = screen.getByRole("dialog", { name: "Filters" });
      fireEvent.click(within(chooser).getByRole("button", { name: FILTER_LABELS[field] }));
      expect(screen.getByRole("dialog", { name: FILTER_LABELS[field] })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "All filters" }));
    }
    await flush();
    expect(initial.onQueryChange).not.toHaveBeenCalled();
  });
  it("applies Exactly No Mod, Includes Any and map/replay star basis through the GUI", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Mod match mode" }), { target: { value: "exactly" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ field: "mods", mode: "exactly", match: null, mods: [] }] }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Mods: Exactly No mods" })[0]);
    fireEvent.change(screen.getByRole("combobox", { name: "Mod match mode" }), { target: { value: "includes" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Include selected mods" }), { target: { value: "any" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hidden (HD)" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Flashlight (FL)" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [{ field: "mods", mode: "includes", match: "any", mods: ["HD", "FL"] }] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Star rating" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Star basis" }), { target: { value: "map" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Minimum" }), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    await flush();
    expect(initial.onQueryChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([{ field: "stars", basis: "map", min: 4, max: null }]),
      }),
    );
  });
  it("previews and applies Excludes with ordinary named mod checkboxes and clear summaries", async () => {
    const initial = props({ onPreview: jest.fn(async () => ({ count: 4, analysisExcluded: 0 })) });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    const mode = screen.getByRole("combobox", { name: "Mod match mode" });
    expect(within(mode).getByRole("option", { name: "Excludes" })).toBeTruthy();
    fireEvent.change(mode, { target: { value: "excludes" } });
    expect(screen.queryByRole("combobox", { name: "Include selected mods" })).toBeNull();
    const choices = screen.getByRole("group", { name: "Mods" });
    const description = document.getElementById(choices.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toContain("Exclude replays containing any selected mod.");
    const relax = within(choices).getByRole("checkbox", { name: "Relax (RX)" }) as HTMLInputElement;
    const hidden = within(choices).getByRole("checkbox", { name: "Hidden (HD)" }) as HTMLInputElement;
    act(() => relax.focus());
    fireEvent.click(relax);
    expect(relax.checked).toBe(true);
    expect(document.activeElement).toBe(relax);
    fireEvent.click(hidden);
    fireEvent.click(hidden);
    expect(hidden.checked).toBe(false);
    expect(hidden.indeterminate).toBe(false);
    fireEvent.click(hidden);
    await flush();
    expect(initial.onPreview).toHaveBeenLastCalledWith(initial.query, {
      field: "mods", mode: "excludes", match: null, mods: ["RX", "HD"],
    });
    expect(screen.getByText("4 matching replays")).toBeTruthy();
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
    expect(initial.onAnalysisSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({
      ...initial.query, cursor: undefined,
      filters: [{ field: "mods", mode: "excludes", match: null, mods: ["RX", "HD"] }],
    });
    expect(screen.getAllByRole("button", { name: "Mods: Excludes RX or HD" })).toHaveLength(2);
  });
  it("keeps Excludes edits cancellable, switches modes without losing choices and clears the applied chip", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Mod match mode" }), { target: { value: "excludes" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Relax (RX)" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Mods: Excludes RX" })[0]);
    const mode = screen.getByRole("combobox", { name: "Mod match mode" }) as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "includes" } });
    expect((screen.getByRole("combobox", { name: "Include selected mods" }) as HTMLSelectElement).value).toBe("all");
    fireEvent.change(screen.getByRole("combobox", { name: "Include selected mods" }), { target: { value: "any" } });
    fireEvent.change(mode, { target: { value: "exactly" } });
    await flush();
    expect(initial.onPreview).toHaveBeenLastCalledWith(expect.anything(), {
      field: "mods", mode: "exactly", match: null, mods: ["RX"],
    });
    fireEvent.change(mode, { target: { value: "excludes" } });
    expect((screen.getByRole("checkbox", { name: "Relax (RX)" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Hidden (HD)" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(initial.onQueryChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Mods: Excludes RX" })[0]);
    expect((screen.getByRole("combobox", { name: "Mod match mode" }) as HTMLSelectElement).value).toBe("excludes");
    expect((screen.getByRole("checkbox", { name: "Hidden (HD)" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Mods filter" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({ ...initial.query, filters: [], cursor: undefined });
    expect(screen.getByRole("button", { name: "Mods Any" })).toBeTruthy();
  });
  it("leaves empty Excludes drafts unset and never previews an invalid exclusion", async () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Mods Any" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Mod match mode" }), { target: { value: "excludes" } });
    await flush();
    const apply = screen.getByRole("button", { name: "Apply filter" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(initial.onPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Relax (RX)" }));
    await flush();
    expect(apply.disabled).toBe(false);
    const previews = (initial.onPreview as jest.Mock).mock.calls.length;
    fireEvent.click(screen.getByRole("checkbox", { name: "Relax (RX)" }));
    await flush();
    expect(apply.disabled).toBe(true);
    expect(initial.onPreview).toHaveBeenCalledTimes(previews);
    fireEvent.click(apply);
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Mods Any" })).toBeTruthy();
  });
  it("restores Excludes and round-trips its canonical expert text only after explicit application", async () => {
    const initial = props({ query: {
      sort: "pp", direction: "desc", search: "literal mods:exactly(none)",
      filters: [{ field: "mods", mode: "excludes", match: null, mods: ["RX", "HD"] }],
    } });
    render(<Controlled initial={initial} />);
    expect(screen.getAllByRole("button", { name: "Mods: Excludes RX or HD" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Mods: Excludes RX or HD" })[0]);
    expect((screen.getByRole("combobox", { name: "Mod match mode" }) as HTMLSelectElement).value).toBe("excludes");
    for (const name of ["Relax (RX)", "Hidden (HD)"])
      expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit filters as text…" }));
    const editor = screen.getByRole("textbox", { name: "Query text" }) as HTMLTextAreaElement;
    expect(editor.value).toBe('"literal mods:exactly(none)" mods:excludes(RX,HD)');
    fireEvent.change(editor, { target: { value: '"literal mods:exactly(none)" mods:excludes(RX,DT)' } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(initial.onQueryChange).toHaveBeenLastCalledWith({
      ...initial.query, cursor: undefined,
      filters: [{ field: "mods", mode: "excludes", match: null, mods: ["RX", "DT"] }],
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Mods: Excludes RX or DT" })[0]);
    expect((screen.getByRole("combobox", { name: "Mod match mode" }) as HTMLSelectElement).value).toBe("excludes");
    expect((screen.getByRole("checkbox", { name: "Double Time (DT)" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Hidden (HD)" }) as HTMLInputElement).checked).toBe(false);
    await flush();
  });
  it.each([0, 1, 2])("uses the matching-preview noun for %i replays without admission", async (count) => {
    const initial = props({ onPreview: jest.fn(async () => ({ count, analysisExcluded: 0 })) });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "UR" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Value" }), { target: { value: "50" } });
    await flush();
    expect(
      within(screen.getByRole("dialog", { name: "UR" })).getByText(
        `${count} matching ${count === 1 ? "replay" : "replays"}`,
      ),
    ).toBeTruthy();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
    expect(initial.onQueryChange).not.toHaveBeenCalled();
  });
  it("ignores late preview counts and pages facet choices without analysis admission", async () => {
    const resolve: ((value: { count: number; analysisExcluded: number }) => void)[] = [];
    const initial = props({ onPreview: jest.fn(() => new Promise((done) => resolve.push(done))) });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: "UR" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Value" }), { target: { value: "50" } });
    await act(async () => {
      resolve[resolve.length - 1]({ count: 2, analysisExcluded: 3 });
    });
    await act(async () => {
      resolve[0]({ count: 999, analysisExcluded: 0 });
    });
    expect(screen.getByText("2 matching replays · 3 lack required analysis data")).toBeTruthy();
    expect(screen.queryByText("999 matching replays")).toBeNull();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("does not turn truncated or other-replay membership evidence into false unchecked values", () => {
    const replay = item({ collectionIds: ["unlisted"], collectionCount: 17 });
    const initial = props({
      page: { items: [replay], total: 1, analysisExcluded: 0 },
      memberships: { replayId: "other", ids: ["parent"], complete: true },
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Fixture map to collection" }));
    const checkbox = within(screen.getByRole("dialog", { name: "Save to" })).getByRole("checkbox", {
      name: "Practice",
    }) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(screen.getByRole("button", { name: "Load remaining memberships" })).toBeTruthy();
  });
  it("suppresses not-yet-read analysis setting values and does not claim current output status", () => {
    const initial = props();
    initial.sources.analysisLoading = true;
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull();
    expect((screen.getByRole("button", { name: "Reading analysis settings…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("keeps the now-playing return separate from replay opening and passes full-map intent", () => {
    const initial = props({
      nowPlaying: { id: "loaded", title: "Loaded replay", position: "2:06" },
      selected: { item: item(), mapIdentity: "map", metrics: [] },
    });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Loaded replay in the viewer, at 2:06" }));
    expect(initial.onReturnToViewer).toHaveBeenCalledTimes(1);
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    expect(initial.onOpen).toHaveBeenCalledWith("fixture-score", { fullMap: true });
  });
  it("commits query syntax only from Use query and validates malformed text", () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit filters as text…" }));
    const editor = screen.getByRole("textbox", { name: "Query text" });
    fireEvent.change(editor, { target: { value: '"literal ur:50" mods:exactly(none) mapstars>=4' } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(initial.onQueryChange).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "literal ur:50",
        filters: [
          { field: "mods", mode: "exactly", match: null, mods: [] },
          { field: "stars", basis: "map", min: 4, max: null },
        ],
      }),
    );
  });
  it("reanchors a dropped bounded window to the same visible replay", () => {
    const items = Array.from({ length: 128 }, (_, n) => item({ id: `window-${n}` }));
    const before = libraryLayoutRows(items, 3, "grid");
    const after = libraryLayoutRows(items.slice(30), 3, "grid");
    const original = before.find((row) => row.items.some((entry) => entry.item.id === "window-60"));
    const replacement = after.find((row) => row.items.some((entry) => entry.item.id === "window-60"));
    if (!original || !replacement) throw new Error("Expected the fixture replay in both bounded windows");
    expect(libraryReanchorScroll(before, after, original.top + 23)).toBe(replacement.top + 23);
  });
  it("uses saved selected judgements and exact calculated map combo while absent evidence stays unknown", () => {
    const initial = props({
      selected: {
        item: item({ perfectCombo: false }),
        mapIdentity: "map",
        metrics: [],
        savedJudgements: { great: 3, ok: 0, meh: null, miss: null, origin: "native-score" },
        exactMapMaxCombo: 19,
      },
    });
    render(<ReplayLibraryView {...initial} />);
    const detail = screen.getByRole("complementary", { name: "Replay details Fixture map" });
    expect(within(detail).getByText("/ 19")).toBeTruthy();
    const label = within(detail).getByText("50");
    expect(label.parentElement?.textContent).toBe("50 —");
    const great = within(detail).getByText("300");
    expect(great.parentElement?.textContent).toBe("300 3");
    expect(within(detail).queryByTitle("Perfect combo")).toBeNull();
  });
  it("retains complete dense values and long List text when replay details are open", () => {
    const original = item();
    const replay = item({
      title: "Synthetic QA qualified passed FC with deliberately long recorded metadata",
      artist: "Synthetic QA artist with a deliberately long display name",
      difficulty: "Synthetic QA difficulty with a deliberately long name 0123456789",
      player: "Synthetic QA recorded player with a deliberately long name 0123456789",
      completion: "passed",
      fullCombo: true,
      perfectCombo: true,
      values: { ...original.values, combo: 65535, acc: 99.99, ur: 10000 },
    });
    const initial = props({
      view: "list",
      page: { items: [replay], total: 1, analysisExcluded: 0 },
      selected: { item: replay, mapIdentity: "map", metrics: [], exactMapMaxCombo: 65535 },
    });
    render(<ReplayLibraryView {...initial} />);
    const row = screen.getByRole("row", { name: `${replay.title}, ${replay.player}` });
    const subtitle = `${replay.artist} · [${replay.difficulty}]`;
    expect(within(row).getByTitle(subtitle).textContent).toBe(subtitle);
    expect(row.getAttribute("tabindex")).toBe("0");
    const detail = screen.getByRole("complementary", { name: `Replay details ${replay.title}` });
    expect(within(detail).getByText("65,535×")).toBeTruthy();
    expect(within(detail).getByText("FC")).toBeTruthy();
    expect(within(detail).getByText("/ 65,535")).toBeTruthy();
    expect(within(detail).getByText("10,000.0")).toBeTruthy();
    expect(within(detail).getByText(replay.player as string)).toBeTruthy();
    expect(initial.onOpen).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("keeps Save to focus when a row bookmark mounts modal details in the same commit", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props({ view: "list" });
    render(<Controlled initial={initial} />);
    const anchor = screen.getByRole("button", { name: "Add Fixture map to collection" });
    fireEvent.click(anchor);
    const popover = screen.getByRole("dialog", { name: "Save to" });
    expect(popover.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Save to" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Replay details Fixture map" })).toBeTruthy();
    expect(document.activeElement).toBe(anchor);
    expect(initial.onOpen).not.toHaveBeenCalled();
    expect(initial.onFavourite).not.toHaveBeenCalled();
    expect(initial.onMembership).not.toHaveBeenCalled();
  });
  it("does not steal Save to focus when selected details arrive after the row bookmark", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props({ view: "list" });
    const { rerender } = render(<ReplayLibraryView {...initial} />);
    const anchor = screen.getByRole("button", { name: "Add Fixture map to collection" });
    fireEvent.click(anchor);
    const popover = screen.getByRole("dialog", { name: "Save to" });
    expect(popover.contains(document.activeElement)).toBe(true);
    rerender(
      <ReplayLibraryView {...initial} selected={{ item: initial.page.items[0], mapIdentity: "map", metrics: [] }} />,
    );
    expect(popover.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Save to" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Replay details Fixture map" })).toBeTruthy();
    expect(document.activeElement).toBe(anchor);
    expect(initial.onOpen).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("uses the correct Result-choice replay noun for count %i", async (count) => {
    const initial = props({
      onFacets: jest.fn(async (field) => ({
        items: field === "result" ? [{ value: "failed", count }] : [],
      })),
    });
    render(<Controlled initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^Result/ }));
    await flush();
    const failed = screen.getByRole("radio", { name: /^Failed/ }).closest("label");
    expect(failed?.textContent).toContain(`${count} ${count === 1 ? "replay" : "replays"}`);
    expect(failed?.textContent).not.toContain("1 replays");
    expect(initial.onQueryChange).not.toHaveBeenCalled();
    expect(initial.onSourceAction).not.toHaveBeenCalled();
  });
  it("traps Tab in the innermost popover when details are modal", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props({ selected: { item: item(), mapIdentity: "map", metrics: [] } });
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    const popover = screen.getByRole("dialog", { name: "Save to" });
    const last = within(popover).getByRole("button", { name: "New collection…" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(within(popover).getByRole("button", { name: "Close Save to" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
  it("keeps narrow sidebar focus after cancelling create/rename and saves rename once", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Show library sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "New collection" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New collection name" }), { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Options for Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const rename = screen.getByRole("textbox", { name: "Rename collection" });
    expect(document.activeElement).toBe(rename);
    fireEvent.change(rename, { target: { value: "Practice updated" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(initial.onCollectionRename).toHaveBeenCalledTimes(1);
    expect(initial.onCollectionRename).toHaveBeenCalledWith("parent", "Practice updated");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Options for Practice" }));
  });
  it("uses authoritative child counts even when only one child is on the loaded page", () => {
    const initial = props();
    initial.collections[0].childCount = 105;
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByText(/Its 105 sub-collections go too/)).toBeTruthy();
  });
  it("provides explicit failure and rebuild recovery callbacks", () => {
    const initial = props({
      selected: {
        item: item({ analysis: "failed", analysisError: "fixture-resource-error" }),
        mapIdentity: "map",
        metrics: [],
      },
      onRetryAnalysis: jest.fn(),
    });
    initial.sources.error = "Source connection failed";
    if (initial.sources.status) initial.sources.status.rebuild.state = "scanning";
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry analysis" }));
    expect(initial.onRetryAnalysis).toHaveBeenCalledWith("fixture-score");
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop rebuild" }));
    expect(initial.onSourceAction).toHaveBeenCalledWith({ method: "rebuild-stop" });
    fireEvent.click(screen.getByRole("button", { name: "Retry source connection" }));
    expect(initial.onSourceAction).toHaveBeenCalledWith({ method: "retry" });
  });
  it("lists direct membership names outside the sidebar page and exposes remaining membership paging", () => {
    const initial = props({
      selected: { item: item({ collectionCount: 2, collectionIds: ["outside-1"] }), mapIdentity: "map", metrics: [] },
      memberships: {
        replayId: "fixture-score",
        ids: ["outside-1"],
        items: [{ id: "outside-1", name: "Far collection", parentId: "outside-parent", parentName: "Other parent" }],
        complete: false,
        next: "next-page",
      },
      onLoadMoreMemberships: jest.fn(),
    });
    render(<ReplayLibraryView {...initial} />);
    expect(screen.getByTitle("Other parent › Far collection").textContent).toBe("Far collection · in Other parent");
    fireEvent.click(screen.getByRole("button", { name: "Load 1 more memberships" }));
    expect(initial.onLoadMoreMemberships).toHaveBeenCalledTimes(1);
  });
  it("does not cancel/restart membership reads on unrelated host callback identity changes", () => {
    const initial = props({
      selected: { item: item(), mapIdentity: "map", metrics: [] },
      onMembershipTarget: jest.fn(),
    });
    const { rerender, unmount } = render(<ReplayLibraryView {...initial} />);
    expect(initial.onMembershipTarget).toHaveBeenCalledTimes(1);
    expect(initial.onMembershipTarget).toHaveBeenCalledWith("fixture-score");
    const replacement = jest.fn();
    rerender(<ReplayLibraryView {...initial} onMembershipTarget={replacement} />);
    expect(replacement).not.toHaveBeenCalled();
    unmount();
    expect(replacement).toHaveBeenCalledWith(null);
  });
  it("focuses confirmation Cancel then restores rebuild opener, and imported-only Scan is disabled", () => {
    const initial = props();
    if (initial.sources.status)
      initial.sources.status.sources = [{ ...initial.sources.status.sources[0], kind: "imported" }];
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect((screen.getByRole("button", { name: "Scan now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Rebuild index…" }));
    const confirmation = screen.getByRole("group", { name: "Confirm rebuild" });
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rebuild index…" }));
    expect(screen.getByRole("dialog", { name: "Sources" })).toBeTruthy();
  });
  it("focuses Cancel when collection menu becomes its delete confirmation", () => {
    const initial = props();
    render(<ReplayLibraryView {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Practice" }));
    const remove = screen.getByRole("button", { name: "Delete…" });
    remove.focus();
    fireEvent.click(remove);
    const confirmation = screen.getByRole("dialog", { name: "Delete Practice?" });
    expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "Cancel" }));
  });
});

describe("v34 quick grade selection", () => {
  const grades = ["SS", "S", "A", "B", "C", "D", "F"];
  const button = (grade: string) =>
    within(screen.getByRole("group", { name: "Quick grade filter" })).getByRole("button", { name: `Grade ${grade}` });
  const lastQuery = (initial: ReplayLibraryViewProps) => {
    const calls = (initial.onQueryChange as jest.Mock).mock.calls;
    return calls[calls.length - 1]?.[0] as ReplayLibraryViewProps["query"];
  };

  it("shows every unrestricted grade as pressed and removes only the first clicked grade", () => {
    const initial = props({
      query: {
        sort: "pp",
        direction: "desc",
        search: "ANiMA",
        cursor: "old-page",
        filters: [{ field: "source", values: ["stable"] }],
      },
    });
    render(<Controlled initial={initial} />);
    for (const grade of grades) {
      expect(button(grade).getAttribute("aria-pressed")).toBe("true");
      expect(button(grade).style.boxShadow).toContain("currentColor");
    }
    fireEvent.click(button("A"));
    expect(lastQuery(initial)).toEqual({
      sort: "pp",
      direction: "desc",
      search: "ANiMA",
      cursor: undefined,
      filters: [
        { field: "source", values: ["stable"] },
        { field: "grade", values: ["SS", "S", "B", "C", "D", "F"] },
      ],
    });
    expect(button("A").getAttribute("aria-pressed")).toBe("false");
    expect(button("A").style.boxShadow).toContain("transparent");
    expect(button("S").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("A"));
    expect(lastQuery(initial).filters).toEqual([{ field: "source", values: ["stable"] }]);
  });

  it("preserves all-off through the real query editor and removes the redundant filter only after all seven return", () => {
    const initial = props();
    render(<Controlled initial={initial} />);
    for (const grade of grades) fireEvent.click(button(grade));
    expect(lastQuery(initial).filters).toEqual([{ field: "grade", values: [] }]);
    for (const grade of grades) {
      expect(button(grade).getAttribute("aria-pressed")).toBe("false");
      expect(button(grade).style.boxShadow).toContain("transparent");
    }
    fireEvent.click(screen.getByRole("button", { name: "Edit filters as text…" }));
    const editor = screen.getByRole("dialog", { name: "Edit filters as text" });
    expect((within(editor).getByRole("textbox", { name: "Query text" }) as HTMLTextAreaElement).value).toBe("grade:");
    fireEvent.click(within(editor).getByRole("button", { name: "Apply filters" }));
    expect(lastQuery(initial).filters).toEqual([{ field: "grade", values: [] }]);
    for (const grade of grades) fireEvent.click(button(grade));
    expect(lastQuery(initial).filters).toEqual([]);
    for (const grade of grades) expect(button(grade).getAttribute("aria-pressed")).toBe("true");
  });

  it("preserves explicit query values outside the seven base controls when toggling a base grade", () => {
    const initial = props({ query: { filters: [{ field: "grade", values: ["SH"] }] } });
    render(<Controlled initial={initial} />);
    for (const grade of grades) expect(button(grade).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("A"));
    expect(lastQuery(initial).filters).toEqual([{ field: "grade", values: ["A", "SH"] }]);
    fireEvent.click(button("A"));
    expect(lastQuery(initial).filters).toEqual([{ field: "grade", values: ["SH"] }]);
  });
});
