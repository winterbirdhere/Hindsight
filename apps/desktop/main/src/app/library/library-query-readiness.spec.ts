import { DatabaseSync } from "node:sqlite";
import { libraryQueryReadiness } from "./library-query-readiness";

let db:DatabaseSync;
beforeEach(()=>{
  db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version=24;
    CREATE TABLE query_projection(id TEXT,visible INTEGER,source_mask INTEGER,c_identity TEXT,analysis_algorithm TEXT,analysis_without_c TEXT);
    CREATE TABLE query_projection_dirty(id TEXT,flags INTEGER);
    CREATE TABLE query_projection_scopes(kind TEXT);
    CREATE TABLE sources(id TEXT,enabled INTEGER,configured INTEGER,kind TEXT,config_revision INTEGER);
    CREATE TABLE locations(replay_id TEXT,source_id TEXT,source_key TEXT,sha256 TEXT,available INTEGER);
    CREATE TABLE incident_recipes(replay_id TEXT,source_id TEXT,source_key TEXT,source_config_revision INTEGER,source_epoch INTEGER,location_epoch INTEGER,scope TEXT,evidence TEXT);
    CREATE TABLE incident_source_epochs(source_id TEXT,epoch INTEGER);
    CREATE TABLE incident_location_epochs(source_id TEXT,source_key TEXT,epoch INTEGER);
    CREATE TABLE query_analysis_algorithm_state(id INTEGER,complete INTEGER);
    INSERT INTO query_analysis_algorithm_state VALUES(1,0);`);
});
afterEach(()=>db.close());
it("separates safe live source work from independent algorithm work",()=>{
  expect(libraryQueryReadiness(db)).toBe("settled");
  db.exec("INSERT INTO query_projection_scopes VALUES('source-visibility'),('c-source'); INSERT INTO query_projection_dirty VALUES('a',10)");
  expect(libraryQueryReadiness(db)).toBe("live-source");
});
it.each(["map-source-visibility","map-publication","source-locations","source","future-kind"])("fences mixed %s work",kind=>{
  db.exec("INSERT INTO query_projection_scopes VALUES('source-visibility')");
  db.prepare("INSERT INTO query_projection_scopes VALUES(?)").run(kind);
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it.each([0,1,4,9,16,-2,null])("fences unsafe dirty flags %s",flags=>{
  db.prepare("INSERT INTO query_projection_dirty VALUES('a',?)").run(flags);
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it.each([2,8,10])("allows exactly source/C dirty bits %s",flags=>{
  db.prepare("INSERT INTO query_projection_dirty VALUES('a',?)").run(flags);
  expect(libraryQueryReadiness(db)).toBe("live-source");
});
it("rechecks queues without trusting an unchanged revision",()=>{
  db.exec("INSERT INTO query_projection_scopes VALUES('source-visibility')");
  expect(libraryQueryReadiness(db)).toBe("live-source");
  db.exec("INSERT INTO query_projection_dirty VALUES('unsafe',1)");
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it.each([24,25,26,27])("retains live-overlay support for compatible schema %s",version=>{
  db.exec(`PRAGMA user_version=${version}; INSERT INTO query_projection_scopes VALUES('source-visibility')`);
  expect(libraryQueryReadiness(db)).toBe("live-source");
});
it.each([23,28])("rejects unsupported schema %s for live overlay",version=>{
  db.exec(`PRAGMA user_version=${version}; INSERT INTO query_projection_scopes VALUES('source-visibility')`);
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it("requires actual live-overlay capabilities",()=>{
  db.exec("ALTER TABLE query_projection DROP COLUMN analysis_algorithm; INSERT INTO query_projection_scopes VALUES('source-visibility')");
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it("fences a malformed scope table missing its kind capability",()=>{
  db.exec("ALTER TABLE query_projection_scopes RENAME COLUMN kind TO unknown_kind; INSERT INTO query_projection_scopes VALUES('source-visibility')");
  expect(libraryQueryReadiness(db)).toBe("updating");
});
it("does not coerce fractional dirty flags into an allowed integer mask",()=>{
  db.exec("INSERT INTO query_projection_dirty VALUES('fractional',2.5)");
  expect(libraryQueryReadiness(db)).toBe("updating");
});
