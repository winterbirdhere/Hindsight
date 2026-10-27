import { LibraryErrorStrip, validateLibraryErrorStrip } from "./library-error-strip";

const strip=(marks:number[])=>({state:"known" as const,value:{version:1 as const,timeBasis:"map-ms" as const,
  ruleset:"stable" as const,mapStartMs:0,mapEndMs:100000,evaluatedThrough:100000,
  endpointBasis:"recorded-end" as const,synthesizedEndpoint:false,ok:marks,meh:[],miss:[],sliderEndMiss:[],sliderBreak:[]}});
it("admits dense byte-fitting strips without dropping duplicate timestamps",()=>{
  const value=strip(Array.from({length:3125},(_,i)=>i%1500));
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(64*1024);
  expect(()=>validateLibraryErrorStrip(value)).not.toThrow();
  expect(value.value.ok).toHaveLength(3125);
});
it("keeps the exact 64KiB boundary authoritative for both rulesets",()=>{
  for(const ruleset of ["stable","lazer"] as const){
    const value=strip([]) as {state:"known";value:LibraryErrorStrip};
    if(ruleset==="lazer"){const {sliderBreak,...base}=value.value as Extract<LibraryErrorStrip,{ruleset:"stable"}>;
      value.value={...base,ruleset,componentMiss:sliderBreak};}
    const overhead=Buffer.byteLength(JSON.stringify(value));
    value.value.ok=Array(Math.floor((64*1024-overhead+1)/2)).fill(0);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(64*1024);
    expect(()=>validateLibraryErrorStrip(value)).not.toThrow();
    value.value.ok.push(0);expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(64*1024);
    expect(()=>validateLibraryErrorStrip(value)).toThrow(/strip/);
  }
});
it("continues to reject sparse/nonfinite/cause-bearing data",()=>{
  for(const marks of [new Array(3),[NaN],[Infinity],[Number.MAX_SAFE_INTEGER+1]])
    expect(()=>validateLibraryErrorStrip(strip(marks))).toThrow(/strip/);
  expect(()=>validateLibraryErrorStrip({...strip([]),cause:"aim"})).toThrow(/strip/);
});
