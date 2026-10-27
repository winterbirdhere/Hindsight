import "reflect-metadata";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { act, StrictMode } from "react";
import { BehaviorSubject } from "rxjs";
import { useGameClockControls, useGameClockTime } from "../../hooks/game-clock";
import { useModControls } from "../../hooks/mods";
import { useShortcuts } from "../../hooks/shortcuts";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import type { ReplayComparisonState, ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import type { OsuReplay } from "../../model/OsuReplay";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import {
  Beatmap,
  buildBeatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  parseBlueprint,
  parseReplayFramesWithDiagnostics,
  Spinner,
  type ReplayAnalysisEvent,
} from "@osujs/core";
import { summarizeReplayEvents } from "../../services/analysis/replay-events";
import * as fullMapAnalysis from "../../services/analysis/full-map-analysis";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import { ErrorNavigationProvider } from "../../hooks/error-navigation";
import { InspectorProvider } from "../../providers/InspectorProvider";
import { groupIncidents } from "../../services/analysis/incidents";
import { IncidentBlock } from "./IncidentBlock";
import { IncidentsList } from "./IncidentsList";
import { RulesetSwitch } from "./RulesetSwitch";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { GameSimulator } from "../../services/common/game/GameSimulator";
import { PerformanceTimelineService } from "../../services/analysis/performance/PerformanceTimelineService";

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));

function ErrorNavigatorHarness() {
  return (
    <ErrorNavigationProvider>
      <RulesetSwitch />
      <IncidentBlock />
      <IncidentsList />
    </ErrorNavigationProvider>
  );
}

jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: jest.fn(),
  // The shortcuts read the held speed and the scroll step from the playbar settings.
  useCommonManagers: jest.fn(() => ({
    playbarSettingsStore: { settings: { difficultyGraphEnabled: true, scrollStep: "auto", holdSpeed: 0.5 } },
  })),
}));
// The steps are tested with their own hook. Here an arrow key only has to reach the replay: a note step is reported
// through the clock controls as the 16 ms it used to be.
jest.mock("../../hooks/playback-steps", () => ({
  usePlaybackWheel: jest.fn(),
  usePlaybackSteps: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const controls = require("../../hooks/game-clock").useGameClockControls();
    return {
      step: (_kind: string, direction: number) => (direction > 0 ? controls.seekForward : controls.seekBackward)(16),
    };
  },
}));
jest.mock("../../hooks/game-clock", () => ({
  useGameClockControls: jest.fn(),
  useGameClockTime: jest.fn(),
}));
jest.mock("../../hooks/audio", () => ({
  useAudioSettings: jest.fn(),
  useAudioSettingsService: jest.fn(),
}));
jest.mock("../../hooks/mods", () => ({
  useModControls: jest.fn(),
}));
jest.mock("../../api", () => ({ frontendAPI: { selectReplayFile: jest.fn() } }));
jest.mock("./BaseGameTimeSlider", () => ({ BaseGameTimeSlider: () => null }));

const EMPTY_COMPARISON: ReplayComparisonState = { status: "EMPTY" };
const summary = {
  counts: { count300: 10, count100: 0, count50: 0, countMiss: 0, total: 10 },
  sliderBreakCount: 0,
  accuracy: 1,
  maxComboInput: 10,
  scoreInput: 1_000_000,
};
const READY_AUTOPLAY_COMPARISON = {
  status: "READY",
  sourceKind: "autoplay-reference",
  ruleset: "stable",
  primary: { label: "Primary player", kind: "replay" },
  secondary: { label: "Autoplay reference", kind: "autoplay-reference" },
  result: {
    primarySummary: summary,
    secondarySummary: summary,
    differences: [],
  },
  validations: { primary: { verified: true, simulatedCounts: [10, 0, 0, 0], simulatedMaxCombo: 10, warnings: [] } },
} as unknown as ReplayComparisonState;

function fullMapFixture() {
  const circle = new HitCircle();
  circle.id = "circle-0";
  circle.hitTime = 1_000;
  circle.position = { x: 256, y: 192 };
  circle.unstackedPosition = circle.position;
  const spinner = new Spinner();
  spinner.id = "spinner-0";
  spinner.startTime = 1_500;
  spinner.duration = 500;
  const beatmap = new Beatmap(
    [circle, spinner],
    { ...DEFAULT_BEATMAP_DIFFICULTY },
    [],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
  );
  const replay: OsuReplay = {
    md5hash: "replay-hash",
    beatmapMd5: "beatmap-hash",
    gameMode: 0,
    gameVersion: 20200101,
    mods: [],
    player: "Analysis player",
    frames: [
      { time: 0, position: circle.position, actions: [] },
      { time: 1_000, position: circle.position, actions: [] },
      { time: 2_000, position: circle.position, actions: [] },
    ],
    statistics: {
      count300: 1,
      count100: 0,
      count50: 0,
      countMiss: 0,
      maxCombo: 1,
      score: 300,
      perfectCombo: true,
    },
  };
  const stableEvents: ReplayAnalysisEvent[] = [
    {
      type: "HitObjectJudgement",
      eventId: "stable:circle-0",
      ruleset: "stable",
      time: 1_000,
      objectTime: 1_000,
      judgementTime: 1_000,
      hitObjectId: circle.id,
      verdict: "GREAT",
      position: circle.position,
    },
    {
      type: "SliderBreak",
      eventId: "stable:slider-0/tick-0",
      ruleset: "stable",
      time: 1_200,
      objectTime: 1_100,
      judgementTime: 1_200,
      sliderId: "slider-0",
      componentId: "slider-0/tick-0",
      componentType: "TICK",
      position: circle.position,
    },
  ];
  const lazerEvents: ReplayAnalysisEvent[] = [
    {
      type: "HitObjectJudgement",
      eventId: "lazer:circle-0",
      ruleset: "lazer",
      time: 1_000,
      objectTime: 1_000,
      judgementTime: 1_000,
      hitObjectId: circle.id,
      verdict: "GREAT",
      position: circle.position,
    },
    {
      type: "SliderComponentMiss",
      eventId: "lazer:slider-0/tick-0",
      ruleset: "lazer",
      time: 1_200,
      objectTime: 1_100,
      judgementTime: 1_200,
      sliderId: "slider-0",
      componentId: "slider-0/tick-0",
      componentType: "TICK",
      position: circle.position,
    },
  ];
  const metadata = parseBlueprint("osu file format v14\n[Metadata]\n").blueprintInfo.metadata;
  return { beatmap, replay, stableEvents, lazerEvents, metadata };
}

/** useShortcuts reads the inspector (Space follows an export session), so it mounts under its provider. */
function ShortcutsUnderInspector() {
  useShortcuts();
  return null;
}

/**
 * Steps to the next incident with Follow off. A step keeps Follow as it was, and the error cause is announced as a
 * status only while Follow is off (a followed incident is shown silently); these tests read that status.
 */
function stepToNextIncidentAnnounced() {
  const follow = screen.getByRole("button", { name: "Follow" });
  if (follow.getAttribute("aria-pressed") === "true") fireEvent.click(follow);
  fireEvent.click(screen.getByRole("button", { name: /^next incident$/i }));
}

function setup(
  initialComparison: ReplayComparisonState = EMPTY_COMPARISON,
  {
    withFullMapAnalysis = false,
    fullMap = fullMapFixture(),
    hits = [[1_000, 0, true]],
  }: {
    withFullMapAnalysis?: boolean;
    fullMap?: ReturnType<typeof fullMapFixture>;
    hits?: fullMapAnalysis.GameSimulatorHit[];
  } = {},
) {
  const replayComparison$ = new BehaviorSubject<ReplayComparisonState>(initialComparison);
  const replayEvents$ = new BehaviorSubject<ReplayAnalysisEvent[]>(withFullMapAnalysis ? fullMap.stableEvents : []);
  const validation$ = new BehaviorSubject<ReplaySimulationValidation>({
    verified: true,
    simulatedCounts: [10, 0, 0, 0] as [number, number, number, number],
    simulatedMaxCombo: 10,
    warnings: [] as string[],
  });
  const lazerAvailable$ = new BehaviorSubject(withFullMapAnalysis);
  const rulesetFocus$ = new BehaviorSubject<"stable" | "lazer">(withFullMapAnalysis ? "stable" : "lazer");
  const gameClock = new GameplayClock();
  const missExplanations$ = new BehaviorSubject<MissExplanationSessionState>({
    status: "not-captured",
    reasons: ["capture-disabled"],
  });
  const performanceTimeline = new PerformanceTimelineService();
  gameClock.setDuration(2_000);
  const seeked$ = gameClock.seeked$;
  const compareWithAutoplayReference = jest.fn(() => {
    replayComparison$.next(READY_AUTOPLAY_COMPARISON);
    return READY_AUTOPLAY_COMPARISON;
  });
  const clearReplayComparison = jest.fn(() => replayComparison$.next(EMPTY_COMPARISON));
  const takeScreenshot = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const eventsByRuleset = { stable: fullMap.stableEvents, lazer: fullMap.lazerEvents } as const;
  const setRulesetFocus = jest.fn((target: "stable" | "lazer") => {
    rulesetFocus$.next(target);
    replayEvents$.next(eventsByRuleset[target]);
  });

  const controls = {
    baseRate: 1,
    speed: 1,
    setSpeed: jest.fn(),
    seekTo: jest.fn(),
    pause: jest.fn(),
    start: jest.fn(),
    toggleClock: jest.fn(),
    seekBackward: jest.fn(),
    seekForward: jest.fn(),
    increaseSpeed: jest.fn(),
    decreaseSpeed: jest.fn(),
  };
  // Space goes through the transport toggle, which outside an export session is the clock's own toggle.
  jest.spyOn(gameClock, "toggle").mockImplementation(controls.toggleClock);
  (useGameClockControls as jest.Mock).mockReturnValue(controls);
  (useGameClockTime as jest.Mock).mockReturnValue(0);
  (useModControls as jest.Mock).mockReturnValue({ hidden: false, setHidden: jest.fn() });
  (useAnalysisApp as jest.Mock).mockReturnValue({
    replayDisplaySettingsStore: new ReplayDisplaySettingsStore(),
    getBeatmap: jest.fn(() => fullMap.beatmap),
    scenarioManager: {
      getBeatmapMetadata: jest.fn(() => fullMap.metadata),
      loadState$: new BehaviorSubject({ phase: "ready" }),
    },
    gameSimulator: {
      analyzeMisses: jest.fn(() => {
        missExplanations$.next({ status: "building" });
        return Promise.resolve(missExplanations$.value);
      }),
      missExplanations$,
      missAnalysisProgress$: new BehaviorSubject(undefined),
      getPrimaryBeatmap: () => fullMap.beatmap,
      replayEvents$,
      validation$,
      lazerAvailable$,
      rulesetFocus$,
      replayComparison$,
      getEventsForRuleset: jest.fn((ruleset: "stable" | "lazer") =>
        withFullMapAnalysis ? eventsByRuleset[ruleset] : [],
      ),
      getHitsForRuleset: jest.fn(() => hits),
      getFinalInfoForRuleset: jest.fn(() => ({
        accuracy: 1,
        verdictCounts: [1, 0, 0, 0],
        score: 300,
        currentCombo: 1,
        maxComboSoFar: 1,
      })),
      getFinalScoreStatsForRuleset: jest.fn((ruleset: "stable" | "lazer") => ({
        count100: 0,
        count50: 0,
        countMiss: 0,
        maxComboSoFar: 1,
        mapMaxCombo: 1,
        ...(ruleset === "stable" ? { sliderBreakCount: 1 } : { sliderTickMissCount: 1 }),
      })),
      getTimingUnreliableHitObjectIds: jest.fn(() => new Set<string>()),
      getPrimaryReplay: jest.fn(() => (withFullMapAnalysis ? fullMap.replay : undefined)),
      hasReplayForMissAnalysis: () => withFullMapAnalysis,
      setRulesetFocus,
    },
    gameClock,
    performanceTimeline,
    compareWithAutoplayReference,
    clearReplayComparison,
    screenshotTaker: { takeScreenshot },
    clipRecorder: {
      isBusy: false,
      state$: new BehaviorSubject({ status: "idle", progress: 0 }),
      preview: jest.fn(() => jest.fn()),
      getFormat: () => ({ label: "WebM", extension: "webm" }),
    },
    clipExportSettingsStore: new ClipExportSettingsStore(),
    osuFolderService: { replaysFolder$: new BehaviorSubject("") },
  });

  return {
    missExplanations$,
    gameClock,
    performanceTimeline,
    validation$,
    replayComparison$,
    replayEvents$,
    rulesetFocus$,
    seeked$,
    controls,
    compareWithAutoplayReference,
    clearReplayComparison,
    setRulesetFocus,
    takeScreenshot,
  };
}

describe("error navigation controls", () => {
  it("does not add an orphan accuracy consequence to original navigation", () => {
    const { missExplanations$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    missExplanations$.next({
      status: "partial",
      identity: { analysisProfileId: "stable" },
      explanations: new Map(),
      reasons: ["unprocessed-parent-contribution"],
      analysis: {
        inventory: {
          atoms: [
            {
              id: "pending-parent",
              role: "consequence",
              component: "slider-parent",
              result: "OK",
              comboPenalty: false,
              relatedAtomIds: [],
            },
          ],
        },
        excludedModelAtomIds: [],
        limitations: ["unclassified:parent"],
        incidents: [
          {
            id: "parent-incident",
            atomIds: ["pending-parent"],
            objectTimeMs: 1000,
            componentId: "parent",
            parentId: "parent",
            mechanism: { status: "unavailable" },
          },
        ],
      },
    } as unknown as MissExplanationSessionState);
    render(<ErrorNavigatorHarness />);
    expect(missExplanations$.value.status).toBe("partial");
    expect(screen.queryByRole("group", { name: "Error filters" })).toBeNull();
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Errors analyzed" })).toBeNull();
  });

  function setupMissAnalysis(native = false) {
    const environment = setup();
    const analyzer = jest.mocked(useAnalysisApp)();
    const simulator = new GameSimulator();
    const map = buildBeatmap(
      parseBlueprint(
        "osu file format v14\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n300,192,1000,1,0\n300,192,5000,1,0",
      ),
      { mods: [], addStacking: false },
    );
    const replay: OsuReplay = {
      md5hash: "manual-miss-analysis",
      beatmapMd5: "map",
      gameMode: 0,
      gameVersion: 20200101,
      mods: [],
      player: "synthetic",
      ...(native ? { sourceClient: "lazer" as const, sourceProvenance: "user-confirmed" as const } : {}),
      frames: [
        { time: 0, position: { x: 300, y: 192 }, actions: [] },
        { time: 1200, position: { x: 300, y: 192 }, actions: [] },
      ],
    };
    const parsed = parseReplayFramesWithDiagnostics("0|300|192|0,800|300|192|0,400|300|192|0,");
    replay.frames = parsed.frames;
    replay.parseDiagnostics = parsed.diagnostics;
    simulator.simulateReplay(map, replay);
    jest.mocked(useAnalysisApp).mockReturnValue(Object.assign(analyzer, { gameSimulator: simulator }));
    return { ...environment, simulator, map, replay };
  }

  it("updates the selected cause presentation from the display store without analysis, seeking or playback changes", async () => {
    const { simulator, controls, gameClock } = setupMissAnalysis();
    const session = await simulator.analyzeMisses();
    if (session.status !== "ready" && session.status !== "partial") throw Error("Expected actual available analysis");
    if (!session.analysis) throw Error("Expected actual error analysis");
    // Supply explicit presentation metadata; this test does not rank or modify
    // the actual source mechanism, verdict, identity, or event mapping.
    const withDetail = {
      ...session,
      analysis: {
        ...session.analysis,
        classifications: session.analysis.classifications.map((item) => ({
          ...item,
          mechanism: { ...item.mechanism, briefDetail: { phrase: "during the hit window" } },
        })),
      },
    };
    simulator.missExplanations$.next(withDetail);
    const analyzer = jest.mocked(useAnalysisApp)();
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    render(<ErrorNavigatorHarness />);
    stepToNextIncidentAnnounced();
    const concise = screen.getByRole("status", { name: "Error cause" }).textContent;
    expect(concise).toBe("No tap");
    controls.seekTo.mockClear();
    controls.pause.mockClear();
    const before = { playing: gameClock.isPlaying, time: gameClock.timeElapsedInMs, speed: gameClock.speed };
    const source = JSON.stringify(withDetail),
      events = simulator.replayEvents$.value,
      state = simulator.getCurrentState();
    act(() =>
      analyzer.replayDisplaySettingsStore.changeSettings((draft) =>
        Object.assign(draft, { errorCauseDisplay: "brief" }),
      ),
    );
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe(`${concise} · during the hit window`);
    act(() =>
      analyzer.replayDisplaySettingsStore.changeSettings((draft) =>
        Object.assign(draft, { errorCauseDisplay: "concise" }),
      ),
    );
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe(concise);
    expect(analyze).not.toHaveBeenCalled();
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect({ playing: gameClock.isPlaying, time: gameClock.timeElapsedInMs, speed: gameClock.speed }).toEqual(before);
    expect(simulator.missExplanations$.value).toBe(withDetail);
    expect(JSON.stringify(withDetail)).toBe(source);
    expect(simulator.replayEvents$.value).toBe(events);
    expect(simulator.getCurrentState()).toBe(state);
    expect(screen.queryByRole("dialog")).toBeNull();
    simulator.clear();
  });

  it.each([false, true])("automatically analyzes once and preserves navigation/playback, native=%s", async (native) => {
    const { simulator, controls, gameClock } = setupMissAnalysis(native);
    simulator.simulate(777);
    gameClock.seekTo(777);
    const events = simulator.replayEvents$.value;
    const state = simulator.getCurrentState();
    const beforeClock = { time: gameClock.timeElapsedInMs, playing: gameClock.isPlaying, speed: gameClock.speed };
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    const captureToggle = jest.spyOn(simulator, "setMissExplanationCaptureEnabled");
    const view = render(
      <StrictMode>
        <ErrorNavigatorHarness />
      </StrictMode>,
    );
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(simulator.missExplanations$.value.status).toBe("building");
    expect(screen.queryByRole("button", { name: /Analyze errors|Analyzing errors|Errors analyzed/ })).toBeNull();
    expect(screen.getByRole("status", { name: "Error analysis status" }).textContent).toBe("Analyzing errors…");
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    stepToNextIncidentAnnounced();
    controls.seekTo.mockClear();
    controls.pause.mockClear();
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    expect(simulator.missExplanations$.value.status).toBe("partial");
    expect(screen.queryByRole("status", { name: "Error analysis status" })).toBeNull();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
    expect(simulator.getMissExplanation("0")).toBeDefined();
    expect(simulator.getMissExplanation("1")).toBeUndefined();
    expect(simulator.replayEvents$.value).toBe(events);
    expect(simulator.getCurrentState()).toBe(state);
    expect(captureToggle).not.toHaveBeenCalled();
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect(controls.toggleClock).not.toHaveBeenCalled();
    expect({ time: gameClock.timeElapsedInMs, playing: gameClock.isPlaying, speed: gameClock.speed }).toEqual(
      beforeClock,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    render(<ErrorNavigatorHarness />);
    expect(analyze).toHaveBeenCalledTimes(1);
    stepToNextIncidentAnnounced();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
    act(() => simulator.clear());
    expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
  });

  it.each([false, true])(
    "cancels automatic analysis after a map-only transition, profile switch=%s",
    async (switchProfile) => {
      const { simulator, replay } = setupMissAnalysis();
      const analyze = jest.spyOn(simulator, "analyzeMisses");
      render(<ErrorNavigatorHarness />);
      expect(analyze).toHaveBeenCalledTimes(1);
      act(() => {
        simulator.clearMissExplanations();
        if (switchProfile) simulator.setRulesetFocus("lazer");
      });
      await act(async () => {
        await analyze.mock.results[0].value;
      });
      expect(simulator.getPrimaryReplay()).toBe(replay);
      expect(simulator.getMissExplanation("0")).toBeUndefined();
      expect(screen.queryByRole("status", { name: "Error analysis status" })).toBeNull();
      expect(analyze).toHaveBeenCalledTimes(1);
    },
  );

  it("does no work without an eligible replay and starts when one is loaded", async () => {
    const { simulator, map, replay } = setupMissAnalysis();
    simulator.clear();
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    render(<ErrorNavigatorHarness />);
    expect(analyze).not.toHaveBeenCalled();
    act(() => simulator.simulateReplay(map, replay));
    expect(analyze).toHaveBeenCalledTimes(1);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    expect(simulator.getMissExplanation("0")).toBeDefined();
  });

  it.each(["replacement", "profile"] as const)(
    "cancels stale automatic work and handles in-flight %s",
    async (change) => {
      const { simulator, map, replay } = setupMissAnalysis();
      const analyze = jest.spyOn(simulator, "analyzeMisses");
      render(<ErrorNavigatorHarness />);
      expect(simulator.missExplanations$.value.status).toBe("building");
      act(() => {
        if (change === "replacement") simulator.simulateReplay(map, { ...replay, md5hash: "replacement" });
        else simulator.setRulesetFocus("lazer");
      });
      expect(analyze).toHaveBeenCalledTimes(2);
      await act(async () => {
        await Promise.all(analyze.mock.results.map((r) => r.value));
      });
      expect(await analyze.mock.results[0].value).toMatchObject({
        status: "not-captured",
        reasons: ["analysis-cancelled"],
      });
      expect(simulator.missExplanations$.value).toBe(await analyze.mock.results[1].value);
      if (change === "replacement") expect(simulator.getMissExplanation("0")).toBeDefined();
      else {
        expect(simulator.missExplanations$.value.status).toBe("unsupported");
        expect(simulator.getMissExplanation("0")).toBeUndefined();
        act(() => simulator.setRulesetFocus("stable"));
        expect(analyze).toHaveBeenCalledTimes(3);
        await act(async () => {
          await analyze.mock.results[2].value;
        });
        expect(simulator.getMissExplanation("0")).toBeDefined();
      }
    },
  );

  it("keeps a cached source result across profile switches without repeating work", async () => {
    const { simulator } = setupMissAnalysis();
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    render(<ErrorNavigatorHarness />);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    const cached = simulator.missExplanations$.value;
    act(() => simulator.setRulesetFocus("lazer"));
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(simulator.missExplanations$.value.status).toBe("unsupported");
    act(() => simulator.setRulesetFocus("stable"));
    expect(simulator.missExplanations$.value).toBe(cached);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("exposes an unsupported result without an automatic retry loop", async () => {
    const { simulator, map, replay } = setupMissAnalysis();
    simulator.simulateReplay(map, { ...replay, gameMode: 1 });
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    const view = render(<ErrorNavigatorHarness />);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    expect(screen.getByRole("status", { name: "Error analysis status" }).textContent).toBe(
      "Error analysis unavailable.",
    );
    view.rerender(<ErrorNavigatorHarness />);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(simulator.missExplanations$.value.status).toBe("unsupported");
    expect(screen.queryByRole("button", { name: /analysis|analyz/i })).toBeNull();
  });

  it("automatically admits Hidden through the existing analysis pipeline", async () => {
    const { simulator, replay } = setupMissAnalysis();
    const hidden = buildBeatmap(
      parseBlueprint(
        "osu file format v14\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n300,192,1000,1,0",
      ),
      { mods: ["HIDDEN"], addStacking: false },
    );
    simulator.simulateReplay(hidden, { ...replay, mods: ["HIDDEN"] });
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    render(<ErrorNavigatorHarness />);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    expect(simulator.getMissExplanation("0")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Error analysis status" })).toBeNull();
  });

  it.each(["analysis-resource-limit", "reconstruction-outcome-conflict", "saved-outcome-localization-unavailable"])(
    "does not retry unavailable evidence for %s",
    (reason) => {
      const { simulator } = setupMissAnalysis();
      simulator.missExplanations$.next({ status: "error", reasons: [reason] });
      const analyze = jest.spyOn(simulator, "analyzeMisses");
      render(<ErrorNavigatorHarness />);
      expect(screen.getByRole("status", { name: "Error analysis status" }).textContent).toBe(
        "Error analysis unavailable.",
      );
      expect(analyze).not.toHaveBeenCalled();
      expect(screen.queryByText(/Try again/)).toBeNull();
    },
  );

  it.each([false, true])(
    "keeps 100/50 and tail statistics but navigates only the same MISS before/after Analyze, native=%s",
    async (native) => {
      const { simulator, replay, controls } = setupMissAnalysis(native);
      const map = buildBeatmap(
        parseBlueprint(
          "osu file format v14\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,192,1000,1,0\n300,192,2000,1,0\n100,192,3000,2,0,L|200:192,1,100\n300,192,4000,1,0",
        ),
        { mods: [], addStacking: false },
      );
      const samples = [
        [0, 100, 0],
        [800, 100, 0],
        [1050, 100, 1],
        [1100, 100, 0],
        [1900, 300, 0],
        [2100, 300, 1],
        [2200, 300, 0],
        [2900, 100, 0],
        [3000, 100, 1],
        [3100, 120, 1],
        [3300, 160, 1],
        [3400, 180, 0],
        [3500, 200, 0],
        [3600, 200, 0],
        [3900, 300, 0],
        [4200, 300, 0],
      ];
      const parsed = parseReplayFramesWithDiagnostics(
        samples.map(([time, x, keys], i) => `${time - (samples[i - 1]?.[0] ?? 0)}|${x}|192|${keys}`).join(",") + ",",
      );
      simulator.simulateReplay(map, { ...replay, frames: parsed.frames, parseDiagnostics: parsed.diagnostics });
      const events = simulator.replayEvents$.value,
        state = simulator.getCurrentState();
      const before = summarizeReplayEvents(events, native ? "lazer" : "stable");
      expect(before.errors.map((error) => [error.type, error.time])).toEqual([["MISS", 4000]]);
      expect(before.timings.ok).toHaveLength(native ? 1 : 2);
      expect(before.timings.meh).toHaveLength(1);
      expect(native ? before.timings.lazerSliderEndMiss : before.timings.stableSliderEndMiss).toHaveLength(1);
      const analyze = jest.spyOn(simulator, "analyzeMisses");
      render(<ErrorNavigatorHarness />);
      await act(async () => {
        await analyze.mock.results[0].value;
      });
      expect(simulator.getCurrentState()).toBe(state);
      expect(simulator.replayEvents$.value).toBe(events);
      expect(controls.seekTo).not.toHaveBeenCalled();
      expect(controls.pause).not.toHaveBeenCalled();
      expect(simulator.missExplanations$.value.status).toBe("partial");
      expect(summarizeReplayEvents(simulator.replayEvents$.value, native ? "lazer" : "stable")).toEqual(before);
      expect(screen.queryByRole("group", { name: "Error filters" })).toBeNull();
      expect(screen.queryByText(/moments?/)).toBeNull();
      stepToNextIncidentAnnounced();
      expect(controls.seekTo).toHaveBeenLastCalledWith(4000);
      expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
      expect(screen.queryByRole("button", { name: "Explain error" })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(analyze).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps original Stable break navigation without adding its later tail or parent accuracy loss", async () => {
    const { simulator, replay } = setupMissAnalysis();
    const map = buildBeatmap(
      parseBlueprint(
        "osu file format v14\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,192,1000,2,0,L|300:192,1,200",
      ),
      { mods: [], addStacking: false },
    );
    const parsed = parseReplayFramesWithDiagnostics(
      "0|100|192|0,800|100|192|0,200|100|192|1,200|140|192|1,100|160|192|0,200|200|192|0,200|240|192|0,264|293|192|0,36|300|192|0,200|300|192|0,",
    );
    simulator.simulateReplay(map, { ...replay, frames: parsed.frames, parseDiagnostics: parsed.diagnostics });
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    render(<ErrorNavigatorHarness />);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    const navigation = summarizeReplayEvents(simulator.replayEvents$.value, "stable");
    expect(navigation.errors.map((error) => [error.type, error.time])).toEqual([["SLIDER_BREAK", 1500]]);
    expect(screen.queryByRole("group", { name: "Error filters" })).toBeNull();
    stepToNextIncidentAnnounced();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toMatch(/release|hold/i);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not loop on an assembly failure; a new replay load can recover", async () => {
    const { simulator, map, replay } = setupMissAnalysis();
    const analyze = jest.spyOn(simulator, "analyzeMisses");
    const getHitObject = jest.spyOn(map, "getHitObject").mockImplementation(() => {
      throw new Error("map unavailable");
    });
    const view = render(<ErrorNavigatorHarness />);
    await act(async () => {
      await analyze.mock.results[0].value;
    });
    expect(simulator.missExplanations$.value.status).toBe("error");
    expect(screen.getByRole("status", { name: "Error analysis status" }).textContent).toBe(
      "Error analysis unavailable.",
    );
    getHitObject.mockRestore();
    view.rerender(<ErrorNavigatorHarness />);
    expect(analyze).toHaveBeenCalledTimes(1);
    act(() => simulator.simulateReplay(map, { ...replay }));
    expect(analyze).toHaveBeenCalledTimes(2);
    await act(async () => {
      await analyze.mock.results[1].value;
    });
    expect(simulator.getMissExplanation("0")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Error analysis status" })).toBeNull();
  });

  it.each([false, true])(
    "reads an actual captured session without replaying or changing results, native=%s",
    async (native) => {
      const { controls } = setup();
      const analyzer = jest.mocked(useAnalysisApp)();
      const simulator = new GameSimulator();
      const map = buildBeatmap(
        parseBlueprint(
          "osu file format v14\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n300,192,1000,1,0",
        ),
        { mods: [], addStacking: false },
      );
      simulator.setMissExplanationCaptureEnabled(true);
      const parsed = parseReplayFramesWithDiagnostics("0|300|192|0,800|300|192|0,400|300|192|0,");
      simulator.simulateReplay(map, {
        md5hash: "synthetic",
        beatmapMd5: "map",
        gameMode: 0,
        gameVersion: 20200101,
        mods: [],
        player: "synthetic",
        ...(native ? { sourceClient: "lazer" as const, sourceProvenance: "user-confirmed" as const } : {}),
        frames: parsed.frames,
        parseDiagnostics: parsed.diagnostics,
      });
      const session = simulator.missExplanations$.value;
      const savedEvents = JSON.stringify(simulator.replayEvents$.value);
      const savedSession = JSON.stringify(session);
      const capture = jest.spyOn(simulator, "simulateReplay");
      const toggleCapture = jest.spyOn(simulator, "setMissExplanationCaptureEnabled");
      jest.mocked(useAnalysisApp).mockReturnValue(Object.assign(analyzer, { gameSimulator: simulator }));
      render(<ErrorNavigatorHarness />);
      stepToNextIncidentAnnounced();
      expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
      expect(screen.queryByRole("button", { name: /Show evidence|Hide evidence/ })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status", { name: "Error cause" }).textContent).not.toMatch(
        /model|reconstruct|predicate|sequence|r\d+/i,
      );
      expect(capture).not.toHaveBeenCalled();
      expect(toggleCapture).not.toHaveBeenCalled();
      expect(simulator.missExplanations$.value).toBe(session);
      expect(JSON.stringify(session)).toBe(savedSession);
      expect(JSON.stringify(simulator.replayEvents$.value)).toBe(savedEvents);
      expect(controls.seekTo).toHaveBeenCalledWith(1000);
      act(() => simulator.clear());
      expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
    },
  );

  it.each(["seek", "profile", "replacement"] as const)(
    "keeps the inspected cause through a seek and clears it on profile or replacement: %s",
    async (change) => {
      const { simulator, map, replay, controls, seeked$ } = setupMissAnalysis();
      await act(async () => {
        await simulator.analyzeMisses();
      });
      render(<ErrorNavigatorHarness />);
      stepToNextIncidentAnnounced();
      expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
      expect(controls.seekTo).toHaveBeenCalledWith(1000);
      act(() => {
        if (change === "seek") {
          seeked$.next(1000);
          seeked$.next(1050);
        } else if (change === "profile") simulator.setRulesetFocus("lazer");
        else simulator.simulateReplay(map, { ...replay, md5hash: "replacement" });
      });
      // Inspection is separate from playback (spec §5.9 A): a seek no longer clears it.
      if (change === "seek") expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("No tap");
      else expect(screen.queryByRole("status", { name: "Error cause" })).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );

  it.each(["stable", "lazer"] as const)(
    "keeps exact %s tick/repeat/Classic-head navigation, ties and HUD statistics after analysis",
    (ruleset) => {
      const { replayEvents$, rulesetFocus$, missExplanations$, controls } = setup(EMPTY_COMPARISON, {
        withFullMapAnalysis: true,
      });
      rulesetFocus$.next(ruleset);
      const p = { x: 0, y: 0 };
      const components = ["HEAD", "TICK", "REPEAT", "TAIL"] as const;
      const events: ReplayAnalysisEvent[] = [
        ...["OK", "MEH", "MISS"].map(
          (verdict, i) =>
            ({
              type: "HitObjectJudgement",
              ruleset,
              hitObjectId: "c" + i,
              verdict,
              time: 500 + i * 100,
              objectTime: 500 + i * 100,
              position: p,
            } as ReplayAnalysisEvent),
        ),
        ...components
          .filter((type) => ruleset === "lazer" || type !== "TAIL")
          .map(
            (componentType, i) =>
              ({
                type: ruleset === "stable" ? "SliderBreak" : "SliderComponentMiss",
                ruleset,
                sliderId: "s",
                componentId: "s/" + i,
                componentType,
                eventId: "part" + i,
                time: 1050,
                objectTime: 1000,
                judgementTime: 1050,
                position: p,
              } as ReplayAnalysisEvent),
          ),
      ];
      replayEvents$.next(events);
      const before = summarizeReplayEvents(events, ruleset);
      expect(before.errors.map((error) => error.id)).toEqual(["miss:c2", "part0", "part1", "part2"]);
      expect(before.timings.ok).toEqual([500]);
      expect(before.timings.meh).toEqual([600]);
      expect(ruleset === "stable" ? before.timings.sliderBreak : before.timings.lazerSliderTickMiss).toEqual([
        1000, 1000, 1000,
      ]);
      if (ruleset === "lazer") expect(before.timings.lazerSliderEndMiss).toEqual([1000]);
      // The buttons step from the playhead, so a seek has to move it, as the real clock does.
      controls.seekTo.mockImplementation((time: number) => (useGameClockTime as jest.Mock).mockReturnValue(time));
      render(<ErrorNavigatorHarness />);
      for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: /^next incident$/i }));
      // The three slider parts share 1000 ms. Next goes to the first incident after the playhead, so the tied ones
      // are one stop (and the third and fourth presses find nothing later: the button is disabled).
      expect(controls.seekTo.mock.calls.map((call) => call[0])).toEqual([700, 1000]);
      expect((screen.getByRole("button", { name: /^next incident$/i }) as HTMLButtonElement).disabled).toBe(true);
      const beforeCalls = controls.seekTo.mock.calls.length;
      act(() =>
        missExplanations$.next({
          status: "partial",
          identity: { analysisProfileId: ruleset },
          explanations: new Map(),
          analysis: {
            inventory: { atoms: [] },
            incidents: [],
            classifications: [],
            excludedModelAtomIds: [],
            limitations: [],
          },
        } as unknown as MissExplanationSessionState),
      );
      expect(controls.seekTo).toHaveBeenCalledTimes(beforeCalls);
      for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /^previous incident$/i }));
      // From 1000 ms the previous stop is 700 ms, and nothing is before it.
      expect(controls.seekTo.mock.calls.slice(beforeCalls).map((call) => call[0])).toEqual([700]);
      expect((screen.getByRole("button", { name: /^previous incident$/i }) as HTMLButtonElement).disabled).toBe(true);
      expect(summarizeReplayEvents(events, ruleset)).toEqual(before);
      expect(screen.queryByRole("group", { name: "Error filters" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Explain error" })).toBeNull();
      expect(screen.queryByText(/moments?/)).toBeNull();
    },
  );

  function NavigatorWithShortcuts() {
    return (
      <InspectorProvider>
        <ShortcutsUnderInspector />
        <ErrorNavigatorHarness />
      </InspectorProvider>
    );
  }

  it("preserves keyboard focus, avoids pointer focus for Space playback, and seeks exactly", () => {
    const { replayEvents$, rulesetFocus$, controls } = setup();
    rulesetFocus$.next("stable");
    replayEvents$.next([
      {
        type: "HitObjectJudgement",
        time: 56_120,
        objectTime: 56_008,
        judgementTime: 56_120,
        hitObjectId: "miss-2",
        verdict: "MISS",
        ruleset: "stable",
        position: { x: 256, y: 192 },
      },
    ]);

    render(<NavigatorWithShortcuts />);
    expect(screen.getByText("Stable")).toBeTruthy();
    expect(screen.queryByText(/Stable ·.*Miss/)).toBeNull();
    const next = screen.getByRole("button", { name: /^next incident$/i });

    act(() => next.focus());
    expect(document.activeElement).toBe(next);
    act(() => next.blur());
    const pointerPress = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    fireEvent(next, pointerPress);
    expect(pointerPress.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(next);

    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.seekTo).toHaveBeenCalledWith(56_008);
    expect(screen.queryByText(/1\/1.*MISS.*0:56\.008/)).toBeNull();

    fireEvent.keyDown(document.body, { key: " ", code: "Space", keyCode: 32, which: 32 });
    expect(controls.toggleClock).toHaveBeenCalledTimes(1);
    expect(controls.seekTo).toHaveBeenCalledTimes(1);
  });
});

describe("incidents list", () => {
  it("lists only navigable errors, marks the selection and computes causes once per session", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const causeSpy = jest.spyOn(require("./error-cause"), "selectedErrorCauses");
    // The bare setup() fixture has no replay events; use the withFullMapAnalysis
    // variant, whose fullMapFixture() stableEvents already contains a slider break.
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    const { rerender } = render(<ErrorNavigatorHarness />);
    const list = screen.getByRole("list", { name: "Incidents" });
    const rows = within(list).getAllByRole("button");
    const events = (useAnalysisApp as jest.Mock).mock.results.slice(-1)[0].value.gameSimulator.replayEvents$.getValue();
    const { errors } = summarizeReplayEvents(events, "stable");
    expect(rows).toHaveLength(groupIncidents(errors, events, "stable").length);
    const callsAfterFirstRender = causeSpy.mock.calls.length;
    rerender(<ErrorNavigatorHarness />);
    rerender(<ErrorNavigatorHarness />);
    expect(causeSpy.mock.calls.length).toBe(callsAfterFirstRender);
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute("aria-current")).toBe("true");
    causeSpy.mockRestore();
  });
});

// ---- Phase 1b: inspection workflow with the real provider (spec §5.9 A–D) ----
describe("inspection workflow", () => {
  const missEvent = (id: string, time: number, blocker?: string): ReplayAnalysisEvent =>
    ({
      type: "HitObjectJudgement",
      ruleset: "stable",
      hitObjectId: id,
      verdict: "MISS",
      time,
      objectTime: time,
      judgementTime: time,
      position: { x: 0, y: 0 },
      ...(blocker ? { notelockCause: { blockerHitObjectId: blocker } } : {}),
    } as ReplayAnalysisEvent);
  /** A miss that locks the next five notes (a Heartless-like chain), then an unrelated miss. */
  const chainEvents = () => [
    missEvent("c0", 64_595),
    ...[64_661, 64_727, 64_793, 64_859, 64_989].map((time, index) => missEvent(`c${index + 1}`, time, "c0")),
    missEvent("z", 79_121),
  ];

  function Hideable({ shown }: { shown: boolean }) {
    return (
      <ErrorNavigationProvider>
        {shown && (
          <>
            <IncidentBlock />
            <IncidentsList />
          </>
        )}
      </ErrorNavigationProvider>
    );
  }
  function start() {
    const environment = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    environment.replayEvents$.next(chainEvents());
    environment.gameClock.setDuration(120_000);
    const analyze = (useAnalysisApp as jest.Mock).mock.results.slice(-1)[0].value.gameSimulator
      .analyzeMisses as jest.Mock;
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    return { ...environment, analyze, scrollIntoView };
  }
  const rows = () => within(screen.getByRole("list", { name: "Incidents" })).getAllByRole("button");
  const members = () => within(screen.getByRole("list", { name: "Incident members" })).getAllByRole("button");
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  const CHAIN_LABEL = "1–6/7";

  afterEach(() => jest.useRealTimers());

  it("inspects a chain, opens its members, selects one and replays it, through seeks", () => {
    const { controls, gameClock } = start();
    render(<Hideable shown />);
    expect(screen.getByText("7 ERRORS")).toBeTruthy();
    expect(screen.getByText("Select an incident, or follow playback.")).toBeTruthy();
    // No cause is known here, so the summaries are built from the types alone; nothing is invented.
    expect(rows().map((row) => row.textContent)).toEqual(["Miss ×61:04.595Miss ×6", "Miss1:19.121Miss"]);

    fireEvent.click(rows()[0]);
    expect(controls.seekTo).toHaveBeenLastCalledWith(64_595);
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Incident members" })).toBeNull();

    fireEvent.click(button("Show 5"));
    expect(members()).toHaveLength(6);
    fireEvent.click(members()[3]);
    expect(controls.seekTo).toHaveBeenLastCalledWith(64_793);
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    expect(members().map((row) => row.getAttribute("aria-current"))).toEqual([null, null, null, "true", null, null]);

    // The user scrubs elsewhere: the inspection stays (a seek used to clear it).
    act(() => gameClock.seekTo(1_000));
    act(() => gameClock.seekTo(1_900));
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(members()[3].getAttribute("aria-current")).toBe("true");

    controls.seekTo.mockClear();
    controls.pause.mockClear();
    fireEvent.click(button("Replay at 1× speed"));
    expect(controls.setSpeed).toHaveBeenLastCalledWith(1);
    expect(controls.seekTo).toHaveBeenCalledTimes(1);
    expect(controls.seekTo).toHaveBeenLastCalledWith(64_793 - 1_500);
    expect(controls.start).toHaveBeenCalledTimes(1);
    expect(controls.pause).not.toHaveBeenCalled();
    expect(members()[3].getAttribute("aria-current")).toBe("true");
  });

  it("follows playback by incident from the start, without seeking, pausing or scrolling, until a manual selection", () => {
    jest.useFakeTimers();
    const { controls, gameClock, scrollIntoView } = start();
    render(<Hideable shown />);
    const playTo = (time: number) => {
      act(() => gameClock.seekTo(time));
      act(() => void jest.advanceTimersByTime(100));
    };
    // Follow is on from the start; before the first error is reached the inspector is idle, and no row is the
    // playback position.
    expect(button("Follow").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("7 ERRORS")).toBeTruthy();
    expect(screen.getByText("Select an incident, or follow playback.")).toBeTruthy();
    expect(rows().some((row) => row.textContent?.includes("(playback position)"))).toBe(false);
    playTo(64_600);
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    // Through the members of the chain: the same incident, and the members are not opened.
    for (const time of [64_661, 64_800, 64_989, 70_000]) {
      playTo(time);
      expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    }
    expect(screen.queryByRole("list", { name: "Incident members" })).toBeNull();
    playTo(79_200);
    expect(screen.getByText("7/7")).toBeTruthy();
    expect(rows()[1].getAttribute("aria-current")).toBe("true");
    expect(rows()[1].textContent).toContain("(playback position)");
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The Follow button turns it off: the panel stops changing, only the list's position mark moves on.
    fireEvent.click(button("Follow"));
    expect(button("Follow").getAttribute("aria-pressed")).toBe("false");
    playTo(90_000);
    expect(screen.getByText("7/7")).toBeTruthy();
    // Turning it on again applies at once, and a manual selection turns it off again.
    fireEvent.click(button("Follow"));
    expect(button("Follow").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(rows()[0]);
    expect(button("Follow").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    playTo(79_500);
    playTo(90_000);
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    // The playback position is still marked, on the other row.
    expect(rows()[1].textContent).toContain("(playback position)");
    expect(rows()[1].getAttribute("aria-current")).toBeNull();
    // A list click does not scroll the list either.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("steps with Previous / Next keep Follow as it was; a list row, the density bar and the Follow button still decide it", () => {
    jest.useFakeTimers();
    const { controls, gameClock } = start();
    // The density bar lays its bins out over the map's duration, which the mocked transport has to report.
    Object.assign(controls, { duration: 120_000 });
    const view = render(<Hideable shown />);
    const pressed = () => button("Follow").getAttribute("aria-pressed");
    // The seek lands on the clock (the controls are mocks here), then the Follow sampler gets its ticks.
    const land = (time: number) => {
      act(() => gameClock.seekTo(time));
      (useGameClockTime as jest.Mock).mockReturnValue(time);
      view.rerender(<Hideable shown />);
      act(() => void jest.advanceTimersByTime(100));
    };

    // Follow on, the playhead on the chain.
    land(64_600);
    expect(pressed()).toBe("true");
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    fireEvent.click(button("Next incident"));
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.seekTo).toHaveBeenLastCalledWith(79_121);
    expect(pressed()).toBe("true");
    land(79_121);
    // The sampler agrees with the step: still the second incident, still following.
    expect(screen.getByText("7/7")).toBeTruthy();
    expect(pressed()).toBe("true");
    fireEvent.click(button("Previous incident"));
    expect(controls.seekTo).toHaveBeenLastCalledWith(64_595);
    land(64_595);
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(pressed()).toBe("true");
    // Still following: playback moving on moves the inspector on.
    land(79_200);
    expect(screen.getByText("7/7")).toBeTruthy();

    // Follow off stays off through a step, which still inspects and seeks.
    fireEvent.click(button("Follow"));
    expect(pressed()).toBe("false");
    land(64_600);
    fireEvent.click(button("Next incident"));
    expect(pressed()).toBe("false");
    expect(screen.getByText("7/7")).toBeTruthy();
    expect(controls.seekTo).toHaveBeenLastCalledWith(79_121);

    // A list row and the density bar are manual selections: they turn Follow off.
    fireEvent.click(button("Follow"));
    expect(pressed()).toBe("true");
    fireEvent.click(rows()[1]);
    expect(pressed()).toBe("false");
    fireEvent.click(button("Follow"));
    expect(pressed()).toBe("true");
    fireEvent.click(document.querySelectorAll("[data-density-bin]")[Math.floor((64_595 / 120_000) * 60)]);
    expect(pressed()).toBe("false");
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
  });

  it("scrolls the list to the inspected row only after an explicit navigation", () => {
    const { scrollIntoView } = start();
    const view = render(<Hideable shown />);
    fireEvent.click(rows()[1]);
    expect(scrollIntoView).not.toHaveBeenCalled();
    // The click sought to the incident (the clock is a mock here): the playhead is on its error, and Previous steps
    // from there.
    (useGameClockTime as jest.Mock).mockReturnValue(79_121);
    view.rerender(<Hideable shown />);
    fireEvent.click(button("Previous incident"));
    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(rows()[0]);
    const field = screen.getByRole("textbox", { name: "Go to time" });
    fireEvent.change(field, { target: { value: "1:19" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByText("7/7")).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(rows()[1]);
  });

  it("resets the inspection and the expansion on a ruleset switch, with no stale index", () => {
    const { setRulesetFocus, replayEvents$ } = start();
    render(<Hideable shown />);
    fireEvent.click(rows()[0]);
    fireEvent.click(button("Show 5"));
    fireEvent.click(members()[5]);
    expect(members()[5].getAttribute("aria-current")).toBe("true");

    act(() => setRulesetFocus("lazer"));
    // One Lazer slider-tick miss: error index 5 no longer exists.
    expect(screen.getByText("1 ERROR")).toBeTruthy();
    expect(screen.getByText("Select an incident, or follow playback.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Incident members" })).toBeNull();
    expect(screen.getByRole("list", { name: "Incidents" }).querySelector('[aria-current="true"]')).toBeNull();
    expect(button("Replay at 1× speed").disabled).toBe(true);

    // The chain again, as a new event stream: nothing inspected, nothing expanded.
    act(() => {
      setRulesetFocus("stable");
      replayEvents$.next(chainEvents());
    });
    expect(screen.getByText("7 ERRORS")).toBeTruthy();
    fireEvent.click(rows()[0]);
    expect(button("Show 5").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps selection, expansion and list scroll through hiding and showing the inspector", () => {
    const { controls, analyze, scrollIntoView, gameClock } = start();
    const view = render(<Hideable shown />);
    fireEvent.click(rows()[0]);
    fireEvent.click(button("Show 5"));
    fireEvent.click(members()[2]);
    const list = screen.getByRole("list", { name: "Incidents" });
    list.scrollTop = 120;
    fireEvent.scroll(list);
    const analyses = analyze.mock.calls.length;
    const clock = { time: gameClock.timeElapsedInMs, playing: gameClock.isPlaying, speed: gameClock.speed };
    controls.seekTo.mockClear();
    controls.pause.mockClear();
    scrollIntoView.mockClear();

    view.rerender(<Hideable shown={false} />);
    expect(screen.queryByRole("list", { name: "Incidents" })).toBeNull();
    view.rerender(<Hideable shown />);

    expect(screen.getByText(CHAIN_LABEL)).toBeTruthy();
    expect(members().map((row) => row.getAttribute("aria-current"))).toEqual([null, null, "true", null, null, null]);
    expect(button("Hide").getAttribute("aria-expanded")).toBe("true");
    const shownAgain = screen.getByRole("list", { name: "Incidents" });
    expect(shownAgain).not.toBe(list);
    expect(shownAgain.scrollTop).toBe(120);
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    // No seek, no pause, no start and no re-analysis. The only scroll into view is the selected member's own row
    // inside the remounted body (QA fix 6), never the incidents list or the page.
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect(controls.start).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.instances[0]).toBe(members()[2]);
    expect(analyze.mock.calls.length).toBe(analyses);
    expect({ time: gameClock.timeElapsedInMs, playing: gameClock.isPlaying, speed: gameClock.speed }).toEqual(clock);
  });

  it("keeps the real playback shortcuts out of the time field and working after pointer use", () => {
    const { controls } = start();
    function WithShortcuts() {
      return (
        <InspectorProvider>
          <ShortcutsUnderInspector />
          <Hideable shown />
        </InspectorProvider>
      );
    }
    render(<WithShortcuts />);
    const space = { key: " ", code: "Space", keyCode: 32, which: 32 };
    const arrowLeft = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, which: 37 };
    const playback = [
      controls.toggleClock,
      controls.seekBackward,
      controls.seekForward,
      controls.increaseSpeed,
      controls.decreaseSpeed,
      controls.seekTo,
      controls.start,
    ];

    // Typing in the field, including Space, arrows and the letter shortcuts, is typing.
    const field = screen.getByRole("textbox", { name: "Go to time" });
    act(() => field.focus());
    for (const key of [
      space,
      arrowLeft,
      { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, shiftKey: true },
      { ...arrowLeft, ctrlKey: true },
      { key: "a", code: "KeyA", keyCode: 65, which: 65 },
      { key: "d", code: "KeyD", keyCode: 68, which: 68 },
      { key: "w", code: "KeyW", keyCode: 87, which: 87 },
      { key: "s", code: "KeyS", keyCode: 83, which: 83 },
      { key: "f", code: "KeyF", keyCode: 70, which: 70 },
    ]) {
      fireEvent.keyDown(field, key);
      fireEvent.keyUp(field, key);
    }
    fireEvent.change(field, { target: { value: "1:1" } });
    for (const mock of playback) expect(mock).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(document.body);

    // A pointer click on a row inspects it and leaves the focus alone, so the next arrow steps the replay.
    const press = (target: Element) => {
      const event = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(true);
      fireEvent.click(target);
      expect(document.activeElement).toBe(document.body);
    };
    press(rows()[0]);
    expect(controls.seekTo).toHaveBeenLastCalledWith(64_595);
    fireEvent.keyDown(document.body, arrowLeft);
    fireEvent.keyUp(document.body, arrowLeft);
    expect(controls.seekBackward).toHaveBeenCalledTimes(1);
    expect(controls.seekBackward).toHaveBeenLastCalledWith(16);
    // The same after Show and a member click.
    press(button("Show 5"));
    press(members()[2]);
    fireEvent.keyDown(document.body, arrowLeft);
    fireEvent.keyUp(document.body, arrowLeft);
    expect(controls.seekBackward).toHaveBeenCalledTimes(2);

    // Space on a keyboard-focused Follow or Replay button plays or pauses once and does not press the button.
    expect(controls.toggleClock).not.toHaveBeenCalled();
    const follow = button("Follow");
    act(() => follow.focus());
    // Not cancelled = false: the shortcut took the key, so the browser will not click the button.
    expect(fireEvent.keyDown(follow, space)).toBe(false);
    fireEvent.keyUp(follow, space);
    expect(controls.toggleClock).toHaveBeenCalledTimes(1);
    expect(follow.getAttribute("aria-pressed")).toBe("false");
    const replay = button("Replay at 1× speed");
    controls.seekTo.mockClear();
    act(() => replay.focus());
    expect(fireEvent.keyDown(replay, space)).toBe(false);
    fireEvent.keyUp(replay, space);
    expect(controls.toggleClock).toHaveBeenCalledTimes(2);
    expect(controls.start).not.toHaveBeenCalled();
    expect(controls.seekTo).not.toHaveBeenCalled();
  });

  it("keeps the inspected error and the list position when a ready analysis links it to an earlier error", () => {
    // Real provider, real grouper, real list. A Stable slider-head break has no simulator notelock event:
    // only the analysis can prove that the miss on object 6 locked it.
    const breakEvent = (sliderId: string, time: number): ReplayAnalysisEvent =>
      ({
        type: "SliderBreak",
        componentId: `${sliderId}/HEAD`,
        sliderId,
        componentType: "HEAD",
        eventId: `stable:slider-break:${sliderId}/HEAD`,
        time,
        objectTime: time,
        judgementTime: time,
        ruleset: "stable",
        position: { x: 0, y: 0 },
      } as ReplayAnalysisEvent);
    const proven = (codes: string[]) =>
      ({
        status: "ready",
        identity: { analysisProfileId: "stable" },
        explanations: new Map(),
        analysis: {
          inventory: {
            atoms: [
              {
                id: "atom:7/HEAD",
                componentId: "7/HEAD",
                parentId: "7",
                component: "slider-head",
                result: "MISS",
                role: "primary",
                identity: { analysisProfileId: "stable" },
                objectTimeMs: 20_100,
                resolutionTimeMs: 20_100,
                relatedAtomIds: [],
                pendingContributionIds: [],
              },
            ],
          },
          classifications: [
            {
              atomId: "atom:7/HEAD",
              mechanism: {
                status: "supported",
                codes,
                headline: "Notelock",
                description: "",
                eventIds: [],
                limitations: [],
                diagnostics: { opportunities: [], primary: { directRejections: [{ blockerId: "6", inputId: "r0" }] } },
              },
            },
          ],
          incidents: [],
          excludedModelAtomIds: [],
          limitations: [],
        },
      } as unknown as MissExplanationSessionState);
    const { replayEvents$, missExplanations$, controls, scrollIntoView, analyze } = start();
    act(() =>
      replayEvents$.next([
        ...[10_000, 11_000, 12_000, 13_000].map((time, index) => missEvent(`m${index}`, time)),
        missEvent("6", 20_000),
        breakEvent("7", 20_100),
        missEvent("z", 30_000),
      ]),
    );
    render(<Hideable shown />);
    // Before the analysis: seven unrelated errors.
    expect(rows()).toHaveLength(7);
    fireEvent.click(rows()[5]);
    expect(controls.seekTo).toHaveBeenLastCalledWith(20_100);
    expect(screen.getByText("6/7")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Incidents" });
    list.scrollTop = 80;
    fireEvent.scroll(list);
    controls.seekTo.mockClear();
    controls.pause.mockClear();
    const analyses = analyze.mock.calls.length;

    // A mixed-cause mechanism proves no lock (I1): nothing regroups.
    act(() => missExplanations$.next(proven(["notelock", "off-target"])));
    expect(rows()).toHaveLength(7);
    expect(screen.getByText("6/7")).toBeTruthy();

    act(() => missExplanations$.next(proven(["notelock"])));
    // The pair is one incident now; the inspected error is the same one, shown as the locked follow-up.
    expect(rows()).toHaveLength(6);
    expect(screen.getByText("5–6/7")).toBeTruthy();
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([null, null, null, null, "true", null]);
    expect(rows()[4].textContent).toContain("Miss → Notelock");
    expect(rows()[4].textContent).toContain("Miss → Slider break");
    expect(screen.getByText("Locked by the miss above")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Error cause" }).textContent).toBe("Notelock");
    // Still the break at 0:20.100: Replay starts 1.5 s before it, not before the pair's lead.
    fireEvent.click(button("Replay at 1× speed"));
    expect(controls.seekTo).toHaveBeenCalledTimes(1);
    expect(controls.seekTo).toHaveBeenLastCalledWith(20_100 - 1_500);
    // The regroup itself moved nothing: no pause, no list scroll, no new analysis.
    expect(controls.pause).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Incidents" })).toBe(list);
    expect(list.scrollTop).toBe(80);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(analyze.mock.calls.length).toBe(analyses);
  });

  it("keeps a dense run of unlinked errors as separate incidents", () => {
    const { replayEvents$ } = start();
    // Eight misses 80 ms apart with no notelock evidence: closeness alone links nothing.
    act(() => replayEvents$.next(Array.from({ length: 8 }, (_, index) => missEvent(`d${index}`, 30_000 + index * 80))));
    render(<Hideable shown />);
    expect(screen.getByText("8 ERRORS")).toBeTruthy();
    expect(rows()).toHaveLength(8);
    expect(rows().every((row) => row.textContent?.startsWith("Miss0:30."))).toBe(true);
    fireEvent.click(rows()[3]);
    expect(screen.getByText("4/8")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
  });
});
