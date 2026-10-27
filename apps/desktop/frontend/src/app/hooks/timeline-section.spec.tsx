import "reflect-metadata";
import { act, fireEvent, render } from "@testing-library/react";
import { Subject } from "rxjs";
import { useAnalysisApp } from "../providers/TheaterProvider";
import { GameplayClock } from "../services/common/game/GameplayClock";
import { useGameClockControls } from "./game-clock";
import { useTimelineSection } from "./timeline-section";

jest.mock("../providers/TheaterProvider", () => ({ useAnalysisApp: jest.fn(), useCommonManagers: jest.fn() }));
jest.mock("./game-clock", () => ({ useGameClockControls: jest.fn() }));

// 120 BPM in 4/4 from 1000 ms: eight bars are 16 s. Two minutes long.
const beatmap = {
  hitObjects: [
    { type: "HIT_CIRCLE", hitTime: 59_000 },
    { type: "SLIDER", startTime: 60_000, endTime: 60_500 },
  ],
  controlPointInfo: { timingPoints: { list: [{ time: 1_000, beatLength: 500, timeSignature: 4 }] } },
};

let zoom: ReturnType<typeof useTimelineSection>;
function Probe(props: { enabled?: boolean; escape?: boolean; errorTimes?: number[] }) {
  zoom = useTimelineSection({ enabled: props.enabled ?? true, escape: props.escape ?? true, errorTimes: props.errorTimes ?? [] });
  return (
    <div>
      <input aria-label="Go to time" />
      {/* Like the timeline's own slider, the dock's buttons and the incident rows: keys pressed here go no further. */}
      <button type="button" onKeyDown={(event) => event.stopPropagation()}>
        Replay timeline
      </button>
    </div>
  );
}

function setup(props: Parameters<typeof Probe>[0] = {}) {
  jest.spyOn(console, "debug").mockImplementation(() => undefined);
  const gameClock = new GameplayClock();
  gameClock.setDuration(120_000);
  const frameRendered$ = new Subject<void>();
  const seekTo = jest.fn((time: number) => gameClock.seekTo(time));
  jest.mocked(useAnalysisApp).mockReturnValue({ gameClock, frameRendered$, gameSimulator: { getPrimaryBeatmap: () => beatmap } } as never);
  jest.mocked(useGameClockControls).mockReturnValue({ seekTo, duration: 120_000 } as never);
  const view = render(<Probe {...props} />);
  return { gameClock, frameRendered$, seekTo, view };
}

afterEach(() => jest.restoreAllMocks());

describe("useTimelineSection", () => {
  it("shows the whole map until asked", () => {
    setup();
    expect(zoom.section).toBeUndefined();
    expect(zoom.noteTimes).toEqual([]);
  });

  it("a right-click takes the playhead to the point and shows eight bars around it, with the notes", () => {
    const { gameClock, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    expect(seekTo).toHaveBeenCalledWith(60_000);
    expect(gameClock.timeElapsedInMs).toBe(60_000);
    expect(zoom.section).toEqual({ startMs: 51_000, endMs: 67_000 });
    expect(zoom.noteTimes).toEqual([59_000, 60_000, 60_500]);
  });

  it("widens the right-click's section to a run of errors under the pointer", () => {
    const errorTimes = Array.from({ length: 15 }, (_unused, index) => 50_000 + index * 1_500);
    setup({ errorTimes });
    act(() => zoom.showAt(60_100, 500));
    expect(zoom.section).toEqual({ startMs: 47_000, endMs: 73_000 });
  });

  it("a right-drag shows that stretch, and takes the playhead to its start only when it is elsewhere", () => {
    const { gameClock, seekTo } = setup();
    act(() => gameClock.seekTo(60_000));
    act(() => zoom.showDrag(42_000, 30_000));
    expect(zoom.section).toEqual({ startMs: 30_000, endMs: 42_000 });
    expect(seekTo).toHaveBeenLastCalledWith(30_000);
    seekTo.mockClear();
    act(() => zoom.showDrag(28_000, 36_000));
    expect(zoom.section).toEqual({ startMs: 28_000, endMs: 36_000 });
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("turns its pages to follow a seek to somewhere else", () => {
    const { gameClock, frameRendered$ } = setup();
    act(() => zoom.showAt(60_000, 500));
    act(() => gameClock.seekTo(70_000));
    expect(zoom.section).toEqual({ startMs: 67_000, endMs: 83_000 });
    const page = zoom.section;
    act(() => frameRendered$.next());
    expect(zoom.section).toBe(page);
    act(() => gameClock.seekTo(5_000));
    expect(zoom.section).toEqual({ startMs: 3_000, endMs: 19_000 });
  });

  it("plays the section again from its start when playback runs off its end", () => {
    const { gameClock, frameRendered$, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    const section = zoom.section;
    seekTo.mockClear();
    act(() => {
      gameClock.start();
      // Still inside: nothing happens.
      gameClock.timeElapsedInMs = 66_990;
      frameRendered$.next();
    });
    expect(seekTo).not.toHaveBeenCalled();
    act(() => {
      gameClock.timeElapsedInMs = 67_012;
      frameRendered$.next();
    });
    expect(seekTo).toHaveBeenCalledWith(51_000);
    expect(gameClock.isPlaying).toBe(true);
    expect(zoom.section).toBe(section);
    act(() => gameClock.pause());
  });

  it("does not pull a paused playhead back: a frame drawn while paused past the end changes nothing", () => {
    const { gameClock, frameRendered$, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    seekTo.mockClear();
    act(() => {
      gameClock.timeElapsedInMs = 67_012;
      frameRendered$.next();
    });
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("leaves an incident replay or a clip preview to play to its own end, and follows it by pages", () => {
    const { gameClock, frameRendered$, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    seekTo.mockClear();
    act(() => {
      gameClock.setPlaybackBoundary(70_000);
      gameClock.start();
      gameClock.timeElapsedInMs = 67_012;
      frameRendered$.next();
    });
    expect(seekTo).not.toHaveBeenCalled();
    expect(zoom.section).toEqual({ startMs: 67_000, endMs: 83_000 });
    act(() => gameClock.pause());
  });

  it("plays the last section again too, where the map's own end stops the clock", async () => {
    const { gameClock } = setup();
    act(() => zoom.showAt(119_000, 500));
    expect(zoom.section).toEqual({ startMs: 104_000, endMs: 120_000 });
    await act(async () => {
      gameClock.start();
      gameClock.timeElapsedInMs = 120_000;
      // What the clock does at the end of the map.
      gameClock.pause();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(gameClock.timeElapsedInMs).toBe(104_000);
    expect(gameClock.isPlaying).toBe(true);
    act(() => gameClock.pause());
  });

  it("stays put when playback is paused inside the section", async () => {
    const { gameClock, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    seekTo.mockClear();
    await act(async () => {
      gameClock.start();
      gameClock.pause();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seekTo).not.toHaveBeenCalled();
    expect(gameClock.isPlaying).toBe(false);
  });

  it("gets longer or shorter around the pointer, or around the playhead when the pointer's side would lose it", () => {
    const { gameClock } = setup();
    act(() => gameClock.seekTo(41_000));
    act(() => zoom.showDrag(40_000, 60_000));
    act(() => zoom.zoom(2, 45_000));
    expect(zoom.section).toEqual({ startMs: 35_000, endMs: 75_000 });
    act(() => zoom.showDrag(40_000, 60_000));
    // Half as long around 58 000 would be 49 000 to 59 000, without the playhead at 41 000.
    act(() => zoom.zoom(0.5, 58_000));
    expect(zoom.section).toEqual({ startMs: 40_500, endMs: 50_500 });
  });

  it("can start from the whole map with Alt and the wheel, and is the whole map again when made that long", () => {
    setup();
    act(() => zoom.zoom(0.5, 60_000));
    expect(zoom.section).toEqual({ startMs: 0, endMs: 60_000 });
    act(() => zoom.zoom(4, 30_000));
    expect(zoom.section).toBeUndefined();
  });

  it("goes back to the whole map with Esc, and with its own way out", () => {
    setup();
    act(() => zoom.showAt(60_000, 500));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(zoom.section).toBeUndefined();
    act(() => zoom.showAt(60_000, 500));
    act(() => zoom.exit());
    expect(zoom.section).toBeUndefined();
  });

  it("hears Esc wherever the focus is, also on a control that keeps its keys to itself", () => {
    const { view } = setup();
    act(() => zoom.showAt(60_000, 500));
    // After a click on the timeline the focus is on its slider, which stops its keys from travelling on.
    const slider = view.getByRole("button", { name: "Replay timeline" });
    act(() => slider.focus());
    fireEvent.keyDown(slider, { key: "Escape" });
    expect(zoom.section).toBeUndefined();
  });

  it("a right-drag is thirty seconds at most", () => {
    setup();
    act(() => zoom.showDrag(10_000, 80_000));
    expect(zoom.section).toEqual({ startMs: 10_000, endMs: 40_000 });
  });

  it("leaves Esc to a field being typed in, to anything that is open, and to the inspector when it is not at rest", () => {
    const { view } = setup();
    act(() => zoom.showAt(60_000, 500));
    fireEvent.keyDown(view.getByLabelText("Go to time"), { key: "Escape" });
    expect(zoom.section).toBeDefined();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(zoom.section).toBeDefined();
    menu.remove();
    view.rerender(<Probe escape={false} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(zoom.section).toBeDefined();
    view.rerender(<Probe escape />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(zoom.section).toBeUndefined();
  });

  it("is the whole map while the lane is something else, and takes no gesture then", () => {
    const { view, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    view.rerender(<Probe enabled={false} />);
    expect(zoom.section).toBeUndefined();
    seekTo.mockClear();
    act(() => zoom.showAt(60_000, 500));
    act(() => zoom.showDrag(10_000, 20_000));
    act(() => zoom.zoom(0.5, 60_000));
    expect(zoom.section).toBeUndefined();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("is the whole map again for another replay", () => {
    const { view, seekTo } = setup();
    act(() => zoom.showAt(60_000, 500));
    jest.mocked(useGameClockControls).mockReturnValue({ seekTo, duration: 90_000 } as never);
    view.rerender(<Probe />);
    expect(zoom.section).toBeUndefined();
  });
});
