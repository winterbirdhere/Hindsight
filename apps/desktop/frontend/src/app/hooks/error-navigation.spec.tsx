import { act, render, screen } from "@testing-library/react";
import type { ReplayAnalysisEvent } from "@osujs/core";
import { BehaviorSubject, Subject } from "rxjs";
import { useAnalysisApp } from "../providers/TheaterProvider";
import type { Incident } from "../services/analysis/incidents";
import type { ReplayError } from "../services/analysis/replay-events";
import {
  ErrorNavigationProvider,
  type ErrorNavigationState,
  useErrorNavigation,
  usePlayheadIncidentIndex,
} from "./error-navigation";
import { useGameClockControls } from "./game-clock";
import type { MissAnalysisPhase } from "../services/analysis/miss-explanation/MissAnalysisRunner";
import type { ReplayLoadState } from "../services/manager/replay-load-state";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("./game-clock", () => ({ useGameClockControls: jest.fn(), useGameClockTime: jest.fn(() => 0) }));

// The real grouper, except that a test may say how a ready analysis regroups the same errors.
let mockRegroup: ((errors: readonly ReplayError[]) => Incident[]) | undefined;
jest.mock("../services/analysis/incidents", () => {
  const actual = jest.requireActual("../services/analysis/incidents");
  return {
    ...actual,
    groupIncidents: (...args: unknown[]) =>
      (args[3] as { status?: string } | undefined)?.status === "ready" && mockRegroup
        ? mockRegroup(args[0] as readonly ReplayError[])
        : actual.groupIncidents(...args),
  };
});

const miss = (id: string, time: number, blocker?: string): ReplayAnalysisEvent =>
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

// Ready for another profile: the real cause lookup finds nothing, and the grouper mock above regroups.
const READY = { status: "ready", identity: { analysisProfileId: "lazer" } };

/** Errors 0–2 are one notelock chain (a → b, c); error 3 stands alone. */
const chain = () => [miss("a", 1_000), miss("b", 1_100, "a"), miss("c", 1_200, "a"), miss("d", 5_000)];

function setup(events: ReplayAnalysisEvent[], baseRate = 1, hasReplay = false) {
  // The viewer's own transport: speed 1 and no playback boundary, until a test says otherwise.
  const gameClock = {
    timeElapsedInMs: 0,
    seeked$: new Subject<number>(),
    isPlaying$: new BehaviorSubject(false),
    speed: 1,
    playbackBoundaryInMs: undefined as number | undefined,
    setPlaybackBoundary: jest.fn((endMs: number | undefined) => void (gameClock.playbackBoundaryInMs = endMs)),
  };
  const replayEvents$ = new BehaviorSubject(events);
  const rulesetFocus$ = new BehaviorSubject<"stable" | "lazer">("stable");
  const missExplanations$ = new BehaviorSubject<{ status: string; identity?: unknown }>({ status: "not-captured" });
  const missAnalysisProgress$ = new BehaviorSubject<MissAnalysisPhase | undefined>(undefined);
  const loadState$ = new BehaviorSubject<ReplayLoadState>({ phase: "ready" });
  const order: string[] = [];
  const controls = {
    baseRate,
    seekTo: jest.fn(() => void order.push("seek")),
    pause: jest.fn(() => void order.push("pause")),
    start: jest.fn(() => void order.push("start")),
    setSpeed: jest.fn(() => void order.push("speed")),
  };
  (useGameClockControls as jest.Mock).mockReturnValue(controls);
  const settings = { errorCauseDisplay: "concise" };
  const holder: { replay: unknown } = { replay: undefined };
  const analyzeMisses = jest.fn();
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameClock,
    scenarioManager: { loadState$ },
    replayDisplaySettingsStore: { settings, settings$: new BehaviorSubject(settings) },
    gameSimulator: {
      replayEvents$,
      rulesetFocus$,
      missExplanations$,
      missAnalysisProgress$,
      getPrimaryReplay: () => holder.replay,
      hasReplayForMissAnalysis: () => hasReplay,
      analyzeMisses,
    },
  });
  return {
    gameClock,
    replayEvents$,
    rulesetFocus$,
    missExplanations$,
    missAnalysisProgress$,
    loadState$,
    controls,
    holder,
    order,
    analyzeMisses,
  };
}

let nav: ErrorNavigationState;
let renders = 0;
function Probe() {
  renders += 1;
  nav = useErrorNavigation();
  return null;
}
let playheadRenders = 0;
function PlayheadProbe() {
  playheadRenders += 1;
  return <output>{usePlayheadIncidentIndex()}</output>;
}
let mounted: ReturnType<typeof render> | undefined;
const mount = (children = <Probe />) =>
  (mounted = render(<ErrorNavigationProvider>{children}</ErrorNavigationProvider>));
const tick = () => act(() => void jest.advanceTimersByTime(100));

beforeEach(() => {
  jest.useFakeTimers();
  renders = 0;
  playheadRenders = 0;
  mockRegroup = undefined;
});
afterEach(() => jest.useRealTimers());

describe("inspection", () => {
  it("starts analysis after load readiness and updates progress without rebuilding causes", () => {
    const f = setup(chain(), 1, true);
    f.loadState$.next({ phase: "loading" });
    mount();
    expect(f.analyzeMisses).not.toHaveBeenCalled();
    act(() => f.loadState$.next({ phase: "ready" }));
    expect(f.analyzeMisses).toHaveBeenCalledTimes(1);
    act(() => f.missExplanations$.next({ status: "building" }));
    const causes = nav.causes,
      incidents = nav.incidents;
    act(() => f.missAnalysisProgress$.next("capturing"));
    expect(nav.analysisStatus).toBe("Reading replay events…");
    expect(nav.causes).toBe(causes);
    expect(nav.incidents).toBe(incidents);
    act(() => f.missAnalysisProgress$.next("analysing"));
    expect(nav.analysisStatus).toBe("Analyzing errors…");
    expect(nav.causes).toBe(causes);
    act(() => f.missAnalysisProgress$.next("finalizing"));
    expect(nav.analysisStatus).toBe("Finishing error analysis…");
  });
  it("starts with nothing inspected, Follow on and nothing expanded", () => {
    setup(chain());
    mount();
    expect(nav.selectedIndex).toBe(-1);
    expect(nav.following).toBe(true);
    expect(nav.expanded.size).toBe(0);
    expect(nav.incidents.map((incident) => incident.errorIndices)).toEqual([[0, 1, 2], [3]]);
  });

  it("selectError inspects, pauses, seeks to the error and asks for a reveal", () => {
    const { controls, order } = setup(chain());
    mount();
    const token = nav.revealToken;
    act(() => nav.selectError(2));
    expect(nav.selectedIndex).toBe(2);
    expect(order).toEqual(["pause", "seek"]);
    expect(controls.seekTo).toHaveBeenLastCalledWith(1_200);
    expect(nav.revealToken).toBe(token + 1);
    // Out of range: nothing happens.
    act(() => nav.selectError(9));
    act(() => nav.selectError(-1));
    expect(nav.selectedIndex).toBe(2);
    expect(controls.seekTo).toHaveBeenCalledTimes(1);
    expect(nav.revealToken).toBe(token + 1);
  });

  it("selectIncident inspects the lead; a list click does not ask for a reveal", () => {
    const { controls } = setup(chain());
    mount();
    const token = nav.revealToken;
    act(() => nav.selectIncident(1));
    expect(nav.selectedIndex).toBe(3);
    expect(controls.seekTo).toHaveBeenLastCalledWith(5_000);
    expect(nav.revealToken).toBe(token + 1);
    act(() => nav.selectIncident(0, { reveal: false }));
    expect(nav.selectedIndex).toBe(0);
    expect(controls.seekTo).toHaveBeenLastCalledWith(1_000);
    expect(controls.pause).toHaveBeenCalledTimes(2);
    expect(nav.revealToken).toBe(token + 1);
    act(() => nav.selectIncident(7));
    expect(nav.selectedIndex).toBe(0);
  });

  it("keeps the inspected error through seeks and playback ticks", () => {
    const { gameClock } = setup(chain());
    mount();
    act(() => nav.selectError(1));
    const settled = renders;
    act(() => gameClock.seeked$.next(1_100));
    act(() => gameClock.seeked$.next(4_000));
    for (const time of [200, 3_000, 5_200, 9_000]) {
      gameClock.timeElapsedInMs = time;
      tick();
    }
    expect(nav.selectedIndex).toBe(1);
    // Neither a seek nor a tick re-renders the consumers.
    expect(renders).toBe(settled);
  });

  it("toggles the expansion of an incident", () => {
    setup(chain());
    mount();
    act(() => nav.toggleExpanded("miss:a"));
    expect([...nav.expanded]).toEqual(["miss:a"]);
    act(() => nav.toggleExpanded("miss:d"));
    act(() => nav.toggleExpanded("miss:a"));
    expect([...nav.expanded]).toEqual(["miss:d"]);
  });

  it("exposes one scroll store for the list across renders", () => {
    setup(chain());
    mount();
    const store = nav.listScrollTop;
    store.current = 240;
    act(() => nav.selectError(3));
    expect(nav.listScrollTop).toBe(store);
    expect(nav.listScrollTop.current).toBe(240);
  });
});

describe("Follow", () => {
  it("applies at once and tracks incident changes without seeking, pausing or revealing", () => {
    const { gameClock, controls } = setup(chain());
    mount();
    const token = nav.revealToken;
    gameClock.timeElapsedInMs = 5_500;
    act(() => nav.setFollowing(true));
    // No timer ran between turning Follow on and this assertion.
    expect(nav.following).toBe(true);
    expect(nav.selectedIndex).toBe(3);
    gameClock.timeElapsedInMs = 1_050;
    tick();
    expect(nav.selectedIndex).toBe(0);
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect(controls.start).not.toHaveBeenCalled();
    expect(nav.revealToken).toBe(token);
  });

  it("follows by incident: the members of one chain do not change the inspection or re-render", () => {
    const { gameClock } = setup(chain());
    mount();
    gameClock.timeElapsedInMs = 1_000;
    act(() => nav.setFollowing(true));
    expect(nav.selectedIndex).toBe(0);
    // React may render once more on the first equal update before it bails out.
    tick();
    const settled = renders;
    for (const time of [1_100, 1_150, 1_200, 3_000, 4_900]) {
      gameClock.timeElapsedInMs = time;
      tick();
      expect(nav.selectedIndex).toBe(0);
    }
    expect(renders).toBe(settled);
    gameClock.timeElapsedInMs = 5_000;
    tick();
    expect(nav.selectedIndex).toBe(3);
    expect(renders).toBeGreaterThan(settled);
  });

  it("follows from the start without being turned on, and inspects nothing until the playhead reaches an error", () => {
    const { gameClock, controls } = setup(chain());
    mount();
    // A fresh replay at time 0: Follow is already on, and the inspector stays in its idle state.
    expect(gameClock.timeElapsedInMs).toBe(0);
    expect(nav.following).toBe(true);
    expect(nav.selectedIndex).toBe(-1);
    tick();
    expect(nav.selectedIndex).toBe(-1);
    gameClock.timeElapsedInMs = 990;
    tick();
    expect(nav.selectedIndex).toBe(-1);
    // The first error is reached: the first incident is followed without any button press.
    gameClock.timeElapsedInMs = 1_000;
    tick();
    expect(nav.following).toBe(true);
    expect(nav.selectedIndex).toBe(0);
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
  });

  it("inspects nothing at the start when turned on late, and also nothing without errors", () => {
    const first = setup(chain());
    const view = mount();
    act(() => nav.setFollowing(false));
    act(() => nav.setFollowing(true));
    expect(first.gameClock.timeElapsedInMs).toBe(0);
    expect(nav.selectedIndex).toBe(-1);
    view.unmount();
    setup([]);
    mount();
    act(() => nav.setFollowing(true));
    expect(nav.following).toBe(true);
    expect(nav.selectedIndex).toBe(-1);
  });

  it("is turned off by a manual selection, after which playback no longer changes the inspection", () => {
    const { gameClock } = setup(chain());
    mount();
    act(() => nav.setFollowing(true));
    act(() => nav.selectError(1));
    expect(nav.following).toBe(false);
    expect(nav.selectedIndex).toBe(1);
    gameClock.timeElapsedInMs = 6_000;
    tick();
    tick();
    expect(nav.selectedIndex).toBe(1);

    act(() => nav.setFollowing(true));
    expect(nav.selectedIndex).toBe(3);
    act(() => nav.selectIncident(0, { reveal: false }));
    expect(nav.following).toBe(false);
    tick();
    expect(nav.selectedIndex).toBe(0);
  });

  describe("a step with keepFollowing", () => {
    it("leaves Follow on, and the sampler agrees with the stepped incident instead of moving the inspector", () => {
      const { gameClock, controls, order } = setup(chain());
      mount();
      gameClock.timeElapsedInMs = 1_050;
      act(() => nav.setFollowing(true));
      expect(nav.selectedIndex).toBe(0);
      const token = nav.revealToken;
      act(() => nav.selectIncident(1, { keepFollowing: true }));
      // The same step as a click: inspect the lead, pause, seek to it, ask for a reveal.
      expect(nav.selectedIndex).toBe(3);
      expect(nav.following).toBe(true);
      expect(order).toEqual(["pause", "seek"]);
      expect(controls.seekTo).toHaveBeenLastCalledWith(5_000);
      expect(nav.revealToken).toBe(token + 1);
      // The seek lands; the sampler runs on its next tick and finds the playhead at the stepped incident.
      gameClock.timeElapsedInMs = 5_000;
      tick();
      expect(nav.selectedIndex).toBe(3);
      expect(nav.following).toBe(true);
      // And back, to an incident whose later members the playhead has not reached.
      act(() => nav.selectIncident(0, { keepFollowing: true }));
      gameClock.timeElapsedInMs = 1_000;
      tick();
      expect(nav.selectedIndex).toBe(0);
      expect(nav.following).toBe(true);
      expect(controls.pause).toHaveBeenCalledTimes(2);
      expect(controls.seekTo).toHaveBeenLastCalledWith(1_000);
    });

    it("keeps following afterwards: playback past the stepped incident moves the inspector on", () => {
      const { gameClock } = setup(chain());
      mount();
      gameClock.timeElapsedInMs = 5_000;
      act(() => nav.setFollowing(true));
      act(() => nav.selectIncident(0, { keepFollowing: true }));
      gameClock.timeElapsedInMs = 1_000;
      tick();
      expect(nav.selectedIndex).toBe(0);
      gameClock.timeElapsedInMs = 5_100;
      tick();
      expect(nav.selectedIndex).toBe(3);
      expect(nav.following).toBe(true);
    });

    it("leaves Follow off when it was off", () => {
      const { gameClock } = setup(chain());
      mount();
      act(() => nav.setFollowing(false));
      act(() => nav.selectIncident(1, { keepFollowing: true }));
      expect(nav.following).toBe(false);
      expect(nav.selectedIndex).toBe(3);
      gameClock.timeElapsedInMs = 1_000;
      tick();
      expect(nav.following).toBe(false);
      expect(nav.selectedIndex).toBe(3);
    });

    it("is the only path that does: a selection without it, or an error selection, still turns Follow off", () => {
      setup(chain());
      mount();
      act(() => nav.setFollowing(true));
      act(() => nav.selectIncident(1));
      expect(nav.following).toBe(false);
      act(() => nav.setFollowing(true));
      act(() => nav.selectIncident(0, { reveal: false }));
      expect(nav.following).toBe(false);
      act(() => nav.setFollowing(true));
      act(() => nav.selectError(2));
      expect(nav.following).toBe(false);
    });

    it("settles on the later incident when two incident leads share one time (what Follow calls reached)", () => {
      const { gameClock } = setup([miss("a", 1_000), miss("b", 1_000), miss("c", 3_000)]);
      mount();
      expect(nav.incidents.map((incident) => incident.leadIndex)).toEqual([0, 1, 2]);
      gameClock.timeElapsedInMs = 3_000;
      act(() => nav.setFollowing(true));
      act(() => nav.selectIncident(0, { keepFollowing: true }));
      expect(nav.selectedIndex).toBe(0);
      gameClock.timeElapsedInMs = 1_000;
      tick();
      // Both leads are at the playhead; Follow has always shown the last one it has reached.
      expect(nav.selectedIndex).toBe(1);
      expect(nav.following).toBe(true);
    });
  });

  it("keeps the last followed incident inspected when it is turned off", () => {
    const { gameClock } = setup(chain());
    mount();
    gameClock.timeElapsedInMs = 5_100;
    act(() => nav.setFollowing(true));
    act(() => nav.setFollowing(false));
    gameClock.timeElapsedInMs = 1_000;
    tick();
    expect(nav.following).toBe(false);
    expect(nav.selectedIndex).toBe(3);
  });
});

describe("reset", () => {
  it.each(["ruleset", "events", "replay"] as const)("clears the inspection and the expansion on a new %s", (change) => {
    const { rulesetFocus$, replayEvents$, holder } = setup(chain());
    const view = mount();
    act(() => nav.selectError(2));
    act(() => nav.toggleExpanded("miss:a"));
    nav.listScrollTop.current = 300;
    act(() => {
      if (change === "ruleset") rulesetFocus$.next("lazer");
      else if (change === "events") replayEvents$.next(chain());
      else {
        holder.replay = { md5hash: "another" };
        view.rerender(
          <ErrorNavigationProvider>
            <Probe />
          </ErrorNavigationProvider>,
        );
      }
    });
    expect(nav.selectedIndex).toBe(-1);
    expect(nav.expanded.size).toBe(0);
    expect(nav.following).toBe(false);
    expect(nav.listScrollTop.current).toBe(0);
  });

  it("never renders a stale index for the new error list", () => {
    const { replayEvents$ } = setup(chain());
    const seen: Array<[number, number]> = [];
    function Recorder() {
      const state = useErrorNavigation();
      seen.push([state.errors.length, state.selectedIndex]);
      return null;
    }
    mount(
      <>
        <Probe />
        <Recorder />
      </>,
    );
    act(() => nav.selectError(3));
    act(() => replayEvents$.next([miss("z", 2_000)]));
    expect(seen.filter(([count]) => count === 1).length).toBeGreaterThan(0);
    expect(seen.filter(([count, index]) => count === 1 && index !== -1)).toEqual([]);
  });

  it("re-derives a followed inspection for the new stream instead of keeping the old index", () => {
    const { gameClock, replayEvents$ } = setup(chain());
    mount();
    gameClock.timeElapsedInMs = 5_100;
    act(() => nav.setFollowing(true));
    expect(nav.selectedIndex).toBe(3);
    // No timer runs between the new stream and the assertion.
    act(() => replayEvents$.next([miss("y", 1_000), miss("z", 2_000)]));
    expect(nav.following).toBe(true);
    expect(nav.selectedIndex).toBe(1);
  });
});

describe("regrouping after the analysis arrives", () => {
  const merged = (errors: readonly ReplayError[]): Incident[] => [
    {
      id: errors[0].id,
      errorIndices: [0, 1, 2, 3],
      leadIndex: 0,
      links: [{ from: 0, to: 3, kind: "notelock", source: "analysis" }],
    },
  ];

  it("keeps the inspected error and the expansion of incidents that still exist", () => {
    const { missExplanations$, controls } = setup([
      miss("a", 1_000),
      miss("b", 1_100, "a"),
      miss("c", 3_000),
      miss("d", 5_000),
    ]);
    mount();
    expect(nav.incidents.map((incident) => incident.id)).toEqual(["miss:a", "miss:c", "miss:d"]);
    act(() => nav.selectError(1));
    act(() => nav.toggleExpanded("miss:a"));
    act(() => nav.toggleExpanded("miss:d"));
    const errorsBefore = nav.errors;
    const token = nav.revealToken;
    controls.seekTo.mockClear();
    controls.pause.mockClear();
    mockRegroup = merged;
    act(() => missExplanations$.next(READY));
    expect(nav.errors).toBe(errorsBefore);
    expect(nav.incidents.map((incident) => incident.errorIndices)).toEqual([[0, 1, 2, 3]]);
    expect(nav.selectedIndex).toBe(1);
    expect([...nav.expanded]).toEqual(["miss:a"]);
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.pause).not.toHaveBeenCalled();
    expect(nav.revealToken).toBe(token);
  });

  it("keeps an expansion by its incident id alone, and drops the id of an incident that is gone", () => {
    const { missExplanations$ } = setup([miss("a", 1_000), miss("b", 1_100, "a"), miss("c", 3_000), miss("d", 5_000)]);
    mount();
    // The inspected error stays a lead, so nothing is opened on its behalf.
    act(() => nav.selectError(2));
    act(() => nav.toggleExpanded("miss:a"));
    act(() => nav.toggleExpanded("miss:d"));
    mockRegroup = (errors) => [
      { id: errors[0].id, errorIndices: [0, 1], leadIndex: 0, links: [] },
      {
        id: errors[2].id,
        errorIndices: [2, 3],
        leadIndex: 2,
        links: [{ from: 2, to: 3, kind: "notelock", source: "analysis" }],
      },
    ];
    act(() => missExplanations$.next(READY));
    expect(nav.selectedIndex).toBe(2);
    expect([...nav.expanded]).toEqual(["miss:a"]);
  });

  it("opens the members of a long incident that swallowed the inspected error", () => {
    const { missExplanations$ } = setup([miss("a", 1_000), miss("b", 1_100), miss("c", 3_000), miss("d", 5_000)]);
    mount();
    act(() => nav.selectError(3));
    expect(nav.expanded.size).toBe(0);
    mockRegroup = merged;
    act(() => missExplanations$.next(READY));
    // Error 3 is no longer a lead: without its member row the inspected error would be invisible.
    expect(nav.selectedIndex).toBe(3);
    expect([...nav.expanded]).toEqual(["miss:a"]);
  });

  it("leaves the expansion alone when the inspected error is still a lead", () => {
    const { missExplanations$ } = setup([miss("a", 1_000), miss("b", 1_100), miss("c", 3_000), miss("d", 5_000)]);
    mount();
    act(() => nav.selectError(0));
    mockRegroup = merged;
    act(() => missExplanations$.next(READY));
    expect(nav.selectedIndex).toBe(0);
    expect(nav.expanded.size).toBe(0);
  });
});

describe("an incident replay plays the incident once and gives the viewer's transport back", () => {
  /** Errors 0–2 are one chain at 1000, 1100 and 1200 ms; error 3 is alone at 5000 ms. */
  function replaying(index: number, speed: 0.25 | 0.5 | 1, baseRate = 1) {
    const context = setup(chain(), baseRate);
    mount();
    act(() => nav.selectError(index));
    context.gameClock.speed = 1.5; // the viewer's own speed
    context.gameClock.playbackBoundaryInMs = 90_000; // and a boundary it already had
    context.controls.setSpeed.mockClear();
    context.controls.seekTo.mockClear();
    context.gameClock.setPlaybackBoundary.mockClear();
    act(() => nav.replaySelection(speed));
    return context;
  }
  /** What the clock does when playback reaches a boundary or the user pauses: it stops at `timeMs`. */
  function stopAt(context: ReturnType<typeof setup>, timeMs: number) {
    context.gameClock.timeElapsedInMs = timeMs;
    act(() => context.gameClock.isPlaying$.next(false));
    tick();
  }

  it.each([
    // [inspected, speed, base rate, end = last error + 1200 × speed × rate]
    [0, 1, 1, 2_400], // the lead stands for its incident: its last error is at 1200
    [0, 0.5, 1, 1_800],
    [0, 0.25, 1.5, 1_650],
    [2, 1, 1, 2_400], // a member replays itself
    [1, 0.5, 1, 1_700],
    [3, 0.25, 1, 5_300],
  ] as const)("inspecting error %i at %s× and rate %s stops playback at %i ms", (index, speed, rate, end) => {
    const { gameClock } = replaying(index, speed, rate);
    expect(gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(end);
    expect(nav.replayingSpeed).toBe(speed);
  });

  it("at its end restores the viewer's speed and boundary and returns to the inspected error", () => {
    const context = replaying(1, 0.25);
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(0.25);
    stopAt(context, 1_400);
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(1.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(90_000);
    expect(context.controls.seekTo).toHaveBeenLastCalledWith(1_100);
    expect(context.controls.start).toHaveBeenCalledTimes(1);
    expect(nav.replayingSpeed).toBeUndefined();
    expect(nav.selectedIndex).toBe(1);
  });

  it("a pause before its end gives the speed and boundary back and leaves the playhead where it is", () => {
    const context = replaying(3, 0.5);
    const seeks = context.controls.seekTo.mock.calls.length;
    stopAt(context, 4_900);
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(1.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(90_000);
    expect(context.controls.seekTo).toHaveBeenCalledTimes(seeks);
    expect(nav.replayingSpeed).toBeUndefined();
  });

  it("a seek during it ends it the same way, without another seek", () => {
    const context = replaying(3, 0.5);
    const seeks = context.controls.seekTo.mock.calls.length;
    act(() => context.gameClock.seeked$.next(20_000));
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(1.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(90_000);
    expect(context.controls.seekTo).toHaveBeenCalledTimes(seeks);
    expect(nav.replayingSpeed).toBeUndefined();
    // The stop that follows later belongs to ordinary playback: nothing more is restored or sought.
    const speeds = context.controls.setSpeed.mock.calls.length;
    stopAt(context, 21_000);
    expect(context.controls.setSpeed).toHaveBeenCalledTimes(speeds);
    expect(context.controls.seekTo).toHaveBeenCalledTimes(seeks);
  });

  it("never loses the viewer's speed when one replay is started over another", () => {
    const context = replaying(3, 0.25);
    act(() => nav.replaySelection(0.5));
    expect(nav.replayingSpeed).toBe(0.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(5_600);
    stopAt(context, 5_600);
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(1.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(90_000);
  });

  it("gives the transport back when the panel goes away mid-replay", () => {
    const context = replaying(3, 0.25);
    mounted?.unmount();
    expect(context.controls.setSpeed).toHaveBeenLastCalledWith(1.5);
    expect(context.gameClock.setPlaybackBoundary).toHaveBeenLastCalledWith(90_000);
  });

  it("does not mark a speed while nothing is being replayed", () => {
    setup(chain());
    mount();
    expect(nav.replayingSpeed).toBeUndefined();
    act(() => nav.replaySelection(1));
    expect(nav.replayingSpeed).toBeUndefined();
  });
});

describe("replaySelection(speed)", () => {
  const SPEEDS = [0.25, 0.5, 1] as const;

  it.each(SPEEDS)("does nothing at %s× with no inspected error", (speed) => {
    const { controls } = setup(chain());
    mount();
    act(() => nav.replaySelection(speed));
    expect(controls.setSpeed).not.toHaveBeenCalled();
    expect(controls.seekTo).not.toHaveBeenCalled();
    expect(controls.start).not.toHaveBeenCalled();
  });

  it.each(
    SPEEDS.flatMap((speed) =>
      [
        // [baseRate, error index, error time, lead-in in map ms = 1500 × speed × baseRate, expected start]
        [1, 3, 5_000],
        [1.5, 3, 5_000],
        [1, 2, 1_200],
        [1.5, 0, 1_000],
      ].map(([rate, index, time]) => [speed, rate, index, time, Math.max(0, time - 1_500 * speed * rate)] as const),
    ),
  )(
    "at %s× and rate %s sets the speed, seeks 1.5 s of real time before error %i (%i ms) and starts",
    (speed, rate, index, time, expected) => {
      const { controls, order } = setup(chain(), rate);
      mount();
      act(() => nav.selectError(index));
      order.length = 0;
      controls.seekTo.mockClear();
      act(() => nav.replaySelection(speed));
      expect(controls.setSpeed).toHaveBeenCalledTimes(1);
      expect(controls.setSpeed).toHaveBeenCalledWith(speed);
      expect(controls.seekTo).toHaveBeenCalledTimes(1);
      expect(controls.seekTo).toHaveBeenLastCalledWith(expected);
      expect(expected).toBe(Math.max(0, time - 1_500 * speed * rate));
      expect(order).toEqual(["speed", "seek", "start"]);
      expect(controls.pause).toHaveBeenCalledTimes(1);
      expect(nav.selectedIndex).toBe(index);
    },
  );

  it.each([
    [0.25, 1, 4_625],
    [0.5, 1, 4_250],
    [1, 1, 3_500],
    [0.25, 1.5, 4_437.5],
    [0.5, 1.5, 3_875],
    [1, 1.5, 2_750],
  ])("starts a replay of error 3 (5 000 ms) at %s× and rate %s at %s ms", (speed, rate, expected) => {
    const { controls } = setup(chain(), rate);
    mount();
    act(() => nav.selectError(3));
    act(() => nav.replaySelection(speed as 0.25 | 0.5 | 1));
    expect(controls.seekTo).toHaveBeenLastCalledWith(expected);
  });

  it.each(SPEEDS)("clamps the start at 0 at %s× when the error is within the lead-in of the beginning", (speed) => {
    const { controls } = setup([miss("a", 100), miss("z", 5_000)], 1.5);
    mount();
    act(() => nav.selectError(0));
    act(() => nav.replaySelection(speed));
    expect(controls.seekTo).toHaveBeenLastCalledWith(0);
  });

  it("starts from the incident's first error for the lead, and from the member itself otherwise", () => {
    const { controls } = setup([miss("a", 2_000), miss("b", 3_000, "a"), miss("c", 3_200, "a")]);
    mount();
    // The lead (error 0) stands for its incident.
    act(() => nav.selectError(0));
    act(() => nav.replaySelection(1));
    expect(controls.seekTo).toHaveBeenLastCalledWith(500);
    act(() => nav.replaySelection(0.5));
    expect(controls.seekTo).toHaveBeenLastCalledWith(1_250);
    // A member replays itself.
    act(() => nav.selectError(2));
    act(() => nav.replaySelection(1));
    expect(controls.seekTo).toHaveBeenLastCalledWith(1_700);
    expect(nav.selectedIndex).toBe(2);
  });

  it("keeps a followed inspection by turning Follow off", () => {
    const { gameClock, controls } = setup(chain());
    mount();
    gameClock.timeElapsedInMs = 5_000;
    act(() => nav.setFollowing(true));
    act(() => nav.replaySelection(0.25));
    expect(controls.setSpeed).toHaveBeenCalledWith(0.25);
    expect(controls.seekTo).toHaveBeenLastCalledWith(4_625);
    // The playhead is now before the incident; with Follow still on the panel would jump to the chain.
    gameClock.timeElapsedInMs = 4_625;
    tick();
    expect(nav.following).toBe(false);
    expect(nav.selectedIndex).toBe(3);
  });
});

describe("usePlayheadIncidentIndex", () => {
  const shown = () => Number(screen.getByRole("status").textContent);

  it("re-renders its caller only when the incident at the playhead changes", () => {
    const { gameClock } = setup(chain());
    mount(<PlayheadProbe />);
    // Before the first error is reached, playback is at no incident.
    expect(shown()).toBe(-1);
    gameClock.timeElapsedInMs = 500;
    tick();
    expect(shown()).toBe(-1);
    gameClock.timeElapsedInMs = 1_000;
    tick();
    expect(shown()).toBe(0);
    tick();
    const settled = playheadRenders;
    // Inside the chain, and up to the next incident: the same incident, no re-render.
    for (const time of [1_050, 1_100, 1_200, 3_000, 4_900]) {
      gameClock.timeElapsedInMs = time;
      tick();
    }
    expect(shown()).toBe(0);
    expect(playheadRenders).toBe(settled);

    gameClock.timeElapsedInMs = 5_000;
    tick();
    expect(shown()).toBe(1);
    expect(playheadRenders).toBeGreaterThan(settled);
    gameClock.timeElapsedInMs = 6_000;
    tick();
    const afterChange = playheadRenders;
    for (const time of [7_000, 8_000, 9_000]) {
      gameClock.timeElapsedInMs = time;
      tick();
    }
    expect(playheadRenders).toBe(afterChange);
    // Seeking back is followed too.
    gameClock.timeElapsedInMs = 1_150;
    tick();
    expect(shown()).toBe(0);
  });

  it("is independent of the inspected error", () => {
    const { gameClock } = setup(chain());
    mount(
      <>
        <Probe />
        <PlayheadProbe />
      </>,
    );
    gameClock.timeElapsedInMs = 5_200;
    tick();
    act(() => nav.selectError(0));
    expect(nav.selectedIndex).toBe(0);
    expect(shown()).toBe(1);
  });

  it("derives the index at once when the incidents change, and is -1 with no errors", () => {
    const { gameClock, replayEvents$ } = setup([]);
    mount(<PlayheadProbe />);
    expect(shown()).toBe(-1);
    gameClock.timeElapsedInMs = 6_000;
    // No timer runs between the new list and the assertion.
    act(() => replayEvents$.next(chain()));
    expect(shown()).toBe(1);
  });
});

describe("M61 automatic analysis", () => {
  it("starts once and is not restarted by selecting, following, expanding or replaying", () => {
    const { analyzeMisses } = setup(chain(), 1, true);
    mount();
    expect(analyzeMisses).toHaveBeenCalledTimes(1);
    act(() => nav.selectError(1));
    act(() => nav.setFollowing(true));
    act(() => nav.toggleExpanded("miss:a"));
    act(() => nav.replaySelection(1));
    tick();
    expect(analyzeMisses).toHaveBeenCalledTimes(1);
  });
});
