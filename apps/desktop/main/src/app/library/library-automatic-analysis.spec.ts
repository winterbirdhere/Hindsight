import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
import { DatabaseSync } from "node:sqlite";
let directory:string,database:string,store:LibraryStore;
const sha="a".repeat(64),header={mode:0,version:20200101,beatmapMD5:"b".repeat(32),mods:0};
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"hindsight-auto-"));database=join(directory,"library.sqlite");store=new LibraryStore(database,"one");
  store.enableNumericalAdmission();store.registerSource({id:"files",kind:"replays",directory:"C:\\files"});});
afterEach(()=>{store.close();for(const suffix of ["","-wal","-shm"])if(existsSync(database+suffix))unlinkSync(database+suffix);rmdirSync(directory);});
function observe(key="one",metadata:Record<string,unknown>={header}){return store.upsertObservation({sourceId:"files",sourceKey:key,locator:key,
  sha256:sha,available:true,addedAt:1,generation:store.beginScan("files"),metadata});}
it("admits numerical preparation on ingestion and coalesces unchanged duplicates while running",()=>{
  const id=observe(),first=store.preparations.read(id)[0];expect(first).toMatchObject({stage:"S",state:"queued",reason:"background"});
  const running=store.preparations.claim(id,"S")!;observe("two");observe("three",{});observe("one",{header,savedScore:{optionalCause:"irrelevant"},stamp:{mtimeMs:4}});
  expect(store.preparations.read(id)[0]).toMatchObject({generation:first.generation,state:"running"});
  expect(store.preparations.complete(running,[{slot:"numerical",stage:"S",inputKey:"fixture",producerVersion:"fixture"}]).state).toBe("applied");
});
it("keeps failed preparation until explicit retry or a semantic prerequisite repair",()=>{
  const id=observe(),ticket=store.preparations.claim(id,"S")!;store.preparations.fail(ticket,"Missing beatmap");
  observe("two");expect(store.preparations.read(id)[0]).toMatchObject({state:"failed",generation:ticket.generation});
  observe("one",{header:{...header,mods:8}});expect(store.preparations.read(id)[0].state).toBe("queued");
});
it("Off and On demand never admit from observations; explicit bounded maintenance handles Background reentry",()=>{
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});const id=observe();
  expect(store.preparations.read(id)).toEqual([]);store.metrics.read(id);store.listReplayIds();store.getReplay(id);expect(store.preparations.read(id)).toEqual([]);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"demand"});observe("two");expect(store.preparations.read(id)).toEqual([]);
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg"});store.reprojectSourceMetrics("",1);
  expect(store.preparations.read(id)[0].state).toBe("queued");
});
it("backfills existing identities after restart without requiring a rescan",()=>{
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});const id=observe();store.close();store=new LibraryStore(database,"two");store.enableNumericalAdmission();
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"bg"});store.reprojectSourceMetrics("",1);
  expect(store.preparations.read(id)).toEqual([expect.objectContaining({stage:"S",state:"queued"})]);
});
it("notifies only committed queue changes; duplicates, claims, reads and rollback stay silent",()=>{
  const notify=jest.fn();store.onAnalysisDirty(notify);const id=observe();expect(notify).toHaveBeenCalledTimes(1);notify.mockClear();
  observe("two");store.metrics.read(id);store.preparations.read(id);store.preparations.nextQueued();const ticket=store.preparations.claim(id,"S")!;expect(notify).not.toHaveBeenCalled();
  store.preparations.release(ticket);expect(notify).toHaveBeenCalledTimes(1);notify.mockClear();
  const fault=new DatabaseSync(database);try{fault.exec("CREATE TRIGGER reject_prep BEFORE UPDATE ON analysis_requests BEGIN SELECT RAISE(ABORT,'injected prep write'); END;");
    expect(()=>observe("one",{header:{...header,mods:8}})).toThrow("injected prep write");expect(notify).not.toHaveBeenCalled();
  }finally{fault.close();}
});
it("notifies active ownership changes when a provisional identity merges even without automatic admission",()=>{
  store.close();store=new LibraryStore(database,"plain");
  const known=observe("known"),pending=store.upsertObservation({sourceId:"files",sourceKey:"pending",locator:"pending",sha256:null,
    available:false,addedAt:2,generation:store.beginScan("files"),metadata:{header}});
  expect(pending).not.toBe(known);const notify=jest.fn();store.onAnalysisDirty(notify);observe("pending");
  expect(notify.mock.calls.some(([flags])=>(flags&4)!==0)).toBe(true);
});
