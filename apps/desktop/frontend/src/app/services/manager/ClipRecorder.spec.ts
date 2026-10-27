import { Blob as NodeBlob } from "buffer";
import { Subject } from "rxjs";
import { GameplayClock } from "../common/game/GameplayClock";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../analysis/replay-display-settings";
import { frontendAPI } from "../../api";
import { ClipRecorder, ClipExportOptions, ClipRunSummary } from "./ClipRecorder";
import { ClipExportRenderer } from "./ClipExportRenderer";

jest.mock("./ClipExportRenderer", () => ({
  ClipExportRenderer: jest.fn().mockImplementation((canvas) => ({
    canvas,
    beginCapture: jest.fn(),
    endCapture: jest.fn(),
    render: jest.fn(),
    readFrame: jest.fn(() => new Uint8ClampedArray([1, 2, 3, 255])),
    destroy: jest.fn(),
  })),
}));

const options: ClipExportOptions = {
  startMs: 1000,
  endMs: 2000,
  width: 1920,
  fps: 60,
  audio: true,
  preset: "analysis",
  showKeys: true,
  showTiming: true,
  showStats: true,
  speed: 1,
};

class FakeRecorder {
  static isTypeSupported = () => true;
  static instances: FakeRecorder[] = [];
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new NodeBlob(["encoded clip"]) as unknown as Blob });
    this.onstop?.();
  }
}

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

describe("ClipRecorder lifecycle", () => {
  const originalRecorder = global.MediaRecorder;
  let frame: Subject<void>;
  let clock: GameplayClock;
  let recorder: ClipRecorder;
  let audio: { beginCapture: jest.Mock; prepareCapture: jest.Mock };
  let tap: { stream: { getAudioTracks: () => unknown[] }; dispose: jest.Mock };
  let replay: { player: string };
  let renderManager: { getRenderer: jest.Mock };
  let beginOfflineCapture: jest.Mock;
  let renderFrame: jest.Mock;
  let releaseOfflineCapture: jest.Mock;
  let refresh: jest.Mock;
  let waitForSettled: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    global.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    FakeRecorder.instances = [];
    frame = new Subject<void>();
    clock = new GameplayClock();
    clock.setDuration(10_000);
    clock.seekTo(500);
    clock.setSpeed(0.75);
    clock.setPlaybackBoundary(9000);
    tap = { stream: { getAudioTracks: () => [{ kind: "audio" }] }, dispose: jest.fn() };
    audio = { beginCapture: jest.fn(() => tap), prepareCapture: jest.fn(async () => undefined) };
    replay = { player: "Player" };
    renderManager = { getRenderer: jest.fn(() => ({})) };
    releaseOfflineCapture = jest.fn();
    refresh = jest.fn();
    waitForSettled = jest.fn(async () => undefined);
    let drawTarget: (() => void) | undefined;
    renderFrame = jest.fn((time: number) => {
      clock.timeElapsedInMs = time;
      drawTarget?.();
    });
    beginOfflineCapture = jest.fn((_onError, draw) => {
      drawTarget = draw;
      return { renderFrame, dispose: releaseOfflineCapture };
    });
    recorder = new ClipRecorder(
      renderManager as never,
      {} as never,
      { frameRendered$: frame, beginOfflineCapture, refresh } as never,
      audio as never,
      clock,
      { getPrimaryReplay: () => replay, getRulesetFocus: () => "stable" } as never,
      { waitForSettled } as never,
      { settings: DEFAULT_REPLAY_DISPLAY_SETTINGS } as never,
      { settings: { dim: 0.8, enabled: true, statsShade: true } } as never,
    );
    jest.spyOn(frontendAPI, "beginClipExport").mockResolvedValue({ id: "clip-id", path: "D:\\clip.mp4" });
    jest.spyOn(frontendAPI, "appendClipExport").mockResolvedValue();
    jest.spyOn(frontendAPI, "appendClipExportFrame").mockResolvedValue();
    jest.spyOn(frontendAPI, "finishClipExport").mockResolvedValue({ path: "D:\\clip.mp4" });
    jest.spyOn(frontendAPI, "abortClipExport").mockResolvedValue();
  });
  afterEach(() => {
    global.MediaRecorder = originalRecorder;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function begin(clipOptions = options) {
    const done = recorder.exportClip(clipOptions);
    await settle();
    frame.next();
    await settle();
    return { done };
  }

  function finishAudio() {
    jest.advanceTimersByTime((options.endMs - clock.timeElapsedInMs) / clock.playbackRate);
    clock.pause();
    frame.next();
  }

  it("draws each output through the offline callback and releases capture layers before resuming the ticker", async () => {
    const { done } = await begin({ ...options, audio: false });
    await jest.runAllTimersAsync();
    await done;
    const instances = jest.mocked(ClipExportRenderer).mock.results;
    const compositor = instances[instances.length - 1]?.value;
    expect(beginOfflineCapture.mock.calls[0][1]).toEqual(expect.any(Function));
    expect(compositor.beginCapture).toHaveBeenCalledTimes(1);
    expect(compositor.render).toHaveBeenCalledTimes(61); // Preparation plus the 60 output frames.
    expect(compositor.endCapture.mock.invocationCallOrder[0]).toBeLessThan(
      releaseOfflineCapture.mock.invocationCallOrder[0],
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it("waits for requested performance stats before acquiring an export session", async () => {
    let ready!: () => void;
    waitForSettled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const done = recorder.exportClip({ ...options, audio: false });
    await settle();
    expect(waitForSettled).toHaveBeenCalledTimes(1);
    expect(frontendAPI.beginClipExport).not.toHaveBeenCalled();
    expect(beginOfflineCapture).not.toHaveBeenCalled();
    ready();
    await settle();
    frame.next();
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("done");
  });

  it("cancels while waiting for stats without changing transport or opening an export", async () => {
    waitForSettled.mockImplementation(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const done = recorder.exportClip({ ...options, audio: false });
    await settle();
    await recorder.cancel();
    await done;
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(clock.timeElapsedInMs).toBe(500);
    expect(frontendAPI.beginClipExport).not.toHaveBeenCalled();
    expect(beginOfflineCapture).not.toHaveBeenCalled();
  });

  it("restores the playhead when capture took control after a performance wait", async () => {
    let ready!: () => void;
    waitForSettled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const done = recorder.exportClip({ ...options, audio: false });
    await settle();
    clock.seekTo(750);
    clock.setSpeed(1.25);
    ready();
    await settle();
    frame.next();
    await jest.runAllTimersAsync();
    await done;
    expect(clock.timeElapsedInMs).toBe(750);
    expect(clock.speed).toBe(1.25);
  });

  it("keeps the gated display settings snapshot while performance is pending", async () => {
    let ready!: () => void;
    waitForSettled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const store = { settings: { ...DEFAULT_REPLAY_DISPLAY_SETTINGS } };
    Object.assign(recorder, { displaySettings: store });
    const done = recorder.exportClip({ ...options, audio: false });
    await settle();
    store.settings.performancePointsEnabled = false;
    ready();
    await settle();
    frame.next();
    await jest.runAllTimersAsync();
    await done;
    const calls = jest.mocked(ClipExportRenderer).mock.calls;
    expect(calls[calls.length - 1][7].performancePointsEnabled).toBe(true);
    expect((calls[calls.length - 1] as readonly unknown[])[10]).toBe(false);
  });

  it.each([
    { showStats: false },
    { showStats: true, displaySettings: { performancePointsEnabled: false, starRatingEnabled: false } },
  ])("does not wait for performance stats when no PP/SR is exported (%j)", async (settings) => {
    const { done } = await begin({ ...options, audio: false, ...settings });
    await jest.runAllTimersAsync();
    await done;
    expect(waitForSettled).not.toHaveBeenCalled();
    expect(recorder.state$.value.status).toBe("done");
  });

  it("records through the clip endpoint, renders every frame to MP4, then restores transport", async () => {
    const { done } = await begin();
    expect(recorder.state$.value.status).toBe("recording");
    expect(clock.speed).toBe(1);
    expect(clock.playbackBoundaryInMs).toBe(2000);
    expect(frontendAPI.beginClipExport).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "mp4",
        video: { width: 1920, height: 1080, fps: 60, frameCount: 60, audio: true },
      }),
    );
    expect(clock.isPlaying).toBe(true);
    finishAudio();
    await jest.runAllTimersAsync();
    await done;
    expect(frontendAPI.appendClipExport).toHaveBeenCalledWith(
      "clip-id",
      0,
      expect.objectContaining({ byteLength: 12 }),
    );
    expect(frontendAPI.finishClipExport).toHaveBeenCalledTimes(1);
    expect(frontendAPI.abortClipExport).not.toHaveBeenCalled();
    expect(recorder.state$.value).toEqual({ status: "done", progress: 1, path: "D:\\clip.mp4" });
    expect(clock.timeElapsedInMs).toBe(500);
    expect(clock.speed).toBe(0.75);
    expect(clock.playbackBoundaryInMs).toBe(9000);
    expect(clock.isPlaying).toBe(false);
    expect(tap.dispose).toHaveBeenCalled();
    expect(renderFrame).toHaveBeenCalledTimes(60);
    expect(releaseOfflineCapture).toHaveBeenCalledTimes(1);
  });

  describe("save folder", () => {
    async function requestFor(clipOptions: ClipExportOptions) {
      const { done } = await begin({ ...clipOptions, audio: false });
      await jest.runAllTimersAsync();
      await done;
      return jest.mocked(frontendAPI.beginClipExport).mock.calls[0][0];
    }

    it("passes the saved folder to the save dialog request", async () => {
      const request = await requestFor({ ...options, saveFolder: "D:\\Clips\\osu" });
      expect(request).toMatchObject({ extension: "mp4", directory: "D:\\Clips\\osu" });
    });

    it.each([
      ["no saveFolder", undefined],
      ["an empty saveFolder", ""],
    ])("sends no directory for %s", async (_name, saveFolder) => {
      const request = await requestFor({ ...options, saveFolder });
      expect(request.directory).toBeUndefined();
      expect(request).not.toHaveProperty("directory");
    });
  });

  describe("run summary", () => {
    const summary = {
      startMs: 1000,
      endMs: 2000,
      width: 1920,
      fps: 60,
      audio: false,
      speed: 1,
      frameCount: 60,
      durationSeconds: 1,
    };

    it("publishes the run summary once the frame plan exists and keeps it after the export", async () => {
      expect(recorder.run$.value).toBeUndefined();
      const atPreparing: Array<ClipRunSummary | undefined> = [];
      recorder.state$.subscribe((state) => {
        if (state.status === "preparing") atPreparing.push(recorder.run$.value);
      });
      const done = recorder.exportClip({ ...options, audio: false });
      expect(atPreparing).toEqual([undefined]);
      await settle();
      frame.next();
      await settle();
      expect(recorder.state$.value.status).toBe("rendering");
      expect(recorder.run$.value).toEqual(summary);
      await jest.runAllTimersAsync();
      await done;
      expect(recorder.state$.value.status).toBe("done");
      expect(recorder.run$.value).toEqual(summary);
    });

    it("publishes the audio flag and the plan's duration while recording audio", async () => {
      const { done } = await begin({ ...options, speed: 2, endMs: 2500 });
      expect(recorder.state$.value.status).toBe("recording");
      expect(recorder.run$.value).toEqual({
        ...summary,
        endMs: 2500,
        audio: true,
        speed: 2,
        frameCount: 45,
        durationSeconds: 0.75,
      });
      await recorder.cancel();
      await done;
    });

    it("keeps the summary after a cancel and after an error", async () => {
      const cancelling = await begin();
      await recorder.cancel();
      await cancelling.done;
      expect(recorder.state$.value.status).toBe("cancelled");
      expect(recorder.run$.value).toEqual({ ...summary, audio: true });

      jest.mocked(frontendAPI.appendClipExportFrame).mockRejectedValueOnce(new Error("encoder input failed"));
      const failing = await begin({ ...options, audio: false, fps: 120 });
      await failing.done;
      expect(recorder.state$.value.status).toBe("error");
      expect(recorder.run$.value).toEqual({ ...summary, fps: 120, frameCount: 120, durationSeconds: 1 });
    });

    it("clears the summary when the next export starts", async () => {
      const first = await begin({ ...options, audio: false });
      await jest.runAllTimersAsync();
      await first.done;
      expect(recorder.run$.value).toEqual(summary);
      const atPreparing: Array<ClipRunSummary | undefined> = [];
      const subscription = recorder.state$.subscribe((state) => {
        if (state.status === "preparing") atPreparing.push(recorder.run$.value);
      });
      const second = recorder.exportClip({ ...options, audio: false, fps: 120 });
      subscription.unsubscribe();
      expect(atPreparing).toEqual([undefined]);
      await settle();
      frame.next();
      await settle();
      expect(recorder.run$.value).toEqual({ ...summary, fps: 120, frameCount: 120 });
      await jest.runAllTimersAsync();
      await second;
    });
  });

  it("awaits a late save dialog and removes its session after cancellation", async () => {
    let select!: (value: { id: string; path: string }) => void;
    jest.mocked(frontendAPI.beginClipExport).mockReturnValue(
      new Promise((resolve) => {
        select = resolve;
      }),
    );
    const { done } = await begin();
    const cancelled = recorder.cancel();
    expect(recorder.isBusy).toBe(true);
    select({ id: "late", path: "D:\\late.mp4" });
    await cancelled;
    await done;
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("late");
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it("aborts an in-flight save promptly and keeps controls locked until cleanup completes", async () => {
    let rejectSave!: (error: Error) => void;
    jest.mocked(frontendAPI.finishClipExport).mockReturnValue(
      new Promise((_, reject) => {
        rejectSave = reject;
      }),
    );
    const { done } = await begin();
    finishAudio();
    await jest.runAllTimersAsync();
    expect(recorder.state$.value.status).toBe("saving");
    const cancelled = recorder.cancel();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(recorder.isBusy).toBe(true);
    rejectSave(new Error("aborted"));
    await cancelled;
    await done;
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(recorder.isBusy).toBe(false);
  });

  it("reports a successful commit if cancellation arrives after the atomic save has succeeded", async () => {
    let finishSave!: (result: { path: string }) => void;
    jest.mocked(frontendAPI.finishClipExport).mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const { done } = await begin();
    finishAudio();
    await jest.runAllTimersAsync();
    const cancelled = recorder.cancel();
    finishSave({ path: "D:\\clip.mp4" });
    await cancelled;
    await done;
    expect(recorder.state$.value.status).toBe("done");
  });

  it("cancels on teardown without restarting the previous playback", async () => {
    clock.start();
    const { done } = await begin();
    await recorder.cancel({ restorePlayback: false });
    await done;
    expect(clock.isPlaying).toBe(false);
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(tap.dispose).toHaveBeenCalled();
  });

  it("rejects an automatic encoder stop before B instead of publishing a truncated clip", async () => {
    const { done } = await begin();
    // MediaRecorder can stop itself when all input tracks end. That emits the
    // final data and stop event without this service requesting completion.
    FakeRecorder.instances[0].stop();
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(recorder.state$.value.error).toContain("stopped before the clip finished");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(clock.timeElapsedInMs).toBe(500);
    expect(clock.speed).toBe(0.75);
    expect(tap.dispose).toHaveBeenCalled();
  });

  it("rejects an encoder that is already inactive when the endpoint frame arrives", async () => {
    const { done } = await begin();
    FakeRecorder.instances[0].state = "inactive";
    finishAudio();
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
  });

  it("still fails the encoder stop timeout after successfully rendering B", async () => {
    jest.useFakeTimers();
    const { done } = await begin();
    const encoder = FakeRecorder.instances[0];
    jest.spyOn(encoder, "stop").mockImplementation(() => {
      encoder.state = "inactive";
    });
    finishAudio();
    jest.advanceTimersByTime(10_001);
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(recorder.state$.value.error).toContain("encoder did not finish");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it.each([60, 120, 144, 240] as const)(
    "renders every scheduled %s FPS frame even when each render takes 80 ms",
    async (fps) => {
      let wallTime = 0;
      jest.spyOn(performance, "now").mockImplementation(() => wallTime);
      renderFrame.mockImplementation((time: number) => {
        clock.timeElapsedInMs = time;
        wallTime += 80;
      });
      const { done } = await begin({ ...options, fps, audio: false });
      await jest.runAllTimersAsync();
      await done;
      expect(recorder.state$.value.status).toBe("done");
      expect(renderFrame).toHaveBeenCalledTimes(fps);
      expect(frontendAPI.appendClipExportFrame).toHaveBeenCalledTimes(fps);
      renderFrame.mock.calls.forEach(([time, delta], index) => {
        expect(time).toBeCloseTo(1000 + (index * 1000) / fps, 9);
        expect(delta).toBe(index === 0 ? 0 : 1000 / fps);
        expect(frontendAPI.appendClipExportFrame).toHaveBeenNthCalledWith(
          index + 1,
          "clip-id",
          index,
          0,
          expect.any(ArrayBuffer),
        );
      });
      expect(FakeRecorder.instances).toHaveLength(0);
      expect(audio.beginCapture).not.toHaveBeenCalled();
      expect(clock.timeElapsedInMs).toBe(500);
    },
  );

  it.each([
    [1.5, 1, 80],
    [0.75, 1, 160],
    [1.5, 0.5, 160],
    [0.75, 2, 80],
  ])("maps base rate %s and viewer speed %s to %s frames at 120 FPS", async (baseRate, speed, count) => {
    clock.setBaseRate(baseRate);
    const { done } = await begin({ ...options, fps: 120, speed, audio: false });
    await jest.runAllTimersAsync();
    await done;
    expect(renderFrame).toHaveBeenCalledTimes(count);
    expect(renderFrame.mock.calls[count - 1][0]).toBeLessThan(options.endMs);
    expect(renderFrame.mock.calls[1][0] - renderFrame.mock.calls[0][0]).toBeCloseTo((baseRate * speed * 1000) / 120, 9);
    expect(frontendAPI.beginClipExport).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ frameCount: count }) }),
    );
  });

  it("waits for encoder acknowledgement before rendering another frame, and cancels without publishing", async () => {
    let acknowledge!: () => void;
    jest.mocked(frontendAPI.appendClipExportFrame).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { done } = await begin({ ...options, audio: false });
    expect(recorder.state$.value.status).toBe("rendering");
    expect(recorder.isBusy).toBe(true);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(frontendAPI.appendClipExportFrame).toHaveBeenCalledTimes(1);
    const cancelled = recorder.cancel();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(recorder.isBusy).toBe(true);
    acknowledge();
    await cancelled;
    await done;
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(releaseOfflineCapture).toHaveBeenCalledTimes(1);
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it("sends complete 4K frames in bounded, sequential chunks", async () => {
    const bytes = new Uint8ClampedArray(3840 * 2160 * 4);
    jest.mocked(ClipExportRenderer).mockImplementationOnce(
      (canvas) =>
        ({
          canvas,
          beginCapture: jest.fn(),
          endCapture: jest.fn(),
          render: jest.fn(),
          destroy: jest.fn(),
          readFrame: () => bytes,
        } as unknown as ClipExportRenderer),
    );
    const { done } = await begin({ ...options, width: 3840, endMs: 1250, audio: false });
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("done");
    const calls = jest.mocked(frontendAPI.appendClipExportFrame).mock.calls;
    expect(calls).toHaveLength(15 * 4);
    for (let index = 0; index < 15; index++) {
      const chunks = calls.filter((call) => call[1] === index);
      expect(chunks.map((call) => call[2])).toEqual([0, 8388608, 16777216, 25165824]);
      expect(chunks.reduce((total, call) => total + call[3].byteLength, 0)).toBe(bytes.byteLength);
      expect(chunks.every((call) => call[3].byteLength <= 8388608)).toBe(true);
    }
  });

  it("aborts a failed native encoder write without rendering the next frame", async () => {
    jest.mocked(frontendAPI.appendClipExportFrame).mockRejectedValueOnce(new Error("encoder input failed"));
    const { done } = await begin({ ...options, audio: false });
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(recorder.state$.value.error).toContain("encoder input failed");
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it.each([1920, 2560, 3840] as const)(
    "bounds frame staging allocations at width %s without overwriting pending data",
    async (width) => {
      const bytes = new Uint8ClampedArray(width * ((width * 9) / 16) * 4);
      let frameIndex = 0;
      jest.mocked(ClipExportRenderer).mockImplementationOnce(
        (canvas) =>
          ({
            canvas,
            beginCapture: jest.fn(),
            endCapture: jest.fn(),
            render: jest.fn(),
            destroy: jest.fn(),
            readFrame: () => {
              frameIndex++;
              for (let offset = 0; offset < bytes.length; offset += 8388608)
                bytes.fill(frameIndex + (offset / 8388608) * 32, offset, Math.min(bytes.length, offset + 8388608));
              return bytes;
            },
          } as unknown as ClipExportRenderer),
      );
      const buffers = new Set<ArrayBuffer>();
      const received: { index: number; offset: number; length: number; first: number; last: number }[] = [];
      jest.mocked(frontendAPI.appendClipExportFrame).mockImplementation(async (_id, index, offset, data) => {
        buffers.add(data);
        const view = new Uint8Array(data);
        const first = view[0],
          last = view[view.length - 1];
        // A real invoke resolves only after the encoder consumes the chunk.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(view[0]).toBe(first);
        expect(view[view.length - 1]).toBe(last);
        received.push({ index, offset, length: view.length, first, last });
      });
      const { done } = await begin({ ...options, width, endMs: 1250, audio: false });
      await jest.runAllTimersAsync();
      await done;
      expect(recorder.state$.value.status).toBe("done");
      for (let index = 0; index < 15; index++) {
        const chunks = received.filter((chunk) => chunk.index === index);
        expect(chunks.map((chunk) => chunk.offset)).toEqual(
          width === 1920 ? [0] : width === 2560 ? [0, 8388608] : [0, 8388608, 16777216, 25165824],
        );
        expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(bytes.byteLength);
        expect(chunks.map((chunk) => chunk.first)).toEqual(
          width === 1920
            ? [index + 1]
            : width === 2560
            ? [index + 1, index + 33]
            : [index + 1, index + 33, index + 65, index + 97],
        );
        expect(chunks.every((chunk) => chunk.length <= 8388608 && chunk.last === chunk.first)).toBe(true);
      }
      if (width === 1920) {
        expect(buffers.size).toBe(1);
        expect(buffers.has(bytes.buffer as ArrayBuffer)).toBe(true);
      } else {
        expect(buffers.size).toBeLessThanOrEqual(2);
        expect([...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
      }
    },
  );

  it("sends only the pixel view when a frame shares a larger backing buffer", async () => {
    const backing = new Uint8ClampedArray(1920 * 1080 * 4 + 16).fill(99);
    const pixels = backing.subarray(8, backing.length - 8);
    pixels.fill(37);
    jest.mocked(ClipExportRenderer).mockImplementationOnce(
      (canvas) =>
        ({
          canvas,
          beginCapture: jest.fn(),
          endCapture: jest.fn(),
          render: jest.fn(),
          destroy: jest.fn(),
          readFrame: () => pixels,
        } as unknown as ClipExportRenderer),
    );
    const received: number[][] = [];
    jest.mocked(frontendAPI.appendClipExportFrame).mockImplementation(async (_id, _index, _offset, data) => {
      const view = new Uint8Array(data);
      received.push([view.length, view[0], view[view.length - 1]]);
    });
    const { done } = await begin({ ...options, endMs: 1250, audio: false });
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("done");
    expect(received).toHaveLength(15);
    expect(received.every((chunk) => chunk[0] === 8294400 && chunk[1] === 37 && chunk[2] === 37)).toBe(true);
  });

  it.each(["cancel", "reject"])("stops a 4K frame on a pending second-chunk %s", async (action) => {
    const pixels = new Uint8ClampedArray(3840 * 2160 * 4);
    pixels.fill(11, 0, 8388608);
    pixels.fill(22, 8388608, 16777216);
    pixels.fill(33, 16777216);
    jest.mocked(ClipExportRenderer).mockImplementationOnce(
      (canvas) =>
        ({
          canvas,
          beginCapture: jest.fn(),
          endCapture: jest.fn(),
          render: jest.fn(),
          destroy: jest.fn(),
          readFrame: () => pixels,
        } as unknown as ClipExportRenderer),
    );
    let held!: Uint8Array;
    let acknowledge!: () => void;
    let reject!: (error: Error) => void;
    jest.mocked(frontendAPI.appendClipExportFrame).mockImplementation(async (_id, _index, offset, data) => {
      if (offset === 8388608) {
        held = new Uint8Array(data);
        await new Promise<void>((resolve, fail) => {
          acknowledge = resolve;
          reject = fail;
        });
      }
    });
    const { done } = await begin({ ...options, width: 3840, endMs: 1250, audio: false });
    await jest.advanceTimersByTimeAsync(100);
    expect(frontendAPI.appendClipExportFrame).toHaveBeenCalledTimes(2);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect([held[0], held[held.length - 1]]).toEqual([22, 22]);
    if (action === "cancel") {
      const cancelled = recorder.cancel();
      expect([held[0], held[held.length - 1]]).toEqual([22, 22]);
      acknowledge();
      await cancelled;
    } else reject(new Error("encoder input failed"));
    await done;
    expect(recorder.state$.value.status).toBe(action === "cancel" ? "cancelled" : "error");
    expect(frontendAPI.appendClipExportFrame).toHaveBeenCalledTimes(2);
    expect(renderFrame).toHaveBeenCalledTimes(1);
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
  });

  it("aborts and restores playback if offline rendering fails", async () => {
    renderFrame.mockImplementationOnce(() => {
      beginOfflineCapture.mock.calls[0][0](new Error("The replay renderer is unavailable"));
    });
    const { done } = await begin({ ...options, fps: 120, audio: false });
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(recorder.state$.value.error).toContain("renderer is unavailable");
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
    expect(clock.timeElapsedInMs).toBe(500);
    expect(releaseOfflineCapture).toHaveBeenCalledTimes(1);
  });

  it("releases the offline clock before native finalization", async () => {
    jest.mocked(frontendAPI.finishClipExport).mockImplementation(async () => {
      expect(releaseOfflineCapture).toHaveBeenCalledTimes(1);
      return { path: "D:\\clip.mp4" };
    });
    const { done } = await begin({ ...options, fps: 144, audio: false });
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("done");
  });

  it.each([{ width: 1280 }, { fps: 30 }, { displaySettings: [] }, { displaySettings: null }])(
    "rejects legacy quality %j before opening a save dialog or changing transport",
    async (change) => {
      await recorder.exportClip({ ...options, ...change } as ClipExportOptions);
      expect(recorder.state$.value.status).toBe("error");
      expect(frontendAPI.beginClipExport).not.toHaveBeenCalled();
      expect(audio.beginCapture).not.toHaveBeenCalled();
      expect(clock.timeElapsedInMs).toBe(500);
      expect(clock.speed).toBe(0.75);
    },
  );

  it("fails a stalled transport and aborts its output instead of recording a frozen replay indefinitely", async () => {
    jest.useFakeTimers();
    const { done } = await begin();
    jest.advanceTimersByTime(5500);
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(recorder.state$.value.error).toContain("stalled");
    expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it.each([
    [1, 1],
    [1.5, 1],
    [0.75, 1],
    [1.5, 0.75],
  ])("accepts normal audio clock variation at base %s and viewer %s", async (baseRate, speed) => {
    clock.setBaseRate(baseRate);
    const { done } = await begin({ ...options, speed });
    let audioTime = options.startMs;
    clock.setTimeSource(() => audioTime);
    const duration = (options.endMs - options.startMs) / (baseRate * speed);
    // The observed graph/pitch-stretch phase can lag the recording by ~32 ms.
    jest.advanceTimersByTime(32);
    frame.next();
    for (let index = 1; index <= 10; index++) {
      jest.advanceTimersByTime(duration / 10);
      audioTime = options.startMs + ((options.endMs - options.startMs) * index) / 10;
      clock.tick();
      frame.next();
    }
    await jest.runAllTimersAsync();
    await done;
    expect(recorder.state$.value.status).toBe("done");
    expect(frontendAPI.finishClipExport).toHaveBeenCalledTimes(1);
  });

  it.each(["startup", "mid-pass", "endpoint"])(
    "rejects a 250 ms %s audio delay before rendering or publishing the fixed-grid video",
    async (phase) => {
      const { done } = await begin();
      let audioTime = options.startMs;
      clock.setTimeSource(() => audioTime);
      if (phase === "mid-pass") {
        jest.advanceTimersByTime(400);
        audioTime += 400;
        clock.tick();
        frame.next();
      }
      if (phase === "endpoint") {
        jest.advanceTimersByTime(1000);
        audioTime = options.endMs;
      }
      jest.advanceTimersByTime(250);
      clock.tick();
      frame.next();
      await done;
      expect(recorder.state$.value.status).toBe("error");
      expect(recorder.state$.value.error).toContain("Audio playback lost sync");
      expect(beginOfflineCapture).not.toHaveBeenCalled();
      expect(frontendAPI.finishClipExport).not.toHaveBeenCalled();
      expect(frontendAPI.abortClipExport).toHaveBeenCalledWith("clip-id");
      expect(tap.dispose).toHaveBeenCalledTimes(1);
      expect(clock.timeElapsedInMs).toBe(500);
    },
  );

  it("cancels before the first ready frame without creating an output session", async () => {
    const done = recorder.exportClip(options);
    await settle();
    await recorder.cancel();
    await done;
    expect(frontendAPI.beginClipExport).not.toHaveBeenCalled();
    expect(recorder.state$.value.status).toBe("cancelled");
    expect(tap.dispose).not.toHaveBeenCalled();
    expect(clock.timeElapsedInMs).toBe(500);
  });

  it("restores after an encoder error even if releasing one resource fails", async () => {
    tap.dispose.mockImplementation(() => {
      throw new Error("device gone");
    });
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { done } = await begin();
    FakeRecorder.instances[0].onerror?.();
    await done;
    expect(recorder.state$.value.status).toBe("error");
    expect(clock.speed).toBe(0.75);
    expect(clock.timeElapsedInMs).toBe(500);
    expect(frontendAPI.abortClipExport).toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
  });
});
