const assert = require("assert").strict;
const path = require("path");
const { spawnSync } = require("child_process");

const directory = path.resolve(process.argv[2] || "tmp/replay-export-speed-package/win-unpacked");
const archive = path.join(directory, "resources/app.asar");
assert.equal(typeof require(path.join(archive, "node_modules/lzma")).decompress, "function");
assert.equal(typeof require(path.join(archive, "node_modules/node-osr")).readSync, "function");
const map =
  "osu file format v14\n[General]\nMode:0\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,64,1000,1,0,0:0:0:0:\n448,320,1200,1,0,0:0:0:0:\n";
const request = {
  beatmap: map,
  calculations: [
    {
      mode: "lazer",
      mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }],
      states: [{ time: 1200, passedObjects: 2, maxCombo: 2, statistics: { great: 2 }, isFinal: true }],
    },
  ],
};
const child = spawnSync(path.join(directory, "resources/performance-engine/RewindPerformance.exe"), [], {
  input: JSON.stringify(request) + "\n",
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
  env: { ...process.env, DOTNET_ROOT: "", DOTNET_ROOT_X64: "" },
});
assert.equal(child.error, undefined);
assert.equal(child.status, 0, child.stderr);
const response = JSON.parse(child.stdout);
assert.equal(response.ok, true, response.error);
assert.equal(response.engineVersion, "2026.730.0-official-pp-v9");
assert.equal(response.timelines[0].error, null);
assert.equal(response.timelines[0].endpointVerified, true);
assert(response.timelines[0].final.pp > 0 && response.timelines[0].final.sr > 0);
assert.deepEqual(Object.keys(response.timelines[0].fullDifficulty).sort(), ["aim", "flashlight", "reading", "sliderFactor", "speed", "total"]);
assert(Object.values(response.timelines[0].fullDifficulty).every(value => Number.isFinite(value) && value >= 0));
assert.equal(response.timelines[0].fullDifficulty.total, response.timelines[0].final.sr);
assert.equal(response.timelines[0].difficultyPoints.length, 2);
assert.equal(response.timelines[0].difficultyPoints[1].sr, response.timelines[0].final.sr);
console.log(
  JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    replayDependencies: true,
    selfContainedEngine: true,
    final: response.timelines[0].final,
  }),
);
