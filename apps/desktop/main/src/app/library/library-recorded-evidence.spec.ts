import { DatabaseSync } from "node:sqlite";
import { libraryKnownNonstandardSql, libraryRecordedCompletionSql, libraryRecordingClientSql } from "./library-recorded-evidence";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE replays(id TEXT,metadata TEXT); CREATE TABLE locations(replay_id TEXT,metadata TEXT);");
});
afterEach(() => db.close());
function classify(metadata: unknown, locations: unknown[] = []) {
  db.prepare("INSERT INTO replays VALUES('r',?)").run(JSON.stringify(metadata));
  for (const value of locations) db.prepare("INSERT INTO locations VALUES('r',?)").run(JSON.stringify(value));
  return db.prepare(`SELECT ${libraryRecordingClientSql("r.id", "r.metadata")} AS client,
    ${libraryKnownNonstandardSql("r.id", "r.metadata")} AS excluded FROM replays r`).get();
}
it.each([
  [{ header: { version: 20260901 } }, "stable"],
  [{ nativeScore: { isLegacyScore: true, mods: [{ acronym: "CL" }] } }, "stable"],
  [{ nativeScore: { isLegacyScore: false, mods: [{ acronym: "CL" }] } }, "lazer"],
  [{ header: { version: 30000000, nativeScoreInfo: false } }, "lazer"],
  [{ header: { version: 30000001, nativeScoreInfo: true } }, "lazer"],
  [{ source: "stable", ruleset: "stable", mods: [] }, "unknown"],
  [{ header: { version: 0 } }, "unknown"],
  [{ header: { version: "20260901" } }, "unknown"],
  [{ nativeScore: { isLegacyScore: "false" } }, "unknown"],
  [{ header: { version: 20260901 }, nativeScore: { isLegacyScore: false } }, "unknown"],
  [{ header: { version: 20260901, nativeScoreInfo: true } }, "unknown"],
  [{ header: { version: 30000001, sourceFormat: "stable" } }, "unknown"],
])("classifies recorded evidence without guessing from source, profile or mods (%j)", (metadata, client) => {
  expect(classify(metadata)?.client).toBe(client);
});
it("does not hide conflicting duplicates behind the preferred summary", () => {
  expect(classify({ nativeScore: { isLegacyScore: false } }, [{ header: { version: 20260901 } }])?.client).toBe("unknown");
});
it("preserves stable provenance after import into lazer", () => {
  expect(classify({ nativeScore: { isLegacyScore: true } }, [{ header: { version: 20260901 } }, {}])?.client).toBe("stable");
});
it.each(["header", "savedScore", "nativeScore"])("excludes known nonstandard %s evidence even in another location", kind => {
  const metadata = kind === "header" ? { header: { mode: 1 } } : kind === "savedScore" ? { savedScore: { header: { mode: 2 } } } : { nativeScore: { ruleset: 3 } };
  expect(classify({ header: { mode: 0 } }, [metadata])?.excluded).toBe(1);
});
it("keeps missing and malformed modes without inventing standard mode", () => {
  expect(classify({ nativeScore: { ruleset: null } }, [{ header: { mode: "1" } }, {}])?.excluded).toBe(0);
});
it("qualifies only explicit recorded outcomes and preserves conflicting evidence as unknown", () => {
  const payload = (value: string, evidence: string) => JSON.stringify({ fields: { completion: { state: "known", value } }, provenance: { completionEvidence: evidence } });
  const query = db.prepare(`SELECT ${libraryRecordedCompletionSql("?1", "?2")} AS completion`);
  expect(query.get(payload("passed", "source-domain-coverage-v1"), null)?.completion).toBeNull();
  expect(query.get(payload("passed", "recorded-outcome-v1"), null)?.completion).toBe("passed");
  expect(query.get(payload("failed", "recorded-outcome-v1"), null)?.completion).toBe("failed");
  expect(query.get(payload("passed", "recorded-outcome-v1"), payload("failed", "recorded-outcome-v1"))?.completion).toBeNull();
});
