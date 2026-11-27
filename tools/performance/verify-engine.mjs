// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const executable = process.argv[2];
assert(executable, 'Pass the published native executable path.');
const map = `osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
64,64,1000,1,0,0:0:0:0:
448,320,1200,1,0,0:0:0:0:
128,128,1400,1,0,0:0:0:0:
400,90,1600,1,0,0:0:0:0:
80,280,1800,1,0,0:0:0:0:
420,310,2000,1,0,0:0:0:0:
`;
const request = { id: 'native-publish-check', beatmap: map, calculations: [
  { mode: 'stable', mods: [], states: [{ time: 2050, passedObjects: 6, maxCombo: 6, statistics: { great: 6 }, isFinal: true }] },
  { mode: 'lazer', mods: [{ acronym: 'DT', settings: { speed_change: 1.2 } }], states: [{ time: 2050, passedObjects: 6, maxCombo: 6, statistics: { great: 6 }, isFinal: true }] },
  { mode: 'lazer-classic', mods: [{ acronym: 'CL' }, { acronym: 'RX' }], states: [{ time: 2050, passedObjects: 6, maxCombo: 6, statistics: { great: 6 }, isFinal: true }] },
  { mode: 'stable', mods: [{ acronym: 'RX' }], states: [{ time: 2050, passedObjects: 6, maxCombo: 6, statistics: { great: 6 }, isFinal: true }] }
] };
const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
const timer = setTimeout(() => child.kill(), 30_000);
const closed = new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Engine exit ${code}: ${stderr}`)));
});
child.stdin.end(JSON.stringify(request) + '\n');
try { await closed; } finally { clearTimeout(timer); }
const lines = stdout.trim().split(/\r?\n/);
assert.equal(lines.length, 1, 'Exactly one JSON response; no diagnostic stdout.');
const response = JSON.parse(lines[0]);
assert.equal(response.id, request.id);
assert.equal(response.ok, true, response.error);
assert.equal(response.engineVersion, '2026.730.0-official-pp-v9');
assert.equal(response.timelines.length, 4);
for (const result of response.timelines) {
  assert.equal(result.error, null);
  assert.equal(result.endpointVerified, true);
  assert.equal(result.effectiveMissCount, 0, 'A full combo of 300s has no effective misses.');
  assert(!('effectiveMissCount' in result.fullDifficulty), 'The effective miss count is a timeline field, not a difficulty field.');
  assert(Number.isFinite(result.final.pp) && result.final.pp > 0);
  assert(Number.isFinite(result.final.sr) && result.final.sr > 0);
  assert.deepEqual(Object.keys(result.fullDifficulty).sort(), ['aim', 'flashlight', 'reading', 'sliderFactor', 'speed', 'total']);
  assert(Object.values(result.fullDifficulty).every(value => Number.isFinite(value) && value >= 0));
  assert.equal(result.fullDifficulty.total, result.final.sr);
  assert.equal(result.difficultyPoints.length, 6);
  assert.equal(result.difficultyPoints.at(-1).sr, result.final.sr);
  assert.equal(result.difficultyPoints.at(-1).time, 2000, 'Custom rate must retain map-time timestamps.');
}
assert.equal(response.timelines[0].final.pp, response.timelines[2].final.pp, 'Relax uses normal PP.');
assert.notEqual(response.timelines[0].final.sr, response.timelines[2].final.sr, 'Relax retains its official difficulty calculation.');
assert.equal(response.timelines[0].final.sr, response.timelines[3].final.sr, 'Stable Relax displays normal star rating.');
assert.deepEqual(response.timelines[0].fullDifficulty, response.timelines[3].fullDifficulty, 'Stable Relax retains normal full-map components.');
assert.notEqual(response.timelines[0].fullDifficulty.speed, response.timelines[2].fullDifficulty.speed, 'Native Relax breakdown retains its official displayed speed difficulty.');
assert.equal(response.timelines[2].final.pp, response.timelines[3].final.pp, 'Stable and Classic Relax use normal PP attributes.');
assert.notEqual(response.timelines[0].final.sr, response.timelines[1].final.sr, 'Custom rate must affect difficulty.');
console.log('Published native engine passed JSON-lines protocol, official endpoints, custom rate and normal Relax PP.');
