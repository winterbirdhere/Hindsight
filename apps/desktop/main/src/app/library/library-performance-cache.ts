import type { DatabaseSync } from "node:sqlite";
import type { PerformanceMode } from "@rewind/osu-performance/types";
import type { LibraryMapCalculation } from "./library-map-performance";

const fields=["version","objectCount","stars","maxCombo","largeTicks","smallTicks","sliderTails","clockRate","drainTimeMs","endTimeMs"] as const;
const counts=["objectCount","maxCombo","largeTicks","smallTicks","sliderTails"] as const;
function identity(inputKey:string,mode:PerformanceMode):void {
  if(!/^[a-f0-9]{64}$/.test(inputKey)||!["stable","lazer","lazer-classic"].includes(mode))throw new Error("Invalid performance cache identity");
}
function encode(value:LibraryMapCalculation):string {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==fields.length||
    Object.keys(value).some(key=>!fields.includes(key as typeof fields[number]))||value.version!==1||
    counts.some(key=>!Number.isSafeInteger(value[key])||value[key]<0||value[key]>2147483647)||value.objectCount===0||
    !Number.isFinite(value.stars)||value.stars<0||!Number.isFinite(value.clockRate)||value.clockRate<=0||
    !Number.isFinite(value.drainTimeMs)||value.drainTimeMs<0||!Number.isFinite(value.endTimeMs))
    throw new Error("Invalid compact performance cache value");
  const encoded=JSON.stringify(Object.fromEntries(fields.map(key=>[key,value[key]])));
  if(Buffer.byteLength(encoded)>2048)throw new Error("Performance cache value limit exceeded");
  return encoded;
}

/** Shared compact map mathematics only. Cache access never schedules analysis or changes user metadata. */
export class LibraryPerformanceCache {
  constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(work:()=>T)=>T,private readonly maximumEntries=4096) {
    if(!Number.isSafeInteger(maximumEntries)||maximumEntries<1||maximumEntries>4096)throw new Error("Invalid performance cache limit");
  }
  static migrate(db:DatabaseSync):void {
    db.exec(`CREATE TABLE performance_map_cache(input_key TEXT PRIMARY KEY,mode TEXT NOT NULL,payload TEXT NOT NULL,last_used INTEGER NOT NULL);
      CREATE INDEX performance_map_cache_lru ON performance_map_cache(last_used,input_key);
      INSERT INTO counters VALUES('performance-map-use',0); PRAGMA user_version=13;`);
  }
  static migrateScalars(db:DatabaseSync):void {
    db.exec(`CREATE TABLE performance_scalar_cache(input_key TEXT PRIMARY KEY,mode TEXT NOT NULL,value REAL NOT NULL,last_used INTEGER NOT NULL);
      CREATE INDEX performance_scalar_cache_lru ON performance_scalar_cache(last_used,input_key); PRAGMA user_version=15;`);
  }
  getScalar(inputKey:string,mode:PerformanceMode):number|undefined {
    identity(inputKey,mode);
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT value FROM performance_scalar_cache WHERE input_key=? AND mode=?").get(inputKey,mode);
      if(!row)return undefined;
      const value=Number(row.value);if(!Number.isFinite(value)||value<0)throw new Error("Invalid performance scalar cache value");
      this.db.prepare("UPDATE performance_scalar_cache SET last_used=? WHERE input_key=?").run(this.nextUse(),inputKey);return value;
    });
  }
  putScalar(inputKey:string,mode:PerformanceMode,value:number):void {
    identity(inputKey,mode);if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new Error("Invalid performance scalar cache value");
    this.transaction(()=>{
      const prior=this.db.prepare("SELECT mode,value FROM performance_scalar_cache WHERE input_key=?").get(inputKey);
      if(prior&&(prior.mode!==mode||prior.value!==value))throw new Error("Conflicting performance cache mathematics");
      this.db.prepare(`INSERT INTO performance_scalar_cache VALUES(?,?,?,?) ON CONFLICT(input_key) DO UPDATE SET last_used=excluded.last_used`)
        .run(inputKey,mode,value,this.nextUse());
      this.db.prepare(`DELETE FROM performance_scalar_cache WHERE input_key IN
        (SELECT input_key FROM performance_scalar_cache ORDER BY last_used DESC,input_key DESC LIMIT -1 OFFSET ?)`).run(this.maximumEntries);
    });
  }
  get(inputKey:string,mode:PerformanceMode):LibraryMapCalculation|undefined {
    identity(inputKey,mode);
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT payload FROM performance_map_cache WHERE input_key=? AND mode=?").get(inputKey,mode);
      if(!row)return undefined;
      const value=JSON.parse(String(row.payload)) as LibraryMapCalculation;encode(value);
      this.db.prepare("UPDATE performance_map_cache SET last_used=? WHERE input_key=?").run(this.nextUse(),inputKey);
      return value;
    });
  }
  put(inputKey:string,mode:PerformanceMode,value:LibraryMapCalculation):void {
    identity(inputKey,mode);const payload=encode(value);
    this.transaction(()=>{
      const prior=this.db.prepare("SELECT mode,payload FROM performance_map_cache WHERE input_key=?").get(inputKey);
      if(prior&&(prior.mode!==mode||prior.payload!==payload))throw new Error("Conflicting performance cache mathematics");
      this.db.prepare(`INSERT INTO performance_map_cache(input_key,mode,payload,last_used) VALUES(?,?,?,?)
        ON CONFLICT(input_key) DO UPDATE SET last_used=excluded.last_used`).run(inputKey,mode,payload,this.nextUse());
      this.db.prepare(`DELETE FROM performance_map_cache WHERE input_key IN
        (SELECT input_key FROM performance_map_cache ORDER BY last_used DESC,input_key DESC LIMIT -1 OFFSET ?)`)
        .run(this.maximumEntries);
    });
  }
  private nextUse():number {
    const prior=Number(this.db.prepare("SELECT value FROM counters WHERE key='performance-map-use'").get()?.value);
    if(!Number.isSafeInteger(prior)||prior<0||prior>=Number.MAX_SAFE_INTEGER)throw new Error("Performance cache use counter exhausted");
    this.db.prepare("UPDATE counters SET value=? WHERE key='performance-map-use'").run(prior+1);return prior+1;
  }
}
