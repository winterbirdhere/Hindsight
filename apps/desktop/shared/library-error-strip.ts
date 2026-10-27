import type { LibraryMetricValue } from "./replay-library-metrics";
export const LIBRARY_STRIP_MAX_BYTES=64*1024;
// Even a one-character timestamp needs two bytes with its separator. This is
// only a cheap allocation preflight; the complete serialized envelope decides.
export const LIBRARY_STRIP_MAX_MARKS=Math.floor(LIBRARY_STRIP_MAX_BYTES/2);
export interface LibraryStripDomain {
  /** Nominal map extent. Observed Stable tail markers may resolve beyond it; rendering must include their extent. */
  mapStartMs:number;mapEndMs:number;evaluatedThrough:number;
  endpointBasis:"recorded-end"|"health-derived"|"aggregate-inferred";synthesizedEndpoint:boolean;
}
export type LibraryErrorStrip=LibraryStripDomain & {
  version:1;timeBasis:"map-ms";ok:number[];meh:number[];miss:number[];sliderEndMiss:number[];
} & ({ruleset:"stable";sliderBreak:number[]}|{ruleset:"lazer";componentMiss:number[]});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v)&&
  (Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const time=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
/** Narrow persistence boundary: no event identifiers, coordinates, evidence or cause graphs. */
export function validateLibraryErrorStrip(value:unknown):asserts value is LibraryMetricValue<LibraryErrorStrip> {
  const invalid=():never=>{throw new Error("Invalid library error strip");};
  if(!object(value))return invalid();
  if(value.state!=="known"){
    if(!["unknown","error","not-applicable"].includes(String(value.state))||typeof value.reason!=="string"||
      !/^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value.reason)||Object.keys(value).some(k=>k!=="state"&&k!=="reason"))invalid();
    return;
  }
  if(Object.keys(value).some(k=>k!=="state"&&k!=="value")||!object(value.value))return invalid();
  const strip=value.value,channel=strip.ruleset==="stable"?"sliderBreak":strip.ruleset==="lazer"?"componentMiss":null;
  if(!channel||strip.version!==1||strip.timeBasis!=="map-ms"||!time(strip.mapStartMs)||!time(strip.mapEndMs)||
    strip.mapEndMs<strip.mapStartMs||!time(strip.evaluatedThrough)||typeof strip.synthesizedEndpoint!=="boolean"||
    !["recorded-end","health-derived","aggregate-inferred"].includes(String(strip.endpointBasis)))return invalid();
  const channels=["ok","meh","miss","sliderEndMiss",channel];
  if(Object.keys(strip).some(k=>!["version","timeBasis","ruleset","mapStartMs","mapEndMs","evaluatedThrough","endpointBasis","synthesizedEndpoint",...channels].includes(k)))invalid();
  let count=0;
  for(const key of channels){
    const values=strip[key];if(!Array.isArray(values)||(count+=values.length)>LIBRARY_STRIP_MAX_MARKS)return invalid();
    for(let i=0;i<values.length;i++)if(!time(values[i]))invalid();
  }
  // Every admitted string/key is fixed ASCII and numbers serialize as ASCII, so length equals UTF-8 bytes.
  if(JSON.stringify(value).length>LIBRARY_STRIP_MAX_BYTES)invalid();
}
