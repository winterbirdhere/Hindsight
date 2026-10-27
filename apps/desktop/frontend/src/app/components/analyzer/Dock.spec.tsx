import "reflect-metadata";
import { fireEvent, render as renderWithoutInspector, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { BehaviorSubject, Subject } from "rxjs";
import { useGameClockControls, useGameClockTime } from "../../hooks/game-clock";
import { useModControls } from "../../hooks/mods";
import { useAudioSettings, useAudioSettingsService } from "../../hooks/audio";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { ErrorNavigationProvider } from "../../hooks/error-navigation";
import { ScreenshotProvider } from "../../hooks/screenshot";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { REWIND_COLORS } from "../../styles/tokens";
import type { ReplayComparisonState, ReplaySimulationValidation } from "../../services/common/game/GameSimulator";
import type { OsuReplay } from "../../model/OsuReplay";
import type { ReplayLoadState } from "../../services/manager/replay-load-state";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  parseBlueprint,
  PathType,
  Slider,
  SliderPath,
  Spinner,
  type ReplayAnalysisEvent,
} from "@osujs/core";
import * as fullMapAnalysis from "../../services/analysis/full-map-analysis";
import * as fullMapViewModel from "../../services/analysis/full-map-analysis-view-model";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { ClipExportSettingsStore } from "../../services/analysis/clip-export-settings";
import { AudioButton } from "./DockIconButtons";
import { ReplayActions } from "./ReplayActions";
import { Dock } from "./Dock";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { PerformanceTimelineService } from "../../services/analysis/performance/PerformanceTimelineService";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { ipcRenderer } from "electron";
import { useLibraryUi } from "../replay-library-host";
jest.mock("../replay-library-host",()=>({useLibraryUi:jest.fn(()=>null),LibraryViewerNavigation:()=><button>Library</button>}));
afterEach(()=>jest.mocked(useLibraryUi).mockReturnValue(null));

let inspector: ReturnType<typeof useInspector>;
/** Hands the tests the inspector the dock is mounted under, to start and end an export session. */
function InspectorProbe() {
  inspector = useInspector();
  return null;
}

/** The app's providers that the dock reads: the inspector, and the F12 shortcut that lives above every screen. */
function Providers({ children }: { children?: ReactNode }) {
  const analyzer = (useAnalysisApp as jest.Mock)();
  return (
    <InspectorProvider>
      <ScreenshotProvider
        takeScreenshot={() => analyzer.screenshotTaker.takeScreenshot()}
        isBusy={() => analyzer.clipRecorder.isBusy}
      >
        {children}
      </ScreenshotProvider>
    </InspectorProvider>
  );
}

/** Every fixture mounts under those providers. */
function render(ui: ReactElement) {
  return renderWithoutInspector(ui, { wrapper: Providers });
}

/** Opens the ⋮ menu. Export and Compare are items in it, not dock buttons. */
async function openMoreMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More replay actions" }));
  return screen.findByRole("menu", { name: "More replay actions" });
}

/** A menu item's name includes its secondary text, so a string matches the start of the name. */
const itemName = (name: string | RegExp) =>
  typeof name === "string" ? new RegExp("^" + name.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")) : name;

/** An item of an open ⋮ menu. */
const menuItemIn = (menu: HTMLElement, name: string | RegExp) =>
  within(menu).getByRole("menuitem", { name: itemName(name) });

/** Opens the ⋮ menu, chooses the item and waits for the menu to close. */
async function chooseMenuItem(name: string | RegExp) {
  fireEvent.click(menuItemIn(await openMoreMenu(), name));
  await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
}

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));

jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: jest.fn(),
  useCommonManagers: jest.fn(),
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
// The slider itself is not under test here; it only exposes the `disabled` prop the dock hands it.
jest.mock("./BaseGameTimeSlider", () => ({
  BaseGameTimeSlider: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="timeline" data-disabled={String(Boolean(disabled))} />
  ),
}));

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
const READY_STABLE_REPLAY_COMPARISON = {
  status: "READY",
  sourceKind: "replay",
  ruleset: "stable",
  primary: { label: "Primary player", kind: "replay" },
  secondary: { label: "Reference player", kind: "replay" },
  result: {
    primarySummary: summary,
    secondarySummary: summary,
    differences: [],
    compatibility: { issues: [] },
    participantLimitations: { primary: [], secondary: [] },
  },
  validations: {
    primary: { verified: true, simulatedCounts: [10, 0, 0, 0], simulatedMaxCombo: 10, warnings: [] },
    secondary: { verified: true, simulatedCounts: [10, 0, 0, 0], simulatedMaxCombo: 10, warnings: [] },
  },
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
  const clearReplay = jest.fn(async () => undefined);
  const loadState$ = new BehaviorSubject<ReplayLoadState>({ phase: "ready" });
  const takeScreenshot = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
  const eventsByRuleset = { stable: fullMap.stableEvents, lazer: fullMap.lazerEvents } as const;
  const setRulesetFocus = jest.fn((target: "stable" | "lazer") => {
    rulesetFocus$.next(target);
    replayEvents$.next(eventsByRuleset[target]);
  });

  const controls = {
    baseRate: 1,
    speed: 1,
    seekTo: jest.fn(),
    pause: jest.fn(),
    toggleClock: jest.fn(),
    seekBackward: jest.fn(),
    seekForward: jest.fn(),
    increaseSpeed: jest.fn(),
    decreaseSpeed: jest.fn(),
  };
  (useGameClockControls as jest.Mock).mockReturnValue(controls);
  (useGameClockTime as jest.Mock).mockReturnValue(0);
  (useModControls as jest.Mock).mockReturnValue({ hidden: false, setHidden: jest.fn() });
  (useAnalysisApp as jest.Mock).mockReturnValue({
    replayDisplaySettingsStore: new ReplayDisplaySettingsStore(),
    getBeatmap: jest.fn(() => fullMap.beatmap),
    scenarioManager: { getBeatmapMetadata: jest.fn(() => fullMap.metadata), clearReplay, loadState$ },
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
    clearReplay,
    loadState$,
    setRulesetFocus,
    takeScreenshot,
  };
}

/** A segment of the open Full-map analysis dialog's Stable | Lazer switch. */
function analysisRuleset(dialog: HTMLElement, name: "Stable" | "Lazer") {
  return within(within(dialog).getByRole("group", { name: "Analysis ruleset" })).getByRole("button", { name });
}

/** A segment of the dialog's switch between its two graphs over the map. */
function analysisGraph(dialog: HTMLElement, name: "Unstable rate · 50 hits" | "Hit error") {
  return within(within(dialog).getByRole("group", { name: "Graph" })).getByRole("button", { name });
}

describe("Full-map replay validation", () => {
  it("opens the existing Full-map analysis dialog only for a fresh explicit library request", async()=>{
    setup(EMPTY_COMPARISON,{withFullMapAnalysis:true});const fullMapRequest$=new BehaviorSubject(0),stableSettingsRequest$=new BehaviorSubject(0);
    jest.mocked(useLibraryUi).mockReturnValue({fullMapRequest$,stableSettingsRequest$} as never);render(<ReplayActions/>);
    expect(screen.queryByRole("dialog",{name:/Full-map analysis/})).toBeNull();act(()=>fullMapRequest$.next(1));
    expect(await screen.findByRole("dialog",{name:/Full-map analysis/})).toBeTruthy();
  });
  it("places Library immediately after Analysis in the dock actions",()=>{
    setup();render(<ReplayActions/>);const analysis=screen.getByRole("button",{name:"Full-map analysis"});
    expect(analysis.nextElementSibling?.textContent).toBe("Library");
  });
  it("updates full-map PP and proportions after calculation and ruleset switches, independent of seeking", async () => {
    const { performanceTimeline, gameClock } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    let resolve!: (value: unknown) => void;
    jest.mocked(ipcRenderer.invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const loading = performanceTimeline.load(
      "map",
      ["stable", "lazer"].map((mode) => ({
        mode: mode as "stable" | "lazer",
        mods: [],
        states: [],
        finalReplayTime: 1000,
        limitations: [],
      })),
    );
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    const dialog = await screen.findByRole("dialog", { name: /Full-map analysis/ });
    expect(within(dialog).getAllByText("Calculating replay performance…")).toHaveLength(2);
    await act(async () => {
      resolve({
        ok: true,
        engineVersion: PERFORMANCE_ENGINE_VERSION,
        timelines: [
          {
            mode: "stable",
            points: [{ time: 1000, pp: 123.45, sr: 1 }],
            difficultyPoints: [{ time: 3000, sr: 7.19 }],
            fullDifficulty: { total: 7.19, aim: 4.2, speed: 2.13, reading: 1.36, flashlight: 0, sliderFactor: 0.983 },
          },
          {
            mode: "lazer",
            points: [{ time: 1000, pp: 150, sr: 2 }],
            difficultyPoints: [{ time: 3000, sr: 5.57 }],
            fullDifficulty: {
              total: 5.579606988316402,
              aim: 3,
              speed: 2,
              reading: 1,
              flashlight: 1,
              sliderFactor: 0.8,
            },
          },
        ],
      });
      await loading;
    });
    expect(within(dialog).getByLabelText("Replay PP 123.45")).toBeTruthy();
    expect(within(dialog).getByLabelText("Full-map SR 7.19 stars")).toBeTruthy();
    // Both are figures of the result row now: the PP before the max combo, the star rating no longer in the footer.
    const result = within(dialog).getByRole("region", { name: "Result" });
    expect(within(result).getByLabelText("Full-map SR 7.19 stars").closest("footer")).toBeNull();
    const replayPp = within(result).getByLabelText("Replay PP 123.45");
    expect(
      replayPp.compareDocumentPosition(within(result).getByText("MAX COMBO")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    act(() => gameClock.seekTo(0));
    expect(within(dialog).getByLabelText("Replay PP 123.45")).toBeTruthy();
    fireEvent.click(analysisRuleset(dialog, "Lazer"));
    expect(within(dialog).getByLabelText("Replay PP 150.00")).toBeTruthy();
    expect(within(dialog).getByLabelText("Full-map SR 5.57 stars")).toBeTruthy();
    fireEvent.mouseOver(within(dialog).getByLabelText("Full-map SR 5.57 stars"));
    expect(within(await screen.findByRole("tooltip")).getByText("Flashlight")).toBeTruthy();
    act(() => performanceTimeline.clear());
    expect(within(dialog).queryByLabelText("Replay PP 150.00")).toBeNull();
    expect(within(dialog).getByText("PP unavailable")).toBeTruthy();
    expect(within(dialog).getByText("SR unavailable")).toBeTruthy();
  });

  it.each([false, true])("pauses full-map entry and stays paused on close (initially playing: %s)", async (playing) => {
    const { gameClock } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    gameClock.seekTo(1000);
    if (playing) gameClock.start();
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    const dialog = await screen.findByRole("dialog", { name: /Full-map analysis/ });
    expect(gameClock.isPlaying).toBe(false);
    const pausedTime = gameClock.timeElapsedInMs;
    fireEvent.click(within(dialog).getByRole("button", { name: "Close full-map analysis" }));
    expect(gameClock.isPlaying).toBe(false);
    expect(gameClock.tick()).toBe(pausedTime);
  });

  it("keeps differences inside full-map results and updates them across ruleset changes and replay unload", async () => {
    const { validation$, replayEvents$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    expect(screen.queryByRole("region", { name: "Final replay results differ" })).toBeNull();
    act(() =>
      validation$.next({
        verified: false,
        expectedCounts: [5, 0, 0, 0],
        simulatedCounts: [4, 0, 0, 1],
        expectedMaxCombo: 5,
        simulatedMaxCombo: 3,
        warnings: [],
      }),
    );
    expect(screen.queryByRole("region", { name: "Final replay results differ" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });
    const judgements = within(dialog).getByRole("region", { name: "Judgements" });
    // Both counts are there without a click, and a note says they differ.
    expect(within(judgements).getByRole("note", { name: "Saved score differs" })).toBeTruthy();
    expect(within(judgements).getByRole("region", { name: /^MISS: saved 0, Hindsight/ })).toBeTruthy();
    expect(within(judgements).queryByRole("button")).toBeNull();
    fireEvent.click(analysisRuleset(dialog, "Lazer"));
    await waitFor(() => expect(screen.queryByRole("note", { name: "Saved score differs" })).toBeNull());
    expect(within(judgements).queryByRole("region", { name: /^MISS: saved 0/ })).toBeNull();
    fireEvent.click(analysisRuleset(dialog, "Stable"));
    expect(await screen.findByRole("note", { name: "Saved score differs" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close full-map analysis" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Final replay results differ" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    expect(await screen.findByRole("note", { name: "Saved score differs" })).toBeTruthy();
    expect(screen.queryByText(/Viewing Lazer simulation/)).toBeNull();
    const simulator = (useAnalysisApp as jest.Mock).mock.results.at(-1)?.value.gameSimulator;
    simulator.getPrimaryReplay.mockReturnValue(undefined);
    act(() => {
      replayEvents$.next([]);
      validation$.next({ verified: false, simulatedCounts: [0, 0, 0, 0], simulatedMaxCombo: 0, warnings: [] });
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Final replay results differ" })).toBeNull());
  });
});

describe("ReplayActions full-map error causes", () => {
  /** A ready analysis that gives the fixture's one slider break an Aim cause, as the replay view's inspector would. */
  function readySession(): MissExplanationSessionState {
    const atom = {
      id: "slider-0/tick-0",
      componentId: "slider-0/tick-0",
      parentId: "slider-0",
      component: "slider-tick",
      result: "MISS",
      role: "primary",
      identity: { analysisProfileId: "stable" },
      objectTimeMs: 1_100,
      resolutionTimeMs: 1_200,
      relatedAtomIds: [],
      pendingContributionIds: [],
    };
    const mechanism = {
      status: "supported",
      headline: "Off track",
      codes: ["off-track"],
      description: "",
      eventIds: [],
      limitations: [],
    };
    return {
      status: "ready",
      identity: { analysisProfileId: "stable" },
      analysis: {
        inventory: { atoms: [atom] },
        classifications: [{ atomId: atom.id, mechanism }],
        incidents: [],
        excludedModelAtomIds: [],
      },
    } as unknown as MissExplanationSessionState;
  }
  const errorCauses = (dialog: HTMLElement) => within(dialog).getByRole("region", { name: "Error causes" });

  async function openAnalysis() {
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    return screen.findByRole("dialog", { name: "Full-map analysis" });
  }

  it("says the errors are being analyzed while the session is building, then counts them when it is ready", async () => {
    const { missExplanations$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    missExplanations$.next({ status: "building" });
    const dialog = await openAnalysis();
    expect(within(errorCauses(dialog)).getByRole("status").textContent).toBe("Analyzing errors…");
    expect(within(errorCauses(dialog)).queryAllByTestId("error-cause-row")).toHaveLength(0);
    act(() => missExplanations$.next(readySession()));
    const panel = errorCauses(dialog);
    expect(within(panel).queryByRole("status")).toBeNull();
    expect(within(panel).getByText("1 error")).toBeTruthy();
    expect(within(panel).getAllByTestId("error-cause-row").map((row) => row.getAttribute("aria-label"))).toEqual([
      "Aim: 1",
      "Tapping: 0",
      "Notelock: 0",
    ]);
  });

  it("counts an error the analysis gives no cause as no cause found", async () => {
    const { missExplanations$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    const session = readySession();
    if (session.status !== "ready" || !session.analysis) throw new Error("fixture");
    missExplanations$.next({ ...session, analysis: { ...session.analysis, inventory: { atoms: [] } } } as never);
    const dialog = await openAnalysis();
    expect(within(errorCauses(dialog)).getByRole("region", { name: "No cause found: 1" })).toBeTruthy();
    expect(within(errorCauses(dialog)).getByRole("region", { name: "Aim: 0" })).toBeTruthy();
  });

  it("says causes belong to the ruleset the replay was played in when the page shows the other", async () => {
    const { missExplanations$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    missExplanations$.next(readySession());
    const dialog = await openAnalysis();
    expect(within(errorCauses(dialog)).getByText("1 error")).toBeTruthy();
    fireEvent.click(analysisRuleset(dialog, "Lazer"));
    expect(within(errorCauses(dialog)).getByRole("status").textContent).toBe(
      "Causes are available in the Stable view only.",
    );
  });

  it("says the analysis is unavailable when the session is unsupported", async () => {
    const { missExplanations$ } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    missExplanations$.next({ status: "unsupported", reasons: ["source-beyond-canonical-traversal"] });
    const dialog = await openAnalysis();
    expect(within(errorCauses(dialog)).getByRole("status").textContent).toBe("Error analysis unavailable.");
  });
});

describe("ReplayActions clip controls", () => {
  it("keeps export locked during deterministic frame rendering", async () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(
      <>
        <InspectorProbe />
        <ReplayActions />
      </>,
    );
    const analyzer = (useAnalysisApp as jest.Mock).mock.results.slice(-1)[0].value;
    act(() => analyzer.clipRecorder.state$.next({ status: "rendering", progress: 0.5 }));
    const action = menuItemIn(await openMoreMenu(), "Export clip");
    // A disabled item is announced as such and takes no pointer input (jsdom would still deliver a synthetic click).
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(getComputedStyle(action).pointerEvents).toBe("none");
    // A locked Export item starts no session.
    expect(inspector.mode).toBe("incidents");
    expect(inspector.exportSession).toBe(false);
  });
});

describe("ReplayActions full-map graph", () => {
  /** A point inside the plot of the chart's default 1840 x 230 frame; only the plot opens the replay. */
  const ON_THE_PLOT = { clientX: 400, clientY: 100 };

  /** Opens the page on its hit-error graph: the fixture's one timed hit, at 1:000, is that graph's one point. */
  async function openHitErrorGraph() {
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
    const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });
    fireEvent.click(analysisGraph(dialog, "Hit error"));
    return within(dialog).getByTestId("timing-interaction-layer");
  }

  it("seeks and closes on a graph click", async () => {
    const { gameClock } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    const seekTo = jest.spyOn(gameClock, "seekTo");
    const start = jest.spyOn(gameClock, "start");
    const plot = await openHitErrorGraph();
    expect(screen.getByText("Click the graph to open the replay there")).toBeTruthy();
    fireEvent.click(plot, ON_THE_PLOT);
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(1_000);
    // The replay opens there and waits: the page paused it on the way in.
    expect(start).not.toHaveBeenCalled();
    expect(gameClock.isPlaying).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Full-map analysis" })).toBeNull());
  });

  it("ignores it while a clip export is busy", async () => {
    const { gameClock } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    const seekTo = jest.spyOn(gameClock, "seekTo");
    const plot = await openHitErrorGraph();
    (useAnalysisApp as jest.Mock).mock.results.slice(-1)[0].value.clipRecorder.isBusy = true;
    fireEvent.click(plot, ON_THE_PLOT);
    expect(seekTo).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Full-map analysis" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Timing error over time" })).toBeTruthy();
  });

  it("marks the map from the same events as the replay timeline, not the summary's filtered ones", async () => {
    const fullMap = fullMapFixture();
    // A Lazer judgement the summary leaves out (its object is not one it counts) is still a mark of the timeline.
    fullMap.lazerEvents.push({
      type: "HitObjectJudgement",
      eventId: "lazer:slider-0/head",
      ruleset: "lazer",
      time: 1_160,
      objectTime: 1_150,
      judgementTime: 1_160,
      hitObjectId: "slider-0/head",
      verdict: "OK",
      position: { x: 256, y: 192 },
    });
    const analyze = jest.spyOn(fullMapAnalysis, "analyzeFullMap");
    const buildViewModel = jest.spyOn(fullMapViewModel, "buildFullMapAnalysisViewModel");
    try {
      setup(EMPTY_COMPARISON, { withFullMapAnalysis: true, fullMap });
      render(<ReplayActions />);
      fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
      const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });
      fireEvent.click(analysisRuleset(dialog, "Lazer"));
      await waitFor(() => {
        const viewModel = buildViewModel.mock.results[buildViewModel.mock.results.length - 1]
          .value as fullMapViewModel.FullMapAnalysisViewModel;
        expect(viewModel.summary.ruleset).toBe("lazer");
        // The fixture's missed slider tick is the Lazer timeline's slider-break mark.
        expect(viewModel.marks).toEqual({ miss: [], sliderBreak: [1_100], ok: [1_150], meh: [] });
      });
      expect(analyze.mock.calls[analyze.mock.calls.length - 1][0].events).not.toContainEqual(
        expect.objectContaining({ hitObjectId: "slider-0/head" }),
      );
    } finally {
      analyze.mockRestore();
      buildViewModel.mockRestore();
    }
  });
});

describe("ReplayActions screenshots", () => {
  it("ignores the capture-phase screenshot shortcut while a clip is exporting", () => {
    const { takeScreenshot } = setup();
    render(<ReplayActions />);
    (useAnalysisApp as jest.Mock).mock.results.slice(-1)[0].value.clipRecorder.isBusy = true;
    fireEvent.keyDown(window, { key: "F12", code: "F12" });
    expect(takeScreenshot).not.toHaveBeenCalled();
  });
  const shortcut = { key: "F12", code: "F12" };

  it("captures at once with no menu open, and permits only one capture while it is in flight", async () => {
    const { takeScreenshot } = setup();
    let finishCapture!: () => void;
    takeScreenshot.mockReturnValue(new Promise<void>((resolve) => (finishCapture = resolve)));
    render(<ReplayActions />);
    const more = screen.getByRole("button", { name: "More replay actions" }) as HTMLButtonElement;

    fireEvent.keyDown(window, shortcut);
    expect(takeScreenshot).toHaveBeenCalledTimes(1);
    expect(more.disabled).toBe(true);
    fireEvent.keyDown(window, shortcut);
    fireEvent.keyDown(window, { ...shortcut, repeat: true });
    expect(takeScreenshot).toHaveBeenCalledTimes(1);
    expect(more.disabled).toBe(true);

    await act(async () => finishCapture());
    expect(more.disabled).toBe(false);
    expect(takeScreenshot).toHaveBeenCalledTimes(1);
  });

  it("waits for the menu exit before a shortcut capture and disables ⋮ meanwhile", async () => {
    jest.useFakeTimers();
    try {
      const { takeScreenshot } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
      let finishCapture!: () => void;
      takeScreenshot.mockReturnValue(new Promise<void>((resolve) => (finishCapture = resolve)));
      render(<ReplayActions />);
      const more = screen.getByRole("button", { name: "More replay actions" }) as HTMLButtonElement;
      fireEvent.click(more);
      act(() => jest.runOnlyPendingTimers());
      const menu = screen.getByRole("menu", { name: "More replay actions" });

      fireEvent.keyDown(window, shortcut);
      expect(menu.isConnected).toBe(true);
      expect(takeScreenshot).not.toHaveBeenCalled();
      expect(more.disabled).toBe(true);

      act(() => jest.runOnlyPendingTimers());
      expect(screen.queryByRole("menu")).toBeNull();
      expect(takeScreenshot).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(window, shortcut);
      expect(takeScreenshot).toHaveBeenCalledTimes(1);
      expect(more.disabled).toBe(true);

      await act(async () => finishCapture());
      expect(more.disabled).toBe(false);
      expect(takeScreenshot).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("shows capture failures in a Snackbar and allows a successful retry", async () => {
    const { takeScreenshot } = setup();
    takeScreenshot.mockRejectedValueOnce(new Error("Clipboard capture failed"));
    render(<ReplayActions />);

    await act(async () => fireEvent.keyDown(window, shortcut));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not take a screenshot. Please try again.");
    expect(alert.closest(".MuiSnackbar-root")).not.toBeNull();
    const more = screen.getByRole("button", { name: "More replay actions" }) as HTMLButtonElement;
    expect(more.disabled).toBe(false);

    await act(async () => fireEvent.keyDown(window, shortcut));
    await waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(more.disabled).toBe(false);
  });

  it("waits for an already-closing menu before taking a shortcut screenshot", async () => {
    const { takeScreenshot } = setup();
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "More replay actions" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.keyDown(window, shortcut);
    expect(takeScreenshot).not.toHaveBeenCalled();
    await waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
  });

  it.each([
    ["Full-map analysis", /Full-map analysis/, EMPTY_COMPARISON],
    ["Stable replay comparison", /Open replay comparison/, READY_STABLE_REPLAY_COMPARISON],
  ] as const)(
    "captures with %s open without changing the dialog or playback",
    async (dialogName, menuName, comparison) => {
      const { takeScreenshot, controls, setRulesetFocus, clearReplayComparison, replayComparison$ } = setup(
        comparison,
        {
          withFullMapAnalysis: true,
        },
      );
      render(<ReplayActions />);
      if (dialogName === "Full-map analysis") {
        fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
      } else {
        await chooseMenuItem(menuName);
      }
      const dialogLabel = new RegExp(dialogName);
      const dialog = await screen.findByRole("dialog", { name: dialogLabel });
      const dialogBefore = dialog.innerHTML;
      const comparisonBefore = replayComparison$.getValue();

      // Repeated keydown events must not start a capture, even while idle.
      fireEvent.keyDown(dialog, { ...shortcut, repeat: true });
      expect(takeScreenshot).not.toHaveBeenCalled();
      await act(async () => fireEvent.keyDown(dialog, shortcut));
      await waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("dialog", { name: dialogLabel })).toBe(dialog);
      expect(dialog.innerHTML).toBe(dialogBefore);
      fireEvent.keyDown(dialog, { ...shortcut, repeat: true });
      expect(takeScreenshot).toHaveBeenCalledTimes(1);
      expect(replayComparison$.getValue()).toBe(comparisonBefore);
      expect(setRulesetFocus).not.toHaveBeenCalled();
      expect(clearReplayComparison).not.toHaveBeenCalled();
      for (const control of Object.values(controls)) {
        if (jest.isMockFunction(control)) expect(control).not.toHaveBeenCalled();
      }
    },
  );
});

describe("ReplayActions replay comparison controls", () => {
  it("keeps full-map identity bound to the loaded beatmap and primary player across ruleset switches", async () => {
    const fullMap = fullMapFixture();
    fullMap.metadata = {
      ...fullMap.metadata,
      title: "  Current song  ",
      artist: " Current artist ",
      difficultyName: " Current difficulty ",
    };
    fullMap.replay.player = " Primary player ";
    const buildViewModel = jest.spyOn(fullMapViewModel, "buildFullMapAnalysisViewModel");
    try {
      setup(READY_STABLE_REPLAY_COMPARISON, { withFullMapAnalysis: true, fullMap });
      render(<ReplayActions />);
      fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
      const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });

      for (const ruleset of ["stable", "lazer"] as const) {
        if (ruleset === "lazer") {
          fireEvent.click(analysisRuleset(dialog, "Lazer"));
        }
        await waitFor(() => {
          const viewModel = buildViewModel.mock.results[buildViewModel.mock.results.length - 1]
            .value as fullMapViewModel.FullMapAnalysisViewModel;
          expect(viewModel.summary.ruleset).toBe(ruleset);
          // Collected where the view model is built: the fixture's one hit has no earlier object, so aim says so
          // in its own words (not the builder's default). The slider-break mark is Stable's slider break and Lazer's
          // missed slider tick, as on the replay timeline.
          expect(viewModel.aim).toMatchObject({
            available: false,
            unavailableReason: "No hit had usable cursor evidence.",
          });
          expect(viewModel.marks).toEqual({
            miss: [],
            sliderBreak: [1_100],
            ok: [],
            meh: [],
          });
          expect(viewModel.context).toEqual({
            title: "Current song",
            artist: "Current artist",
            difficulty: "Current difficulty",
            player: "Primary player",
          });
        });
      }
    } finally {
      buildViewModel.mockRestore();
    }
  });

  it.each([
    ["circle", true],
    ["circle", false],
    ["slider", true],
    ["slider", false],
  ] as const)(
    "starts both rulesets at the first missed %s, with later successful hits: %s",
    async (firstType, hasHits) => {
      const fullMap = fullMapFixture();
      const firstCircle = fullMap.beatmap.hitObjects[0] as HitCircle;
      const firstSlider = new Slider(firstCircle);
      firstSlider.id = "first-slider";
      firstSlider.path = new SliderPath(
        [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
        100,
      );
      firstSlider.velocity = 100 / 3_000;
      const later = new HitCircle();
      later.id = "later-circle";
      later.hitTime = 8_000;
      const leadingSpinner = new Spinner();
      leadingSpinner.id = "leading-spinner";
      leadingSpinner.startTime = 100;
      leadingSpinner.duration = 400;
      const trailingSpinner = new Spinner();
      trailingSpinner.id = "trailing-spinner";
      trailingSpinner.startTime = 12_000;
      trailingSpinner.duration = 2_000;
      const invalidCircle = new HitCircle();
      invalidCircle.id = "invalid-circle";
      invalidCircle.hitTime = Number.NaN;
      // Object-array order and replay success must not select the chart boundaries.
      fullMap.beatmap = new Beatmap(
        [later, invalidCircle, trailingSpinner, firstType === "slider" ? firstSlider : firstCircle, leadingSpinner],
        { ...DEFAULT_BEATMAP_DIFFICULTY },
        [],
        Beatmap.EMPTY_BEATMAP.controlPointInfo,
      );
      fullMap.stableEvents = fullMap.stableEvents.map((event) =>
        event.type === "HitObjectJudgement" ? { ...event, verdict: "MISS" } : event,
      );
      fullMap.lazerEvents = fullMap.lazerEvents.map((event) =>
        event.type === "HitObjectJudgement" ? { ...event, verdict: "MISS" } : event,
      );
      const analyze = jest.spyOn(fullMapAnalysis, "analyzeFullMap");
      try {
        setup(EMPTY_COMPARISON, {
          withFullMapAnalysis: true,
          fullMap,
          hits: hasHits
            ? [
                [1_200, 200, false],
                [8_020, 20, true],
              ]
            : [[1_200, 200, false]],
        });
        render(<ReplayActions />);
        fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
        const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });
        expect(analyze).toHaveBeenLastCalledWith(
          expect.objectContaining({ ruleset: "stable", startTime: 1_000, duration: 8_000 }),
        );
        expect(within(dialog).getByText("Length").textContent).toContain("0:02.000");

        fireEvent.click(analysisRuleset(dialog, "Lazer"));
        await waitFor(() =>
          expect(analyze).toHaveBeenLastCalledWith(
            expect.objectContaining({ ruleset: "lazer", startTime: 1_000, duration: 8_000 }),
          ),
        );
        expect(analyze.mock.results[analyze.mock.results.length - 1].value.timing.samples).toHaveLength(
          hasHits ? 1 : 0,
        );
      } finally {
        analyze.mockRestore();
      }
    },
  );

  it.each(["circle", "slider", "overlapping-slider", "miss"] as const)(
    "ends all displayed graphs at the last non-spinner start for a final %s while preserving analysis duration",
    async (mapKind) => {
      const fullMap = fullMapFixture();
      const first = fullMap.beatmap.hitObjects[0] as HitCircle;
      const middle = new HitCircle();
      middle.id = "middle-circle";
      middle.hitTime = 4_000;
      const last = new HitCircle();
      last.id = "last-circle";
      last.hitTime = 8_000;
      const slider = new Slider(mapKind === "slider" ? last : first);
      slider.id = "boundary-slider";
      slider.path = new SliderPath(
        [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
        100,
      );
      slider.velocity = 100 / (mapKind === "slider" ? 3_000 : 14_000);
      const trailingSpinner = new Spinner();
      trailingSpinner.id = "trailing-spinner";
      trailingSpinner.startTime = 16_000;
      trailingSpinner.duration = 2_000;
      fullMap.beatmap = new Beatmap(
        [
          mapKind === "slider" ? slider : last,
          trailingSpinner,
          middle,
          mapKind === "overlapping-slider" ? slider : first,
        ],
        { ...DEFAULT_BEATMAP_DIFFICULTY },
        [],
        Beatmap.EMPTY_BEATMAP.controlPointInfo,
      );
      const finalHitTime = mapKind === "miss" ? 8_150 : 8_020;
      for (const ruleset of ["stable", "lazer"] as const) {
        fullMap[ruleset === "stable" ? "stableEvents" : "lazerEvents"].push({
          type: "HitObjectJudgement",
          eventId: `${ruleset}:last-object`,
          ruleset,
          time: finalHitTime,
          objectTime: 8_000,
          judgementTime: finalHitTime,
          hitObjectId: last.id,
          verdict: mapKind === "miss" ? "MISS" : "GREAT",
          position: last.position,
        });
      }
      const hits: fullMapAnalysis.GameSimulatorHit[] = [
        [1_000, -10, true],
        [4_000, 0, true],
        [finalHitTime, finalHitTime - 8_000, mapKind !== "miss"],
      ];
      const expectedDuration = mapKind === "slider" ? 11_000 : mapKind === "overlapping-slider" ? 15_000 : 8_000;
      const analyze = jest.spyOn(fullMapAnalysis, "analyzeFullMap");
      const buildViewModel = jest.spyOn(fullMapViewModel, "buildFullMapAnalysisViewModel");
      try {
        setup(EMPTY_COMPARISON, { withFullMapAnalysis: true, fullMap, hits });
        render(<ReplayActions />);
        fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
        const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });

        for (const ruleset of ["stable", "lazer"] as const) {
          if (ruleset === "lazer") {
            fireEvent.click(analysisRuleset(dialog, "Lazer"));
          }
          await waitFor(() =>
            expect(analyze).toHaveBeenLastCalledWith(
              expect.objectContaining({ ruleset, startTime: 1_000, duration: expectedDuration }),
            ),
          );
          const viewModel = buildViewModel.mock.results[buildViewModel.mock.results.length - 1]
            .value as fullMapViewModel.FullMapAnalysisViewModel;
          expect(viewModel.chartEndTimeMs).toBe(8_000);
          expect(viewModel.summary.duration).toBe(expectedDuration);
          expect(viewModel.summary.timing.thirds[2].endTime).toBe(expectedDuration);
          expect(viewModel.summary.timing.samples).toEqual(
            hits.filter(([, , successful]) => successful).map(([time, offsetMs]) => ({ time, offsetMs })),
          );
          expect(viewModel.footer.durationMs).toBe(2_000);
          if (mapKind === "miss") {
            expect(analyze.mock.calls[analyze.mock.calls.length - 1][0].events).toContainEqual(
              expect.objectContaining({ hitObjectId: last.id, verdict: "MISS", objectTime: 8_000 }),
            );
          }

          const expectGraphEnd = (name: string) => {
            const graph = within(dialog).getByRole("img", { name });
            expect(within(graph).getByText("0:08").getAttribute("x")).toBe("1784");
            for (const obsoleteEnd of ["0:11", "0:15", "0:18"]) {
              expect(within(graph).queryByText(obsoleteEnd)).toBeNull();
            }
          };
          // One graph at a time: the unstable rate first, then the hit error in its place.
          expectGraphEnd("Unstable rate over time");
          fireEvent.click(analysisGraph(dialog, "Hit error"));
          expectGraphEnd("Timing error over time");
          fireEvent.click(analysisGraph(dialog, "Unstable rate · 50 hits"));
          expect(within(dialog).getByText("Length").textContent).toContain("0:02.000");
        }
      } finally {
        analyze.mockRestore();
        buildViewModel.mockRestore();
      }
    },
  );

  it.each(["empty", "spinner-only"])("uses a finite zero-start fallback for %s maps", async (mapKind) => {
    const fullMap = fullMapFixture();
    fullMap.beatmap = new Beatmap(
      mapKind === "spinner-only" ? [fullMap.beatmap.hitObjects[1]] : [],
      { ...DEFAULT_BEATMAP_DIFFICULTY },
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
    );
    const analyze = jest.spyOn(fullMapAnalysis, "analyzeFullMap");
    try {
      setup(EMPTY_COMPARISON, { withFullMapAnalysis: true, fullMap, hits: [] });
      render(<ReplayActions />);
      fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));
      await screen.findByRole("dialog", { name: "Full-map analysis" });
      expect(analyze).toHaveBeenLastCalledWith(expect.objectContaining({ startTime: 0, duration: 2_000 }));
    } finally {
      analyze.mockRestore();
    }
  });

  it("switches the open full-map analysis through the simulator and rebuilds the focused ruleset", async () => {
    const { setRulesetFocus } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);

    fireEvent.click(screen.getByRole("button", { name: "Full-map analysis" }));

    const dialog = await screen.findByRole("dialog", { name: "Full-map analysis" });
    expect(analysisRuleset(dialog, "Stable").getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByText(/reconstruction/)).toBeNull();
    expect(within(dialog).getByText("SliderBreak")).toBeTruthy();
    const stableUrChart = within(dialog).getByRole("img", { name: "Unstable rate over time" });
    // One timed hit is too few for an unstable rate: the graph says so and draws no time axis.
    expect(within(stableUrChart).getByText("No UR samples")).toBeTruthy();
    expect(within(stableUrChart).queryByText("0:01")).toBeNull();
    fireEvent.click(analysisGraph(dialog, "Hit error"));
    const stableTimingChart = within(dialog).getByRole("img", { name: "Timing error over time" });
    expect(within(stableTimingChart).getByText("0:01")).toBeTruthy();
    expect(within(stableTimingChart).queryByText("0:02")).toBeNull();
    expect(within(dialog).getByText("Length").textContent).toContain("0:02.000");

    fireEvent.click(analysisRuleset(dialog, "Lazer"));

    expect(setRulesetFocus).toHaveBeenLastCalledWith("lazer");
    await waitFor(() => expect(within(dialog).getByText(/Lazer reconstruction/)).toBeTruthy());
    expect(within(dialog).getByText("SliderTick")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Full-map analysis" })).toBe(dialog);

    fireEvent.click(analysisRuleset(dialog, "Stable"));

    expect(setRulesetFocus).toHaveBeenLastCalledWith("stable");
    await waitFor(() => expect(analysisRuleset(dialog, "Stable").getAttribute("aria-pressed")).toBe("true"));
    expect(within(dialog).queryByText(/reconstruction/)).toBeNull();
    expect(within(dialog).getByText("SliderBreak")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Full-map analysis" })).toBe(dialog);
  });

  it("keeps an Autoplay comparison dialog-less while exposing direct Exit", async () => {
    const { compareWithAutoplayReference } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);

    await chooseMenuItem(/Compare with Autoplay/);

    expect(compareWithAutoplayReference).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Exit replay comparison" })).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: /Replay comparison/ })).toBeNull();

    const menu = await openMoreMenu();
    expect(within(menu).queryByRole("menuitem", { name: /Open replay comparison/ })).toBeNull();
  });

  it("keeps replay comparison labels bound to the stored ruleset after live focus changes", async () => {
    setup(READY_STABLE_REPLAY_COMPARISON);
    render(<ReplayActions />);

    // The menu row is one line with no ruleset text; the dialog it opens carries the stored ruleset.
    const open = menuItemIn(await openMoreMenu(), /Open replay comparison/);
    fireEvent.click(open);

    expect(await screen.findByRole("heading", { name: "Stable replay comparison" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Miss / Slider Break" })).toBeTruthy();
  });

  it("exposes a direct exit action and removes the redundant overflow-menu action", async () => {
    const { clearReplayComparison } = setup(READY_AUTOPLAY_COMPARISON);
    render(<ReplayActions />);

    const exitButton = screen.getByRole("button", { name: "Exit replay comparison" });
    expect(exitButton.textContent).toContain("Exit comparison");
    act(() => exitButton.focus());
    expect(document.activeElement).toBe(exitButton);

    fireEvent.click(screen.getByRole("button", { name: "More replay actions" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: /Clear replay comparison/ })).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });

    fireEvent.click(exitButton);
    expect(clearReplayComparison).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Exit replay comparison" })).toBeNull());
  });

  it("keeps the comparison actions in the ⋮ menu; the dock has no Compare button or second menu", async () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    expect(screen.queryByRole("button", { name: /compare/i })).toBeNull();
    const more = await openMoreMenu();
    expect(within(more).getByText("Compare with another replay…")).toBeTruthy();
    expect(within(more).getByText("Compare with Autoplay")).toBeTruthy();
    expect(within(more).queryByText("Open replay comparison")).toBeNull();
    expect(within(more).getByText("Keyboard shortcuts")).toBeTruthy();
    expect(within(more).getByText("Close replay")).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Compare with…" })).toBeNull();
  });

  it("moves keyboard focus onto the first item, Export clip, when the menu opens", async () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    const menu = await openMoreMenu();
    const first = within(menu).getAllByRole("menuitem")[0];
    expect(first.textContent).toContain("Export clip");
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.getAttribute("tabindex")).toBe("0");
  });

  it("offers Open replay comparison in the ⋮ menu while a replay comparison is ready", async () => {
    setup(READY_STABLE_REPLAY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    const more = await openMoreMenu();
    expect(within(more).getByText("Open replay comparison")).toBeTruthy();
    expect(within(more).getByText("Compare with another replay…")).toBeTruthy();
    expect(within(more).getByText("Compare with Autoplay")).toBeTruthy();
  });

  it("draws More as the 3a three-dot glyph inside the named button", () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    const more = screen.getByRole("button", { name: "More replay actions" });
    const svgs = more.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("aria-hidden")).toBe("true");
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 4 14");
    expect(svgs[0].querySelectorAll("circle")).toHaveLength(3);
  });

  it("offers Close replay in the overflow menu", async () => {
    const { clearReplay } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    fireEvent.click(screen.getByRole("button", { name: "More replay actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close replay" }));
    await waitFor(() => expect(clearReplay).toHaveBeenCalledTimes(1));
  });
});

describe("ReplayActions ⋮ menu", () => {
  /** The menu top to bottom: each item's primary text, a divider as "—". */
  const layoutOf = (menu: HTMLElement) =>
    Array.from(menu.children).map((child) =>
      child.classList.contains("MuiDivider-root")
        ? "—"
        : child.querySelector(".MuiListItemText-primary")?.textContent ?? "",
    );

  it("lists Export clip, the compare items, Keyboard shortcuts and Close replay in four groups divided by hairlines", async () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    expect(layoutOf(await openMoreMenu())).toEqual([
      "Export clip",
      "—",
      "Compare with another replay…",
      "Compare with Autoplay",
      "—",
      "Keyboard shortcuts",
      "—",
      "Close replay",
    ]);
  });

  it("adds Open replay comparison to the compare group only while a replay comparison exists", async () => {
    setup(READY_STABLE_REPLAY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    expect(layoutOf(await openMoreMenu()).slice(0, 6)).toEqual([
      "Export clip",
      "—",
      "Compare with another replay…",
      "Compare with Autoplay",
      "Open replay comparison",
      "—",
    ]);
  });

  it.each([
    ["no comparison", EMPTY_COMPARISON],
    ["a replay comparison", READY_STABLE_REPLAY_COMPARISON],
  ] as const)("gives every item one line, with %s", async (_name, comparison) => {
    setup(comparison, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    const menu = await openMoreMenu();
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThanOrEqual(5);
    expect(menu.querySelectorAll(".MuiListItemText-secondary")).toHaveLength(0);
  });

  it("has no rows for Open replay…, Take screenshot or Settings; those are F2, F12 and the dock's Settings button", async () => {
    setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    render(<ReplayActions />);
    const menu = await openMoreMenu();
    for (const name of [/open replay…/i, /screenshot/i, /settings/i]) {
      expect([name.source, within(menu).queryByRole("menuitem", { name })]).toEqual([name.source, null]);
    }
  });

  describe("Export clip", () => {
    function mount() {
      setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
      render(
        <>
          <InspectorProbe />
          <ReplayActions />
        </>,
      );
    }

    it("opens and closes the Export mode, reads Close export and shows selected while it is open", async () => {
      mount();
      const menu = await openMoreMenu();
      const closed = menuItemIn(menu, "Export clip");
      expect(closed.classList.contains("Mui-selected")).toBe(false);
      expect(closed.getAttribute("aria-disabled")).toBeNull();
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
      expect(inspector.mode).toBe("incidents");

      await chooseMenuItem("Export clip");
      expect(inspector.mode).toBe("export");
      expect(inspector.exportSession).toBe(true);

      const open = menuItemIn(await openMoreMenu(), "Close export");
      expect(open.classList.contains("Mui-selected")).toBe(true);
      expect(screen.queryByRole("menuitem", { name: /^Export clip/ })).toBeNull();
      fireEvent.click(open);
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
      expect(inspector.mode).toBe("incidents");
      expect(inspector.exportSession).toBe(false);

      // Settings opened from Export is still an export session: the item stays selected and closes the whole session.
      await chooseMenuItem("Export clip");
      act(() => inspector.openSettings());
      expect(inspector.mode).toBe("settings");
      const during = menuItemIn(await openMoreMenu(), "Close export");
      expect(during.classList.contains("Mui-selected")).toBe(true);
      fireEvent.click(during);
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
      expect(inspector.mode).toBe("incidents");
      expect(menuItemIn(await openMoreMenu(), "Export clip").classList.contains("Mui-selected")).toBe(false);
    });

    it("is off for a replay shorter than the shortest clip", async () => {
      const { gameClock } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
      gameClock.setDuration(100);
      render(<ReplayActions />);
      expect(menuItemIn(await openMoreMenu(), "Export clip").getAttribute("aria-disabled")).toBe("true");
    });
  });

});

describe("playbar audio settings", () => {
  it("shows the persisted effects volume instead of resetting the slider to zero", async () => {
    (useAudioSettings as jest.Mock).mockReturnValue({
      muted: false,
      volume: { master: 0.1, music: 0.8, effects: 0.37 },
    });
    (useAudioSettingsService as jest.Mock).mockReturnValue({
      setMuted: jest.fn(),
      setMasterVolume: jest.fn(),
      setMusicVolume: jest.fn(),
      setEffectsVolume: jest.fn(),
    });

    render(<AudioButton />);
    fireEvent.click(screen.getByRole("button", { name: "Audio settings" }));

    const label = await screen.findByText("Effects Volume");
    const panel = label.parentElement;
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement)
        .getByRole("slider")
        .getAttribute("aria-valuenow"),
    ).toBe("37");
  });
});

describe("Dock shell", () => {
  function renderDock() {
    const { controls, takeScreenshot } = setup(EMPTY_COMPARISON, { withFullMapAnalysis: true });
    Object.assign(controls, { isPlaying: false, duration: 2_000, setSpeed: jest.fn() });
    const analyzer = (useAnalysisApp as jest.Mock)();
    Object.assign(analyzer, { frameRendered$: new Subject<void>() });
    Object.assign(analyzer.gameSimulator, { difficulties$: new BehaviorSubject<number[]>([]) });
    (useCommonManagers as jest.Mock).mockReturnValue({
      playbarSettingsStore: { settings$: new BehaviorSubject(DEFAULT_PLAY_BAR_SETTINGS) },
    });
    (useAudioSettings as jest.Mock).mockReturnValue({ muted: false, volume: { master: 1, music: 1, effects: 1 } });
    (useAudioSettingsService as jest.Mock).mockReturnValue({});
    const view = render(
      <ErrorNavigationProvider>
        <InspectorProbe />
        <Dock />
      </ErrorNavigationProvider>,
    );
    return { analyzer, view, takeScreenshot };
  }

  it("renders the transport controls in the 3a order", () => {
    const { view } = renderDock();
    const order = [
      /^play replay$/i,
      /^decrease viewer speed$/i,
      /^viewer playback speed/i,
      /^increase viewer speed$/i,
      /^audio settings$/i,
      /^toggle hidden visualization$/i,
      /^settings$/i,
      /^full-map analysis$/i,
      /^more replay actions$/i,
    ];
    const buttons = order.map((name) => screen.getByRole("button", { name }));
    const positions = buttons.map((button) =>
      within(view.container).getAllByRole("button").indexOf(button),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The time readout sits between Play and the speed stepper.
    const time = screen.getByTitle("Elapsed replay time at the modded rate");
    expect(buttons[0].compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(time.compareDocumentPosition(buttons[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(previous|next) error$/i })).toBeNull();
    // Settings, Analysis and ⋮ are all that is left of the dock's right side; Compare and Export are in the menu.
    expect(screen.queryByRole("button", { name: /^(compare replays|export)$/i })).toBeNull();
  });

  /** jsdom's computed style ignores selector specificity, so look for the 16 px rule that targets the glyph. */
  const setsFontSize16 = (element: Element) =>
    Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .some((rule) => rule instanceof CSSStyleRule && rule.style.getPropertyValue("font-size") === "16px" && element.matches(rule.selectorText));

  it("gives each text action its Material icon before its label, and shows only the icons in a narrow window", () => {
    renderDock();
    const actions: Array<[string, string, string]> = [
      ["Settings", "Settings", "SettingsOutlinedIcon"],
      ["Full-map analysis", "Analysis", "BarChartIcon"],
    ];
    for (const [name, label, glyph] of actions) {
      const button = screen.getByRole("button", { name });
      // The icon is decorative, 16 px, ahead of the label. The label is displayed here, so the button has no title.
      const icon = button.querySelector(`svg[data-testid="${glyph}"]`) as SVGElement;
      expect([name, icon]).not.toEqual([name, null]);
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(setsFontSize16(icon)).toBe(true);
      expect(button.querySelectorAll("svg")).toHaveLength(1);
      expect(button.hasAttribute("title")).toBe(false);
      expect(button.textContent).toBe(label);
      const text = within(button).getByText(label);
      expect(icon.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Below the md breakpoint (900 px) the label is hidden and the 6 px gap goes with it.
      const classes = Array.from(text.classList).filter((entry) => entry.startsWith("css-"));
      const rules = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
      const media = rules.filter(
        (rule) => rule.cssText.startsWith("@media") && classes.some((entry) => rule.cssText.includes("." + entry)),
      );
      expect(media.map((rule) => rule.cssText).join("\n")).toMatch(
        /min-width:\s*0px[^}]*display: none[\s\S]*min-width:\s*900px[^}]*display: inline/,
      );
    }
  });

  it("names Analysis by its own aria-label, so the name does not depend on the label being displayed", () => {
    renderDock();
    expect(screen.getByRole("button", { name: "Full-map analysis" }).getAttribute("aria-label")).toBe("Full-map analysis");
  });

  it("names the menu items by their visible text: Export clip, Compare with another replay…", async () => {
    renderDock();
    const menu = await openMoreMenu();
    for (const name of ["Export clip", "Compare with another replay…", "Compare with Autoplay"]) {
      expect([name, menuItemIn(menu, name).hasAttribute("aria-label")]).toEqual([name, false]);
    }
  });

  /** jsdom's computed style ignores selector specificity, so look for the 18 px rule that targets the glyph. */
  const setsFontSize18 = (element: Element) =>
    Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .some((rule) => rule instanceof CSSStyleRule && rule.style.getPropertyValue("font-size") === "18px" && element.matches(rule.selectorText));

  it("gives each menu item a decorative 18 px Material icon before its label", async () => {
    renderDock();
    const menu = await openMoreMenu();
    const items: Array<[string, string]> = [
      ["Export clip", "IosShareIcon"],
      ["Compare with another replay…", "AddIcon"],
      ["Compare with Autoplay", "AutoAwesomeIcon"],
      ["Keyboard shortcuts", "HelpIcon"],
      ["Close replay", "CloseIcon"],
    ];
    for (const [name, glyph] of items) {
      const item = menuItemIn(menu, name);
      const icon = item.querySelector('svg[data-testid="' + glyph + '"]') as SVGElement;
      expect([name, icon]).not.toEqual([name, null]);
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(setsFontSize18(icon)).toBe(true);
      expect(item.querySelectorAll("svg")).toHaveLength(1);
    }
  });

  it("gives the text actions their label as a title only when the labels are hidden (below md)", () => {
    const original = window.matchMedia;
    const labels: Array<[string, string]> = [
      ["Settings", "Settings"],
      ["Full-map analysis", "Analysis"],
    ];
    try {
      // A window narrower than md: the query matches.
      window.matchMedia = ((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      renderDock();
      for (const [name, label] of labels) expect([name, screen.getByRole("button", { name }).getAttribute("title")]).toEqual([name, label]);
    } finally {
      window.matchMedia = original;
    }
  });

  it("hides speed, audio and Hidden during an export session and brings them back after", () => {
    renderDock();
    const hiddenDuringExport = [
      /^decrease viewer speed$/i,
      /^viewer playback speed/i,
      /^increase viewer speed$/i,
      /^audio settings$/i,
      /^toggle hidden visualization$/i,
    ];
    for (const name of hiddenDuringExport) expect(screen.queryByRole("button", { name })).not.toBeNull();

    act(() => inspector.openExport());
    for (const name of hiddenDuringExport) expect([name.source, screen.queryByRole("button", { name })]).toEqual([name.source, null]);
    // The rest of the transport and the replay actions stay, the ⋮ button with them.
    for (const name of [/^play replay$/i, /^settings$/i, /^full-map analysis$/i, /^more replay actions$/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeNull();
    }
    expect(screen.getByLabelText("Clip time")).toBeTruthy();

    act(() => inspector.closeMode());
    for (const name of hiddenDuringExport) expect(screen.queryByRole("button", { name })).not.toBeNull();
    expect(screen.queryByLabelText("Clip time")).toBeNull();
    expect(screen.getByTitle("Elapsed replay time at the modded rate")).toBeTruthy();
  });

  it("the Export clip item opens and closes the Export mode and reads as selected", async () => {
    renderDock();
    // The panel's own button is the one named Export clip; the dock has none.
    expect(screen.queryByRole("button", { name: "Export clip" })).toBeNull();
    const selected = async (name: string) => {
      const menu = await openMoreMenu();
      const state = menuItemIn(menu, name).classList.contains("Mui-selected");
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
      return state;
    };
    expect(inspector.mode).toBe("incidents");
    expect(await selected("Export clip")).toBe(false);

    await chooseMenuItem("Export clip");
    expect(inspector.mode).toBe("export");
    expect(inspector.exportSession).toBe(true);
    expect(await selected("Close export")).toBe(true);

    await chooseMenuItem("Close export");
    expect(inspector.mode).toBe("incidents");
    expect(inspector.exportSession).toBe(false);
    expect(await selected("Export clip")).toBe(false);

    // Settings opened from Export is still an export session: the item stays selected and closes the whole session.
    await chooseMenuItem("Export clip");
    act(() => inspector.openSettings());
    expect(inspector.mode).toBe("settings");
    expect(await selected("Close export")).toBe(true);
    await chooseMenuItem("Close export");
    expect(inspector.mode).toBe("incidents");
    expect(await selected("Export clip")).toBe(false);
  });

  it("keeps More replay actions in an export session", async () => {
    renderDock();
    const more = () => screen.getByRole("button", { name: "More replay actions" }) as HTMLButtonElement;
    for (const open of [() => inspector.openExport(), () => inspector.openSettings()]) {
      act(open);
      // Exactly the button outside a session: no placeholder, enabled, with its menu.
      expect(screen.queryByTestId("more-actions-slot")).toBeNull();
      expect(more().disabled).toBe(false);
      expect(more().getAttribute("aria-haspopup")).toBe("true");
      fireEvent.click(more());
      const menu = await screen.findByRole("menu", { name: "More replay actions" });
      expect(within(menu).getByRole("menuitem", { name: /Close replay/ })).toBeTruthy();
      expect(within(menu).getByRole("menuitem", { name: /Keyboard shortcuts/ })).toBeTruthy();
      // The session is closed from the menu too.
      expect(menuItemIn(menu, "Close export").classList.contains("Mui-selected")).toBe(true);
      expect(menuItemIn(menu, /Compare with another replay/).getAttribute("aria-disabled")).toBeNull();
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
    }
    // Settings opened from Export is still the session.
    expect(inspector.exportSession).toBe(true);
  });

  it("takes the F12 screenshot after the ⋮ menu has closed during an export session", async () => {
    const { takeScreenshot } = renderDock();
    act(() => inspector.openExport());
    await openMoreMenu();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F12", code: "F12" });
    });
    await waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu", { hidden: true })).toBeNull();
    expect(inspector.mode).toBe("export");
  });

  it("still takes a screenshot with F12 during an export session, and no longer with Ctrl+Shift+S", async () => {
    const { takeScreenshot } = renderDock();
    act(() => inspector.openExport());
    expect(screen.queryByRole("button", { name: "More replay actions" })).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: "F12", code: "F12", shiftKey: true });
    });
    expect(takeScreenshot).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F12", code: "F12" });
    });
    await waitFor(() => expect(takeScreenshot).toHaveBeenCalledTimes(1));
    expect(inspector.mode).toBe("export");
  });

  it("plays the clip from its start when the playhead is at the range end", () => {
    const { analyzer } = renderDock();
    const clock = analyzer.gameClock as GameplayClock;
    act(() => {
      inspector.openExport();
      inspector.setExportRange({ startMs: 500, endMs: 1_500 });
    });
    act(() => clock.seekTo(1_500));
    const seekTo = jest.spyOn(clock, "seekTo");
    const start = jest.spyOn(clock, "start");

    fireEvent.click(screen.getByRole("button", { name: /^play replay$/i }));
    expect(seekTo).toHaveBeenCalledWith(500);
    expect(start).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(clock.playbackBoundaryInMs).toBe(1_500);
    expect(clock.isPlaying).toBe(true);
    act(() => clock.pause());
  });

  it("lets the time readout inherit the dock's mono font and sizes", () => {
    renderDock();
    const duration = screen.getByTitle("Replay duration at the modded rate");
    const current = screen.getByTitle("Elapsed replay time at the modded rate").querySelector(".MuiTypography-root");
    for (const typography of [duration, current]) {
      expect(typography?.classList.contains("MuiTypography-inherit")).toBe(true);
      expect(typography?.classList.contains("MuiTypography-body1")).toBe(false);
    }
  });

  it("disables the dock fieldset while the clip recorder is busy", () => {
    const { analyzer, view } = renderDock();
    const fieldset = view.container.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(false);
    act(() => analyzer.clipRecorder.state$.next({ status: "rendering", progress: 0.5 }));
    expect(fieldset.disabled).toBe(true);
    expect(fieldset.contains(screen.getByRole("button", { name: /^play replay$/i }))).toBe(true);
    act(() => analyzer.clipRecorder.state$.next({ status: "idle", progress: 0 }));
    expect(fieldset.disabled).toBe(false);
  });

  describe("without a replay", () => {
    const dimmed = [
      /^play replay$/i,
      /^decrease viewer speed$/i,
      /^increase viewer speed$/i,
      /^audio settings$/i,
      /^toggle hidden visualization$/i,
      /^full-map analysis$/i,
    ];
    /** The menu items that need a replay, and the one that does not. */
    const replayItems = ["Export clip", "Compare with another replay…", "Compare with Autoplay"];
    const alwaysItems = ["Keyboard shortcuts"];
    const isDisabled = (name: RegExp) => screen.getByRole("button", { name }).matches(":disabled");
    const timelineDisabled = () => screen.getByTestId("timeline").getAttribute("data-disabled");
    /** Opens the ⋮ menu, reads which of the named items are disabled, and closes it again. */
    async function disabledItems(names: string[]) {
      const menu = await openMoreMenu();
      const states = names.map((name) => [name, menuItemIn(menu, name).getAttribute("aria-disabled") === "true"]);
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
      return states;
    }

    it("disables the transport and the replay actions while idle, but not Settings or More", async () => {
      const { analyzer } = renderDock();
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      for (const name of dimmed) expect([name.source, isDisabled(name)]).toEqual([name.source, true]);
      expect(isDisabled(/^settings$/i)).toBe(false);
      expect(isDisabled(/^more replay actions$/i)).toBe(false);
      expect(await disabledItems(replayItems)).toEqual(replayItems.map((name) => [name, true]));
      expect(await disabledItems(alwaysItems)).toEqual(alwaysItems.map((name) => [name, false]));
      expect(timelineDisabled()).toBe("true");
    });

    it.each<ReplayLoadState>([
      { phase: "loading", step: "simulate" },
      { phase: "failed", failure: { kind: "other", message: "x" } },
    ])("keeps the replay controls disabled while $phase", async (state) => {
      const { analyzer } = renderDock();
      act(() => analyzer.scenarioManager.loadState$.next(state));
      for (const name of dimmed) expect(isDisabled(name)).toBe(true);
      expect(isDisabled(/^settings$/i)).toBe(false);
      expect(isDisabled(/^more replay actions$/i)).toBe(false);
      expect(await disabledItems(replayItems)).toEqual(replayItems.map((name) => [name, true]));
      expect(await disabledItems(alwaysItems)).toEqual(alwaysItems.map((name) => [name, false]));
      expect(timelineDisabled()).toBe("true");
    });

    it("takes no pointer input on the dimmed transport group, and again once ready", () => {
      const { analyzer } = renderDock();
      const transport = screen.getByRole("button", { name: /^play replay$/i }).closest("fieldset") as HTMLElement;
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      expect(getComputedStyle(transport).pointerEvents).toBe("none");
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "ready" }));
      expect(getComputedStyle(transport).pointerEvents).not.toBe("none");
    });

    it("dims the transport group and Analysis to 0.38, and each disabled menu item the same way, and nothing else", async () => {
      const { analyzer } = renderDock();
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      const transport = screen.getByRole("button", { name: /^play replay$/i }).closest("fieldset") as HTMLElement;
      expect(transport.parentElement?.closest("fieldset")).not.toBeNull();
      expect(getComputedStyle(transport).opacity).toBe("0.38");
      expect(getComputedStyle(screen.getByRole("button", { name: /^full-map analysis$/i })).opacity).toBe("0.38");
      for (const name of [/^settings$/i, /^more replay actions$/i]) {
        expect(getComputedStyle(screen.getByRole("button", { name })).opacity).not.toBe("0.38");
      }
      const menu = await openMoreMenu();
      for (const name of replayItems) expect([name, getComputedStyle(menuItemIn(menu, name)).opacity]).toEqual([name, "0.38"]);
      for (const name of alwaysItems) expect([name, getComputedStyle(menuItemIn(menu, name)).opacity]).not.toEqual([name, "0.38"]);
    });

    it("is unchanged once the replay is ready", async () => {
      const { analyzer } = renderDock();
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "ready" }));
      for (const name of dimmed) expect([name.source, isDisabled(name)]).toEqual([name.source, false]);
      expect(timelineDisabled()).toBe("false");
      const transport = screen.getByRole("button", { name: /^play replay$/i }).closest("fieldset") as HTMLElement;
      expect(getComputedStyle(transport).opacity).toBe("1");
      expect(await disabledItems([...replayItems, ...alwaysItems])).toEqual(
        [...replayItems, ...alwaysItems].map((name) => [name, false]),
      );
    });

    it("keeps the dock's height in both states", () => {
      const { analyzer, view } = renderDock();
      const dock = view.container.querySelector("fieldset") as HTMLElement;
      const ready = getComputedStyle(dock).height;
      expect(ready).toBe("86px");
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      expect(getComputedStyle(dock).height).toBe(ready);
    });

    it("keeps the outer fieldset reserved for the clip recorder", () => {
      const { analyzer, view } = renderDock();
      const outer = view.container.querySelector("fieldset") as HTMLFieldSetElement;
      act(() => analyzer.scenarioManager.loadState$.next({ phase: "idle" }));
      expect(outer.disabled).toBe(false);
    });
  });

  it("draws the shared accent focus ring on keyboard-focused dock controls", () => {
    renderDock();
    // jsdom's computed style ignores selector specificity, so check the emitted rule instead:
    // an accent-outline rule must match the control only while MUI marks it focus-visible.
    const probe = document.createElement("div");
    probe.style.outline = `2px solid ${REWIND_COLORS.focus}`; // normalised the way jsdom stores rules
    const ringMatches = (element: Element) =>
      Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules))
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
        .some(
          (rule) =>
            rule.style.outline === probe.style.outline &&
            rule.style.getPropertyValue("outline-offset") === "2px" &&
            element.matches(rule.selectorText),
        );
    for (const name of [
      /^play replay$/i,
      /^decrease viewer speed$/i,
      /^audio settings$/i,
      /^toggle hidden visualization$/i,
      /^full-map analysis$/i,
      /^settings$/i,
      /^more replay actions$/i,
    ]) {
      const control = screen.getByRole("button", { name });
      expect(ringMatches(control)).toBe(false);
      fireEvent.keyDown(document.body, { key: "Tab", code: "Tab" });
      act(() => control.focus());
      expect(control.classList.contains("Mui-focusVisible")).toBe(true);
      expect(ringMatches(control)).toBe(true);
      act(() => control.blur());
    }
  });
});
