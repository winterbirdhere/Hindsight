import "reflect-metadata";
import { render, act } from "@testing-library/react";
import { StrictMode } from "react";
import { BehaviorSubject } from "rxjs";
import { InspectorProvider, useInspector, type InspectorState } from "../providers/InspectorProvider";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { ClipExportSettingsStore, type ClipExportSettings } from "../services/analysis/clip-export-settings";
import { GameplayClock } from "../services/common/game/GameplayClock";
import type { ClipRange } from "../services/manager/clip-range";
import { useClipExportRange, useClipExportTransport, useTransportToggle } from "./clip-export";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));

const DURATION = 100_000;
const RANGE: ClipRange = { startMs: 62_000, endMs: 70_000 };

interface Seen {
  inspector: InspectorState;
  range: ReturnType<typeof useClipExportRange>;
  toggle: () => void;
}

interface SetupOptions {
  time?: number;
  playing?: boolean;
  speed?: number;
  baseRate?: number;
  /** The clip speed already saved in the clip store; absent keeps the store's default. */
  clipSpeed?: number;
}

/** The smallest app the hooks need: a real clock, a replay identity that follows `replayEvents$`, a recorder flag. */
function setup({ time = 5_000, playing = false, speed = 1, baseRate = 1, clipSpeed }: SetupOptions = {}) {
  const clock = new GameplayClock();
  clock.setDuration(DURATION);
  clock.setBaseRate(baseRate);
  clock.setSpeed(speed);
  clock.seekTo(time);
  if (playing) clock.start();
  let replay: object | undefined = { name: "replay A" };
  const replayEvents$ = new BehaviorSubject<unknown[]>([]);
  const clipExportSettingsStore = new ClipExportSettingsStore();
  if (clipSpeed !== undefined) clipExportSettingsStore.changeSettings((draft) => void (draft.speed = clipSpeed));
  const app = {
    gameClock: clock,
    clipExportSettingsStore,
    gameSimulator: { replayEvents$, getPrimaryReplay: jest.fn(() => replay) },
    clipRecorder: {
      isBusy: false,
      state$: new BehaviorSubject<{ status: string; progress: number }>({ status: "idle", progress: 0 }),
    },
  };
  (useAnalysisApp as jest.Mock).mockReturnValue(app);

  const seen = {} as Seen;
  function Probe() {
    useClipExportTransport();
    seen.inspector = useInspector();
    seen.range = useClipExportRange();
    seen.toggle = useTransportToggle();
    return null;
  }
  const spies = {
    pause: jest.spyOn(clock, "pause"),
    start: jest.spyOn(clock, "start"),
    seekTo: jest.spyOn(clock, "seekTo"),
    setSpeed: jest.spyOn(clock, "setSpeed"),
    setPlaybackBoundary: jest.spyOn(clock, "setPlaybackBoundary"),
    toggle: jest.spyOn(clock, "toggle"),
  };
  const clearSpies = () => Object.values(spies).forEach((spy) => spy.mockClear());
  const tree = (locked: boolean) => (
    <InspectorProvider locked={locked}>
      <Probe />
    </InspectorProvider>
  );
  const view = (strict = false) => {
    const wrap = (locked: boolean) => (strict ? <StrictMode>{tree(locked)}</StrictMode> : tree(locked));
    const rendered = render(wrap(false));
    return { ...rendered, setLocked: (locked: boolean) => rendered.rerender(wrap(locked)) };
  };
  const changeReplay = (next: object | undefined) => {
    replay = next;
    act(() => replayEvents$.next([]));
  };
  /**
   * What a real clear does, in the real order: the simulator emits while the old replay is still there, the clock is
   * cleared, the replay is dropped, and React renders. Nothing emits again. `replaceReplay` then loads another replay,
   * which emits much later, once the new replay is simulated.
   */
  const clearReplay = () => {
    act(() => {
      replayEvents$.next([]);
      clock.clear();
      replay = undefined;
    });
  };
  const replaceReplay = (next: object) => {
    clearReplay();
    act(() => {
      replay = next;
      replayEvents$.next([]);
    });
  };
  /** Moves the recorder to a status the way ClipRecorder does: the flag follows the state it emits. */
  const setRecorder = (status: string) => {
    act(() => {
      app.clipRecorder.isBusy = ["preparing", "recording", "rendering", "saving"].includes(status);
      app.clipRecorder.state$.next({ status, progress: 0 });
    });
  };
  const store = clipExportSettingsStore;
  return { clock, app, store, seen, spies, clearSpies, view, changeReplay, clearReplay, replaceReplay, setRecorder };
}

const openExport = (seen: Seen, range: ClipRange | null = RANGE) => {
  act(() => seen.inspector.setExportRange(range));
  act(() => seen.inspector.openExport());
};

describe("useClipExportRange", () => {
  it("resolves no range to the whole replay and clamps a stored range to the replay", () => {
    const { seen, view, clock } = setup();
    view();
    expect(seen.inspector.exportRange).toBeNull();
    expect(seen.range.range).toEqual({ startMs: 0, endMs: DURATION });
    expect(seen.range.durationMs).toBe(DURATION);

    act(() => seen.inspector.setExportRange(RANGE));
    expect(seen.range.range).toEqual(RANGE);

    // A range that sticks out of the replay is clamped when read...
    act(() => seen.inspector.setExportRange({ startMs: -5_000, endMs: 500_000 }));
    expect(seen.range.range).toEqual({ startMs: 0, endMs: DURATION });

    // ...and a range set through the hook is stored already normalized.
    act(() => seen.range.setRange({ startMs: 1_000.4, endMs: 90_000.6 }));
    expect(seen.inspector.exportRange).toEqual({ startMs: 1_000, endMs: 90_000.6 });
    act(() => seen.range.setRange({ startMs: 10_000, endMs: 900_000 }));
    expect(seen.inspector.exportRange).toEqual({ startMs: 10_000, endMs: DURATION });

    // A shorter replay clamps a stored range too.
    act(() => seen.inspector.setExportRange(RANGE));
    act(() => clock.setDuration(65_000));
    expect(seen.range.durationMs).toBe(65_000);
    expect(seen.range.range).toEqual({ startMs: 62_000, endMs: 65_000 });
  });

  it("reports the playback rate as the replay's rate times the clock's speed", () => {
    const { seen, view, clock } = setup({ baseRate: 1.5, speed: 0.5 });
    view();
    expect(seen.range.playbackRate).toBe(0.75);
    act(() => clock.setSpeed(1));
    expect(seen.range.playbackRate).toBe(1.5);
  });
});

describe("useClipExportTransport", () => {
  it("enters the preview when Export opens and restores the transport when it closes", () => {
    const { seen, view, clock } = setup({ time: 5_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    expect(clock.isPlaying).toBe(false);
    expect(clock.playbackBoundaryInMs).toBe(70_000);
    expect(clock.timeElapsedInMs).toBe(62_000);

    act(() => seen.inspector.closeMode());
    expect(clock.isPlaying).toBe(true);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.timeElapsedInMs).toBe(5_000);
    expect(clock.speed).toBe(0.5);
  });

  it("does not start playback on closing when the viewer had paused", () => {
    const { seen, view, clock, spies } = setup({ time: 65_000, playing: false });
    view();
    openExport(seen);
    expect(clock.timeElapsedInMs).toBe(65_000);
    act(() => seen.inspector.closeExport());
    expect(spies.start).not.toHaveBeenCalled();
    expect(clock.isPlaying).toBe(false);
    expect(clock.timeElapsedInMs).toBe(65_000);
  });

  it("enters once per session even under StrictMode", () => {
    const { seen, view, spies } = setup({ time: 5_000 });
    view(true);
    openExport(seen);
    expect(spies.setPlaybackBoundary).toHaveBeenCalledTimes(1);
    expect(spies.setPlaybackBoundary).toHaveBeenCalledWith(70_000);
    expect(spies.seekTo).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview while Settings is open from Export", () => {
    const { seen, view, clock, spies, clearSpies } = setup({ time: 5_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    clearSpies();
    act(() => seen.inspector.openSettings({ tab: "display", target: "clip" }));
    expect(seen.inspector.mode).toBe("settings");
    expect(seen.inspector.exportSession).toBe(true);
    act(() => seen.inspector.closeSettings());
    expect(seen.inspector.mode).toBe("export");
    // Neither a leave nor a second enter touched the clock.
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.speed).toBe(1);
    expect(clock.playbackBoundaryInMs).toBe(70_000);
    expect(clock.timeElapsedInMs).toBe(62_000);

    // The session still ends once, with the viewer's transport.
    act(() => seen.inspector.closeExport());
    expect(clock.speed).toBe(0.5);
    expect(clock.isPlaying).toBe(true);
    expect(clock.timeElapsedInMs).toBe(5_000);
  });

  it("leaves the preview when Settings, opened from Export, is closed with the export session", () => {
    const { seen, view, clock } = setup({ time: 5_000, speed: 0.5 });
    view();
    openExport(seen);
    act(() => seen.inspector.openSettings());
    act(() => seen.inspector.closeMode());
    expect(seen.inspector.exportSession).toBe(false);
    expect(clock.speed).toBe(0.5);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.timeElapsedInMs).toBe(5_000);
  });

  it("starts the clip at 1× whatever the viewer speed is, and gives the viewer its speed back", () => {
    const { seen, view, clock } = setup({ speed: 0.5 });
    view();
    expect(clock.speed).toBe(0.5);
    openExport(seen);
    expect(clock.speed).toBe(1);
    expect(seen.range.playbackRate).toBe(1);
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(0.5);
  });

  it("starts the session at the stored clip speed whatever the viewer's speed is", () => {
    const { seen, view, clock } = setup({ speed: 0.5, clipSpeed: 0.75 });
    view();
    expect(clock.speed).toBe(0.5);
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    expect(seen.range.playbackRate).toBe(0.75);
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(0.5);
  });

  it("writes a speed chosen in a session to the clip store at once, and only when it differs", () => {
    const { seen, view, clock, store } = setup({ speed: 1.25 });
    view();
    const changes = jest.spyOn(store, "changeSettings");
    openExport(seen);
    expect(clock.speed).toBe(1);
    // Entering sets the stored speed on the clock; that is not a change.
    expect(changes).not.toHaveBeenCalled();

    // The speed stepper and the up and down arrows both go through the clock.
    act(() => clock.setSpeed(0.75));
    expect(store.settings.speed).toBe(0.75);
    expect(changes).toHaveBeenCalledTimes(1);
    act(() => clock.setSpeed(0.75));
    expect(changes).toHaveBeenCalledTimes(1);
    act(() => clock.setSpeed(1.5));
    expect(store.settings.speed).toBe(1.5);
    expect(changes).toHaveBeenCalledTimes(2);

    // Leaving gives the viewer's speed back without storing it.
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(1.25);
    expect(store.settings.speed).toBe(1.5);
    expect(changes).toHaveBeenCalledTimes(2);
    // A viewer speed change outside a session is the viewer's, never the clip's.
    act(() => clock.setSpeed(2));
    expect(store.settings.speed).toBe(1.5);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("does not write the viewer's speed that comes back on leaving", () => {
    const { seen, view, clock, store } = setup({ speed: 0.5, clipSpeed: 0.75 });
    view();
    openExport(seen);
    const changes = jest.spyOn(store, "changeSettings");
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(0.5);
    expect(changes).not.toHaveBeenCalled();
    expect(store.settings.speed).toBe(0.75);
  });

  it("keeps the clip speed for the next session, another replay and a remount with the same store", () => {
    const { seen, view, clock, store, changeReplay, replaceReplay } = setup({ speed: 1.25 });
    const first = view();
    openExport(seen);
    act(() => clock.setSpeed(0.75));
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(1.25);

    openExport(seen);
    expect(clock.speed).toBe(0.75);
    act(() => seen.inspector.closeMode());

    // Another replay: no session open, then one opened on it.
    changeReplay({ name: "replay B" });
    expect(store.settings.speed).toBe(0.75);
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    act(() => seen.inspector.closeMode());

    // The real order of a replay swap resets the clock's own speed to 1; the clip speed is untouched.
    replaceReplay({ name: "replay C" });
    expect(store.settings.speed).toBe(0.75);
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    act(() => seen.inspector.closeMode());

    // Unmounted and mounted again with the same store (the next run of Rewind loads it from storage).
    first.unmount();
    clock.setSpeed(1.5);
    view();
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    expect(store.settings.speed).toBe(0.75);
  });

  it("keeps the clip speed when another replay replaces the one an open session was entered on", () => {
    const { seen, view, clock, store, replaceReplay } = setup({ speed: 1.25, clipSpeed: 0.75 });
    view();
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    // The clock's clear resets its speed to 1 while the session's replay is still the primary one.
    replaceReplay({ name: "replay B" });
    expect(seen.inspector.exportSession).toBe(false);
    expect(store.settings.speed).toBe(0.75);

    openExport(seen);
    expect(clock.speed).toBe(0.75);
  });

  it("keeps the clip speed when the replay is cleared during a session", () => {
    const { seen, view, store, clearReplay } = setup({ clipSpeed: 0.75 });
    view();
    openExport(seen);
    clearReplay();
    expect(seen.inspector.exportSession).toBe(false);
    expect(store.settings.speed).toBe(0.75);
  });

  it("resolution, frame rate and speed survive another replay being loaded", () => {
    const { seen, view, clock, store, replaceReplay } = setup();
    view();
    store.changeSettings((draft) => {
      draft.width = 2560;
      draft.fps = 120;
    });
    openExport(seen);
    act(() => clock.setSpeed(0.75));
    replaceReplay({ name: "replay B" });
    expect(seen.inspector.exportSession).toBe(false);
    expect(store.settings).toMatchObject({ width: 2560, fps: 120, speed: 0.75 });
    openExport(seen);
    expect(clock.speed).toBe(0.75);
    expect(store.settings).toMatchObject({ width: 2560, fps: 120, speed: 0.75 });
  });

  it("does not write a speed change made while the recorder is busy", () => {
    const { seen, view, clock, store, setRecorder } = setup({ clipSpeed: 0.75 });
    view();
    openExport(seen);
    const changes = jest.spyOn(store, "changeSettings");
    setRecorder("recording");
    act(() => clock.setSpeed(2));
    expect(store.settings.speed).toBe(0.75);
    expect(changes).not.toHaveBeenCalled();
    // Not busy again: the next change counts.
    setRecorder("done");
    act(() => clock.setSpeed(1.5));
    expect(store.settings.speed).toBe(1.5);
  });

  it.each([
    ["has no speed", undefined],
    ["has a speed that is not one of the steps", 7],
  ])("enters at 1x when the saved clip store %s", (_name, saved) => {
    const { seen, view, clock, store } = setup({ speed: 0.5 });
    const { speed: _dropped, ...withoutSpeed } = store.settings;
    store.settings = (saved === undefined ? withoutSpeed : { ...withoutSpeed, speed: saved }) as ClipExportSettings;
    view();
    openExport(seen);
    expect(clock.speed).toBe(1);
    act(() => seen.inspector.closeMode());
    expect(clock.speed).toBe(0.5);
  });

  it("moves the playhead with an edited bound", () => {
    const { seen, view, clock } = setup({ time: 5_000, playing: true });
    view();
    openExport(seen);

    act(() => seen.range.setRange({ startMs: 63_000, endMs: 70_000 }));
    expect(clock.isPlaying).toBe(false);
    expect(clock.timeElapsedInMs).toBe(63_000);
    expect(clock.playbackBoundaryInMs).toBe(70_000);

    act(() => seen.range.setRange({ startMs: 63_000, endMs: 69_000 }));
    expect(clock.timeElapsedInMs).toBe(69_000);
    expect(clock.playbackBoundaryInMs).toBe(69_000);
  });

  it("does not touch the playhead when a range edit leaves the range as it was", () => {
    const { seen, view, clock, clearSpies, spies } = setup({ time: 5_000 });
    view();
    openExport(seen);
    act(() => clock.seekTo(66_000));
    clearSpies();
    act(() => seen.range.setRange({ ...RANGE }));
    expect(spies.seekTo).not.toHaveBeenCalled();
    expect(clock.timeElapsedInMs).toBe(66_000);
  });

  it("does not restart playback on unmount", () => {
    const { seen, view, clock, spies, clearSpies } = setup({ time: 5_000, playing: true, speed: 0.5 });
    const { unmount } = view();
    openExport(seen);
    clearSpies();
    unmount();
    expect(spies.start).not.toHaveBeenCalled();
    expect(clock.isPlaying).toBe(false);
    // Position and settings still come back.
    expect(clock.timeElapsedInMs).toBe(5_000);
    expect(clock.speed).toBe(0.5);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
  });

  it("does nothing on unmount when no session was open", () => {
    const { view, clock, spies, clearSpies } = setup({ time: 5_000, playing: true });
    const { unmount } = view();
    clearSpies();
    unmount();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.isPlaying).toBe(true);
  });

  it("closes Export and clears the range when another replay is loaded, leaving its transport alone", () => {
    const { seen, view, clock, spies, clearSpies, changeReplay } = setup({ time: 5_000, playing: true });
    view();
    openExport(seen);
    expect(seen.inspector.exportRange).toEqual(RANGE);
    // The new replay has its own transport; whatever it is now must survive.
    act(() => clock.seekTo(1_234));
    clearSpies();

    changeReplay({ name: "replay B" });
    expect(seen.inspector.mode).toBe("incidents");
    expect(seen.inspector.exportSession).toBe(false);
    expect(seen.inspector.exportRange).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.timeElapsedInMs).toBe(1_234);
    // Not restored to the old replay's viewer state either: it is the clock exactly as the change found it.
    expect(clock.playbackBoundaryInMs).toBe(70_000);
    expect(clock.speed).toBe(1);
  });

  it("clears the range on another replay even with no session open, and does not touch the clock", () => {
    const { seen, view, spies, clearSpies, changeReplay } = setup();
    view();
    act(() => seen.inspector.setExportRange(RANGE));
    clearSpies();
    changeReplay({ name: "replay B" });
    expect(seen.inspector.exportRange).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("ignores a ruleset-style re-emission for the same replay", () => {
    const { seen, view, changeReplay, app } = setup();
    view();
    openExport(seen);
    const same = app.gameSimulator.getPrimaryReplay();
    changeReplay(same);
    expect(seen.inspector.exportSession).toBe(true);
    expect(seen.inspector.exportRange).toEqual(RANGE);
  });

  it("leaves the clock alone while the recorder is busy", () => {
    const { seen, view, app, spies, clearSpies, clock } = setup({ time: 66_000 });
    view();

    // A session that opens while the recorder is busy is not entered.
    app.clipRecorder.isBusy = true;
    openExport(seen);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.speed).toBe(1);
    act(() => seen.inspector.closeMode());
    app.clipRecorder.isBusy = false;

    // A running session ignores edits and toggles while the recorder is busy.
    openExport(seen);
    clearSpies();
    app.clipRecorder.isBusy = true;
    act(() => seen.range.setRange({ startMs: 63_000, endMs: 69_000 }));
    act(() => seen.toggle());
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.isPlaying).toBe(false);

    // The ordinary toggle is refused too.
    app.clipRecorder.isBusy = false;
    act(() => seen.inspector.closeMode());
    clearSpies();
    app.clipRecorder.isBusy = true;
    act(() => seen.toggle());
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });
});

describe("useTransportToggle", () => {
  it("toggles the clip preview in a session and the clock outside one", () => {
    const { seen, view, clock, spies, clearSpies } = setup({ time: 30_000 });

    view();
    // Outside a session: the ordinary toggle, with no boundary and the playhead where it is.
    act(() => seen.toggle());
    expect(spies.toggle).toHaveBeenCalledTimes(1);
    expect(clock.isPlaying).toBe(true);
    expect(clock.timeElapsedInMs).toBe(30_000);
    expect(spies.setPlaybackBoundary).not.toHaveBeenCalled();
    act(() => seen.toggle());
    expect(clock.isPlaying).toBe(false);

    // In a session: the preview, bounded to the range.
    openExport(seen);
    clearSpies();
    expect(clock.timeElapsedInMs).toBe(62_000);
    act(() => seen.toggle());
    expect(spies.toggle).not.toHaveBeenCalled();
    expect(clock.isPlaying).toBe(true);
    expect(clock.playbackBoundaryInMs).toBe(70_000);
    expect(clock.timeElapsedInMs).toBe(62_000);
    act(() => seen.toggle());
    expect(clock.isPlaying).toBe(false);

    // A preview that reached the end plays again from the start.
    act(() => clock.seekTo(70_000));
    act(() => seen.toggle());
    expect(clock.isPlaying).toBe(true);
    expect(clock.timeElapsedInMs).toBe(62_000);
    act(() => seen.toggle());

    // Back outside the session the ordinary toggle returns.
    act(() => seen.inspector.closeMode());
    clearSpies();
    act(() => seen.toggle());
    expect(spies.toggle).toHaveBeenCalledTimes(1);
  });
});

describe("useClipExportTransport when the replay goes away", () => {
  const MOVED = ["seekTo", "start", "setSpeed", "setPlaybackBoundary"] as const;

  it("does not put a boundary on the cleared clock when the replay is cleared during a session", () => {
    const { seen, view, clock, clearReplay } = setup({ time: 90_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    expect(clock.playbackBoundaryInMs).toBe(70_000);

    clearReplay();
    expect(clock.durationInMs).toBe(1);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.isPlaying).toBe(false);
    expect(seen.inspector.exportSession).toBe(false);
    expect(seen.inspector.mode).toBe("incidents");
    expect(seen.inspector.exportRange).toBeNull();
    // The whole-replay range is now {0, 1}; nothing follows it onto the cleared clock.
    expect(seen.range.range).toEqual({ startMs: 0, endMs: 1 });
    expect(clock.playbackBoundaryInMs).toBeUndefined();
  });

  it("ends the session when the simulator only emitted before it dropped the replay", async () => {
    const { seen, view, clock, spies, clearSpies, app } = setup({ time: 5_000, playing: true });
    view();
    openExport(seen);
    clearSpies();
    // The one emission arrives while getPrimaryReplay() still returns the old replay; the replay then goes, silently.
    act(() => app.gameSimulator.replayEvents$.next([]));
    expect(seen.inspector.exportSession).toBe(true);
    (app.gameSimulator.getPrimaryReplay as jest.Mock).mockReturnValue(undefined);
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen.inspector.exportSession).toBe(false);
    expect(seen.inspector.exportRange).toBeNull();
    for (const name of MOVED) expect(spies[name]).not.toHaveBeenCalled();
    expect(clock.playbackBoundaryInMs).toBe(70_000);
  });

  it("does not restore the old replay's transport onto a new replay", () => {
    const { seen, view, clock, spies, clearSpies, replaceReplay } = setup({ time: 90_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    clearSpies();

    replaceReplay({ name: "replay B" });
    // The load of the new replay leaves its own transport behind.
    act(() => {
      clock.setDuration(80_000);
      clock.speed = 1.5;
    });
    clearSpies();
    act(() => seen.inspector.closeMode());
    for (const name of MOVED) expect(spies[name]).not.toHaveBeenCalled();
    expect(clock.speed).toBe(1.5);
    expect(clock.isPlaying).toBe(false);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.timeElapsedInMs).toBe(0);
    expect(seen.inspector.exportSession).toBe(false);
  });

  it("closing Export after the replay was cleared touches nothing", () => {
    const { seen, view, clock, spies, clearSpies, app } = setup({ time: 90_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    clearSpies();
    // The replay goes away with no event reaching the hook; the user closes Export in the same tick.
    act(() => {
      clock.clear();
      (app.gameSimulator.getPrimaryReplay as jest.Mock).mockReturnValue(undefined);
      seen.inspector.closeExport();
    });
    for (const name of MOVED) expect(spies[name]).not.toHaveBeenCalled();
    expect(clock.speed).toBe(1);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.isPlaying).toBe(false);
    expect(clock.timeElapsedInMs).toBe(0);
  });

  it("leaves ordinary Settings open when a replay loads", () => {
    const { seen, view, replaceReplay } = setup();
    view();
    act(() => seen.inspector.openSettings({ tab: "display" }));
    expect(seen.inspector.exportSession).toBe(false);
    replaceReplay({ name: "replay B" });
    expect(seen.inspector.mode).toBe("settings");
    expect(seen.inspector.settingsTab).toBe("display");
  });

  it("still resets the range then, and leaves the clip speed alone", () => {
    const { seen, view, clock, store, replaceReplay } = setup({ speed: 1.25 });
    view();
    openExport(seen);
    act(() => clock.setSpeed(0.75));
    act(() => seen.inspector.closeMode());
    act(() => seen.inspector.setExportRange(RANGE));
    act(() => seen.inspector.openSettings());
    expect(seen.inspector.exportSession).toBe(false);

    replaceReplay({ name: "replay B" });
    expect(seen.inspector.mode).toBe("settings");
    expect(seen.inspector.exportRange).toBeNull();
    expect(store.settings.speed).toBe(0.75);

    act(() => seen.inspector.openExport());
    expect(clock.speed).toBe(0.75);
  });

  it("closes a session whose replay changed during an export once the lock is released", () => {
    const { seen, view, replaceReplay, clock, spies, clearSpies } = setup({ time: 5_000, speed: 0.5 });
    const { setLocked } = view();
    openExport(seen);
    act(() => setLocked(true));

    replaceReplay({ name: "replay B" });
    // closeMode and setExportRange were ignored while locked.
    expect(seen.inspector.mode).toBe("export");
    expect(seen.inspector.exportRange).toEqual(RANGE);
    expect(clock.playbackBoundaryInMs).toBeUndefined();

    clearSpies();
    act(() => setLocked(false));
    expect(seen.inspector.mode).toBe("incidents");
    expect(seen.inspector.exportSession).toBe(false);
    expect(seen.inspector.exportRange).toBeNull();
    for (const name of MOVED) expect(spies[name]).not.toHaveBeenCalled();
  });
});

describe("useClipExportTransport while the recorder is busy", () => {
  it("restores the viewer after an export that was cancelled by leaving the analyzer", () => {
    const { seen, view, clock, spies, clearSpies, setRecorder } = setup({ time: 5_000, playing: true, speed: 0.5 });
    const { unmount } = view();
    openExport(seen);
    expect(clock.speed).toBe(1);
    setRecorder("recording");
    clearSpies();

    unmount();
    // Nothing is touched while the recorder still owns the transport.
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    expect(clock.speed).toBe(1);

    // The recorder restores what it saw at export start, then reports its outcome last.
    clock.pause();
    clock.setPlaybackBoundary(70_000);
    clock.seekTo(66_000);
    clearSpies();
    setRecorder("cancelled");
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.speed).toBe(0.5);
    expect(clock.timeElapsedInMs).toBe(5_000);
    expect(clock.isPlaying).toBe(false);
    expect(spies.start).not.toHaveBeenCalled();

    // The deferred leave runs once: later recorder states do not touch the clock again.
    act(() => clock.setSpeed(2));
    clearSpies();
    setRecorder("idle");
    expect(clock.speed).toBe(2);
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it("does not restore after the deferred leave if the replay changed meanwhile", () => {
    const { seen, view, clock, spies, clearSpies, setRecorder, app } = setup({
      time: 5_000,
      playing: true,
      speed: 0.5,
    });
    const { unmount } = view();
    openExport(seen);
    setRecorder("rendering");
    unmount();

    // Another replay is loaded while the export is being cancelled.
    act(() => {
      clock.clear();
      (app.gameSimulator.getPrimaryReplay as jest.Mock).mockReturnValue({ name: "replay B" });
      clock.setDuration(80_000);
      clock.speed = 1.5;
    });
    clearSpies();
    setRecorder("cancelled");
    for (const name of ["seekTo", "start", "setSpeed", "setPlaybackBoundary"] as const) {
      expect(spies[name]).not.toHaveBeenCalled();
    }
    expect(clock.speed).toBe(1.5);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
    expect(clock.timeElapsedInMs).toBe(0);
  });

  it("defers a session-end leave until the recorder stops, then resumes the viewer", () => {
    const { seen, view, clock, spies, clearSpies, setRecorder } = setup({ time: 5_000, playing: true, speed: 0.5 });
    view();
    openExport(seen);
    setRecorder("saving");
    clearSpies();
    act(() => seen.inspector.closeMode());
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    setRecorder("done");
    expect(clock.speed).toBe(0.5);
    expect(clock.isPlaying).toBe(true);
    expect(clock.timeElapsedInMs).toBe(5_000);
    expect(clock.playbackBoundaryInMs).toBeUndefined();
  });
});
