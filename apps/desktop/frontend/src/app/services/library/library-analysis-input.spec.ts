import { createHash, webcrypto } from "crypto";
import { TextDecoder, TextEncoder } from "util";
import { buildBeatmap, parseBlueprint } from "@osujs/core";
import type { LibraryReplayData } from "../../../../../shared/library-replay-data";
import { traceMapText } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { prepareLibraryNumericalInput } from "./library-analysis-input";
import { projectLibraryNumerical, runLibraryNumerical } from "./library-numerical";
import { LIBRARY_NUMERIC_PROJECTION_VERSION,LIBRARY_REPLAY_PARSER_VERSION,LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../../shared/library-analysis";
import { copyCurrentReplayNumericalProjection } from "./library-current-replay";
import { libraryTimelineTarget } from "../../../../../main/src/app/library/library-timeline-target";
import { libraryFcTarget } from "../../../../../main/src/app/library/library-fc-target";

Object.assign(globalThis, { TextDecoder, TextEncoder });
Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
it("revises semantic numerical identity and dependent timeline/FC keys without changing their producers",()=>{
  expect(LIBRARY_NUMERIC_PROJECTION_VERSION).not.toBe("library-numeric-v3");
  const old={replayId:"replay",slot:"numerical" as const,stage:"S" as const,inputKey:"c".repeat(64),producerVersion:"library-numeric-v3"},current={...old,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION};
  for(const target of [libraryTimelineTarget,libraryFcTarget]){expect(target(current).inputKey).not.toBe(target(old).inputKey);expect(target(current).producerVersion).toBe(target(old).producerVersion);}
});
function fixture(native = false, mapText = traceMapText("300,192,1000,1,0")) {
  const replay: LibraryReplayData = { gameMode: 0, gameVersion: native ? 30000016 : 20200101,
    beatmapMD5: "a".repeat(32), replayContentSha256: "b".repeat(64), replayMD5: "fixture", playerName: "Fixture",
    number_300s: 1, number_100s: 0, number_50s: 0, misses: 0, score: 300, max_combo: 1, perfect_combo: 1, mods: 0, life_bar: "",
    replay_data: "0|256|-500|0,0|256|-500|0,0|300|192|0,1000|300|192|5,100|300|192|0,",
    ...(native ? { nativeSource: { scoreId: "fixture", schemaFingerprint: "schema", isLegacyScore: false,
      mods: [{ acronym: "CL", settings: { no_slider_head_accuracy: true } }] } } : {}) };
  const bytes = { replay: new Uint8Array(Buffer.from(JSON.stringify(replay))), map: new Uint8Array(Buffer.from(mapText)) };
  const input = { format: "resources" as const, replayBytes: bytes.replay.length, mapBytes: bytes.map.length,
    binding: { replaySha256: replay.replayContentSha256, mapSha256: createHash("sha256").update(bytes.map).digest("hex"),
      mapMd5: replay.beatmapMD5, exactMapAndProfile: true } };
  const read = jest.fn(async (kind: "replay" | "map", offset: number) => {
    const data = bytes[kind].slice(offset, offset + 97); return { bytes: data, done: offset + data.length === bytes[kind].length };
  });
  return { input, bytes, read, mapText };
}

it("carries parser-attested reset through production batching and shares the current-replay numerical policy",async()=>{
  const f=fixture(false,traceMapText("300,192,5000,1,0")),wire=JSON.parse(Buffer.from(f.bytes.replay).toString("utf8"));
  wire.replay_data="0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,4985|300|192|5,100|300|192|0,";
  f.bytes.replay=new Uint8Array(Buffer.from(JSON.stringify(wire)));f.input.replayBytes=f.bytes.replay.length;
  const prepared=await prepareLibraryNumericalInput(f.input,f.read,async()=>undefined,new AbortController().signal),diagnostics=prepared.replay.parseDiagnostics;
  if(!diagnostics)throw new Error("Expected parsed roundtrip fixture");
  expect(diagnostics.leadingResetWitness).toMatchObject({version:"stable-released-leading-reset-v2",frameCount:3});
  expect(diagnostics.sourceCoverageLimits).toContain("parser-negative-delta");expect(diagnostics.frameSources[0].discontinuityBefore).toEqual(["parser-negative-delta"]);
  const background=await runLibraryNumerical(prepared.beatmap,prepared.replay,prepared.binding,async()=>undefined);
  const current=await projectLibraryNumerical(prepared.beatmap,prepared.replay,background.scoring,background.state,prepared.binding,async()=>undefined);
  expect(current).toEqual(background.metrics);expect(current.fields.fc).toEqual({state:"known",value:true});
  const binding={...prepared.binding,numericalInputKey:"f".repeat(64),mode:"stable" as const,clockRate:1,objectCount:1,parserVersion:LIBRARY_REPLAY_PARSER_VERSION,preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION};
  expect(copyCurrentReplayNumericalProjection(binding,current)?.fields).toEqual(current.fields);
  expect(copyCurrentReplayNumericalProjection(binding,{...current,provenance:{...current.provenance,projectionVersion:"library-numeric-v2"}})).toBeUndefined();
});

it.each([{nativeMods:[]},{nativeMods:[{acronym:"HR"}]},{nativeMods:[{acronym:"DT",settings:{speed_change:1.2}}]},{nativeMods:[{acronym:"DA",settings:{approach_rate:3}}]}])(
  "carries native initial-negative proof through worker transport and current replay with mods $nativeMods",async({nativeMods})=>{
    const f=fixture(true,traceMapText("300,192,5000,1,0")),wire=JSON.parse(Buffer.from(f.bytes.replay).toString("utf8"));
    wire.nativeSource.mods=nativeMods;wire.mods=2048; // Stale legacy AT is overridden by authoritative native metadata.
    wire.replay_data="-900|280|180|0,20|300|192|0,5880|300|192|1,100|300|192|0,-12345|0|0|9";
    f.bytes.replay=new Uint8Array(Buffer.from(JSON.stringify(wire)));f.input.replayBytes=f.bytes.replay.length;
    const prepared=await prepareLibraryNumericalInput(f.input,f.read,async()=>undefined,new AbortController().signal),d=prepared.replay.parseDiagnostics;
    if(!d)throw new Error("Expected native proof roundtrip fixture");
    expect(d.initialNegativeWitness).toMatchObject({version:"native-zero-initial-negative-v1",frameCount:3});
    expect(d.leadingResetWitness).toBeUndefined();expect(d.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
    expect(prepared.replay.lazerMods).toEqual(nativeMods);expect(prepared.replay.mods).not.toContain("AUTO_PLAY");
    expect(prepared.beatmap.appliedMods).not.toContain("AUTO_PLAY");expect(prepared.beatmap.lazerMods).toEqual(nativeMods);
    const background=await runLibraryNumerical(prepared.beatmap,prepared.replay,prepared.binding,async()=>undefined);
    expect(background.metrics.provenance.coverageQualified).toBe(true);
    const current=await projectLibraryNumerical(prepared.beatmap,prepared.replay,background.scoring,background.state,prepared.binding,async()=>undefined);
    expect(current).toEqual(background.metrics);
    const binding={...prepared.binding,numericalInputKey:"f".repeat(64),mode:"lazer" as const,clockRate:prepared.beatmap.gameClockRate,objectCount:1,parserVersion:LIBRARY_REPLAY_PARSER_VERSION,preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION};
    expect(copyCurrentReplayNumericalProjection(binding,current)?.fields).toEqual(current.fields);
    expect(copyCurrentReplayNumericalProjection(binding,{...current,provenance:{...current.provenance,projectionVersion:"library-numeric-v3"}})).toBeUndefined();
  });

it.each([false, true])("prepares exact bounded source input inside the worker with native=%s", async native => {
  const f = fixture(native), checkpoint = jest.fn(async () => undefined);
  const prepared = await prepareLibraryNumericalInput(f.input, f.read, checkpoint, new AbortController().signal);
  expect(prepared.replay.frames).toHaveLength(3); expect(prepared.replay.parseDiagnostics?.frameSources).toHaveLength(3);
  expect(prepared.replay.replayContentSha256).toBe(f.input.binding.replaySha256);
  if (native) expect(prepared.replay.lazerMods).toEqual([{ acronym: "CL", settings: { no_slider_head_accuracy: true } }]);
  const expectedMap = buildBeatmap(parseBlueprint(f.mapText), { addStacking: true, mods: prepared.replay.mods, lazerMods: prepared.replay.lazerMods });
  const expected = await runLibraryNumerical(expectedMap, prepared.replay, f.input.binding, checkpoint);
  const actual = await runLibraryNumerical(prepared.beatmap, prepared.replay, prepared.binding, checkpoint);
  expect(actual.metrics).toEqual(expected.metrics); expect(actual.metrics.fields.fc).toEqual({ state: "known", value: true });
  expect(f.read.mock.calls.filter(([kind]) => kind === "map").length).toBeGreaterThan(1);
  expect(checkpoint.mock.calls.length).toBeGreaterThan(f.read.mock.calls.length);
});

it("rejects mismatched map bytes and replay identity before numerical evaluation", async () => {
  const f = fixture();
  await expect(prepareLibraryNumericalInput({ ...f.input, binding: { ...f.input.binding, mapSha256: "d".repeat(64) } },
    f.read, async () => undefined, new AbortController().signal)).rejects.toThrow(/map.*identity/i);
  await expect(prepareLibraryNumericalInput({ ...f.input, binding: { ...f.input.binding, replaySha256: "e".repeat(64) } },
    f.read, async () => undefined, new AbortController().signal)).rejects.toThrow(/replay.*identity/i);
});

it("rejects invalid bounds, incomplete chunk flags and nonstandard map mode", async () => {
  const f = fixture();
  await expect(prepareLibraryNumericalInput({ ...f.input, replayBytes: 64 * 1024 * 1024 + 1 }, f.read, async () => undefined,
    new AbortController().signal)).rejects.toThrow(/limit/i); expect(f.read).not.toHaveBeenCalled();
  await expect(prepareLibraryNumericalInput(f.input, async () => ({ bytes: new Uint8Array([1]), done: true }), async () => undefined,
    new AbortController().signal)).rejects.toThrow(/chunk/i);
  const nonstandard = fixture(false, f.mapText.replace("[Difficulty]", "[General]\nMode:1\n[Difficulty]"));
  await expect(prepareLibraryNumericalInput(nonstandard.input, nonstandard.read, async () => undefined,
    new AbortController().signal)).rejects.toThrow(/mode/i);
});

it("propagates cancellation while delivering chunks and never continues to map work", async () => {
  const f = fixture(), abort = new AbortController(); let checkpoints = 0;
  await expect(prepareLibraryNumericalInput(f.input, f.read, async () => { if (++checkpoints === 3) abort.abort(new Error("fixture cancelled")); },
    abort.signal)).rejects.toThrow("fixture cancelled");
  expect(f.read.mock.calls.every(([kind]) => kind === "replay")).toBe(true);
});
