/* SPDX-License-Identifier: MIT
 * Headless integration: real replay reconstruction -> main-process worker ->
 * official native difficulty/performance engine. No GUI or external fixtures.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "../..");
process.chdir(root);
require("reflect-metadata");
require("ts-node").register({
  transpileOnly: true,
  project: path.join(root, "tsconfig.base.json"),
  compilerOptions: { module: "commonjs", experimentalDecorators: true, emitDecoratorMetadata: true },
});
const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.base.json"), "utf8"));
require("tsconfig-paths").register({ baseUrl: root, paths: tsconfig.compilerOptions.paths });

const { buildBeatmap, parseBlueprint, HitCircle, Slider, Spinner, OsuAction } = require("@osujs/core");
const { legacyModsFromLazerMods } = require("../../apps/desktop/frontend/src/app/model/OsuReplay.ts");
const { GameSimulator } = require("../../apps/desktop/frontend/src/app/services/common/game/GameSimulator.ts");
const { PerformanceWorker } = require("../../apps/desktop/main/src/app/performance-worker.ts");
const { performanceAt, starRatingAt, PERFORMANCE_ENGINE_VERSION } = require("@rewind/osu-performance/protocol");

const mapHeader = `osu file format v14
[General]
AudioFilename:test.mp3
Mode:0
[Metadata]
Title:Rewind performance pipeline fixture
Artist:Rewind tests
Creator:Rewind tests
Version:Integration
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
`;
const mixedMap =
  mapHeader +
  `100,100,1000,1,0,0:0:0:0:
100,200,1500,2,0,L|300:200,2,200
350,250,2100,1,0,0:0:0:0:
400,100,3300,2,0,L|200:100,1,200
256,192,4500,8,0,5500
256,192,6000,1,0,0:0:0:0:
`;

function fixture(raw, mods, native, end = 6600, manyCircles = false) {
  const legacyMods = legacyModsFromLazerMods(mods);
  const started = performance.now();
  const beatmap = buildBeatmap(parseBlueprint(raw), { mods: legacyMods, ...(native ? { lazerMods: mods } : {}) });
  const frames = [];
  if (manyCircles) {
    frames.push({ time: 0, position: { x: 0, y: 0 }, actions: [] });
    for (const object of beatmap.hitObjects) {
      frames.push({ time: object.hitTime, position: object.position, actions: [OsuAction.leftButton] });
      frames.push({ time: object.hitTime + 1, position: object.position, actions: [] });
    }
    frames.push({ time: end, position: { x: 0, y: 0 }, actions: [] });
  } else {
    const times = new Set([0, end]);
    for (let time = 0; time <= end; time += 10) times.add(time);
    for (const object of beatmap.hitObjects) {
      const objectStart = object instanceof HitCircle ? object.hitTime : object.startTime;
      if (objectStart <= end) times.add(objectStart);
      if (!(object instanceof HitCircle) && object.endTime <= end) times.add(object.endTime);
    }
    for (const time of [...times].sort((a, b) => a - b)) {
      let position = { x: 0, y: 0 };
      let actions = [];
      const slider = beatmap.hitObjects.find(
        (object) => object instanceof Slider && time >= object.startTime && time <= object.endTime,
      );
      const spinner = beatmap.hitObjects.find(
        (object) => object instanceof Spinner && time >= object.startTime && time <= object.endTime,
      );
      if (slider) {
        position = slider.ballPositionAt((time - slider.startTime) / slider.duration);
        // A real tracking break exercises effective misses, repeated sliders,
        // tick/repeat loss, tail judgement, and Classic proportional grades.
        if (!(time >= 1980 && time < 2200)) actions = [OsuAction.leftButton];
      } else if (spinner) {
        const angle = ((time - spinner.startTime) / 1000) * Math.PI * 2 * 5;
        position = { x: 256 + Math.cos(angle) * 80, y: 192 + Math.sin(angle) * 80 };
        actions = [OsuAction.leftButton];
      }
      const circle = beatmap.hitObjects.find(
        (object) => object instanceof HitCircle && time === object.hitTime + (object.hitTime === 6000 ? 60 : 0),
      );
      if (circle) {
        position = circle.position;
        actions = slider ? [OsuAction.leftButton, OsuAction.rightButton] : [OsuAction.leftButton];
      }
      frames.push({ time, position, actions });
    }
  }
  const replay = {
    gameMode: 0,
    gameVersion: native ? 30_000_019 : 20_260_904,
    player: "Pipeline fixture",
    md5hash: "pipeline-fixture",
    beatmapMd5: "pipeline-fixture-map",
    mods: legacyMods,
    ...(native ? { lazerMods: mods } : {}),
    frames,
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, beatmap, replay, simulationMs: performance.now() - started };
}

function requireClose(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-10),
    `${label}: ${actual} != ${expected}`,
  );
}

async function main() {
  const published = path.join(root, "resources/performance-engine/RewindPerformance.exe");
  const framework = path.join(root, "engine/RewindPerformance/bin/Release/net8.0/RewindPerformance.exe");
  const executable = process.env.REWIND_PERFORMANCE_ENGINE || (fs.existsSync(published) ? published : framework);
  assert.ok(fs.existsSync(executable), "Build the performance engine before running pipeline verification.");
  if (executable === framework && !process.env.DOTNET_ROOT) {
    process.env.DOTNET_ROOT = path.join(process.env.LOCALAPPDATA, "Microsoft/dotnet");
  }
  const worker = new PerformanceWorker(() => executable);
  const report = {
    generatedAt: new Date().toISOString(),
    engineVersion: PERFORMANCE_ENGINE_VERSION,
    executable,
    cases: [],
  };
  let owner = 1;
  try {
    const cases = [
      { name: "Stable no mods", mods: [], native: false },
      { name: "Stable HD HR DT", mods: [{ acronym: "HD" }, { acronym: "HR" }, { acronym: "DT" }], native: false },
      ...["RX", "AP", "AT", "SO"].map((acronym) => ({
        name: `Stable automated ${acronym}`,
        mods: [{ acronym }],
        native: false,
        unrankedMod: acronym,
      })),
      ...["RX", "AP", "AT", "SO"].map((acronym) => ({
        name: `Native automated ${acronym}`,
        mods: [{ acronym }],
        native: true,
        unrankedMod: acronym,
      })),
      { name: "Native lazer", mods: [], native: true },
      {
        name: "Native custom DT and DA",
        mods: [
          { acronym: "DT", settings: { speed_change: 1.2 } },
          { acronym: "DA", settings: { circle_size: 6, approach_rate: 9.3, overall_difficulty: 7.2 } },
        ],
        native: true,
      },
      {
        name: "Native custom HT and DA",
        mods: [
          { acronym: "HT", settings: { speed_change: 0.65 } },
          { acronym: "DA", settings: { circle_size: 3.5, approach_rate: 7, overall_difficulty: 6 } },
        ],
        native: true,
      },
      {
        name: "Classic custom DT",
        mods: [{ acronym: "CL" }, { acronym: "DT", settings: { speed_change: 1.35 } }],
        native: true,
      },
      {
        name: "Classic head accuracy enabled with DA HT",
        mods: [
          { acronym: "CL", settings: { no_slider_head_accuracy: false } },
          { acronym: "HT", settings: { speed_change: 0.6 } },
          { acronym: "DA", settings: { overall_difficulty: 8 } },
        ],
        native: true,
      },
      { name: "Failed native replay in second slider", mods: [], native: true, end: 3800 },
      { name: "Failed Stable replay in second slider", mods: [], native: false, end: 3800 },
      { name: "Failed Classic replay in second slider", mods: [{ acronym: "CL" }], native: true, end: 3800 },
      { name: "Failed native replay before first object", mods: [], native: true, end: 500 },
      {
        name: "Failed native custom DT DA",
        mods: [
          { acronym: "DT", settings: { speed_change: 1.2 } },
          { acronym: "DA", settings: { overall_difficulty: 7.2 } },
        ],
        native: true,
        end: 3800,
      },
      {
        name: "Failed native custom HT",
        mods: [{ acronym: "HT", settings: { speed_change: 0.65 } }],
        native: true,
        end: 3800,
      },
    ];
    for (const sample of cases) {
      const end = sample.end ?? 6600;
      const prepared = fixture(mixedMap, sample.mods, sample.native, end);
      const inputs = prepared.simulator.getPerformanceInputs();
      if (process.env.REWIND_PIPELINE_DEBUG) {
        process.stdout.write(
          JSON.stringify({
            name: sample.name,
            objects: prepared.beatmap.hitObjects.map((object) => ({
              id: object.id,
              type: object.type,
              start: object.hitTime ?? object.startTime,
              end: object.endTime,
            })),
            states: inputs.map((input) => ({
              mode: input.mode,
              count: input.states.length,
              limitations: input.limitations,
            })),
            frames: prepared.replay.frames.length,
            validation: prepared.simulator.validation$.value,
          }) + "\n",
        );
      }
      const expectedModeCount = sample.expectedModeCount ?? 2;
      assert.equal(inputs.length, expectedModeCount, `${sample.name}: expected analysis modes must be present`);
      if (sample.unrankedMod) {
        assert.equal(inputs[0].mode, "stable", `${sample.name}: Stable analysis must remain available`);
        assert.equal(inputs[1].mode, "lazer", `${sample.name}: Lazer analysis must be available`);
        for (const input of inputs) {
          assert.deepEqual(input.mods, sample.mods, `${sample.name}: retain the automation mod for calculation`);
        }
      }
      const request = {
        beatmap: mixedMap,
        calculations: inputs.map(({ mode, mods, states }) => ({ mode, mods, states })),
      };
      const started = performance.now();
      const response = await worker.calculate(owner++, request);
      const calculationMs = performance.now() - started;
      assert.equal(response.ok, true, `${sample.name}: ${response.error}`);
      assert.equal(response.engineVersion, PERFORMANCE_ENGINE_VERSION);
      assert.equal(response.timelines.length, expectedModeCount, `${sample.name}: all requested modes must return`);
      if (sample.mods.some((mod) => mod.acronym === "RX")) {
        const normalResponse = await worker.calculate(owner++, {
          ...request,
          calculations: request.calculations.map((calculation) => ({
            ...calculation,
            mods: calculation.mods.filter((mod) => mod.acronym !== "RX"),
          })),
        });
        assert.equal(normalResponse.ok, true, `${sample.name}: normal PP comparison succeeds`);
        response.timelines.forEach((timeline, modeIndex) => {
          const normal = normalResponse.timelines[modeIndex];
          assert.ok(normal.error == null, normal.error);
          timeline.points.forEach((point, index) =>
            requireClose(point.pp, normal.points[index].pp, `${sample.name}: normal PP at ${point.time}`),
          );
        });
      }
      if (expectedModeCount === 2) {
        if (sample.mods.some((mod) => mod.acronym === "RX")) {
          assert.notDeepEqual(
            response.timelines[0].difficultyPoints,
            response.timelines[1].difficultyPoints,
            `${sample.name}: Stable ignores Relax only for displayed SR`,
          );
        } else {
          assert.deepEqual(
            response.timelines[0].difficultyPoints,
            response.timelines[1].difficultyPoints,
            `${sample.name}: equivalent Stable/lazer mods have the same timed SR`,
          );
        }
      }
      const timelines = response.timelines.map((timeline) => {
        assert.ok(timeline.error == null, `${sample.name}/${timeline.mode}: ${timeline.error}`);
        const input = inputs.find((candidate) => candidate.mode === timeline.mode);
        assert.equal(timeline.points.length, input.states.length);
        assert.equal(timeline.objectCount, prepared.beatmap.hitObjects.length);
        const last = performanceAt(timeline.points, end);
        if (timeline.points.length) assert.equal(last.time, end);
        requireClose(last.pp, timeline.final.pp, `${sample.name}: final PP`);
        assert.equal(timeline.difficultyPoints.length, prepared.beatmap.hitObjects.length);
        const finalDifficulty = starRatingAt(timeline.difficultyPoints, Infinity);
        assert.equal(finalDifficulty.sr, timeline.final.sr, `${sample.name}: exact full-map SR`);
        if (sample.unrankedMod) {
          assert.ok(Number.isFinite(last.pp) && last.pp > 0, `${sample.name}: final PP must be positive`);
          assert.ok(
            Number.isFinite(finalDifficulty.sr) && finalDifficulty.sr > 0,
            `${sample.name}: final SR must be positive`,
          );
        }
        assert.equal(starRatingAt(timeline.difficultyPoints, -1).sr, 0);
        if (sample.end !== undefined) {
          assert(finalDifficulty.time > end, `${sample.name}: SR must continue after failure`);
          assert.notEqual(starRatingAt(timeline.difficultyPoints, end).sr, finalDifficulty.sr);
          assert.equal(performanceAt(timeline.points, finalDifficulty.time).pp, last.pp, "PP stays at achieved value");
        }
        assert.equal(timeline.endpointVerified, sample.end === undefined);
        assert.equal(performanceAt(timeline.points, -1).pp, 0);
        assert.equal(performanceAt(timeline.points, end), last);
        return {
          mode: timeline.mode,
          mods: input.mods,
          pointCount: timeline.points.length,
          difficultyPointCount: timeline.difficultyPoints.length,
          difficultyEndTime: finalDifficulty.time,
          passedObjects: input.states[input.states.length - 1]?.passedObjects ?? 0,
          final: timeline.final,
          endpointVerified: timeline.endpointVerified,
          limitations: input.limitations,
        };
      });
      const cacheStarted = performance.now();
      assert.equal(
        await worker.calculate(owner++, request),
        response,
        `${sample.name}: worker cache should reuse response`,
      );
      report.cases.push({
        name: sample.name,
        simulationMs: prepared.simulationMs,
        calculationMs,
        cachedMs: performance.now() - cacheStarted,
        timelines,
      });
      prepared.simulator.clear();
      process.stdout.write(`PASS ${sample.name}\n`);
    }

    const count = 1000;
    const benchmarkMap =
      mapHeader +
      Array.from(
        { length: count },
        (_, index) => `${64 + (index % 7) * 60},${64 + (index % 5) * 55},${1000 + index * 80},1,0,0:0:0:0:`,
      ).join("\n") +
      "\n";
    const end = 1000 + count * 80;
    const benchmark = fixture(benchmarkMap, [], false, end, true);
    const inputs = benchmark.simulator.getPerformanceInputs();
    const request = {
      beatmap: benchmarkMap,
      calculations: inputs.map(({ mode, mods, states }) => ({ mode, mods, states })),
    };
    const started = performance.now();
    const response = await worker.calculate(owner++, request);
    const calculationMs = performance.now() - started;
    assert.equal(response.ok, true, response.error);
    for (const timeline of response.timelines) {
      assert.ok(timeline.error == null, timeline.error);
      assert.equal(timeline.endpointVerified, true);
    }
    const points = response.timelines[0].points;
    const difficultyPoints = response.timelines[0].difficultyPoints;
    const lookups = 200000;
    let checksum = 0;
    const lookupStarted = performance.now();
    for (let index = 0; index < lookups; index++) {
      const time = index % end;
      checksum += performanceAt(points, time).pp + starRatingAt(difficultyPoints, time).sr;
    }
    const lookupMs = performance.now() - lookupStarted;
    assert.ok(Number.isFinite(checksum));
    report.benchmark = {
      objects: count,
      replayFrames: benchmark.replay.frames.length,
      modes: inputs.length,
      simulationMs: benchmark.simulationMs,
      calculationMs,
      requestBytes: Buffer.byteLength(JSON.stringify(request)),
      responseBytes: Buffer.byteLength(JSON.stringify(response)),
      lookups,
      lookupMs,
      averageLookupMicroseconds: (lookupMs * 1000) / lookups,
      checksum,
    };
    benchmark.simulator.clear();
    const output = path.resolve(root, process.argv[2] || "tmp/performance-pipeline-validation.json");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(
      `PASS 1000-object benchmark; ${lookups} paired PP/SR lookups in ${lookupMs.toFixed(2)} ms\n${output}\n`,
    );
  } finally {
    worker.dispose();
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + "\n");
  process.exitCode = 1;
});
