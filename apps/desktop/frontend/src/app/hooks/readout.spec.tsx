import { act, render } from "@testing-library/react";
import { BehaviorSubject, Subject } from "rxjs";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { readoutAt } from "../services/analysis/readout-source";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../services/analysis/replay-display-settings";
import { useGameClockTime } from "./game-clock";
import { useReadoutIdentity, useReadoutModel } from "./readout";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn() }));
jest.mock("../services/analysis/readout-source", () => ({ readoutAt: jest.fn() }));
// Delegates to the real hook; the wrapper only records whether a caller subscribed to the clock.
jest.mock("./game-clock", () => {
  const actual = jest.requireActual("./game-clock");
  return { ...actual, useGameClockTime: jest.fn(actual.useGameClockTime) };
});

function setup(useTitle: () => string | undefined = () => useReadoutModel()?.identity.title) {
  const app = {
    gameClock: { timeElapsedInMs: 5_000 },
    performanceTimeline: { changed$: new BehaviorSubject(0) },
    gameSimulator: { rulesetFocus$: new BehaviorSubject("stable"), replayEvents$: new BehaviorSubject([]) },
    scenarioManager: { scenario$: new BehaviorSubject({ status: "DONE" }) },
    replayDisplaySettingsStore: {
      settings: DEFAULT_REPLAY_DISPLAY_SETTINGS,
      settings$: new Subject<typeof DEFAULT_REPLAY_DISPLAY_SETTINGS>(),
    },
  };
  jest.mocked(useAnalysisApp).mockReturnValue(app as unknown as ReturnType<typeof useAnalysisApp>);
  // Echo the ruleset the hook saw, so a re-evaluation is observable in the rendered output.
  jest.mocked(readoutAt).mockImplementation(
    (deps) =>
      ({
        identity: { title: String((deps as unknown as typeof app).gameSimulator.rulesetFocus$.value), mods: "NM", ruleset: "Stable" },
        rows: [],
        judgements: [],
      }) as ReturnType<typeof readoutAt>,
  );
  function Probe() {
    return <span data-testid="title">{useTitle()}</span>;
  }
  const view = render(<Probe />);
  return { app, title: () => view.getByTestId("title").textContent };
}

// Playback is paused in every case below: no clock tick drives the refresh.
describe("useReadoutModel", () => {
  beforeEach(() => jest.mocked(readoutAt).mockClear());

  it("refreshes paused values when the ruleset focus changes", () => {
    const { app, title } = setup();
    expect(title()).toBe("stable");
    act(() => app.gameSimulator.rulesetFocus$.next("lazer"));
    expect(title()).toBe("lazer");
  });

  it("re-reads the readout when background PP/SR is published while paused", () => {
    const { app } = setup();
    const before = jest.mocked(readoutAt).mock.calls.length;
    act(() => app.performanceTimeline.changed$.next(1));
    expect(jest.mocked(readoutAt).mock.calls.length).toBeGreaterThan(before);
  });

  it("re-reads with the new settings when display settings change", () => {
    const { app } = setup();
    const next = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, unstableRateEnabled: !DEFAULT_REPLAY_DISPLAY_SETTINGS.unstableRateEnabled };
    act(() => app.replayDisplaySettingsStore.settings$.next(next));
    expect(jest.mocked(readoutAt).mock.lastCall?.[1]).toBe(next);
  });
});

describe("useReadoutIdentity", () => {
  beforeEach(() => {
    jest.mocked(readoutAt).mockClear();
    jest.mocked(useGameClockTime).mockClear();
  });

  it("does not subscribe to the playback clock", () => {
    setup(() => useReadoutIdentity()?.title);
    expect(useGameClockTime).not.toHaveBeenCalled();
  });

  it("still follows ruleset, replay, performance and settings changes", () => {
    const { app, title } = setup(() => useReadoutIdentity()?.title);
    expect(title()).toBe("stable");
    act(() => app.gameSimulator.rulesetFocus$.next("lazer"));
    expect(title()).toBe("lazer");
    const before = jest.mocked(readoutAt).mock.calls.length;
    act(() => app.performanceTimeline.changed$.next(1));
    expect(jest.mocked(readoutAt).mock.calls.length).toBeGreaterThan(before);
    const next = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, unstableRateEnabled: !DEFAULT_REPLAY_DISPLAY_SETTINGS.unstableRateEnabled };
    act(() => app.replayDisplaySettingsStore.settings$.next(next));
    expect(jest.mocked(readoutAt).mock.lastCall?.[1]).toBe(next);
  });

  it("leaves useReadoutModel on the HUD cadence", () => {
    setup(() => useReadoutModel()?.identity.title);
    expect(useGameClockTime).toHaveBeenCalledWith(15);
  });
});
