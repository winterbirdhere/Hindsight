import { LibraryMainOwner, LibraryChildOwner } from "./library-main-owner";
import type { LibraryServiceConfiguration } from "./library-service";

function fixture() {
  const calls: string[] = [], configurations: LibraryServiceConfiguration[] = [];
  const owners: LibraryChildOwner[] = [];
  const owner = new LibraryMainOwner({ directory: "D:\\owned", appData: "C:\\AppData", nativeExecutable: "D:\\engine.exe", sessionId: "app-session",
    originFile: "D:\\profile\\replay-origins.json" }, config => {
    configurations.push(config); const index = owners.length;
    const child = { start: jest.fn(async () => { calls.push(`${index}:start`); }),
      request: jest.fn(async (method: string) => { calls.push(`${index}:${method}`); return method; }),
      setViewerDemand: jest.fn(async (active: boolean) => { calls.push(`${index}:demand:${active}`); }),
      close: jest.fn(async () => { calls.push(`${index}:close`); }) };
    owners.push(child); return child;
  });
  return { owner, owners, configurations, calls };
}

it("starts one app-session utility with installation identities and initial demand before initialization", async () => {
  const f = fixture(); await f.owner.setViewerDemand(true);
  await f.owner.configure({ stable: { directory: "D:\\osu!", songsRoot: "D:\\Songs" } });
  expect(f.calls).toEqual(["0:demand:true", "0:start", "0:start-updates"]);
  expect(f.configurations[0]).toMatchObject({ sessionId: "app-session", originFile: "d:\\profile\\replay-origins.json", sources: expect.arrayContaining([
    expect.objectContaining({ kind: "stable", directory: "d:\\osu!", songsRoot: "d:\\songs" }),
    expect.objectContaining({ kind: "replays", directory: "d:\\osu!\\replays" }),
    expect.objectContaining({ kind: "lazer", directory: "c:\\appdata\\osu" }),
  ]) });
  await f.owner.configure({ stable: { directory: "D:\\osu!", songsRoot: "D:\\Songs" } });
  expect(f.owners).toHaveLength(1); expect(await f.owner.request("status")).toBe("status"); await f.owner.close();
});

it("keeps the automatic native candidate distinct from an explicitly selected or saved installation", async () => {
  const f = fixture(); await f.owner.configure({});
  const automatic = f.configurations[0].sources.find(source => source.kind === "lazer");
  expect(automatic).toMatchObject({ directory: "c:\\appdata\\osu", configuration: "automatic" });
  await f.owner.configure({ stable: { directory: "D:\\stable", songsRoot: "D:\\maps" } });
  expect(f.configurations.at(-1)?.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "stable", configuration: "configured" }),
    expect.objectContaining({ kind: "replays", configuration: "configured" }),
    expect.objectContaining({ kind: "lazer", configuration: "automatic" }),
  ]));
  await f.owner.configure({ lazerDirectory: "C:\\AppData\\osu" });
  const selected = f.configurations.at(-1)?.sources.find(source => source.kind === "lazer");
  expect(selected).toMatchObject({ id: automatic?.id, configuration: "configured" });
  await f.owner.configure({ stable: null }); await f.owner.retry();
  expect(f.configurations.at(-1)?.sources).toEqual([
    expect.objectContaining({ kind: "lazer", configuration: "configured" }),
  ]);
  await f.owner.close();
});

it("drains old ownership before changed configuration and preserves installation identities on reconnection", async () => {
  const f = fixture(), first = { stable: { directory: "D:\\first", songsRoot: "D:\\first\\Songs" } };
  await f.owner.configure(first); const ids = f.configurations[0].sources.map(source => source.id);
  let release!: () => void; (f.owners[0].close as jest.Mock).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const next = f.owner.configure({ stable: { directory: "D:\\second", songsRoot: "D:\\second\\Songs" } });
  await Promise.resolve(); await Promise.resolve(); expect(f.owners).toHaveLength(1);
  release(); await next; expect(f.configurations[1].sources[0].id).not.toBe(ids[0]);
  await f.owner.configure(first); expect(f.configurations[2].sources.map(source => source.id)).toEqual(ids); await f.owner.close();
});

it("does not restart a failed process on ordinary requests; retry is explicit and serialized", async () => {
  const f = fixture(); await f.owner.configure({}); (f.owners[0].request as jest.Mock).mockRejectedValue(new Error("crashed"));
  await expect(f.owner.request("status")).rejects.toThrow("crashed"); expect(f.owners).toHaveLength(1);
  await f.owner.retry(); expect(f.owners).toHaveLength(2); await f.owner.close();
  await expect(f.owner.configure({})).rejects.toThrow(/closed/i); expect(f.owners).toHaveLength(2);
});

it("rechecks a foreground capability after queued configuration and forwards its final send guard",async()=>{
  const f=fixture();await f.owner.configure({});let release!:()=>void;
  (f.owners[0].close as jest.Mock).mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const changed=f.owner.configure({lazerDirectory:"D:\\new"});await Promise.resolve();await Promise.resolve();
  const revoked=()=>{throw Error("document expired");};const request=f.owner.request("status",{},revoked);
  const rejected=expect(request).rejects.toThrow("document expired");release();await changed;await rejected;
  expect(f.owners[1].request).not.toHaveBeenCalledWith("status",expect.anything(),expect.anything());
  const guard=jest.fn();await f.owner.request("status",{},guard);expect(f.owners[1].request).toHaveBeenCalledWith("status",{},guard);await f.owner.close();
});

it("rejects unbounded/relative configuration and does not start a child after shutdown wins", async () => {
  const f = fixture(); await expect(f.owner.configure({ stable: { directory: "relative", songsRoot: "D:\\Songs" } })).rejects.toThrow(/configuration/i);
  const configured = f.owner.configure({}); const closed = f.owner.close();
  await expect(configured).rejects.toThrow(/closed/i); await closed; expect(f.owners).toHaveLength(0);
});

it("inherits queued installation changes and retries the latest configuration", async () => {
  const f = fixture(); await f.owner.configure({});
  const native = f.owner.configure({ lazerDirectory: "D:\\custom-native" });
  const stable = f.owner.configure({ stable: { directory: "D:\\stable", songsRoot: "D:\\maps" } });
  const retry = f.owner.retry(); await Promise.all([native, stable, retry]);
  expect(f.configurations.at(-1)?.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "stable", directory: "d:\\stable" }),
    expect.objectContaining({ kind: "lazer", directory: "d:\\custom-native" }),
  ]));
  await f.owner.configure({ lazerDirectory: "D:\\another-native" });
  expect(f.configurations.at(-1)?.sources.some(source => source.kind === "stable")).toBe(true);
  await f.owner.close();
});

it("uses the same configuration and identity for equivalent Windows paths", async () => {
  const f = fixture(); await f.owner.configure({ stable: { directory: "D:\\Osu", songsRoot: "D:\\Maps" }, lazerDirectory: "D:\\Native" });
  await f.owner.configure({ stable: { directory: "d:\\OSU\\", songsRoot: "d:\\MAPS\\" }, lazerDirectory: "d:\\NATIVE\\" });
  expect(f.owners).toHaveLength(1);
  await f.owner.configure({ stable: { directory: "D:\\", songsRoot: "D:\\" } });
  expect(f.configurations.at(-1)?.sources[0].directory).toMatch(/^[a-z]:\\$/i); await f.owner.close();
});

it("acknowledges demand during retirement without sending to the closing child", async () => {
  const f = fixture(); await f.owner.configure({});
  let release!: () => void;
  (f.owners[0].close as jest.Mock).mockImplementationOnce(() => {
    (f.owners[0].setViewerDemand as jest.Mock).mockRejectedValue(new Error("closing"));
    return new Promise<void>(resolve => { release = resolve; });
  });
  const changed = f.owner.configure({ lazerDirectory: "D:\\new" });
  await Promise.resolve(); await Promise.resolve();
  const demand = f.owner.setViewerDemand(true); const result = expect(demand).resolves.toBeUndefined();
  release(); await Promise.all([changed, result]);
  expect(f.owners[0].setViewerDemand).toHaveBeenCalledTimes(1);
  expect(f.owners[1].setViewerDemand).toHaveBeenNthCalledWith(1, true); await f.owner.close();
});

it("cancels initialization before waiting for it during close", async () => {
  const f = fixture(); let cancel!: () => void;
  const configured = f.owner.configure({});
  await Promise.resolve();
  (f.owners[0].start as jest.Mock).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { cancel = () => reject(new Error("cancelled")); }));
  (f.owners[0].close as jest.Mock).mockImplementationOnce(async () => { cancel(); });
  await Promise.resolve();
  const failure = expect(configured).rejects.toThrow("cancelled"); await f.owner.close(); await failure;
  expect(f.owners[0].request).not.toHaveBeenCalled();
});

it("waits for retirement on shutdown and never creates the queued replacement", async () => {
  const f = fixture(); await f.owner.configure({}); let release!: () => void;
  (f.owners[0].close as jest.Mock).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const changed = f.owner.configure({ lazerDirectory: "D:\\new" });
  await Promise.resolve(); await Promise.resolve();
  const failure = expect(changed).rejects.toThrow(/closed/i); const closed = f.owner.close();
  release(); await Promise.all([failure, closed]); expect(f.owners[0].close).toHaveBeenCalledTimes(1); expect(f.owners).toHaveLength(1);
});
