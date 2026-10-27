import { LibraryResourceSessions } from "./library-resource-sessions";
import type { PreparedLibraryReplay, PreparedLibraryMap } from "./library-selected-resources";
import type { LibraryOpenLocation } from "./library-store";
import { LibraryAssetUnavailableError } from "./library-resource-errors";
import type { LibraryIncidentEvidenceProbe } from "./library-incidents-probe";

const ticket: LibraryOpenLocation = { replayId: "replay", sourceId: "imports", sourceKey: "hash", locator: "D:\\owned\\one.osr",
  sha256: "a".repeat(64), locationRevision: 1, sourceConfigRevision: 1, kind: "imported", directory: "D:\\owned", metadata: {} };
function prepared(raw = "0|1|2|0,"): PreparedLibraryReplay {
  return { ticket, receipt: { sha256: ticket.sha256, available: true, metadata: {} }, data: {
    gameMode: 0, gameVersion: 20260101, beatmapMD5: "b".repeat(32), playerName: "Fixture", replayMD5: "c".repeat(32),
    number_300s: 1, number_100s: 0, number_50s: 0, misses: 0, score: 300, max_combo: 1, perfect_combo: 1, mods: 0,
    life_bar: "", replay_data: raw, replayContentSha256: ticket.sha256!, timestamp: 1700000000000,
  } };
}
const mapBytes = Buffer.from("fixture-map");
const resource = (bytes: Buffer) => ({ bytes, md5: "b".repeat(32), sha256: "d".repeat(64),
  stamp: { bytes: bytes.length, device: "1", inode: "2", modifiedNs: "3", changedNs: "4" } });
function map(): PreparedLibraryMap {
  return { map: resource(mapBytes), storyboards: [], assetManifestComplete: true,
    readAsset: async () => resource(Buffer.from("asset")) };
}
const probeResult = (): LibraryIncidentEvidenceProbe => ({
  evidence: { version: 1, state: "absent", replaySha256: ticket.sha256!, mapMd5: "b".repeat(32), validationVersion: "library-saved-evidence-v1" },
  scope: "stable-sidecar", observation: prepared().receipt, origin: null,
});

it("reports an absent asset without a transfer and preserves integrity failures", async () => {
  const asset = jest.fn().mockRejectedValueOnce(new LibraryAssetUnavailableError("gone"))
    .mockRejectedValueOnce(new Error("SHA mismatch"));
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => ({ ...map(), readAsset: asset }) });
  await sessions.begin("one", ticket); await sessions.prepareMap("one");
  await expect(sessions.openTransfer("one", "asset", "gone.wav")).resolves.toEqual({ id: "", bytes: 0, unavailable: true });
  await expect(sessions.openTransfer("one", "asset", "changed.wav")).rejects.toThrow("SHA mismatch");
  await sessions.close();
});

it("propagates dependency cleanup failure after failed work has already left the queue", async () => {
  const dependencies = { prepareReplay: async () => { throw new Error("Native cleanup failed"); }, prepareMap: async () => map(),
    close: jest.fn(async () => { throw new Error("Native cleanup failed"); }) };
  const sessions = new LibraryResourceSessions(dependencies);
  await expect(sessions.begin("one", ticket)).rejects.toThrow(/cleanup/i);
  await expect(sessions.close()).rejects.toThrow(/cleanup/i);
  expect(dependencies.close).toHaveBeenCalledTimes(1);
});

it("delivers ordered bounded copies, rejects stale offsets and releases consumed replay bytes", async () => {
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared("0|1|2|0,".repeat(90000)), prepareMap: async () => map() });
  await sessions.begin("one", ticket); await sessions.prepareMap("one");
  const transfer = await sessions.openTransfer("one", "replay");
  const chunks: Uint8Array[] = []; let offset = 0;
  while (offset < transfer.bytes) {
    const part = sessions.readChunk("one", transfer.id, offset);
    expect(part.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(part.bytes.buffer.byteLength).toBe(part.bytes.byteLength);
    chunks.push(part.bytes); offset += part.bytes.byteLength;
    expect(() => sessions.readChunk("one", transfer.id, offset - 1)).toThrow(/transfer|offset/i);
  }
  const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  expect(decoded.replay_data.length).toBe(720000); expect(decoded.timestamp).toBe(1700000000000);
  await expect(sessions.openTransfer("one", "replay")).rejects.toThrow(/consumed/i);
  const audio = await sessions.openTransfer("one", "asset", "audio.mp3");
  expect(Buffer.from(sessions.readChunk("one", audio.id, 0).bytes).toString()).toBe("asset");
  await sessions.close();
});

it("bounds retained sessions and keeps the current one until explicit release", async () => {
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => map() });
  await sessions.begin("current", ticket); await sessions.begin("next", ticket);
  await expect(sessions.begin("third", ticket)).rejects.toThrow(/limit/i);
  sessions.release("next"); await sessions.prepareMap("current");
  const transfer = await sessions.openTransfer("current", "map");
  expect(Buffer.from(sessions.readChunk("current", transfer.id, 0).bytes)).toEqual(mapBytes);
  sessions.release("current"); await expect(sessions.openTransfer("current", "map")).rejects.toThrow(/session/i);
  await sessions.close();
});

it("drains cancelled preparation and refuses its late result", async () => {
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pendingIO = new Promise<void>(resolve => { finish = resolve; });
  let observed: AbortSignal | undefined;
  const sessions = new LibraryResourceSessions({ prepareReplay: async (_ticket, signal) => {
    observed = signal; started(); await pendingIO; return prepared();
  }, prepareMap: async () => map() });
  const pending = sessions.begin("one", ticket); const rejected = expect(pending).rejects.toThrow(/abort/i);
  await entered; let closed = false;
  const closing = sessions.close().then(() => { closed = true; });
  expect(observed?.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
  finish(); await rejected; await closing;
  await expect(sessions.begin("later", ticket)).rejects.toThrow(/closed/i);
});

it("refuses an overlapping transfer instead of retaining repeated copies", async () => {
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => map() });
  await sessions.begin("one", ticket); await sessions.prepareMap("one");
  const first = await sessions.openTransfer("one", "map");
  await expect(sessions.openTransfer("one", "asset", "audio.mp3")).rejects.toThrow(/transfer/i);
  sessions.release("one"); expect(() => sessions.readChunk("one", first.id, 0)).toThrow(/session/i);
  await sessions.close();
});

it("does not let a cancelled generation release a replacement that reused its session ID", async () => {
  let finish!: () => void, entered!: () => void; let first = true;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pendingIO = new Promise<void>(resolve => { finish = resolve; });
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => {
    if (first) { first = false; entered(); await pendingIO; } return prepared();
  }, prepareMap: async () => map() });
  const old = sessions.begin("reused", ticket); const rejected = expect(old).rejects.toThrow(/abort/i);
  await started; sessions.release("reused"); const replacement = sessions.begin("reused", ticket);
  finish(); await rejected; await replacement;
  await expect(sessions.prepareMap("reused")).resolves.toMatchObject({ md5: "b".repeat(32) });
  await sessions.close();
});

it("finishes empty assets without leaving the transfer channel occupied", async () => {
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => ({ ...map(), readAsset: async () => resource(Buffer.alloc(0)) }) });
  await sessions.begin("one", ticket); await sessions.prepareMap("one");
  expect(await sessions.openTransfer("one", "asset", "empty.wav")).toMatchObject({ bytes: 0 });
  await expect(sessions.openTransfer("one", "map")).resolves.toMatchObject({ bytes: mapBytes.length });
  await sessions.close();
});

it("parks an independent background resource continuation without touching foreground sessions",async()=>{
  const foreground=new LibraryResourceSessions({prepareReplay:async()=>prepared(),prepareMap:async()=>map()});
  let checkpoint!:()=>Promise<void>,entered!:()=>void,continueIO!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),io=new Promise<void>(resolve=>{continueIO=resolve;});
  const prepareReplay=jest.fn(async(_ticket:LibraryOpenLocation,_signal:AbortSignal,yieldWork:()=>Promise<void>)=>{
    checkpoint=yieldWork;entered();await io;await checkpoint();return prepared();
  });
  const background=new LibraryResourceSessions({prepareReplay,prepareMap:async()=>map()},{background:true});
  const preparing=background.begin("background",ticket);let done=false;void preparing.then(()=>{done=true;});
  try {
    await new Promise(resolve=>setTimeout(resolve,5));expect(prepareReplay).not.toHaveBeenCalled();
    await background.control({viewerDemand:false,userPaused:false});await started;
    let acknowledged=false;const hold=background.control({viewerDemand:true,userPaused:false}).then(value=>{acknowledged=true;return value;});
    await Promise.resolve();expect(acknowledged).toBe(false);
    continueIO();expect(await hold).toBe("parked");expect(done).toBe(false);
    await foreground.begin("current",ticket);await foreground.prepareMap("current");
    await background.control({viewerDemand:false,userPaused:true});expect(done).toBe(false);
    await background.control({viewerDemand:false,userPaused:false});await preparing;expect(prepareReplay).toHaveBeenCalledTimes(1);
    await background.prepareMap("background");const transfer=await background.openTransfer("background","map");
    await background.control({viewerDemand:true,userPaused:false});let read=false;
    const chunk=background.readChunkAsync("background",transfer.id,0).then(value=>{read=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,5));expect(read).toBe(false);
    await background.control({viewerDemand:false,userPaused:false});expect(Buffer.from((await chunk).bytes)).toEqual(mapBytes);
  }finally{continueIO();await background.close();await foreground.close();await preparing.catch(()=>undefined);}
});

it("closes held background work only after owned dependencies drain",async()=>{
  let drain!:()=>void;const closed=new Promise<void>(resolve=>{drain=resolve;});
  const prepareReplay=jest.fn(async()=>prepared());
  const sessions=new LibraryResourceSessions({prepareReplay,prepareMap:async()=>map(),close:()=>closed},{background:true});
  const opening=sessions.begin("one",ticket).catch(error=>error);await sessions.control({viewerDemand:true,userPaused:false});
  let finished=false;const closing=sessions.close().then(()=>{finished=true;});
  try {await new Promise(resolve=>setTimeout(resolve,5));expect(finished).toBe(false);expect(prepareReplay).not.toHaveBeenCalled();}
  finally{drain();await closing;await opening;}
  expect(await opening).toMatchObject({name:"AbortError"});
});

it("describes verified numerical inputs before consuming replay bytes, with no frames in the descriptor",async()=>{
  const sessions=new LibraryResourceSessions({prepareReplay:async()=>prepared(),prepareMap:async()=>map()},{background:true});
  try {
    await sessions.control({viewerDemand:false,userPaused:false});await sessions.begin("one",ticket);await sessions.prepareMap("one");
    const descriptor=await sessions.describeAnalysis("one");
    expect(descriptor).toMatchObject({input:{format:"resources",mapBytes:mapBytes.length},target:{slot:"numerical",stage:"S"},origin:null});
    expect(JSON.stringify(descriptor)).not.toContain("replay_data");expect(JSON.stringify(descriptor).length).toBeLessThan(2048);
    const bytes=await sessions.openTransfer("one","replay");expect(bytes.bytes).toBe(descriptor.input.replayBytes);
    await sessions.readChunkAsync("one",bytes.id,0);await expect(sessions.describeAnalysis("one")).rejects.toThrow(/consumed/);
  }finally{await sessions.close();}
});

it("describes already verified foreground resources without another read, native request or background admission", async () => {
  const prepareReplay = jest.fn(async () => prepared()), prepareMap = jest.fn(async () => map());
  const sessions = new LibraryResourceSessions({ prepareReplay, prepareMap });
  try {
    await sessions.begin("foreground", ticket); await sessions.prepareMap("foreground");
    const descriptor = await sessions.describeAnalysis("foreground");
    expect(descriptor.input.binding).toEqual({ replaySha256: ticket.sha256, mapSha256: "d".repeat(64), mapMd5: "b".repeat(32), exactMapAndProfile: true });
    expect(prepareReplay).toHaveBeenCalledTimes(1); expect(prepareMap).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(descriptor)).not.toContain("replay_data");
    const transfer = await sessions.openTransfer("foreground", "replay"); sessions.readChunk("foreground", transfer.id, 0);
    await expect(sessions.describeAnalysis("foreground")).rejects.toThrow(/consumed/i);
  } finally { await sessions.close(); }
});
it("rejects contradictory foreground replay and map identity instead of issuing a numerical descriptor", async () => {
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => ({ ...map(), map: { ...resource(mapBytes), md5: "f".repeat(32) } }) });
  try {
    await sessions.begin("foreground", ticket); await sessions.prepareMap("foreground");
    await expect(sessions.describeAnalysis("foreground")).rejects.toThrow(/identity/i);
  } finally { await sessions.close(); }
});

it("performs fresh disposable incident probes through the background gate without replay/map preparation", async () => {
  const prepareReplay = jest.fn(async () => prepared()), prepareMap = jest.fn(async () => map());
  const probeIncidentEvidence = jest.fn(async (_ticket: LibraryOpenLocation, _signal: AbortSignal, checkpoint: () => Promise<void>) => {
    await checkpoint(); return probeResult();
  });
  const sessions = new LibraryResourceSessions({ prepareReplay, prepareMap, probeIncidentEvidence }, { background: true });
  const probe = (id: string) => sessions.probeIncidentEvidence(id, ticket);
  expect((sessions as unknown as Record<string, unknown>).probeIncidentEvidence).toEqual(expect.any(Function));
  const pending = probe("probe");
  try {
    await new Promise(resolve => setTimeout(resolve, 5)); expect(probeIncidentEvidence).not.toHaveBeenCalled();
    await sessions.control({ viewerDemand: false, userPaused: false });
    expect(await pending).toMatchObject({ evidence: { state: "absent" } });
    await probe("probe"); expect(probeIncidentEvidence).toHaveBeenCalledTimes(2);
    expect(prepareReplay).not.toHaveBeenCalled(); expect(prepareMap).not.toHaveBeenCalled();
  } finally { await sessions.close(); await pending.catch(() => undefined); }
});

it("drains cancelled evidence probes before close and never releases a reused session generation", async () => {
  let entered!: () => void, finish!: () => void, first = true;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const probeIncidentEvidence = async (_ticket: LibraryOpenLocation, signal: AbortSignal) => {
    if (first) { first = false; entered(); await held; signal.throwIfAborted(); }
    return probeResult();
  };
  const sessions = new LibraryResourceSessions({ prepareReplay: async () => prepared(), prepareMap: async () => map(), probeIncidentEvidence }, { background: true });
  const probe = (id: string) => sessions.probeIncidentEvidence(id, ticket);
  expect((sessions as unknown as Record<string, unknown>).probeIncidentEvidence).toEqual(expect.any(Function));
  await sessions.control({ viewerDemand: false, userPaused: false });
  const pending = probe("probe"), rejected = expect(pending).rejects.toThrow(/abort/i); await started;
  sessions.release("probe"); const replacement = probe("probe"); finish(); await rejected;
  expect(await replacement).toMatchObject({ evidence: { state: "absent" } }); await sessions.close();
});

it("waits for an in-flight evidence read to drain after cancellation and rejects foreground probing", async () => {
  let entered!: () => void, finish!: () => void, observed: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
  const dependencies = { prepareReplay: async () => prepared(), prepareMap: async () => map(),
    probeIncidentEvidence: async (_ticket: LibraryOpenLocation, signal: AbortSignal) => {
      observed = signal; entered(); await held; signal.throwIfAborted(); return probeResult();
    } };
  const foreground = new LibraryResourceSessions(dependencies), background = new LibraryResourceSessions(dependencies, { background: true });
  await expect(foreground.probeIncidentEvidence("probe", ticket)).rejects.toThrow(/background/i);
  await background.control({ viewerDemand: false, userPaused: false });
  const pending = background.probeIncidentEvidence("probe", ticket), rejected = expect(pending).rejects.toThrow(/abort/i);
  await started; let closed = false; const closing = background.close().then(() => { closed = true; });
  try {
    await Promise.resolve(); expect(observed?.aborted).toBe(true); expect(closed).toBe(false);
  } finally { finish(); await rejected; await closing; await foreground.close(); }
});
