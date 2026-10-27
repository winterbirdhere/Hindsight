import { mkdtempSync,rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";
let directory:string,store:LibraryStore;
const md5="b".repeat(32),key="c".repeat(64),header={mode:0,version:20250101,beatmapMD5:md5,modsBitmask:0,counts:{great:3,ok:0,meh:0,miss:0},maxCombo:3,score:123};
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"hindsight-auto-p-"));store=new LibraryStore(join(directory,"library.sqlite"),"one");
  store.enablePerformanceAdmission();store.registerSource({id:"stable",kind:"stable",directory:"C:/fixture"});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});});
afterEach(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
function observe(score=123){return store.upsertObservation({sourceId:"stable",sourceKey:key,locator:"C:/fixture/absent.osr",sha256:null,available:false,
  addedAt:1,generation:store.beginScan("stable"),metadata:{savedScore:{sourceKey:key,databaseVersion:20250101,header:{...header,score}}}});}
it("admits P for source-only scores while Off, retains running duplicates and reports a changed live dependency",()=>{
  const id=observe(),ticket=store.preparations.claim(id,"P")!,notify=jest.fn();store.onAnalysisDirty(notify);
  expect(ticket.stage).toBe("P");observe();expect(store.preparations.read(id)).toEqual([expect.objectContaining({state:"running",generation:ticket.generation})]);
  expect(notify).not.toHaveBeenCalled();observe(124);
  expect(store.preparations.read(id)).toEqual([expect.objectContaining({stage:"P",state:"queued"})]);expect(store.preparations.isEligible(ticket)).toBe(false);
  expect(notify.mock.calls.some(([flags])=>(flags&4)!==0)).toBe(true);expect(store.metrics.nextQueued()).toEqual([]);
});
it("keeps a missing-map failure until a semantic prerequisite repair and never admits from passive reads",()=>{
  const id=observe(),ticket=store.preparations.claim(id,"P")!;store.preparations.fail(ticket,"Exact map unavailable");
  observe();store.getReplay(id);store.metrics.read(id);store.listReplayIds();expect(store.preparations.read(id)[0].state).toBe("failed");
  const generation=store.beginMapScan("stable");store.upsertMap({sourceId:"stable",generation,sourceKey:"map",md5,locator:"C:/fixture/map.osu",state:"unverified",metadata:{}});
  store.finishMapScan("stable",generation);store.reprojectSourceMetrics();expect(store.preparations.read(id)[0].state).toBe("queued");
});
it("backfills indexed identities after restart while Off without a replay rescan",()=>{
  const id=observe();store.close();store=new LibraryStore(join(directory,"library.sqlite"),"two");store.enablePerformanceAdmission();
  store.reprojectSourceMetrics();expect(store.preparations.read(id)).toEqual([expect.objectContaining({stage:"P",state:"queued"})]);
});
