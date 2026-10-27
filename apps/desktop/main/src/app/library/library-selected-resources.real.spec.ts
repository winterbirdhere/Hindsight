import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { createHash } from "crypto";
import { parseReplayFramesWithDiagnosticsAsync } from "@osujs/core";
import { prepareLibraryReplay, prepareLibraryMap } from "./library-selected-resources";
import { LazerSource, LazerSourceInspection } from "./sources/lazer-source";
import { LibraryLzmaClient } from "./library-lzma-client";

const executable = process.env.HINDSIGHT_LIBRARY_DECODER_EXECUTABLE;
const directory = process.env.HINDSIGHT_LIBRARY_NATIVE_DIRECTORY;
const manifest = process.env.HINDSIGHT_LIBRARY_NATIVE_MANIFEST;
const report = process.env.HINDSIGHT_LIBRARY_NATIVE_REPORT;
const enabled = executable && directory && manifest && report;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

(enabled ? it : it.skip)("prepares one real native replay/map and parses its frames without simulation or source writes", async () => {
  if (!executable || !directory || !manifest || !report) throw Error("Explicit real-source fixture configuration required");
  const qa = resolve(__dirname, "../../../../../../qa/replay-library");
  if (!resolve(report).startsWith(qa + sep)) throw Error("Report must be a fresh project QA file");
  const selected = JSON.parse(await readFile(manifest, "utf8")) as LazerSourceInspection;
  const score = selected.scores?.[0];
  if (!score?.replay.sha256 || !score.replay.path || !score.beatmap.path) throw Error("Verified selected manifest required");
  const inventory = async () => {
    const files = [join(directory, "client.realm"), score.replay.path!, score.beatmap.path!];
    const top = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name.startsWith("client.realm"));
    for (const entry of top) {
      if (entry.isFile() && entry.name !== "client.realm") files.push(join(directory, entry.name));
      if (entry.isDirectory()) for (const name of await readdir(join(directory, entry.name))) {
        const file = join(directory, entry.name, name); if ((await stat(file)).isFile()) files.push(file);
      }
    }
    return Promise.all(files.sort().map(async path => ({ path, sha256: hash(await readFile(path)) })));
  };
  const before = await inventory(); const decoder = new LibraryLzmaClient(() => executable);
  let result: Record<string, unknown> = { ok: false };
  try {
    const replay = await prepareLibraryReplay({ replayId: "real-selected", sourceId: "native", sourceKey: score.id,
      locator: score.replay.path, sha256: score.replay.sha256, kind: "lazer", directory,
      locationRevision: 1, sourceConfigRevision: 1, metadata: {} }, new LazerSource(() => executable), decoder.decode);
    const map = await prepareLibraryMap(replay);
    const parsed = await parseReplayFramesWithDiagnosticsAsync(replay.data.replay_data,
      { maxRawLength: 32 * 1024 * 1024, maxTokenLength: 4096, maxTokens: 1100000, maxFrames: 1000000 },
      () => new Promise<void>(resolve => setImmediate(resolve)));
    expect(parsed.frames.length).toBeGreaterThan(0);
    expect(map.map.md5).toBe(replay.data.beatmapMD5);
    expect(replay.receipt.sha256).toBe(score.replay.sha256);
    expect(replay.data.nativeSource?.scoreId).toBe(score.id);
    result = { ok: true, scope: "one selected native replay/map and frame parsing; no simulation, media playback or full-source acceptance",
      scoreId: score.id, replaySha256: replay.receipt.sha256, mapSha256: map.map.sha256, mapMd5: map.map.md5,
      frameCount: parsed.frames.length, skippedTokens: parsed.diagnostics.skippedTokens.length,
      frameTextCharacters: replay.data.replay_data.length, gameVersion: replay.data.gameVersion, timestamp: replay.data.timestamp,
      nativeSource: replay.data.nativeSource, embeddedMods: replay.data.lazerMods, storyboards: map.storyboards,
      assetManifestComplete: map.assetManifestComplete };
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    await decoder.close(); const after = await inventory(); const unchanged = JSON.stringify(before) === JSON.stringify(after);
    await writeFile(report, JSON.stringify({ ...result, unchanged, before, after, executable, utc: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
    expect(unchanged).toBe(true);
  }
}, 90000);
