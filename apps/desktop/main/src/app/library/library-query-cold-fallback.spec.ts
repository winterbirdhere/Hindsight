import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LibraryStore } from "./library-store";
import { LibraryQueryReader } from "./library-query";
import { LibraryQuerySnapshots } from "./library-query-snapshots";
import { numericalProfileKey } from "./library-numerical-profile";
import { projectLibraryIncidentEvidence } from "./library-incidents-evidence";
import { libraryIncidentTarget, LIBRARY_INCIDENT_QUERY_REVISION } from "./library-incidents-target";
import { LIBRARY_INCIDENT_DEPENDENCIES } from "../../../../shared/library-incidents";
import { LIBRARY_NUMERIC_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import type { LibraryQuery, LibraryQueryItem } from "../../../../shared/library-query";

type State="queued"|"running"|"failed";
type Spec={name:string;s?:boolean;unknown?:boolean;job?:State;prep?:State;prepStage?:"S"|"C";c?:boolean;old?:boolean;cJob?:State;badGeneration?:boolean;stored?:boolean;unsupported?:boolean};
let store:LibraryStore,db:DatabaseSync,rows:(Spec&{id:string})[],root:string;
const oldModel="85e69df3583ef1acca3cc83433173b51bb5f3b18fce21384f960071210852b12";
function drain(){let calls=0;while(store.queryProjectionPending()){expect(++calls).toBeLessThan(100);expect(store.maintainQueryProjection().updated).toBeLessThanOrEqual(8);}}
function cold(){db.exec("UPDATE query_projection SET c_identity=NULL,analysis_without_c=NULL,analysis_error_without_c=NULL");}
function fixtureRow(name:string){const row=rows.find(row=>row.name===name);if(!row)throw Error("Missing fixture row: "+name);return row;}
function snapshot(){return {changes:db.prepare("SELECT total_changes() n").get()?.n,tables:Object.fromEntries(
  ["metric_targets","metric_results","metric_jobs","analysis_requests"].map(table=>[table,db.prepare(`SELECT * FROM ${table}${table==="analysis_requests"?" WHERE stage<>'C'":table==="metric_jobs"?" WHERE stage<>'C' AND slot<>'incidents'":""} ORDER BY rowid`).all()]))};}
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"cold-query-"));store=new LibraryStore(join(root,"library.sqlite"),"test");db=store["db"];rows=[];
  store.reconcileSources([{id:"replays",kind:"replays",directory:"fixture/replays"},{id:"imports",kind:"imported",directory:"fixture/imports"}]);
  store.metrics.setAnalysisSettings({mode:"demand",workers:2,userPaused:false,pauseOnBattery:true});
  const generations={replays:store.beginScan("replays"),imports:store.beginScan("imports")};
  const specs:Spec[]=[{name:"none"},{name:"S-known",s:true},{name:"S-unknown-payload",s:true,unknown:true},
    {name:"S-queued",job:"queued"},{name:"S-running",job:"running"},{name:"S-failed",job:"failed",prep:"failed"},
    {name:"S-active-and-failed",job:"running",prep:"failed"},{name:"C-prep-queued",prep:"queued"},
    {name:"C-prep-running",prep:"running"},{name:"C-prep-failed",prep:"failed"},{name:"S-prep-failed",prep:"failed",prepStage:"S"},
    {name:"current-C",c:true},{name:"old-C",c:true,old:true},{name:"current-C-failed-S",c:true,cJob:"failed",s:true},
    {name:"current-C-failed",c:true,cJob:"failed"},{name:"stale-S-generation",job:"failed",badGeneration:true}];
  for(const [index,spec] of specs.entries()){
    const sha=(index+1).toString(16).padStart(64,"0"),sourceKey=String(index);let id="";
    for(const sourceId of ["replays","imports"] as const)id=store.upsertObservation({sourceId,sourceKey,locator:`fixture/${sourceId}/${sourceKey}.osr`,sha256:sha,available:true,addedAt:index,generation:generations[sourceId],
      metadata:{header:{mode:0,version:20260901,beatmapMD5:"b".repeat(32),modsBitmask:0,player:spec.name,counts:{great:100,ok:0,meh:0,miss:0},score:1000,maxCombo:100}}});
    const recipe={version:1 as const,replaySha256:sha,fixedKey:"d".repeat(64),intrinsicNative:false,embeddedModsHash:null,legacyModsHash:"e".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask" as const};
    const profile=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});if(profile.state!=="known")throw Error("Expected known profile");
    const numerical=store.metrics.setTarget({replayId:id,slot:"numerical",stage:"S",inputKey:profile.inputKey,producerVersion:LIBRARY_NUMERIC_PROJECTION_VERSION});
    expect(store["numericalRecipes"].bindInTransaction(id,numerical,recipe)).toBe(true);
    if(spec.s)store.metrics.publishObserved(numerical,{fields:{ur:spec.unknown?{state:"unknown",reason:"unavailable"}:{state:"known",value:80}},provenance:{replaySha256:sha}});
    rows.push({...spec,id});
    if(spec.c){
      const evidence=projectLibraryIncidentEvidence(undefined,{replaySha256:sha,mapMd5:"b".repeat(32)});store.incidents.bindInTransaction(id,numerical,evidence);
      const location=store.openLocationCandidates(id).items.find(row=>row.sourceId==="replays");if(!location)throw Error("Missing source receipt");
      expect(store.incidents.attestInTransaction(id,evidence,{...location,...store.incidents.epochs(location.sourceId,location.sourceKey),scope:"stable-sidecar"})).toBe(true);
      const target=store.metrics.setTarget(libraryIncidentTarget(numerical,evidence,{...LIBRARY_INCIDENT_DEPENDENCIES,model:spec.old?oldModel:LIBRARY_INCIDENT_DEPENDENCIES.model}));
      store.metrics.publishObserved(target,{fields:{incidentCount:{state:"known",value:1}},provenance:{replaySha256:sha}});
    }
    for(const [slot,state,error] of [["numerical",spec.job,"S failure"],["incidents",spec.cJob,"C failure"]] as const)if(state)
      db.prepare(`INSERT INTO metric_jobs(id,replay_id,slot,stage,input_key,producer_version,generation,reason,state,attempt,error)
        SELECT ?,replay_id,slot,stage,input_key,producer_version,generation+?,'selection',?,NULL,? FROM metric_targets WHERE replay_id=? AND slot=?`)
        .run(id+slot,spec.badGeneration?1:0,state,state==="failed"?error:null,id,slot);
    if(spec.prep){db.prepare("INSERT INTO analysis_requests(replay_id,stage,dependency_key,generation,reason,state) VALUES(?,?,'historical',1,'selection','queued')").run(id,spec.prepStage??"C");
      db.prepare("UPDATE analysis_requests SET state=?,error=? WHERE replay_id=?").run(spec.prep,spec.prep==="failed"?"A preparation failure":null,id);}
  }
  drain();
});
afterEach(()=>{store.close();expect(dirname(resolve(root))).toBe(resolve(tmpdir()));expect(basename(root).startsWith("cold-query-")).toBe(true);rmSync(root,{recursive:true,force:true});});

function expected({initial=false,stale=false,paused=false,partly=false,epochOnly=false,staleOne=""}={}){
  return rows.map(row=>{
    void initial;void stale;void partly;void epochOnly;void staleOne;
    const states=[row.job&&!row.badGeneration?row.job:null,row.prepStage==="S"?row.prep:null];
    let state:LibraryQueryItem["analysis"]=states.includes("running")?"analysing":states.includes("queued")?"queued":states.includes("failed")?"failed":row.s?"analysed":"none";
    if(paused&&(state==="queued"||state==="analysing"))state="paused";
    const errors=[row.job==="failed"&&!row.badGeneration?"S failure":null,row.prepStage==="S"&&row.prep==="failed"?"A preparation failure":null].filter((e):e is string=>e!==null).sort();
    return{id:row.id,state,error:errors[0]??null,incidents:null};
  });
}
const facetState=(state:string)=>["queued","analysing","paused"].includes(state)?"active":state;
function checkTruth(options:Parameters<typeof expected>[0]&{missingSourceOne?:string}={}){
  const before=snapshot(),reader=store.createQueryReader(),want=expected(options),page=reader.page({limit:64});
  const actual=page.items.map(row=>({id:row.id,state:row.analysis,error:row.analysisError,incidents:row.values.incidents}));
  expect(actual.sort((a,b)=>a.id.localeCompare(b.id))).toEqual([...want].sort((a,b)=>a.id.localeCompare(b.id)));
  const facets=[...new Set(want.map(row=>facetState(row.state)))].sort().map(value=>({value,count:want.filter(row=>facetState(row.state)===value).length}));
  expect(reader.facets({},"astate").items).toEqual(facets);
  const first=reader.facets({},"astate",{limit:1});expect(first.items).toEqual(facets.slice(0,1));
  if(first.next)expect(reader.facets({},"astate",{after:first.next}).items).toEqual(facets.slice(1));
  expect(reader.facets({},"astate",{search:"a"}).items).toEqual(facets.filter(row=>row.value.includes("a")));
  for(const value of ["none","analysed","active","failed"]){
    const filter={field:"astate" as const,values:[value]},query:LibraryQuery={filters:[filter],limit:64};
    const ids=want.filter(row=>facetState(row.state)===value).map(row=>row.id).sort();
    const filtered=reader.page(query);expect(filtered.total).toBe(ids.length);expect(filtered.items.map(row=>row.id).sort()).toEqual(ids);
    for(const row of filtered.items){const e=want.find(e=>e.id===row.id);expect(row.analysisError).toBe(e?.error);expect(row.values.incidents).toBe(e?.incidents);}
    expect(reader.preview({},filter)).toEqual({count:ids.length,analysisExcluded:0});
    expect(reader.facets(query,"player").items.reduce((n,row)=>n+row.count,0)).toBe(ids.length);
    expect(reader.facets(query,"source").items.every(row=>row.count===ids.length-(row.value==="replays"&&options.missingSourceOne&&ids.includes(options.missingSourceOne)?1:0))).toBe(true);
    expect(reader.facets(query,"collection").items).toEqual([{value:"fav",label:"Favourites",parentId:null,parentLabel:null,count:0}]);
    expect(reader.facets(query,"astate").items).toEqual(facets); // self-exclusion
    expect(reader.bands(query).items.reduce((n,row)=>n+row.count,0)).toBe(ids.length);
    expect(reader.captureOrder(query,64).ids.sort()).toEqual(ids);
    expect(reader.sameMap(rows[0].id,query).items.map(row=>row.id).sort()).toEqual(ids);
    if(ids.length)expect(reader.reveal(query,ids[0]).state).toBe("found");
  }
  expect(snapshot()).toEqual(before);
}

it("keeps retired C inert while preserving independent S state/error truth through current, cold, partial, paused, stale, alternate-source and Off phases",()=>{
  checkTruth();cold();checkTruth({initial:true});
  const keep=fixtureRow("current-C");keep.stored=true;
  db.prepare("UPDATE query_projection SET c_identity=? WHERE id=?").run(LIBRARY_INCIDENT_QUERY_REVISION,keep.id);
  db.prepare("UPDATE query_projection SET analysis_without_c='analysed',analysis_error_without_c=NULL WHERE id=?").run(fixtureRow("S-known").id);
  checkTruth({partly:true});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:true});drain();cold();checkTruth({initial:true,paused:true});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:false});drain();store.dirtyIncidentEvidence("replays",{kind:"source"});drain();checkTruth({stale:true});
  store.setSourceEnabled("replays",false);drain();checkTruth({stale:true});
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});drain();
  for(const row of rows){if(row.job==="queued"||row.job==="running")row.job=undefined;if(row.prep==="queued"||row.prep==="running")row.prep=undefined;}
  cold();checkTruth({initial:true,stale:true});
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"restart");db=store["db"];drain();checkTruth({initial:true,stale:true});
});

it.each(["stage","input_key","producer_version"])("rejects cached numerical results whose current target %s differs",column=>{
  const row=fixtureRow("S-known");
  db.prepare(`UPDATE metric_targets SET ${column}=? WHERE replay_id=? AND slot='numerical'`).run(column==="stage"?"P":"different",row.id);
  row.s=false;drain();cold();checkTruth({initial:true});
});

it("recomputes old-algorithm nonNULL status across every surface while ignoring retired C while Off, partially repaired and restarted",()=>{
  store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),mode:"off"});drain();
  for(const row of rows){if(row.job==="queued"||row.job==="running")row.job=undefined;if(row.prep==="queued"||row.prep==="running")row.prep=undefined;}
  const persisted=snapshot().tables;
  db.exec(`UPDATE query_projection SET analysis_algorithm='previous-query-algorithm',analysis='none',analysis_error='obsolete cached error',
    analysis_without_c='none',analysis_error_without_c='obsolete cached fallback';
    UPDATE query_analysis_algorithm_state SET revision='previous-query-algorithm',after_id='zzzz',complete=1,verified=16;`);
  db.exec("DROP INDEX IF EXISTS query_projection_analysis_cover");
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"algorithm-upgrade");db=store["db"];
  expect(db.prepare("PRAGMA index_info(query_projection_analysis_cover)").all().map(row=>row.name)).toEqual(["visible","id","c_identity","analysis_algorithm","analysis","analysis_without_c"]);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(27);
  drain();expect(store.queryProjectionPending()).toBe(0);expect(store.incidentIdentityPending()).toBe(true);
  checkTruth();
  // Current and historical C-only results and jobs stay inert during repair.
  const reader=store.createQueryReader();
  expect(reader.detail(fixtureRow("current-C").id)?.item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null}});
  expect(reader.detail(fixtureRow("current-C-failed").id)?.item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null}});
  expect(reader.detail(fixtureRow("old-C").id)?.item).toMatchObject({analysis:"none",analysisError:null,values:{incidents:null}});
  const first=store.maintainIncidentIdentity();expect(first.updated).toBeGreaterThan(0);expect(first.updated).toBeLessThanOrEqual(8);checkTruth();
  store.close();store=new LibraryStore(join(root,"library.sqlite"),"algorithm-partial-restart");db=store["db"];drain();checkTruth();
  let passes=0;while(store.incidentIdentityPending()){expect(++passes).toBeLessThan(30);expect(store.maintainIncidentIdentity().updated).toBeLessThanOrEqual(8);}
  checkTruth();expect(snapshot().tables).toEqual(persisted);
});

function obsoleteAlgorithm(id:string){
  db.prepare("UPDATE query_projection SET analysis_algorithm='previous-query-algorithm',analysis='failed',analysis_error='obsolete cached error',analysis_without_c='failed',analysis_error_without_c='obsolete cached fallback' WHERE id=?").run(id);
  db.exec("UPDATE query_analysis_algorithm_state SET complete=0,after_id='',verified=0");
}
function checkSelectedStatus(id:string,state:string,error:string|null){
  const before=snapshot(),reader=store.createQueryReader(),row=rows.find(row=>row.id===id);if(!row)throw Error("Missing replay");
  expect(reader.detail(id)?.item).toMatchObject({analysis:state,analysisError:error});
  const scope={filters:[{field:"player" as const,values:[row.name]}]},filter={field:"astate" as const,values:[facetState(state)]};
  expect(reader.page({filters:[...scope.filters,filter]})).toMatchObject({total:1,items:[{id,analysis:state,analysisError:error}]});
  expect(reader.preview(scope,filter).count).toBe(1);
  expect(reader.facets(scope,"astate").items).toEqual([{value:facetState(state),count:1}]);expect(snapshot()).toEqual(before);
}
it("requires a fresh C receipt during algorithm fallback even when a semantic stamp is present",()=>{
  const row=fixtureRow("current-C-failed");store.dirtyIncidentEvidence("replays",{kind:"source"});drain();
  // Deliberately retain the semantic stamp to isolate the independent receipt
  // gate. This fixture must not treat that stamp as proof of source freshness.
  db.prepare("UPDATE query_projection SET c_identity=? WHERE id=?").run(LIBRARY_INCIDENT_QUERY_REVISION,row.id);
  obsoleteAlgorithm(row.id);checkSelectedStatus(row.id,"none",null);
});
it.each(["stage","input_key","producer_version","generation"])("ignores a C job with obsolete %s without reviving a C-only analysis state",column=>{
  const row=fixtureRow("current-C-failed");
  if(column==="generation")db.prepare("UPDATE metric_jobs SET generation=generation+1 WHERE replay_id=? AND slot='incidents'").run(row.id);
  else db.prepare(`UPDATE metric_jobs SET ${column}=? WHERE replay_id=? AND slot='incidents'`).run(column==="stage"?"S":"obsolete",row.id);
  drain();obsoleteAlgorithm(row.id);checkSelectedStatus(row.id,"none",null);
});

function observePlans(run:(reader:LibraryQueryReader)=>unknown){
  const statements:string[]=[],plans:string[][]=[],correlatedMetrics:string[]=[];
  const reader=new LibraryQueryReader({prepare(sql:string){
    if(sql.startsWith("WITH ")){statements.push(sql);const statement=db.prepare(sql),plan=db.prepare("EXPLAIN QUERY PLAN "+sql);
      return new Proxy(statement,{get(target,key){const value=target[key as keyof typeof target];if(typeof value!=="function")return value;
        return (...args:Parameters<typeof statement.all>)=>{if(key==="all"||key==="get"){
          const nodes=plan.all(...args);plans.push(nodes.map(row=>String(row.detail)));
          for(const node of nodes.filter(row=>/metric_|analysis_requests/.test(String(row.detail)))){
            let ancestor=nodes.find(row=>row.id===node.parent);
            while(ancestor){if(String(ancestor.detail).includes("CORRELATED"))correlatedMetrics.push(String(node.detail));ancestor=nodes.find(row=>row.id===ancestor?.parent);}
          }
        }return value.apply(target,args);};}});
    }
    return db.prepare(sql);
  }},"test");
  run(reader);return{statements,plans,correlatedMetrics};
}
it("avoids per-replay correlated fallback and broad result scans on every whole-analysis query surface",()=>{
  cold();const filter={field:"astate" as const,values:["analysed"]},query={filters:[filter]};
  const calls:((r:LibraryQueryReader)=>unknown)[]=[r=>r.facets({},"astate"),r=>r.preview({},filter),r=>r.page(query),r=>r.facets(query,"player"),
    r=>r.facets(query,"source"),r=>r.facets(query,"collection"),r=>r.bands(query),r=>r.captureOrder(query,64),r=>r.reveal(query,rows[1].id)];
  for(const call of calls){const {plans,correlatedMetrics}=observePlans(call);expect(plans.length).toBeGreaterThan(0);
    expect(correlatedMetrics).toEqual([]); // Collection membership may remain correlated; metric fallback must not.
    for(const plan of plans)expect(plan.filter(row=>/^SCAN r\b/.test(row))).toEqual([]);}
});
it("keeps ordinary row evidence lazy while sharing narrow page and analysis facet materializations",()=>{
  cold();const before=snapshot();
  const ordinary=observePlans(reader=>{reader.page({limit:1});reader.facets({},"player");reader.facets({},"source");reader.detail(rows[0].id);reader.bands({});reader.captureOrder({},64);});
  // Page counts share only IDs, sort keys and predicate flags; full row evidence
  // is hydrated by exact ID after LIMIT. The source facet also materializes counts.
  expect(ordinary.plans.flat().filter(row=>/MATERIALIZE/.test(row)&&!["MATERIALIZE counts","MATERIALIZE matched","MATERIALIZE picked"].includes(row))).toEqual([]);
  const page=ordinary.statements.find(sql=>sql.includes("matched AS MATERIALIZED"))??"";
  const matched=page.slice(page.indexOf("matched AS MATERIALIZED"),page.indexOf("), totals AS"));
  expect(matched).not.toContain("analysis_error");expect(matched).not.toContain("source_kinds");expect(matched).not.toContain("collection_ids");
  expect(page).toContain("projected AS NOT MATERIALIZED");expect(page).toContain("LEFT JOIN projected q ON q.id=picked.id");
  expect(page).toContain("id ASC LIMIT ?");
  expect(ordinary.plans.flat().some(row=>/SEARCH p .*id=\?/.test(row)&&row.includes("LEFT-JOIN"))).toBe(true);
  let steps=0;while(store.incidentIdentityPending()){expect(++steps).toBeLessThan(30);expect(store.maintainIncidentIdentity().updated).toBeLessThanOrEqual(8);}
  const settledBefore=snapshot(),settled=observePlans(reader=>{reader.facets({},"astate");reader.page({filters:[{field:"astate",values:["analysed"]}]});});
  expect(settled.plans.flat().filter(row=>/MATERIALIZE/.test(row)&&!["MATERIALIZE facet","MATERIALIZE facet_buckets","MATERIALIZE matched","MATERIALIZE picked"].includes(row))).toEqual([]);
  expect(settled.plans.flat()).toContain("MATERIALIZE facet");
  expect(settled.plans.flat()).toContain("MATERIALIZE facet_buckets");
  expect(settled.plans.flat()).toContain("SEARCH p USING COVERING INDEX query_projection_analysis_filter_cover (visible=? AND standard_excluded=?)");
  const scalarFacet="facet AS MATERIALIZED (SELECT analysis AS value FROM projected q WHERE ";
  expect(settled.statements.filter(sql=>sql.includes("facet AS MATERIALIZED")).map(sql=>sql.includes(scalarFacet))).toEqual([true]);
  const facet=settled.statements.find(sql=>sql.includes(scalarFacet))??"";
  expect(facet.match(/THEN p\.analysis_without_c END/g)).toHaveLength(1);
  expect(facet).not.toContain("p.c_identity");expect(facet).not.toMatch(/THEN p\.analysis\s/);
  expect(facet).toContain("facet_buckets AS MATERIALIZED (SELECT value,count(*) AS n FROM facet GROUP BY value)");
  expect(facet).toContain("SELECT value,sum(n) AS count FROM facet_values");
  expect(settled.statements.some(sql=>sql.includes("cold_candidates AS MATERIALIZED"))).toBe(false);
  expect(snapshot()).toEqual(settledBefore);expect(before.tables).toEqual(settledBefore.tables);
});

it("reads live source affiliation and excludes a disabled C receipt while an alternate source stays visible",()=>{
  store.setSourceEnabled("replays",false);
  expect(store.queryProjectionPending()).toBeGreaterThan(0);
  checkTruth({stale:true});
  const reader=store.createQueryReader(),before=snapshot();
  expect(reader.facets({},"source").items).toEqual([{value:"imported",count:16}]);
  expect(reader.page({filters:[{field:"source",values:["replays"]}]}).total).toBe(0);
  expect(reader.page().items.every(row=>row.sourceKinds.join()==="imported")).toBe(true);
  expect(reader.detail(fixtureRow("current-C").id)?.metrics.some(row=>row.slot==="incidents")).toBe(false);
  expect(snapshot()).toEqual(before);
  const changes=jest.fn();store.onLibraryChanged(changes);drain();
  expect(changes).toHaveBeenCalled(); // The retained source/scalar maintenance lane publishes changes.
  checkTruth({stale:true});
  expect(store.createQueryReader().detail(fixtureRow("current-C").id)?.metrics.some(row=>row.slot==="incidents")).toBe(false);
});

it("includes cached-hidden reenabled rows in cold aggregates, favourites and overlapping collections",()=>{
  const favourite=fixtureRow("S-known");store.setFavourite(favourite.id,true);
  const parent=store.createCollection("parent"),child=store.createCollection("child",parent);
  store.setMembership(favourite.id,parent,true);store.setMembership(favourite.id,child,true);drain();
  store.setSourceEnabled("replays",false);store.setSourceEnabled("imports",false);drain();
  expect(store.createQueryReader().page().total).toBe(0);
  db.exec("UPDATE query_projection SET analysis_algorithm='old',analysis_without_c='failed',analysis='failed'; UPDATE query_analysis_algorithm_state SET complete=0");
  store.setSourceEnabled("imports",true);expect(store.queryProjectionPending()).toBeGreaterThan(0);
  expect(db.prepare("SELECT count(*) n FROM query_projection WHERE visible=0").get()?.n).toBeGreaterThan(0);
  const reader=store.createQueryReader(),before=snapshot();
  const analysed={filters:[{field:"astate" as const,values:["analysed"]}]};
  expect(reader.page(analysed).items.map(row=>row.id).sort()).toEqual(rows.filter(row=>row.s&&!row.job).map(row=>row.id).sort());
  expect(reader.page({scope:{kind:"favourites"}}).items.map(row=>row.id)).toEqual([favourite.id]);
  expect(reader.facets({},"collection").items.find(row=>row.value==="fav")?.count).toBe(1);
  expect(reader.facets({},"collection").items.find(row=>row.value===parent)?.count).toBe(1);
  expect(reader.page({scope:{kind:"collection",id:parent}}).total).toBe(1);
  expect(reader.reveal({},favourite.id).state).toBe("found");
  expect(reader.captureOrder({},64).ids).toHaveLength(16);
  expect(reader.sameMap(favourite.id).total).toBe(16);
  expect(reader.collectionsPage().items.find(row=>row.id===parent)?.count).toBe(1);
  const snapshots=new LibraryQuerySnapshots(reader),captured=snapshots.create({},favourite.id);
  expect(captured.total).toBe(16);
  expect(snapshot()).toEqual(before);
  const cursor=reader.page({limit:1}).next;store.setSourceEnabled("imports",false);
  expect(()=>reader.page({limit:1,cursor})).toThrow(/changed/i);
  expect(snapshots.neighbors(captured.snapshotId,{position:captured.position}).total).toBe(16);
});

it("fences unsafe work injected after a live-source request starts even without a revision update",()=>{
  store.setSourceEnabled("replays",false);let injected=false;
  const reader=new LibraryQueryReader({prepare(sql:string){
    if(!injected&&sql.startsWith("WITH ")){injected=true;db.prepare("INSERT INTO query_projection_dirty(id,flags) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET flags=1").run(rows[0].id);}
    return db.prepare(sql);
  }},"test",Date.now,{revision:()=>"unchanged"});
  expect(()=>reader.page()).toThrow(/updating/i);expect(injected).toBe(true);
});

it("reuses the independent 17-phase receipt/source oracle against production SQL",()=>{
  const unsupported=fixtureRow("current-C");unsupported.unsupported=true;
  db.prepare("UPDATE incident_recipes SET scope='unsupported-profile' WHERE replay_id=?").run(unsupported.id);drain();
  const phases:string[]=[],phase=(name:string,options:Parameters<typeof checkTruth>[0]={})=>{checkTruth(options);phases.push(name);};
  const reattest=()=>{for(const row of rows.filter(row=>row.c)){
    const receipt=db.prepare("SELECT evidence FROM incident_recipes WHERE replay_id=?").get(row.id);
    const location=store.openLocationCandidates(row.id).items.find(item=>item.sourceId==="replays");
    if(!receipt||!location)throw Error("Missing oracle receipt");
    expect(store.incidents.attestInTransaction(row.id,JSON.parse(String(receipt.evidence)),{...location,...store.incidents.epochs(location.sourceId,location.sourceKey),scope:row.unsupported?"unsupported-profile":"stable-sidecar"})).toBe(true);
  }drain();};
  cold();phase("cold",{initial:true});
  while(store.incidentIdentityPending())expect(store.maintainIncidentIdentity().updated).toBeLessThanOrEqual(8);
  // The original fixture has already completed identity; explicitly qualify the
  // cold stamp fixture through C work before evaluating current C evidence.
  db.exec("INSERT INTO query_projection_dirty(id,flags) SELECT id,2 FROM query_projection");drain();phase("qualified");
  store.incidents.dirtyInTransaction("replays");phase("source-epoch-pending",{stale:true,epochOnly:true});drain();phase("source-epoch-settled",{stale:true,epochOnly:true});
  reattest();phase("source-reattested");
  const single=fixtureRow("current-C-failed"),key=String(db.prepare("SELECT source_key FROM incident_recipes WHERE replay_id=?").get(single.id)?.source_key);
  store.incidents.dirtyInTransaction("replays",key);phase("location-epoch-pending",{staleOne:single.id});drain();phase("location-epoch-settled",{staleOne:single.id});reattest();
  store.setSourceEnabled("replays",false);phase("disabled-pending",{stale:true});drain();phase("disabled-settled",{stale:true});
  store.setSourceEnabled("replays",true);phase("reenabled-old-receipt-pending",{stale:true});drain();phase("reenabled-old-receipt-settled",{stale:true});
  reattest();phase("reenabled-reattested");
  db.exec("UPDATE sources SET config_revision=config_revision+1 WHERE id='replays'");phase("configuration-pending",{stale:true});drain();phase("configuration-settled",{stale:true});
  reattest();phase("configuration-reattested");
  db.prepare("DELETE FROM locations WHERE source_id='replays' AND source_key=?").run(key);
  expect(()=>store.createQueryReader().page()).toThrow(/updating/i);drain();phase("missing-receipt-location",{staleOne:single.id,missingSourceOne:single.id});
  db.exec("INSERT INTO query_projection_scopes(kind,scope_id) VALUES('c-source','replays'),('map-visibility','unsafe')");
  expect(()=>store.createQueryReader().page()).toThrow(/updating/i);phases.push("mixed-map-refused");expect(phases).toHaveLength(17);
});

it("uses indexed live affiliation probes and keyed cold candidates across changed whole-query families",()=>{
  store.setSourceEnabled("replays",false);cold();
  const query={filters:[{field:"astate" as const,values:["analysed"]},{field:"source" as const,values:["imported"]}]};
  const result=observePlans(reader=>{reader.page(query);reader.facets(query,"source");reader.facets(query,"collection");reader.reveal(query,fixtureRow("S-known").id);reader.captureOrder(query,64);});
  expect(result.correlatedMetrics).toEqual([]);
  expect(result.plans.flat().filter(row=>/^SCAN (r|live_location)\b/.test(row))).toEqual([]);
  expect(result.statements.some(sql=>sql.includes("cold_candidates AS MATERIALIZED")&&sql.includes("live_location.replay_id=p.id"))).toBe(true);
});

it("keeps configured-disabled receipts excluded from materialized facets and metadata pagination",()=>{
  db.exec("UPDATE sources SET configured=0 WHERE id='replays'");
  checkTruth({stale:true});
  const reader=store.createQueryReader(),before=snapshot(),failed=expected({stale:true}).filter(row=>row.state==='failed').length;
  expect(reader.facets({},'astate',{search:'FAIL'}).items).toEqual([{value:'failed',count:failed}]);
  expect(reader.facets({},'astate',{search:'missing'}).items).toEqual([]);
  expect(reader.facets({},'astate',{limit:100}).items).toEqual(reader.facets({},'astate').items);
  expect(snapshot()).toEqual(before);
});
it("keeps valid S facet status when the retired primary analysis cache is NULL",()=>{
  const expected=store.createQueryReader().facets({},'astate').items;
  db.prepare('UPDATE query_projection SET analysis=NULL WHERE id=?').run(fixtureRow('current-C').id);
  const before=snapshot();
  expect(store.createQueryReader().facets({},'astate').items).toEqual(expected);
  expect(expected.reduce((n,row)=>n+row.count,0)).toBe(16);
  expect(snapshot()).toEqual(before);
});
it("merges raw active buckets after scope filtering while preserving paused rows and facet cursors",()=>{
  for(const name of ["none","S-queued","S-running","current-C"])store.setFavourite(fixtureRow(name).id,true);
  drain();const input={scope:{kind:"favourites" as const},filters:[{field:"astate" as const,values:["none"]}]};
  for(const paused of [false,true]){
    store.metrics.setAnalysisSettings({...store.metrics.analysisSettings(),userPaused:paused});
    const reader=store.createQueryReader(),before=snapshot(),want=[{value:"active",count:2},{value:"none",count:2}];
    expect(reader.facets(input,"astate").items).toEqual(want);
    expect(reader.facets(input,"astate",{search:"ACT"}).items).toEqual(want.slice(0,1));
    const first=reader.facets(input,"astate",{limit:1}),second=reader.facets(input,"astate",{limit:1,after:first.next});
    expect([...first.items,...second.items]).toEqual(want);expect(second.next).toBeUndefined();
    expect(reader.page({scope:input.scope}).items.filter(row=>row.analysis===(paused?"paused":"queued")||!paused&&row.analysis==="analysing")).toHaveLength(2);
    expect(snapshot()).toEqual(before);
  }
});
