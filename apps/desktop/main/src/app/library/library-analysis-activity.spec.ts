import { LibraryStore } from "./library-store";
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let store: LibraryStore;
beforeEach(() => {
  store = new LibraryStore(":memory:", "activity");
  store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
});
afterEach(() => store.close());
const read = () => store.analysisActivity();
function replay(key = "one", metadata = {}) {
  return store.upsertObservation({ sourceId: "source", sourceKey: key, locator: key,
    sha256: key === "one" ? "a".repeat(64) : "b".repeat(64), available: true,
    generation: store.beginScan("source"), addedAt: 1, metadata });
}
function target(id: string) {
  return store.metrics.setTarget({ replayId: id, slot: "numerical", stage: "S", inputKey: "input", producerVersion: "v1" });
}
it("reports real request lifecycle without treating missing metrics or bound preparation as completion", () => {
  const id = replay();
  expect(read()).toMatchObject({ queued: 0, awaitingInputs: 0, failed: 0, deferred: 0 });
  store.preparations.request(id, "P", "background");
  store.preparations.request(id, "S", "background");
  expect(read()).toMatchObject({ queued: 0, awaitingInputs: 2 });
  const prepared = store.preparations.claim(id, "S");
  if (!prepared) throw new Error("Expected queued preparation to be claimed");
  expect(read()).toMatchObject({ awaitingInputs: 1, running: 1 });
  store.preparations.fail(prepared, "Replay data unavailable");
  expect(read()).toMatchObject({ awaitingInputs: 1, running: 0, failed: 1 });
  store.preparations.request(id, "S", "retry");
  const work = target(id);
  store.metrics.request(work, "selection");
  expect(read()).toMatchObject({ queued: 1, awaitingInputs: 2, failed: 0 });
  const job = store.metrics.nextQueued()[0], ticket = store.metrics.claim(job.id);
  if (!ticket) throw new Error("Expected queued metric to be claimed");
  expect(read()).toMatchObject({ queued: 0, running: 1 });
  store.metrics.commit({ ticket, producerVersion: ticket.producerVersion,
    fields: { ur: { state: "unknown", reason: "insufficient-samples" } }, provenance: {} });
  expect(read()).toMatchObject({ queued: 0, running: 0 });
  expect(read()).not.toHaveProperty("completed");
  expect(read()).not.toHaveProperty("total");
});
it("separates dormant sources and demand-mode work and excludes stale targets", () => {
  const id = replay(), work = target(id);
  store.metrics.request(work, "background");
  expect(read()).toMatchObject({ queued: 1, deferred: 0 });
  store.setSourceEnabled("source", false);
  expect(read()).toMatchObject({ queued: 0, deferred: 1 });
  store.setSourceEnabled("source", true);
  store.metrics.setAnalysisSettings({ mode: "demand", workers: 2, userPaused: false, pauseOnBattery: true });
  expect(read()).toMatchObject({ queued: 0, deferred: 1 });
  store.metrics.request(work, "selection");
  expect(read()).toMatchObject({ queued: 1, deferred: 0 });
  store.metrics.setTarget({ ...work, inputKey: "new-input" });
  expect(read()).toMatchObject({ queued: 0, deferred: 0 });
});
it("keeps rollback and Off deletion in step with actual durable work", () => {
  const id = replay(), work = target(id);
  store.metrics.request(work, "selection");
  const db = store["db"];
  db.exec("BEGIN; DELETE FROM metric_jobs;");
  expect(read()).toMatchObject({ queued: 0 });
  db.exec("ROLLBACK;");
  expect(read()).toMatchObject({ queued: 1 });
  store.metrics.setAnalysisSettings({ mode: "off", workers: 1, userPaused: false, pauseOnBattery: true });
  expect(read()).toMatchObject({ queued: 0, deferred: 0 });
});
it("never creates work during repeated status reads", () => {
  replay();
  const before = store["db"].prepare("SELECT total_changes() AS n").get()?.n;
  for (let i = 0; i < 20; i++) expect(read()).toMatchObject({ queued: 0, awaitingInputs: 0 });
  expect(store["db"].prepare("SELECT total_changes() AS n").get()?.n).toBe(before);
});
it("recounts both identities when an observation moves, retaining old deferred work", () => {
  const first = replay(), second = replay("two");
  store.metrics.request(target(first), "selection");
  store.metrics.request(target(second), "selection");
  expect(read()).toMatchObject({ queued: 2, deferred: 0 });
  store["db"].prepare("UPDATE locations SET replay_id=? WHERE replay_id=?").run(second, first);
  expect(read()).toMatchObject({ queued: 1, deferred: 1 });
});
it("excludes merged identities and recorded nonstandard evidence immediately", () => {
  const first = replay(), second = replay("two");
  store.metrics.request(target(first), "selection");
  store.metrics.request(target(second), "selection");
  store["db"].prepare("UPDATE locations SET metadata=? WHERE replay_id=?")
    .run(JSON.stringify({ header: { mode: 3 } }), first);
  expect(read()).toMatchObject({ queued: 1 });
  store["db"].prepare("UPDATE replays SET merged_into=? WHERE id=?").run(first, second);
  expect(read()).toMatchObject({ queued: 0 });
});
it("does not count bound preparation as completed replay analysis", () => {
  const id = replay();
  store.preparations.request(id, "P", "background");
  const ticket = store.preparations.claim(id, "P");
  if (!ticket) throw new Error("Expected queued preparation to be claimed");
  store.preparations.complete(ticket, [{ slot: "calculated-map", stage: "P", inputKey: "p", producerVersion: "v1" }]);
  expect(read()).toMatchObject({ awaitingInputs: 0, running: 0, queued: 1 });
  expect(read()).not.toHaveProperty("completed");
});
it("reconstructs counters after recovery without persisting a new schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "hindsight-activity-")), path = join(directory, "library.sqlite");
  store.close();
  try {
    store = new LibraryStore(path, "before");
    store.registerSource({ id: "source", kind: "replays", directory: "C:\\fixture" });
    const id = replay(), work = target(id);
    store.metrics.request(work, "selection");
    store.metrics.claim(store.metrics.nextQueued()[0].id);
    expect(read()).toMatchObject({ running: 1, queued: 0 });
    store.close();
    store = new LibraryStore(path, "after");
    expect(read()).toMatchObject({ running: 0, queued: 1 });
    expect(store["db"].prepare("PRAGMA user_version").get()?.user_version).toBe(27);
    expect(store["db"].prepare("SELECT name FROM main.sqlite_master WHERE name LIKE 'analysis_activity_%'").all()).toEqual([]);
  } finally {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(path + suffix)) unlinkSync(path + suffix);
    rmdirSync(directory);
  }
});
it("uses replay indexes for both branches of source-scoped refreshes", () => {
  const plans = store["db"].prepare(`EXPLAIN QUERY PLAN SELECT * FROM analysis_activity_intents
    WHERE replay_id IN (SELECT replay_id FROM locations WHERE source_id=?)`).all("source").map(row => String(row.detail));
  expect(plans).toEqual(expect.arrayContaining([expect.stringMatching(/SEARCH a .*\(replay_id=\?/)]));
  expect(plans).toEqual(expect.arrayContaining([expect.stringMatching(/SEARCH j .*\(replay_id=\?/)]));
  expect(plans.some(plan => /SCAN (a|j|r|l|t)\b/.test(plan))).toBe(false);
});

it("counts cached strip-only work honestly across held policy, running and failed states",()=>{
  const id=replay(),current=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:"dense",producerVersion:"library-numeric-v6"});
  store.metrics.publishObserved(current,{fields:{ur:{state:"known",value:20}},provenance:{replaySha256:"a".repeat(64),projectionVersion:"library-numeric-v6",
    ruleset:"stable",scoreOrigin:"reconstructed",coverageQualified:true,completionEvidence:"source-domain-coverage-v1"},errorStrip:{state:"unknown",reason:"strip-size-limit"}});
  expect(store.metrics.admitStripRepairInTransaction(id)).toBe(true);expect(read()).toMatchObject({queued:1,deferred:0});
  for(const mode of ["demand","off"] as const){store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode});expect(read()).toMatchObject({queued:0,deferred:1});}
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg"});
  const job=store.metrics.nextQueued()[0],ticket=store.metrics.claim(job.id);if(!ticket)throw Error("Missing strip claim");
  expect(read()).toMatchObject({queued:0,running:1});store.metrics.fail(ticket,"Bounded repair failed");
  expect(read()).toMatchObject({running:0,failed:1});expect(store.metrics.read(id)[0].result).toBeDefined();
});
