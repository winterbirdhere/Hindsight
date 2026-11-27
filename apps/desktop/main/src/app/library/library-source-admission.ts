import type { DatabaseSync } from "node:sqlite";
import { LibraryQueryInvalidation, LibraryQueryInvalidationPage, LibraryQueryInvalidationScope } from "./library-query-invalidation";

/** Durable availability admission only. Query truth has its own queue and always runs first. */
export class LibrarySourceAdmission {
  private readonly queue:LibraryQueryInvalidation;
  constructor(private readonly db:DatabaseSync,private readonly admit:(id:string)=>void){
    this.queue=new LibraryQueryInvalidation(db,"source_admission_scopes");
  }
  static migrate(db:DatabaseSync):void {
    LibraryQueryInvalidation.migrate(db,"source_admission_scopes");
    // Recovery can project a legacy page before production admissions are enabled.
    // Retain eventual admission for that entire scope, including identities before its cursor.
    db.exec(`INSERT INTO source_admission_scopes(kind,scope_id)
      SELECT CASE kind WHEN 'source-locations' THEN 'source' WHEN 'map-md5' THEN 'map' ELSE 'map-source' END,scope_id
      FROM query_projection_scopes WHERE kind IN ('source-locations','map-source','map-md5')
      ON CONFLICT(kind,scope_id) DO NOTHING;`);
  }
  pendingCount():number{return this.queue.pendingCount();}
  private page(scope:LibraryQueryInvalidationScope,after:string,limit:number):LibraryQueryInvalidationPage {
    const sql=scope.kind==="source"?"SELECT replay_id AS id FROM locations WHERE source_id=? AND replay_id>? GROUP BY replay_id ORDER BY replay_id LIMIT ?":
      scope.kind==="map-source"?"SELECT m.source_key AS id,m.md5 FROM maps m JOIN map_scans g ON g.source_id=m.source_id AND g.current_generation=m.generation WHERE m.source_id=? AND m.source_key>? ORDER BY m.source_key LIMIT ?":
      scope.kind==="map"?"SELECT id FROM query_projection WHERE map_identity=? AND id>? ORDER BY id LIMIT ?":undefined;
    if(!sql)throw Error("Invalid source admission scope");
    const rows=this.db.prepare(sql).all(scope.scopeId,after,limit+1),more=rows.length>limit;if(more)rows.pop();
    return{ids:rows.map(row=>String(scope.kind==="map-source"?row.md5:row.id)),...(more?{next:String(rows[rows.length-1].id)}:{})};
  }
  /** Caller owns transaction and flushes every admitted row's scalar dirtiness before commit. */
  maintainInTransaction(limit=8):{processed:number;pending:number}{
    return this.queue.expandInTransaction(limit,(scope,after,bound)=>this.page(scope,after,bound),(ids,scope)=>{
      for(const id of ids)if(scope.kind==="map-source")this.queue.enqueue("map",id);else this.admit(id);
    });
  }
}
