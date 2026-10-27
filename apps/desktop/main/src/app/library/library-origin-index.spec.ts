import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { setImmediate } from "timers/promises";
import { LibraryOriginIndex, libraryOriginRevision, readLibraryOrigins, LibraryOriginSnapshot } from "./library-origin-index";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hindsight-origins-")); });
afterEach(async () => { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error("Unexpected fixture root"); await rm(root, { recursive: true, force: true }); });
const sha = "a".repeat(64);
const revisionFor=(fingerprint:string,state:LibraryOriginSnapshot["state"]="ready")=>libraryOriginRevision({fingerprint,state,entries:new Map()});
it("keeps the complete producer and source revision inside the persistent revision budget",()=>{
  const snapshot:LibraryOriginSnapshot={fingerprint:sha,state:"ready",entries:new Map()},revision=libraryOriginRevision(snapshot);
  expect(revision).toMatch(/^[a-zA-Z0-9:._-]{1,256}$/);
  expect(libraryOriginRevision({...snapshot,state:"error"})).not.toBe(revision);
  expect(libraryOriginRevision({...snapshot,fingerprint:"c".repeat(64)})).not.toBe(revision);

});
it("reads only bounded exact-byte confirmations and treats missing/invalid files as no evidence", async () => {
  const file = join(root, "origins.json");
  expect((await readLibraryOrigins(file)).state).toBe("missing");
  await writeFile(file, JSON.stringify({ version: 1, entries: { [sha]: { client: "lazer", provenance: "user-confirmed" },
    ["b".repeat(64)]: { client: "lazer", provenance: "inferred" }, filename: { client: "stable", provenance: "user-confirmed" } } }));
  const read = await readLibraryOrigins(file); expect(read.entries.size).toBe(1);
  expect(read.entries.get(sha)).toEqual({ client: "lazer", provenance: "user-confirmed" });
  await writeFile(file, "{"); expect(await readLibraryOrigins(file)).toMatchObject({ state: "invalid", entries: new Map() });
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1)); expect((await readLibraryOrigins(file)).state).toBe("error");
  const controller = new AbortController(); controller.abort(); await expect(readLibraryOrigins(file, controller.signal)).rejects.toThrow(/abort/i);
});

function fixture() {
  let notify!: () => void, snapshot: LibraryOriginSnapshot = { fingerprint: "one", state: "missing", entries: new Map() };
  let stored: string | undefined; const pages: (string | undefined)[] = []; const close = jest.fn();
  const publish = jest.fn(), read = jest.fn(async () => snapshot);
  const owner = new LibraryOriginIndex(join(root, "origins.json"), {
    publish, revision: () => stored, complete: value => { stored = value; return true; },
    invalidate: () => { stored = undefined; },
    page: after => { pages.push(after); return after ? { processed: 1 } : { processed: 1, next: "next" }; },
  }, { read, watch: (_file, changed) => { notify = changed; return close; } });
  return { owner, notify: () => notify(), pages, read, publish, close, stored: () => stored,
    snapshot: (value: LibraryOriginSnapshot) => { snapshot = value; } };
}
it("coalesces origin notifications and reprojects once per changed snapshot without cancelling active work", async () => {
  const f = fixture(); f.owner.start(); await f.owner.drain(); expect(f.pages).toEqual([undefined, "next"]);
  const before = f.read.mock.calls.length; for (let i = 0; i < 10; i++) f.notify(); await f.owner.drain();
  expect(f.read.mock.calls.length - before).toBeLessThanOrEqual(2); expect(f.pages).toHaveLength(2);
  f.snapshot({ fingerprint: "two", state: "ready", entries: new Map([[sha, { client: "lazer", provenance: "user-confirmed" }]]) });
  f.notify(); await f.owner.drain(); expect(f.pages).toHaveLength(4); expect(f.stored()).toBe(revisionFor("two"));
  f.snapshot({ fingerprint: "missing", state: "missing", entries: new Map() }); f.notify(); await f.owner.drain();
  expect(f.publish.mock.calls.at(-1)?.[0].entries.size).toBe(0); expect(f.pages).toHaveLength(6);
  await f.owner.close(); expect(f.close).toHaveBeenCalledTimes(1);
});
it("acknowledges viewer demand while parked, does not restart a page, and drains on close", async () => {
  const f = fixture(); await f.owner.setViewerDemand(true); f.owner.start();
  await setImmediate(); expect(f.pages).toEqual([]); await f.owner.setViewerDemand(true);
  await f.owner.setViewerDemand(false); await f.owner.drain(); expect(f.pages).toEqual([undefined, "next"]);
  await f.owner.setViewerDemand(true); f.notify(); await setImmediate(); await f.owner.close();
  expect(f.pages).toHaveLength(2); expect(f.close).toHaveBeenCalledTimes(1);
});
it("retains an actionable projection failure without committing its revision or silently retrying", async () => {
  let changed!: () => void, revision: string | undefined;
  const page = jest.fn(() => { throw Error("SQLite fixture failure"); });
  const owner = new LibraryOriginIndex(undefined, { publish: () => undefined, revision: () => revision,
    invalidate: () => { revision = undefined; }, complete: value => { revision = value; return true; }, page }, { watch: (_file, notify) => { changed = notify; return () => undefined; } });
  owner.start(); await owner.drain(); expect(owner.status()).toMatchObject({ state: "error", error: "SQLite fixture failure" });
  expect(revision).toBeUndefined(); expect(page).toHaveBeenCalledTimes(1); expect(changed).toBeUndefined();
  await owner.close();
});

it("invalidates the last complete revision before publishing a partially applied replacement", async () => {
  let revision: string | undefined, snapshot: LibraryOriginSnapshot = { fingerprint: "B", state: "ready", entries: new Map() }, fail = false;
  let notify!: () => void; const applied: string[] = [];
  const owner = new LibraryOriginIndex(join(root, "origins.json"), { revision: () => revision,
    invalidate: () => { revision = undefined; }, complete: value => { revision = value; return true; },
    publish: () => { if (snapshot.fingerprint === "A") expect(revision).toBeUndefined(); },
    page: after => { if (after && fail) throw Error("Interrupted A"); applied.push(snapshot.fingerprint); return after ? { processed: 1 } : { processed: 1, next: "second" }; },
  }, { read: async () => snapshot, watch: (_file, changed) => { notify = changed; return () => undefined; } });
  owner.start(); await owner.drain(); expect(revision).toBe(revisionFor("B"));
  fail = true; snapshot = { ...snapshot, fingerprint: "A" }; notify(); await owner.drain(); expect(revision).toBeUndefined();
  fail = false; snapshot = { ...snapshot, fingerprint: "B" }; notify(); await owner.drain();
  expect(applied).toEqual(["B", "B", "A", "B", "B"]); expect(revision).toBe(revisionFor("B")); await owner.close();
});

it("aborts and drains parked work even when watcher teardown throws", async () => {
  const page = jest.fn(() => ({ processed: 0 }));
  const owner = new LibraryOriginIndex(join(root, "origins.json"), { publish: () => undefined, revision: () => undefined,
    invalidate: () => undefined, complete: () => true, page }, { watch: () => () => { throw Error("watch close failure"); } });
  await owner.setViewerDemand(true); owner.start(); await setImmediate();
  await expect(owner.close()).rejects.toThrow("watch close failure");
  let drained = false; void owner.drain().then(() => { drained = true; }); await setImmediate(); await setImmediate();
  expect(drained).toBe(true); expect(page).not.toHaveBeenCalled();
});

it("handles a distinct notification received during a failed pass without looping the failed pass", async () => {
  let notify!: () => void, fingerprint = "A", revision: string | undefined;
  const applied: string[] = [];
  const owner = new LibraryOriginIndex(join(root, "origins.json"), { publish: () => undefined, revision: () => revision,
    invalidate: () => { revision = undefined; }, complete: value => { revision = value; return true; },
    page: () => { applied.push(fingerprint); if (fingerprint === "A") { fingerprint = "B"; notify(); throw Error("A failed"); } return { processed: 1 }; },
  }, { read: async () => ({ fingerprint, state: "missing", entries: new Map() }), watch: (_file, changed) => { notify = changed; return () => undefined; } });
  owner.start(); await owner.drain(); expect(applied).toEqual(["A", "B"]); expect(revision).toBe(revisionFor("B","missing")); await owner.close();
});

it("leaves map publications to their durable targeted reconciliation without another global origin pass", async () => {
  let maps = "A", revision: string | undefined;
  const applied: string[] = [], completed: string[] = [];
  const sink = { publish: () => undefined, revision: () => revision,
    invalidate: () => { revision = undefined; },
    complete: (value: string) => {
      revision = value; completed.push(value); return true;
    },
    page: (after?: string) => {
      applied.push(maps);
      if (!after) { maps = "B"; return { processed: 1, next: "second" }; }
      return { processed: 1 };
    },
  };
  const owner = new LibraryOriginIndex(undefined, sink);
  owner.start(); await owner.drain();
  expect(applied).toEqual(["A", "B"]);
  expect(completed).toHaveLength(1); expect(revision).toBe(libraryOriginRevision(await readLibraryOrigins()));
  owner.refresh(); await owner.drain(); expect(applied).toHaveLength(2);
  maps = "C"; owner.refresh(); await owner.drain();
  expect(applied).toEqual(["A", "B"]);
  await owner.close();
});

type OriginDependencyChange="retired-model"|"retired-limits"|"numerical"|"performance";
function originWithDependencyChange(change?:OriginDependencyChange):typeof import("./library-origin-index"){
  let result!:typeof import("./library-origin-index");
  try{
    jest.isolateModules(()=>{
      jest.doMock("../../../../shared/library-incidents",()=>{
        const actual=jest.requireActual<typeof import("../../../../shared/library-incidents")>("../../../../shared/library-incidents");
        return {...actual,LIBRARY_INCIDENT_DEPENDENCIES:{...actual.LIBRARY_INCIDENT_DEPENDENCIES,
          ...(change==="retired-model"?{model:"f".repeat(64)}:{})},
        LIBRARY_INCIDENT_TRACE_LIMITS:{...actual.LIBRARY_INCIDENT_TRACE_LIMITS,
          ...(change==="retired-limits"?{maxRecords:actual.LIBRARY_INCIDENT_TRACE_LIMITS.maxRecords+1}:{})}};
      });
      jest.doMock("../../../../shared/library-analysis",()=>{
        const actual=jest.requireActual<typeof import("../../../../shared/library-analysis")>("../../../../shared/library-analysis");
        return {...actual,...(change==="numerical"?{LIBRARY_NUMERIC_PROJECTION_VERSION:"numerical-changed-fixture"}:{})};
      });
      jest.doMock("./library-performance-versions",()=>{
        const actual=jest.requireActual<typeof import("./library-performance-versions")>("./library-performance-versions");
        return {...actual,...(change==="performance"?{LIBRARY_P_PRODUCER_VERSION:"performance-changed-fixture"}:{})};
      });
      result=jest.requireActual<typeof import("./library-origin-index")>("./library-origin-index");
    });
  }finally{
    jest.dontMock("../../../../shared/library-incidents");
    jest.dontMock("../../../../shared/library-analysis");
    jest.dontMock("./library-performance-versions");
  }
  return result;
}
it.each([
  ["retired-model",0],["retired-limits",0],["numerical",1],["performance",1],
] as const)("reconciles only active dependency changes: %s",async(change,expectedPages)=>{
  const snapshot:LibraryOriginSnapshot={state:"missing",fingerprint:"missing",entries:new Map()};
  const before=originWithDependencyChange().libraryOriginRevision(snapshot),variant=originWithDependencyChange(change);
  let stored:string|undefined=before;
  const page=jest.fn(()=>({processed:1})),complete=jest.fn((value:string)=>{stored=value;return true;});
  const owner=new variant.LibraryOriginIndex(undefined,{
    revision:()=>stored,invalidate:()=>{stored=undefined;},publish:()=>undefined,page,complete,
  });
  try{
    owner.start();await owner.drain();
    expect(page).toHaveBeenCalledTimes(expectedPages);expect(complete).toHaveBeenCalledTimes(expectedPages);
    expect(stored).toBe(variant.libraryOriginRevision(snapshot));
    if(expectedPages)expect(stored).not.toBe(before);else expect(stored).toBe(before);
    owner.refresh();await owner.drain();expect(page).toHaveBeenCalledTimes(expectedPages);
  }finally{await owner.close();}
});

// This is the retained fixture's actual completed historical key, never written into a real index.
const completedLegacyOrigin="library-origin-v2:24b09cfa06d9fda66dacce4329c96c8f635d696d8417f02695c6296d7930fbb5";
it("upgrades a completed v2 origin through one genuine pass and skips subsequent unchanged refreshes",async()=>{
  let stored:string|undefined=completedLegacyOrigin;
  const page=jest.fn((after?:string)=>after?{processed:1}:{processed:1,next:"second"});
  const complete=jest.fn((value:string)=>{stored=value;return true;});
  const owner=new LibraryOriginIndex(undefined,{revision:()=>stored,invalidate:()=>{stored=undefined;},
    publish:()=>{if(!complete.mock.calls.length)expect(stored).toBeUndefined();},page,complete});
  try{
    owner.start();await owner.drain();
    expect(page.mock.calls).toEqual([[undefined],["second"]]);expect(complete).toHaveBeenCalledTimes(1);
    expect(stored).toMatch(/^library-origin-v3:/);
    expect(stored).toBe(libraryOriginRevision({state:"missing",fingerprint:"missing",entries:new Map()}));
    owner.refresh();await owner.drain();expect(page).toHaveBeenCalledTimes(2);expect(complete).toHaveBeenCalledTimes(1);
  }finally{await owner.close();}
});
it("does not retain a completed v2 marker after an interrupted active-only transition",async()=>{
  let stored:string|undefined=completedLegacyOrigin,fail=true;
  const page=jest.fn((after?:string)=>{if(after&&fail)throw Error("interrupted transition");return after?{processed:1}:{processed:1,next:"second"};});
  const complete=jest.fn((value:string)=>{stored=value;return true;});
  const owner=new LibraryOriginIndex(undefined,{revision:()=>stored,invalidate:()=>{stored=undefined;},publish:()=>undefined,page,complete});
  try{
    owner.start();await owner.drain();
    expect(owner.status()).toMatchObject({state:"error",error:"interrupted transition"});
    expect(stored).toBeUndefined();expect(complete).not.toHaveBeenCalled();
    fail=false;owner.refresh();await owner.drain();
    expect(page.mock.calls).toEqual([[undefined],["second"],[undefined],["second"]]);
    expect(complete).toHaveBeenCalledTimes(1);expect(stored).toMatch(/^library-origin-v3:/);
    owner.refresh();await owner.drain();expect(page).toHaveBeenCalledTimes(4);
  }finally{await owner.close();}
});
