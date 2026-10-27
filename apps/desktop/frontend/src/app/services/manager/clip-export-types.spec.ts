import { Blob as NodeBlob } from "buffer";
import {
  createClipFramePlan,
  CLIP_EXPORT_FRAME_RATES,
  CLIP_EXPORT_WIDTHS,
  ClipChunkWriter,
  ClipExportOptions,
  ClipExportFrameRate,
  validateClipOptions,
} from "./clip-export-types";
import { clipAppearanceOptions, ClipExportSettingsStore } from "../analysis/clip-export-settings";

export const clipOptions: ClipExportOptions = {
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

describe("deterministic clip frame plans", () => {
  const playbackCases = [
    [1, 1],
    [1.5, 1],
    [0.75, 1],
    [1.5, 0.5],
    [0.75, 1.5],
    [1, 0.1],
    [1, 0.25],
    [1.5, 1.25],
    [0.75, 1.75],
    [1.5, 2],
    [0.75, 4],
  ];

  it.each(
    CLIP_EXPORT_FRAME_RATES.flatMap((fps) => playbackCases.map(([base, viewer]) => [fps, base, viewer] as const)),
  )("preserves every sample of five video seconds at %s FPS, replay %s× and viewer %s×", (fps, base, viewer) => {
    const rate = base * viewer;
    const start = 55_123.456;
    const end = start + 5_000 * rate;
    const plan = createClipFramePlan(start, end, rate, fps);
    const times = Array.from({ length: plan.frameCount }, (_, index) => plan.timeAt(index));
    expect(plan.frameCount).toBe(5 * fps);
    expect(plan.durationSeconds).toBe(5);
    expect(plan.requestedDurationSeconds).toBeCloseTo(5, 10);
    expect(times[0]).toBe(start);
    expect(new Set(times).size).toBe(plan.frameCount);
    expect(times.every((time, index) => time >= start && time < end && (index === 0 || time > times[index - 1]))).toBe(
      true,
    );
    expect(times.at(-1)).toBeCloseTo(end - (1000 * rate) / fps, 8);
    expect(times.every((time, index) => Math.abs((time - start) / (1000 * rate) - index / fps) < 1e-10)).toBe(true);
  });

  it.each([
    [60, 1, 300],
    [120, 1, 600],
    [144, 1, 720],
    [240, 1, 1200],
    [60, 1.5, 200],
    [120, 1.5, 400],
    [144, 1.5, 480],
    [240, 1.5, 800],
    [60, 0.75, 400],
    [120, 0.75, 800],
    [144, 0.75, 960],
    [240, 0.75, 1600],
  ] as const)("uses %s FPS and rate %s× to turn five map seconds into %s frames", (fps, rate, frames) => {
    const plan = createClipFramePlan(55_000, 60_000, rate, fps);
    expect(plan.frameCount).toBe(frames);
    expect(plan.durationSeconds).toBeCloseTo(5 / rate, 10);
    expect(plan.timeAt(0)).toBe(55_000);
    expect(plan.timeAt(frames - 1)).toBeLessThan(60_000);
    expect(() => plan.timeAt(frames)).toThrow("Invalid clip frame index");
  });

  it.each(CLIP_EXPORT_FRAME_RATES)("rounds a fractional interval up by less than one frame at %s FPS", (fps) => {
    const start = 12_345.678;
    const end = 14_999.123;
    const rate = 1.5 * 1.25;
    const plan = createClipFramePlan(start, end, rate, fps);
    expect(plan.durationSeconds).toBeGreaterThanOrEqual(plan.requestedDurationSeconds);
    expect(plan.durationSeconds - plan.requestedDurationSeconds).toBeLessThan(1 / fps);
    expect(plan.timeAt(plan.frameCount - 1)).toBeLessThan(end);
    expect(plan.timeAt(plan.frameCount - 1) + (1000 * rate) / fps).toBeGreaterThanOrEqual(end);
  });

  it.each(CLIP_EXPORT_FRAME_RATES)(
    "retains one initial sample for a shorter-than-one-frame interval at %s FPS",
    (fps) => {
      const plan = createClipFramePlan(1_000.25, 1_000.5, 6, fps);
      expect(plan.frameCount).toBe(1);
      expect(plan.timeAt(0)).toBe(1_000.25);
      expect(plan.durationSeconds).toBe(1 / fps);
    },
  );

  it.each(CLIP_EXPORT_FRAME_RATES)("does not invent an endpoint frame for floating-point noise at %s FPS", (fps) => {
    const count = 5 * fps;
    const exact = createClipFramePlan(0, 5_000, 1, fps);
    const numericalNoise = createClipFramePlan(0, ((count + 5e-10) * 1000) / fps, 1, fps);
    const actualFraction = createClipFramePlan(0, ((count + 1e-6) * 1000) / fps, 1, fps);
    expect(exact.frameCount).toBe(count);
    expect(numericalNoise.frameCount).toBe(count);
    expect(actualFraction.frameCount).toBe(count + 1);
  });

  it.each(CLIP_EXPORT_FRAME_RATES)(
    "keeps identical sample times across slow, stalled and out-of-order consumers at %s FPS",
    (fps) => {
      jest.useFakeTimers();
      try {
        const plan = createClipFramePlan(55_000, 60_000, 1.5, fps);
        const baseline = Array.from({ length: plan.frameCount }, (_, index) => plan.timeAt(index));
        const slow = baseline.map((_, index) => {
          jest.advanceTimersByTime(index % 19 === 0 ? 5_000 : 100);
          return plan.timeAt(index);
        });
        expect(slow).toEqual(baseline);
        expect([...baseline.keys()].reverse().map((index) => plan.timeAt(index))).toEqual([...baseline].reverse());
        expect(plan.frameCount).toBe(baseline.length);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(CLIP_EXPORT_FRAME_RATES)("accepts the finite million-frame limit and rejects overflow at %s FPS", (fps) => {
    const plan = createClipFramePlan(0, (1_000_000 * 1000) / fps, 1, fps);
    expect(plan.frameCount).toBe(1_000_000);
    expect(Number.isFinite(plan.timeAt(999_999))).toBe(true);
    expect(() => createClipFramePlan(0, (1_000_001 * 1000) / fps, 1, fps)).toThrow("too many frames");
  });

  it.each([
    [NaN, 2_000, 1, 60],
    [-1, 2_000, 1, 60],
    [1_000, Infinity, 1, 60],
    [1_000, 1_000, 1, 60],
    [2_000, 1_000, 1, 60],
    [1_000, 2_000, 0, 60],
    [1_000, 2_000, -1, 60],
    [1_000, 2_000, NaN, 60],
    [1_000, 2_000, Infinity, 60],
    [1_000, 2_000, 1, 30],
    [1_000, 2_000, 1, 90],
    [1_000, 2_000, 1, 360],
  ])("rejects invalid frame plan arguments %s / %s / %s / %s", (start, end, rate, fps) => {
    expect(() => createClipFramePlan(start, end, rate, fps as ClipExportFrameRate)).toThrow("Invalid clip frame plan");
  });

  it.each([-1, 0.5, 60, NaN, Infinity])(
    "rejects an invalid index %s instead of silently clamping or duplicating a frame",
    (index) => {
      expect(() => createClipFramePlan(0, 1_000, 1, 60).timeAt(index)).toThrow("Invalid clip frame index");
    },
  );
});

describe("clip options and bounded writes", () => {
  it("accepts the options built from the default clip settings", () => {
    expect(() =>
      validateClipOptions(
        {
          startMs: 0,
          endMs: 3000,
          speed: 1,
          width: 1920,
          fps: 60,
          audio: true,
          ...clipAppearanceOptions(new ClipExportSettingsStore().getDefaultValue()),
        },
        3000,
      ),
    ).not.toThrow();
  });
  it("accepts options with no saveFolder and with a saveFolder string", () => {
    expect(() => validateClipOptions(clipOptions, 5000)).not.toThrow();
    expect(() => validateClipOptions({ ...clipOptions, saveFolder: undefined }, 5000)).not.toThrow();
    expect(() => validateClipOptions({ ...clipOptions, saveFolder: "D:\\Clips\\osu" }, 5000)).not.toThrow();
  });
  it.each([42, { path: "D:\\Clips" }, null, true])("rejects a saveFolder that is not a string: %j", (saveFolder) => {
    expect(() =>
      validateClipOptions({ ...clipOptions, saveFolder } as unknown as ClipExportOptions, 5000),
    ).toThrow("The clip export settings are invalid");
  });
  it.each([0, -1, NaN, "2", null])("rejects a display scale that is not a positive finite number: %j", (scale) => {
    expect(() =>
      validateClipOptions(
        { ...clipOptions, displaySettings: { hitErrorBarScale: scale } } as unknown as ClipExportOptions,
        5000,
      ),
    ).toThrow("clip display settings");
  });
  it("rejects an unknown error-cause detail", () => {
    expect(() =>
      validateClipOptions(
        { ...clipOptions, displaySettings: { errorCauseDisplay: "verbose" } } as unknown as ClipExportOptions,
        5000,
      ),
    ).toThrow("clip display settings");
  });
  it.each(["concise", "brief"] as const)("accepts the %s error-cause detail and a positive scale", (detail) => {
    expect(() =>
      validateClipOptions(
        { ...clipOptions, displaySettings: { errorCauseDisplay: detail, hitErrorBarScale: 1.5 } },
        5000,
      ),
    ).not.toThrow();
  });
  it.each(["short", "medium", "long"] as const)("accepts the %s key overlay length", (keyOverlayLength) => {
    expect(() => validateClipOptions({ ...clipOptions, displaySettings: { keyOverlayLength } }, 5000)).not.toThrow();
  });
  it.each(["huge", true, 2, null])("rejects an invalid key overlay length %s", (keyOverlayLength) => {
    expect(() =>
      validateClipOptions({ ...clipOptions, displaySettings: { keyOverlayLength } } as ClipExportOptions, 5000),
    ).toThrow("clip display settings");
  });
  it.each(["off", "selected", "all"] as const)("accepts the %s error outline mode", (errorOutline) => {
    expect(() => validateClipOptions({ ...clipOptions, displaySettings: { errorOutline } }, 5000)).not.toThrow();
  });
  it.each(["some", true, 1, null])("rejects an invalid error outline mode %s", (errorOutline) => {
    expect(() =>
      validateClipOptions({ ...clipOptions, displaySettings: { errorOutline } } as ClipExportOptions, 5000),
    ).toThrow("clip display settings");
  });
  it.each(["classic", "compact"] as const)("accepts the %s stats style alongside visibility flags", (statsStyle) => {
    expect(() =>
      validateClipOptions({ ...clipOptions, displaySettings: { statsStyle, starRatingEnabled: false } }, 5000),
    ).not.toThrow();
  });
  it.each(["unknown", true, 1, null])("rejects an invalid stats style %s", (statsStyle) => {
    expect(() =>
      validateClipOptions({ ...clipOptions, displaySettings: { statsStyle } } as ClipExportOptions, 5000),
    ).toThrow("clip display settings");
  });
  it.each([
    { startMs: NaN },
    { endMs: Infinity },
    { startMs: -1 },
    { endMs: 9000 },
    { endMs: 1100 },
    { speed: 0 },
    { speed: NaN },
    { width: 800 },
    { width: 1280 },
    { width: 4096 },
    { fps: 30 },
    { fps: 59 },
    { fps: 90 },
    { fps: 360 },
    { audio: "yes" },
    { showKeys: undefined },
    { showHitErrorBar: 1 },
    { showReplayCursor: "false" },
    { showAnalysisCursor: null },
    { showComparisonCursor: [] },
    { displaySettings: { accuracyEnabled: "true" } },
    { displaySettings: null },
    { displaySettings: [] },
  ])("rejects invalid export settings %j", (change) => {
    expect(() => validateClipOptions({ ...clipOptions, ...change } as ClipExportOptions, 3000)).toThrow();
  });

  it("accepts optional clip element preferences and legacy callers that omit them", () => {
    expect(() => validateClipOptions(clipOptions, 3000)).not.toThrow();
    expect(() =>
      validateClipOptions(
        {
          ...clipOptions,
          showHitErrorBar: false,
          showReplayCursor: true,
          showAnalysisCursor: true,
          showComparisonCursor: false,
          displaySettings: { accuracyEnabled: true, maxComboEnabled: false },
        },
        3000,
      ),
    ).not.toThrow();
  });

  it.each(CLIP_EXPORT_WIDTHS.flatMap((width) => CLIP_EXPORT_FRAME_RATES.map((fps) => [width, fps] as const)))(
    "accepts supported width %s at %s FPS",
    (width, fps) => {
      expect(() => validateClipOptions({ ...clipOptions, width, fps }, 3000)).not.toThrow();
    },
  );

  it("writes each chunk fully before the next and splits oversized encoder chunks", async () => {
    const append = jest.fn(async () => undefined);
    const error = jest.fn();
    const writer = new ClipChunkWriter(append, error);
    writer.push(new NodeBlob([new Uint8Array(9 * 1024 * 1024)]) as unknown as Blob);
    writer.push(new NodeBlob(["last"]) as unknown as Blob);
    await writer.flush();
    expect(append.mock.calls.map((call) => (call as unknown[])[0])).toEqual([0, 1, 2]);
    expect((append.mock.calls[0] as unknown as [number, ArrayBuffer])[1].byteLength).toBe(8 * 1024 * 1024);
    expect(error).not.toHaveBeenCalled();
  });

  it("applies backpressure and stops a recording instead of buffering without a limit", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = jest.fn(() => blocked);
    const error = jest.fn();
    const writer = new ClipChunkWriter(append, error, 5);
    writer.push(new NodeBlob(["1234"]) as unknown as Blob);
    writer.push(new NodeBlob(["6789"]) as unknown as Blob);
    expect(error).toHaveBeenCalledTimes(1);
    release();
    await expect(writer.flush()).rejects.toThrow("Video data is arriving faster than it can be saved");
  });

  it("streams a legitimate encoder burst above 32 MiB in bounded pieces without copying the full Blob", async () => {
    const append = jest.fn(async () => undefined);
    const error = jest.fn();
    const blob = new NodeBlob([new Uint8Array(33 * 1024 * 1024)]);
    const fullBlobCopy = jest.spyOn(blob, "arrayBuffer");
    const writer = new ClipChunkWriter(append, error);
    writer.push(blob as unknown as Blob);
    await writer.flush();
    expect(error).not.toHaveBeenCalled();
    expect(fullBlobCopy).not.toHaveBeenCalled();
    expect(append.mock.calls.map((call) => (call as unknown[])[0])).toEqual([0, 1, 2, 3, 4]);
    expect(append.mock.calls.map((call) => (call as unknown as [number, ArrayBuffer])[1].byteLength)).toEqual([
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      1024 * 1024,
    ]);
  });

  it("allows one bounded encoder burst alongside ordinary queued writes, preserving order", async () => {
    const append = jest.fn(async () => undefined);
    const error = jest.fn();
    const writer = new ClipChunkWriter(append, error, 8, 32);
    writer.push(new NodeBlob(["1234"]) as unknown as Blob);
    writer.push(new NodeBlob([new Uint8Array(20)]) as unknown as Blob);
    writer.push(new NodeBlob(["5678"]) as unknown as Blob);
    await writer.flush();
    expect(error).not.toHaveBeenCalled();
    expect(append.mock.calls.map((call) => (call as unknown as [number, ArrayBuffer])[1].byteLength)).toEqual([
      4, 20, 4,
    ]);
    writer.push(new NodeBlob([new Uint8Array(20)]) as unknown as Blob);
    await writer.flush();
    expect(error).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(4);
  });

  it("rejects a second queued burst with incoming and waiting byte evidence", async () => {
    const error = jest.fn();
    const writer = new ClipChunkWriter(jest.fn(), error, 8, 32);
    writer.push(new NodeBlob([new Uint8Array(20)]) as unknown as Blob);
    writer.push(new NodeBlob([new Uint8Array(24)]) as unknown as Blob);
    expect(error).toHaveBeenCalledTimes(1);
    await expect(writer.flush()).rejects.toThrow("20 bytes waiting, 24 bytes incoming");
  });

  it("rejects a single burst beyond its finite cap without misdiagnosing a slow disk", async () => {
    const append = jest.fn();
    const error = jest.fn();
    const writer = new ClipChunkWriter(append, error, 8, 32);
    writer.push(new NodeBlob([new Uint8Array(33)]) as unknown as Blob);
    await expect(writer.flush()).rejects.toThrow("above the 32-byte limit (0 bytes waiting, 33 bytes incoming)");
    expect(append).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("caps queued tiny chunks as well as their total bytes", async () => {
    const writer = new ClipChunkWriter(jest.fn(), jest.fn(), 1000, 2000);
    for (let index = 0; index < 65; index++) writer.push(new NodeBlob(["x"]) as unknown as Blob);
    await expect(writer.flush()).rejects.toThrow("64 bytes waiting, 1 bytes incoming");
  });

  it("no longer validates a stats layout: options from a stale caller that still carry one are accepted", () => {
    for (const statsLayout of ["sideways", "sidePanel", "playfield"])
      expect(() => validateClipOptions({ ...clipOptions, statsLayout } as ClipExportOptions, 10_000)).not.toThrow();
  });

  it("cancels queued writes and reports disk failures without an unhandled rejection", async () => {
    const error = jest.fn();
    const writer = new ClipChunkWriter(async () => {
      throw new Error("disk full");
    }, error);
    writer.push(new NodeBlob(["data"]) as unknown as Blob);
    await expect(writer.flush()).rejects.toThrow("disk full");
    expect(error).toHaveBeenCalledTimes(1);
    const append = jest.fn();
    const cancelled = new ClipChunkWriter(append, jest.fn());
    cancelled.push(new NodeBlob(["data"]) as unknown as Blob);
    cancelled.cancel();
    await cancelled.flush();
    expect(append).not.toHaveBeenCalled();
  });
});
