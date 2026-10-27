import { createHash } from "crypto";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { buildAggregatePerformanceRequest, buildAggregatePerformanceCalculation, readAggregatePerformanceResult, AggregatePerformanceInput } from "./library-aggregate-performance";

const mapText = "osu file format v14\n[General]\nMode:0\n[Difficulty]\nCircleSize:4\nOverallDifficulty:6\nApproachRate:7\nHPDrainRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n[TimingPoints]\n0,500,4,2,1,50,1,0\n[HitObjects]\n64,64,1000,1,0,0:0:0:0:\n256,192,1500,1,0,0:0:0:0:\n448,320,2000,1,0,0:0:0:0:\n";
const input = (): AggregatePerformanceInput => ({ map: { text: mapText, sha256: createHash("sha256").update(mapText).digest("hex"), ruleset: 0,
  objectCount: 3, aggregateTimeMs: 2000 }, score: { mode: "stable", basic: [2, 1, 0, 0], maxCombo: 3, evidenceKey: "saved-v1" }, mods: [], profileKey: "stable-v1" });
const expected = { mode: "stable" as const, objectCount: 3, time: 2000 };
const response = () => ({ ok: true, engineVersion: PERFORMANCE_ENGINE_VERSION, timelines: [{ mode: "stable", objectCount: 3, endpointVerified: true,
  points: [{ time: 2000, pp: 3, sr: 1 }], final: { pp: 3, sr: 1 }, difficultyPoints: [] }] });

it("builds one aggregate state from complete Stable counts without inventing a replay timeline", () => {
  const result = buildAggregatePerformanceRequest(input()); expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error(result.reason);
  expect(result.request.calculations).toEqual([{ mode: "stable", scope: "full-map", mods: [], states: [{ time: 2000, passedObjects: 3, maxCombo: 3,
    statistics: { great: 2, ok: 1, meh: 0, miss: 0, large_tick_hit: 0, large_tick_miss: 0, small_tick_hit: 0, small_tick_miss: 0,
      slider_tail_hit: 0, slider_tail_miss: 0 } }] }]);
  expect(result).not.toHaveProperty("completion"); expect(result).not.toHaveProperty("peakPp"); expect(result).not.toHaveProperty("fc");
});
it("builds the same bounded calculation from an exact descriptor without transferring map text",()=>{
  const source=input(),request=buildAggregatePerformanceRequest(source);
  const calculation=buildAggregatePerformanceCalculation({...source,map:{sha256:source.map.sha256,ruleset:0,objectCount:3,aggregateTimeMs:2000}});
  expect(calculation.state).toBe("ready");
  if(calculation.state!=="ready"||request.state!=="ready")throw new Error("Expected complete calculation");
  expect(calculation.inputKey).toBe(request.inputKey);expect(calculation.calculation).toEqual(request.request.calculations[0]);
});
it("refuses a supplied text body that does not match its exact descriptor",()=>{
  const value=input();value.map.text+="\n";expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
});

it.each([[1, 0, 0, 0], [4, 0, 0, 0], [-1, 4, 0, 0], [1.5, 1.5, 0, 0], [2147483648, 0, 0, 0]].map(basic => ({ basic })))("rejects partial, excessive or invalid aggregate counts %j", ({ basic }) => {
  const value = input(); value.score = { mode: "stable", basic: basic as [number, number, number, number], maxCombo: 3, evidenceKey: "x" };
  expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
});

it("preserves a genuine ScoreV1 total separately from its absence", () => {
  const missing = buildAggregatePerformanceRequest(input());
  const value = input(); value.score = { ...value.score, mode: "stable", basic: [2, 1, 0, 0], legacyScoreV1: 123456 };
  const present = buildAggregatePerformanceRequest(value);
  expect(present.state).toBe("ready");
  if (present.state === "ready") expect(present.request.calculations[0].states[0].legacyTotalScore).toBe(123456);
  if (missing.state === "ready" && present.state === "ready") expect(missing.inputKey).not.toBe(present.inputKey);
});

it("retains native settings, collapses implied mods, and rejects missing or conflicting profile settings", () => {
  const value = input(); value.mods = [{ acronym: "DT" }, { acronym: "NC", settings: { speed_change: 1.25 } }, { acronym: "SD" }, { acronym: "PF" }, { acronym: "CL" }];
  const result = buildAggregatePerformanceRequest(value);
  if (result.state !== "ready") throw new Error(result.reason);
  expect(result.request.calculations[0].mods).toEqual([{ acronym: "NC", settings: { speed_change: 1.25 } }, { acronym: "PF" }]);
  value.mods = null; expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
});

it.each(["V2", "SV2"])("refuses a purported ScoreV1 total combined with %s while retaining official fallback", acronym => {
  const value = input(); value.mods = [{ acronym }];
  expect(buildAggregatePerformanceRequest(value).state).toBe("ready");
  value.score = { mode: "stable", basic: [2, 1, 0, 0], maxCombo: 3, evidenceKey: "v2", legacyScoreV1: 123 };
  expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
});

it("requires explicitly qualified complete native component counts instead of zero-filling Realm statistics", () => {
  const value = input(); value.score = { mode: "lazer", statistics: { great: 2, ok: 1, meh: 0, miss: 0 }, maxCombo: 3,
    evidenceKey: "native-v1", componentsQualified: false };
  expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
  value.score = { ...value.score, componentsQualified: true, statistics: { great: 2, ok: 1, meh: 0, miss: 0,
    large_tick_hit: 0, large_tick_miss: 0, small_tick_hit: 0, small_tick_miss: 0, slider_tail_hit: 0, slider_tail_miss: 0 } };
  expect(buildAggregatePerformanceRequest(value).state).toBe("ready");
  value.mods = [{ acronym: "CL" }]; expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
  value.score.mode = "lazer-classic"; expect(buildAggregatePerformanceRequest(value).state).toBe("ready");
  value.mods = []; expect(buildAggregatePerformanceRequest(value).state).toBe("unknown");
});

it("keys actual map text, map identity, settings, profile and score evidence without classifier inputs", () => {
  const first = buildAggregatePerformanceRequest(input()); if (first.state !== "ready") throw new Error(first.reason);
  for (const change of [
    (value: AggregatePerformanceInput) => { value.map.text += "\n";value.map.sha256=createHash("sha256").update(value.map.text).digest("hex"); },
    (value: AggregatePerformanceInput) => { value.profileKey = "stable-v2"; },
    (value: AggregatePerformanceInput) => { value.score.evidenceKey = "changed-osg"; },
    (value: AggregatePerformanceInput) => { value.mods = [{ acronym: "DT", settings: { speed_change: 1.25 } }]; },
  ]) {
    const value = input(); change(value); const result = buildAggregatePerformanceRequest(value);
    if (result.state !== "ready") throw new Error(result.reason); expect(result.inputKey).not.toBe(first.inputKey);
  }
});

it("reads only a verified complete aggregate response and retains legitimate pp zero", () => {
  expect(readAggregatePerformanceResult(response(), expected)).toEqual({ state: "known", value: 3 });
  const zero = response(); zero.timelines[0].points[0].pp = 0; zero.timelines[0].final.pp = 0;
  expect(readAggregatePerformanceResult(zero, expected)).toEqual({ state: "known", value: 0 });
});

it("accepts exactly the native endpoint tolerance", () => {
  const value = response(); value.timelines[0].points[0].pp += 8e-9;
  expect(readAggregatePerformanceResult(value, expected)).toEqual({ state: "known", value: 3 });
  value.timelines[0].points[0].pp += 8e-9;
  expect(readAggregatePerformanceResult(value, expected).state).toBe("unknown");
});

it.each([
  (value: ReturnType<typeof response>) => { value.engineVersion = "old"; },
  (value: ReturnType<typeof response>) => { value.timelines[0].endpointVerified = false; },
  (value: ReturnType<typeof response>) => { value.timelines[0].objectCount = 2; },
  (value: ReturnType<typeof response>) => { value.timelines[0].points = []; },
  (value: ReturnType<typeof response>) => { value.timelines[0].points[0].pp = Infinity; },
  (value: ReturnType<typeof response>) => { value.timelines[0].points[0].time = 1999; },
  (value: ReturnType<typeof response>) => { value.timelines[0].final.pp = 5; },
  (value: ReturnType<typeof response>) => { Object.assign(value.timelines[0], { error: "Missing native statistics" }); },
])("does not accept wrong engine, partial endpoint, empty/error or conflicting scalar output", change => {
  const value = response(); change(value); expect(readAggregatePerformanceResult(value, expected).state).toBe("unknown");
});
