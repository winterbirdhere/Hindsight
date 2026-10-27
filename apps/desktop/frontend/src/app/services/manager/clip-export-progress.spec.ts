import { exportProgress } from "./clip-export-progress";

const run = {
  startMs: 62_000,
  endMs: 70_000,
  width: 1920,
  fps: 60,
  audio: true,
  speed: 1,
  frameCount: 480,
  durationSeconds: 8,
} as const;

describe("exportProgress", () => {
  it("is at zero while preparing", () => {
    expect(exportProgress({ status: "preparing", progress: 0 }, undefined)).toMatchObject({
      title: "Preparing",
      subline: "Opening the recorder",
      percent: 0,
      rendering: false,
      steps: [
        { id: "preparing", state: "active" },
        { id: "audio", state: "pending" },
        { id: "frames", state: "pending" },
        { id: "saving", state: "pending" },
      ],
    });
  });

  it("gives audio the design's 6–22 % span", () => {
    expect(exportProgress({ status: "recording", progress: 0.5 }, run)).toMatchObject({
      title: "Recording audio",
      subline: "Mixing music and hit sounds",
      percent: 14,
    });
  });

  it("matches the 18d picture: 46 of 480 frames is 28 %", () => {
    expect(exportProgress({ status: "rendering", progress: 46 / 480 }, run)).toMatchObject({
      subline: "46 / 480 frames",
      percent: 28,
    });
  });

  it("gives frames the 22–93 % span and shows the frame count", () => {
    const model = exportProgress({ status: "rendering", progress: 0.25 }, run);
    expect(model).toMatchObject({ title: "Rendering frames", subline: "120 / 480 frames", percent: 39, rendering: true });
    expect(model.fraction).toBeCloseTo(0.3975);
    expect(model.steps).toEqual([
      { id: "preparing", label: "Preparing", state: "done" },
      { id: "audio", label: "Recording audio", state: "done", detail: "8.0 s" },
      { id: "frames", label: "Rendering frames", state: "active", detail: "120 / 480" },
      { id: "saving", label: "Saving", state: "pending" },
    ]);
  });

  it("gives frames 6–93 % and marks audio skipped when the clip has no audio", () => {
    const model = exportProgress({ status: "rendering", progress: 0.25 }, { ...run, audio: false });
    expect(model.percent).toBe(27);
    expect(model.steps[1]).toEqual({ id: "audio", label: "Recording audio", state: "skipped", detail: "skipped" });
  });

  it("rests at 93 % while saving", () => {
    const model = exportProgress({ status: "saving", progress: 1 }, run);
    expect(model).toMatchObject({ title: "Saving", subline: "Writing MP4", percent: 93 });
    expect(model.steps[2]).toMatchObject({ state: "done", detail: "480 / 480" });
  });

  it("stays inside its step for a broken progress value and never rounds a whole figure down", () => {
    expect(exportProgress({ status: "rendering", progress: NaN }, run).percent).toBe(22);
    expect(exportProgress({ status: "rendering", progress: 7 }, run).percent).toBe(93);
    expect(exportProgress({ status: "recording", progress: -1 }, run).percent).toBe(6);
    expect(exportProgress({ status: "recording", progress: 1 }, run).percent).toBe(22);
  });
});
