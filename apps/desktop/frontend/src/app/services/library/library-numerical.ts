import { Beatmap, BucketedGameStateTimeMachine, errorCapabilities, GameState, GameplayInfoEvaluator, HitCircle,
  LazerGameplayInfoEvaluator, LazerGameStateTimeMachine, ReplayAnalysisRuleset, Slider, Spinner,
  REPLAY_LEADING_RESET_WITNESS_VERSION, REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION, REPLAY_PARSER_VERSION } from "@osujs/core";
import { OsuAction, REPLAY_RELEASED_PREFIX_WITNESS_VERSION, REPLAY_RELEASED_PREFIX_MAX_TOKENS, REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION, REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION, REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION, stableNumericalInputBoundary } from "@osujs/core";
import { retrieveEventsAsync } from "@osujs/core";
import { isLazerReplay, OsuReplay } from "../../model/OsuReplay";
import type { LibraryMetricResult, LibraryMetricValue } from "../../../../../shared/replay-library-metrics";
import { performanceJudgements } from "../analysis/performance/replay-performance-input";
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
  let time=0,prior=-Infinity,frameIndex=0,skippedIndex=0,resets=0,pendingReset=false,retainedBeforeReset=false;
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
      f.time!==t.timeAfter||f.time<prior||f.position.x!==t.x||f.position.y!==t.y||f.rawButtonMask!==0||f.actions.length!==0)return false;
    prior=f.time;pendingReset=false;frameIndex++;
  }
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
  binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>):Promise<LibraryMetricResult> {
  await checkpoint();
  validateBinding(replay,binding);
  const profile:ReplayAnalysisRuleset=isLazerReplay(replay)?"lazer":"stable";
  let sourceEvidence:string|undefined;
  const qualified=(replay.gameMode??0)===0&&binding.exactMapAndProfile&&errorCapabilities(map,profile).scoring==="supported"&&
    await sourceCoverage(map,replay,checkpoint,value=>{sourceEvidence=value;});
  const coverage=await outcomeCoverage(map,state,profile,scoring.endTime,replay.frames[0]?.time??0,checkpoint);
  const completedDomain=qualified&&scoring.domain.endpointBasis==="recorded-end"&&!scoring.domain.synthesizedEndpoint;
  const completion=completionMetric({...binding.sourceCompletion,coverage:{exactMapAndProfile:binding.exactMapAndProfile,
    expectedJudgements:map.hitObjects.length,observedJudgements:coverage.parents,terminalJudgementObserved:coverage.terminal,
    replayCoverage:completedDomain?"complete":"unknown"}});
  // Absent future outcomes stay unknown; source/header values remain separately available in H.
  const countsAvailable=qualified&&coverage.full&&map.hitObjects.length>0;
  await checkpoint();
  const info=countsAvailable?(profile==="stable"?new GameplayInfoEvaluator(map):new LazerGameplayInfoEvaluator()).evaluateReplayState(state):undefined;
  await checkpoint();
  const events=qualified?await retrieveEventsAsync(state,map.hitObjects,profile,checkpoint):[];
  const breaks=profile==="stable"&&countsAvailable?stableSliderBreakResolutionTimes(events).length:null;
  const misses=sliderMissResolutionTimes(events);
  await checkpoint();
  const losses=qualified&&coverage.breaks?performanceJudgements(map,state,profile==="stable"?"stable":map.lazerModSettings.classic?"lazer-classic":"lazer")
    .filter(j=>j.combo==="reset").length:null;
  const combo=comboMetrics({completion,misses:info?.verdictCounts[3]??null,comboLosses:losses,
    completeBreakEvidence:qualified&&coverage.breaks,maxCombo:info?.maxComboSoFar??null,exactMapMaxCombo:theoreticalMaxCombo(map,profile),
    ...(profile==="stable"?{ruleset:"stable" as const,sliderBreaks:breaks}:{ruleset:"lazer" as const})});
  await checkpoint();
  const timing=timingMetrics(qualified?replayTimingHits(map,state):[],map.gameClockRate,profile);
  const metric=(value:number|undefined)=>value===undefined?unknown<number>():known(value);
  let mapStartMs=Infinity,mapEndMs=-Infinity;
  for(let index=0;index<map.hitObjects.length;index++){
    if(index%256===0)await checkpoint();const object=map.hitObjects[index];
    mapStartMs=Math.min(mapStartMs,object instanceof HitCircle?object.hitTime:object.startTime);
    mapEndMs=Math.max(mapEndMs,object instanceof HitCircle?object.hitTime:object.endTime);
  }
  const errorStrip=await projectLibraryErrorStrip(events,profile,{mapStartMs,mapEndMs,evaluatedThrough:scoring.endTime,
    endpointBasis:scoring.domain.endpointBasis,synthesizedEndpoint:scoring.domain.synthesizedEndpoint},qualified&&coverage.consistent&&map.hitObjects.length>0,checkpoint);
  await checkpoint();
  return {errorStrip,provenance:{replaySha256:binding.replaySha256,mapSha256:binding.mapSha256,mapMd5:binding.mapMd5,ruleset:profile,
    projectionVersion:LIBRARY_NUMERIC_PROJECTION_VERSION,scoreOrigin:"reconstructed",completionEvidence:"source-domain-coverage-v1",
    ...([REPLAY_RELEASED_PREFIX_WITNESS_VERSION,REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION,REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION,REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION,"stable-initial-negative-v1"].includes(sourceEvidence??"")?{sourceCoverageEvidence:sourceEvidence}:{}),
    coverageQualified:qualified,completeBreakEvidence:qualified&&coverage.breaks,completeAccuracyEvidence:countsAvailable,rate:map.gameClockRate},
    fields:{completion,...combo,accuracy:metric(info?.accuracy),misses:metric(info?.verdictCounts[3]),maxCombo:metric(info?.maxComboSoFar),
      comboLosses:metric(losses??undefined),sliderBreaks:profile==="lazer"?{state:"not-applicable",reason:"stable-slider-breaks-only"}:metric(breaks??undefined),
      sliderEndMisses:metric(countsAvailable?(profile==="stable"?misses.stableSliderEnd.length:misses.lazerSliderEnd.length):undefined),
      sliderTickMisses:profile==="stable"?{state:"not-applicable",reason:"native-slider-ticks-only"}:metric(countsAvailable?misses.lazerSliderTick.length:undefined),
      ur:timing.ur,biasMs:timing.biasMs,sampleCount:qualified?known(timing.sampleCount):unknown()}};
}

/** Worker-local result retains state for following numerical consumers; only metrics may be persisted. */
export async function runLibraryNumerical(map:Beatmap,replay:OsuReplay,binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>) {
  validateBinding(replay,binding);
  const scoring=await scoringReplayFramesAsync(map,replay,checkpoint);
  const state=scoring.reusableSourceState?.state??await (isLazerReplay(replay)
    ?new LazerGameStateTimeMachine(scoring.frames,map,undefined,{legacyReplay:!isLazerReplay(replay)})
    :new BucketedGameStateTimeMachine(scoring.frames,map,{hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion,replayTimestamp:replay.timestamp}))
    .evaluateReplayAsync(checkpoint);
  const metrics=await projectLibraryNumerical(map,replay,scoring,state,binding,checkpoint);
  return {metrics,state,scoring};
}
