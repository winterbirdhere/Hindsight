import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import { useErrorNavigation, usePlayheadIncidentIndex, type ErrorNavigationState } from "../../hooks/error-navigation";
import { useGameClockControls, useGameClockTime } from "../../hooks/game-clock";
import { hitWindowsForOD } from "@osujs/math";
import { stableHitWindowsForOD } from "../../../../../../../libs/osu/core/src/gameplay/StableDifficulty";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type { Incident } from "../../services/analysis/incidents";
import type { ReplayError } from "../../services/analysis/replay-events";
import { buildHitWindowDiagram } from "./hit-window-diagram";
import { visuallyHidden } from "./incident-format";
import { errorTypeLabel, INCIDENT_BODY_HEIGHT, INCIDENT_BODY_MIN_HEIGHT, IncidentBlock } from "./IncidentBlock";
import { IncidentsList } from "./IncidentsList";

// The real provider (inspection, Follow, expansion, Replay) and `usePlayheadIncidentIndex` are covered by
// `hooks/error-navigation.spec.tsx`; here a test sets the state the components read.
jest.mock("../../hooks/error-navigation", () => ({
  useErrorNavigation: jest.fn(),
  usePlayheadIncidentIndex: jest.fn(),
}));
jest.mock("../../hooks/game-clock", () => ({ useGameClockControls: jest.fn(), useGameClockTime: jest.fn() }));
jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

const cause = (headline: string, extra: Partial<ComponentMechanism> = {}): ComponentMechanism => ({
  status: "supported",
  headline,
  codes: [headline.toLowerCase().replace(/\s+/g, "-")],
  description: "",
  eventIds: [],
  limitations: [],
  ...extra,
});
const errors: ReplayError[] = [
  { id: "miss:1", time: 66_472, type: "MISS", hitObjectId: "1" },
  { id: "break:2", time: 66_553, type: "SLIDER_BREAK", hitObjectId: "2/HEAD", sliderId: "2" },
  { id: "miss:3", time: 76_444, type: "MISS", hitObjectId: "3" },
];
const selectError = jest.fn();
const selectIncident = jest.fn();
// What Previous / Next ask for: the step leaves Follow as it is.
const KEEP_FOLLOWING = { keepFollowing: true };
const setFollowing = jest.fn();
const toggleExpanded = jest.fn();
const replaySelection = jest.fn();
const seekTo = jest.fn();
const start = jest.fn();
function navigation(extra: Partial<ErrorNavigationState> = {}) {
  const state: ErrorNavigationState = {
    errors,
    selectedIndex: 0,
    selectError,
    selectIncident,
    following: false,
    setFollowing,
    expanded: new Set<string>(),
    toggleExpanded,
    replaySelection,
    revealToken: 0,
    listScrollTop: { current: 0 },
    causes: new Map([
      ["miss:1", [cause("Late tap", { metric: { value: 43, unit: "ms late" } })]],
      ["break:2", [cause("Notelock")]],
    ]),
    incidents: [
      { id: "miss:1", errorIndices: [0, 1], leadIndex: 0, links: [{ from: 0, to: 1, kind: "notelock", source: "simulator" }] },
      { id: "miss:3", errorIndices: [2], leadIndex: 2, links: [] },
    ],
    analysisStatus: undefined,
    displayMode: "concise",
    ruleset: "stable",
    ...extra,
  };
  (useErrorNavigation as jest.Mock).mockReturnValue(state);
  return state;
}

/** A Heartless-like chain: a late tap that locks the next five notes, then an unrelated miss. */
const chainErrors: ReplayError[] = [
  ...[64_595, 64_661, 64_727, 64_793, 64_859, 64_989].map(
    (time, index): ReplayError => ({ id: `miss:c${index}`, time, type: "MISS", hitObjectId: `c${index}` }),
  ),
  { id: "miss:z", time: 79_121, type: "MISS", hitObjectId: "z" },
];
const chainIncidents: Incident[] = [
  {
    id: "miss:c0",
    errorIndices: [0, 1, 2, 3, 4, 5],
    leadIndex: 0,
    links: [1, 2, 3, 4, 5].map((to) => ({ from: 0, to, kind: "notelock" as const, source: "simulator" as const })),
  },
  { id: "miss:z", errorIndices: [6], leadIndex: 6, links: [] },
];
const chainCauses = () =>
  new Map<string, ComponentMechanism[]>([
    ["miss:c0", [cause("Late tap", { metric: { value: 43, unit: "ms late" } })]],
    ...[1, 2, 3, 4, 5].map((index): [string, ComponentMechanism[]] => [`miss:c${index}`, [cause("Notelock")]]),
  ]);
const chain = (extra: Partial<ErrorNavigationState> = {}) =>
  navigation({ errors: chainErrors, incidents: chainIncidents, causes: chainCauses(), ...extra });
const controls = (extra: Record<string, unknown> = {}) =>
  (useGameClockControls as jest.Mock).mockReturnValue({ duration: 118_000, baseRate: 1, seekTo, start, ...extra });

beforeEach(() => {
  for (const mock of [selectError, selectIncident, setFollowing, toggleExpanded, replaySelection, seekTo, start]) mock.mockClear();
  (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(-1);
  controls();
  (useGameClockTime as jest.Mock).mockReturnValue(66_472);
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameSimulator: { getPrimaryReplay: () => ({}) },
    getBeatmap: () => ({ gameClockRate: 1, stableOverallDifficulty: 8, difficulty: { overallDifficulty: 8 } }),
  });
});

describe("IncidentBlock", () => {
  it("labels the incident and stacks one headline per error", () => {
    navigation();
    render(<IncidentBlock />);
    expect(screen.getByText("1–2/3")).toBeTruthy();
    const headlines = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headlines).toEqual(["Late tap", "Notelock"]);
    // The offset is on the hit-window diagram (and the UR bar), not printed as text beside the type and time.
    expect(screen.queryByText(/ms (late|early)/)).toBeNull();
    expect(screen.getByText("Locked by the miss above")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap");
  });

  it("draws the diagram only for the timed lead, with no key label", () => {
    navigation();
    render(<IncidentBlock />);
    const diagrams = screen.getAllByRole("img", { name: /hit window/i });
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].textContent).toBe("+43 ms");
    expect(diagrams[0].textContent).not.toMatch(/K[12]/);
  });

  it("shows the error type as a neutral headline when there is no cause", () => {
    navigation({ selectedIndex: 2 });
    render(<IncidentBlock />);
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Miss"]);
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
    expect(screen.queryByRole("img", { name: /hit window/i })).toBeNull();
    // The type is the headline, so the row must not repeat it.
    expect(screen.getAllByText("Miss")).toHaveLength(1);
  });

  it("shows the followed incident silently while Follow is on", () => {
    // What the provider yields with Follow on: the lead of the incident at the playhead.
    navigation({ selectedIndex: 2, following: true, causes: new Map([["miss:3", [cause("Late tap")]]]) });
    render(<IncidentBlock />);
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Late tap"]);
    // Only an inspected error with Follow off is announced; a followed one is shown silently.
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
  });

  it("does not claim a lock when the link does not point at the entry above", () => {
    navigation({
      incidents: [
        { id: "miss:1", errorIndices: [0, 1, 2], leadIndex: 0, links: [{ from: 0, to: 2, kind: "notelock", source: "simulator" }] },
      ],
    });
    render(<IncidentBlock />);
    expect(screen.queryByText(/Locked by/)).toBeNull();
  });

  it("keeps the brief detail in the announced cause text", () => {
    navigation({
      displayMode: "brief",
      causes: new Map([["miss:1", [cause("Late tap", { briefDetail: { phrase: "after the window", metric: { value: 46, unit: "ms late" } } })]]]),
    });
    render(<IncidentBlock />);
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap · after the window · 46 ms late");
  });

  it("labels a slider component miss from its component type", () => {
    const componentErrors: ReplayError[] = [
      { id: "head:1", time: 1_000, type: "SLIDER_COMPONENT_MISS", sliderId: "1", sliderComponentType: "HEAD" },
      { id: "tick:1", time: 2_000, type: "SLIDER_COMPONENT_MISS", sliderId: "1", sliderComponentType: "TICK" },
      { id: "repeat:1", time: 3_000, type: "SLIDER_COMPONENT_MISS", sliderId: "1", sliderComponentType: "REPEAT" },
      { id: "legacy:1", time: 4_000, type: "SLIDER_COMPONENT_MISS", sliderId: "1", sliderComponentType: "LAST_LEGACY_TICK" },
      { id: "plain:1", time: 5_000, type: "SLIDER_COMPONENT_MISS", sliderId: "1" },
    ];
    expect(componentErrors.map(errorTypeLabel)).toEqual([
      "Slider head",
      "Slider tick",
      "Slider repeat",
      "Slider tick",
      "Slider tick",
    ]);
    expect(errorTypeLabel(errors[0])).toBe("Miss");
    expect(errorTypeLabel(errors[1])).toBe("Slider break");
  });

  it("calls a missed Lazer slider head a slider head, also in the lock sentence", () => {
    const lazerErrors: ReplayError[] = [
      { id: "head:1", time: 66_472, type: "SLIDER_COMPONENT_MISS", sliderId: "1", sliderComponentType: "HEAD" },
      { id: "miss:2", time: 66_553, type: "MISS", hitObjectId: "2" },
    ];
    navigation({
      errors: lazerErrors,
      selectedIndex: 0,
      causes: new Map(),
      ruleset: "lazer",
      incidents: [{ id: "head:1", errorIndices: [0, 1], leadIndex: 0, links: [{ from: 0, to: 1, kind: "notelock", source: "simulator" }] }],
    });
    render(<IncidentBlock />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Slider head", "Miss"]);
    expect(screen.getByText("Locked by the slider head above")).toBeTruthy();
    expect(screen.queryByText(/slider tick/i)).toBeNull();
  });

  it("draws the diagram with the windows of the ruleset the causes were computed for", () => {
    // Different overall difficulties per profile, so the two rulesets draw visibly different marks.
    (useAnalysisApp as jest.Mock).mockReturnValue({
      gameSimulator: { getPrimaryReplay: () => ({}) },
      getBeatmap: () => ({ gameClockRate: 1, stableOverallDifficulty: 4, difficulty: { overallDifficulty: 9 } }),
    });
    const markLeft = (ruleset: "stable" | "lazer") => {
      navigation({ ruleset });
      const view = render(<IncidentBlock />);
      const diagram = screen.getByRole("img", { name: /hit window/i });
      const left = getComputedStyle(diagram.querySelector("span") as HTMLElement).left;
      view.unmount();
      return left;
    };
    const expected = (windows: readonly number[]) => `${buildHitWindowDiagram(43, windows, 1)?.markPercent}%`;
    expect(markLeft("stable")).toBe(expected(stableHitWindowsForOD(4)));
    expect(markLeft("lazer")).toBe(expected(hitWindowsForOD(9, true)));
    expect(expected(stableHitWindowsForOD(4))).not.toBe(expected(hitWindowsForOD(9, true)));
  });

  it("prints the offset nowhere as text in Brief mode when the detail is only that offset; the diagram has it", () => {
    navigation({
      displayMode: "brief",
      causes: new Map([
        ["miss:1", [cause("Late tap", { metric: { value: 46, unit: "ms late" }, briefDetail: { phrase: "", metric: { value: 46, unit: "ms late" } } })]],
      ]),
    });
    render(<IncidentBlock />);
    expect(screen.queryByText(/46 ms late/)).toBeNull();
    expect(screen.getByRole("img", { name: "Hit window, press +46 ms" })).toBeTruthy();
    // Nothing is left of the detail, so the announced text is the headline alone.
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap");
  });

  it("keeps the phrase and drops only the metric that is the diagram's offset in Brief mode", () => {
    navigation({
      displayMode: "brief",
      causes: new Map([
        [
          "miss:1",
          [cause("Late tap", { metric: { value: 46, unit: "ms late" }, briefDetail: { phrase: "after the window", metric: { value: 46, unit: "ms late" } } })],
        ],
      ]),
    });
    render(<IncidentBlock />);
    expect(screen.queryByText(/46 ms late/)).toBeNull();
    expect(screen.getByRole("img", { name: "Hit window, press +46 ms" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap · after the window");
  });

  it("shows no metric on a locked follow-up in Brief mode, only its phrase", () => {
    navigation({
      displayMode: "brief",
      selectedIndex: 1,
      causes: new Map([
        [
          "break:2",
          [cause("Late tap", { metric: { value: 30, unit: "ms late" }, briefDetail: { phrase: "after the window", metric: { value: 30, unit: "ms late" } } })],
        ],
      ]),
    });
    render(<IncidentBlock />);
    expect(screen.getByText("Locked by the miss above")).toBeTruthy();
    expect(screen.queryByText(/30 ms late/)).toBeNull();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap · after the window");
  });

  it("omits the detail line when a locked follow-up's detail was only a metric", () => {
    navigation({
      displayMode: "brief",
      selectedIndex: 1,
      causes: new Map([["break:2", [cause("Late tap", { briefDetail: { phrase: "", metric: { value: 30, unit: "ms late" } } })]]]),
    });
    render(<IncidentBlock />);
    expect(screen.queryByText(/30 ms late/)).toBeNull();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Late tap");
  });

  it("keeps the label, status and navigator outside the scrolling headlines and resets the scroll on a new incident", () => {
    const state = navigation({ analysisStatus: "Analyzing errors…" });
    const view = render(<IncidentBlock />);
    const scroller = screen.getAllByRole("heading", { level: 2 })[0].closest("[data-incident-scroll]") as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.contains(screen.getByText("1–2/3"))).toBe(false);
    expect(scroller.contains(screen.getByRole("status", { name: "Error analysis status" }))).toBe(false);
    expect(scroller.contains(screen.getByRole("button", { name: "Next incident" }))).toBe(false);
    expect(scroller.contains(view.container.querySelector("[data-density-bin]"))).toBe(false);
    expect(scroller.contains(screen.getAllByRole("heading", { level: 2 })[1])).toBe(true);
    scroller.scrollTop = 120;
    // Same incident, new selection inside it: the position is kept.
    navigation({ ...state, selectedIndex: 1 });
    view.rerender(<IncidentBlock />);
    expect(scroller.scrollTop).toBe(120);
    // A different incident starts at the top again.
    navigation({ ...state, selectedIndex: 2 });
    view.rerender(<IncidentBlock />);
    const next = screen.getAllByRole("heading", { level: 2 })[0].closest("[data-incident-scroll]") as HTMLElement;
    expect(next.scrollTop).toBe(0);
  });

  it("steps incidents from the navigator and selects from the density bar", () => {
    navigation();
    const { container } = render(<IncidentBlock />);
    expect((screen.getByRole("button", { name: "Previous incident" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next incident" }));
    expect(selectIncident).toHaveBeenLastCalledWith(1, KEEP_FOLLOWING);
    const bins = container.querySelectorAll("[data-density-bin]");
    expect(bins).toHaveLength(60);
    selectIncident.mockClear();
    fireEvent.click(bins[Math.floor((76_444 / 118_000) * 60)]);
    expect(selectIncident).toHaveBeenLastCalledWith(1);
    selectIncident.mockClear();
    fireEvent.click(bins[0]);
    expect(selectIncident).not.toHaveBeenCalled();
    expect(selectError).not.toHaveBeenCalled();
  });

  it("re-renders only the playhead and step buttons on a clock tick inside the same error", () => {
    navigation();
    // A clock that really ticks: every reader re-renders when the time is advanced.
    const tickers = new Set<(time: number) => void>();
    (useGameClockTime as jest.Mock).mockImplementation(() => {
      const [time, setTime] = useState(66_472);
      tickers.add(setTime);
      return time;
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const labelSpy = jest.spyOn(require("./incident-format"), "formatIncidentPosition");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const binsSpy = jest.spyOn(require("../../services/analysis/incidents"), "buildDensityBins");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const causeSpy = jest.spyOn(require("./error-cause-presentation"), "presentCause");
    const { container } = render(<IncidentBlock />);
    const playhead = container.querySelector("[data-density-playhead]") as HTMLElement;
    const leftBefore = playhead.style.left;
    const bodyRenders = labelSpy.mock.calls.length;
    const binBuilds = binsSpy.mock.calls.length;
    const entryRenders = causeSpy.mock.calls.length;
    expect(bodyRenders).toBeGreaterThan(0);
    expect(tickers.size).toBeGreaterThan(0);

    act(() => tickers.forEach((setTime) => setTime(66_500)));

    // The tick arrived: the playhead moved.
    expect(playhead.style.left).not.toBe(leftBefore);
    // The body (one label per render), the bins and the entries were not rendered again.
    expect(labelSpy.mock.calls.length).toBe(bodyRenders);
    expect(binsSpy.mock.calls.length).toBe(binBuilds);
    expect(causeSpy.mock.calls.length).toBe(entryRenders);
    expect(container.querySelectorAll("[data-density-bin]")).toHaveLength(60);
    labelSpy.mockRestore();
    binsSpy.mockRestore();
    causeSpy.mockRestore();
  });

  it("shows the analysis status and calm empty states", () => {
    navigation({ errors: [], incidents: [], causes: new Map(), selectedIndex: -1, analysisStatus: "Analyzing errors…" });
    const view = render(<IncidentBlock />);
    expect(screen.getByRole("status", { name: "Error analysis status" }).textContent).toBe("Analyzing errors…");
    expect(screen.getByText("NO ERRORS")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    (useAnalysisApp as jest.Mock).mockReturnValue({ gameSimulator: { getPrimaryReplay: () => undefined } });
    navigation({ errors: [], incidents: [], causes: new Map(), selectedIndex: -1 });
    view.rerender(<IncidentBlock />);
    expect(screen.queryByText("NO ERRORS")).toBeNull();
  });
});

describe("IncidentsList", () => {
  it("lists one row per incident with cause, types and time", () => {
    navigation();
    render(<IncidentsList />);
    // Only the number of incidents sits next to the title; the error total is in the inspector header.
    expect(screen.getByText("2", { selector: "span" }).parentElement?.textContent).toBe("Incidents2");
    expect(screen.queryByText(/errors/)).toBeNull();
    const rows = within(screen.getByRole("list", { name: "Incidents" })).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Late tap");
    expect(rows[0].textContent).toContain("Miss → Slider break");
    expect(rows[0].textContent).toContain("1:06.472");
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    expect(rows[1].textContent).toContain("Miss");
    expect(rows[1].getAttribute("aria-current")).toBeNull();
    fireEvent.click(rows[1]);
    // A list click inspects the incident and leaves the list where it is.
    expect(selectIncident).toHaveBeenCalledWith(1, { reveal: false });
  });

  it("highlights nothing while nothing is inspected", () => {
    navigation({ selectedIndex: -1 });
    render(<IncidentsList />);
    expect(screen.getByRole("list", { name: "Incidents" }).querySelector('[aria-current="true"]')).toBeNull();
  });

  it("does not re-render rows on a time-only clock tick", () => {
    const state = navigation();
    (useGameClockTime as jest.Mock).mockClear();
    // One `splitErrorTime` call per row render: a counter that fails if the rows lose their memoisation.
    // (A row no longer calls `presentCause`: its title is the incident's cause chain, summarised once by the list.)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const causeSpy = jest.spyOn(require("./incident-format"), "splitErrorTime");
    const { rerender } = render(<IncidentsList />);
    expect(causeSpy).toHaveBeenCalledTimes(2);
    (useGameClockTime as jest.Mock).mockReturnValue(70_000);
    // The list itself renders again (new context object), with nothing a row shows changed.
    (useErrorNavigation as jest.Mock).mockReturnValue({ ...state });
    act(() => rerender(<IncidentsList />));
    expect(causeSpy).toHaveBeenCalledTimes(2);
    // A selection change re-renders only the rows whose `selected` flips (both, with two incidents).
    (useErrorNavigation as jest.Mock).mockReturnValue({ ...state, selectedIndex: 2 });
    act(() => rerender(<IncidentsList />));
    expect(causeSpy).toHaveBeenCalledTimes(4);
    // The list never reads the clock; only IncidentBlock's playhead and step buttons do.
    expect(useGameClockTime).not.toHaveBeenCalled();
    causeSpy.mockRestore();
  });

  it("says so when there are no errors, and shows a dash with no replay", () => {
    navigation({ errors: [], incidents: [], causes: new Map(), selectedIndex: -1 });
    const view = render(<IncidentsList />);
    expect(screen.getByText("No errors")).toBeTruthy();
    (useAnalysisApp as jest.Mock).mockReturnValue({ gameSimulator: { getPrimaryReplay: () => undefined } });
    view.rerender(<IncidentsList />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

// ---- Phase 1b: inspection workflow (spec §5.9) ----

/** A clock that really ticks: every `useGameClockTime` reader re-renders when the time is advanced. */
function tickingClock(initial: number) {
  const tickers = new Set<(time: number) => void>();
  (useGameClockTime as jest.Mock).mockImplementation(() => {
    const [time, setTime] = useState(initial);
    tickers.add(setTime);
    return time;
  });
  return (time: number) => act(() => tickers.forEach((setTime) => setTime(time)));
}
const members = () => within(screen.getByRole("list", { name: "Incident members" })).getAllByRole("button");
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("chained errors", () => {
  /** The classifier's link from a chained miss to the earlier press that caused it, and that press's own cause. */
  const chainedFrom = (timeMs: number, startCause = { codes: ["early-tap"], headline: "Early tap" }): ComponentMechanism["chain"] => ({
    policy: "recorded-input-chain-v1",
    chained: true,
    start: { componentId: "290", inputId: "r1", timeMs, kind: "hit-nothing" },
    opportunities: [],
    pressIds: [],
    durationMs: 0,
    stop: "hit-nothing",
    disposition: "inherited",
    cause: { ...startCause, observationOnly: false, reason: "", eventIds: [] },
    certification: { status: "observation", reason: "" },
  });
  // The inherited cause carries the earlier press's offset and detail.
  const inherited = (timeMs: number) =>
    cause("Early tap", {
      metric: { value: 24, unit: "ms early" },
      briefDetail: { phrase: "before the window", metric: { value: 24, unit: "ms early" } },
      chain: chainedFrom(timeMs),
    });
  const pause = jest.fn();
  beforeEach(() => {
    pause.mockClear();
    controls({ pause });
  });

  it("says which earlier mistake caused it and when, under the arrow, with no offset, diagram or detail of that press", () => {
    navigation({ selectedIndex: 2, displayMode: "brief", causes: new Map([["miss:3", [inherited(70_192)]]]) });
    const { container } = render(<IncidentBlock />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Early tap"]);
    const message = button("Caused by early tap at 1:10.192");
    expect(message.title).toBe("Go to the earlier mistake");
    // The arrow is decoration beside the headline; the message is the one control.
    expect(container.querySelector('[data-chained] svg[aria-hidden="true"]')).toBeTruthy();
    expect(screen.queryByRole("img", { name: /hit window/i })).toBeNull();
    expect(screen.queryByText(/before the window|ms early/)).toBeNull();
    // Announced with the cause: the cause, then where it came from.
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Early tapCaused by early tap at 1:10.192");
  });

  it("goes to the earlier press paused, with Follow off, and inspects nothing else", () => {
    navigation({ selectedIndex: 2, causes: new Map([["miss:3", [inherited(70_192)]]]) });
    render(<IncidentBlock />);
    const message = button("Caused by early tap at 1:10.192");
    fireEvent.click(message);
    expect(setFollowing).toHaveBeenCalledWith(false);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(70_192);
    expect(selectError).not.toHaveBeenCalled();
    expect(selectIncident).not.toHaveBeenCalled();
    // A pointer press leaves the focus where it was, like the other inspector buttons.
    expect(fireEvent.mouseDown(message)).toBe(false);
  });

  it("gives the time in displayed playback time and seeks in map time", () => {
    controls({ pause, baseRate: 1.5 });
    navigation({ selectedIndex: 2, causes: new Map([["miss:3", [inherited(70_192)]]]) });
    render(<IncidentBlock />);
    fireEvent.click(button("Caused by early tap at 0:46.795"));
    expect(seekTo).toHaveBeenCalledWith(70_192);
  });

  it("shows no arrow or message for an error with its own cause", () => {
    navigation();
    const { container } = render(<IncidentBlock />);
    expect(screen.queryByRole("button", { name: /^Caused by/ })).toBeNull();
    expect(container.querySelector("[data-chained]")).toBeNull();
  });

  it("keeps a chained Notelock's label and lock sentence, and names the earlier mistake behind it", () => {
    const state = navigation();
    const lateStart = chainedFrom(66_100, { codes: ["late-tap"], headline: "Late tap" });
    navigation({ ...state, causes: new Map([...state.causes, ["break:2", [cause("Notelock", { chain: lateStart })]]]) });
    render(<IncidentBlock />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Late tap", "Notelock"]);
    expect(screen.getByText("Locked by the miss above")).toBeTruthy();
    fireEvent.click(button("Caused by late tap at 1:06.100"));
    expect(seekTo).toHaveBeenCalledWith(66_100);
  });

  it("puts the message on a chained member's arrow, drops its timing, and leaves the other rows alone", () => {
    const causes = chainCauses();
    causes.set("miss:c2", [inherited(64_000)]);
    const unlocked: Incident[] = [
      { ...chainIncidents[0], links: chainIncidents[0].links.filter((link) => link.to !== 2) },
      chainIncidents[1],
    ];
    chain({ causes, incidents: unlocked, expanded: new Set(["miss:c0"]), selectedIndex: 2 });
    render(<IncidentBlock />);
    const note = "Caused by early tap at 1:04.000";
    expect(within(members()[2]).getByRole("img", { name: note })).toBeTruthy();
    // Selected, not locked, with a tap offset: the offset is the earlier press's, so it is not printed here.
    expect(members()[2].textContent).toBe(`${note}Early tapMiss1:04.727`);
    expect(within(members()[1]).queryByRole("img", { name: /^Caused by/ })).toBeNull();
    // The row is the only button: the arrow is not a second control inside it.
    expect(within(members()[2]).queryByRole("button")).toBeNull();
  });

  it("starts a list row with the arrow and its message when its lead is chained, and only then", () => {
    navigation({ causes: new Map([["miss:1", [cause("Late tap")]], ["miss:3", [inherited(70_192)]]]) });
    render(<IncidentsList />);
    const rows = within(screen.getByRole("list", { name: "Incidents" })).getAllByRole("button");
    expect(within(rows[0]).queryByRole("img", { name: /^Caused by/ })).toBeNull();
    expect(within(rows[1]).getByRole("img", { name: "Caused by early tap at 1:10.192" })).toBeTruthy();
    expect(rows[1].textContent).toContain("Early tap");
    fireEvent.click(rows[1]);
    expect(selectIncident).toHaveBeenCalledWith(1, { reveal: false });
    expect(seekTo).not.toHaveBeenCalled();
  });
});

describe("IncidentBlock inspection", () => {
  it("shows a count label and a one-line prompt when nothing is inspected", () => {
    navigation({ selectedIndex: -1 });
    render(<IncidentBlock />);
    expect(screen.getByText("3 ERRORS")).toBeTruthy();
    expect(screen.getByText("Select an incident, or follow playback.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
    expect(screen.queryByRole("img", { name: /hit window/i })).toBeNull();
  });

  it("uses singular forms and shows no prompt without errors", () => {
    navigation({
      selectedIndex: -1,
      errors: [errors[2]],
      incidents: [{ id: "miss:3", errorIndices: [0], leadIndex: 0, links: [] }],
    });
    const view = render(<IncidentBlock />);
    expect(screen.getByText("1 ERROR")).toBeTruthy();
    navigation({ selectedIndex: -1, errors: [], incidents: [], causes: new Map() });
    view.rerender(<IncidentBlock />);
    expect(screen.getByText("NO ERRORS")).toBeTruthy();
    expect(screen.queryByText("Select an incident, or follow playback.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Follow" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Replay selection" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Replay at / })).toBeNull();
  });

  it("toggles Follow from a pressed-state text button", () => {
    // The provider starts with Follow on: the button reads pressed, and a press asks for it off.
    const state = navigation({ selectedIndex: -1, following: true });
    const view = render(<IncidentBlock />);
    expect(button("Follow").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Follow"));
    expect(setFollowing).toHaveBeenLastCalledWith(false);
    navigation({ ...state, following: false, selectedIndex: 0 });
    view.rerender(<IncidentBlock />);
    expect(button("Follow").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button("Follow"));
    expect(setFollowing).toHaveBeenLastCalledWith(true);
    expect(seekTo).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  describe("Previous / Next incident follow the playhead", () => {
    /** Six single-error incidents, 10 s apart: the first at 10 s, the sixth at 60 s. */
    const sixErrors: ReplayError[] = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000].map(
      (time, index): ReplayError => ({ id: `miss:s${index}`, time, type: "MISS", hitObjectId: `s${index}` }),
    );
    const sixIncidents: Incident[] = sixErrors.map((error, index) => ({
      id: error.id,
      errorIndices: [index],
      leadIndex: index,
      links: [],
    }));
    const six = (selectedIndex: number) =>
      navigation({ errors: sixErrors, incidents: sixIncidents, causes: new Map(), selectedIndex });

    it("steps from the playhead, not from the inspected incident", () => {
      // Incident 5 (index 4) is inspected, but the playhead was moved to between incidents 1 and 2.
      (useGameClockTime as jest.Mock).mockReturnValue(15_000);
      six(4);
      render(<IncidentBlock />);
      fireEvent.click(button("Next incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(1, KEEP_FOLLOWING);
      fireEvent.click(button("Previous incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(0, KEEP_FOLLOWING);
      expect(selectError).not.toHaveBeenCalled();
    });

    it("walks one incident at a time, because inspecting an incident puts the playhead on its lead error", () => {
      (useGameClockTime as jest.Mock).mockReturnValue(20_000);
      six(1);
      const view = render(<IncidentBlock />);
      // Each press: the incident is inspected, the playhead is sought to it, the block renders again.
      const arriveAt = (index: number) => {
        (useGameClockTime as jest.Mock).mockReturnValue(sixErrors[index].time);
        six(index);
        view.rerender(<IncidentBlock />);
      };
      fireEvent.click(button("Next incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(2, KEEP_FOLLOWING);
      arriveAt(2);
      fireEvent.click(button("Next incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(3, KEEP_FOLLOWING);
      arriveAt(3);
      fireEvent.click(button("Previous incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(2, KEEP_FOLLOWING);
      arriveAt(2);
      fireEvent.click(button("Previous incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(1, KEEP_FOLLOWING);
    });

    it("disables Previous at the first incident and Next at and after the last, by the playhead", () => {
      six(2);
      const view = render(<IncidentBlock />);
      const at = (time: number, selectedIndex: number) => {
        (useGameClockTime as jest.Mock).mockReturnValue(time);
        six(selectedIndex);
        view.rerender(<IncidentBlock />);
        return [button("Previous incident").disabled, button("Next incident").disabled];
      };
      expect(at(10_000, 0)).toEqual([true, false]);
      expect(at(5_000, 0)).toEqual([true, false]);
      expect(at(35_000, 0)).toEqual([false, false]);
      expect(at(60_000, 5)).toEqual([false, true]);
      expect(at(90_000, 5)).toEqual([false, true]);
      // The inspected incident does not decide it: the first is inspected, the playhead is at the end.
      expect(at(90_000, 0)).toEqual([false, true]);
    });

    it("steps from the playhead with nothing inspected", () => {
      (useGameClockTime as jest.Mock).mockReturnValue(70_000);
      navigation({ selectedIndex: -1 });
      render(<IncidentBlock />);
      fireEvent.click(button("Previous incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(0, KEEP_FOLLOWING);
      fireEvent.click(button("Next incident"));
      expect(selectIncident).toHaveBeenLastCalledWith(1, KEEP_FOLLOWING);
      expect(selectError).not.toHaveBeenCalled();
    });

    // Whether Follow really stays as it was is the provider's: error-navigation.spec.tsx and ErrorNavigation.spec.tsx.
    it("asks to keep Follow as it is on every step, with Follow on or off, and does not set it itself", () => {
      for (const following of [true, false]) {
        selectIncident.mockClear();
        (useGameClockTime as jest.Mock).mockReturnValue(30_000);
        navigation({ errors: sixErrors, incidents: sixIncidents, causes: new Map(), selectedIndex: 2, following });
        const view = render(<IncidentBlock />);
        fireEvent.click(button("Previous incident"));
        fireEvent.click(button("Next incident"));
        expect(selectIncident.mock.calls).toEqual([
          [1, KEEP_FOLLOWING],
          [3, KEEP_FOLLOWING],
        ]);
        expect(setFollowing).not.toHaveBeenCalled();
        view.unmount();
      }
    });
  });

  it("summarises a six-member chain in compact runs with a time range", () => {
    chain();
    render(<IncidentBlock />);
    expect(screen.getByText("1–6/7")).toBeTruthy();
    // Only the lead is shown in full.
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Late tap"]);
    expect(screen.getAllByRole("img", { name: /hit window/i })).toHaveLength(1);
    const runs = Array.from(document.querySelectorAll("[data-incident-run]")).map((node) => node.textContent);
    expect(runs).toEqual(["→ Notelock ×5Miss ×5 · 1:04.661 – 1:04.989"]);
    expect(screen.queryByText(/Locked by/)).toBeNull();
    // The members are available on demand, not rendered.
    expect(screen.queryByRole("list", { name: "Incident members" })).toBeNull();
    const show = button("Show 5");
    expect(show.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(show);
    expect(toggleExpanded).toHaveBeenCalledWith("miss:c0");
    expect(selectError).not.toHaveBeenCalled();
  });

  it("keeps a ten-member chain as compact as a six-member one", () => {
    const times = Array.from({ length: 10 }, (_, index) => 79_121 + index * 79);
    const long: ReplayError[] = times.map((time, index) => ({ id: `miss:l${index}`, time, type: "MISS", hitObjectId: `l${index}` }));
    navigation({
      errors: long,
      incidents: [
        {
          id: "miss:l0",
          errorIndices: long.map((_, index) => index),
          leadIndex: 0,
          links: long.slice(1).map((_, index) => ({ from: 0, to: index + 1, kind: "notelock" as const, source: "simulator" as const })),
        },
      ],
      causes: new Map(long.map((error, index) => [error.id, [cause(index === 0 ? "Late tap" : "Notelock")]])),
    });
    render(<IncidentBlock />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    const runs = Array.from(document.querySelectorAll("[data-incident-run]")).map((node) => node.textContent);
    expect(runs).toEqual(["→ Notelock ×9Miss ×9 · 1:19.200 – 1:19.832"]);
    expect(button("Show 9")).toBeTruthy();
  });

  it("splits runs where the cause or the type changes, and never merges a member without a cause into a cause", () => {
    const mixed: ReplayError[] = [
      { id: "miss:m0", time: 10_000, type: "MISS", hitObjectId: "m0" },
      { id: "miss:m1", time: 10_100, type: "MISS", hitObjectId: "m1" },
      { id: "miss:m2", time: 10_200, type: "MISS", hitObjectId: "m2" },
      { id: "break:m3", time: 10_300, type: "SLIDER_BREAK", hitObjectId: "m3/HEAD", sliderId: "m3" },
      { id: "miss:m4", time: 10_400, type: "MISS", hitObjectId: "m4" },
    ];
    navigation({
      errors: mixed,
      incidents: [{ id: "miss:m0", errorIndices: [0, 1, 2, 3, 4], leadIndex: 0, links: [] }],
      causes: new Map([
        ["miss:m0", [cause("Late tap")]],
        ["miss:m1", [cause("Notelock")]],
        ["miss:m2", [cause("Notelock")]],
        ["break:m3", [cause("Notelock")]],
      ]),
    });
    render(<IncidentBlock />);
    const runs = Array.from(document.querySelectorAll("[data-incident-run]")).map((node) => node.textContent);
    expect(runs).toEqual([
      "→ Notelock ×2Miss ×2 · 0:10.100 – 0:10.200",
      "→ NotelockSlider break · 0:10.300",
      // No cause: the type is the label and is not printed a second time.
      "→ Miss0:10.400",
    ]);
    expect(button("Show 4")).toBeTruthy();
  });

  it("shows run times in displayed playback time", () => {
    controls({ baseRate: 1.5 });
    chain();
    render(<IncidentBlock />);
    const [run] = Array.from(document.querySelectorAll("[data-incident-run]")).map((node) => node.textContent);
    expect(run).toBe("→ Notelock ×5Miss ×5 · 0:43.107 – 0:43.326");
  });

  it("lists every member when expanded and selects the clicked error inside the same incident", () => {
    const state = chain({ expanded: new Set(["miss:c0"]) });
    const view = render(<IncidentBlock />);
    expect(button("Hide").getAttribute("aria-expanded")).toBe("true");
    const rows = members();
    expect(rows.map((row) => row.textContent)).toEqual([
      "Late tapMiss1:04.595",
      "NotelockMiss1:04.661",
      "NotelockMiss1:04.727",
      "NotelockMiss1:04.793",
      "NotelockMiss1:04.859",
      "NotelockMiss1:04.989",
    ]);
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual(["true", null, null, null, null, null]);
    // With the lead inspected the members can be hidden again.
    expect(button("Hide").disabled).toBe(false);
    fireEvent.click(button("Hide"));
    expect(toggleExpanded).toHaveBeenCalledWith("miss:c0");
    fireEvent.click(rows[3]);
    expect(selectError).toHaveBeenLastCalledWith(3);
    expect(selectIncident).not.toHaveBeenCalled();

    chain({ ...state, selectedIndex: 3 });
    view.rerender(<IncidentBlock />);
    // The same incident: label, lead entry and diagram stay.
    expect(screen.getByText("1–6/7")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Late tap"]);
    expect(screen.getAllByRole("img", { name: /hit window/i })).toHaveLength(1);
    expect(members().map((row) => row.getAttribute("aria-current"))).toEqual([null, null, null, "true", null, null]);
    // The announced cause moves to the selected member.
    const status = screen.getAllByRole("status", { name: "Error cause" });
    expect(status).toHaveLength(1);
    expect(status[0].textContent).toBe("Notelock");
    expect(members()[3].contains(status[0])).toBe(true);
  });

  it("keeps the members shown while one of them is inspected: Hide is disabled and says why", () => {
    // Not in `expanded` (after a regroup, or a state restored without it): the inspected member still has its row.
    const state = chain({ selectedIndex: 3 });
    const view = render(<IncidentBlock />);
    expect(members()[3].getAttribute("aria-current")).toBe("true");
    const hide = button("Hide");
    expect(hide.disabled).toBe(true);
    expect(hide.title).toBe("A member is selected");
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(toggleExpanded).not.toHaveBeenCalled();
    // Expanded by the user as well: the same.
    chain({ ...state, expanded: new Set(["miss:c0"]) });
    view.rerender(<IncidentBlock />);
    expect(button("Hide").disabled).toBe(true);
    // Back on the lead: Hide works again and has no excuse to show.
    chain({ ...state, expanded: new Set(["miss:c0"]), selectedIndex: 0 });
    view.rerender(<IncidentBlock />);
    expect(button("Hide").disabled).toBe(false);
    expect(button("Hide").title).toBe("");
    // The lead inspected and nothing expanded: collapsed as before.
    chain({ ...state, selectedIndex: 0 });
    view.rerender(<IncidentBlock />);
    expect(screen.queryByRole("list", { name: "Incident members" })).toBeNull();
    expect(button("Show 5").disabled).toBe(false);
  });

  it("prints an uncaused run's type once", () => {
    chain({ causes: new Map() });
    render(<IncidentBlock />);
    const runs = Array.from(document.querySelectorAll("[data-incident-run]")).map((node) => node.textContent);
    expect(runs).toEqual(["→ Miss ×51:04.661 – 1:04.989"]);
  });

  it("gives the body one fixed height in every state, with a single scroller", () => {
    expect(INCIDENT_BODY_HEIGHT).toBe(236);
    const body = () => document.querySelector("[data-incident-scroll]") as HTMLElement;
    const fixed = () => {
      const style = getComputedStyle(body());
      // The basis is the constant and no height is set, so content cannot size the body; it only shrinks with the window.
      expect(style.flexBasis).toBe(`${INCIDENT_BODY_HEIGHT}px`);
      expect(style.flexGrow).toBe("0");
      expect(style.height).toBe("");
      expect(style.overflowY).toBe("auto");
      expect(style.overflowX).toBe("hidden");
    };
    // Nothing inspected.
    const state = chain({ selectedIndex: -1 });
    const view = render(<IncidentBlock />);
    expect(body().contains(screen.getByText("Select an incident, or follow playback."))).toBe(true);
    fixed();
    const element = body();
    // Inspected.
    chain({ ...state, selectedIndex: 0 });
    view.rerender(<IncidentBlock />);
    expect(body().contains(screen.getByRole("heading", { level: 2 }))).toBe(true);
    expect(body().contains(button("Show 5"))).toBe(true);
    fixed();
    // Expanded: the members scroll with the body, not in a second scroller.
    chain({ ...state, selectedIndex: 0, expanded: new Set(["miss:c0"]) });
    view.rerender(<IncidentBlock />);
    const list = screen.getByRole("list", { name: "Incident members" });
    expect(body().contains(list)).toBe(true);
    expect(getComputedStyle(list).maxHeight).toBe("");
    expect(getComputedStyle(list).overflowY).not.toBe("auto");
    fixed();
    // The same element throughout, so nothing below it is laid out anew.
    expect(body()).toBe(element);
    // Replay stays outside the scroller; so do the label and the navigator.
    expect(body().contains(screen.getByRole("group", { name: "Replay selection" }))).toBe(false);
    expect(body().contains(button("Follow"))).toBe(false);
    expect(body().contains(button("Next incident"))).toBe(false);
    // No errors at all: the same fixed region, empty.
    navigation({ errors: [], incidents: [], causes: new Map(), selectedIndex: -1 });
    view.rerender(<IncidentBlock />);
    fixed();
  });

  it("lets the body and its block shrink in a short window, down to a minimum, and never grow", () => {
    expect(INCIDENT_BODY_MIN_HEIGHT).toBe(96);
    chain({ selectedIndex: 0 });
    render(<IncidentBlock />);
    const body = getComputedStyle(document.querySelector("[data-incident-scroll]") as HTMLElement);
    expect(body.flexShrink).toBe("1");
    expect(body.flexGrow).toBe("0");
    expect(body.minHeight).toBe(`${INCIDENT_BODY_MIN_HEIGHT}px`);
    const block = getComputedStyle(screen.getByRole("region", { name: "Current incident" }));
    expect(block.flexShrink).toBe("1");
    expect(block.flexGrow).toBe("0");
    expect(parseFloat(block.minHeight)).toBe(0);
  });

  it("starts a newly inspected incident at the top and keeps a selected member in view", () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const state = chain({ expanded: new Set(["miss:c0"]) });
    const view = render(<IncidentBlock />);
    const body = document.querySelector("[data-incident-scroll]") as HTMLElement;
    // Showing the members scrolls nothing by itself.
    expect(scrollIntoView).not.toHaveBeenCalled();
    body.scrollTop = 90;
    chain({ ...state, selectedIndex: 4 });
    view.rerender(<IncidentBlock />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances[0]).toBe(members()[4]);
    // The same incident: the body is not thrown back to the top.
    expect(body.scrollTop).toBe(90);
    // Another incident: top again, and nothing is scrolled into view for a lead.
    chain({ ...state, selectedIndex: 6 });
    view.rerender(<IncidentBlock />);
    expect(body.scrollTop).toBe(0);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does not take focus on a pointer press: the playback shortcuts keep working", () => {
    chain({ expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    for (const target of [
      members()[2],
      button("Hide"),
      button("Follow"),
      button("Replay at 0.25× speed"),
      button("Replay at 0.5× speed"),
      button("Replay at 1× speed"),
      button("Next incident"),
    ]) {
      const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
      fireEvent(target, press);
      expect(press.defaultPrevented).toBe(true);
      expect(document.activeElement).not.toBe(target);
    }
    // Keyboard focus is untouched.
    act(() => members()[2].focus());
    expect(document.activeElement).toBe(members()[2]);
  });

  it("shows the timing of a selected member that has one, and none for a locked member", () => {
    const causes = chainCauses();
    causes.set("miss:c2", [cause("Early tap", { metric: { value: 12, unit: "ms early" } })]);
    causes.set("miss:c3", [cause("Early tap", { metric: { value: 12, unit: "ms early" } })]);
    const unlocked: Incident[] = [
      { ...chainIncidents[0], links: chainIncidents[0].links.filter((link) => link.to !== 2) },
      chainIncidents[1],
    ];
    const state = chain({ causes, incidents: unlocked, expanded: new Set(["miss:c0"]), selectedIndex: 2 });
    const view = render(<IncidentBlock />);
    expect(members()[2].textContent).toBe("Early tap12 ms earlyMiss1:04.727");
    // Not selected: no timing text.
    expect(members()[3].textContent).toBe("Early tapMiss1:04.793");
    // No diagram is drawn for the selected member (only the lead's), so its row is the one place its offset is shown.
    expect(screen.getAllByRole("img", { name: /hit window/i })).toHaveLength(1);
    expect(screen.getByRole("img", { name: /hit window/i }).textContent).toBe("+43 ms");
    // Member 3 is locked by a proven notelock link: no timing, like a locked follow-up entry.
    chain({ ...state, selectedIndex: 3 });
    view.rerender(<IncidentBlock />);
    expect(members()[3].textContent).toBe("Early tapMiss1:04.793");
  });

  it("does not repeat the type of a member without a cause", () => {
    const causes = chainCauses();
    causes.delete("miss:c4");
    chain({ causes, expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    expect(members()[4].textContent).toBe("Miss1:04.859");
  });

  it("announces nothing while Follow is on, also for an expanded incident", () => {
    const state = chain({ expanded: new Set(["miss:c0"]), following: true });
    const view = render(<IncidentBlock />);
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
    expect(members()).toHaveLength(6);
    // The provider only follows leads; the member rows hold the same rule on their own.
    chain({ ...state, selectedIndex: 3 });
    view.rerender(<IncidentBlock />);
    expect(members()[3].getAttribute("aria-current")).toBe("true");
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
  });

  it("announces the lead while it is the inspected error", () => {
    chain({ expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    const status = screen.getAllByRole("status", { name: "Error cause" });
    expect(status).toHaveLength(1);
    expect(status[0].textContent).toBe("Late tap");
    expect(screen.getByRole("list", { name: "Incident members" }).contains(status[0])).toBe(false);
  });

  describe("replay row", () => {
    const SPEEDS = [0.25, 0.5, 1] as const;
    const speedName = (speed: number) => `Replay at ${speed}× speed`;
    const group = () => screen.getByRole("group", { name: "Replay selection" });
    const speedButtons = () => within(group()).getAllByRole("button") as HTMLButtonElement[];

    it("labels the row REPLAY and offers 0.25×, 0.5× and 1× in one labelled group, with no speed-less Replay button", () => {
      navigation();
      const { container } = render(<IncidentBlock />);
      expect(speedButtons().map((node) => node.textContent)).toEqual(["0.25×", "0.5×", "1×"]);
      expect(speedButtons().map((node) => node.getAttribute("aria-label"))).toEqual([
        "Replay at 0.25× speed",
        "Replay at 0.5× speed",
        "Replay at 1× speed",
      ]);
      for (const node of speedButtons()) expect(node.title).toBe("Play this incident once at this speed");
      const row = container.querySelector("[data-replay-row]") as HTMLElement;
      expect(row.firstElementChild?.textContent).toBe("REPLAY");
      expect(row.firstElementChild?.nextElementSibling).toBe(group());
      // The old pair is gone: no button named "Replay selection" (the group has that name) and no plain "Replay".
      expect(screen.queryByRole("button", { name: "Replay selection" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Replay selection at 0.25× speed" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Replay$/ })).toBeNull();
    });

    it.each(SPEEDS)("calls replaySelection(%s) exactly once for its button, and nothing else", (speed) => {
      navigation();
      render(<IncidentBlock />);
      fireEvent.click(screen.getByRole("button", { name: speedName(speed) }));
      expect(replaySelection).toHaveBeenCalledTimes(1);
      expect(replaySelection.mock.calls[0]).toEqual([speed]);
      // The block itself neither seeks nor starts: the provider does that (and sets the speed).
      expect(seekTo).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });

    it("is disabled with nothing inspected and calls nothing", () => {
      const state = navigation();
      const view = render(<IncidentBlock />);
      for (const node of speedButtons()) expect(node.disabled).toBe(false);
      navigation({ ...state, selectedIndex: -1 });
      view.rerender(<IncidentBlock />);
      expect(speedButtons()).toHaveLength(3);
      for (const node of speedButtons()) {
        expect(node.disabled).toBe(true);
        fireEvent.click(node);
      }
      expect(replaySelection).not.toHaveBeenCalled();
    });

    it("is absent with zero errors", () => {
      navigation({ selectedIndex: -1, errors: [], incidents: [], causes: new Map() });
      const { container } = render(<IncidentBlock />);
      expect(screen.queryByRole("group", { name: "Replay selection" })).toBeNull();
      expect(container.querySelector("[data-replay-row]")).toBeNull();
      expect(screen.queryByText("REPLAY")).toBeNull();
    });

    it.each([
      [0.25, ["true", "false", "false"]],
      [0.5, ["false", "true", "false"]],
      [1, ["false", "false", "true"]],
      [undefined, ["false", "false", "false"]],
    ] as const)("marks the speed of the incident replay that is playing (%s), and none while there is none", (replayingSpeed, pressed) => {
      navigation({ replayingSpeed });
      render(<IncidentBlock />);
      expect(speedButtons().map((node) => node.getAttribute("aria-pressed"))).toEqual(pressed);
    });

    it.each([0.25, 0.5, 1, 1.5])("marks nothing for the viewer's own speed of %s×: the row is not a speed control", (speed) => {
      navigation();
      controls({ speed });
      render(<IncidentBlock />);
      expect(speedButtons().map((node) => node.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    });

    it("follows the replay that is playing, and styles its button like a pressed Follow", () => {
      const state = navigation({ following: true, replayingSpeed: 0.5 });
      const view = render(<IncidentBlock />);
      const follow = getComputedStyle(button("Follow"));
      const active = () => getComputedStyle(screen.getByRole("button", { name: speedName(0.5) }));
      expect(active().backgroundColor).toBe(follow.backgroundColor);
      expect(active().color).toBe(follow.color);
      const quiet = getComputedStyle(screen.getByRole("button", { name: speedName(1) }));
      expect(quiet.backgroundColor).not.toBe(follow.backgroundColor);
      expect(quiet.color).not.toBe(follow.color);
      navigation({ ...state, replayingSpeed: 1 });
      view.rerender(<IncidentBlock />);
      expect(screen.getByRole("button", { name: speedName(1) }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: speedName(0.5) }).getAttribute("aria-pressed")).toBe("false");
      expect(getComputedStyle(screen.getByRole("button", { name: speedName(1) })).backgroundColor).toBe(follow.backgroundColor);
    });

    it("leaves Follow and the inspection to the provider: the buttons only ask for the replay", () => {
      navigation({ following: true });
      render(<IncidentBlock />);
      fireEvent.click(screen.getByRole("button", { name: speedName(0.25) }));
      expect(setFollowing).not.toHaveBeenCalled();
      expect(selectError).not.toHaveBeenCalled();
      expect(selectIncident).not.toHaveBeenCalled();
    });

    it("styles the label like the block's section label and the buttons quiet, mono, 24 px", () => {
      navigation();
      const { container } = render(<IncidentBlock />);
      const label = getComputedStyle(container.querySelector("[data-replay-label]") as Element);
      const section = getComputedStyle(container.querySelector("[data-incident-label]") as Element);
      for (const property of ["fontFamily", "fontWeight", "fontSize", "letterSpacing", "color"] as const) {
        expect(label[property]).toBe(section[property]);
      }
      expect(label.fontSize).toBe("11px");
      expect(label.letterSpacing).toBe("0.08em");
      for (const node of speedButtons()) {
        const style = getComputedStyle(node);
        expect(style.fontFamily).toContain("mono");
        expect(style.fontSize).toBe("12px");
        expect(style.height).toBe("24px");
        expect(style.fontStyle).not.toBe("italic");
      }
    });

    it("keeps one line of fixed height that cannot be squeezed: 28 px controls area, nothing shrinks or wraps", () => {
      navigation();
      const { container } = render(<IncidentBlock />);
      const row = getComputedStyle(container.querySelector("[data-replay-row]") as Element);
      expect(row.display).toBe("flex");
      expect(row.minHeight).toBe("28px");
      expect(row.flexWrap).not.toBe("wrap");
      expect(row.marginTop).toBe("-6px");
      expect(row.marginBottom).toBe("-6px");
      expect(getComputedStyle(container.querySelector("[data-replay-label]") as Element).flexShrink).toBe("0");
      expect(getComputedStyle(group()).flexShrink).toBe("0");
      for (const node of speedButtons()) expect(getComputedStyle(node).flexShrink).toBe("0");
    });
  });

  // The inspector is 240 to 440 px wide: 204 px of content at the narrowest. jsdom has no layout, so these pin the
  // style rules that keep each row on its line (or let it wrap or ellipsise) without changing the block's height.
  describe("at the narrowest inspector (204 px of content)", () => {
    it("keeps the entry line's type and time as whole units that can wrap, with no offset text and nothing squeezed", () => {
      navigation();
      const { container } = render(<IncidentBlock />);
      const line = container.querySelector("[data-incident-entry-line]") as HTMLElement;
      const style = getComputedStyle(line);
      expect([style.display, style.flexWrap, style.rowGap, style.columnGap]).toEqual(["flex", "wrap", "2px", "8px"]);
      // Type and time: each is one unit that wraps as a whole. The offset is on the diagram below, not in this line.
      expect(Array.from(line.children).map((node) => node.textContent)).toEqual(["Miss", "1:06.472"]);
      expect(screen.getByRole("img", { name: "Hit window, press +43 ms" })).toBeTruthy();
      for (const node of Array.from(line.children)) {
        expect(getComputedStyle(node).flexShrink).toBe("0");
        expect(getComputedStyle(node).whiteSpace).toBe("nowrap");
      }
    });

    it("keeps the body at its fixed height whatever the entry wraps to: it scrolls inside", () => {
      navigation();
      const { container } = render(<IncidentBlock />);
      const body = getComputedStyle(container.querySelector("[data-incident-scroll]") as Element);
      expect(body.flexBasis).toBe(`${INCIDENT_BODY_HEIGHT}px`);
      expect(body.overflowY).toBe("auto");
      expect(body.overflowX).toBe("hidden");
    });

    it("ends the time range line of a run with an ellipsis and offers the full text as its title", () => {
      chain({ selectedIndex: 0 });
      const { container } = render(<IncidentBlock />);
      const times = container.querySelector("[data-incident-run-times]") as HTMLElement;
      const style = getComputedStyle(times);
      expect([style.overflow, style.textOverflow, style.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
      expect(times.textContent).toBe("Miss ×5 · 1:04.661 – 1:04.989");
      expect(times.title).toBe(times.textContent);
    });

    it("lets a member's label ellipsise while its type and time keep their size", () => {
      chain({ expanded: new Set(["miss:c0"]) });
      render(<IncidentBlock />);
      const row = members()[1];
      const [labelCell, type, time] = Array.from(row.children) as HTMLElement[];
      const label = getComputedStyle(labelCell.firstElementChild as Element);
      expect([label.minWidth, label.overflow, label.textOverflow, label.whiteSpace]).toEqual(["0", "hidden", "ellipsis", "nowrap"]);
      expect(getComputedStyle(labelCell).minWidth).toBe("0");
      expect(getComputedStyle(type).flexShrink).toBe("0");
      expect(getComputedStyle(time).flexShrink).toBe("0");
    });

    it("keeps the label above ellipsised on one line and Follow at its size", () => {
      navigation();
      render(<IncidentBlock />);
      const label = getComputedStyle(screen.getByText("1–2/3"));
      expect([label.minWidth, label.overflow, label.textOverflow, label.whiteSpace]).toEqual(["0", "hidden", "ellipsis", "nowrap"]);
      expect(getComputedStyle(button("Follow")).flexShrink).toBe("0");
    });

    it("keeps the hit-window label inside its box at both ends of the band", () => {
      navigation();
      render(<IncidentBlock />);
      const diagram = screen.getByRole("img", { name: /hit window/i });
      const label = diagram.querySelector(":scope > span") as HTMLElement;
      const style = getComputedStyle(label);
      expect(style.whiteSpace).toBe("nowrap");
      // left: p% and translateX(-p%): the label is never wider outside the box than the band end allows.
      expect(style.transform).toBe(`translateX(-${style.left})`);
    });

    it("opens the chooser no wider than the narrowest inspector (a minimum of 232 px at most), within the window", () => {
      const dense: ReplayError[] = [...errors.slice(0, 2), { id: "miss:3", time: 66_800, type: "MISS", hitObjectId: "3" }];
      navigation({ errors: dense, selectedIndex: -1 });
      const { container } = render(<IncidentBlock />);
      fireEvent.click(container.querySelectorAll("[data-density-bin]")[Math.floor((66_472 / 118_000) * 60)]);
      const paper = screen.getByRole("menu", { name: "Incidents here" }).closest(".MuiPaper-root") as HTMLElement;
      const style = getComputedStyle(paper);
      expect(parseFloat(style.minWidth)).toBeLessThanOrEqual(232);
      expect(style.maxWidth).toBe("calc(100vw - 16px)");
    });
  });

  it("selects from a bin with one incident and opens a chooser for a dense bin", () => {
    const dense: ReplayError[] = [...errors.slice(0, 2), { id: "miss:3", time: 66_800, type: "MISS", hitObjectId: "3" }];
    navigation({ errors: dense, selectedIndex: -1 });
    const { container } = render(<IncidentBlock />);
    const bins = container.querySelectorAll("[data-density-bin]");
    fireEvent.click(bins[Math.floor((66_472 / 118_000) * 60)]);
    // Nothing is chosen for the user.
    expect(selectIncident).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu", { name: "Incidents here" });
    // A quiet header that the keyboard skips: the first real item takes the focus.
    expect(within(menu).getByText("2 INCIDENTS HERE")).toBeTruthy();
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(document.activeElement).toBe(items[0]);
    // Each item: cause chain and time on the first line, type chain below.
    const parts = (item: HTMLElement) => [
      ...Array.from(item.querySelectorAll(":scope > span:first-child > span")).map((part) => part.textContent),
      item.querySelector(":scope > span:nth-child(2)")?.textContent,
    ];
    expect(items.map(parts)).toEqual([
      ["Late tap → Notelock", "1:06.472", "Miss → Slider break"],
      ["Miss", "1:06.800", "Miss"],
    ]);
    fireEvent.click(items[1]);
    expect(selectIncident).toHaveBeenCalledTimes(1);
    expect(selectIncident).toHaveBeenLastCalledWith(1);
    expect(selectError).not.toHaveBeenCalled();
  });

  it("opens no chooser for a bin with one incident", () => {
    navigation({ selectedIndex: -1 });
    const { container } = render(<IncidentBlock />);
    fireEvent.click(container.querySelectorAll("[data-density-bin]")[Math.floor((66_472 / 118_000) * 60)]);
    expect(selectIncident).toHaveBeenLastCalledWith(0);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not re-render or change while playback ticks with nothing inspected", () => {
    navigation({ selectedIndex: -1 });
    const tickTo = tickingClock(0);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const binsSpy = jest.spyOn(require("../../services/analysis/incidents"), "buildDensityBins");
    const { container } = render(<IncidentBlock />);
    // Only the block body reads the navigation state; its children get props.
    const bodyRenders = (useErrorNavigation as jest.Mock).mock.calls.length;
    const binBuilds = binsSpy.mock.calls.length;
    const playhead = container.querySelector("[data-density-playhead]") as HTMLElement;
    const leftBefore = playhead.style.left;
    const section = screen.getByRole("region", { name: "Current incident" });
    const prompt = screen.getByText("Select an incident, or follow playback.");
    expect(button("Previous incident").disabled).toBe(true);

    tickTo(70_000);
    tickTo(100_000);

    // The ticks arrived: the mark moved and the step buttons follow the playhead.
    expect(playhead.style.left).not.toBe(leftBefore);
    expect(button("Previous incident").disabled).toBe(false);
    // The body did not render again and still shows the prompt, the same label and no entry.
    expect((useErrorNavigation as jest.Mock).mock.calls.length).toBe(bodyRenders);
    expect(binsSpy.mock.calls.length).toBe(binBuilds);
    expect(section.contains(prompt)).toBe(true);
    expect(screen.getByText("3 ERRORS")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    binsSpy.mockRestore();
  });

  it("keeps an inspected incident's body untouched while playback passes other incidents", () => {
    chain({ expanded: new Set(["miss:c0"]), selectedIndex: 3 });
    const tickTo = tickingClock(60_000);
    const { container } = render(<IncidentBlock />);
    const bodyRenders = (useErrorNavigation as jest.Mock).mock.calls.length;
    const body = container.querySelector("[data-incident-scroll]") as HTMLElement;
    const before = body.innerHTML;
    const playhead = container.querySelector("[data-density-playhead]") as HTMLElement;
    const leftBefore = playhead.style.left;
    for (const time of [64_700, 70_000, 79_200, 110_000]) tickTo(time);
    expect(playhead.style.left).not.toBe(leftBefore);
    expect((useErrorNavigation as jest.Mock).mock.calls.length).toBe(bodyRenders);
    expect(body.innerHTML).toBe(before);
    expect(screen.getByText("1–6/7")).toBeTruthy();
  });

  it("never seeks, starts or selects on hover, scroll or wheel", () => {
    chain({ expanded: new Set(["miss:c0"]) });
    const { container } = render(<IncidentBlock />);
    const targets = [
      ...Array.from(container.querySelectorAll("[data-density-bin]")),
      ...members(),
      container.querySelector("[data-incident-scroll]") as Element,
      screen.getByRole("list", { name: "Incident members" }),
      button("Follow"),
      button("Replay at 0.25× speed"),
      button("Replay at 0.5× speed"),
      button("Replay at 1× speed"),
      button("Next incident"),
    ];
    for (const target of targets) {
      fireEvent.mouseEnter(target);
      fireEvent.mouseOver(target);
      fireEvent.mouseMove(target);
      fireEvent.focus(target);
      fireEvent.wheel(target, { deltaY: 120 });
      fireEvent.scroll(target);
    }
    for (const mock of [selectError, selectIncident, setFollowing, toggleExpanded, replaySelection, seekTo, start]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("keeps the member buttons' keys away from the global shortcuts", () => {
    chain({ expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    const onKeyDown = jest.fn();
    document.addEventListener("keydown", onKeyDown);
    fireEvent.keyDown(members()[1], { key: "ArrowLeft" });
    fireEvent.keyDown(members()[1], { key: "d" });
    document.removeEventListener("keydown", onKeyDown);
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

describe("IncidentsList inspection", () => {
  const list = () => screen.getByRole("list", { name: "Incidents" });
  const rows = () => within(list()).getAllByRole("button");
  const field = () => screen.getByRole("textbox", { name: "Go to time" }) as HTMLInputElement;
  let scrollIntoView: jest.Mock;
  beforeEach(() => {
    scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("keeps the header on one line at 204 px: the count gives way, the title and the 96 px field do not", () => {
    chain();
    render(<IncidentsList />);
    const count = getComputedStyle(screen.getByText("2", { selector: "span" }));
    expect([count.minWidth, count.overflow, count.textOverflow, count.whiteSpace]).toEqual(["0", "hidden", "ellipsis", "nowrap"]);
    expect(getComputedStyle(screen.getByText("2", { selector: "span" }).parentElement as HTMLElement).minWidth).toBe("0");
    expect(getComputedStyle(screen.getByText("Incidents", { selector: "span" })).flexShrink).toBe("0");
    const style = getComputedStyle(field());
    expect([style.flexShrink, style.width, style.boxSizing]).toEqual(["0", "96px", "border-box"]);
  });

  it("lets a row title wrap but keeps the time on one line that cannot shrink", () => {
    chain();
    render(<IncidentsList />);
    const time = rows()[0].querySelector("[data-incident-time]") as HTMLElement;
    const timeStyle = getComputedStyle(time);
    expect([timeStyle.flexShrink, timeStyle.whiteSpace]).toEqual(["0", "nowrap"]);
    const title = time.previousElementSibling as HTMLElement;
    expect(getComputedStyle(title).minWidth).toBe("0");
    expect(getComputedStyle(title).whiteSpace).not.toBe("nowrap");
  });

  it("titles a row with the compressed cause chain and the compressed types", () => {
    chain();
    render(<IncidentsList />);
    expect(screen.getByText("2", { selector: "span" })).toBeTruthy();
    expect(rows().map((row) => row.textContent)).toEqual(["Late tap → Notelock ×51:04.595Miss ×6", "Miss1:19.121Miss"]);
  });

  it("marks the playback position apart from the inspected row", () => {
    navigation({ selectedIndex: 0 });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(1);
    render(<IncidentsList />);
    const [inspected, playing] = rows();
    expect(inspected.getAttribute("aria-current")).toBe("true");
    expect(inspected.querySelector("[data-playback-position]")).toBeNull();
    expect(inspected.textContent).not.toContain("playback position");
    expect(playing.getAttribute("aria-current")).toBeNull();
    expect(playing.querySelector("[data-playback-position]")).toBeTruthy();
    expect(playing.textContent).toContain(" (playback position)");
    // Not a highlight: the playing row keeps the plain background of an unselected row.
    expect(getComputedStyle(playing).backgroundColor).not.toBe(getComputedStyle(inspected).backgroundColor);
  });

  it("can mark the inspected row as the playback position too", () => {
    navigation({ selectedIndex: 0 });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(0);
    render(<IncidentsList />);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(rows()[0].querySelector("[data-playback-position]")).toBeTruthy();
    expect(rows()[1].querySelector("[data-playback-position]")).toBeNull();
  });

  it("re-renders only the two affected rows when the playback position moves", () => {
    const sixteen: ReplayError[] = Array.from({ length: 16 }, (_, index) => ({
      id: `miss:r${index}`,
      time: 1_000 * (index + 1),
      type: "MISS",
      hitObjectId: `r${index}`,
    }));
    const state = navigation({
      errors: sixteen,
      selectedIndex: 2,
      causes: new Map(),
      incidents: sixteen.map((error, index) => ({ id: error.id, errorIndices: [index], leadIndex: index, links: [] })),
    });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(4);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rowSpy = jest.spyOn(require("./incident-format"), "splitErrorTime");
    const { rerender } = render(<IncidentsList />);
    expect(rowSpy).toHaveBeenCalledTimes(16);
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(5);
    (useErrorNavigation as jest.Mock).mockReturnValue({ ...state });
    act(() => rerender(<IncidentsList />));
    expect(rowSpy).toHaveBeenCalledTimes(18);
    expect(rows()[5].querySelector("[data-playback-position]")).toBeTruthy();
    expect(rows()[4].querySelector("[data-playback-position]")).toBeNull();
    // The inspected row did not move with playback.
    expect(rows()[2].getAttribute("aria-current")).toBe("true");
    rowSpy.mockRestore();
  });

  describe("Go to time", () => {
    const far: ReplayError[] = [
      { id: "miss:f0", time: 60_000, type: "MISS", hitObjectId: "f0" },
      { id: "miss:f1", time: 178_300, type: "MISS", hitObjectId: "f1" },
      { id: "miss:f2", time: 267_200, type: "MISS", hitObjectId: "f2" },
    ];
    const farState = () =>
      navigation({
        errors: far,
        selectedIndex: -1,
        causes: new Map(),
        incidents: far.map((error, index) => ({ id: error.id, errorIndices: [index], leadIndex: index, links: [] })),
      });
    const enter = (text: string) => {
      fireEvent.change(field(), { target: { value: text } });
      fireEvent.keyDown(field(), { key: "Enter" });
    };

    it("is a small labelled field with a Go to 0:00 hint", () => {
      farState();
      render(<IncidentsList />);
      expect(field().placeholder).toBe("Go to 0:00");
      expect(field().title).toBe("Jump to the incident nearest this time (m:ss)");
      expect(field().getAttribute("aria-invalid")).not.toBe("true");
    });

    it.each([
      [1, "2:58", 1],
      // Displayed 2:58 at 1.5× is map time 4:27.
      [1.5, "2:58", 2],
      [1, "2:58.250", 1],
      [1, "61", 0],
      [1.5, "30", 0],
    ])("at rate %s inspects the incident nearest %s", (baseRate, text, incidentIndex) => {
      controls({ baseRate });
      farState();
      render(<IncidentsList />);
      enter(text);
      expect(selectIncident).toHaveBeenCalledTimes(1);
      expect(selectIncident).toHaveBeenLastCalledWith(incidentIndex);
      expect(field().value).toBe("");
      expect(field().getAttribute("aria-invalid")).not.toBe("true");
    });

    it("flags an entry it cannot read until it is edited, and goes nowhere", () => {
      farState();
      render(<IncidentsList />);
      for (const text of ["abc", "1:75", "-3", ""]) {
        enter(text);
        expect(selectIncident).not.toHaveBeenCalled();
        if (text) expect(field().getAttribute("aria-invalid")).toBe("true");
        else expect(field().getAttribute("aria-invalid")).not.toBe("true");
      }
      enter("abc");
      expect(field().getAttribute("aria-invalid")).toBe("true");
      fireEvent.change(field(), { target: { value: "abcd" } });
      expect(field().getAttribute("aria-invalid")).not.toBe("true");
    });

    it("clears and leaves the field on Escape", () => {
      farState();
      render(<IncidentsList />);
      act(() => field().focus());
      fireEvent.change(field(), { target: { value: "abc" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(field().value).toBe("");
      expect(field().getAttribute("aria-invalid")).not.toBe("true");
      expect(document.activeElement).not.toBe(field());
      expect(selectIncident).not.toHaveBeenCalled();
    });

    it("is absent when there is nothing to go to", () => {
      navigation({ errors: [], incidents: [], causes: new Map(), selectedIndex: -1 });
      render(<IncidentsList />);
      expect(screen.queryByRole("textbox", { name: "Go to time" })).toBeNull();
    });

    it("keeps its keys away from the global shortcuts and never seeks while typing", () => {
      farState();
      render(<IncidentsList />);
      const onKey = jest.fn();
      document.addEventListener("keydown", onKey);
      document.addEventListener("keyup", onKey);
      for (const key of [" ", "ArrowLeft", "d", "f", "Enter", "Escape"]) {
        fireEvent.keyDown(field(), { key });
        fireEvent.keyUp(field(), { key });
      }
      fireEvent.change(field(), { target: { value: "2:5" } });
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keyup", onKey);
      expect(onKey).not.toHaveBeenCalled();
      expect(selectIncident).not.toHaveBeenCalled();
      expect(seekTo).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe("scrolling", () => {
    it("reveals the inspected row only when a reveal is requested", () => {
      const state = navigation({ selectedIndex: -1 });
      const { rerender } = render(<IncidentsList />);
      const next = (extra: Partial<ErrorNavigationState>) => {
        (useErrorNavigation as jest.Mock).mockReturnValue({ ...state, ...extra });
        act(() => rerender(<IncidentsList />));
      };
      expect(scrollIntoView).not.toHaveBeenCalled();
      // Follow or a list click: the inspection changes, the token does not.
      next({ selectedIndex: 2 });
      next({ selectedIndex: 0, following: true });
      // Playback moves on.
      (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(1);
      next({ selectedIndex: 0, following: true });
      expect(scrollIntoView).not.toHaveBeenCalled();
      // Arrows, a density pick or a time entry bump the token.
      next({ selectedIndex: 2, revealToken: 1 });
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.instances[0]).toBe(rows()[1]);
      // The same incident again (a member, or the same arrow target): still an explicit navigation.
      next({ selectedIndex: 2, revealToken: 2 });
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    });

    it("does not reveal on mount, whatever the token is", () => {
      navigation({ selectedIndex: 2, revealToken: 7 });
      render(<IncidentsList />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("stores its scroll position in the provider and restores it when it is shown again", () => {
      const state = navigation({ listScrollTop: { current: 140 } });
      const first = render(<IncidentsList />);
      expect(list().scrollTop).toBe(140);
      list().scrollTop = 60;
      fireEvent.scroll(list());
      expect(state.listScrollTop.current).toBe(60);
      // Hidden and shown again: the provider stays, the list is a new element.
      first.unmount();
      render(<IncidentsList />);
      expect(list().scrollTop).toBe(60);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(selectIncident).not.toHaveBeenCalled();
    });

    it("starts at the top for another error list", () => {
      const state = navigation({ selectedIndex: -1 });
      const { rerender } = render(<IncidentsList />);
      list().scrollTop = 90;
      fireEvent.scroll(list());
      expect(state.listScrollTop.current).toBe(90);
      (useErrorNavigation as jest.Mock).mockReturnValue({ ...state, errors: [...errors] });
      act(() => rerender(<IncidentsList />));
      expect(list().scrollTop).toBe(0);
      expect(state.listScrollTop.current).toBe(0);
    });

    describe("regroup anchor", () => {
      const ROW = 40;
      const TOP = 100;
      const VIEW = 120;
      const eight: ReplayError[] = Array.from({ length: 8 }, (_, index) => ({
        id: `miss:g${index}`,
        time: 1_000 * (index + 1),
        type: "MISS",
        hitObjectId: `g${index}`,
      }));
      const single = (indices: number[]): Incident => ({ id: eight[indices[0]].id, errorIndices: indices, leadIndex: indices[0], links: [] });
      const alone = eight.map((_, index) => single([index]));
      let rectSpy: jest.SpyInstance;
      beforeEach(() => {
        // Rows are 40 px high inside a 120 px viewport that starts at y = 100.
        rectSpy = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) });
          if (this.tagName === "UL") return rect(TOP, VIEW);
          const item = this.closest("li");
          const scroller = item?.parentElement;
          if (!item || !scroller) return rect(0, 0);
          return rect(TOP + Array.from(scroller.children).indexOf(item) * ROW - scroller.scrollTop, ROW);
        });
      });
      afterEach(() => rectSpy.mockRestore());

      const mountAt = (scrollTop: number, selectedIndex: number) => {
        const state = navigation({ errors: eight, incidents: alone, causes: new Map(), selectedIndex });
        const view = render(<IncidentsList />);
        list().scrollTop = scrollTop;
        fireEvent.scroll(list());
        const regroup = (incidents: Incident[], extra: Partial<ErrorNavigationState> = {}) => {
          (useErrorNavigation as jest.Mock).mockReturnValue({ ...state, incidents, ...extra });
          act(() => view.rerender(<IncidentsList />));
        };
        return { state, regroup };
      };

      it("keeps the inspected row where it was when rows above it merge", () => {
        // Row 4 sits at y = 180 (visible).
        const { state, regroup } = mountAt(80, 4);
        regroup([single([0, 1, 2]), single([3]), single([4]), single([5]), single([6]), single([7])]);
        expect(rows()[2].getAttribute("aria-current")).toBe("true");
        expect(rows()[2].getBoundingClientRect().top).toBe(180);
        expect(list().scrollTop).toBe(0);
        expect(state.listScrollTop.current).toBe(0);
        expect(scrollIntoView).not.toHaveBeenCalled();
      });

      it("keeps the first visible row where it was when nothing is inspected", () => {
        // Row 2 is the first visible row, at y = 100.
        const { regroup } = mountAt(80, -1);
        regroup([single([0, 1]), single([2]), single([3]), single([4]), single([5]), single([6]), single([7])]);
        expect(list().scrollTop).toBe(40);
        expect(rows()[1].getBoundingClientRect().top).toBe(100);
      });

      it("anchors on the first visible row when the inspected row is out of view", () => {
        // Row 0 is inspected but scrolled away; row 3 is the first visible row, at y = 100.
        const { regroup } = mountAt(120, 0);
        regroup([single([0]), single([1, 2]), single([3]), single([4]), single([5]), single([6]), single([7])]);
        expect(list().scrollTop).toBe(80);
        expect(rows()[2].getBoundingClientRect().top).toBe(100);
      });

      it("follows the inspected error into the incident that swallowed it", () => {
        // Error 4 (row 4, y = 180) becomes a member of the incident led by error 3.
        const { regroup } = mountAt(80, 4);
        regroup([single([0]), single([1]), single([2]), single([3, 4]), single([5]), single([6]), single([7])]);
        expect(rows()[3].getAttribute("aria-current")).toBe("true");
        expect(rows()[3].getBoundingClientRect().top).toBe(180);
        expect(list().scrollTop).toBe(40);
      });

      it("does not move the list for a re-render with the same incidents", () => {
        const { regroup } = mountAt(80, -1);
        regroup(alone, { selectedIndex: 6 });
        expect(list().scrollTop).toBe(80);
      });
    });
  });

  it("does not take focus on a pointer press on a row, and still takes keyboard focus", () => {
    chain();
    render(<IncidentsList />);
    const row = rows()[1];
    const press = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    fireEvent(row, press);
    expect(press.defaultPrevented).toBe(true);
    fireEvent.click(row);
    expect(selectIncident).toHaveBeenCalledWith(1, { reveal: false });
    expect(document.activeElement).not.toBe(row);
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
  });

  it("keeps the row buttons' keys away from the global shortcuts", () => {
    chain();
    render(<IncidentsList />);
    const onKeyDown = jest.fn();
    document.addEventListener("keydown", onKeyDown);
    fireEvent.keyDown(rows()[1], { key: "ArrowRight" });
    fireEvent.keyDown(rows()[1], { key: "a" });
    document.removeEventListener("keydown", onKeyDown);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("never selects, seeks or starts on hover, scroll or wheel", () => {
    chain();
    render(<IncidentsList />);
    for (const target of [...rows(), list(), field()]) {
      fireEvent.mouseEnter(target);
      fireEvent.mouseOver(target);
      fireEvent.mouseMove(target);
      fireEvent.focus(target);
      fireEvent.wheel(target, { deltaY: 120 });
      fireEvent.scroll(target);
    }
    for (const mock of [selectError, selectIncident, setFollowing, toggleExpanded, replaySelection, seekTo, start]) {
      expect(mock).not.toHaveBeenCalled();
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("GUI QA fixes (layout traps)", () => {
  const list = () => screen.getByRole("list", { name: "Incidents" });
  const rows = () => within(list()).getAllByRole("button");

  it("draws an empty density bin as a 1 px tick, not 100 % (a bare 1 in sx is a fraction)", () => {
    // Two incidents lead in the same stretch of the map, one in another; every other bin is empty.
    const twoInOne: ReplayError[] = [
      { id: "miss:a", time: 66_472, type: "MISS", hitObjectId: "a" },
      { id: "miss:b", time: 66_553, type: "MISS", hitObjectId: "b" },
      { id: "miss:c", time: 10_000, type: "MISS", hitObjectId: "c" },
    ];
    navigation({
      errors: twoInOne,
      selectedIndex: -1,
      causes: new Map(),
      incidents: twoInOne.map((error, index) => ({ id: error.id, errorIndices: [index], leadIndex: index, links: [] })),
    });
    const { container } = render(<IncidentBlock />);
    const heights = Array.from(container.querySelectorAll("[data-density-bar]")).map((bar) => getComputedStyle(bar).height);
    expect(heights).toHaveLength(60);
    expect(heights.filter((height) => height === "1px")).toHaveLength(58);
    expect(heights.filter((height) => height === "9px")).toHaveLength(1);
    expect(heights.filter((height) => height === "13px")).toHaveLength(1);
    expect(heights.some((height) => height.includes("%"))).toBe(false);
  });

  it("makes the visually hidden text 1 px by px strings, out of the box and out of the scroll width", () => {
    expect(visuallyHidden).toMatchObject({
      position: "absolute",
      width: "1px",
      height: "1px",
      m: "-1px",
      p: 0,
      border: 0,
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    });
    navigation({ selectedIndex: 0 });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(1);
    render(<IncidentsList />);
    const hidden = Array.from(rows()[1].querySelectorAll("span")).find((span) => span.textContent === " (playback position)") as HTMLElement;
    const style = getComputedStyle(hidden);
    expect([style.position, style.width, style.height, style.margin]).toEqual(["absolute", "1px", "1px", "-1px"]);
    // Its containing block lies inside the row, and the list never scrolls sideways.
    expect(getComputedStyle(rows()[1]).position).toBe("relative");
    expect(getComputedStyle(hidden.parentElement as HTMLElement).position).toBe("relative");
    expect(getComputedStyle(list()).overflowX).toBe("hidden");
    expect(getComputedStyle(list()).overflowY).toBe("auto");
  });

  it("gives every row the same fixed line heights, with or without the playback mark", () => {
    navigation({ selectedIndex: 0 });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(0);
    const view = render(<IncidentsList />);
    const lines = (row: HTMLElement) => {
      const time = row.querySelector("[data-incident-time]") as HTMLElement;
      const title = time.previousElementSibling as HTMLElement;
      const types = row.children[1] as HTMLElement;
      return [title, time, types].map((node) => [getComputedStyle(node).lineHeight, getComputedStyle(node).height]);
    };
    const withMark = rows().map(lines);
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(-1);
    navigation({ selectedIndex: 1 });
    view.rerender(<IncidentsList />);
    const withoutMark = rows().map(lines);
    // The time cell has an explicit height and line height equal to the title's, in every state.
    for (const [title, time, types] of [...withMark, ...withoutMark]) {
      expect(title[0]).toBe("20px");
      expect(time).toEqual(["20px", "20px"]);
      expect(types[0]).toBe("18px");
    }
    expect(withMark[0]).toEqual(withoutMark[0]);
    // The mark and its text are out of the line layout.
    view.unmount();
    navigation({ selectedIndex: 0 });
    (usePlayheadIncidentIndex as jest.Mock).mockReturnValue(0);
    render(<IncidentsList />);
    const dot = rows()[0].querySelector("[data-playback-position]") as HTMLElement;
    expect(getComputedStyle(dot).position).toBe("absolute");
    expect(getComputedStyle(dot).width).toBe("5px");
    expect(getComputedStyle(dot.parentElement as HTMLElement).position).toBe("relative");
  });

  it("brings the members into view inside the body when the user shows them, and only then", () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const state = chain({ selectedIndex: 0 });
    const view = render(<IncidentBlock />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(button("Show 5"));
    expect(toggleExpanded).toHaveBeenCalledWith("miss:c0");
    // The members are not on screen until the state changes.
    expect(scrollIntoView).not.toHaveBeenCalled();
    chain({ ...state, expanded: new Set(["miss:c0"]) });
    view.rerender(<IncidentBlock />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    const target = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(target.hasAttribute("data-incident-members")).toBe(true);
    expect((document.querySelector("[data-incident-scroll]") as HTMLElement).contains(target)).toBe(true);
    expect(target.contains(members()[0])).toBe(true);
    // Hiding, and a rerender, scroll nothing.
    fireEvent.click(button("Hide"));
    chain({ ...state, expanded: new Set() });
    view.rerender(<IncidentBlock />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("keeps the label on one line next to Follow, with its full text as the title", () => {
    chain({ selectedIndex: 0 });
    render(<IncidentBlock />);
    const label = document.querySelector("[data-incident-label]") as HTMLElement;
    const style = getComputedStyle(label);
    expect([style.whiteSpace, style.overflow, style.textOverflow, style.minWidth, style.flexGrow]).toEqual(["nowrap", "hidden", "ellipsis", "0", "1"]);
    expect(label.getAttribute("title")).toBe(label.textContent);
    expect(label.textContent).toBe("1–6/7");
    expect(getComputedStyle(button("Follow")).flexGrow).toBe("0");
    expect(getComputedStyle(button("Follow")).flexShrink).toBe("0");
  });

  it("brings the selected member into view when the block mounts with it selected", () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // The inspector shown again: a non-lead member is selected in an expanded incident.
    chain({ selectedIndex: 4, expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances[0]).toBe(members()[4]);
  });

  it("scrolls nothing on mount when the lead is selected", () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    chain({ selectedIndex: 0, expanded: new Set(["miss:c0"]) });
    render(<IncidentBlock />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
