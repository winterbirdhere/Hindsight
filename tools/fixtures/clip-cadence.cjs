/*
 * Historical MediaRecorder cadence comparison, with no app/GUI input.
 * This intentionally retains the retired real-time scheduler for regression
 * investigation. It does not exercise the production deterministic exporter.
 * CLIP_CADENCE_INVESTIGATION=timer or single retains observation-only diagnostics;
 * Default reproduces the old RAF presentation and its original acceptance gate.
 */
module.exports = async function verifyClipCadence(workspace, output) {
  const fs = require("node:fs");
  const path = require("node:path");
  const investigation = process.env.CLIP_CADENCE_INVESTIGATION || "";
  if (!["", "single", "raf", "timer"].includes(investigation)) throw new Error("Unknown cadence investigation");
  class ClipFrameScheduler {
    constructor(fps) {
      this.intervalMs = 1000 / fps;
      this.nextFrameAt = undefined;
    }
    shouldCapture(now) {
      if (this.nextFrameAt === undefined) this.nextFrameAt = now;
      if (now + 0.5 < this.nextFrameAt) return false;
      const elapsed = Math.max(1, Math.floor((now - this.nextFrameAt) / this.intervalMs) + 1);
      this.nextFrameAt += elapsed * this.intervalMs;
      return true;
    }
  }
  function chooseClipFormat(supported) {
    const mimeType = [
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
    ].find(supported);
    return mimeType ? { mimeType, extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm" } : undefined;
  }
  const format = chooseClipFormat((type) => MediaRecorder.isTypeSupported(type));
  if (!format) throw new Error("No recording format in the test runtime");
  const scheduler = new ClipFrameScheduler(30);
  let lastFrame = -Infinity;
  const previous = (now) => {
    if (now - lastFrame < 1000 / 30 - 0.5) return false;
    lastFrame = now;
    return true;
  };
  const recordings = [
    { name: "previous", capture: previous },
    { name: "fixed", capture: (now) => scheduler.shouldCapture(now) },
  ]
    .filter((recording) => investigation !== "single" || recording.name === "fixed")
    .map((recording) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      document.body.appendChild(canvas);
      const context = canvas.getContext("2d", { alpha: false });
      const pixels = context.createImageData(64, 64);
      const stream = canvas.captureStream(0);
      const track = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: 250_000 });
      const chunks = [];
      const events = [];
      recorder.onstart = () => events.push({ type: "start", time: performance.now() });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
        events.push({ type: "data", time: performance.now(), bytes: event.data.size });
      };
      return { ...recording, canvas, context, pixels, stream, track, recorder, chunks, events, requested: 0 };
    });
  const ticks = [];
  const start = performance.now();
  const draw = (index, now) => {
    ticks.push(now - start);
    for (const recording of recordings) {
      if (!recording.capture(now)) continue;
      for (let at = 0; at < recording.pixels.data.length; at += 4) {
        recording.pixels.data[at] = index % 256;
        recording.pixels.data[at + 1] = (index * 7) % 256;
        recording.pixels.data[at + 2] = (index * 19) % 256;
        recording.pixels.data[at + 3] = 255;
      }
      // Match the historical compositor's CPU readback-to-canvas operation.
      recording.context.putImageData(recording.pixels, 0, 0);
      recording.track.requestFrame();
      recording.requested++;
    }
  };
  try {
    recordings.forEach((recording) => recording.recorder.start(1000));
    draw(0, performance.now());
    // Absolute deadlines keep the source at32Hz. Presentation is aligned with
    // RAF, as the old PixiTicker -> GameLoop.frameRendered$ path did. Drawing
    // two captured canvases directly in unrelated timer tasks can coalesce or
    // lose initial frames in the offscreen compositor. Explicit timer/single
    // investigation modes preserve that earlier fixture behavior for diagnosis.
    for (let index = 1; index < 128; index++) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, start + (index * 1000) / 32 - performance.now())));
      if (investigation !== "timer" && investigation !== "single") await new Promise(requestAnimationFrame);
      draw(index, performance.now());
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, start + 4000 - performance.now())));
    await Promise.all(
      recordings.map(
        (recording) =>
          new Promise((resolve, reject) => {
            recording.recorder.onerror = (event) => reject(new Error(String(event.error || event)));
            recording.recorder.onstop = resolve;
            recording.recorder.stop();
          }),
      ),
    );
    const report = [];
    for (const recording of recordings) {
      const destination = path.join(output, `${recording.name}.${format.extension}`);
      const bytes = Buffer.from(await new Blob(recording.chunks).arrayBuffer());
      fs.writeFileSync(destination, bytes);
      report.push({
        name: recording.name,
        path: destination,
        requestedFrames: recording.requested,
        bytes: bytes.length,
        events: recording.events.map((event) => ({ ...event, time: event.time - start })),
      });
    }
    return {
      targetFps: 30,
      observationOnly: !!investigation,
      investigation,
      sourcePresentation: investigation === "timer" || investigation === "single" ? "timer" : "requestAnimationFrame",
      sourceFps: 32,
      sourceTicks: ticks.length,
      sourceElapsedMs: ticks[ticks.length - 1],
      minTickMs: Math.min(...ticks.slice(1).map((time, index) => time - ticks[index])),
      maxTickMs: Math.max(...ticks.slice(1).map((time, index) => time - ticks[index])),
      format: format.mimeType,
      recordings: report,
    };
  } finally {
    recordings.forEach((recording) => {
      if (recording.recorder.state !== "inactive") recording.recorder.stop();
      recording.stream.getTracks().forEach((track) => track.stop());
    });
  }
};
