// Analyze completed native Rewind recordings without opening the application/player.
// node tools/media/verify-native-clips.cjs <recordings-directory> [selected-wall-duration-seconds]
// Optional filename suffixes: -1p5x (rate), -1s (explicit output duration).
// native-expectations.json may specify per-file duration, interval and package attribution.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
assert(
  process.argv[2],
  "Usage: node tools/media/verify-native-clips.cjs <recordings-directory> [selected-wall-duration-seconds]",
);
const directory = path.resolve(process.argv[2]);
assert(
  fs.existsSync(directory) && fs.statSync(directory).isDirectory(),
  `Recordings directory not found: ${directory}`,
);
const defaultRequestedSeconds = Number(process.argv[3] || 5);
assert(Number.isFinite(defaultRequestedSeconds) && defaultRequestedSeconds > 0);
const expectationPath = path.join(directory, "native-expectations.json");
const expectations = fs.existsSync(expectationPath) ? JSON.parse(fs.readFileSync(expectationPath, "utf8")) : {};
const ffmpeg = path.join(root, "resources/clip-media/win-x64/ffmpeg.exe");
const verificationVersion = 1;
const aggregate = { verificationVersion, verified: false, defaultRequestedSeconds, clips: [] };
function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), "", "Strict media inspection must not report decode errors");
  return result.stdout;
}
function save(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function hashes(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split(",").at(-1).trim());
}
function changes(values) {
  let adjacentDuplicates = 0;
  for (let index = 1; index < values.length; index++) if (values[index] === values[index - 1]) adjacentDuplicates++;
  return { frameCount: values.length, distinctFrames: new Set(values).size, adjacentDuplicates };
}
function motion(file) {
  const data = fs.readFileSync(file),
    frameSize = 160 * 90;
  assert.equal(data.length % frameSize, 0);
  const meanAbsoluteDifferences = [];
  for (let offset = frameSize; offset < data.length; offset += frameSize) {
    let difference = 0;
    for (let index = 0; index < frameSize; index++)
      difference += Math.abs(data[offset + index] - data[offset - frameSize + index]);
    meanAbsoluteDifferences.push(difference / frameSize);
  }
  const sorted = [...meanAbsoluteDifferences].sort((a, b) => a - b);
  return {
    comparisonCount: sorted.length,
    minMeanAbsoluteDifference: sorted[0],
    medianMeanAbsoluteDifference: sorted[Math.floor(sorted.length / 2)],
    maxMeanAbsoluteDifference: sorted.at(-1),
    changedPairsAbove01: sorted.filter((value) => value > 0.1).length,
    meanAbsoluteDifferences,
  };
}
function verify(file) {
  const name = path.basename(file),
    match =
      /^rewind-(?:(1080|1440|2160)p|(4k))(60|120|144|240)-(silent|audio)((?:-[0-9]+(?:p[0-9]+)?[xs])*)\.mp4$/.exec(
        name,
      );
  assert(match, `Filename must declare independent expected resolution/FPS/audio: ${name}`);
  const declaration = expectations.clips?.[name] || {};
  const namedDuration = /-([0-9]+(?:p[0-9]+)?)s(?:-|$)/.exec(match[5]);
  const namedRate = /-([0-9]+(?:p[0-9]+)?)x(?:-|$)/.exec(match[5]);
  const requestedSeconds =
    declaration.durationSeconds ??
    (namedDuration ? Number(namedDuration[1].replace("p", ".")) : defaultRequestedSeconds);
  assert(Number.isFinite(requestedSeconds) && requestedSeconds > 0);
  const packageAttribution = declaration.package ?? expectations.defaultPackage;
  const height = match[2] ? 2160 : Number(match[1]),
    fps = Number(match[3]),
    hasAudio = match[4] === "audio";
  const selection = {
    ...(declaration.selection || {}),
    ...(namedRate ? { playbackRate: Number(namedRate[1].replace("p", ".")) } : {}),
  };
  if (selection.startMs !== undefined && selection.endMs !== undefined && selection.playbackRate !== undefined)
    assert(Math.abs((selection.endMs - selection.startMs) / (1000 * selection.playbackRate) - requestedSeconds) < 1e-9);
  const expectedFrames = Math.ceil(requestedSeconds * fps - 1e-9),
    expectedDuration = expectedFrames / fps;
  const evidence = path.join(directory, path.basename(file, ".mp4") + "-inspection");
  fs.mkdirSync(evidence, { recursive: true });
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const resultFile = path.join(evidence, "result.json");
  if (fs.existsSync(resultFile)) {
    const previous = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (
      previous.verified &&
      previous.sha256 === sha256 &&
      previous.verificationVersion === verificationVersion &&
      previous.requestedSeconds === requestedSeconds
    ) {
      previous.packageAttribution = packageAttribution;
      previous.selection = selection;
      if (previous.audioSamples) {
        previous.strictAudioSampleCountVerified =
          previous.audioSamples.perChannelSamples === previous.audioSamples.expectedPresentationSamples;
        previous.audioSamples.sampleCountDifferenceFromPresentation =
          previous.audioSamples.perChannelSamples - previous.audioSamples.expectedPresentationSamples;
        delete previous.audioSamples.finalAacFramePaddingSamples;
      }
      save(resultFile, previous);
      return previous;
    }
  }
  const result = {
    verificationVersion,
    verified: false,
    file,
    sha256,
    requestedSeconds,
    packageAttribution,
    selection,
    expected: { width: (height * 16) / 9, height, fps, frames: expectedFrames, duration: expectedDuration, hasAudio },
  };
  try {
    const probeText = run("ffprobe", [
      "-v",
      "error",
      "-count_frames",
      "-show_streams",
      "-show_format",
      "-show_frames",
      "-show_entries",
      "stream=index,codec_type,codec_name,profile,level,width,height,r_frame_rate,avg_frame_rate,time_base,start_pts,start_time,duration,nb_frames,nb_read_frames,sample_rate,channels:format=duration,start_time,size:frame=media_type,best_effort_timestamp,key_frame,pict_type,nb_samples",
      "-of",
      "json",
      file,
    ]);
    fs.writeFileSync(path.join(evidence, "ffprobe.json"), probeText);
    const probe = JSON.parse(probeText);
    const video = probe.streams.filter((stream) => stream.codec_type === "video");
    const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
    assert.equal(video.length, 1);
    assert.equal(audio.length, Number(hasAudio));
    const stream = video[0],
      frames = probe.frames.filter((frame) => frame.media_type === "video");
    result.video = stream;
    result.audio = audio;
    result.container = probe.format;
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.width, result.expected.width);
    assert.equal(stream.height, height);
    assert.equal(stream.r_frame_rate, `${fps}/1`);
    assert.equal(stream.avg_frame_rate, `${fps}/1`);
    assert.equal(Number(stream.nb_read_frames), expectedFrames);
    assert.equal(frames.length, expectedFrames);
    assert.equal(Number(stream.start_pts), 0);
    assert(Math.abs(Number(stream.duration) - expectedDuration) < 0.000001);
    const [num, den] = stream.time_base.split("/").map(BigInt);
    frames.forEach((frame, index) =>
      assert.equal(
        BigInt(frame.best_effort_timestamp) * num * BigInt(fps),
        BigInt(index) * den,
        `Decoded frame ${index} must have exact timestamp n/${fps}`,
      ),
    );
    const keyframes = frames.flatMap((frame, index) => (frame.key_frame ? [index] : []));
    const keyframeGaps = keyframes.slice(1).map((index, position) => (index - keyframes[position]) / fps);
    result.timestamps = {
      exact: true,
      first: 0,
      finalFrameSeconds: (expectedFrames - 1) / fps,
      intervalSeconds: 1 / fps,
      decodedDurationSeconds: expectedDuration,
      keyframeIndices: keyframes,
      maximumKeyframeGapSeconds: keyframeGaps.length ? Math.max(...keyframeGaps) : null,
    };
    if (hasAudio) {
      assert.equal(audio[0].codec_name, "aac");
      assert.equal(Number(audio[0].sample_rate), 48000);
      assert.equal(audio[0].channels, 2);
      result.audioVideoDurationGapSeconds = Math.abs(Number(audio[0].duration) - expectedDuration);
      assert(result.audioVideoDurationGapSeconds <= 1 / 48000 + 0.000001);
    }
    const full = path.join(evidence, "frames.framemd5"),
      stats = path.join(evidence, "stats.framemd5");
    const scaled = path.join(evidence, "motion.gray"),
      scale = height / 900;
    const crop = [180, 450, 8, 60].map((value) => Math.floor((value * scale) / 2) * 2).join(":");
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-y",
      "-threads",
      "2",
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-threads:v",
      "2",
      "-f",
      "framemd5",
      full,
      "-map",
      "0:v:0",
      "-vf",
      `crop=${crop}`,
      "-fps_mode",
      "passthrough",
      "-threads:v",
      "2",
      "-f",
      "framemd5",
      stats,
      "-map",
      "0:v:0",
      "-vf",
      "scale=160:90:flags=area,format=gray",
      "-fps_mode",
      "passthrough",
      "-threads:v",
      "2",
      "-f",
      "rawvideo",
      scaled,
    ];
    const pcm = path.join(evidence, "audio.s16le");
    if (hasAudio) args.push("-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", pcm);
    run(ffmpeg, args);
    result.decode = { clean: true, strictErrorMode: true, allVideoAndAudioDecoded: true };
    result.decodedContent = changes(hashes(full));
    result.statsRegion = { logicalStageCrop: { x: 8, y: 60, width: 180, height: 450 }, ...changes(hashes(stats)) };
    result.motion = motion(scaled);
    if (hasAudio) {
      const samples = fs.readFileSync(pcm);
      const channels = audio[0].channels,
        sampleRate = Number(audio[0].sample_rate);
      assert.equal(samples.length % (channels * 2), 0);
      const perChannelSamples = samples.length / (channels * 2);
      const expectedSamples = Math.round(expectedDuration * sampleRate);
      let sumSquares = 0,
        peak = 0,
        nonzeroValues = 0;
      for (let index = 0; index < samples.length; index += 2) {
        const value = samples.readInt16LE(index) / 32768;
        sumSquares += value * value;
        peak = Math.max(peak, Math.abs(value));
        if (value !== 0) nonzeroValues++;
      }
      result.audioSamples = {
        sampleRate,
        channels,
        perChannelSamples,
        expectedPresentationSamples: expectedSamples,
        decodedSeconds: perChannelSamples / sampleRate,
        sampleCountDifferenceFromPresentation: perChannelSamples - expectedSamples,
        rms: Math.sqrt(sumSquares / (samples.length / 2)),
        peak,
        nonzeroValues,
      };
      result.strictAudioSampleCountVerified = perChannelSamples === expectedSamples;
      const decodedAudioFrames = probe.frames.filter((frame) => frame.media_type === "audio");
      const discontinuities = decodedAudioFrames.slice(1).flatMap((frame, index) => {
        const previous = decodedAudioFrames[index];
        const difference =
          Number(frame.best_effort_timestamp) - Number(previous.best_effort_timestamp) - previous.nb_samples;
        return difference ? [{ frameIndex: index + 1, differenceSamples: difference }] : [];
      });
      result.audioSamples.decodedTimeline = {
        frameCount: decodedAudioFrames.length,
        discontinuities,
        totalTimestampDiscontinuitySamples: discontinuities.reduce((total, item) => total + item.differenceSamples, 0),
        largestAbsoluteDiscontinuitySamples: Math.max(
          0,
          ...discontinuities.map((item) => Math.abs(item.differenceSamples)),
        ),
        interpretation:
          "Decoded sample-count precision is reported separately from exact video cadence and declared mux duration. Audio timestamps can retain sub-millisecond capture-container rounding. No acoustic alignment claim is made by these duration checks.",
      };
      assert(
        Math.abs(perChannelSamples - expectedSamples) < 1024,
        "Decoded audio duration must remain within one AAC frame of the declared presentation duration",
      );
      assert(nonzeroValues > 0, "The selected audible replay export must contain actual audio samples");
    }
    assert.equal(result.decodedContent.frameCount, expectedFrames);
    assert.equal(result.statsRegion.frameCount, expectedFrames);
    assert.equal(
      result.decodedContent.adjacentDuplicates,
      0,
      "This moving replay interval must not repeat an identical decoded frame",
    );
    assert(result.motion.changedPairsAbove01 > 0, "The decoded replay must contain actual visible motion");
    result.contentInterpretation =
      "Hashes are from actual decoded replay pixels, not synthetic frame IDs. Crop changes and downsampled motion describe visible content; lossy-codec pixel differences alone do not establish semantically unique states on every frame.";
    for (const index of [0, Math.floor(expectedFrames / 2), expectedFrames - 1]) {
      run(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-threads",
        "2",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${index})`,
        "-frames:v",
        "1",
        "-update",
        "1",
        "-threads:v",
        "2",
        path.join(evidence, `frame-${index}.png`),
      ]);
    }
    result.verified = true;
  } catch (error) {
    result.error = String(error.stack || error);
  }
  save(resultFile, result);
  return result;
}
for (const file of fs
  .readdirSync(directory)
  .filter((name) => /^rewind-.*\.mp4$/i.test(name))
  .sort()) {
  const result = verify(path.join(directory, file));
  aggregate.clips.push(result);
  console.log(
    JSON.stringify({
      file,
      verified: result.verified,
      expected: result.expected,
      content: result.decodedContent,
      stats: result.statsRegion,
      error: result.error,
    }),
  );
}
aggregate.verified = aggregate.clips.length > 0 && aggregate.clips.every((clip) => clip.verified);
aggregate.verificationScope =
  "Exact video cadence/count, clean whole-file decode, requested dimensions and presentation duration, evolving replay pixels and audible AAC where selected. Sample-exact audio duration is a separate stronger diagnostic.";
const audioClips = aggregate.clips.filter((clip) => clip.expected.hasAudio);
aggregate.strictAudioSampleCountsVerified =
  audioClips.length > 0 && audioClips.every((clip) => clip.strictAudioSampleCountVerified);
aggregate.maximumVerifiedFPS = Math.max(
  0,
  ...aggregate.clips.filter((clip) => clip.verified).map((clip) => clip.expected.fps),
);
aggregate.verified1080pRates = [
  ...new Set(
    aggregate.clips.filter((clip) => clip.verified && clip.expected.height === 1080).map((clip) => clip.expected.fps),
  ),
].sort((a, b) => a - b);
save(path.join(directory, "native-verification.json"), aggregate);
if (!aggregate.verified) process.exitCode = 1;
