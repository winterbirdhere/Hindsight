import type { ReplayHeader } from "@rewind/osu-local/osr-reader/header";
import type { LibrarySavedScore } from "@rewind/osu-local/db-reader/library-scores";
import type { LazerSourceScore } from "./sources/lazer-source";
import { metricInputKey, projectStableHeader, projectStableScore, projectNativeScore, projectStableMap, projectNativeMap } from "./library-source-metrics";

const sha = "a".repeat(64), md5 = "b".repeat(32), schema = "c".repeat(64);
const profile = { client: "stable" as const, key: "stable-source-v1" };
const header: ReplayHeader = { mode: 0, version: 20260101, beatmapMD5: md5, player: "P", replayMD5: "legacy",
  counts: { great: 90, ok: 5, meh: 3, miss: 2, geki: 0, katu: 0 }, score: 123, maxCombo: 80,
  perfectComboFlag: true, modsBitmask: 0, playedAtTicks: "638961337234567891", compressedFrames: { offset: 70, length: 10 },
  sourceFormat: "stable", nativeScoreInfo: false };
const native: LazerSourceScore = { id: "id", playedAtTicks: header.playedAtTicks, player: "P", ruleset: 0, clientVersion: "2026.730.0",
  isLegacyScore: false, maxCombo: 100, accuracy: 0.95, rank: 3, pp: 123, mods: [{ acronym: "DT", settings: { speed_change: 1.25 } }],
  statistics: { Great: 90, Ok: 5, Meh: 3, Miss: 2 }, maximumStatistics: { Great: 100 },
  replay: { status: "missing" }, beatmap: { status: "missing", md5 }, assets: [] };

it("projects saved standard counts without simulation, FC or inferred completion", () => {
  const result = projectStableHeader({ header, replaySha256: sha, profile });
  expect(result).toMatchObject({ slot: "source-score", stage: "H", provenance: { replaySha256: sha }, fields: {
    maxCombo: { state: "known", value: 80 }, misses: { state: "known", value: 2 },
    completion: { state: "unknown" }, grade: { state: "known", value: "B" }, sourcePp: { state: "unknown" },
  } });
  expect(result.fields.accuracy).toEqual({ state: "known", value: 27650 / 30000 });
  expect(result.fields).not.toHaveProperty("fc"); expect(result.fields).not.toHaveProperty("perfectCombo");
});

it.each(["unknown", "lazer"] as const)("does not reinterpret a legacy wrapper as stable when profile is %s", client => {
  const result = projectStableHeader({ header, replaySha256: sha, profile: { client, key: client + "-v1" } });
  expect(result.fields.accuracy.state).toBe("unknown"); expect(result.fields.grade.state).toBe("unknown");
  expect(result.fields.maxCombo).toEqual({ state: "known", value: 80 });
  expect(result.fields.misses).toEqual({ state: "known", value: 2 });
});

it("keeps empty counts and native header placeholders unknown", () => {
  const empty = { ...header, counts: { great: 0, ok: 0, meh: 0, miss: 0, geki: 0, katu: 0 } };
  expect(projectStableHeader({ header: empty, replaySha256: sha, profile }).fields.accuracy.state).toBe("unknown");
  const wrapper = projectStableHeader({ header: { ...header, version: 30000001, sourceFormat: "lazer", nativeScoreInfo: true }, replaySha256: sha, profile });
  expect(wrapper.fields.maxCombo.state).toBe("unknown"); expect(wrapper.fields.accuracy.state).toBe("unknown");
});

it("binds saved scores to record content and qualifications rather than whole database or path", () => {
  const saved: LibrarySavedScore = { header, sourceKey: sha, databaseVersion: 20260924, onlineId: "123", targetPractice: null };
  const a = projectStableScore({ score: saved, profile });
  expect(a.provenance).toMatchObject({ sourceOnly: true, sourceEvidenceHash: sha });
  expect(a.provenance).not.toHaveProperty("replaySha256");
  expect(projectStableScore({ score: { ...saved, sourceKey: "d".repeat(64) }, profile }).inputKey).not.toBe(a.inputKey);
  expect(projectStableScore({ score: { ...saved, databaseVersion: 20250101 }, profile }).inputKey).not.toBe(a.inputKey);
});

it("projects explicit native saved values while missing dictionaries and completion stay unknown", () => {
  const result = projectNativeScore({ score: native, schemaFingerprint: schema });
  expect(result.fields).toMatchObject({ accuracy: { state: "known", value: 0.95 }, maxCombo: { state: "known", value: 100 },
    misses: { state: "known", value: 2 }, sourcePp: { state: "known", value: 123 }, completion: { state: "unknown" } });
  const missing = projectNativeScore({ score: { ...native, statistics: {}, pp: null }, schemaFingerprint: schema });
  expect(missing.fields.misses.state).toBe("unknown"); expect(missing.fields.sourcePp.state).toBe("unknown");
  expect(missing.fields).not.toHaveProperty("sliderBreaks");
  expect(projectNativeScore({ score: { ...native, rank: 0 }, schemaFingerprint: schema }).fields.completion.state).toBe("unknown");
});

it("native fingerprints follow meaningful source evidence and full mod settings, never locations or scans", () => {
  const a = projectNativeScore({ score: native, schemaFingerprint: schema });
  const reordered = { ...native, statistics: { Miss: 2, Meh: 3, Ok: 5, Great: 90 }, id: "new-id",
    replay: { status: "missing" as const, path: "C:\\new-location" } };
  expect(projectNativeScore({ score: reordered, schemaFingerprint: schema }).inputKey).toBe(a.inputKey);
  for (const changed of [
    { ...native, mods: [{ acronym: "DT", settings: { speed_change: 1.5 } }] },
    { ...native, statistics: null }, { ...native, maximumStatistics: null }, { ...native, isLegacyScore: true },
  ]) expect(projectNativeScore({ score: changed, schemaFingerprint: schema }).inputKey).not.toBe(a.inputKey);
  expect(projectNativeScore({ score: native, schemaFingerprint: "d".repeat(64) }).inputKey).not.toBe(a.inputKey);
});

it("distinguishes cached map provenance and ambiguous status/tempo from calculated values", () => {
  const map = { md5, databaseVersion: 20260924, rankedStatus: 2, drainTimeSeconds: 120, mode: 0 };
  const result = projectStableMap({ map, cachedNoModStars: 5, cachedTempo: { min: 120, max: 180 } });
  expect(result.fields).toEqual({ sourceMapStars: { state: "known", value: 5 }, drainLengthMs: { state: "known", value: 120000 },
    cachedBpm: { state: "unknown", reason: "variable-cached-tempo" }, mapStatus: { state: "unknown", reason: "ambiguous-source-status" } });
  const changed = projectStableMap({ map: { ...map, rankedStatus: 4 }, cachedNoModStars: 6, cachedTempo: { min: 120, max: 120 } });
  expect(changed.fields.mapStatus).toEqual({ state: "known", value: "ranked" });
  expect(changed.fields.cachedBpm).toEqual({ state: "known", value: 120 }); expect(changed.inputKey).not.toBe(result.inputKey);
  expect(result.fields).not.toHaveProperty("replayStars"); expect(result.fields).not.toHaveProperty("bpm");
});

it("does not pretend native cached audio length is drain length or other-ruleset stars are standard stars", () => {
  const input = { md5, schemaFingerprint: schema, ruleset: 0, map: { title: "T", titleUnicode: null, artist: "A", artistUnicode: null,
    mapper: "M", difficultyName: "D", onlineId: 123, status: 1, cachedLengthMs: 150000, cachedBpm: 180, cachedNoModStars: 5 } };
  const result = projectNativeMap(input);
  expect(result.fields.drainLengthMs.state).toBe("unknown"); expect(result.fields.cachedBpm).toEqual({ state: "known", value: 180 });
  const taiko = { ...input, ruleset: 1 };
  expect(projectNativeMap(taiko).fields.sourceMapStars.state).toBe("unknown");
  expect(projectNativeMap(taiko).inputKey).not.toBe(result.inputKey);
});

it("keeps native v30000000 wrapper and unknown rank/status/ambiguous statistics qualified", () => {
  expect(projectStableHeader({ header: { ...header, version: 30000000, sourceFormat: "lazer", nativeScoreInfo: false },
    replaySha256: sha, profile }).fields.accuracy.state).toBe("unknown");
  const result = projectNativeScore({ score: { ...native, rank: 1000, statistics: { Miss: 0, miss: 3 } }, schemaFingerprint: schema });
  expect(result.fields.misses.state).toBe("unknown"); expect(result.fields.grade.state).toBe("unknown");
  expect(projectNativeScore({ score: { ...native, rank: -1 }, schemaFingerprint: schema }).fields.grade.state).toBe("unknown");
});

it("fingerprints canonical objects but retains array order and unknown/null distinction", () => {
  expect(metricInputKey({ a: { z: 1, b: true }, n: null })).toBe(metricInputKey({ n: null, a: { b: true, z: 1 } }));
  expect(metricInputKey({ a: null })).not.toBe(metricInputKey({}));
  expect(metricInputKey([1, 2])).not.toBe(metricInputKey([2, 1]));
  expect(() => metricInputKey({ value: Infinity })).toThrow();
  expect(() => metricInputKey({ value: undefined })).toThrow();
  expect(() => metricInputKey({ value: "x".repeat(100000) })).toThrow();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => metricInputKey(cycle)).toThrow();
});
