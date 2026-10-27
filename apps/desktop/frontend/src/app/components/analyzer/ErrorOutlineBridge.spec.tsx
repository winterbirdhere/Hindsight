import { act, render } from "@testing-library/react";
import type { ReplayAnalysisEvent } from "@osujs/core";
import { BehaviorSubject, Subject } from "rxjs";
import { ErrorNavigationProvider, type ErrorNavigationState, useErrorNavigation } from "../../hooks/error-navigation";
import { useGameClockControls } from "../../hooks/game-clock";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { ErrorOutlineStore } from "../../services/common/error-outline";
import { ErrorOutlineBridge } from "./ErrorOutlineBridge";

jest.mock("../../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("../../hooks/game-clock", () => ({ useGameClockControls: jest.fn(), useGameClockTime: jest.fn(() => 0) }));

const miss = (id: string, time: number, blocker?: string): ReplayAnalysisEvent =>
  ({
    type: "HitObjectJudgement",
    ruleset: "stable",
    hitObjectId: id,
    verdict: "MISS",
    time: time + 100,
    objectTime: time,
    judgementTime: time + 100,
    position: { x: time / 10, y: 50 },
    ...(blocker ? { notelockCause: { blockerHitObjectId: blocker } } : {}),
  }) as ReplayAnalysisEvent;

/** Errors 0–2 are one notelock chain (a → b, c); error 3 stands alone. */
const chain = () => [miss("a", 1_000), miss("b", 1_100, "a"), miss("c", 1_200, "a"), miss("d", 5_000)];

let nav: ErrorNavigationState;
function Probe() {
  nav = useErrorNavigation();
  return null;
}

/** One cursor sample every 50 ms from 0 to 6000, x = time / 10. */
const FRAMES = Array.from({ length: 121 }, (_unused, index) => ({ time: index * 50, position: { x: index * 5, y: 9 } }));

/** One replay object for the whole test, like the simulator's: a new one would reset the inspection. */
const REPLAY = { frames: FRAMES };

/** A ready analysis that attributes one tap (43 ms after the note, by the trace) to miss "b" and none to the others. */
function analysed(codes = ["aim-late"]) {
  const atom = (id: string, time: number) => ({
    id: `atom:${id}`,
    componentId: id,
    component: "circle",
    result: "MISS",
    role: "primary",
    identity: { analysisProfileId: "stable" },
    objectTimeMs: time,
    resolutionTimeMs: time + 100,
    relatedAtomIds: [],
    pendingContributionIds: [],
  });
  const mechanism = (associations: unknown[]) => ({
    status: "supported",
    codes,
    headline: "Aim late",
    description: "",
    eventIds: [],
    limitations: [],
    diagnostics: { opportunities: [], primary: { association: { associations, limitations: [] } } },
  });
  return {
    status: "ready",
    identity: { analysisProfileId: "stable" },
    trace: {
      records: [
        // "b" is judged at (110, 50) with radius 32: this tap is on the circle.
        { id: "in-b", kind: "input", phase: "input", timeMs: 1_143, position: { x: 114.3, y: 49 } },
        // Nearer to "a" in time than anything else, and given to no note: never shown.
        { id: "in-stray", kind: "input", phase: "input", timeMs: 1_010, position: { x: 101, y: 9 } },
      ],
    },
    analysis: {
      inventory: { atoms: [atom("a", 1_000), atom("b", 1_100), atom("c", 1_200), atom("d", 5_000)] },
      classifications: [
        { atomId: "atom:a", mechanism: mechanism([{ inputId: "in-stray", role: "context", reasons: [], eventIds: [] }]) },
        { atomId: "atom:b", mechanism: mechanism([{ inputId: "in-b", role: "relevant", reasons: [], eventIds: [] }]) },
      ],
      incidents: [],
      excludedModelAtomIds: [],
    },
  };
}

function mount(events = chain(), options: { session?: object; clockRate?: number; mode?: "default" } = {}) {
  window.localStorage.clear();
  const replayEvents$ = new BehaviorSubject(events);
  const settingsStore = new ReplayDisplaySettingsStore();
  // The default is Off; most of these tests are about what an inspection does, which is Selected.
  if (options.mode !== "default") settingsStore.changeSettings((draft) => void (draft.errorOutline = "selected"));
  const errorOutlineStore = new ErrorOutlineStore();
  const beatmap: { current: unknown } = {
    current: {
      gameClockRate: options.clockRate ?? 1,
      getHitObject: (id: string) => ({ type: "HIT_CIRCLE", id, spawnTime: 0, scale: 0.5 }),
      // No object is listed, so every trail takes its 0.4 s.
      hitObjects: [],
    },
  };
  (useGameClockControls as jest.Mock).mockReturnValue({
    baseRate: 1,
    seekTo: jest.fn(),
    pause: jest.fn(),
    start: jest.fn(),
    setSpeed: jest.fn(),
  });
  const gameClock = {
    timeElapsedInMs: 0,
    seeked$: new Subject<number>(),
    isPlaying$: new BehaviorSubject(false),
    speed: 1,
    playbackBoundaryInMs: undefined,
    setPlaybackBoundary: jest.fn(),
  };
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameClock,
    scenarioManager: { loadState$: new BehaviorSubject({ phase: "ready" }) },
    replayDisplaySettingsStore: settingsStore,
    errorOutlineStore,
    gameSimulator: {
      replayEvents$,
      rulesetFocus$: new BehaviorSubject<"stable" | "lazer">("stable"),
      missExplanations$: new BehaviorSubject(options.session ?? { status: "not-captured" }),
      missAnalysisProgress$: new BehaviorSubject(undefined),
      getPrimaryReplay: () => REPLAY,
      getPrimaryBeatmap: () => beatmap.current,
      hasReplayForMissAnalysis: () => false,
      analyzeMisses: jest.fn(),
    },
  });
  const view = render(
    <ErrorNavigationProvider>
      <Probe />
      <ErrorOutlineBridge />
    </ErrorNavigationProvider>,
  );
  const outlined = () => errorOutlineStore.targets.map((target) => [target.errorId, target.emphasis]);
  const setMode = (mode: "off" | "selected" | "all") =>
    act(() => settingsStore.changeSettings((draft) => void (draft.errorOutline = mode)));
  const set = (change: (draft: ReplayDisplaySettingsStore["settings"]) => void) =>
    act(() => settingsStore.changeSettings(change));
  return { view, errorOutlineStore, replayEvents$, outlined, setMode, set, beatmap, gameClock };
}

describe("ErrorOutlineBridge", () => {
  it("by default outlines nothing: the option starts off", () => {
    const { outlined } = mount(chain(), { mode: "default" });
    act(() => nav.selectError(1));
    expect(outlined()).toEqual([]);
  });

  it("outlines every error in All, with nothing inspected", () => {
    const { outlined, setMode } = mount();
    setMode("all");
    expect(outlined().map(([id]) => id)).toEqual(["miss:a", "miss:b", "miss:c", "miss:d"]);
  });

  it("gives the renderer nothing until an error is inspected", () => {
    const { outlined } = mount();
    expect(outlined()).toEqual([]);
  });

  it("outlines the inspected error in full and the rest of its incident lightly", () => {
    const { outlined, errorOutlineStore } = mount();
    act(() => nav.selectError(1));
    expect(outlined()).toEqual([
      ["miss:b", "full"],
      ["miss:a", "light"],
      ["miss:c", "light"],
    ]);
    expect(errorOutlineStore.targets[0]).toMatchObject({ position: { x: 110, y: 50 }, holdFrom: 1_200, radius: 32 });
    act(() => nav.selectError(3));
    expect(outlined()).toEqual([["miss:d", "full"]]);
  });

  it("follows the Error outline setting: All needs no inspection, Off shows nothing", () => {
    const { outlined, setMode } = mount();
    setMode("all");
    expect(outlined()).toEqual([
      ["miss:a", "full"],
      ["miss:b", "full"],
      ["miss:c", "full"],
      ["miss:d", "full"],
    ]);
    act(() => nav.selectError(1));
    expect(outlined()).toHaveLength(4);
    setMode("off");
    expect(outlined()).toEqual([]);
    setMode("selected");
    expect(outlined().map(([id]) => id)).toEqual(["miss:b", "miss:a", "miss:c"]);
  });

  it("drops the rings of a replay that is gone", () => {
    const { outlined, replayEvents$, setMode } = mount();
    setMode("all");
    expect(outlined()).toHaveLength(4);
    act(() => replayEvents$.next([miss("z", 9_000)]));
    expect(outlined()).toEqual([["miss:z", "full"]]);
    act(() => replayEvents$.next([]));
    expect(outlined()).toEqual([]);
  });

  describe("miss trail", () => {
    const byId = (store: ErrorOutlineStore, errorId: string) => {
      const found = store.targets.find((target) => target.errorId === errorId);
      if (!found) throw new Error(`no target for ${errorId}`);
      return found;
    };

    it("gives an error the replay's own cursor samples around it", () => {
      const { errorOutlineStore } = mount();
      act(() => nav.selectError(1));
      // "b" is at 1100 and judged at 1200: samples from 700 to 1200.
      expect(byId(errorOutlineStore, "miss:b").trail.map((point) => point.time)).toEqual([700, 750, 800, 850, 900, 950, 1_000, 1_050, 1_100, 1_150, 1_200]);
      expect(byId(errorOutlineStore, "miss:b").trail[0]).toEqual({ x: 70, y: 9, time: 700 });
    });

    it("shows a tap only where the analysis attributes one, with no number beside it by default", () => {
      const { errorOutlineStore } = mount(chain(), { session: analysed() });
      act(() => nav.selectError(1));
      expect(byId(errorOutlineStore, "miss:b").taps).toEqual([
        { position: { x: 114.3, y: 49 }, time: 1_143, certainty: "attributed", offsetMs: 43 },
      ]);
      expect(byId(errorOutlineStore, "miss:b").taps[0].label).toBeUndefined();
      // "a" has a tap 10 ms away in the trace, which the analysis gave to no note: it gets none.
      expect(byId(errorOutlineStore, "miss:a").taps).toEqual([]);
      expect(byId(errorOutlineStore, "miss:c").taps).toEqual([]);
    });

    it("drops the trail of an error whose cause is not about aim, and keeps its tap", () => {
      const { errorOutlineStore } = mount(chain(), { session: analysed(["late-tap"]) });
      act(() => nav.selectError(1));
      expect(byId(errorOutlineStore, "miss:b").trail).toEqual([]);
      expect(byId(errorOutlineStore, "miss:b").taps).toHaveLength(1);
      // "c" has no cause in this analysis: nothing says its path is beside the point.
      expect(byId(errorOutlineStore, "miss:c").trail.length).toBeGreaterThan(0);
    });

    it("has a trail and no taps while there is no analysis", () => {
      const { errorOutlineStore } = mount();
      act(() => nav.selectError(1));
      expect(byId(errorOutlineStore, "miss:b").taps).toEqual([]);
      expect(byId(errorOutlineStore, "miss:b").trail.length).toBeGreaterThan(0);
    });

    it("writes offsets as the player experienced them with a faster clock", () => {
      const { errorOutlineStore, set } = mount(chain(), { session: analysed(), clockRate: 1.5 });
      act(() => nav.selectError(1));
      set((draft) => void (draft.tapNumbersEnabled = true));
      expect(byId(errorOutlineStore, "miss:b").taps[0]).toMatchObject({ offsetMs: 29, label: "+29 ms" });
    });

    it("follows the Tap numbers and Miss trail toggles", () => {
      const { errorOutlineStore, set } = mount(chain(), { session: analysed() });
      act(() => nav.selectError(1));
      set((draft) => void (draft.tapNumbersEnabled = true));
      expect(byId(errorOutlineStore, "miss:b").taps[0].label).toBe("+43 ms");
      set((draft) => void (draft.tapNumbersEnabled = false));
      expect(byId(errorOutlineStore, "miss:b").taps).toEqual([expect.objectContaining({ offsetMs: 43 })]);
      expect(byId(errorOutlineStore, "miss:b").taps[0].label).toBeUndefined();
      set((draft) => void (draft.missTrailEnabled = false));
      expect(byId(errorOutlineStore, "miss:b")).toMatchObject({ trail: [], taps: [] });
      set((draft) => void (draft.missTrailEnabled = true));
      expect(byId(errorOutlineStore, "miss:b").trail.length).toBeGreaterThan(0);
    });
  });

  it("shows an incident's ring and trail while it is being replayed, even with the outline and the trail off", () => {
    const { outlined, set, errorOutlineStore, gameClock } = mount();
    set((draft) => {
      draft.errorOutline = "off";
      draft.missTrailEnabled = false;
    });
    act(() => nav.selectError(1));
    expect(outlined()).toEqual([]);
    act(() => nav.replaySelection(0.5));
    expect(outlined()).toEqual([
      ["miss:b", "full"],
      ["miss:a", "light"],
      ["miss:c", "light"],
    ]);
    expect(errorOutlineStore.targets[0].trail.length).toBeGreaterThan(0);
    // A seek ends the replay, and the settings apply again.
    act(() => gameClock.seeked$.next(9_000));
    expect(outlined()).toEqual([]);
  });

  it("narrows All to the replayed incident during an incident replay, and gives All back afterwards", () => {
    const { outlined, setMode, gameClock } = mount();
    setMode("all");
    act(() => nav.selectError(1));
    expect(outlined()).toHaveLength(4);
    act(() => nav.replaySelection(1));
    expect(outlined()).toEqual([
      ["miss:b", "full"],
      ["miss:a", "light"],
      ["miss:c", "light"],
    ]);
    act(() => gameClock.seeked$.next(9_000));
    expect(outlined()).toHaveLength(4);
  });

  it("marks the followers of a run in All mode", () => {
    const { errorOutlineStore, setMode } = mount();
    setMode("all");
    // "a", "b" and "c" are 100 ms apart; "d" is seconds later.
    expect(errorOutlineStore.targets.map((target) => [target.errorId, target.follower === true])).toEqual([
      ["miss:a", false],
      ["miss:b", true],
      ["miss:c", true],
      ["miss:d", false],
    ]);
  });

  it("colours the key overlay's marks for every error whatever the Error outline is set to, by a setting of their own", () => {
    const { view, errorOutlineStore, setMode, set } = mount(chain(), { mode: "default" });
    const marked = () => [...errorOutlineStore.marks.keys()];
    // The outline is off by default; the marks are on.
    expect(errorOutlineStore.targets).toEqual([]);
    expect(marked()).toEqual(["a", "b", "c", "d"]);
    expect(errorOutlineStore.marks.get("a")).toBe(0xff7082);
    setMode("selected");
    expect(marked()).toEqual(["a", "b", "c", "d"]);
    set((draft) => void (draft.keyOverlayErrorMarksEnabled = false));
    expect(marked()).toEqual([]);
    setMode("all");
    expect(marked()).toEqual([]);
    expect(errorOutlineStore.targets).toHaveLength(4);
    set((draft) => void (draft.keyOverlayErrorMarksEnabled = true));
    expect(marked()).toEqual(["a", "b", "c", "d"]);
    view.unmount();
    expect(marked()).toEqual([]);
  });

  it("tells the renderer which error is inspected, in either mode, so that one keeps its trail", () => {
    const { view, errorOutlineStore, setMode } = mount();
    expect(errorOutlineStore.inspectedErrorId).toBeUndefined();
    act(() => nav.selectError(1));
    expect(errorOutlineStore.inspectedErrorId).toBe("miss:b");
    setMode("all");
    act(() => nav.selectError(3));
    expect(errorOutlineStore.inspectedErrorId).toBe("miss:d");
    view.unmount();
    expect(errorOutlineStore.inspectedErrorId).toBeUndefined();
  });

  it("clears the renderer's rings when it goes away", () => {
    const { view, outlined, setMode } = mount();
    setMode("all");
    expect(outlined()).toHaveLength(4);
    view.unmount();
    expect(outlined()).toEqual([]);
  });
});
