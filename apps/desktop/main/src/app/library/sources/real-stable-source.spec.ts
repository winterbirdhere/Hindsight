import { createHash } from "crypto";
import { readFile, writeFile, stat } from "fs/promises";
import { join, resolve, relative, isAbsolute } from "path";
import { scanStableScores } from "./stable-scores-source";
import { scanReplayFolder } from "./replays-folder-source";
import { inspectReplayFile } from "./replay-file";
import { parseLibraryMaps } from "@rewind/osu-local/db-reader/library-maps";
import { readSourceDatabase } from "./source-file";

// Opt-in bounded integration, never part of synthetic ordinary checks or source mutation.
const root = process.env.HINDSIGHT_LIBRARY_REAL_STABLE;
const evidence = process.env.HINDSIGHT_LIBRARY_REAL_EVIDENCE;
const realTest = root && evidence ? it : it.skip;
realTest("reads eight actual Stable/cache and eight Replays entries without source writes or gameplay analysis", async () => {
  if (!root || !evidence) throw new Error("Explicit integration paths required");
  const qaRoot = resolve(__dirname, "../../../../../../../qa/replay-library");
  const relativeOutput = relative(qaRoot, resolve(evidence));
  if (relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) throw new Error("Evidence must stay in replay-library QA");
  const dbPath = join(root, "scores.db");
  const before = await readFile(dbPath);
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const dbStamp = await stat(dbPath, { bigint: true });
  const started = performance.now();
  const mapDatabase = await readSourceDatabase(join(root, "osu!.db"));
  let mapSamples = 0;
  for (const map of parseLibraryMaps(mapDatabase.bytes)) {
    expect(map.md5).toMatch(/^[a-f\d]{32}$/);
    if (++mapSamples === 8) break;
  }
  const saved = new Map<string, { status: unknown; sha256: string | null; locator: string }>();
  for await (const row of scanStableScores(root)) {
    saved.set(row.sourceKey, { status: row.metadata.fileState, sha256: row.sha256, locator: row.locator });
    if (saved.size === 8 && row.metadata.fileState !== "indexing") break;
  }
  const folder = new Map<string, { status: unknown; sha256: string | null; locator: string }>();
  for await (const row of scanReplayFolder(join(root, "Replays"))) {
    folder.set(row.sourceKey, { status: row.metadata.fileState, sha256: row.sha256, locator: row.locator });
    if (folder.size === 8 && row.metadata.fileState !== "indexing") break;
  }
  const verifications: boolean[] = [];
  for (const record of [...saved.values(), ...folder.values()]) if (record.sha256)
    verifications.push((await inspectReplayFile(record.locator)).sha256 === record.sha256);
  const after = await readFile(dbPath);
  const afterStamp = await stat(dbPath, { bigint: true });
  const result = {
    scope: "Bounded actual-source metadata and byte-identity sample, not exhaustive indexing/playback acceptance",
    utc: new Date().toISOString(), root, databaseVersion: before.readInt32LE(0), databaseBytes: before.length,
    databaseSha256: digest(before), databaseUnchanged: digest(after) === digest(before) && dbStamp.mtimeNs === afterStamp.mtimeNs && dbStamp.ctimeNs === afterStamp.ctimeNs,
    mapDatabaseVersion: mapDatabase.bytes.readInt32LE(0), mapSamples, mapDatabaseSha256: mapDatabase.sha256,
    mapDatabaseUnchanged: digest(await readFile(join(root, "osu!.db"))) === mapDatabase.sha256,
    stable: [...saved.values()].map(({ status, sha256 }) => ({ status, sha256 })),
    replays: [...folder.values()].map(({ status, sha256 }) => ({ status, sha256 })),
    verifiedReplaysUnchanged: verifications.every(Boolean), elapsedMs: performance.now() - started,
  };
  await writeFile(evidence, JSON.stringify(result, null, 2));
  expect(saved.size).toBe(8); expect(folder.size).toBe(8);
  expect(result.databaseUnchanged).toBe(true); expect(result.verifiedReplaysUnchanged).toBe(true);
  expect(result.mapDatabaseUnchanged).toBe(true); expect(mapSamples).toBe(8);
  expect(verifications.length).toBeGreaterThan(0);
}, 30000);
