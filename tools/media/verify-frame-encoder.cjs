// Non-GUI native encoder regression: deliberately slow input, exact decoded cadence/content.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const root = path.resolve(__dirname, "../..");
process.env.TS_NODE_PROJECT = path.join(root, "apps/desktop/main/tsconfig.app.json");
require("ts-node/register/transpile-only");
const { ClipExportManager } = require(path.join(root, "apps/desktop/main/src/app/clip-export.ts"));
const { FFmpegClipFrameEncoder } = require(path.join(root, "apps/desktop/main/src/app/clip-frame-encoder.ts"));
const executable = path.join(root, "resources/clip-media/win-x64/ffmpeg.exe");
const outputDirectory = path.resolve(
  process.argv[2] || path.join(root, "tmp/review-20260908/deterministic-native-matrix"),
);
const report = { verified: false, executable, cases: [] };

function run(command, args, binary = false) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    encoding: binary ? undefined : "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

async function checkCase(fps, width, frameCount, audioMode) {
  const height = (width * 9) / 16;
  const duration = frameCount / fps;
  const name = `${width}x${height}-${fps}fps-${audioMode}`;
  const output = path.join(outputDirectory, `${name}.mp4`);
  const audio = audioMode !== "silent";
  let audioPath;
  if (audio) {
    audioPath = path.join(outputDirectory, `${name}-input.webm`);
    const audioDuration = duration + (audioMode === "pad" ? -0.07 : 0.1);
    run(executable, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:sample_rate=48000:duration=${audioDuration}`,
      "-ac",
      "2",
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
      "-f",
      "webm",
      audioPath,
    ]);
  }
  const owner = Object.assign(new EventEmitter(), {
    id: 700,
    isDestroyed: () => false,
    getBackgroundThrottling: () => true,
    setBackgroundThrottling: () => {},
  });
  const manager = new ClipExportManager(
    { selectDestination: async () => output, openPath: async () => "", showItemInFolder: () => {} },
    undefined,
    undefined,
    (video, videoPath, signal) => new FFmpegClipFrameEncoder(video, videoPath, signal, () => executable),
  );
  const started = performance.now();
  try {
    const session = await manager.begin(owner, {
      fileName: path.basename(output),
      extension: "mp4",
      video: { width, height, fps, frameCount, audio },
    });
    if (audioPath) {
      const bytes = await fs.readFile(audioPath);
      await manager.append(
        owner.id,
        session.id,
        0,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      );
    }
    const frame = Buffer.alloc(width * height * 4);
    const pixels = new Uint32Array(frame.buffer, frame.byteOffset, frame.length / 4);
    for (let index = 0; index < frameCount; index++) {
      pixels.fill(0xff443322);
      for (let bit = 0; bit < 8; bit++) {
        const value = ((index + 1) >> bit) & 1 ? 0xffffffff : 0xff000000;
        for (let row = height - 128; row < height - 64; row++)
          pixels.fill(value, row * width + 64 + bit * 64, row * width + 128 + bit * 64);
      }
      // Feed at <=50 frames/second even when the requested file cadence is240.
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (let offset = 0; offset < frame.length; offset += 8 * 1024 * 1024) {
        const end = Math.min(frame.length, offset + 8 * 1024 * 1024);
        await manager.appendFrame(
          owner.id,
          session.id,
          index,
          offset,
          frame.buffer.slice(frame.byteOffset + offset, frame.byteOffset + end),
        );
      }
    }
    await manager.finish(owner.id, session.id);
    const elapsed = (performance.now() - started) / 1000;
    const info = JSON.parse(run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]));
    const video = info.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, width);
    assert.equal(video.height, height);
    const frames = JSON.parse(
      run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp",
        "-of",
        "json",
        output,
      ]),
    ).frames;
    assert.equal(frames.length, frameCount, "decoded frame count");
    const [numerator, denominator] = video.time_base.split("/").map(Number);
    frames.forEach((frame, index) =>
      assert.equal(
        Number(frame.best_effort_timestamp) * numerator * fps,
        index * denominator,
        `frame${index} exact PTS`,
      ),
    );
    assert(Math.abs(Number(video.duration) - duration) < 0.000001, "video duration equals frameCount/fps");
    const markers = run(
      executable,
      [
        "-v",
        "error",
        "-i",
        output,
        "-map",
        "0:v:0",
        "-vf",
        `crop=512:64:64:${height - 128},scale=8:1:flags=neighbor,format=gray`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      true,
    );
    assert.equal(markers.length, frameCount * 8);
    for (let index = 0; index < frameCount; index++) {
      let marker = 0;
      for (let bit = 0; bit < 8; bit++) if (markers[index * 8 + bit] > 128) marker |= 1 << bit;
      assert.equal(marker, index + 1, `decoded frame${index} content; no drops/duplicates`);
    }
    const audioStream = info.streams.find((stream) => stream.codec_type === "audio");
    let tailRms;
    if (audio) {
      assert.equal(audioStream.codec_name, "aac");
      assert.equal(audioStream.sample_rate, "48000");
      assert.equal(audioStream.channels, 2);
      assert(
        Math.abs(Number(audioStream.duration) - duration) < 1 / 48000 + 0.000001,
        "audio duration is padded/trimmed to video",
      );
      const decoded = run(
        executable,
        [
          "-v",
          "error",
          "-i",
          output,
          "-map",
          "0:a:0",
          "-t",
          String(duration),
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          "pipe:1",
        ],
        true,
      );
      const tail = Math.min(960, decoded.length / 4);
      let sum = 0;
      for (let sample = decoded.length / 4 - tail; sample < decoded.length / 4; sample++)
        sum += decoded.readFloatLE(sample * 4) ** 2;
      tailRms = Math.sqrt(sum / tail);
      if (audioMode === "pad") assert(tailRms < 0.001, "short audio is padded with silence");
      else assert(tailRms > 0.01, "long audio retains its signal through the trimmed endpoint");
    } else assert.equal(audioStream, undefined);
    assert.equal(manager.hasWork, false);
    const result = {
      name,
      output,
      fps,
      width,
      height,
      frameCount,
      duration,
      elapsedSeconds: elapsed,
      suppliedWallClockFps: frameCount / elapsed,
      decodedFrameCount: frames.length,
      exactPts: true,
      exactFrameMarkers: true,
      audio: audioStream
        ? {
            codec: audioStream.codec_name,
            channels: audioStream.channels,
            duration: audioStream.duration,
            mode: audioMode,
            tailRms,
          }
        : null,
    };
    report.cases.push(result);
    console.log(JSON.stringify(result));
  } finally {
    await manager.dispose();
  }
}

(async () => {
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const width of [1920, 2560, 3840]) {
    for (const fps of [60, 120, 144, 240]) {
      await checkCase(
        fps,
        width,
        fps === 144 ? 37 : fps / 4,
        width === 1920 && fps === 120 ? "pad" : width === 1920 && fps === 144 ? "trim" : "silent",
      );
    }
  }
  assert(
    !(await fs.readdir(outputDirectory)).some((name) => name.startsWith(".rewind-")),
    "no abandoned staging files",
  );
  report.verified = true;
})()
  .catch((error) => {
    report.error = error.stack || String(error);
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.writeFile(path.join(outputDirectory, "result.json"), JSON.stringify(report, null, 2) + "\n"));
