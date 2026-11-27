import { Beatmap, BucketedGameStateTimeMachine, errorCapabilities, GameState, GameplayInfoEvaluator, HitCircle,
  LazerGameplayInfoEvaluator, LazerGameStateTimeMachine, ReplayAnalysisRuleset, Slider, Spinner,
  REPLAY_LEADING_RESET_WITNESS_VERSION, REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION, REPLAY_PARSER_VERSION } from "@osujs/core";
import { OsuAction, REPLAY_RELEASED_PREFIX_WITNESS_VERSION, REPLAY_RELEASED_PREFIX_MAX_TOKENS, REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION, REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION, REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION, stableNumericalInputBoundary } from "@osujs/core";
import { retrieveEventsAsync } from "@osujs/core";
import { modsFromBitmask, modsToBitmask, ReplayFrame, ReplayLeadingResetToken, ReplayAnalysisEvent } from "@osujs/core";
import { Vec2 } from "@osujs/math";
import { isLazerReplay, OsuReplay } from "../../model/OsuReplay";
import type { LibraryMetricResult, LibraryMetricValue } from "../../../../../shared/replay-library-metrics";
import { LIBRARY_RX_TIMING_COMPARISON_VERSION,LIBRARY_MANUAL_CLOCK_SOURCE_VERSION,LIBRARY_MANUAL_CLOCK_COMPARISON_VERSION,LIBRARY_RX_CLOCK_COMPARISON_VERSION,LIBRARY_RX_CLOCK_SOURCE_VERSION,LIBRARY_EARLY_MAP_CLOCK_VERSION,LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION } from "../../../../../shared/replay-library-metrics";
import { performanceJudgements,buildReplayPerformanceInputAsync,hasExactPerformancePrefix,ReplayPerformanceInput } from "../analysis/performance/replay-performance-input";
import {prepareManualClockPlan,ManualClockPlan,sameManualClockEvidence,manualClockSemanticDomain,
  registerManualClockPerformance,getManualClockPerformanceInput,selectNormalizedClockReplay,hasNormalizedClockSource} from "./library-manual-clock";
import { sliderMissResolutionTimes, stableSliderBreakResolutionTimes } from "../analysis/live-replay-stats";
import { PreparedScoringReplay, scoringReplayFramesAsync } from "../common/game/ReplayScoringFrames";
import { replayTimingHits, theoreticalMaxCombo } from "../common/game/ReplayNumericalFacts";
import { comboMetrics, completionMetric, LIBRARY_NUMERIC_PROJECTION_VERSION, timingMetrics } from "./library-metrics";
import type { LibraryNumericalBinding } from "../../../../../shared/library-analysis";
import { projectLibraryErrorStrip } from "./library-error-strip";
export type { LibraryNumericalBinding } from "../../../../../shared/library-analysis";
const known = <T>(value:T):LibraryMetricValue<T> => ({state:"known",value});
const unknown = <T>(reason="numerical-evidence-incomplete"):LibraryMetricValue<T> => ({state:"unknown",reason});
const basic = new Set(["GREAT","OK","MEH","MISS"]);
const RX_SUPPORTED_MASK=1|2|4|8|16|32|64|128|256|512|1024|4096|16384|(1<<29);
/** This is the finite attempt domain, not successful input certification. */
function rxAttemptEligible(replay:OsuReplay):boolean {
  return !isLazerReplay(replay)&&(replay.gameMode??0)===0&&replay.mods.includes("RELAX")&&
    !replay.mods.includes("AUTO_PLAY")&&!replay.mods.includes("AUTO_PILOT");
}

/** Compare bounded evidence cooperatively. Property insertion order is immaterial;
 * array order, missing fields and every finite number remain significant. */
async function sameRxEvidence(left:unknown,right:unknown,checkpoint:()=>Promise<void>):Promise<boolean> {
  const pending:[unknown,unknown][]=[[left,right]];let work=0;
  while(pending.length){
    if(++work>1000000)return false;if(work%256===0)await checkpoint();
    const [a,b]=pending.pop()!;
    if(typeof a==="number"&&(!Number.isFinite(a)||typeof b!=="number"||!Number.isFinite(b)))return false;
    const aVector=a!==null&&typeof a==="object"&&Object.getPrototypeOf(a)===Vec2.prototype;
    const bVector=b!==null&&typeof b==="object"&&Object.getPrototypeOf(b)===Vec2.prototype;
    if(aVector||bVector){
      // Both event arrays are generated in this worker from the same map/module.
      // Slider/checkpoint getters allocate fresh Vec2 positions. Compare only this
      // exact model value type, including before the shared-reference shortcut.
      if(!aVector||!bVector)return false;
      for(const value of [a,b] as Vec2[]){
        const keys=Reflect.ownKeys(value);
        if(keys.length!==2||!keys.includes("x")||!keys.includes("y"))return false;
      }
      for(const key of ["x","y"]){
        const left=Object.getOwnPropertyDescriptor(a,key)?.value,right=Object.getOwnPropertyDescriptor(b,key)?.value;
        if(typeof left!=="number"||typeof right!=="number"||!Number.isFinite(left)||!Number.isFinite(right)||left!==right)return false;
      }
      continue;
    }
    if(a===b&&(a===null||typeof a!=="object"))continue;
    if(a===null||b===null||typeof a!=="object"||typeof b!=="object"||Array.isArray(a)!==Array.isArray(b))return false;
    if(Array.isArray(a)&&a.length!==(b as unknown[]).length)return false;
    if(!Array.isArray(a)&&(Object.getPrototypeOf(a)!==Object.prototype||Object.getPrototypeOf(b)!==Object.prototype))return false;
    if(a===b)continue;
    const keys=Object.keys(a),other=Object.keys(b);
    if(keys.length!==other.length||keys.length>200000||pending.length+keys.length>200000)return false;
    for(let i=0;i<keys.length;i++){
      if(i%256===0)await checkpoint();const key=keys[i];
      if(!Object.prototype.hasOwnProperty.call(b,key))return false;
      pending.push([(a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]]);
    }
  }
  return true;
}

/** Reconstruct only the pinned importer's clock acceptance policy. Coordinates stay
 * double precision except its float32 sentinel test; this is not historical-client parity.
 * No retained frame, diagnostic or original state is mutated. */
async function rxClockFrames(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,
  binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>):Promise<ReplayFrame[]|undefined> {
  const d=replay.parseDiagnostics,r=d?.rxClockComparison,frames=replay.frames;
  const format=binding.verifiedMapFormatVersion,capability=errorCapabilities(map,"stable");
  if(!binding.exactMapAndProfile||typeof format!=="number"||!Number.isSafeInteger(format)||format<5||format>14||
    !d||r?.status!=="complete"||Object.keys(r).length!==8||r.version!=="stable-rx-clock-input-v1"||r.parserVersion!==REPLAY_PARSER_VERSION||
    d.parserVersion!==REPLAY_PARSER_VERSION||r.gameVersion!==replay.gameVersion||!Number.isSafeInteger(r.gameVersion)||r.gameVersion<=0||
    !Number.isInteger(r.modsBitmask)||(r.modsBitmask&~RX_SUPPORTED_MASK)!==0||(r.modsBitmask&128)===0||
    modsToBitmask(replay.mods)!==r.modsBitmask||replay.mods.length!==new Set(replay.mods).size||
    replay.mods.length!==modsFromBitmask(r.modsBitmask).length||map.appliedMods.length!==replay.mods.length||
    map.appliedMods.some(mod=>!replay.mods.includes(mod))||map.lazerMods.length||replay.lazerMods?.length||
    ((r.modsBitmask&256)!==0&&(r.modsBitmask&(64|512))!==0)||((r.modsBitmask&2)!==0&&(r.modsBitmask&16)!==0)||
    map.gameClockRate!==((r.modsBitmask&(64|512))!==0?1.5:(r.modsBitmask&256)!==0?0.75:1)||
    capability.scoring!=="supported"||capability.geometry!=="supported"||capability.tracking!=="supported"||capability.aim!=="manual"||
    !frames.length||frames.length>1000000||r.frameCount!==frames.length||d.frameSources.length!==frames.length||
    !Number.isSafeInteger(r.rawTokenCount)||r.rawTokenCount<4||r.rawTokenCount>1100000||
    !Array.isArray(r.omittedTokens)||r.omittedTokens.length>100000||d.skippedTokens.length>100000||
    map.hitObjects.length===0||map.hitObjects.length>100000||
    scoring.domain.endpointBasis!=="recorded-end"||scoring.domain.synthesizedEndpoint||scoring.frames.length!==frames.length||
    scoring.domain.endpointInputBracket!==undefined||scoring.domain.frameSources?.length!==frames.length||
    !Number.isFinite(scoring.endTime)||scoring.endTime!==frames[frames.length-1].time||scoring.domain.endTimeMs!==scoring.endTime)return;
  let components=map.hitObjects.length;
  for(let index=0;index<map.hitObjects.length;index++){
    if(index%256===0)await checkpoint();const object=map.hitObjects[index];
    if(object instanceof Slider)components+=(object.stableCheckPoints??object.checkPoints).length+2;
    if(components>200000)return;
  }
  const boundary=stableNumericalInputBoundary(map);
  await checkpoint();
  if(boundary===undefined||!Number.isFinite(boundary))return;
  const accepted:ReplayFrame[]=[],first:ReplayLeadingResetToken[]=[];
  let frameIndex=0,omissionIndex=0,skipIndex=0,time=0,lastAccepted=-Infinity,common=false,ended=false,acceptedLimit=false;
  const accept=(token:ReplayLeadingResetToken)=>{
    if(token.timeAfter<lastAccepted)return;
    if(accepted.length>=1000000){acceptedLimit=true;return;}
    if(token.rawTokenIndex===d.frameSources[0].rawTokenIndex&&token.timeAfter===frames[0].time&&
      token.x===frames[0].position.x&&token.y===frames[0].position.y&&token.timeAfter<boundary)common=true;
    lastAccepted=token.timeAfter;
    accepted.push({time:token.timeAfter,position:{x:token.x,y:token.y},actions:[],rawButtonMask:0});
  };
  for(let raw=0;raw<r.rawTokenCount;raw++){
    if(raw%256===0)await checkpoint();
    const source=d.frameSources[frameIndex],omitted=r.omittedTokens[omissionIndex],skip=d.skippedTokens[skipIndex];
    let token:ReplayLeadingResetToken;
    if(source?.rawTokenIndex===raw){
      const f=frames[frameIndex],s=scoring.frames[frameIndex],scoringSource=scoring.domain.frameSources[frameIndex];
      if(ended||source.origin!=="parsed"||source.parsedFrameIndex!==frameIndex||omitted?.rawTokenIndex===raw||skip?.rawTokenIndex===raw||
        scoringSource?.origin!=="parsed"||scoringSource.parsedFrameIndex!==frameIndex||scoringSource.rawTokenIndex!==raw||
        !f||f.rawButtonMask!==0||f.actions.length||!s||s.time!==f.time||s.position.x!==f.position.x||s.position.y!==f.position.y||
        s.rawButtonMask!==f.rawButtonMask||s.actions.length||f.sourceFramesAtSameTime!==undefined||s.sourceFramesAtSameTime!==undefined)return;
      token={rawTokenIndex:raw,delta:f.time-time,x:f.position.x,y:f.position.y,rawButtonMask:0,timeBefore:time,timeAfter:f.time};
      if(token.delta<0||raw<2&&token.x===256&&token.y===-500)return;
      frameIndex++;
    }else if(omitted?.rawTokenIndex===raw){
      token=omitted;
      if(ended||Object.keys(token).length!==7||skip?.rawTokenIndex!==raw||
        !(raw<2&&token.x===256&&token.y===-500?skip.reason==="stable-sentinel":token.delta<0&&skip.reason==="negative-delta"))return;
      omissionIndex++;skipIndex++;
    }else{
      if(skip?.rawTokenIndex!==raw||raw<3)return;
      if(skip.reason==="seed"&&!ended&&(raw===r.rawTokenCount-1||raw===r.rawTokenCount-2&&d.skippedTokens[skipIndex+1]?.reason==="empty-token"))ended=true;
      else if(skip.reason==="empty-token"&&raw===r.rawTokenCount-1)ended=true;
      else return;
      skipIndex++;continue;
    }
    if(token.rawButtonMask!==0||!Number.isInteger(token.delta)||token.delta<-2147483648||token.delta>2147483647||
      !Number.isSafeInteger(token.timeAfter)||token.timeBefore!==time||token.timeAfter!==time+token.delta||
      !Number.isFinite(token.x)||!Number.isFinite(token.y)||Math.abs(token.x)>131072||Math.abs(token.y)>131072)return;
    time=token.timeAfter;
    // A bounded complete raw prefix, including sentinel/reset endpoints, must be
    // strictly before any judgment, slider tracking or spinner activation. RX's
    // automatic attempts and holdAccepted||hasRelax tracking do not consume prior
    // button histories; the shared recorded released cursor fixes their geometry.
    if(!common&&(raw>=REPLAY_RELEASED_PREFIX_MAX_TOKENS||token.timeBefore>=boundary||token.timeAfter>=boundary))return;
    if(raw<3){
      first.push({...token});
      if(raw===2){
        if(first[1].timeAfter<first[0].timeAfter){first[1].timeAfter=first[0].timeAfter;first[0].timeAfter=0;}
        if(first[0].timeAfter>first[2].timeAfter)first[0].timeAfter=first[1].timeAfter=first[2].timeAfter;
        for(let index=0;index<3;index++){
          const entry=first[index];
          if(index<2&&Math.fround(entry.x)===256&&Math.fround(entry.y)===-500)continue;
          accept(entry);
        }
      }
    }else accept(token);
    if(acceptedLimit)return;
  }
  if(!common||frameIndex!==frames.length||omissionIndex!==r.omittedTokens.length||skipIndex!==d.skippedTokens.length||
    accepted[accepted.length-1]?.time!==scoring.endTime)return;
  return accepted;
}

async function compareRxNumerical(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,state:GameState,
  binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>):Promise<{timing:boolean;events?:ReplayAnalysisEvent[];otherEvents?:ReplayAnalysisEvent[]}> {
  const frames=await rxClockFrames(map,replay,scoring,binding,checkpoint);
  if(!frames)return {timing:false};
  const alternate=await new BucketedGameStateTimeMachine(frames,map,{hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",
    replayGameVersion:replay.gameVersion,replayTimestamp:replay.timestamp}).evaluateReplayAsync(checkpoint);
  const currentCoverage=await outcomeCoverage(map,state,"stable",scoring.endTime,replay.frames[0].time,checkpoint);
  const otherCoverage=await outcomeCoverage(map,alternate,"stable",scoring.endTime,frames[0].time,checkpoint);
  if(!currentCoverage.consistent||!otherCoverage.consistent||state.currentTime!==scoring.endTime||alternate.currentTime!==scoring.endTime)return {timing:false};
  // Includes exact ordered IDs and full circle/head results and resolution times.
  // Checkpoint/parent/spinner observations close the relevant ledger independently
  // of reduced UR, aggregate counts, or final cursor equality.
  let timing=true;
  for(const key of ["judgedObjects","hitCircleVerdict","checkPointVerdict","sliderVerdict","sliderJudgementTime","spinnerVerdict"] as const)
    if(!await sameRxEvidence(state[key],alternate[key],checkpoint)){timing=false;break;}
  const events=await retrieveEventsAsync(state,map.hitObjects,"stable",checkpoint);
  const otherEvents=await retrieveEventsAsync(alternate,map.hitObjects,"stable",checkpoint);
  return {timing,...(await sameRxEvidence(events,otherEvents,checkpoint)?{events,otherEvents}:{})};
}
interface ManualFieldComparison {
  timing:boolean;outcome:boolean;legacyTiming?:boolean;events?:ReplayAnalysisEvent[];otherEvents?:ReplayAnalysisEvent[];performanceInput?:ReplayPerformanceInput;
}
async function compareManualNumerical(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,state:GameState,
  reference:OsuReplay,checkpoint:()=>Promise<void>):Promise<ManualFieldComparison>{
  const unavailable:ManualFieldComparison={timing:false,outcome:false};
  const otherScoring=await scoringReplayFramesAsync(map,reference,checkpoint);
  if(!await sameManualClockEvidence(manualClockSemanticDomain(scoring),manualClockSemanticDomain(otherScoring),checkpoint))return unavailable;
  const alternate=otherScoring.reusableSourceState?.state??await new BucketedGameStateTimeMachine(otherScoring.frames,map,
    {hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion,replayTimestamp:replay.timestamp}).evaluateReplayAsync(checkpoint);
  const currentCoverage=await outcomeCoverage(map,state,"stable",scoring.endTime,replay.frames[0].time,checkpoint),
    otherCoverage=await outcomeCoverage(map,alternate,"stable",otherScoring.endTime,reference.frames[0].time,checkpoint);
  if(!currentCoverage.consistent||!otherCoverage.consistent||state.currentTime!==scoring.endTime||alternate.currentTime!==otherScoring.endTime)return unavailable;
  const samples=async(value:GameState)=>{const rows:unknown[]=[];
    for(let i=0;i<value.judgedObjects.length;i++){if(i%256===0)await checkpoint();const id=value.judgedObjects[i],object=map.getHitObject(id),v=value.hitCircleVerdict[id];
      if(object?.type==="HIT_CIRCLE"&&v&&v.type!=="MISS"){const time=map.getHitCircle(id).hitTime;rows.push([id,v.type,v.judgementTime,time,v.judgementTime-time,v.hitAction??null]);}}
    return rows;};
  const timing=await sameManualClockEvidence(await samples(state),await samples(alternate),checkpoint);
  let legacyTiming=true;
  for(const key of ["judgedObjects","hitCircleVerdict","checkPointVerdict","sliderVerdict","sliderJudgementTime","spinnerVerdict"] as const)
    if(legacyTiming&&!await sameRxEvidence(state[key],alternate[key],checkpoint))legacyTiming=false;
  let outcome=await sameManualClockEvidence(currentCoverage,otherCoverage,checkpoint);
  for(const key of ["judgedObjects","hitCircleVerdict","checkPointVerdict","sliderTailVerdict","sliderVerdict","sliderJudgementTime","spinnerVerdict"] as const)
    if(outcome&&!await sameManualClockEvidence(state[key],alternate[key],checkpoint))outcome=false;
  const ledger=performanceJudgements(map,state,"stable"),otherLedger=performanceJudgements(map,alternate,"stable");
  outcome=outcome&&await sameManualClockEvidence(ledger,otherLedger,checkpoint);
  const events=await retrieveEventsAsync(state,map.hitObjects,"stable",checkpoint),otherEvents=await retrieveEventsAsync(alternate,map.hitObjects,"stable",checkpoint);
  const sameEvents=await sameManualClockEvidence(events,otherEvents,checkpoint);
  // Event-only break resolution is part of outcome dependency, not inferred from
  // matching final counts. Timing can remain independently proven when this differs.
  outcome=outcome&&sameEvents;
  const input=await buildReplayPerformanceInputAsync({beatmap:map,replay,state,mode:"stable",finalReplayTime:scoring.endTime,stateIsScoringBounded:true},checkpoint),
    other=await buildReplayPerformanceInputAsync({beatmap:map,replay:reference,state:alternate,mode:"stable",finalReplayTime:otherScoring.endTime,stateIsScoringBounded:true},checkpoint);
  let performance=input.states.length<=100001&&input.states.some(s=>s.passedObjects>0)&&hasExactPerformancePrefix(input)&&
    await sameManualClockEvidence(input,other,checkpoint);
  const pending:unknown[]=[input];let work=0;
  while(performance&&pending.length){if(++work>1000000){performance=false;break;}if(work%256===0)await checkpoint();const value=pending.pop();
    if(typeof value==="number"&&!Number.isFinite(value))performance=false;else if(value&&typeof value==="object"){
      const values=Object.values(value);if(pending.length+values.length>200000){performance=false;break;}pending.push(...values);}}
  return{timing,outcome,legacyTiming,...(sameEvents?{events,otherEvents}:{}),...(performance?{performanceInput:input}:{})};
}
function validateBinding(replay:OsuReplay,binding:LibraryNumericalBinding) {
  if(!/^[0-9a-f]{64}$/.test(binding.replaySha256)||!/^[0-9a-f]{64}$/.test(binding.mapSha256)||!/^[0-9a-f]{32}$/.test(binding.mapMd5)||
    replay.beatmapMd5.toLowerCase()!==binding.mapMd5||
    (replay.replayContentSha256!==undefined&&replay.replayContentSha256.toLowerCase()!==binding.replaySha256))
    throw new Error("Numerical replay/map binding is invalid or contradictory");
}

/** SO changes spinner resolution, not manual tapping/aim. Its existing evaluator
 * starts that resolution only at spinner activation, which both prefix proofs
 * below keep strictly after the discarded domain. No spinner score is inferred. */
function supportedStablePrefixInput(map:Beatmap):boolean {
  const capability=errorCapabilities(map,"stable");
  return capability.scoring==="supported"&&capability.geometry==="supported"&&capability.tracking==="supported"&&
    capability.tapping==="manual"&&capability.aim==="manual"&&
    (capability.spinner==="manual"||map.appliedMods.includes("SPUN_OUT"));
}

/** Parser provenance is trusted only through the existing exact-source preparation boundary.
 * Check its fixed-size witness independently; it never clears warnings or attests outcomes. */
function neutralLeadingReset(map:Beatmap,replay:OsuReplay,firstOpportunity:number):boolean {
  const diagnostics=replay.parseDiagnostics,witness=diagnostics?.leadingResetWitness,first=replay.frames[0];
  if(!diagnostics||!witness||isLazerReplay(replay)||(replay.gameMode??0)!==0||!first||!Number.isFinite(firstOpportunity)||
    diagnostics.initialActionsKnown!==false||diagnostics.sourceCoverageLimits.length!==2||diagnostics.sourceCoverageLimits[0]!=="initial-actions-unknown"||diagnostics.sourceCoverageLimits[1]!=="parser-negative-delta"||
    diagnostics.parserVersion!==REPLAY_PARSER_VERSION||witness.parserVersion!==REPLAY_PARSER_VERSION||witness.version!==REPLAY_LEADING_RESET_WITNESS_VERSION||
    Object.keys(witness).length!==5||!Array.isArray(witness.tokens)||witness.tokens.length!==4||witness.frameCount!==replay.frames.length||
    !Number.isSafeInteger(witness.rawTokenCount)||witness.rawTokenCount<4||diagnostics.frameSources.length!==replay.frames.length)return false;
  if(!supportedStablePrefixInput(map))return false;
  let time=0;
  for(let index=0;index<4;index++){
    const token=witness.tokens[index];
    if(!token||Object.keys(token).length!==7||token.rawTokenIndex!==index||token.rawButtonMask!==0||
      ![token.delta,token.x,token.y,token.timeBefore,token.timeAfter].every(Number.isFinite)||token.timeBefore!==time||
      token.timeAfter!==time+token.delta||
      Math.abs(token.x)>131072||Math.abs(token.y)>131072)return false;
    time=token.timeAfter;
  }
  const [a,b,reset,retained]=witness.tokens;
  // Stable's exact 0/-1 offscreen startup pair anchors the clock; it is not
  // gameplay at time zero. Its reset destination and retained interval must
  // still precede activation, including maps whose spawn time is negative.
  const startupAnchor=a.delta===0&&b.delta===-1;
  if(startupAnchor
    ?reset.timeAfter>=firstOpportunity||retained.timeBefore>=firstOpportunity||retained.timeAfter>=firstOpportunity
    :witness.tokens.some(token=>token.timeBefore>=firstOpportunity||token.timeAfter>=firstOpportunity))return false;
  // Released movement/delay before activation converges to the retained frame. The
  // complete prefix envelope above must precede every scoring opportunity.
  if(a.x!==256||a.y!==-500||b.x!==256||b.y!==-500||reset.delta>=0||retained.delta<0||
    first.time!==retained.timeAfter||first.position.x!==retained.x||first.position.y!==retained.y||
    first.rawButtonMask!==0||first.actions.length!==0||first.time>=firstOpportunity)return false;
  const skipped=diagnostics.skippedTokens;
  if(skipped.length<3||skipped.length>5||skipped[0].rawTokenIndex!==0||skipped[0].reason!=="stable-sentinel"||
    skipped[1].rawTokenIndex!==1||skipped[1].reason!=="stable-sentinel"||skipped[2].rawTokenIndex!==2||skipped[2].reason!=="negative-delta")return false;
  let next=replay.frames.length+3,index=3;
  if(skipped[index]?.reason==="seed"&&skipped[index].rawTokenIndex===next){next++;index++;}
  if(skipped[index]?.reason==="empty-token"&&skipped[index].rawTokenIndex===next){next++;index++;}
  return index===skipped.length&&next===witness.rawTokenCount;
}

/** Only a released initial timestamp is omitted; the retained input converges before any activation. */
function neutralInitialNegative(map:Beatmap,replay:OsuReplay,firstOpportunity:number):boolean {
  const diagnostics=replay.parseDiagnostics,witness=diagnostics?.initialNegativeWitness,first=replay.frames[0];
  if(!diagnostics||!witness||!isLazerReplay(replay)||(replay.gameMode??0)!==0||!Array.isArray(replay.lazerMods)||
    replay.lazerMods.some(mod=>mod.acronym==="CL")||map.lazerModSettings.classic||!first||!Number.isFinite(firstOpportunity)||
    diagnostics.initialActionsKnown!==false||diagnostics.sourceCoverageLimits.length!==2||diagnostics.sourceCoverageLimits[0]!=="initial-actions-unknown"||diagnostics.sourceCoverageLimits[1]!=="parser-negative-delta"||
    diagnostics.parserVersion!==REPLAY_PARSER_VERSION||witness.parserVersion!==REPLAY_PARSER_VERSION||witness.version!==REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION||
    Object.keys(witness).length!==5||!Array.isArray(witness.tokens)||witness.tokens.length!==2||witness.frameCount!==replay.frames.length||
    !Number.isSafeInteger(witness.rawTokenCount)||witness.rawTokenCount<2||diagnostics.frameSources.length!==replay.frames.length)return false;
  const capability=errorCapabilities(map,"lazer");
  if(capability.scoring!=="supported"||capability.geometry!=="supported"||capability.tracking!=="supported"||
    capability.tapping!=="manual"||capability.aim!=="manual"||capability.spinner!=="manual")return false;
  let time=0;
  // The initial accumulator zero is not a recorded input. Its released timestamp
  // destination and every retained interval must still precede activation.
  for(let index=0;index<2;index++){
    const token=witness.tokens[index];
    if(!token||Object.keys(token).length!==7||token.rawTokenIndex!==index||token.rawButtonMask!==0||
      ![token.delta,token.x,token.y,token.timeBefore,token.timeAfter].every(Number.isFinite)||token.timeBefore!==time||
      token.timeAfter!==time+token.delta||(index>0&&token.timeBefore>=firstOpportunity)||token.timeAfter>=firstOpportunity||
      Math.abs(token.x)>131072||Math.abs(token.y)>131072)return false;
    time=token.timeAfter;
  }
  const [initial,retained]=witness.tokens;
  if(initial.delta>=0||retained.delta<=0||first.time!==retained.timeAfter||first.position.x!==retained.x||first.position.y!==retained.y||
    first.rawButtonMask!==0||first.actions.length!==0||first.time>=firstOpportunity)return false;
  const skipped=diagnostics.skippedTokens;
  if(skipped.length<1||skipped.length>3||skipped[0].rawTokenIndex!==0||skipped[0].reason!=="negative-delta")return false;
  let next=replay.frames.length+1,index=1;
  if(skipped[index]?.reason==="seed"&&skipped[index].rawTokenIndex===next){next++;index++;}
  if(skipped[index]?.reason==="empty-token"&&skipped[index].rawTokenIndex===next){next++;index++;}
  return index===skipped.length&&next===witness.rawTokenCount;
}

/** A successful fresh traversal is necessary but not sufficient for whole-play evidence. */
async function legacySourceCoverage(map:Beatmap,replay:OsuReplay,checkpoint:()=>Promise<void>):Promise<boolean> {
  const diagnostics=replay.parseDiagnostics;
  if (!diagnostics || !replay.frames.length || diagnostics.frameSources.length!==replay.frames.length) return false;
  let firstOpportunity=Infinity;
  for(let index=0;index<map.hitObjects.length;index++) {
    if(index%256===0) await checkpoint();
    const object=map.hitObjects[index];
    firstOpportunity=Math.min(firstOpportunity,object instanceof Spinner?object.startTime:object.spawnTime);
  }
  const resetOffset=neutralLeadingReset(map,replay,firstOpportunity)?3:neutralInitialNegative(map,replay,firstOpportunity)?1:0,reset=resetOffset!==0;
  if(diagnostics.sourceCoverageLimits.some(limit=>limit!=="initial-actions-unknown"&&!(reset&&limit==="parser-negative-delta")))return false;
  let prior=-Infinity,token=-1;
  for(let index=0;index<replay.frames.length;index++){
    if(index%256===0)await checkpoint();const frame=replay.frames[index],source=diagnostics.frameSources[index];
    if(!Number.isFinite(frame.time)||frame.time<prior||source.origin!=="parsed"||source.parsedFrameIndex!==index||
      !Number.isSafeInteger(source.rawTokenIndex)||source.rawTokenIndex===undefined||source.rawTokenIndex<=token||(reset&&source.rawTokenIndex!==index+resetOffset)||
      source.discontinuityBefore?.length&&!(reset&&index===0&&source.discontinuityBefore.length===1&&source.discontinuityBefore[0]==="parser-negative-delta"))return false;
    if(reset&&index===0&&(!source.discontinuityBefore||source.discontinuityBefore.length!==1||source.discontinuityBefore[0]!=="parser-negative-delta"))return false;
    prior=frame.time;token=source.rawTokenIndex;
  }
  // Unknown pre-recording actions cannot fabricate a first press inside an active object.
  return Number.isFinite(firstOpportunity)&&replay.frames[0].time<firstOpportunity;
}

/** Additive admission only: the original v6 path is evaluated first and remains unchanged. */
async function releasedPrefixCoverage(map:Beatmap,replay:OsuReplay,checkpoint:()=>Promise<void>):Promise<boolean> {
  const d=replay.parseDiagnostics,w=d?.releasedPrefixWitness;
  if(!d||!w||d.leadingResetWitness||d.initialNegativeWitness||isLazerReplay(replay)||(replay.gameMode??0)!==0||
    d.parserVersion!==REPLAY_PARSER_VERSION||w.parserVersion!==REPLAY_PARSER_VERSION||w.version!==REPLAY_RELEASED_PREFIX_WITNESS_VERSION||
    Object.keys(w).length!==6||d.initialActionsKnown!==false||d.sourceCoverageLimits.length!==2||
    d.sourceCoverageLimits[0]!=="initial-actions-unknown"||d.sourceCoverageLimits[1]!=="parser-negative-delta"||
    !Array.isArray(w.tokens)||w.tokens.length<4||w.tokens.length>REPLAY_RELEASED_PREFIX_MAX_TOKENS||
    !Number.isSafeInteger(w.releaseFrameIndex)||w.releaseFrameIndex<0||w.releaseFrameIndex>=replay.frames.length||
    w.frameCount!==replay.frames.length||d.frameSources.length!==replay.frames.length||
    !Number.isSafeInteger(w.rawTokenCount)||w.rawTokenCount<w.tokens.length)return false;
  if(!supportedStablePrefixInput(map))return false;
  await checkpoint();const boundary=stableNumericalInputBoundary(map);
  if(boundary===undefined)return false;
  const released=replay.frames[w.releaseFrameIndex];
  if(!Number.isFinite(released.time)||released.time>=boundary||released.rawButtonMask!==0||released.actions.length!==0)return false;
  let time=0,frameIndex=0,skippedIndex=0,reset=false,held=false,pendingReset=false;
  for(let i=0;i<w.tokens.length;i++){
    const t=w.tokens[i];
    if(!t||Object.keys(t).length!==7||t.rawTokenIndex!==i||
      ![t.delta,t.x,t.y,t.timeBefore,t.timeAfter].every(Number.isFinite)||t.timeBefore!==time||t.timeAfter!==time+t.delta||
      t.timeBefore>=boundary||t.timeAfter>=boundary||Math.abs(t.x)>131072||Math.abs(t.y)>131072||
      !Number.isSafeInteger(t.rawButtonMask)||t.rawButtonMask<0||t.rawButtonMask>31)return false;
    time=t.timeAfter;
    if(i<2||t.delta<0){
      const reason=i<2?"stable-sentinel":"negative-delta",skip=d.skippedTokens[skippedIndex++];
      if(!skip||skip.rawTokenIndex!==i||skip.reason!==reason)return false;
      if(i<2){if(t.x!==256||t.y!==-500||t.rawButtonMask!==0||i===0&&t.delta!==0)return false;}
      else {reset=true;pendingReset=true;}
      continue;
    }
    const f=replay.frames[frameIndex],s=d.frameSources[frameIndex];
    const actions=[...(t.rawButtonMask&5?[OsuAction.leftButton]:[]),...(t.rawButtonMask&10?[OsuAction.rightButton]:[])];
    if(!f||!s||s.origin!=="parsed"||s.parsedFrameIndex!==frameIndex||s.rawTokenIndex!==i||
      JSON.stringify(s.discontinuityBefore??[])!==JSON.stringify(pendingReset?["parser-negative-delta"]:[])||
      f.time!==t.timeAfter||f.time>released.time||f.position.x!==t.x||f.position.y!==t.y||f.rawButtonMask!==t.rawButtonMask||
      JSON.stringify(f.actions)!==JSON.stringify(actions))return false;
    pendingReset=false;held||=reset&&actions.length>0;frameIndex++;
  }
  if(!reset||!held||pendingReset||frameIndex!==w.releaseFrameIndex+1||w.tokens[w.tokens.length-1].rawButtonMask!==0||
    d.frameSources[w.releaseFrameIndex].rawTokenIndex!==w.tokens.length-1)return false;
  let prior=released.time,raw=w.tokens.length;
  for(let i=w.releaseFrameIndex+1;i<replay.frames.length;i++){
    if(i%256===0)await checkpoint();const f=replay.frames[i],s=d.frameSources[i];
    if(!Number.isFinite(f.time)||f.time<prior||s.origin!=="parsed"||s.parsedFrameIndex!==i||s.rawTokenIndex!==raw||s.discontinuityBefore?.length)return false;
    prior=f.time;raw++;
  }
  if(d.skippedTokens[skippedIndex]?.reason==="seed"&&d.skippedTokens[skippedIndex]?.rawTokenIndex===raw){skippedIndex++;raw++;}
  if(d.skippedTokens[skippedIndex]?.reason==="empty-token"&&d.skippedTokens[skippedIndex]?.rawTokenIndex===raw){skippedIndex++;raw++;}
  return skippedIndex===d.skippedTokens.length&&raw===w.rawTokenCount;
}
/** A single initial negative timestamp is an origin, not a recorded input at
 * accumulator zero. Only its actual destination and retained prefix must precede
 * activation. The original native released-first path remains unchanged. */
async function initialNegativeCoverage(map:Beatmap,replay:OsuReplay,checkpoint:()=>Promise<void>):Promise<string|undefined> {
  const native=isLazerReplay(replay),d=replay.parseDiagnostics,w=native?d?.initialHeldPrefixWitness:d?.initialNegativeWitness;
  if(!d||!w||(replay.gameMode??0)!==0||d.leadingResetWitness||d.releasedPrefixWitness||d.neutralPrefixWitness||
    (native?!!d.initialNegativeWitness:!!d.initialHeldPrefixWitness)||d.parserVersion!==REPLAY_PARSER_VERSION||w.parserVersion!==REPLAY_PARSER_VERSION||
    w.version!==(native?REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION:REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION)||
    Object.keys(w).length!==(native?6:5)||d.initialActionsKnown!==false||d.sourceCoverageLimits.length!==2||
    d.sourceCoverageLimits[0]!=="initial-actions-unknown"||d.sourceCoverageLimits[1]!=="parser-negative-delta"||
    !Array.isArray(w.tokens)||w.tokens.length<(native?3:2)||w.tokens.length>REPLAY_RELEASED_PREFIX_MAX_TOKENS||(!native&&w.tokens.length!==2)||
    w.frameCount!==replay.frames.length||d.frameSources.length!==replay.frames.length||!Number.isSafeInteger(w.rawTokenCount)||w.rawTokenCount<w.tokens.length)return;
  const capability=errorCapabilities(map,native?"lazer":"stable");
  if(capability.scoring!=="supported"||capability.geometry!=="supported"||capability.tracking!=="supported")return;
  if(native){
    if(!Array.isArray(replay.lazerMods)||replay.lazerMods.some(mod=>mod.acronym==="CL")||map.lazerModSettings.classic||
      capability.tapping!=="manual"||capability.aim!=="manual"||capability.spinner!=="manual")return;
  }else{
    // AT's recorded cursor/actions use the existing evaluator. No ideal inputs are generated.
    const hasAutoPlay=map.appliedMods.includes("AUTO_PLAY")||replay.mods.includes("AUTO_PLAY");
    const supportedAutoPlay=map.appliedMods.includes("AUTO_PLAY")&&replay.mods.includes("AUTO_PLAY")&&
      map.appliedMods.length===replay.mods.length&&replay.mods.every(mod=>map.appliedMods.includes(mod));
    if(hasAutoPlay?!supportedAutoPlay:!supportedStablePrefixInput(map))return;
    if([...map.appliedMods,...replay.mods].some(mod=>mod==="RELAX"||mod==="AUTO_PILOT")||
      map.lazerMods.some(mod=>mod.acronym==="RX"||mod.acronym==="AP"))return;
  }
  let boundary=Infinity;
  for(let i=0;i<map.hitObjects.length;i++){
    if(i%256===0)await checkpoint();const object=map.hitObjects[i];
    boundary=Math.min(boundary,object instanceof Spinner?object.startTime:object.spawnTime);
  }
  if(!Number.isFinite(boundary))return;
  const releaseIndex=native?d.initialHeldPrefixWitness?.releaseFrameIndex:0;
  if(releaseIndex===undefined||!Number.isSafeInteger(releaseIndex)||releaseIndex!==w.tokens.length-2||releaseIndex>=replay.frames.length)return;
  const release=replay.frames[releaseIndex];
  if(!release||release.rawButtonMask!==0||release.actions.length!==0||!Number.isFinite(release.time)||release.time>=boundary)return;
  let time=0;
  for(let i=0;i<w.tokens.length;i++){
    const t=w.tokens[i];
    if(!t||Object.keys(t).length!==7||t.rawTokenIndex!==i||![t.delta,t.x,t.y,t.timeBefore,t.timeAfter].every(Number.isFinite)||
      t.timeBefore!==time||t.timeAfter!==time+t.delta||(i>0&&t.timeBefore>=boundary)||t.timeAfter>=boundary||
      Math.abs(t.x)>131072||Math.abs(t.y)>131072||!Number.isSafeInteger(t.rawButtonMask)||t.rawButtonMask<0||t.rawButtonMask>31)return;
    time=t.timeAfter;
    if(i===0){if(t.delta>=0||t.rawButtonMask!==0)return;continue;}
    if(t.delta<0||(!native&&t.delta<=0)||native&&i===1&&(t.rawButtonMask&15)===0||i<w.tokens.length-1&&t.rawButtonMask===0)return;
    const f=replay.frames[i-1],source=d.frameSources[i-1],actions=[...(t.rawButtonMask&5?[OsuAction.leftButton]:[]),...(t.rawButtonMask&10?[OsuAction.rightButton]:[])];
    if(!f||!source||source.origin!=="parsed"||source.parsedFrameIndex!==i-1||source.rawTokenIndex!==i||
      JSON.stringify(source.discontinuityBefore??[])!==JSON.stringify(i===1?["parser-negative-delta"]:[])||
      f.time!==t.timeAfter||f.position.x!==t.x||f.position.y!==t.y||f.rawButtonMask!==t.rawButtonMask||JSON.stringify(f.actions)!==JSON.stringify(actions))return;
  }
  if(w.tokens[w.tokens.length-1].rawButtonMask!==0)return;
  let prior=release.time,raw=w.tokens.length;
  for(let i=releaseIndex+1;i<replay.frames.length;i++){
    if(i%256===0)await checkpoint();const f=replay.frames[i],source=d.frameSources[i];
    if(!f||!source||!Number.isFinite(f.time)||f.time<prior||source.origin!=="parsed"||source.parsedFrameIndex!==i||source.rawTokenIndex!==raw||source.discontinuityBefore?.length)return;
    prior=f.time;raw++;
  }
  const skipped=d.skippedTokens;let index=1;
  if(skipped[0]?.rawTokenIndex!==0||skipped[0]?.reason!=="negative-delta")return;
  if(skipped[index]?.reason==="seed"&&skipped[index]?.rawTokenIndex===raw){index++;raw++;}
  if(skipped[index]?.reason==="empty-token"&&skipped[index]?.rawTokenIndex===raw){index++;raw++;}
  if(index!==skipped.length||raw!==w.rawTokenCount)return;
  return native?REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION:"stable-initial-negative-v1";
}
async function sourceCoverage(map:Beatmap,replay:OsuReplay,checkpoint:()=>Promise<void>,evidence?:(value:string)=>void):Promise<boolean> {
  if(await legacySourceCoverage(map,replay,checkpoint)){evidence?.("source-domain-coverage-v1");return true;}
  if(await releasedPrefixCoverage(map,replay,checkpoint)){evidence?.(REPLAY_RELEASED_PREFIX_WITNESS_VERSION);return true;}
  if(await neutralPrefixCoverage(map,replay,checkpoint)){evidence?.(replay.parseDiagnostics?.neutralPrefixWitness?.version??REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION);return true;}
  const initial=await initialNegativeCoverage(map,replay,checkpoint);if(initial){evidence?.(initial);return true;}
  return false;
}

/** All uncertainty is released input before any numerical effect. The first
 * fresh press then shifts a known zero into Stable's previous-button register,
 * making slider tracking independent of earlier distinct-button history. */
async function neutralPrefixCoverage(map:Beatmap,replay:OsuReplay,checkpoint:()=>Promise<void>):Promise<boolean> {
  const d=replay.parseDiagnostics,w=d?.neutralPrefixWitness,later=w?.version===REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION;
  if(!d||!w||d.leadingResetWitness||d.initialNegativeWitness||isLazerReplay(replay)||(replay.gameMode??0)!==0||
    d.parserVersion!==REPLAY_PARSER_VERSION||w.parserVersion!==REPLAY_PARSER_VERSION||(!later&&w.version!==REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION)||
    Object.keys(w).length!==6||d.initialActionsKnown!==false||d.sourceCoverageLimits.length!==2||
    d.sourceCoverageLimits[0]!=="initial-actions-unknown"||d.sourceCoverageLimits[1]!=="parser-negative-delta"||
    !Array.isArray(w.tokens)||w.tokens.length<5||w.tokens.length>REPLAY_RELEASED_PREFIX_MAX_TOKENS||
    !Number.isSafeInteger(w.releaseFrameIndex)||w.releaseFrameIndex<0||w.releaseFrameIndex>=replay.frames.length||
    w.frameCount!==replay.frames.length||d.frameSources.length!==replay.frames.length||
    !Number.isSafeInteger(w.rawTokenCount)||w.rawTokenCount<w.tokens.length||!supportedStablePrefixInput(map))return false;
  await checkpoint();const boundary=stableNumericalInputBoundary(map);
  if(boundary===undefined)return false;
  let time=0,prior=-Infinity,frameIndex=0,skippedIndex=0,resets=0,pendingReset=false,retainedBeforeReset=false,reversed=false;
  for(let i=0;i<w.tokens.length;i++){
    const t=w.tokens[i];
    if(!t||Object.keys(t).length!==7||t.rawTokenIndex!==i||t.rawButtonMask!==0||
      ![t.delta,t.x,t.y,t.timeBefore,t.timeAfter].every(Number.isFinite)||t.timeBefore!==time||t.timeAfter!==time+t.delta||
      t.timeBefore>=boundary||t.timeAfter>=boundary||Math.abs(t.x)>131072||Math.abs(t.y)>131072)return false;
    time=t.timeAfter;
    if(i<2||t.delta<0){
      const reason=i<2?"stable-sentinel":"negative-delta",skip=d.skippedTokens[skippedIndex++];
      if(!skip||skip.rawTokenIndex!==i||skip.reason!==reason)return false;
      if(i<2){if(t.x!==256||t.y!==-500||i===0&&t.delta!==0)return false;}
      else {if(resets===0)retainedBeforeReset=frameIndex>0;resets++;pendingReset=true;}
      continue;
    }
    const f=replay.frames[frameIndex],s=d.frameSources[frameIndex];
    if(!f||!s||s.origin!=="parsed"||s.parsedFrameIndex!==frameIndex||s.rawTokenIndex!==i||
      JSON.stringify(s.discontinuityBefore??[])!==JSON.stringify(pendingReset?["parser-negative-delta"]:[])||
      f.time!==t.timeAfter||(f.time<prior&&!pendingReset)||f.position.x!==t.x||f.position.y!==t.y||f.rawButtonMask!==0||f.actions.length!==0)return false;
    reversed||=f.time<prior;
    prior=f.time;pendingReset=false;frameIndex++;
  }
  // Only the newly admitted reversing prefix requires exact integral clock sums.
  // Every endpoint above is still strictly before the first numerical effect.
  if(reversed&&w.tokens.some(t=>![t.delta,t.timeBefore,t.timeAfter].every(Number.isSafeInteger)))return false;
  if((later?resets!==1||!retainedBeforeReset:resets<2)||pendingReset||frameIndex!==w.releaseFrameIndex+1||d.frameSources[w.releaseFrameIndex].rawTokenIndex!==w.tokens.length-1)return false;
  let raw=w.tokens.length;
  for(let i=w.releaseFrameIndex+1;i<replay.frames.length;i++){
    if(i%256===0)await checkpoint();const f=replay.frames[i],s=d.frameSources[i];
    if(!Number.isFinite(f.time)||f.time<prior||s.origin!=="parsed"||s.parsedFrameIndex!==i||s.rawTokenIndex!==raw||s.discontinuityBefore?.length)return false;
    prior=f.time;raw++;
  }
  if(d.skippedTokens[skippedIndex]?.reason==="seed"&&d.skippedTokens[skippedIndex]?.rawTokenIndex===raw){skippedIndex++;raw++;}
  if(d.skippedTokens[skippedIndex]?.reason==="empty-token"&&d.skippedTokens[skippedIndex]?.rawTokenIndex===raw){skippedIndex++;raw++;}
  return skippedIndex===d.skippedTokens.length&&raw===w.rawTokenCount;
}

async function outcomeCoverage(map:Beatmap,state:GameState,profile:ReplayAnalysisRuleset,end:number,begin:number,
  checkpoint:()=>Promise<void>) {
  const ledger=new Map<string,number>();
  for(let index=0;index<state.judgedObjects.length;index++) {
    if(index%256===0) await checkpoint(); const id=state.judgedObjects[index]; ledger.set(id,(ledger.get(id)??0)+1);
  }
  const native=new Map<string,typeof state.lazerJudgements>();
  for(let index=0;index<state.lazerJudgements.length;index++) {
    if(index%256===0) await checkpoint(); const j=state.lazerJudgements[index],key=`${j.kind}:${j.hitObjectId}`;
    const entries=native.get(key)??[]; entries.push(j); native.set(key,entries);
  }
  let full=true,breaks=true,parents=0,terminal=true,observedConsistent=true;
  const expectedStable=new Set<string>(), expectedNative=new Set<string>();
  const at=(time:unknown):time is number => typeof time==="number"&&Number.isFinite(time)&&time>=begin&&time<=end;
  const once=(id:string)=>ledger.get(id)===1;
  const stable=(id:string,valid:boolean,reset:boolean,observed:boolean)=> {
    expectedStable.add(id); const ok=once(id)&&valid; full&&=ok; if(reset)breaks&&=ok;
    if(observed||ledger.has(id))observedConsistent&&=ok;return ok;
  };
  const lazer=(kind:string,id:string,result:string|undefined,valid:boolean,reset:boolean,observed:boolean)=> {
    const key=`${kind}:${id}`; expectedNative.add(key); const rows=native.get(key);
    const ok=valid&&rows?.length===1&&rows[0].result===result&&at(rows[0].judgementTime);
    full&&=!!ok; if(reset)breaks&&=!!ok;
    if(observed||rows?.length||ledger.has(id))observedConsistent&&=!!ok;return !!ok;
  };
  const circle=(object:HitCircle)=> {
    const verdict=state.hitCircleVerdict[object.id],valid=!!verdict&&basic.has(verdict.type)&&at(verdict.judgementTime);
    if(profile==="stable")return stable(object.id,valid,true,verdict!==undefined);
    const result=object.sliderId!==undefined&&map.lazerModSettings.classic?.noSliderHeadAccuracy
      ? verdict?.type==="MISS"?"LARGE_TICK_MISS":"LARGE_TICK_HIT":verdict?.type;
    return lazer(object.sliderId===undefined?"CIRCLE":"SLIDER_HEAD",object.id,result,valid&&once(object.id),true,verdict!==undefined);
  };
  for(let index=0;index<map.hitObjects.length;index++) {
    if(index%256===0)await checkpoint(); const object=map.hitObjects[index]; let parent=false;
    if(object instanceof HitCircle)parent=circle(object);
    else if(object instanceof Spinner) {
      const verdict=state.spinnerVerdict[object.id],valid=!!verdict&&basic.has(verdict.type)&&at(verdict.judgementTime);
      parent=profile==="stable"?stable(object.id,valid,true,verdict!==undefined):lazer("SPINNER",object.id,verdict?.type,valid&&once(object.id),true,verdict!==undefined);
    } else {
      const slider=object as Slider; circle(slider.head);
      const checkpoints=profile==="stable"?slider.stableCheckPoints??slider.checkPoints:slider.checkPoints.filter(p=>p.type!=="LAST_LEGACY_TICK");
      for(let part=0;part<checkpoints.length;part++) {
        if(part%256===0)await checkpoint(); const point=checkpoints[part],verdict=state.checkPointVerdict[point.id];
        const valid=!!verdict&&typeof verdict.hit==="boolean"&&at(verdict.judgementTime);
        if(profile==="stable")stable(point.id,valid,point.type!=="LAST_LEGACY_TICK",verdict!==undefined);
        else lazer(point.type==="REPEAT"?"SLIDER_REPEAT":"SLIDER_TICK",point.id,verdict?.hit?"LARGE_TICK_HIT":"LARGE_TICK_MISS",valid&&once(point.id),true,verdict!==undefined);
      }
      const verdict=state.sliderVerdict[slider.id];
      if(profile==="stable")parent=stable(slider.id,basic.has(verdict)&&at(state.sliderJudgementTime[slider.id]),false,verdict!==undefined);
      else {
        const tail=state.sliderTailVerdict[slider.id],classic=map.lazerModSettings.classic?.noSliderHeadAccuracy===true;
        const tailValid=lazer("SLIDER_TAIL",slider.id,classic?(tail?.hit?"SMALL_TICK_HIT":"SMALL_TICK_MISS"):(tail?.hit?"SLIDER_TAIL_HIT":"IGNORE_MISS"),
          !!tail&&typeof tail.hit==="boolean"&&at(tail.judgementTime),false,tail!==undefined);
        parent=basic.has(verdict)&&once(slider.id)&&tailValid;
        if(classic)parent=lazer("SLIDER",slider.id,verdict,parent,true,verdict!==undefined)&&parent;
        if(verdict!==undefined||ledger.has(slider.id))observedConsistent&&=parent;
        full&&=parent;
      }
    }
    if(parent)parents++; else terminal=false;
  }
  const consistent=profile==="stable"
    ? [...ledger].every(([id,count])=>count===1&&expectedStable.has(id))
    : [...native].every(([key,rows])=>rows.length===1&&expectedNative.has(key));
  return {full:full&&consistent,breaks:breaks&&consistent,parents,terminal:terminal&&consistent,consistent:consistent&&observedConsistent};
}

/** Scalar projection only. No classifier, trace capture, viewer state or persistent cause data. */
export async function projectLibraryNumerical(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,state:GameState,
  binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>,workerManual=false):Promise<LibraryMetricResult> {
  await checkpoint();
  validateBinding(replay,binding);
  const profile:ReplayAnalysisRuleset=isLazerReplay(replay)?"lazer":"stable";
  const normalized=workerManual&&await hasNormalizedClockSource(map,replay,scoring,binding,checkpoint);
  // A background target requiring a normalized source cannot publish facts from
  // the unselected fallback. Keep the ordinary untagged input contract intact.
  const normalizationVersion=normalized?(binding.clockNormalizationVersion??LIBRARY_EARLY_MAP_CLOCK_VERSION):undefined;
  const normalizationUnavailable=(binding.clockNormalizationVersion===LIBRARY_EARLY_MAP_CLOCK_VERSION||
    binding.clockNormalizationVersion===LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION)&&!normalized;
  let sourceEvidence:string|undefined;
  let qualified=!normalizationUnavailable&&(replay.gameMode??0)===0&&binding.exactMapAndProfile&&errorCapabilities(map,profile).scoring==="supported"&&
    await sourceCoverage(map,replay,checkpoint,value=>{sourceEvidence=value;});
  if(normalized){qualified=true;sourceEvidence=normalizationVersion;}
  let manualPlan:ManualClockPlan|undefined;
  if(!normalizationUnavailable&&!qualified&&workerManual){manualPlan=await prepareManualClockPlan(map,replay,scoring,binding,checkpoint);
    if(manualPlan?.sourceEquivalent){qualified=true;sourceEvidence=manualPlan.family==="relax"?LIBRARY_RX_CLOCK_SOURCE_VERSION:LIBRARY_MANUAL_CLOCK_SOURCE_VERSION;}}
  const coverage=await outcomeCoverage(map,state,profile,scoring.endTime,replay.frames[0]?.time??0,checkpoint);
  let manual=manualPlan&&!manualPlan.sourceEquivalent?await compareManualNumerical(map,replay,scoring,state,manualPlan.reference,checkpoint):undefined;
  // Preserve the accepted legacy tags only after its unchanged all-zero source
  // guards reconstruct the exact same alternate. Reuse the evaluated state.
  const legacyFrames=manual&&manualPlan?.family==="relax"&&binding.rxTimingComparison==="worker-prepared-v1"
    ?await rxClockFrames(map,replay,scoring,binding,checkpoint):undefined;
  let legacyModel=!!legacyFrames&&!!manualPlan&&await sameManualClockEvidence(legacyFrames,manualPlan.reference.frames,checkpoint);
  const outcomeQualified=qualified||manual?.outcome===true;
  const completedDomain=outcomeQualified&&scoring.domain.endpointBasis==="recorded-end"&&!scoring.domain.synthesizedEndpoint;
  const completion=completionMetric({...(!normalizationUnavailable?binding.sourceCompletion:{}),coverage:{exactMapAndProfile:binding.exactMapAndProfile,
    expectedJudgements:map.hitObjects.length,observedJudgements:coverage.parents,terminalJudgementObserved:coverage.terminal,
    replayCoverage:completedDomain?"complete":"unknown"}});
  if(manual&&!manual.outcome&&(completion.state!=="unknown"||completion.reason!=="completion-not-established"))manual=undefined;
  if(!manual)legacyModel=false;
  // Preserve independently supplied completion/conflict evidence. This narrow
  // certificate has no authority to erase or reinterpret those existing fields.
  const rxAttempt=!normalizationUnavailable&&!manualPlan&&binding.rxTimingComparison==="worker-prepared-v1"&&!qualified&&rxAttemptEligible(replay)&&
    completion.state==="unknown"&&completion.reason==="completion-not-established";
  const rx=rxAttempt?await compareRxNumerical(map,replay,scoring,state,binding,checkpoint):undefined;
  // Absent future outcomes stay unknown; source/header values remain separately available in H.
  const countsAvailable=outcomeQualified&&coverage.full&&map.hitObjects.length>0;
  await checkpoint();
  const info=countsAvailable?(profile==="stable"?new GameplayInfoEvaluator(map):new LazerGameplayInfoEvaluator()).evaluateReplayState(state):undefined;
  await checkpoint();
  const events=qualified?await retrieveEventsAsync(state,map.hitObjects,profile,checkpoint):manual?.events??[];
  const breaks=profile==="stable"&&countsAvailable?stableSliderBreakResolutionTimes(events).length:null;
  const misses=sliderMissResolutionTimes(events);
  await checkpoint();
  const losses=outcomeQualified&&coverage.breaks?performanceJudgements(map,state,profile==="stable"?"stable":map.lazerModSettings.classic?"lazer-classic":"lazer")
    .filter(j=>j.combo==="reset").length:null;
  const combo=comboMetrics({completion,misses:info?.verdictCounts[3]??null,comboLosses:losses,
    completeBreakEvidence:outcomeQualified&&coverage.breaks,maxCombo:info?.maxComboSoFar??null,exactMapMaxCombo:theoreticalMaxCombo(map,profile),
    ...(profile==="stable"?{ruleset:"stable" as const,sliderBreaks:breaks}:{ruleset:"lazer" as const})});
  await checkpoint();
  const timingQualified=qualified||rx?.timing===true||manual?.timing===true;
  const timing=timingMetrics(timingQualified?replayTimingHits(map,state):[],map.gameClockRate,profile);
  const metric=(value:number|undefined)=>value===undefined?unknown<number>():known(value);
  let mapStartMs=Infinity,mapEndMs=-Infinity;
  for(let index=0;index<map.hitObjects.length;index++){
    if(index%256===0)await checkpoint();const object=map.hitObjects[index];
    mapStartMs=Math.min(mapStartMs,object instanceof HitCircle?object.hitTime:object.startTime);
    mapEndMs=Math.max(mapEndMs,object instanceof HitCircle?object.hitTime:object.endTime);
  }
  const stripDomain={mapStartMs,mapEndMs,evaluatedThrough:scoring.endTime,
    endpointBasis:scoring.domain.endpointBasis,synthesizedEndpoint:scoring.domain.synthesizedEndpoint};
  let errorStrip=await projectLibraryErrorStrip(events,profile,stripDomain,qualified&&coverage.consistent&&map.hitObjects.length>0,checkpoint);
  let manualStrip=false;
  if(manual?.events&&manual.otherEvents){
    const currentStrip=await projectLibraryErrorStrip(manual.events,"stable",stripDomain,coverage.consistent&&map.hitObjects.length>0,checkpoint);
    const otherStrip=await projectLibraryErrorStrip(manual.otherEvents,"stable",stripDomain,coverage.consistent&&map.hitObjects.length>0,checkpoint);
    if(currentStrip.state==="known"&&otherStrip.state==="known"&&await sameManualClockEvidence(currentStrip,otherStrip,checkpoint)){errorStrip=currentStrip;manualStrip=true;}
    else if(currentStrip.state==="unknown")errorStrip=currentStrip;
  }
  let rxStrip=false;
  if(rx?.events&&rx.otherEvents){
    const currentStrip=await projectLibraryErrorStrip(rx.events,"stable",stripDomain,true,checkpoint);
    const otherStrip=await projectLibraryErrorStrip(rx.otherEvents,"stable",stripDomain,true,checkpoint);
    if(currentStrip.state==="known"&&otherStrip.state==="known"&&await sameRxEvidence(currentStrip,otherStrip,checkpoint)){
      errorStrip=currentStrip;rxStrip=true;
    }else if(currentStrip.state==="unknown")errorStrip=currentStrip;
  }
  await checkpoint();
  const fieldPrefix=manualPlan?.family==="relax"?"rxClock":"manualClock",fieldVersion=manualPlan?.family==="relax"?LIBRARY_RX_CLOCK_COMPARISON_VERSION:LIBRARY_MANUAL_CLOCK_COMPARISON_VERSION;
  const result:LibraryMetricResult={errorStrip,provenance:{replaySha256:binding.replaySha256,mapSha256:binding.mapSha256,mapMd5:binding.mapMd5,ruleset:profile,
    projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,scoreOrigin:"reconstructed",completionEvidence:"source-domain-coverage-v1",
    ...(rxAttempt||legacyModel?{timingComparisonVersion:LIBRARY_RX_TIMING_COMPARISON_VERSION}:{}),
    ...(rx?.timing||legacyModel&&manual?.legacyTiming&&manual.timing?{timingEvidence:LIBRARY_RX_TIMING_COMPARISON_VERSION}:{}),
    ...(rxStrip||legacyModel&&manualStrip?{stripEvidence:LIBRARY_RX_TIMING_COMPARISON_VERSION}:{}),
    ...(manual?{[fieldPrefix+"ComparisonVersion"]:fieldVersion}:{}),
    ...(manual?.timing?{[fieldPrefix+"TimingEvidence"]:fieldVersion}:{}),
    ...(manualStrip?{[fieldPrefix+"StripEvidence"]:fieldVersion}:{}),
    ...(manual?.outcome?{[fieldPrefix+"OutcomeEvidence"]:fieldVersion}:{}),
    ...(manual?.performanceInput?{[fieldPrefix+"PerformanceEvidence"]:fieldVersion}:{}),
    ...([REPLAY_RELEASED_PREFIX_WITNESS_VERSION,REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION,REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION,REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION,"stable-initial-negative-v1",LIBRARY_MANUAL_CLOCK_SOURCE_VERSION,LIBRARY_RX_CLOCK_SOURCE_VERSION,LIBRARY_EARLY_MAP_CLOCK_VERSION,LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION].includes(sourceEvidence??"")?{sourceCoverageEvidence:sourceEvidence}:{}),
    ...(normalized?{clockNormalizationVersion:normalizationVersion}:{}),
    coverageQualified:qualified,completeBreakEvidence:outcomeQualified&&coverage.breaks,completeAccuracyEvidence:countsAvailable,rate:map.gameClockRate},
    fields:{completion,...combo,accuracy:metric(info?.accuracy),misses:metric(info?.verdictCounts[3]),maxCombo:metric(info?.maxComboSoFar),
      comboLosses:metric(losses??undefined),sliderBreaks:profile==="lazer"?{state:"not-applicable",reason:"stable-slider-breaks-only"}:metric(breaks??undefined),
      sliderEndMisses:metric(countsAvailable?(profile==="stable"?misses.stableSliderEnd.length:misses.lazerSliderEnd.length):undefined),
      sliderTickMisses:profile==="stable"?{state:"not-applicable",reason:"native-slider-ticks-only"}:metric(countsAvailable?misses.lazerSliderTick.length:undefined),
      ur:timing.ur,biasMs:timing.biasMs,sampleCount:timingQualified?known(timing.sampleCount):unknown()}};
  if(manual?.performanceInput&&!await registerManualClockPerformance(result,manual.performanceInput,checkpoint))delete result.provenance[fieldPrefix+"PerformanceEvidence"];
  return result;
}

/** Worker-local result retains state for following numerical consumers; only metrics may be persisted. */
export async function runLibraryNumerical(map:Beatmap,replay:OsuReplay,binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>) {
  validateBinding(replay,binding);
  const selected=await selectNormalizedClockReplay(map,replay,binding,checkpoint);
  const scoring=await scoringReplayFramesAsync(map,selected,checkpoint);
  const state=scoring.reusableSourceState?.state??await (isLazerReplay(replay)
    ?new LazerGameStateTimeMachine(scoring.frames,map,undefined,{legacyReplay:!isLazerReplay(replay)})
    :new BucketedGameStateTimeMachine(scoring.frames,map,{hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion,replayTimestamp:replay.timestamp}))
    .evaluateReplayAsync(checkpoint);
  const metrics=await projectLibraryNumerical(map,selected,scoring,state,binding,checkpoint,true);
  const manualClockPerformanceInput=getManualClockPerformanceInput(metrics);
  return {metrics,state,scoring,...(selected!==replay?{analysisReplay:selected}:{}),...(manualClockPerformanceInput?{manualClockPerformanceInput}:{})};
}
