import "reflect-metadata";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject, Subject } from "rxjs";
import { useGameClockControls } from "../../hooks/game-clock";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp, useCommonManagers } from "../../providers/TheaterProvider";
import { DEFAULT_PLAY_BAR_SETTINGS } from "../../services/common/playbar";
import { GameplayClock } from "../../services/common/game/GameplayClock";
import { ReplayDisplaySettingsStore } from "../../services/analysis/replay-display-settings";
import { GameTimeSlider } from "./GameTimeSlider";

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));
jest.mock("../../providers/TheaterProvider", () => ({
  useAnalysisApp: jest.fn(),
  useCommonManagers: jest.fn(),
}));
jest.mock("../../hooks/game-clock", () => ({
  useGameClockControls: jest.fn(),
}));
// The seek slider itself is not under test; it hands the timeline's onChange and `disabled` to the test.
jest.mock("./BaseGameTimeSlider", () => ({
  BaseGameTimeSlider: ({ disabled, onChange }: { disabled?: boolean; onChange: (value: number) => void }) => (
    <div data-testid="timeline" data-disabled={String(Boolean(disabled))}>
      {[10_000, 75_000, 190_000].map((value) => (
        <button key={value} type="button" onClick={() => onChange(value)}>
          {`seek ${value}`}
        </button>
      ))}
    </div>
  ),
}));

const DURATION = 200_000;

/** Drives the inspector from the test: Export opens and closes, and the range is set the way the panel would set it. */
function InspectorControls() {
  const { openExport, closeMode, setExportRange } = useInspector();
  return (
    <>
      <button type="button" onClick={openExport}>
        open export
      </button>
      <button type="button" onClick={closeMode}>
        close export
      </button>
      <button type="button" onClick={() => setExportRange({ startMs: 50_000, endMs: 100_000 })}>
        set range
      </button>
    </>
  );
}

function setup({ disabled = false }: { disabled?: boolean } = {}) {
  const gameClock = new GameplayClock();
  gameClock.setDuration(DURATION);
  const seekTo = jest.fn();
  (useGameClockControls as jest.Mock).mockReturnValue({ seekTo, duration: DURATION, baseRate: 1 });
  (useAnalysisApp as jest.Mock).mockReturnValue({
    gameClock,
    frameRendered$: new Subject<void>(),
    replayDisplaySettingsStore: new ReplayDisplaySettingsStore(),
    gameSimulator: {
      replayEvents$: new BehaviorSubject([]),
      rulesetFocus$: new BehaviorSubject<"stable" | "lazer">("lazer"),
      difficulties$: new BehaviorSubject<number[]>([]),
    },
  });
  (useCommonManagers as jest.Mock).mockReturnValue({
    playbarSettingsStore: { settings$: new BehaviorSubject(DEFAULT_PLAY_BAR_SETTINGS) },
  });
  render(
    <InspectorProvider>
      <InspectorControls />
      <GameTimeSlider disabled={disabled} />
    </InspectorProvider>,
  );
  return { seekTo };
}

const openExport = () => fireEvent.click(screen.getByRole("button", { name: "open export" }));
const setRange = () => fireEvent.click(screen.getByRole("button", { name: "set range" }));
const seek = (value: number) => fireEvent.click(screen.getByRole("button", { name: `seek ${value}` }));
const startEdge = () => screen.queryByRole("slider", { name: "Clip start" });
const endEdge = () => screen.queryByRole("slider", { name: "Clip end" });

describe("GameTimeSlider", () => {
  afterEach(() => jest.clearAllMocks());

  it("shows the range picker on the timeline only during an export session", () => {
    setup();
    expect(startEdge()).toBeNull();
    expect(endEdge()).toBeNull();
    expect(screen.queryByTestId("clip-outline")).toBeNull();

    openExport();
    expect(startEdge()).not.toBeNull();
    expect(endEdge()).not.toBeNull();
    // With no stored range the picker is the whole replay.
    expect(startEdge()?.getAttribute("aria-valuenow")).toBe("0");
    expect(endEdge()?.getAttribute("aria-valuenow")).toBe(String(DURATION));
    // It sits in the lane box that holds the timeline, so its percentages refer to the lane.
    const lane = screen.getByTestId("timeline").parentElement as HTMLElement;
    expect(lane.contains(startEdge())).toBe(true);
    expect(lane.contains(screen.getByTestId("clip-outline"))).toBe(true);
    expect(getComputedStyle(lane).position).toBe("relative");

    setRange();
    expect(startEdge()?.getAttribute("aria-valuetext")).toBe("0:50");
    expect(endEdge()?.getAttribute("aria-valuetext")).toBe("1:40");

    fireEvent.click(screen.getByRole("button", { name: "close export" }));
    expect(startEdge()).toBeNull();
    expect(screen.queryByTestId("clip-outline")).toBeNull();
  });

  it("clamps a timeline seek to the range during an export session", () => {
    const { seekTo } = setup();
    openExport();
    setRange(); // 50-100 s
    seek(10_000);
    expect(seekTo).toHaveBeenLastCalledWith(50_000);
    seek(190_000);
    expect(seekTo).toHaveBeenLastCalledWith(100_000);
    seek(75_000);
    expect(seekTo).toHaveBeenLastCalledWith(75_000);
  });

  it("seeks freely outside an export session", () => {
    const { seekTo } = setup();
    setRange(); // a stored range does not matter while Export is closed
    seek(10_000);
    expect(seekTo).toHaveBeenLastCalledWith(10_000);
    seek(190_000);
    expect(seekTo).toHaveBeenLastCalledWith(190_000);

    openExport();
    fireEvent.click(screen.getByRole("button", { name: "close export" }));
    seek(10_000);
    expect(seekTo).toHaveBeenLastCalledWith(10_000);
    expect(seekTo).toHaveBeenCalledTimes(3);
  });

  it("locks the range picker while the timeline is disabled", () => {
    setup({ disabled: true });
    openExport();
    expect(screen.getByTestId("timeline").getAttribute("data-disabled")).toBe("true");
    for (const edge of [startEdge(), endEdge()]) {
      expect(edge?.getAttribute("aria-disabled")).toBe("true");
      expect(edge?.tabIndex).toBe(-1);
    }
    // A locked edge does not react to the keyboard.
    act(() => {
      fireEvent.keyDown(startEdge() as HTMLElement, { key: "ArrowRight" });
    });
    expect(startEdge()?.getAttribute("aria-valuenow")).toBe("0");
  });
});
