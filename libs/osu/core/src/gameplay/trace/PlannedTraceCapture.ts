import { Beatmap } from "../../beatmap/Beatmap";
import { ReplayFrame } from "../../replays/Replay";
import { GameState } from "../GameState";
import { ReplayTraceObservation, TraceCapture } from "./ReplayTrace";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { errorCapabilities } from "../error-analysis/ErrorCapabilities";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { hitWindowsForOD } from "@osujs/math";
import { stableSavedScoreCandidates } from "../../replays/SavedScoreCandidates";
import { validTraceObservation, traceUtf8Bytes } from "./ReplayTraceCollector";

export function automatedInputRetention(map:Beatmap,frames:readonly ReplayFrame[],state:GameState,profile:string):number[] | undefined {
  // Manual attribution queries neighbouring cadence and initiating chains. Until
  // that dependency closure is planned explicitly, preserve its complete stream.
  if(errorCapabilities(map,profile).tapping !== "automated" || !frames.length ||
    frames.some((f,i)=>!Number.isFinite(f.time) || (i>0 && f.time<frames[i-1].time))) return;
  const protectedIndices=new Set<number>();
  const protect=(i:number)=>{for(let j=Math.max(0,i-1);j<=Math.min(frames.length-1,i);j++)protectedIndices.add(j);};
  const bound=(time:number,strict=false)=>{
    let lo=0,hi=frames.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(strict ? frames[mid].time<=time : frames[mid].time<time)lo=mid+1;else hi=mid;}
    return lo;
  };
  const range=(start:number,end:number)=>{
    const first=Math.max(0,bound(start)-2),last=Math.min(frames.length-1,bound(end,true));
    for(let i=first;i<=last;i++)protectedIndices.add(i);
  };
  const window=(profile === "stable" ? stableHitWindowsForOD(map.stableOverallDifficulty) : hitWindowsForOD(map.difficulty.overallDifficulty,true))[2];
  for(const o of map.hitObjects) {
    if(o instanceof HitCircle){
      const v=state.hitCircleVerdict[o.id];
      if(v && v.type!=="GREAT")range(Math.min(o.spawnTime,o.hitTime-window),Math.max(o.hitTime+window,v.judgementTime));
    } else if(o instanceof Slider){
      const head=state.hitCircleVerdict[o.head.id],parent=state.sliderVerdict[o.id];
      const failed=[...o.checkPoints,...(o.stableCheckPoints ?? [])].some(p=>state.checkPointVerdict[p.id]?.hit===false) || state.sliderTailVerdict[o.id]?.hit===false;
      if((head && head.type!=="GREAT") || (parent && parent!=="GREAT") || failed)
        range(Math.min(o.head.spawnTime,o.startTime-window),Math.max(o.endTime,o.startTime+window,head?.judgementTime ?? 0,state.sliderJudgementTime[o.id] ?? 0));
    } else {
      const v=state.spinnerVerdict[o.id];
      if(v && v.type!=="GREAT")range(o.startTime,Math.max(o.endTime,v.judgementTime));
    }
  }
  for(const candidate of stableSavedScoreCandidates(map,frames)) {
    const i=bound(candidate.latestTime);
    if(frames[i]?.time === candidate.latestTime)protect(i);
  }
  protect(1);protect(frames.length-1);
  for(let i=1;i<frames.length;i++)if(frames[i].rawButtonMask!==frames[i-1].rawButtonMask ||
    frames[i].actions.length!==frames[i-1].actions.length || frames[i].actions.some(a=>!frames[i-1].actions.includes(a)))protect(i);
  return [...protectedIndices].sort((a,b)=>a-b);
}
export function retainPlannedInputs(capture:TraceCapture,indices:readonly number[]):TraceCapture {
  const planned=new Set(indices);
  type Block={index:number;keep:boolean;records:ReplayTraceObservation[];bytes:number};
  const blocks:Block[]=[];
  const reserved=new Set<string>();
  let index=0,buffered=0,bufferedBytes=0,stopped=false;
  const byteLimit=Math.min(capture.limits?.maxExportBytes ?? 64*1024*1024,8*1024*1024);
  const flush=()=>{
    const b=blocks.shift();if(!b)return;
    buffered-=b.records.length;
    bufferedBytes-=b.bytes;
    for(const r of b.records)if(r.kind!=="input" || b.keep)capture.record(r);
  };
  const finish=()=>{while(blocks.length)flush();};
  return {
    limits:capture.limits,observationVersion:capture.observationVersion,domain:capture.domain,reserveId:()=>{
      if(stopped)return "";const id=capture.reserveId();if(id)reserved.add(id);return id;
    },
    fail:reason=>{stopped=true;capture.fail(reason);},
    record(o){
      if(stopped)return;
      if(!reserved.delete(o.id) || !validTraceObservation(o,capture.observationVersion ?? 1) || buffered>=4096){stopped=true;capture.fail("planned-capture-invalid-or-buffer-limit");return;}
      if(o.kind === "input") {
        if(blocks.length>=2)flush();
        const previous=blocks[blocks.length-1]?.records[0];
        const changed=o.freshActions.length>0 || (previous?.kind === "input" && (o.rawButtonMask!==previous.rawButtonMask ||
          o.actions.length!==previous.actions.length || o.actions.some(a=>!previous.actions.includes(a)))) ||
          o.source.origin!=="parsed" || !!o.source.discontinuityBefore?.length;
        if(changed && blocks.length)blocks[blocks.length-1].keep=true;
        blocks.push({index,keep:planned.has(index++) || changed,records:[],bytes:0});
      }
      const current=blocks[blocks.length-1];
      if(!current){capture.record(o);return;}
      if(o.kind === "attempt") {
        if(current.records[0]?.id!==o.inputId){stopped=true;capture.fail("planned-capture-input-reference");return;}
        current.keep=true;if(blocks.length>1)blocks[blocks.length-2].keep=true;
      }
      const text=JSON.stringify(o),bytes=traceUtf8Bytes(text);
      if(bufferedBytes+bytes>byteLimit){stopped=true;capture.fail("planned-capture-byte-limit");return;}
      current.records.push(JSON.parse(text) as ReplayTraceObservation);buffered++;bufferedBytes+=bytes;current.bytes+=bytes;
    },
    seal(){finish();return capture.seal();},
    sealAsync(checkpoint){finish();return capture.sealAsync(checkpoint);},
    dispose(){blocks.length=0;reserved.clear();buffered=0;bufferedBytes=0;stopped=true;capture.dispose();},
  };
}
