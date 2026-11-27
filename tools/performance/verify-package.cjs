const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert").strict;
const asar = require("@electron/asar");

const directory = path.resolve(process.argv[2] || "dist/win-unpacked");
const archive = path.join(directory, "resources/app.asar");
const files = asar.listPackage(archive).map((name) => name.replaceAll("\\", "/"));
const html = asar.extractFile(archive, "frontend/index.html").toString();
const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map((match) => match[1].replace(/^\.\//, ""));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
assert(assets.length > 0);
const frontendAssets = assets.map((asset) => {
  assert(files.includes("/frontend/" + asset), asset);
  const packaged = hash(asar.extractFile(archive, "frontend/" + asset));
  assert.equal(packaged, hash(fs.readFileSync(path.join("dist/apps/desktop/frontend", asset))));
  return { asset, sha256: packaged };
});
const mainAsset = assets.find((asset) => asset.startsWith("main."));
const renderer = asar.extractFile(archive, "frontend/" + mainAsset).toString();
for (const marker of ["Replay stats", "performancePointsEnabled"])
  assert(renderer.includes(marker), `packaged renderer contains live PP readout marker ${marker}`);
assert(renderer.includes("2026.730.0-official-pp-v9"));
for (const marker of ["urMultiplier", "successfulOffsets", "waitForSettled", "beginCaptureLayers"])
  assert(renderer.includes(marker), `packaged renderer contains replay/export speed marker ${marker}`);
for (const marker of ["appendClipExportFrame", "data-range-fields", "Length", "Rendering frames", "Clip saved", "Open clip"])
  assert(renderer.includes(marker), `packaged renderer contains deterministic export marker ${marker}`);
const mainBytes = asar.extractFile(archive, "index.js");
const main = mainBytes.toString();
const mainSha256 = hash(mainBytes);
assert.equal(mainSha256, hash(fs.readFileSync("dist/apps/desktop/index.js")), "packaged main matches production build");
for (const marker of [
  "performance-engine",
  "clip-media",
  "ffmpeg.exe",
  "+faststart",
  "-protocol_whitelist",
  "0:a:0?",
  "MP4 finalization produced no video data.",
  "appendClipExportFrame",
  "rawvideo",
  "libx264",
  "-framerate",
  "-video_track_timescale",
  "Video frame chunks arrived out of order or with an invalid size.",
  "complete frames before saving.",
])
  assert(main.includes(marker), `packaged main contains ${marker}`);
assert(files.includes("/node_modules/lzma/index.js"));
assert(fs.existsSync(path.join(directory, "resources/Skins")));

const engineDirectory = path.join(directory, "resources/performance-engine");
const nativePolicy = require('./realm-no-conversion/package.cjs').verifyArtifact(engineDirectory);
const engineFiles = [];
function verifyEngine(relative = "") {
  for (const entry of fs.readdirSync(path.join("resources/performance-engine", relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) verifyEngine(name);
    else {
      const original = fs.readFileSync(path.join("resources/performance-engine", name));
      const packaged = fs.readFileSync(path.join(engineDirectory, name));
      assert.equal(hash(packaged), hash(original), name);
      engineFiles.push({ file: name, bytes: packaged.length, sha256: hash(packaged) });
    }
  }
}
verifyEngine();
assert(engineFiles.some(({ file }) => file === "RewindPerformance.exe"));
assert(engineFiles.some(({ file }) => file === "dependency-licenses.json"));
assert(engineFiles.some(({ file }) => file === "THIRD_PARTY_NOTICES.md"));
const verifiedMedia = require('../media/verify-runtime.cjs').verifyMedia(directory);
const clipMediaManifest = verifiedMedia.manifest;
const clipMediaFiles = verifiedMedia.rows
  .filter(row => row.file.startsWith('resources/clip-media/'))
  .map(row => ({ ...row, file: row.file.slice('resources/clip-media/'.length) }));
// Source hashes record the inspected workspace alongside compiled-asset hashes;
// they are an audit snapshot, not a substitute for the production build above.
const deterministicSources = [
  ["apps/desktop/frontend/src/app/services/manager/ClipRecorder.ts", "appendClipExportFrame"],
  ["apps/desktop/frontend/src/app/services/manager/clip-export-types.ts", "createClipFramePlan"],
  ["apps/desktop/frontend/src/app/services/manager/ClipExportRenderer.ts", "readFrame"],
  ["apps/desktop/frontend/src/app/services/common/game/GameplayClock.ts", "beginOfflineCapture"],
  ["apps/desktop/frontend/src/app/services/common/game/GameLoop.ts", "beginOfflineCapture"],
  ["apps/desktop/frontend/src/app/services/renderers/components/hud/TimingHitIndex.ts", "urMultiplier"],
  ["apps/desktop/frontend/src/app/services/analysis/performance/PerformanceTimelineService.ts", "waitForSettled"],
  ["apps/desktop/frontend/src/app/services/manager/ScenarioManager.ts", "performanceTimeline.load"],
  ["apps/desktop/frontend/src/app/hooks/readout.ts", "performanceTimeline.changed$"],
  ["apps/desktop/frontend/src/app/services/analysis/readout-source.ts", "performanceTimeline.at(ruleset, deps.gameClock.timeElapsedInMs)"],
  ["apps/desktop/frontend/src/app/services/renderers/components/stage/AnalysisStage.ts", "beginCaptureLayers"],
  ["apps/desktop/main/src/app/performance-worker.ts", "MAX_PROCESS_REQUESTS"],
  ["apps/desktop/frontend/src/app/services/analysis/scenes/AnalysisScene.ts", "gameSimulator.simulate"],
  ["apps/desktop/frontend/src/app/components/export/ExportPanel.tsx", "createClipFramePlan", "withClipLength(range, seconds, playbackRate, durationMs)"],
  ["apps/desktop/frontend/src/app/api.ts", "appendClipExportFrame"],
  ["apps/desktop/shared/clip-export.ts", "MAX_CLIP_VIDEO_FRAMES"],
  ["apps/desktop/main/src/app/events.ts", 'ipcMain.handle("appendClipExportFrame"'],
  ["apps/desktop/main/src/app/clip-export.ts", "appendFrame"],
  ["apps/desktop/main/src/app/clip-frame-encoder.ts", "FFmpegClipFrameEncoder"],
].map(([file, ...markers]) => {
  const bytes = fs.readFileSync(file);
  const source = bytes.toString();
  for (const marker of markers) assert(source.includes(marker), `deterministic source ${file} contains ${marker}`);
  return { file, bytes: bytes.length, sha256: hash(bytes) };
});
const result = {
  directory,
  executableSha256: hash(fs.readFileSync(path.join(directory, "Hindsight.exe"))),
  asarSha256: hash(fs.readFileSync(archive)),
  mainSha256,
  frontendAssets,
  engineFileCount: engineFiles.length,
  engineBytes: engineFiles.reduce((sum, file) => sum + file.bytes, 0),
  engineFiles,
  nativePolicy,
  clipMediaManifest,
  clipMediaFiles,
  mediaNotices: verifiedMedia.rows.filter(row => row.file.startsWith('resources/third-party-notices/')),
  deterministicSources,
};
const output = process.argv[3] || "tmp/package-validation.json";
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    directory,
    frontendAssets: frontendAssets.length,
    engineFiles: engineFiles.length,
    clipMediaFiles: clipMediaFiles.length,
    result: output,
  }),
);
