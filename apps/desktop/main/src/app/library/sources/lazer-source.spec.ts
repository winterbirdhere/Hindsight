import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import { LazerSource, defaultLazerDirectory } from "./lazer-source";

jest.mock("child_process", () => ({ spawn: jest.fn() }));

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn(() => true),
  });
  (spawn as jest.Mock).mockReturnValue(child);
  return child;
}

const good = { version: 1, ok: true, status: "ready", sampleOnly: true, scores: [], schemaFingerprint: "a".repeat(64) };

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

it("locates only the OS app-data candidate and does not equate discovery with connection", () => {
  expect(defaultLazerDirectory("C:\\Users\\Player\\AppData\\Roaming")).toBe("C:\\Users\\Player\\AppData\\Roaming\\osu");
  expect(spawn).not.toHaveBeenCalled();
});

it("uses a separate bounded native command and waits for clean exit", async () => {
  const child = childFixture();
  let request = "";
  child.stdin.on("data", (part) => { request += part; });
  const source = new LazerSource(() => "engine.exe");
  const pending = source.inspect("C:\\lazer");
  expect(spawn).toHaveBeenCalledWith("engine.exe", ["--library-source"], expect.objectContaining({ windowsHide: true, shell: false }));
  expect(JSON.parse(request)).toEqual({ version: 1, operation: "inspect", sourceDirectory: "C:\\lazer", limit: 8 });
  child.stdout.write(JSON.stringify(good) + "\n");
  child.emit("close", 0);
  await expect(pending).resolves.toEqual(good);
});

it("rejects an old native engine rather than treating empty timelines as an empty source", async () => {
  const child = childFixture();
  const pending = new LazerSource(() => "old.exe").inspect("C:\\lazer");
  child.stdout.write(JSON.stringify({ ok: true, timelines: [] }) + "\n");
  child.emit("close", 0);
  await expect(pending).resolves.toMatchObject({ ok: false, status: "incompatible-helper" });
});

it.each(["source-busy", "unsupported-schema", "source-missing"])("preserves %s without exporting a substitute", async (status) => {
  const child = childFixture();
  const pending = new LazerSource(() => "engine.exe").inspect("C:\\lazer");
  child.stdout.write(JSON.stringify({ version: 1, ok: false, status }) + "\n");
  child.emit("close", 0);
  await expect(pending).resolves.toEqual({ version: 1, ok: false, status });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it("cancels only its own native process, and a pre-aborted call never starts one", async () => {
  const source = new LazerSource(() => "engine.exe");
  const first = childFixture();
  const abort = new AbortController();
  const pending = source.inspect("C:\\lazer", abort.signal);
  const second = childFixture();
  const other = source.inspect("C:\\another");
  abort.abort();
  let completed = false;
  void pending.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  first.emit("close", null);
  await expect(pending).resolves.toMatchObject({ ok: false, status: "cancelled" });
  expect(first.kill).toHaveBeenCalledTimes(1);
  expect(second.kill).not.toHaveBeenCalled();
  first.stdout.write(JSON.stringify(good));
  second.stdout.write(JSON.stringify(good));
  second.emit("close", 0);
  await expect(other).resolves.toEqual(good);
  await expect(source.inspect("C:\\lazer", abort.signal)).resolves.toMatchObject({ status: "cancelled" });
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("bounds duration and output, including a helper that never ends a JSON line", async () => {
  jest.useFakeTimers();
  const child = childFixture();
  const pending = new LazerSource(() => "engine.exe").inspect("C:\\lazer");
  jest.advanceTimersByTime(15_000);
  child.emit("close", null);
  await expect(pending).resolves.toMatchObject({ status: "timeout" });
  expect(child.kill).toHaveBeenCalledTimes(1);
  const oversized = childFixture();
  const huge = new LazerSource(() => "engine.exe").inspect("C:\\lazer");
  oversized.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  oversized.emit("close", null);
  await expect(huge).resolves.toMatchObject({ status: "resource-limit" });
  expect(oversized.kill).toHaveBeenCalledTimes(1);
});

it.each([false, "throw"])("reports unconfirmed termination as a cleanup failure (%s)", async (killResult) => {
  jest.useFakeTimers();
  const child = childFixture();
  child.kill.mockImplementation(() => { if (killResult === "throw") throw new Error("kill failed"); return false; });
  const abort = new AbortController();
  const pending = new LazerSource(() => "engine.exe").inspect("C:\\lazer", abort.signal);
  abort.abort();
  jest.advanceTimersByTime(2_000);
  await expect(pending).rejects.toThrow(/cleanup.*exit not confirmed/i);
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("retains ownership after cleanup timeout and prevents another native admission", async () => {
  jest.useFakeTimers();
  const child = childFixture(), source = new LazerSource(() => "engine.exe"), abort = new AbortController();
  const pending = source.inspect("C:\\lazer", abort.signal);
  abort.abort(); jest.advanceTimersByTime(2000);
  await expect(pending).rejects.toThrow(/cleanup/i);
  await expect(source.inspect("C:\\lazer")).rejects.toThrow(/cleanup/i);
  expect(spawn).toHaveBeenCalledTimes(1);
  child.emit("close", null);
  await expect(source.inspect("C:\\lazer")).rejects.toThrow(/cleanup/i);
});

it.each(["error", "stdout", "stderr"])("waits for native exit after a %s failure", async (kind) => {
  const child = childFixture(), source = new LazerSource(() => "engine.exe");
  Object.assign(child, { pid: 123 });
  const pending = source.inspect("C:\\lazer"); let settled = false;
  void pending.then(() => { settled = true; });
  if (kind === "error") child.emit("error", new Error("fixture"));
  else child[kind as "stdout" | "stderr"].emit("error", new Error("fixture"));
  await Promise.resolve(); expect(settled).toBe(false); expect(child.kill).toHaveBeenCalledTimes(1);
  child.emit("close", null); await expect(pending).resolves.toMatchObject({ status: "helper-failed" });
});

it("closes all owned requests and reports unconfirmed cleanup even after a request settled", async () => {
  jest.useFakeTimers();
  const source = new LazerSource(() => "engine.exe");
  const first = childFixture(), one = source.inspect("C:\\one");
  const second = childFixture(), two = source.inspect("C:\\two");
  const closing = source.close();
  expect(first.kill).toHaveBeenCalledTimes(1); expect(second.kill).toHaveBeenCalledTimes(1);
  first.emit("close", null); await expect(one).resolves.toMatchObject({ status: "cancelled" });
  jest.advanceTimersByTime(2000);
  await expect(two).rejects.toThrow(/cleanup/i); await expect(closing).rejects.toThrow(/cleanup/i);
  second.emit("close", null); await expect(source.close()).rejects.toThrow(/cleanup/i);
  await expect(source.inspect("C:\\one")).rejects.toThrow(/closed/i);
});

it("does not accept a truncated or malformed response, or a successful body with a crash exit", async () => {
  for (const [body, exit] of [["{", 0], [JSON.stringify(good), 1], [JSON.stringify({ ...good, scores: [{}] }), 0]] as const) {
    const child = childFixture();
    const pending = new LazerSource(() => "engine.exe").inspect("C:\\lazer");
    child.stdout.write(body);
    child.emit("close", exit);
    expect((await pending).ok).toBe(false);
  }
});

it("requests an exhaustive metadata page with an explicit cursor and refuses an inspection sample as EOF", async () => {
  const child = childFixture();
  let request = ""; child.stdin.on("data", part => { request += part; });
  const source = new LazerSource(() => "engine.exe");
  const pending = source.page("C:\\lazer", { token: "b".repeat(64), offset: 32 });
  expect(JSON.parse(request)).toEqual({ version: 1, operation: "scan-page", sourceDirectory: "C:\\lazer", limit: 32, token: "b".repeat(64), offset: 32 });
  const page = { ...good, sampleOnly: false, cursorToken: "b".repeat(64), nextOffset: 32, total: 32, complete: true };
  child.stdout.write(JSON.stringify(page)); child.emit("close", 0);
  await expect(pending).resolves.toEqual(page);
  const old = childFixture(); const incompatible = source.page("C:\\lazer");
  old.stdout.write(JSON.stringify(good)); old.emit("close", 0);
  await expect(incompatible).resolves.toMatchObject({ status: "incompatible-helper" });
});

it("rejects non-advancing or inconsistent successful native pages", async () => {
  for (const patch of [{ nextOffset: 0, total: 1, complete: false }, { nextOffset: 1, total: 0, complete: true }, { nextOffset: 0, total: 0, complete: false }]) {
    const child = childFixture(); const pending = new LazerSource(() => "engine.exe").page("C:\\lazer");
    child.stdout.write(JSON.stringify({ ...good, sampleOnly: false, cursorToken: "b".repeat(64), ...patch })); child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ status: "incompatible-helper" });
  }
});

it("accepts explicit per-row failures as consumed cursor positions, without fabricating score values", async () => {
  const child = childFixture(); const pending = new LazerSource(() => "engine.exe").page("C:\\lazer");
  const page = { ...good, sampleOnly: false, cursorToken: "b".repeat(64), nextOffset: 1, total: 1, complete: true,
    errors: [{ id: "a0000000-0000-4000-8000-000000000001", status: "resource-limit" }] };
  child.stdout.write(JSON.stringify(page)); child.emit("close", 0);
  await expect(pending).resolves.toEqual(page);
});

const selectedId = "a0000000-0000-4000-8000-000000000065";
const selectedHash = "c".repeat(64);
const selectedScore = { id: selectedId, playedAtTicks: "638961337234560000", player: null, ruleset: 0,
  clientVersion: null, isLegacyScore: false, maxCombo: 10, accuracy: 1, rank: 0, pp: null, mods: [],
  statistics: null, maximumStatistics: null, replay: { status: "unverified", path: "C:\\lazer\\files\\c\\cc\\" + selectedHash, sha256: selectedHash, bytes: 40 },
  beatmap: { status: "missing" }, assets: [], assetManifestComplete: false };
it("resolves a provisional GUID explicitly and validates the returned hash without weakening known identities", async () => {
  const child = childFixture(); let request = ""; child.stdin.on("data", part => { request += part; });
  const pending = new LazerSource(() => "engine.exe").resolveProvisionalScore("C:\\lazer", selectedId);
  expect(JSON.parse(request)).toMatchObject({ operation: "resolve-provisional-score", scoreId: selectedId });
  expect(JSON.parse(request)).not.toHaveProperty("includeAssets");
  const response = { ...good, sampleOnly: false, resolvedScoreId: selectedId, cursorToken: "b".repeat(64), scores: [selectedScore] };
  child.stdout.write(JSON.stringify(response)); child.emit("close", 0);
  await expect(pending).resolves.toEqual(response);
  for (const replay of [{ ...selectedScore.replay, sha256: "bad" }, { status: "missing", sha256: "bad" }]) {
    const invalid = childFixture(); const rejected = new LazerSource(() => "engine.exe").resolveProvisionalScore("C:\\lazer", selectedId);
    invalid.stdout.write(JSON.stringify({ ...response, scores: [{ ...selectedScore, replay }] })); invalid.emit("close", 0);
    await expect(rejected).resolves.toMatchObject({ ok: false, status: "incompatible-helper" });
  }
});
it("resolves any selected native identity without substituting an inspection sample", async () => {
  const child = childFixture(); let request = ""; child.stdin.on("data", part => { request += part; });
  const pending = new LazerSource(() => "engine.exe").resolveScore("C:\\lazer", selectedId, selectedHash);
  expect(JSON.parse(request)).toMatchObject({ operation: "resolve-score", scoreId: selectedId, expectedReplaySha256: selectedHash });
  expect(JSON.parse(request)).not.toHaveProperty("includeAssets");
  const response = { ...good, sampleOnly: false, resolvedScoreId: selectedId, cursorToken: "b".repeat(64), scores: [selectedScore] };
  child.stdout.write(JSON.stringify(response)); child.emit("close", 0);
  await expect(pending).resolves.toEqual(response);
});
it.each([false, true])("explicitly requests metadata-only native selection, provisional=%s", async provisional => {
  const child = childFixture(); let request = ""; child.stdin.on("data", part => { request += part; });
  const native = new LazerSource(() => "engine.exe");
  const pending = provisional ? native.resolveProvisionalScore("C:\\lazer", selectedId, undefined, { includeAssets: false })
    : native.resolveScore("C:\\lazer", selectedId, selectedHash, undefined, { includeAssets: false });
  expect(JSON.parse(request)).toMatchObject({ operation: provisional ? "resolve-provisional-score" : "resolve-score", includeAssets: false });
  const response = { ...good, sampleOnly: false, resolvedScoreId: selectedId, cursorToken: "b".repeat(64), scores: [selectedScore] };
  child.stdout.write(JSON.stringify(response)); child.emit("close", 0);
  await expect(pending).resolves.toEqual(response);
});
it("rejects wrong score/hash, incomplete resolution contracts and unsafe asset names", async () => {
  for (const patch of [{ resolvedScoreId: "a0000000-0000-4000-8000-000000000001" },
    { scores: [{ ...selectedScore, replay: { ...selectedScore.replay, sha256: "d".repeat(64) } }] },
    { scores: [{ ...selectedScore, assetManifestComplete: undefined }] },
    { scores: [{ ...selectedScore, assets: [{ name: "../outside.wav", resource: { status: "missing" } }] }] }]) {
    const child = childFixture(); const pending = new LazerSource(() => "engine.exe").resolveScore("C:\\lazer", selectedId, selectedHash);
    child.stdout.write(JSON.stringify({ ...good, sampleOnly: false, resolvedScoreId: selectedId,
      cursorToken: "b".repeat(64), scores: [selectedScore], ...patch })); child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ status: "incompatible-helper" });
  }
  expect((await new LazerSource(() => "engine.exe").resolveScore("C:\\lazer", "not-an-id", selectedHash)).status).toBe("invalid-source");
});
describe("single-name artwork source contract",()=>{
  const selection={mapSha256:"d".repeat(64),mapMd5:"e".repeat(32),name:"BG.png"};
  function native(){return new LazerSource(()=>"engine.exe");}
  function response(){return{...good,sampleOnly:false,resolvedScoreId:selectedId,cursorToken:"b".repeat(64),scores:[{...selectedScore,
    beatmap:{status:"unverified",path:"C:\\lazer\\files\\d\\dd\\"+selection.mapSha256,sha256:selection.mapSha256,md5:selection.mapMd5,bytes:100},
    artworkLookup:{...selection,complete:true}}]};}
  it("sends an exact map-bound lookup and retains partial-manifest semantics",async()=>{
    const child=childFixture();let request="";child.stdin.on("data",part=>{request+=part;});
    const work=native().resolveArtwork("C:\\lazer",selectedId,selectedHash,selection);
    expect(JSON.parse(request)).toMatchObject({operation:"resolve-artwork",scoreId:selectedId,expectedReplaySha256:selectedHash,expectedMapSha256:selection.mapSha256,expectedMapMd5:selection.mapMd5,assetName:"BG.png"});
    const result=response();child.stdout.write(JSON.stringify(result));child.emit("close",0);await expect(work).resolves.toEqual(result);
  });
  it.each(["name","map","incomplete","full-manifest","multiple","foreign-asset"])("rejects a %s targeted response",async fault=>{
    const child=childFixture(),work=native().resolveArtwork("C:\\lazer",selectedId,selectedHash,selection),result=response(),score=result.scores[0];
    if(fault==="name")score.artworkLookup.name="other.png";
    if(fault==="map")score.beatmap.sha256="f".repeat(64);
    if(fault==="incomplete")score.artworkLookup.complete=false;
    if(fault==="full-manifest")score.assetManifestComplete=true;
    if(fault==="multiple")Object.assign(score,{assets:[{name:"BG.png",resource:{status:"missing"}},{name:"bg.png",resource:{status:"missing"}}]});
    if(fault==="foreign-asset")Object.assign(score,{assets:[{name:"other.png",resource:{status:"missing"}}]});
    child.stdout.write(JSON.stringify(result));child.emit("close",0);await expect(work).resolves.toMatchObject({ok:false,status:"incompatible-helper"});
  });
});
