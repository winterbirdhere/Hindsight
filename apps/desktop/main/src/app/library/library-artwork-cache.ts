import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, utimes } from "fs/promises";
import { isAbsolute, join } from "path";
import { LIBRARY_PASSIVE_ART_MAX_BYTES } from "../../../../shared/library-passive-resources";

const magic=Buffer.from("RWART01\n"),headerBytes=72;
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest();
interface Options { directory?:string;memoryBytes?:number;memoryEntries?:number;diskBytes?:number;diskEntries?:number }
/** Only verified, bounded transformed bytes live here. Source selection/validation remains with
 * each caller. Cancellation never abandons a shared transform: every consumer awaits its drain. */
export class LibraryArtworkCache {
  private readonly memory=new Map<string,Buffer>();
  private readonly pending=new Map<string,Promise<Buffer>>();
  private readonly disk=new Map<string,{bytes:number;used:number}>();
  private memoryBytes=0;
  private diskBytes=0;
  private sequence=0;
  private initialized?:Promise<void>;
  private diskRoot?:string;
  private diskTail:Promise<void>=Promise.resolve();
  private readonly limits:{memoryBytes:number;memoryEntries:number;diskBytes:number;diskEntries:number};
  private readonly counts={memoryHits:0,diskHits:0,misses:0,generated:0,deduplicated:0,diskErrors:0};
  constructor(private readonly options:Options={}) {
    this.limits={memoryBytes:options.memoryBytes??32*1024*1024,memoryEntries:options.memoryEntries??256,
      diskBytes:options.diskBytes??128*1024*1024,diskEntries:options.diskEntries??1024};
    if(Object.values(this.limits).some(value=>!Number.isSafeInteger(value)||value<1)||options.directory!==undefined&&!isAbsolute(options.directory))throw Error("Invalid artwork cache limits/path");
  }
  status(){return{...this.counts,memoryBytes:this.memoryBytes,memoryEntries:this.memory.size,diskBytes:this.diskBytes,diskEntries:this.disk.size,pending:this.pending.size};}
  private retain(key:string,bytes:Buffer):void {
    const prior=this.memory.get(key);if(prior){this.memoryBytes-=prior.length;this.memory.delete(key);}
    if(bytes.length>this.limits.memoryBytes)return;
    this.memory.set(key,Buffer.from(bytes));this.memoryBytes+=bytes.length;
    while(this.memoryBytes>this.limits.memoryBytes||this.memory.size>this.limits.memoryEntries){const oldest=this.memory.entries().next().value;if(!oldest)break;this.memoryBytes-=oldest[1].length;this.memory.delete(oldest[0]);}
  }
  private async safeDirectory():Promise<boolean>{
    if(!this.options.directory||!this.diskRoot)return false;
    const info=await lstat(this.options.directory);return info.isDirectory()&&!info.isSymbolicLink()&&await realpath(this.options.directory)===this.diskRoot;
  }
  private initialize():Promise<void>{
    return this.initialized??=(async()=>{
      if(!this.options.directory)return;
      try{
        await mkdir(this.options.directory,{recursive:true});const info=await lstat(this.options.directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error("Invalid artwork cache directory");
        this.diskRoot=await realpath(this.options.directory);const directory=await opendir(this.options.directory);let seen=0;
        for await(const entry of directory){
          if(++seen>4096)throw Error("Artwork cache directory inventory exceeded limit");
          if(/^\.[a-f0-9]{64}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.name)){
            if(!await this.safeDirectory())throw Error("Artwork cache directory changed");
            const file=join(this.options.directory,entry.name),temporary=await lstat(file);
            if(!temporary.isFile()||temporary.isSymbolicLink())throw Error("Invalid owned artwork cache temporary file");
            await unlink(file);continue;
          }
          if(!entry.isFile()||!/^([a-f0-9]{64})\.thumb$/.test(entry.name))continue;
          const info=await lstat(join(this.options.directory,entry.name));if(!info.isFile()||info.isSymbolicLink())continue;
          this.disk.set(entry.name.slice(0,64),{bytes:info.size,used:info.mtimeMs});this.diskBytes+=info.size;this.sequence=Math.max(this.sequence,info.mtimeMs);
        }
        await this.prune();
      }catch{this.counts.diskErrors++;this.diskRoot=undefined;this.disk.clear();this.diskBytes=0;}
    })();
  }
  private async prune(reservedBytes=0,reservedEntries=0):Promise<void>{
    const directory=this.options.directory;if(!directory||!await this.safeDirectory())return;
    while(this.diskBytes+reservedBytes>this.limits.diskBytes||this.disk.size+reservedEntries>this.limits.diskEntries){
      const [key,row]=[...this.disk].reduce((a,b)=>a[1].used<=b[1].used?a:b);
      await unlink(join(directory,key+".thumb"));this.disk.delete(key);this.diskBytes-=row.bytes;
    }
  }
  private serial(work:()=>Promise<void>):Promise<void>{
    const result=this.diskTail.then(work).catch(()=>{this.counts.diskErrors++;this.diskRoot=undefined;});this.diskTail=result;return result;
  }
  private async readDisk(key:string,validate:(bytes:Buffer)=>void):Promise<Buffer|undefined>{
    await this.initialize();
    if(!this.disk.has(key))return;
    try{
      const directory=this.options.directory;if(!directory||!await this.safeDirectory())return;
      const file=join(directory,key+".thumb"),info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size<headerBytes+1||info.size>headerBytes+LIBRARY_PASSIVE_ART_MAX_BYTES)return;
      const handle=await open(file,"r");let stored:Buffer;
      try{const actual=await handle.stat();if(actual.dev!==info.dev||actual.ino!==info.ino||actual.size!==info.size)return;stored=Buffer.alloc(info.size);let offset=0;
        while(offset<stored.length){const read=await handle.read(stored,offset,stored.length-offset,offset);if(!read.bytesRead)return;offset+=read.bytesRead;}
      }finally{await handle.close();}
      const bytes=stored.subarray(headerBytes);
      if(!stored.subarray(0,8).equals(magic)||stored.subarray(8,40).toString("hex")!==key||!stored.subarray(40,72).equals(digest(bytes)))return;
      validate(bytes);this.counts.diskHits++;await this.touch(key);return bytes;
    }catch{this.counts.diskErrors++;return;}
  }
  private touch(key:string):Promise<void>{return this.serial(async()=>{
    const row=this.disk.get(key),directory=this.options.directory;if(!row||!directory||!await this.safeDirectory())return;row.used=++this.sequence;
    const time=new Date();await utimes(join(directory,key+".thumb"),time,time);
  });}
  private async writeDisk(key:string,bytes:Buffer):Promise<void>{
    await this.initialize();
    await this.serial(async()=>{
      const directory=this.options.directory;if(!directory||!await this.safeDirectory()||bytes.length+headerBytes>this.limits.diskBytes)return;
      // Reserve space before creating a replacement. A failed eviction must not grow disk use.
      const prior=this.disk.get(key);
      if(prior){await unlink(join(directory,key+".thumb"));this.disk.delete(key);this.diskBytes-=prior.bytes;}
      await this.prune(bytes.length+headerBytes,1);
      const temporary=join(directory,`.${key}.${randomUUID()}.tmp`),file=join(directory,key+".thumb");
      const stored=Buffer.concat([magic,Buffer.from(key,"hex"),digest(bytes),bytes]);
      try{const handle=await open(temporary,"wx");try{await handle.writeFile(stored);await handle.sync();}finally{await handle.close();}
        if(!await this.safeDirectory())return;await rename(temporary,file);
        this.disk.set(key,{bytes:stored.length,used:++this.sequence});this.diskBytes+=stored.length;
      }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});}
    });
  }
  async get(key:string,create:()=>Promise<Buffer>,validate:(bytes:Buffer)=>void):Promise<Buffer>{
    if(!/^[a-f0-9]{64}$/.test(key))throw Error("Invalid artwork cache key");
    const cached=this.memory.get(key);
    if(cached){validate(cached);this.counts.memoryHits++;this.retain(key,cached);await this.touch(key);return Buffer.from(cached);}
    const existing=this.pending.get(key);if(existing){this.counts.deduplicated++;return Buffer.from(await existing);}
    const work=(async()=>{
      const disk=await this.readDisk(key,validate);if(disk){this.retain(key,disk);return disk;}
      this.counts.misses++;const bytes=await create();if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>LIBRARY_PASSIVE_ART_MAX_BYTES)throw Error("Invalid artwork cache output");
      validate(bytes);this.counts.generated++;this.retain(key,bytes);await this.writeDisk(key,bytes);return bytes;
    })();this.pending.set(key,work);
    try{return Buffer.from(await work);}finally{if(this.pending.get(key)===work)this.pending.delete(key);}
  }
}
