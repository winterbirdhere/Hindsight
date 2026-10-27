import { isAbsolute } from "path";
import { setImmediate } from "timers/promises";
import { TextDecoder } from "util";
import type { LibraryOpenLocation, LibraryOpenMap } from "./library-store";
import { sourceMapEvidence } from "./library-source-binding";
import { readVerifiedLibraryResource } from "./library-resource-reader";
import { BlueprintParser, dominantBeatLength, invariantDominantBeatLength, parseOsuHitObjectSetting, PathApproximator, PathType, SliderPath } from "@osujs/core";
import { float32_div, Position, Vec2 } from "@osujs/math";

const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
export const LIBRARY_TEMPO_UNAVAILABLE_REASONS=["missing-map-timing","invalid-map-timing","tempo-timing-budget","map-horizon-unavailable","tempo-geometry-budget"] as const;
export type LibraryTempoUnavailableReason=typeof LIBRARY_TEMPO_UNAVAILABLE_REASONS[number];
export const validLibraryTempoUnavailableReason=(value:unknown):value is LibraryTempoUnavailableReason=>
  typeof value==="string"&&(LIBRARY_TEMPO_UNAVAILABLE_REASONS as readonly string[]).includes(value);
export interface LibraryPerformanceMapResource {
  map:{text:string;sha256:string;md5:string};
  metadata:{ruleset:number;baseBpm:number|null;tempoUnavailableReason?:LibraryTempoUnavailableReason};
  location:LibraryOpenLocation;
  mapTicket?:LibraryOpenMap;
}
class TempoUnavailable extends Error {constructor(readonly reason:LibraryTempoUnavailableReason){super(reason);}}
// These bound work in the existing isolated resource helper, not map validity.
const MAX_TIMING_POINTS=8192,MAX_CANDIDATES=128,MAX_PATH_POINTS=64,MAX_PATH_OUTPUT=8192,MAX_GEOMETRY_WORK=1_000_000;
type GeometryBudget={remaining:number};
function spend(budget:GeometryBudget,work:number):void {
  budget.remaining-=work;if(budget.remaining<0)throw new TempoUnavailable("tempo-geometry-budget");
}
/** Preflight the existing subdivision with the same floating-point operations.
 * This proves a bounded call to the unmodified path implementation; a point/coordinate
 * cap alone cannot bound nearly-collinear arcs or adaptive Bezier subdivision. */
class TempoSliderPath extends SliderPath {
  constructor(points:SliderPath["controlPoints"],length:number|undefined,private readonly budget:GeometryBudget){super(points,length);}
  calculateSubPath(points:Position[],type:PathType):Position[]{
    const vectors=points.map(point=>new Vec2(point.x,point.y));
    if(type===PathType.Linear){spend(this.budget,points.length);return super.calculateSubPath(points,type);}
    if(type===PathType.Catmull){
      const output=Math.max(0,points.length-1)*100;if(output>MAX_PATH_OUTPUT)throw new TempoUnavailable("tempo-geometry-budget");
      spend(this.budget,output*16);return super.calculateSubPath(points,type);
    }
    if(type===PathType.PerfectCurve&&points.length===3){
      const arc=PathApproximator.circularArcProperties(vectors);
      if(arc){
        const output=2*arc.radius<=Math.fround(0.1)?2:Math.max(2,Math.ceil(arc.thetaRange/(2*Math.acos(1-float32_div(Math.fround(0.1),arc.radius)))));
        if(!Number.isFinite(output)||output>MAX_PATH_OUTPUT)throw new TempoUnavailable("tempo-geometry-budget");
        spend(this.budget,output*16);return super.calculateSubPath(points,type);
      }
    }
    const pending=[vectors];let output=1;
    while(pending.length){
      const parent=pending.pop()!,count=parent.length;
      // Both preflight and the subsequent production approximation are charged.
      spend(this.budget,4*count*count+count);
      if(PathApproximator._bezierIsFlatEnough(parent)){
        output+=count;if(output>MAX_PATH_OUTPUT)throw new TempoUnavailable("tempo-geometry-budget");
      }else{
        const left=new Array<Vec2>(count),right=new Array<Vec2>(count),buffer=new Array<Vec2>(count);
        PathApproximator._bezierSubdivide(parent,left,right,buffer,count);pending.push(right,left);
      }
    }
    return super.calculateSubPath(points,type);
  }
}
/** Keep long paths as a range in the already bounded resource text. Scalar envelope
 * reading must not allocate an array proportional to path complexity. */
function objectEnvelope(line:string):{fields:string[];pathStart:number;pathEnd:number} {
  const fields:string[]=[];let offset=0,pathStart=0,pathEnd=0;
  for(let index=0;index<8;index++){
    const end=line.indexOf(",",offset),last=end<0?line.length:end;
    if(index===5){pathStart=offset;pathEnd=last;fields.push("");}else fields.push(line.slice(offset,last));
    if(end<0)break;offset=end+1;
  }
  return{fields,pathStart,pathEnd};
}
async function mapMetadata(text:string,checkpoint:()=>Promise<void>,signal?:AbortSignal):Promise<LibraryPerformanceMapResource["metadata"]> {
  const header=/^\ufeff?[ \t]*osu file format v(\d+)\s*(?:\r?\n|$)/.exec(text);
  if(!header)throw new Error("Invalid map format header");
  const version=Number(header[1]),timeOffset=version<=4?24:0;
  const parser=new BlueprintParser("",{formatVersion:version,sectionsToRead:["TimingPoints","Difficulty"]});
  const timingLines:string[]=[];
  let mode:number|undefined,firstBeat:number|undefined,constant=true,timingRows=0,tempoKnown=true,horizonKnown=true,objectCount=0,horizon=-Infinity;
  let timingReason:LibraryTempoUnavailableReason="invalid-map-timing",horizonReason:LibraryTempoUnavailableReason="map-horizon-unavailable";
  const pause=async()=>{await checkpoint();signal?.throwIfAborted();};
  const scan=async(visit:(section:string,line:string,overlong:boolean)=>void|Promise<void>)=>{
    let section="",offset=0,lines=0;
    while(offset<text.length){
      const end=text.indexOf("\n",offset),lineEnd=end===-1?text.length:end,overlong=lineEnd-offset>4096;
      let line="";
      if(!overlong||section==="[HitObjects]"){
        const raw=text.slice(offset,lineEnd),comment=raw.indexOf("//");line=(comment<0?raw:raw.slice(0,comment)).trim();
      }
      offset=end===-1?text.length:end+1;
      if(line.startsWith("[")&&line.endsWith("]"))section=line;
      else if(overlong||line)await visit(section,line,overlong);
      if(++lines%32===0||overlong)await pause();
    }
  };
  // Number accepts hexadecimal/binary spellings which the authoritative legacy
  // float decoder reads differently. An upper bound is safe only when both agree.
  const number=(value:string|undefined)=>{
    if(value===undefined||value.trim()==="")return NaN;
    const parsed=Number(value);return Number.isFinite(parsed)&&parsed===parseFloat(value)?parsed:NaN;
  };
  const integer=(value:string|undefined)=>{
    const parsed=number(value);return value!==undefined&&Number.isInteger(parsed)&&parsed===parseInt(value)?parsed:NaN;
  };
  await scan((section,line,overlong)=>{
    if(overlong&&section!=="[HitObjects]"){
      if(section==="[TimingPoints]"){tempoKnown=false;timingReason="tempo-timing-budget";}
      if(section==="[Difficulty]"){horizonKnown=false;horizonReason="tempo-geometry-budget";}
      if(section==="[General]")throw new Error("Map general metadata line exceeds limit");return;
    }
    if(section==="[General]"&&/^Mode\s*:/.test(line)){
      const value=number(line.slice(line.indexOf(":")+1));
      if(!Number.isInteger(value)||value<0||value>3||mode!==undefined&&mode!==value)throw new Error("Invalid or conflicting map mode");mode=value;
    }else if(section==="[Difficulty]"&&/^SliderMultiplier\s*:/.test(line)){
      const value=number(line.slice(line.indexOf(":")+1));
      if(!Number.isFinite(value)||value<=0)horizonKnown=false;
      else{parser.parseLine("[Difficulty]");parser.parseLine(line);}
    }else if(section==="[TimingPoints]"){
      timingRows++;
      const fields=line.split(",",8),time=number(fields[0]),duration=number(fields[1]),red=fields.length<7||fields[6].trim()==="1";
      if(!Number.isFinite(time)||!Number.isFinite(duration)||fields.length>=7&&!["0","1"].includes(fields[6].trim())||red&&duration<=0){tempoKnown=false;return;}
      if(red){if(firstBeat!==undefined&&duration!==firstBeat)constant=false;firstBeat??=duration;}
      // Only tempo/SV fields are consumed. Unrelated sample metadata cannot poison BPM.
      if(timingRows<=MAX_TIMING_POINTS)timingLines.push(`${time},${duration},4,1,0,100,${red?1:0},0`);
    }else if(section==="[HitObjects]"){
      const {fields,pathStart,pathEnd}=objectEnvelope(line),start=number(fields[2])+timeOffset,type=integer(fields[3]);objectCount++;
      if(!Number.isFinite(start)||!Number.isInteger(type)){horizonKnown=false;return;}
      horizon=Math.max(horizon,start);
      if(type&1)return;
      if(type&2){
        const spans=integer(fields[6]),length=fields[7]===undefined?0:number(fields[7]);
        if(!Number.isInteger(spans)||spans<1||spans>9000||!Number.isFinite(length)||length<0)horizonKnown=false;
      }else if(type&8){
        const end=number(line.slice(pathStart,pathEnd))+timeOffset;if(!Number.isFinite(end))horizonKnown=false;else horizon=Math.max(horizon,end);
      }else horizonKnown=false;
    }
  });
  const absent=(reason:LibraryTempoUnavailableReason)=>({ruleset:mode??0,baseBpm:null,tempoUnavailableReason:reason});
  if(!tempoKnown)return absent(timingReason);
  if(firstBeat===undefined)return absent("missing-map-timing");
  // A single exact tempo needs no duration or geometry, retaining existing known values.
  if(constant){const bpm=60000/firstBeat;return Number.isFinite(bpm)&&bpm>0?{ruleset:mode??0,baseBpm:bpm}:absent("invalid-map-timing");}
  if(timingRows>MAX_TIMING_POINTS)return absent("tempo-timing-budget");
  if(!horizonKnown||!objectCount||!Number.isFinite(horizon)||horizon<=0)return absent(horizonReason);
  parser.parseLine("[TimingPoints]");
  for(let index=0;index<timingLines.length;index++){
    parser.parseLine(timingLines[index]);if(index%32===31)await pause();
  }
  parser.flushPendingPoints();
  const control=parser.controlPointInfo,budget={remaining:MAX_GEOMETRY_WORK};let candidates=0;
  let upperHorizon=horizon,certificateKnown=true,envelopeWork=0;
  await scan(async(section,line)=>{
    if(section!=="[HitObjects]"||!certificateKnown)return;
    const {fields,pathStart,pathEnd}=objectEnvelope(line),type=integer(fields[3]);if(type&1||!(type&2))return;
    const start=number(fields[2])+timeOffset,spans=integer(fields[6]),length=number(fields[7]);
    const velocity=100*parser.blueprintDifficulty.sliderMultiplier*control.difficultyPointAt(start).speedMultiplier/control.timingPointAt(start).beatLength;
    const upper=start+(spans*length)/velocity;
    if(!Number.isFinite(length)||length<=0||!Number.isFinite(upper)||!Number.isFinite(velocity)||velocity<=0){certificateKnown=false;return;}
    upperHorizon=Math.max(upperHorizon,upper);
    const x=number(fields[0]),y=number(fields[1]);
    if(![x,y].every(Number.isFinite)||Math.abs(x)>131072||Math.abs(y)>131072){certificateKnown=false;return;}
    let offset=pathStart,previousType=false;
    while(offset<=pathEnd){
      if(++envelopeWork>MAX_GEOMETRY_WORK){certificateKnown=false;return;}
      const separator=line.indexOf("|",offset),end=separator<0||separator>pathEnd?pathEnd:separator;
      if(end-offset>4096){certificateKnown=false;return;}
      const token=line.slice(offset,end),isType=/^[LBPC]$/.test(token);
      if(isType){
        if(offset!==pathStart&&(previousType||end===pathEnd)){certificateKnown=false;return;}
      }else{
        const coordinates=token.split(":",3).map(number);
        if(coordinates.length!==2||coordinates.some(value=>!Number.isFinite(value)||Math.abs(value)>131072)){certificateKnown=false;return;}
      }
      previousType=isType;
      if(envelopeWork%256===0)await pause();
      if(end===pathEnd)break;offset=end+1;
    }
  });
  if(certificateKnown){
    await pause();const beat=invariantDominantBeatLength(control.timingPoints.list,horizon,upperHorizon);await pause();
    if(beat!==null){const bpm=60000/beat;if(Number.isFinite(bpm)&&bpm>0)return{ruleset:mode??0,baseBpm:bpm};}
  }
  try{
    await scan(async(section,line,overlong)=>{
      if(section!=="[HitObjects]")return;
      const {fields,pathStart,pathEnd}=objectEnvelope(line),type=integer(fields[3]);if(type&1||!(type&2))return;
      const start=number(fields[2])+timeOffset,spans=integer(fields[6]),length=fields[7]===undefined?undefined:number(fields[7]);
      const velocity=100*parser.blueprintDifficulty.sliderMultiplier*control.difficultyPointAt(start).speedMultiplier/control.timingPointAt(start).beatLength;
      if(!Number.isFinite(velocity)||velocity<=0)throw new TempoUnavailable("map-horizon-unavailable");
      // SliderPath.calculateLength: for positive expected distance, clipping/extension
      // returns that distance, or a shorter degenerate path. The SAME arithmetic as
      // Slider.endTime makes this a conservative bound, with no guessed epsilon.
      if(length!==undefined&&length>0&&start+(spans*length)/velocity<=horizon)return;
      if(overlong)throw new TempoUnavailable("tempo-geometry-budget");
      if(++candidates>MAX_CANDIDATES)throw new TempoUnavailable("tempo-geometry-budget");
      await pause();
      const pathText=line.slice(pathStart,pathEnd),path=pathText.split("|");
      if(!path||path.length>MAX_PATH_POINTS)throw new TempoUnavailable("tempo-geometry-budget");
      const x=number(fields[0]),y=number(fields[1]);
      if(![x,y].every(Number.isFinite))throw new TempoUnavailable("map-horizon-unavailable");
      for(const point of path){
        if(/^[LBPC]$/.test(point))continue;
        const coordinates=point.split(":").map(number);
        if(coordinates.length!==2||!coordinates.every(Number.isFinite))throw new TempoUnavailable("map-horizon-unavailable");
        if(coordinates.some(value=>Math.abs(value)>131072))throw new TempoUnavailable("tempo-geometry-budget");
      }
      if(Math.abs(x)>131072||Math.abs(y)>131072)throw new TempoUnavailable("tempo-geometry-budget");
      // Geometry does not consume edge samples or repeat count. Keep the exact
      // path/position/length decoder while avoiding thousands of sample allocations.
      const geometryLine=`${fields[0]},${fields[1]},${fields[2]},2,0,${pathText},1${fields[7]===undefined?"":","+fields[7]}`;
      const object=parseOsuHitObjectSetting(geometryLine,timeOffset);
      if(object.type!=="SLIDER"||object.pathPoints.length>MAX_PATH_POINTS)throw new TempoUnavailable("tempo-geometry-budget");
      const distance=new TempoSliderPath(object.pathPoints,object.length,budget).distance;
      const end=start+(spans*distance)/velocity;
      if(!Number.isFinite(end)||distance<0)throw new TempoUnavailable("map-horizon-unavailable");
      horizon=Math.max(horizon,end);
    });
  }catch(error){if(error instanceof TempoUnavailable)return absent(error.reason);throw error;}
  const beat=dominantBeatLength(control.timingPoints.list,horizon),bpm=beat===null?NaN:60000/beat;
  return Number.isFinite(bpm)&&bpm>0?{ruleset:mode??0,baseBpm:bpm}:absent("invalid-map-timing");
}

export function performanceMapMd5(location:LibraryOpenLocation):string {
  const evidence=sourceMapEvidence(location);
  if(evidence.headerMd5&&evidence.sourceMd5&&evidence.headerMd5!==evidence.sourceMd5)throw new Error("Conflicting source map identity");
  const md5=evidence.headerMd5??evidence.sourceMd5;if(!md5)throw new Error("Source map identity unavailable");return md5;
}

/** P-only exact bytes: no replay open/decompression, saved cause read, asset enumeration or simulation.
 * Publication must still compare the original location/map tickets and semantic preparation key. */
export async function prepareLibraryPerformanceMap(location:LibraryOpenLocation,candidate?:LibraryOpenMap,signal?:AbortSignal,
  checkpoint:()=>Promise<void>=()=>setImmediate()):Promise<LibraryPerformanceMapResource> {
  signal?.throwIfAborted();await checkpoint();signal?.throwIfAborted();
  const md5=performanceMapMd5(location),score=location.metadata.nativeScore;
  let path:string|undefined,sha256:string|undefined,mapTicket:LibraryOpenMap|undefined;
  if(!candidate&&location.kind==="lazer"&&record(score)&&score.id===location.sourceKey&&record(score.beatmap)){
    const resource=score.beatmap;
    if(resource.md5!==md5)throw new Error("Native map identity changed");
    if(["available","unverified"].includes(String(resource.status))&&typeof resource.path==="string"&&isAbsolute(resource.path)&&
      typeof resource.sha256==="string"&&/^[a-f0-9]{64}$/.test(resource.sha256)){
      path=resource.path;sha256=resource.sha256;
    }
  }
  if(!path&&candidate){
    if(candidate.kind!=="stable"||candidate.md5!==md5||!isAbsolute(candidate.locator))throw new Error("Fallback map identity disagrees with score");
    path=candidate.locator;mapTicket=candidate;
  }
  if(!path)throw new Error("Exact map resource unavailable");
  const resource=await readVerifiedLibraryResource(path,{md5,...(sha256?{sha256}:{}),maxBytes:16*1024*1024},signal,checkpoint);
  const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(resource.bytes);
  const metadata=await mapMetadata(text,checkpoint,signal);
  await checkpoint();signal?.throwIfAborted();
  return{map:{text,sha256:resource.sha256,md5:resource.md5},metadata,location,...(mapTicket?{mapTicket}:{})};
}
