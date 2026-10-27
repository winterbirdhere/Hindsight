import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryArtworkCache } from "./library-artwork-cache";
import { promises as fs } from "fs";

const key=(n:number)=>n.toString(16).padStart(64,"0"),bytes=Buffer.from("verified thumbnail");
const validate=(value:Buffer)=>{if(!value.equals(bytes))throw Error("invalid thumbnail");};
describe("bounded verified artwork cache",()=>{
  let directory:string;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"rewind-art-cache-"));});
  afterEach(async()=>{if(!directory.startsWith(join(tmpdir(),"rewind-art-cache-")))throw Error("Unexpected cache fixture");await rm(directory,{recursive:true,force:true});});
  it("deduplicates concurrent transforms and reloads verified bytes after restart",async()=>{
    const first=new LibraryArtworkCache({directory});let finish!:(value:Buffer)=>void;
    const create=jest.fn(()=>new Promise<Buffer>(resolve=>{finish=resolve;}));
    const a=first.get(key(1),create,validate),b=first.get(key(1),create,validate);
    while(!finish)await new Promise(resolve=>setImmediate(resolve));finish(bytes);
    expect(await a).toEqual(bytes);expect(await b).toEqual(bytes);expect(create).toHaveBeenCalledTimes(1);
    const result=await first.get(key(1),create,validate);result[0]=0;
    expect(await first.get(key(1),create,validate)).toEqual(bytes);
    const restarted=new LibraryArtworkCache({directory}),unexpected=jest.fn(async()=>{throw Error("decode should be cached");});
    expect(await restarted.get(key(1),unexpected,validate)).toEqual(bytes);expect(unexpected).not.toHaveBeenCalled();
    expect(restarted.status()).toMatchObject({diskHits:1,pending:0});
    expect((await readdir(directory)).every(name=>name.endsWith(".thumb"))).toBe(true);
  });
  it.each(["digest","key","truncated"])("treats a %s disk entry as a miss and regenerates",async fault=>{
    await new LibraryArtworkCache({directory}).get(key(1),async()=>bytes,validate);
    const file=join(directory,key(1)+".thumb"),stored=await readFile(file);
    if(fault==="digest")stored[stored.length-1]^=1;if(fault==="key")stored[8]^=1;
    await writeFile(file,fault==="truncated"?stored.subarray(0,40):stored);
    const create=jest.fn(async()=>bytes),cache=new LibraryArtworkCache({directory});
    expect(await cache.get(key(1),create,validate)).toEqual(bytes);expect(create).toHaveBeenCalledTimes(1);
    expect(cache.status().diskHits).toBe(0);
  });
  it("evicts least recently used RAM and disk entries within both byte and count limits",async()=>{
    const cache=new LibraryArtworkCache({directory,memoryEntries:2,memoryBytes:bytes.length*2,diskEntries:2,diskBytes:2048});
    for(const n of [1,2,1,3])await cache.get(key(n),async()=>bytes,validate);
    expect(cache.status()).toMatchObject({memoryEntries:2,memoryBytes:bytes.length*2,diskEntries:2});
    expect((await readdir(directory)).sort()).toEqual([key(1)+".thumb",key(3)+".thumb"]);
    const missed=jest.fn(async()=>bytes);await cache.get(key(2),missed,validate);expect(missed).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid producer output and retries the same key without persisting failure",async()=>{
    const cache=new LibraryArtworkCache({directory});
    await expect(cache.get(key(1),async()=>Buffer.from("wrong"),validate)).rejects.toThrow("invalid");
    expect(await cache.get(key(1),async()=>bytes,validate)).toEqual(bytes);expect(cache.status().pending).toBe(0);
  });
  it("does not add disk entries when eviction cannot remove the oldest entry",async()=>{
    const cache=new LibraryArtworkCache({directory,diskEntries:2,diskBytes:2048});
    for(const n of [1,2])await cache.get(key(n),async()=>bytes,validate);
    const oldest=join(directory,key(1)+".thumb");await rm(oldest);await mkdir(oldest);
    for(const n of [3,4])expect(await cache.get(key(n),async()=>bytes,validate)).toEqual(bytes);
    expect(cache.status().diskEntries).toBeLessThanOrEqual(2);
    expect((await readdir(directory)).sort()).toEqual([key(1)+".thumb",key(2)+".thumb"]);
    expect(cache.status().diskErrors).toBeGreaterThan(0);
  });
  it("keeps verified image delivery working when the disposable disk cache is unwritable",async()=>{
    const file=join(directory,"not-a-directory");await writeFile(file,"preserve me");
    const cache=new LibraryArtworkCache({directory:file});expect(await cache.get(key(1),async()=>bytes,validate)).toEqual(bytes);
    expect(await readFile(file,"utf8")).toBe("preserve me");expect(cache.status().diskErrors).toBeGreaterThan(0);
  });
  it("recovers only exact owned interrupted-write files before admitting new disk writes",async()=>{
    const orphan=join(directory,`.${key(9)}.12345678-1234-4123-8123-123456789abc.tmp`),unknown=join(directory,"keep-me.tmp");
    await writeFile(orphan,Buffer.alloc(4096));await writeFile(unknown,"unrecognized");
    await new LibraryArtworkCache({directory,diskBytes:1024}).get(key(1),async()=>bytes,validate);
    expect((await readdir(directory)).sort()).toEqual([key(1)+".thumb","keep-me.tmp"].sort());
    expect(await readFile(unknown,"utf8")).toBe("unrecognized");
  });
  it("disables disk writes if an owned orphan cannot be removed",async()=>{
    const orphan=join(directory,`.${key(9)}.12345678-1234-4123-8123-123456789abc.tmp`);await writeFile(orphan,Buffer.alloc(4096));
    const unlink=fs.unlink;
    const mock=jest.spyOn(fs,"unlink").mockImplementation(async file=>{if(String(file)===orphan)throw Error("fixture cleanup denied");await unlink(file);});
    try{const cache=new LibraryArtworkCache({directory,diskBytes:1024});
      for(const n of [1,2])expect(await cache.get(key(n),async()=>bytes,validate)).toEqual(bytes);
      expect(await readdir(directory)).toEqual([orphan.slice(directory.length+1)]);expect(cache.status().diskErrors).toBeGreaterThan(0);
    }finally{mock.mockRestore();}
  });
  it("stops new disk writes when an interrupted write cannot clean up its temporary file",async()=>{
    const unlink=fs.unlink;
    const renameMock=jest.spyOn(fs,"rename").mockRejectedValue(Error("fixture rename failed"));
    const unlinkMock=jest.spyOn(fs,"unlink").mockImplementation(async file=>{if(String(file).endsWith(".tmp"))throw Error("fixture cleanup failed");await unlink(file);});
    try{const cache=new LibraryArtworkCache({directory,diskBytes:1024});
      for(const n of [1,2])expect(await cache.get(key(n),async()=>bytes,validate)).toEqual(bytes);
      const files=await readdir(directory);expect(files).toHaveLength(1);expect(files[0]).toMatch(/\.tmp$/);expect(renameMock).toHaveBeenCalledTimes(1);
    }finally{renameMock.mockRestore();unlinkMock.mockRestore();}
  });
});
