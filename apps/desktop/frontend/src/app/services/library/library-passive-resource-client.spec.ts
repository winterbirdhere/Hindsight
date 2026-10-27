import { LibraryPassiveResourceClient, retainLibraryPassiveResourceSnapshot } from "./library-passive-resource-client";
import type { LibraryPassiveResourceRequest } from "../../../../../shared/library-passive-resources";
import type { LibraryErrorStrip } from "../../../../../shared/library-error-strip";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const knownStrip: LibraryErrorStrip = { version: 1, timeBasis: "map-ms", ruleset: "stable", mapStartMs: 0, mapEndMs: 1000, evaluatedThrough: 1000, endpointBasis: "recorded-end", synthesizedEndpoint: false, ok: [], meh: [], miss: [500], sliderEndMiss: [], sliderBreak: [] };
const stripReply = { target: { slot: "numerical", stage: "S" }, result: { state: "known", value: knownStrip } };
describe("passive artwork and selected strip lifetime", () => {
  function fixture() {
    const calls: LibraryPassiveResourceRequest[] = [], revoked: string[] = []; let urls = 0;
    const identities = new Map<string, number>(), requests = new Map<string, number>();
    const resource = async (input: LibraryPassiveResourceRequest): Promise<unknown> => {
      calls.push(input);
      if (input.method === "artwork") {
        if (!identities.has(input.replayId)) identities.set(input.replayId, identities.size + 1);
        requests.set(input.requestId, identities.get(input.replayId) ?? 0);
        return { state: "ready", bytes: 3, mime: "image/png" };
      }
      if (input.method === "chunk") { const id = requests.get(input.requestId); return { bytes: new Uint8Array(id === undefined ? [1, 2, 3] : [id & 255, id >> 8, 3]), done: true }; }
      if (input.method === "release") requests.delete(input.requestId);
      if (input.method === "strip") return null;
      return input.method === "reveal" ? { revealed: true } : undefined;
    };
    const client = new LibraryPassiveResourceClient({ resource }, { create: () => `blob:${++urls}`, revoke: url => { revoked.push(url); } });
    return { client, calls, revoked, resource };
  }
  function contentFixture(contentOf: (id: string) => string = id => id, byteLength = 3) {
    const identities = new Map<string, number>(), requests = new Map<string, number>();
    const reads: string[] = [], revoked: string[] = [], live = new Map<string, number>(); let created = 0;
    const resource = async (input: LibraryPassiveResourceRequest): Promise<unknown> => {
      if (input.method === "artwork") {
        reads.push(input.replayId); const key = contentOf(input.replayId);
        if (!identities.has(key)) identities.set(key, identities.size + 1);
        requests.set(input.requestId, identities.get(key) ?? 0);
        return { state: "ready", bytes: byteLength, mime: "image/png" };
      }
      if (input.method === "chunk") {
        const bytes = new Uint8Array(Math.min(64 * 1024, byteLength - input.offset));
        if (input.offset === 0) { const id = requests.get(input.requestId) ?? 0; bytes[0] = id & 255; bytes[1] = id >> 8; bytes[2] = 3; }
        return { bytes, done: input.offset + bytes.length === byteLength };
      }
      if (input.method === "release") requests.delete(input.requestId);
      return input.method === "strip" ? null : undefined;
    };
    const urls = { create: (bytes: Uint8Array) => { const url = `blob:${++created}`; live.set(url, bytes.length); return url; }, revoke: (url: string) => { expect(live.delete(url)).toBe(true); revoked.push(url); } };
    return { client: new LibraryPassiveResourceClient({ resource }, urls), resource, urls, reads, revoked, live, created: () => created };
  }
  const invalidateIds = (client: LibraryPassiveResourceClient, artworkIds: string[]) => {
    const options = { artwork: true, strip: false, preserveArtwork: true, artworkIds };
    client.invalidate(options);
  };
  it.each(["stale-release", "peer-release"])("admits no queued artwork after %s cleanup fails, including stale-result continuations", async kind => {
    const f = contentFixture(), gates = { a: deferred<void>(), b: deferred<void>() },
      entered = { a: deferred<void>(), b: deferred<void>() }, failedRelease = deferred<void>();
    const requests = new Map<string, string>(), poisoned = kind === "stale-release" ? "a" : "b";
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork") {
        requests.set(input.requestId, input.replayId);
        const reply = await f.resource(input);
        if (input.replayId === "a" || input.replayId === "b") {
          entered[input.replayId].resolve(); await gates[input.replayId].promise;
        }
        return reply;
      }
      if (input.method === "release" && requests.get(input.requestId) === poisoned) {
        failedRelease.resolve(); throw Error("release was not acknowledged");
      }
      return f.resource(input);
    } }, f.urls);
    const pending = client.update({ artworkIds: ["a", "b", "c"] });
    try {
      await Promise.all([entered.a.promise, entered.b.promise]);
      invalidateIds(client, ["a"]);
      gates[poisoned].resolve(); await failedRelease.promise;
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
      gates.a.resolve(); gates.b.resolve(); await pending;
      expect(f.reads).toEqual(["a", "b"]);
      await expect(client.update({ artworkIds: ["c"] })).rejects.toThrow("unavailable");
      await expect(client.dispose()).rejects.toThrow("cleanup did not complete");
    } finally {
      gates.a.resolve(); gates.b.resolve(); await pending;
      await client.dispose().catch(() => undefined);
    }
  });
  it("scoped changes retain untouched inactive artwork without a new read or URL", async () => {
    const f = contentFixture();
    try {
      const first = await f.client.update({ artworkIds: ["a", "b"] });
      await f.client.update({ artworkIds: ["c"] });
      invalidateIds(f.client, ["a"]);
      const updates: Readonly<Record<string, { artUrl?: string }>>[] = [];
      await f.client.update({ artworkIds: ["b"], onUpdate: value => updates.push(value) });
      expect(updates[0].b?.artUrl).toBe(first.b.artUrl);
      expect(f.reads).toEqual(["a", "b", "c"]);
      expect(f.revoked).not.toContain(first.b.artUrl);
    } finally { await f.client.dispose(); }
  });
  it("scoped changes fence only the affected admitted read before publication", async () => {
    const f = contentFixture(), entered = deferred<void>(), held = deferred<unknown>();
    let aRead = 0;
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork" && input.replayId === "a" && aRead++ === 0) { entered.resolve(); return held.promise; }
      return f.resource(input);
    } }, f.urls);
    try {
      const pending = client.update({ artworkIds: ["a", "b"] });
      await entered.promise;
      invalidateIds(client, ["a"]);
      held.resolve({ state: "ready", bytes: 3, mime: "image/png" });
      const result = await pending;
      expect(result.a?.artUrl).toBeUndefined();
      expect(result.b?.artUrl).toBeDefined();
      expect(f.reads.filter(id => id === "b")).toHaveLength(1);
      const current = await client.update({ artworkIds: ["a", "b"] });
      expect(current.a.artUrl).toBeDefined();
      expect(current.b.artUrl).toBe(result.b.artUrl);
    } finally { held.resolve({ state: "unavailable" }); await client.dispose(); }
  });
  it("does not expose stale inactive artwork during repeated scoped changes and reuses its URL only after verification", async () => {
    const f = contentFixture(), entered = deferred<void>(), held = deferred<void>(); let hold = false;
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      const result = await f.resource(input);
      if (input.method === "artwork" && input.replayId === "a" && hold) { entered.resolve(); await held.promise; }
      return result;
    } }, f.urls);
    try {
      const first = await client.update({ artworkIds: ["a"] });
      await client.update({ artworkIds: ["b"] });
      invalidateIds(client, ["a"]);
      hold = true;
      const updates: Readonly<Record<string, { artUrl?: string }>>[] = [];
      const pending = client.update({ artworkIds: ["a"], onUpdate: value => updates.push(value) });
      await entered.promise;
      invalidateIds(client, ["a"]);
      hold = false; held.resolve();
      expect((await pending).a?.artUrl).toBeUndefined();
      expect(updates.every(value => value.a?.artUrl === undefined)).toBe(true);
      expect(f.revoked).not.toContain(first.a.artUrl);
      const verified = await client.update({ artworkIds: ["a"] });
      expect(verified.a.artUrl).toBe(first.a.artUrl);
      expect(f.reads).toEqual(["a", "b", "a", "a"]);
    } finally { held.resolve(); await client.dispose(); }
  });
  it.each(["unavailable", "error"])("ignores an affected stale %s reply instead of replacing the displayed verified image", async kind => {
    const f = contentFixture(), entered = deferred<void>(), held = deferred<void>(); let hold = false;
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork" && hold) {
        entered.resolve(); await held.promise;
        if (kind === "error") throw Error("old read failed");
        return { state: "unavailable" };
      }
      return f.resource(input);
    } }, f.urls);
    try {
      const first = await client.update({ artworkIds: ["a"] });
      invalidateIds(client, ["a"]); hold = true;
      const pending = client.update({ artworkIds: ["a"] }); await entered.promise;
      invalidateIds(client, ["a"]); hold = false; held.resolve();
      expect((await pending).a).toEqual(first.a);
      expect((await client.update({ artworkIds: ["a"] })).a).toEqual(first.a);
      expect(f.created()).toBe(1);
    } finally { held.resolve(); await client.dispose(); }
  });
  it("bounds scoped epoch bookkeeping to retained IDs and ignores arbitrary uncached change history", async () => {
    const f = contentFixture();
    const epochs = () => (f.client as unknown as { artworkEpochs: Map<string, number> }).artworkEpochs.size;
    try {
      for (let batch = 0; batch < 24; batch++) {
        const ids = Array.from({ length: 32 }, (_, offset) => `replay-${batch * 32 + offset}`);
        await f.client.update({ artworkIds: ids }); invalidateIds(f.client, ids);
        expect(epochs()).toBeLessThanOrEqual(288);
        expect(f.live.size).toBeLessThanOrEqual(288);
      }
      const retained = epochs();
      for (let batch = 0; batch < 20; batch++)
        invalidateIds(f.client, Array.from({ length: 256 }, (_, offset) => `never-retained-${batch * 256 + offset}`));
      expect(epochs()).toBe(retained);
      f.client.invalidate();
      expect(epochs()).toBe(0);
      expect(f.live.size).toBe(0);
    } finally { await f.client.dispose(); }
  });
  it("retains shared content leases when a scoped alias changes and another alias is still rendered", async () => {
    let changed = false;
    const f = contentFixture(id => changed && id === "a" ? "changed" : "shared");
    const first = await f.client.update({ artworkIds: ["a", "b"] });
    const release = retainLibraryPassiveResourceSnapshot(first);
    try {
      changed = true; invalidateIds(f.client, ["a"]);
      const next = await f.client.update({ artworkIds: ["a", "b"] });
      expect(next.a.artUrl).not.toBe(first.a.artUrl);
      expect(next.b.artUrl).toBe(first.b.artUrl);
      expect(f.reads).toEqual(["a", "b", "a"]);
      expect(f.revoked).toEqual([]);
      await f.client.dispose();
      expect(f.live.size).toBe(1);
      release(); expect(f.live.size).toBe(0);
    } finally { release(); await f.client.dispose(); }
  });
  it("keeps visible and recently used URLs and reads only the selected strip", async () => {
    const f = fixture(), first = await f.client.update({ artworkIds: ["a", "b"], stripReplayId: "a" });
    const second = await f.client.update({ artworkIds: ["b", "c"], stripReplayId: "c" });
    expect(second.b.artUrl).toBe(first.b.artUrl); expect(f.revoked).toEqual([]);
    expect(f.calls.filter(c => c.method === "strip").map(c => "replayId" in c && c.replayId)).toEqual(["a", "c"]);
    expect(f.calls.filter(c => c.method === "artwork").length).toBe(3);
    await f.client.dispose(); expect(new Set(f.revoked)).toEqual(new Set([first.a.artUrl, first.b.artUrl, second.c.artUrl]));
  });
  it("revalidates identical bytes without a new URL and retires changed bytes only after the displayed lease releases", async () => {
    const f = fixture();
    let byte = 1, created = 0;
    const client = new LibraryPassiveResourceClient({ resource: async input => input.method === "chunk" ? { bytes: new Uint8Array([byte, 2, 3]), done: true } : f.resource(input) }, {
      create: () => `blob:verified-${++created}`, revoke: url => { f.revoked.push(url); },
    });
    const first = await client.update({ artworkIds: ["a"] });
    const release = retainLibraryPassiveResourceSnapshot(first);
    try {
      client.invalidate({ preserveArtwork: true });
      const same = await client.update({ artworkIds: ["a"] });
      expect(same.a.artUrl).toBe(first.a.artUrl); expect(created).toBe(1);
      byte = 9; client.invalidate({ preserveArtwork: true });
      const changed = await client.update({ artworkIds: ["a"] });
      expect(changed.a.artUrl).not.toBe(first.a.artUrl); expect(created).toBe(2);
      expect(f.revoked).toEqual([]);
      release(); expect(f.revoked).toEqual([first.a.artUrl]);
    } finally { release(); await client.dispose(); }
    expect(new Set(f.revoked)).toEqual(new Set(["blob:verified-1", "blob:verified-2"]));
  });
  it("bounds repeated changed-byte revalidation with one retained render and never retains duplicate byte payloads as URLs", async () => {
    const f = fixture(), live = new Set<string>();
    let byte = 1, created = 0, peak = 0;
    const client = new LibraryPassiveResourceClient({ resource: async input => input.method === "chunk" ? { bytes: new Uint8Array([byte, 2, 3]), done: true } : f.resource(input) }, {
      create: () => { const url = `blob:${++created}`; live.add(url); peak = Math.max(peak, live.size); return url; },
      revoke: url => { live.delete(url); f.revoked.push(url); },
    });
    const ids = Array.from({ length: 32 }, (_, index) => String(index));
    const first = await client.update({ artworkIds: ids });
    const release = retainLibraryPassiveResourceSnapshot(first);
    try {
      for (byte = 2; byte <= 6; byte++) {
        client.invalidate({ preserveArtwork: true });
        await client.update({ artworkIds: ids });
        // All 32 aliases have equal bytes: one current and one held old content.
        expect(live.size).toBe(2);
      }
      // One held old content, one current content and one replacement allocation.
      expect(peak).toBeLessThanOrEqual(3);
      await client.dispose(); expect(live.size).toBe(1);
      release(); expect(live.size).toBe(0);
      expect(created).toBe(6); expect(new Set(f.revoked).size).toBe(6);
    } finally { release(); await client.dispose(); }
  });
  it("keeps an explicitly retained immutable snapshot alive across invalidation and disposal without reusing stale artwork", async () => {
    const f = fixture(), first = await f.client.update({ artworkIds: ["a"] });
    const releaseFirst = retainLibraryPassiveResourceSnapshot(first);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.a)).toBe(true);
    f.client.invalidate();
    expect(f.revoked).toEqual([]);
    const second = await f.client.update({ artworkIds: ["a"] });
    expect(second.a.artUrl).not.toBe(first.a.artUrl);
    const releaseSecond = retainLibraryPassiveResourceSnapshot(second);
    await f.client.dispose();
    expect(f.revoked).toEqual([]);
    releaseFirst(); releaseFirst();
    expect(f.revoked).toEqual([first.a.artUrl]);
    releaseSecond();
    expect(f.revoked).toEqual([first.a.artUrl, second.a.artUrl]);
    retainLibraryPassiveResourceSnapshot(first)();
    expect(f.revoked).toHaveLength(2);
  });
  it("does not accumulate uncommitted generations while one rendered window is retained", async () => {
    const f = fixture(), ids = Array.from({ length: 32 }, (_, index) => String(index));
    const first = await f.client.update({ artworkIds: ids });
    const releaseRender = retainLibraryPassiveResourceSnapshot(first);
    for (let generation = 0; generation < 5; generation++) {
      f.client.invalidate();
      const latest = await f.client.update({ artworkIds: ids });
      const created = f.calls.filter(call => call.method === "artwork").length;
      expect(created - f.revoked.length).toBe(64);
      expect(latest["0"].artUrl).not.toBe(first["0"].artUrl);
    }
    await f.client.dispose();
    expect(f.calls.filter(call => call.method === "artwork").length - f.revoked.length).toBe(32);
    releaseRender();
    expect(new Set(f.revoked).size).toBe(192);
  });
  it("never publishes artwork returned after its desired set was superseded", async () => {
    const gate = deferred<unknown>(), entered = deferred<void>(), revoked: string[] = [];
    const f = fixture(); let created = 0;
    const client = new LibraryPassiveResourceClient({ resource: input => { if (input.method === "artwork" && input.replayId === "old") { entered.resolve(); return gate.promise; } return f.resource(input); } }, { create: () => `blob:${++created}`, revoke: url => { revoked.push(url); } });
    const oldUpdates: unknown[] = [], currentUpdates: Readonly<Record<string, unknown>>[] = [];
    const old = client.update({ artworkIds: ["old"], onUpdate: value => oldUpdates.push(value) }); await entered.promise;
    const beforeReplacement = oldUpdates.length;
    const current = client.update({ artworkIds: ["new"], onUpdate: value => currentUpdates.push(value) }); gate.resolve({ state: "ready", bytes: 3, mime: "image/png" });
    expect(await old).toEqual({}); expect((await current).new.artUrl).toBeDefined(); expect(created).toBe(1);
    expect(oldUpdates).toHaveLength(beforeReplacement); expect(currentUpdates.every(value => value.old === undefined)).toBe(true);
    await client.dispose();
  });
  it("rejects oversized replies without allocating URLs and releases the session", async () => {
    const calls: LibraryPassiveResourceRequest[] = []; let created = false;
    const client = new LibraryPassiveResourceClient({ resource: async input => { calls.push(input); return { state: "ready", bytes: 100000000, mime: "image/png" }; } }, { create: () => { created = true; return "blob:x"; }, revoke: () => undefined });
    expect(await client.update({ artworkIds: ["a"] })).toEqual({ a: { artworkError: expect.any(String) } }); expect(created).toBe(false);
    expect(calls.some(c => c.method === "release")).toBe(true); await client.dispose();
  });
  it("invalidates cached artifacts and rejects bulk viewport requests", async () => {
    const f = fixture(), result = await f.client.update({ artworkIds: ["a"] }); f.client.invalidate();
    expect(f.revoked).toContain(result.a.artUrl);
    await expect(f.client.update({ artworkIds: Array.from({ length: 33 }, (_, i) => String(i)) })).rejects.toThrow(); await f.client.dispose();
  });
  it("refreshes the selected strip while retaining artwork on metric-only changes", async () => {
    const f = fixture(), first = await f.client.update({ artworkIds: ["a"], stripReplayId: "a" });
    f.client.invalidate({ artwork: false, strip: true });
    const second = await f.client.update({ artworkIds: ["a"], stripReplayId: "a" });
    expect(second.a.artUrl).toBe(first.a.artUrl); expect(f.revoked).toEqual([]);
    expect(f.calls.filter(call => call.method === "artwork")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "strip")).toHaveLength(2); await f.client.dispose();
  });
  it("retains a slow same-generation artwork read while refreshing the selected strip", async () => {
    const f = fixture(), entered = deferred<void>(), artwork = deferred<unknown>();
    const client = new LibraryPassiveResourceClient({ resource: async request => {
      if (request.method === "artwork") { f.calls.push(request); entered.resolve(); return artwork.promise; }
      return f.resource(request);
    } }, { create: bytes => { expect(Array.from(bytes)).toEqual([1, 2, 3]); return "blob:retained"; }, revoke: () => undefined });
    const previousController = new AbortController();
    try {
      const previous = client.update({ artworkIds: ["a"], stripReplayId: "a" }, previousController.signal);
      await entered.promise;
      client.invalidate({ artwork: false, strip: true });
      previousController.abort();
      const current = client.update({ artworkIds: ["a"], stripReplayId: "a" });
      artwork.resolve({ state: "ready", bytes: 3, mime: "image/png" });
      expect(await previous).toEqual({});
      expect(await current).toEqual({ a: { artUrl: "blob:retained" } });
      expect(f.calls.filter(call => call.method === "artwork")).toHaveLength(1);
      expect(f.calls.filter(call => call.method === "strip")).toHaveLength(2);
    } finally { artwork.resolve({ state: "unavailable" }); await client.dispose(); }
  });
  it("cancels slow artwork when its route abort has no replacement viewport", async () => {
    const f = fixture(), entered = deferred<void>(), artwork = deferred<unknown>(), controller = new AbortController();
    const client = new LibraryPassiveResourceClient({ resource: async request => {
      if (request.method === "artwork") { f.calls.push(request); entered.resolve(); return artwork.promise; }
      return f.resource(request);
    } }, { create: () => { throw Error("Cancelled artwork cannot create a URL"); }, revoke: () => undefined });
    const pending = client.update({ artworkIds: ["a"] }, controller.signal); await entered.promise; controller.abort();
    try { expect(await pending).toEqual({}); expect(f.calls.filter(call => call.method === "release")).toHaveLength(1); }
    finally { artwork.resolve({ state: "unavailable" }); await client.dispose(); }
  });
  it("rejects partial or inconsistent chunks and reports verification failure without creating a URL", async () => {
    let created = false;
    const client = new LibraryPassiveResourceClient({ resource: async request => request.method === "artwork" ? { state: "ready", bytes: 3, mime: "image/png" } : request.method === "chunk" ? { bytes: new Uint8Array([1]), done: true } : undefined },
      { create: () => { created = true; return "blob:x"; }, revoke: () => undefined });
    expect(await client.update({ artworkIds: ["a"] })).toEqual({ a: { artworkError: expect.any(String) } }); expect(created).toBe(false); await client.dispose();
  });
  it("does not begin a replacement read until the previous release acknowledges drainage", async () => {
    const entered = deferred<void>(), releaseGate = deferred<void>(), oldReply = deferred<unknown>(), f = fixture(); let oldRequest = "", nextStarted = false;
    const client = new LibraryPassiveResourceClient({ resource: async request => {
      if (request.method === "artwork" && request.replayId === "old") { oldRequest = request.requestId; entered.resolve(); return oldReply.promise; }
      if (request.method === "release" && request.requestId === oldRequest) return releaseGate.promise;
      if (request.method === "artwork") nextStarted = true;
      return f.resource(request);
    } }, { create: () => "blob:current", revoke: () => undefined });
    const old = client.update({ artworkIds: ["old"] }); await entered.promise;
    const next = client.update({ artworkIds: ["new"] }); await Promise.resolve(); await Promise.resolve(); expect(nextStarted).toBe(false);
    releaseGate.resolve(); expect(await old).toEqual({}); expect((await next).new.artUrl).toBeDefined();
    oldReply.resolve({ state: "unavailable" }); await client.dispose();
  });
  it("reuses verified offscreen artwork on scroll-back without re-reading or resurrecting a retired URL", async () => {
    const f = fixture();
    try {
      const first = await f.client.update({ artworkIds: ["a"] });
      await f.client.update({ artworkIds: ["b"] });
      await f.client.update({ artworkIds: [] });
      const returned = await f.client.update({ artworkIds: ["a"] });
      expect(returned.a.artUrl).toBe(first.a.artUrl);
      expect(f.revoked).not.toContain(first.a.artUrl);
      expect(f.calls.filter(c => c.method === "artwork").map(c => "replayId" in c && c.replayId)).toEqual(["a", "b"]);
    } finally { await f.client.dispose(); }
    expect(new Set(f.revoked).size).toBe(2);
  });
  it("publishes a fast verified image while the slower batch peer is still pending", async () => {
    const f = fixture(), slow = deferred<unknown>();
    const updates: Readonly<Record<string, { artUrl?: string }>>[] = [];
    const client = new LibraryPassiveResourceClient({ resource: input => input.method === "artwork" && input.replayId === "slow" ? slow.promise : f.resource(input) }, { create: () => "blob:fast", revoke: () => undefined });
    const desired = { artworkIds: ["fast", "slow"], onUpdate: (value: typeof updates[number]) => updates.push(value) };
    const pending = client.update(desired);
    try {
      for (let n = 0; n < 40; n++) await Promise.resolve();
      expect(updates.some(value => value.fast?.artUrl === "blob:fast" && !value.slow)).toBe(true);
      expect(updates.every(Object.isFrozen)).toBe(true);
    } finally { slow.resolve({ state: "unavailable" }); await pending; await client.dispose(); }
  });
  it("does not block artwork publication behind a selected strip and keeps at most two resource operations active", async () => {
    const f = fixture(), strip = deferred<unknown>(); let active = 0, peak = 0;
    const updates: Readonly<Record<string, { artUrl?: string }>>[] = [];
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method !== "artwork" && input.method !== "strip") return f.resource(input);
      active++; peak = Math.max(peak, active);
      try { return await (input.method === "strip" ? strip.promise : f.resource(input)); } finally { active--; }
    } }, { create: () => "blob:visible", revoke: () => undefined });
    const desired = { artworkIds: ["a", "b"], stripReplayId: "a", onUpdate: (value: typeof updates[number]) => updates.push(value) };
    const pending = client.update(desired);
    try {
      for (let n = 0; n < 60; n++) await Promise.resolve();
      expect(updates.some(value => value.a?.artUrl)).toBe(true);
      expect(peak).toBeLessThanOrEqual(2);
    } finally { strip.resolve(null); await pending; await client.dispose(); }
  });
  it("retains admitted matching reads but applies a new selected and viewport priority before the remaining queue", async () => {
    const f = fixture(), admitted = deferred<void>(), gate = deferred<unknown>(), order: string[] = []; let created = 0;
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork") {
        order.push(`art:${input.replayId}`);
        if (order.length === 2) admitted.resolve();
        if (input.replayId === "a" || input.replayId === "b") return gate.promise;
      }
      if (input.method === "strip") order.push(`strip:${input.replayId}`);
      return f.resource(input);
    } }, { create: () => `blob:${++created}`, revoke: () => undefined });
    const first = client.update({ artworkIds: ["a", "b", "c", "d"] }); await admitted.promise;
    const latest = client.update({ artworkIds: ["d", "c", "a", "b"], stripReplayId: "d" });
    try {
      gate.resolve({ state: "ready", bytes: 3, mime: "image/png" });
      expect(await first).toEqual({}); await latest;
      expect(order).toEqual(["art:a", "art:b", "strip:d", "art:d", "art:c"]);
    } finally { gate.resolve({ state: "unavailable" }); await latest; await client.dispose(); }
  });
  it("evicts inactive least-recently-used entries at its count bound while retaining a committed snapshot", async () => {
    const f = fixture(), first = await f.client.update({ artworkIds: ["old"] });
    const release = retainLibraryPassiveResourceSnapshot(first);
    try {
      for (let i = 0; i < 257; i++) await f.client.update({ artworkIds: [`id-${i}`] });
      await f.client.update({ artworkIds: [] });
      expect(f.revoked).not.toContain(first.old.artUrl);
      // 256 unique inactive contents plus the deliberately held old render.
      expect(f.calls.filter(c => c.method === "artwork").length - f.revoked.length).toBe(257);
      const recent = await f.client.update({ artworkIds: ["id-256"] });
      expect(recent["id-256"].artUrl).toBe("blob:258");
      const reread = await f.client.update({ artworkIds: ["old"] });
      expect(f.calls.filter(c => c.method === "artwork" && c.replayId === "old")).toHaveLength(2);
      // The alias was evicted, but verified equal bytes may rejoin the live held content.
      expect(reread.old.artUrl).toBe(first.old.artUrl);
      release(); expect(f.revoked).not.toContain(first.old.artUrl);
    } finally { release(); await f.client.dispose(); }
  });
  it("publishes the selected strip while artwork is pending without claiming artwork is unavailable", async () => {
    const f = fixture(), artwork = deferred<unknown>();
    const updates: Readonly<Record<string, { artUrl?: string; artworkPending?: boolean; strip?: LibraryErrorStrip }>>[] = [];
    const client = new LibraryPassiveResourceClient({ resource: async input => input.method === "artwork" ? artwork.promise : input.method === "strip" ? stripReply : f.resource(input) }, { create: () => "blob:selected", revoke: () => undefined });
    const pending = client.update({ artworkIds: ["a"], stripReplayId: "a", onUpdate: value => updates.push(value) });
    try {
      for (let n = 0; n < 40; n++) await Promise.resolve();
      expect(updates[updates.length - 1]).toEqual({ a: { strip: knownStrip, artworkPending: true } });
      artwork.resolve({ state: "unavailable" });
      expect(await pending).toEqual({ a: { strip: knownStrip } });
    } finally { artwork.resolve({ state: "unavailable" }); await pending; await client.dispose(); }
  });
  it("bounds inactive encoded bytes independently of the entry count", async () => {
    const f = contentFixture(id => id, 256 * 1024), { client, live } = f;
    try {
      for (let i = 0; i < 140; i++) await client.update({ artworkIds: [`id-${i}`] });
      await client.update({ artworkIds: [] });
      expect(live.size).toBe(128); expect([...live.values()].reduce((sum, n) => sum + n, 0)).toBe(32 * 1024 * 1024);
      await client.update({ artworkIds: ["id-139"] }); expect(f.reads).toHaveLength(140);
      await client.update({ artworkIds: ["id-0"] }); expect(f.reads).toHaveLength(141);
      expect(live.size).toBeLessThanOrEqual(129); // One active image may sit outside the inactive cap.
    } finally { await client.dispose(); }
    expect(live.size).toBe(0);
  });
  it("far return retains six original URLs after 105 verified replay IDs without another request", async () => {
    const f = contentFixture(id => id, 200000), firstIds = Array.from({ length: 6 }, (_, i) => `first-${i}`);
    try {
      const first = await f.client.update({ artworkIds: firstIds });
      for (let offset = 0; offset < 99; offset += 9) await f.client.update({ artworkIds: Array.from({ length: 9 }, (_, i) => `out-${offset + i}`) });
      const updates: unknown[] = [], pending = f.client.update({ artworkIds: firstIds, onUpdate: value => updates.push(value) });
      expect(updates[0]).toEqual(first);
      expect(await pending).toEqual(first); expect(f.reads).toHaveLength(105);
      expect(f.revoked).toEqual([]);
    } finally { await f.client.dispose(); }
    expect(f.live.size).toBe(0);
  });
  it("shares verified equal content only after the new replay's independent request releases", async () => {
    const f = contentFixture(() => "same"), releaseEntered = deferred<void>(), releaseGate = deferred<void>(); let heldRequest = "";
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork" && input.replayId === "b") heldRequest = input.requestId;
      if (input.method === "release" && input.requestId === heldRequest) { releaseEntered.resolve(); await releaseGate.promise; }
      return f.resource(input);
    } }, f.urls);
    let pending: ReturnType<typeof client.update> | undefined;
    try {
      const first = await client.update({ artworkIds: ["a"] }), updates: Record<string, unknown>[] = [];
      pending = client.update({ artworkIds: ["a", "b"], onUpdate: value => updates.push(value) }); await releaseEntered.promise;
      expect(updates.every(value => value.b === undefined)).toBe(true); expect(f.created()).toBe(1);
      releaseGate.resolve(); const second = await pending;
      expect(second.a.artUrl).toBe(first.a.artUrl); expect(second.b.artUrl).toBe(first.a.artUrl);
      expect(f.reads).toEqual(["a", "b"]); expect(f.created()).toBe(1);
    } finally { releaseGate.resolve(); await pending; await client.dispose(); await f.client.dispose(); }
    expect(f.revoked).toEqual(["blob:1"]);
  });
  it("does not let old-owner cleanup remove new-owner shared content or revoke a committed alias", async () => {
    const f = contentFixture(() => "same"), first = await f.client.update({ artworkIds: ["a", "b"] });
    const releaseOld = retainLibraryPassiveResourceSnapshot(first);
    let releaseNew: () => void = () => undefined;
    try {
      expect(first.a.artUrl).toBe(first.b.artUrl);
      f.client.invalidate();
      const current = await f.client.update({ artworkIds: ["c", "d"] });
      expect(current.c.artUrl).not.toBe(first.a.artUrl); expect(current.d.artUrl).toBe(current.c.artUrl);
      releaseNew = retainLibraryPassiveResourceSnapshot(current);
      releaseOld(); expect(f.revoked).toEqual([first.a.artUrl]);
      const next = await f.client.update({ artworkIds: ["e"] });
      expect(next.e.artUrl).toBe(current.c.artUrl); expect(f.created()).toBe(2);
      await f.client.dispose(); expect(f.revoked).toHaveLength(1);
      releaseNew(); expect(f.revoked).toEqual([first.a.artUrl, current.c.artUrl]);
    } finally { releaseOld(); releaseNew(); await f.client.dispose(); }
  });
  it("replaces changed alias content without revoking an equal sibling or a held old render", async () => {
    let content = "shared";
    const f = contentFixture(id => id === "a" ? content : "shared");
    const first = await f.client.update({ artworkIds: ["a", "b"] }), release = retainLibraryPassiveResourceSnapshot(first);
    try {
      content = "changed"; f.client.invalidate({ preserveArtwork: true });
      const second = await f.client.update({ artworkIds: ["a", "b"] });
      expect(second.a.artUrl).not.toBe(first.a.artUrl); expect(second.b.artUrl).toBe(first.b.artUrl);
      expect(f.created()).toBe(2); expect(f.revoked).toEqual([]);
      await f.client.update({ artworkIds: ["a"] });
      f.client.invalidate({ preserveArtwork: true }); // Retire the inactive older-generation b alias.
      expect(f.revoked).toEqual([]);
      release(); expect(f.revoked).toEqual([first.b.artUrl]);
      expect(f.live.has(second.a.artUrl ?? "")).toBe(true);
    } finally { release(); await f.client.dispose(); }
    expect(f.live.size).toBe(0);
  });
  it("counts shared inactive content bytes once while independently bounding replay aliases", async () => {
    const f = contentFixture(id => id.split(":")[0], 256 * 1024);
    try {
      for (let i = 0; i < 100; i++) await f.client.update({ artworkIds: [`${i}:a`, `${i}:b`] });
      await f.client.update({ artworkIds: [] });
      expect(f.created()).toBe(100); expect(f.live.size).toBe(100);
      expect([...f.live.values()].reduce((sum, n) => sum + n, 0)).toBe(25 * 1024 * 1024);
      const again = await f.client.update({ artworkIds: ["0:a", "0:b"] });
      expect(again["0:a"].artUrl).toBe(again["0:b"].artUrl); expect(f.reads).toHaveLength(200);
    } finally { await f.client.dispose(); }
  });
  it("evicts the oldest of more than 256 aliases even when all aliases share one live URL", async () => {
    const f = contentFixture(() => "same");
    try {
      const first = await f.client.update({ artworkIds: ["old"] });
      for (let i = 0; i < 257; i++) await f.client.update({ artworkIds: [`id-${i}`] });
      await f.client.update({ artworkIds: [] });
      expect(f.created()).toBe(1); expect(f.live.size).toBe(1);
      await f.client.update({ artworkIds: ["id-256"] }); expect(f.reads).toHaveLength(258);
      const reread = await f.client.update({ artworkIds: ["old"] });
      expect(f.reads).toHaveLength(259); expect(reread.old.artUrl).toBe(first.old.artUrl);
      expect(f.created()).toBe(1); expect(f.revoked).toEqual([]);
    } finally { await f.client.dispose(); }
    expect(f.revoked).toEqual(["blob:1"]);
  });
  it("bounds active and inactive unique bytes separately while protecting a committed maximum-size window", async () => {
    const f = contentFixture(id => id, 256 * 1024), ids = Array.from({ length: 32 }, (_, i) => `held-${i}`);
    const first = await f.client.update({ artworkIds: ids }), release = retainLibraryPassiveResourceSnapshot(first);
    const liveBytes = () => [...f.live.values()].reduce((sum, bytes) => sum + bytes, 0);
    try {
      for (let generation = 0; generation < 6; generation++) {
        await f.client.update({ artworkIds: Array.from({ length: 32 }, (_, i) => `${generation}-${i}`) });
        expect(liveBytes()).toBeLessThanOrEqual(48 * 1024 * 1024);
        for (const id of ids) expect(f.live.has(first[id].artUrl ?? "")).toBe(true);
      }
      // 8 MiB active +32 MiB inactive +8 MiB in evicted but committed aliases.
      expect(liveBytes()).toBe(48 * 1024 * 1024); expect(f.live.size).toBe(192);
      await f.client.dispose(); expect(liveBytes()).toBe(8 * 1024 * 1024);
      release(); expect(f.live.size).toBe(0); expect(new Set(f.revoked).size).toBe(224);
    } finally { release(); await f.client.dispose(); }
  });
  it("does not let a cancelled new alias join shared content without a fresh verified request", async () => {
    const f = contentFixture(() => "same"), entered = deferred<void>(), gate = deferred<void>(); let hold = true;
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      const result = await f.resource(input);
      if (input.method === "artwork" && input.replayId === "b" && hold) { entered.resolve(); await gate.promise; }
      return result;
    } }, f.urls);
    const controller = new AbortController();
    try {
      const first = await client.update({ artworkIds: ["a"] });
      const cancelled = client.update({ artworkIds: ["a", "b"] }, controller.signal); await entered.promise;
      controller.abort(); expect(await cancelled).toEqual({});
      hold = false; gate.resolve();
      const next = await client.update({ artworkIds: ["b"] });
      expect(next.b.artUrl).toBe(first.a.artUrl); expect(f.reads).toEqual(["a", "b", "b"]);
      expect(f.created()).toBe(1); expect(f.revoked).toEqual([]);
    } finally { gate.resolve(); await client.dispose(); await f.client.dispose(); }
    expect(f.revoked).toEqual(["blob:1"]);
  });
  it.each([
    ["changed", false], ["unavailable", false], ["error", false],
    ["changed", true], ["unavailable", true], ["error", true],
  ] as const)("enforces inactive bytes after active shared content becomes %s (held render: %s)", async (outcome, heldRender) => {
    const bytes = 256 * 1024, blocked = deferred<unknown>(); let holdB = false, replacing = false;
    const f = contentFixture(id => id === "b" && replacing ? "replacement" : id === "a" || id === "b" ? "shared" : id, bytes);
    const client = new LibraryPassiveResourceClient({ resource: async input => {
      if (input.method === "artwork" && input.replayId === "b") {
        if (holdB) return blocked.promise;
        if (replacing && outcome === "unavailable") return { state: "unavailable" };
        if (replacing && outcome === "error") throw Error("Replacement source unavailable");
      }
      return f.resource(input);
    } }, f.urls);
    const work: Promise<unknown>[] = []; let releaseRender: () => void = () => undefined;
    const liveBytes = () => [...f.live.values()].reduce((sum, value) => sum + value, 0);
    try {
      const first = await client.update({ artworkIds: ["a", "b"] }), original = first.a.artUrl;
      if (heldRender) releaseRender = retainLibraryPassiveResourceSnapshot(first);
      holdB = true; client.invalidate({ preserveArtwork: true });
      let publications = 0; const revalidatedA = deferred<void>();
      work.push(client.update({ artworkIds: ["a", "b"], onUpdate: () => { if (++publications === 2) revalidatedA.resolve(); } }));
      await revalidatedA.promise; // a is current, while active b still owns stale shared content.
      for (let offset = 0; offset < 128; offset += 31) {
        const ids = Array.from({ length: Math.min(31, 128 - offset) }, (_, i) => `inactive-${offset + i}`), ready = deferred<void>();
        work.push(client.update({ artworkIds: [...ids, "b"], onUpdate: value => { if (ids.every(id => value[id]?.artUrl)) ready.resolve(); } }));
        await ready.promise;
      }
      expect(f.live.size).toBe(129); // 128 distinct payloads, plus X shared by a and stale b.
      holdB = false; replacing = true;
      const publishedInactive: number[] = [];
      const last = await client.update({ artworkIds: ["b"], onUpdate: value => {
        if (value.b && value.b.artUrl !== original && !heldRender)
          publishedInactive.push(liveBytes() - (f.live.get(value.b.artUrl ?? "") ?? 0));
      } });
      if (outcome === "changed") expect(last.b.artUrl).toBeDefined();
      else if (outcome === "error") expect(last.b.artworkError).toBeDefined();
      else expect(last.b).toEqual({});
      if (heldRender) expect(f.revoked).not.toContain(original);
      releaseRender();
      // a must be evicted when b stops owning X; a held render delays only revocation.
      const inactiveBytes = liveBytes() - (f.live.get(last.b.artUrl ?? "") ?? 0);
      expect(inactiveBytes).toBe(32 * 1024 * 1024);
      expect(f.revoked).toContain(original);
      if (!heldRender) {
        expect(publishedInactive.length).toBeGreaterThan(0);
        expect(publishedInactive.every(value => value <= 32 * 1024 * 1024)).toBe(true);
      }
    } finally { blocked.resolve({ state: "unavailable" }); releaseRender(); await client.dispose(); await Promise.all(work); await f.client.dispose(); }
    expect(f.live.size).toBe(0);
  });
  it("keeps the previous selected strip and verified artwork during a partial metric refresh", async () => {
    const f = fixture(), strip = deferred<unknown>(); let refreshing = false;
    const client = new LibraryPassiveResourceClient({ resource: async input => input.method === "strip" ? refreshing ? strip.promise : stripReply : f.resource(input) }, { create: () => "blob:selected", revoke: () => undefined });
    try {
      const first = await client.update({ artworkIds: ["a"], stripReplayId: "a" });
      refreshing = true; client.invalidate({ artwork: false, strip: true });
      const updates: unknown[] = [];
      const pending = client.update({ artworkIds: ["a"], stripReplayId: "a", onUpdate: value => updates.push(value) });
      for (let n = 0; n < 20; n++) await Promise.resolve();
      expect(updates[updates.length - 1]).toEqual(first);
      strip.resolve(null);
      expect(await pending).toEqual({ a: { artUrl: "blob:selected" } });
    } finally { strip.resolve(null); await client.dispose(); }
  });
});
