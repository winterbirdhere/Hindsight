import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import { DatabaseSync } from "node:sqlite";
import { LibraryStore } from "./library-store";
import { LibraryQueryReader } from "./library-query";
import { LibraryQueryApi } from "./library-query-api";
import { LibraryUserMetadataApi } from "./library-user-metadata-api";

it("persists explicit names and refreshes passive Me queries without changing recorded names or analysis work",()=>{
  const directory=mkdtempSync(join(tmpdir(),"hindsight-my-names-api-")),path=join(directory,"library.sqlite");
  if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw Error("Unexpected fixture directory");
  let store=new LibraryStore(path,"first");let reader:DatabaseSync|undefined;
  try{
    store.registerSource({id:"imports",kind:"imported",directory});
    store.metrics.setAnalysisSettings({mode:"off",workers:1,userPaused:false,pauseOnBattery:false});
    const generation=store.beginScan("imports");
    for(const [index,player] of ["Éclair","lark_old","me","kirin_"].entries())store.upsertObservation({sourceId:"imports",sourceKey:String(index),
      locator:join(directory,`${index}.osr`),sha256:String(index).padStart(64,"0"),generation,addedAt:index,available:true,
      metadata:{header:{mode:0,version:20260901,player,beatmapMD5:"a".repeat(32),counts:{great:1,ok:0,meh:0,miss:0},maxCombo:1,modsBitmask:0}}});
    store.finishScan("imports",generation);
    for(let pages=0;store.queryProjectionPending()||store.incidentIdentityPending();pages++){
      if(pages>100)throw Error("Unbounded names fixture repair");
      if(store.queryProjectionPending())store.maintainQueryProjection();else store.maintainIncidentIdentity();
    }
    reader=new DatabaseSync(path,{readOnly:true});
    const api=new LibraryQueryApi(new LibraryQueryReader(reader,"first")),metadata=new LibraryUserMetadataApi(store);
    const page=()=>api.receive("query-page",{query:{filters:[{field:"player",values:[],me:true}]}}) as {items:{player:string}[];total:number};
    const jobs=()=>reader?.prepare("SELECT count(*) AS n FROM analysis_requests").get()?.n;
    const beforeJobs=jobs();expect(page().total).toBe(0);
    expect(api.receive("query-player-names",{})).toEqual({names:[]});
    expect(metadata.receive("player-names-set",{names:["éclair","LARK_OLD","ÉCLAIR"]})).toEqual({names:["éclair","LARK_OLD"]});
    expect(page().items.map(item=>item.player).sort()).toEqual(["lark_old","Éclair"].sort());
    metadata.receive("player-names-set",{names:["éclair"]});expect(page().total).toBe(1);
    expect(jobs()).toBe(beforeJobs);
    expect(api.receive("query-preview",{query:{filters:[{field:"player",values:["me"]}]}})).toMatchObject({count:1});
    api.close();reader.close();reader=undefined;store.close();
    store=new LibraryStore(path,"second");expect(store.playerNames()).toEqual(["éclair"]);
  }finally{
    reader?.close();store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
