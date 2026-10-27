import { createHash } from "crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { parseReplayHeader } from "@rewind/osu-local/osr-reader";
import type { LibraryOpenLocation, LibraryLocationRefresh } from "./library-store";
import type { LibraryOriginLookup } from "./library-selected-resources";
import type { LibraryIncidentEvidenceReceipt } from "../../../../shared/library-incidents";
import * as reader from "./library-incidents-probe";

const md5 = "1".repeat(32), ticks = "639255087055389781", fileTime = "134343855055389781";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
type Probe = (ticket: LibraryOpenLocation, signal?: AbortSignal, origin?: LibraryOriginLookup,
  checkpoint?: () => Promise<void>) => Promise<{ evidence: LibraryIncidentEvidenceReceipt; observation: LibraryLocationRefresh;
    origin: { client: "stable" | "lazer"; provenance: "user-confirmed" } | null; scope: "stable-sidecar" | "unsupported-profile" }>;
const probe: Probe = (...args) => (reader as unknown as { probeLibraryIncidentEvidence: Probe }).probeLibraryIncidentEvidence(...args);
function bytes(version = 20260711) {
  const string = (value: string) => Buffer.concat([Buffer.from([11, value.length]), Buffer.from(value)]);
  const prefix = Buffer.alloc(5); prefix.writeInt32LE(version, 1);
  const result = Buffer.alloc(23); result.writeUInt16LE(1, 0); result.writeUInt16LE(1, 6);
  result.writeInt32LE(300, 12); result.writeUInt16LE(1, 16); result[18] = 1;
  const end = Buffer.alloc(12); end.writeBigUInt64LE(BigInt(ticks)); end.writeInt32LE(3, 8);
  // Deliberately invalid compressed frames: the evidence probe must never decode them.
  return Buffer.concat([prefix, string(md5), string("Player"), string(md5), result, Buffer.from([0]), end, Buffer.from([255, 255, 255])]);
}
function sidecar(time = 1000) {
  const value = Buffer.alloc(37); value.writeInt32LE(20260711); value.writeInt32LE(1, 4); value.writeInt32LE(time, 8);
  value.writeUInt16LE(1, 13); value.writeUInt16LE(1, 19); value.writeInt32LE(300, 25);
  value.writeUInt16LE(1, 29); value.writeUInt16LE(1, 31); return value;
}
let directory: string, ticket: LibraryOpenLocation, replay: Buffer;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hindsight-incident-probe-")); replay = bytes();
  ticket = { replayId: "one", sourceId: "replays", sourceKey: "replay", locator: join(directory, "one.osr"),
    sha256: digest(replay), locationRevision: 2, sourceConfigRevision: 3, kind: "replays", directory, metadata: {} };
  await writeFile(ticket.locator, replay);
});
afterEach(async () => {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true });
});

it("provides a fresh bounded evidence-only resource entrypoint", () => {
  expect((reader as unknown as Record<string, unknown>).probeLibraryIncidentEvidence).toEqual(expect.any(Function));
});
it("observes absent, validated, changed and removed evidence with unchanged replay bytes", async () => {
  expect(await probe(ticket)).toMatchObject({ evidence: { state: "absent" }, scope: "stable-sidecar", origin: null });
  await writeFile(join(directory, "one.osg"), sidecar());
  const first = await probe(ticket);
  expect(first.evidence).toMatchObject({ state: "validated", timelineSha256: digest(sidecar()), replaySha256: ticket.sha256 });
  expect(first.observation).toMatchObject({ sha256: ticket.sha256, available: true, metadata: { header: { beatmapMD5: md5 } } });
  expect(JSON.stringify(first)).not.toMatch(/"(?:rows|groups|attempts|timelinePath|pairedReplayPath|replay_data)"/);
  await writeFile(join(directory, "one.osg"), sidecar(1001));
  expect((await probe(ticket)).evidence).toMatchObject({ state: "validated", timelineSha256: digest(sidecar(1001)) });
  await rm(join(directory, "one.osg")); expect((await probe(ticket)).evidence.state).toBe("absent");
  expect(await readFile(ticket.locator)).toEqual(replay);
});
it("requires an exact replay digest and exact Stable saved-score binding before optional discovery", async () => {
  await expect(probe({ ...ticket, sha256: null })).rejects.toThrow(/identity|digest|exact/i);
  await expect(probe({ ...ticket, sha256: "f".repeat(64) })).rejects.toThrow(/digest/i);
  await expect(probe({ ...ticket, kind: "stable" })).rejects.toThrow(/saved score/i);
  const stable = { ...ticket, kind: "stable" as const, metadata: { savedScore: { sourceKey: ticket.sourceKey, header: parseReplayHeader(replay) } } };
  await mkdir(join(directory, "Data", "r"), { recursive: true });
  const cache = join(directory, "Data", "r", `${md5}-${fileTime}`);
  await writeFile(cache + ".osr", replay); await writeFile(cache + ".osg", sidecar());
  expect((await probe(stable)).evidence.state).toBe("validated");
  await writeFile(cache + ".osr", Buffer.concat([replay, Buffer.from([99])]));
  expect((await probe(stable)).evidence.state).toBe("rejected");
});
it("proves native unavailability from exact bytes, current confirmed origin, or SHA-bound native metadata", async () => {
  const origin: LibraryOriginLookup = async sha => { expect(sha).toBe(ticket.sha256); return { client: "lazer", provenance: "user-confirmed" }; };
  expect(await probe(ticket, undefined, origin)).toMatchObject({ evidence: { state: "unavailable" }, scope: "unsupported-profile", origin: { client: "lazer" } });
  const native = { ...ticket, kind: "lazer" as const, analysisRequiresNative: true as const, metadata: {
    nativeScore: { id: ticket.sourceKey, ruleset: 0, isLegacyScore: false, replay: { sha256: ticket.sha256 }, beatmap: { md5 } } } };
  expect(await probe(native)).toMatchObject({ evidence: { state: "unavailable" }, scope: "unsupported-profile" });
  await expect(probe({ ...native, metadata: {} })).rejects.toThrow(/native|profile/i);
  await expect(probe({ ...ticket, kind: "lazer" })).rejects.toThrow(/native|profile/i);
  await expect(probe({ ...native, metadata: { nativeScore: { ...native.metadata.nativeScore, replay: { sha256: "e".repeat(64) } } } })).rejects.toThrow(/native|profile|binding/i);
  const nativeBytes = bytes(30000016); await writeFile(ticket.locator, nativeBytes);
  expect(await probe({ ...ticket, sha256: digest(nativeBytes) })).toMatchObject({ evidence: { state: "unavailable" }, scope: "unsupported-profile" });
});
it("never substitutes stale path bytes or cancellation with optional absence", async () => {
  const cancel = new AbortController(), reason = new Error("stop evidence probe");
  await expect(probe(ticket, cancel.signal, undefined, async () => { cancel.abort(reason); })).rejects.toBe(reason);
  let changed = false;
  await expect(probe(ticket, undefined, async () => {
    if (!changed) { changed = true; await rename(ticket.locator, join(directory, "old.osr")); await writeFile(ticket.locator, replay); }
    return undefined;
  })).rejects.toThrow(/changed/i);
});
it("refuses an evidence file replacement during its bounded discovery", async () => {
  await writeFile(join(directory, "one.osg"), sidecar()); let replaced = false;
  const fs = jest.requireActual<typeof import("fs/promises")>("fs/promises"), original = fs.open;
  const spy = jest.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (!replaced && args[0] === join(directory, "one.osg")) {
      try { replaced = true; await rename(join(directory, "one.osg"), join(directory, "old.osg")); await writeFile(join(directory, "one.osg"), sidecar(1001)); }
      catch (error) { await handle.close(); throw error; }
    }
    return handle;
  }) as typeof fs.open);
  try { await expect(probe(ticket)).rejects.toThrow(/changed/i); } finally { spy.mockRestore(); }
});
