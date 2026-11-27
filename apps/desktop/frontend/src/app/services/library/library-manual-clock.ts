import {Beatmap,defaultGameState,GameStateEvaluator,NOT_PRESSING,OsuAction,ReplayFrame,ReplayLeadingResetToken,Spinner,stableNumericalInputBoundary} from "@osujs/core";
import type {OsuReplay} from "../../model/OsuReplay";
import type {LibraryNumericalBinding} from "../../../../../shared/library-analysis";
import type {LibraryMetricResult} from "../../../../../shared/replay-library-metrics";
import {LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION} from "../../../../../shared/replay-library-metrics";
import type {ReplayPerformanceInput} from "../analysis/performance/replay-performance-input";
import type {PreparedScoringReplay} from "../common/game/ReplayScoringFrames";
import {interpolateReplayPosition} from "../../utils/replay";
import {getPreparedClockInput,StableClockInput,StableClockFamily} from "./library-manual-clock-certificate";

/** Complete ordered worker-local evidence comparison. No scalar digest grants authority. */
export async function sameManualClockEvidence(left:unknown,right:unknown,checkpoint:()=>Promise<void>):Promise<boolean>{
  const pending:[unknown,unknown][]=[[left,right]];let work=0;
  while(pending.length){
    if(++work>1000000)return false;if(work%256===0)await checkpoint();const pair=pending.pop();if(!pair)return false;const [a,b]=pair;
    if(a===b)continue;
    if(!a||!b||typeof a!=="object"||typeof b!=="object"||Object.getPrototypeOf(a)!==Object.getPrototypeOf(b))return false;
    if(a instanceof Map&&b instanceof Map){if(a.size!==b.size)return false;pending.push([[...a],[...b]]);continue;}
    if(a instanceof Set&&b instanceof Set){if(a.size!==b.size)return false;pending.push([[...a],[...b]]);continue;}
    if(Array.isArray(a)&&(!Array.isArray(b)||a.length!==b.length))return false;
    const keys=Object.keys(a),other=Object.keys(b);if(keys.length!==other.length||pending.length+keys.length>200000)return false;
    for(const key of keys){if(!Object.prototype.hasOwnProperty.call(b,key))return false;pending.push([(a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]]);}
  }
  return true;
}
const equalFrame=(a:ReplayFrame,b:ReplayFrame)=>a.time===b.time&&a.position.x===b.position.x&&a.position.y===b.position.y&&
  a.rawButtonMask===b.rawButtonMask&&a.actions.length===b.actions.length&&a.actions.every((action,index)=>action===b.actions[index]);
const released=(frame:ReplayFrame)=>frame.rawButtonMask!==undefined&&(frame.rawButtonMask&15)===0&&frame.actions.length===0;
export function manualClockSemanticDomain(scoring:PreparedScoringReplay){
  const {frameSources,sourceCoverageLimits,...domain}=scoring.domain;
  void frameSources;void sourceCoverageLimits;
  // Provenance arrays remain independently bound to each actually prepared input.
  // They are not interchangeable with the semantic scoring endpoint contract.
  return domain;
}
export interface ManualClockPlan {sourceEquivalent:boolean;reference:OsuReplay;family:StableClockFamily}

// A deliberate worker-proof cost budget, shared by history search and the one
// selected evaluator traversal per side. This is not the parser's input cap.
const MANUAL_CLOCK_HISTORY_FRAME_BUDGET=1024;

type ConsumedClockDomain={kind:"recorded-end"|"health-bracket";current:ReplayFrame[];reference:ReplayFrame[];
  referenceLength:number;referenceEndpoint?:ReplayFrame};

/** Same endpoint policy as scoring preparation, without copying/sorting health
 * points. Stable sort order is the pair (time, original index), including ties. */
async function observedClockHealthEnd(replay:OsuReplay,replayEnd:number,checkpoint:()=>Promise<void>){
  if(replay.mods.includes("NO_FAIL"))return;
  for(let i=0;i<(replay.lazerMods?.length??0);i++){
    if(i%256===0)await checkpoint();if(replay.lazerMods?.[i].acronym.toUpperCase()==="NF")return;
  }
  const points=replay.lifeBar??[];let positiveTime=-Infinity,positiveIndex=-1;
  for(let i=0;i<points.length;i++){
    if(i%256===0)await checkpoint();const {time,health}=points[i];
    if(Number.isFinite(time)&&Number.isFinite(health)&&time<=replayEnd&&health>0&&
      (time>positiveTime||time===positiveTime&&i>positiveIndex)){positiveTime=time;positiveIndex=i;}
  }
  let failedTime=Infinity,failedIndex=Infinity;
  for(let i=0;i<points.length;i++){
    if(i%256===0)await checkpoint();const {time,health}=points[i];
    if(Number.isFinite(time)&&Number.isFinite(health)&&time<=replayEnd&&health<=0&&
      (time>positiveTime||time===positiveTime&&i>positiveIndex)&&
      (time<failedTime||time===failedTime&&i<failedIndex)){failedTime=time;failedIndex=i;}
  }
  await checkpoint();return Number.isFinite(failedTime)?Math.max(0,failedTime):undefined;
}

/** The source mapping belongs to the actual parser input. Reference frames keep
 * their separate raw inventory; interpolating them never manufactures parsed provenance. */
async function consumedClockDomain(replay:OsuReplay,reference:OsuReplay,raws:readonly number[],scoring:PreparedScoringReplay,
  family:StableClockFamily,checkpoint:()=>Promise<void>):Promise<ConsumedClockDomain|undefined>{
  const d=replay.parseDiagnostics,current=replay.frames,end=scoring.endTime;if(!d||!current.length||scoring.domain.endTimeMs!==end)return;
  if(scoring.domain.endpointBasis==="recorded-end"){
    if(scoring.domain.synthesizedEndpoint||scoring.domain.endpointInputBracket!==undefined||end!==current.at(-1)?.time||
      scoring.frames.length!==current.length||scoring.domain.frameSources?.length!==d.frameSources.length)return;
    for(let i=0;i<current.length;i++){
      if(i%256===0)await checkpoint();if(!equalFrame(current[i],scoring.frames[i])||
        !await sameManualClockEvidence(d.frameSources[i],scoring.domain.frameSources[i],checkpoint))return;
    }
    return{kind:"recorded-end",current:scoring.frames,reference:reference.frames,referenceLength:reference.frames.length};
  }
  // Only an actually observed health endpoint inside a complete adjacent input
  // bracket is added here. Aggregate inference and unbracketed truncation stay out.
  if(family!=="manual"||scoring.domain.endpointBasis!=="health-derived"||!scoring.domain.synthesizedEndpoint||!Number.isFinite(end)||
    !equalFrame(current[current.length-1],reference.frames[reference.frames.length-1])||
    d.frameSources[current.length-1]?.rawTokenIndex!==raws[raws.length-1])return;
  // Reconstruction copies the metadata references; equal terminal tuples give
  // the same health filter bound. Validate once, not once per equivalent model.
  if(reference.lifeBar!==replay.lifeBar||reference.mods!==replay.mods||reference.lazerMods!==replay.lazerMods||
    await observedClockHealthEnd(replay,current[current.length-1].time,checkpoint)!==end)return;
  const index=scoring.frames.length-2,previous=current[index],next=current[index+1];
  const previousSource=d.frameSources[index],nextSource=d.frameSources[index+1];
  if(!previous||!next||!(previous.time<end&&end<next.time)||previousSource?.origin!=="parsed"||nextSource?.origin!=="parsed"||
    previousSource.rawTokenIndex===undefined||nextSource.rawTokenIndex!==previousSource.rawTokenIndex+1||
    nextSource.parsedFrameIndex!==previousSource.parsedFrameIndex+1||nextSource.discontinuityBefore?.length||
    previous.rawButtonMask===undefined||next.rawButtonMask===undefined)return;
  const bracket={previous:{timeMs:previous.time,source:{...previousSource,rawTokenIndex:previousSource.rawTokenIndex},actions:[...previous.actions],rawButtonMask:previous.rawButtonMask},
    next:{timeMs:next.time,source:{...nextSource,rawTokenIndex:nextSource.rawTokenIndex},actions:[...next.actions],rawButtonMask:next.rawButtonMask}};
  const expectedDomain={endTimeMs:end,endpointBasis:"health-derived",synthesizedEndpoint:true,endpointInputBracket:bracket,
    initialActionsKnown:d.initialActionsKnown,sourceCoverageLimits:d.sourceCoverageLimits};
  const {frameSources,...domain}=scoring.domain;
  if(!frameSources||frameSources.length!==scoring.frames.length||!await sameManualClockEvidence(domain,expectedDomain,checkpoint))return;
  // Validate the existing arrays as bounded views. Only the synthetic endpoint
  // is a new object; no million-frame/source prefix is copied for this proof.
  for(let i=0;i<=index;i++){
    if(i%256===0)await checkpoint();if(current[i].time>end||!await sameManualClockEvidence(scoring.frames[i],current[i],checkpoint)||
      !await sameManualClockEvidence(frameSources[i],d.frameSources[i],checkpoint))return;
  }
  const endpoint={time:end,position:interpolateReplayPosition(previous,next,end),actions:[...previous.actions],rawButtonMask:previous.rawButtonMask};
  if(!await sameManualClockEvidence(scoring.frames[index+1],endpoint,checkpoint)||
    !await sameManualClockEvidence(frameSources[index+1],{origin:"synthetic",reason:"scoring-endpoint-interpolation"},checkpoint))return;
  let otherIndex=-1;
  for(let i=0;i<raws.length;i++){if(i%256===0)await checkpoint();if(raws[i]===previousSource.rawTokenIndex){otherIndex=i;break;}}
  if(otherIndex<0||raws[otherIndex+1]!==nextSource.rawTokenIndex||!equalFrame(previous,reference.frames[otherIndex])||
    !reference.frames[otherIndex+1]||!equalFrame(next,reference.frames[otherIndex+1]))return;
  return{kind:"health-bracket",current:scoring.frames,reference:reference.frames,referenceLength:otherIndex+2,referenceEndpoint:endpoint};
}

/** Exact finite transformation of (current, previous, older) logical buttons.
 * One/two distinct observations retain conditional incoming-history dependence.
 * Three or more overwrite it: the final history is exactly the last three
 * distinct masks, newest first. Keep short signatures distinct from constants. */
const logicalMask=(frame:ReplayFrame)=>(frame.actions.includes(OsuAction.leftButton)?1:0)|(frame.actions.includes(OsuAction.rightButton)?2:0);
// All selected inputs are below NOT_PRESSING. An actually observed predecessor
// therefore establishes held sides, independently of incoming older history.
// Continuing/subset held input has no fresh manual attempt; first-active held
// input without that observation remains unsupported.
const noFreshInput=(frame:ReplayFrame,previous:ReplayFrame|undefined)=>released(frame)||
  previous!==undefined&&(logicalMask(frame)&~logicalMask(previous))===0;
function advanceHistoryTransform(history:number[],frame:ReplayFrame){
  const mask=logicalMask(frame);
  if(history[history.length-1]===mask)return;
  if(history.length===3)history.shift();history.push(mask);
}
// At a common released anchor, two distinct observed states ending in the same
// [held, released] pair establish equal previous buttons for every input history.
// Only older history can differ. Stable slider latch logic ignores it while
// released; the next logical transition overwrites it from equal previous buttons
// before hit/tracking dispatch. Keep the actual full-state comparison unchanged.
function equivalentReleasedHistory(left:readonly number[],right:readonly number[],next:ReplayFrame){
  return left.length===right.length&&left.every((value,index)=>value===right[index])||
    left.length>=2&&right.length>=2&&left.at(-1)===0&&right.at(-1)===0&&
    left.at(-2)!==0&&left.at(-2)===right.at(-2)&&
    // Select only a candidate whose ordinary constructor history also closes:
    // a fresh next input overwrites older, otherwise its default value is the
    // third-last observed state (or the constructor's zero). This avoids hiding
    // a later exact anchor behind an earlier failed full-state comparison.
    (logicalMask(next)!==0||(left.at(-3)??0)===(right.at(-3)??0));
}
// The additional released-start case has no observed previous state on one
// side. Its two history cells are inert while released. A fresh transition sets
// previous=0 (so older is still unused), and the next transition overwrites older.
// This relation is local to a pre-activation release+released-next proof; neither
// the evaluator's history nor the general evidence comparator is normalized.
const releasedInitialHistory=(left:readonly number[],right:readonly number[])=>
  left.length===1&&left[0]===0&&right.length===2&&right[0]!==0&&right[1]===0||
  right.length===1&&right[0]===0&&left.length===2&&left[0]!==0&&left[1]===0;
const prefixCarry=(evaluator:GameStateEvaluator)=>{
  const value=evaluator as unknown as Record<string,unknown>;
  return{previousInputTime:value.previousInputTime,freshLogicalButtonsThisFrame:value.freshLogicalButtonsThisFrame,
    freshPressCountThisFrame:value.freshPressCountThisFrame,frame:value.frame,pendingScoringEvents:value.pendingScoringEvents,
    stableSliderBallPaths:value.stableSliderBallPaths};
};
async function prefixHistoryTransform(frames:readonly ReplayFrame[],end:number,before:number,activation:number,checkpoint:()=>Promise<void>){
  const history:number[]=[];let spawned=false,previousTime=-Infinity;
  for(let i=0;i<=end;i++){
    await checkpoint();const frame=frames[i];if(!frame||frame.time>=before)return;
    spawned||=frame.time>=activation;
    if(spawned&&(!noFreshInput(frame,frames[i-1])||frame.time<previousTime))return;
    previousTime=frame.time;
    advanceHistoryTransform(history,frame);
  }
  return{history,spawned};
}

/** The private receipt attests raw lexical/inventory and exact current tuple identity.
 * Reconstruct the pinned importer clock policy with this evaluator's two tap actions.
 * Smoke stays in raw masks; neither full importer-action nor historical parity is claimed. */
async function reconstructClock(replay:OsuReplay,receipt:StableClockInput,checkpoint:()=>Promise<void>){
  const d=replay.parseDiagnostics;if(!d||!replay.frames.length)return;
  const frames:ReplayFrame[]=[],raws:number[]=[],first:ReplayLeadingResetToken[]=[];
  let retained=0,omitted=0,skipped=0,time=0,clock:number=receipt.policy.rawClockOriginMs,last=-Infinity,ended=false;
  const accept=(token:ReplayLeadingResetToken)=>{
    if(token.timeAfter<last)return;last=token.timeAfter;raws.push(token.rawTokenIndex);
    frames.push({time:token.timeAfter,position:{x:token.x,y:token.y},rawButtonMask:token.rawButtonMask,
      actions:[...(token.rawButtonMask&5?[OsuAction.leftButton]:[]),...(token.rawButtonMask&10?[OsuAction.rightButton]:[])]});
  };
  for(let raw=0;raw<receipt.rawTokenCount;raw++){
    if(raw%256===0)await checkpoint();const source=d.frameSources[retained],skip=d.skippedTokens[skipped],missing=receipt.omittedTokens[omitted];let token:ReplayLeadingResetToken;
    if(source?.rawTokenIndex===raw){const f=replay.frames[retained++];if(f.rawButtonMask===undefined)return;token={rawTokenIndex:raw,delta:f.time-time,x:f.position.x,y:f.position.y,
      rawButtonMask:f.rawButtonMask,timeBefore:time,timeAfter:f.time};}
    else if(missing?.rawTokenIndex===raw){token=missing;omitted++;if(skip?.rawTokenIndex!==raw)return;skipped++;}
    else{
      if(raw<3||skip?.rawTokenIndex!==raw)return;
      if(skip.reason==="seed"&&!ended&&(raw===receipt.rawTokenCount-1||raw===receipt.rawTokenCount-2&&d.skippedTokens[skipped+1]?.reason==="empty-token"))ended=true;
      else if(skip.reason==="empty-token"&&raw===receipt.rawTokenCount-1)ended=true;else return;
      skipped++;continue;
    }
    if(ended||token.timeBefore!==time||token.timeAfter!==time+token.delta||!Number.isSafeInteger(token.timeAfter))return;
    time=token.timeAfter;clock+=token.delta;if(!Number.isSafeInteger(clock))return;
    const selected={...token,timeBefore:clock-token.delta,timeAfter:clock};
    if(raw<3){first.push(selected);if(raw<2)continue;
      if(first[1].timeAfter<first[0].timeAfter){first[1].timeAfter=first[0].timeAfter;first[0].timeAfter=0;}
      if(first[0].timeAfter>first[2].timeAfter){first[0].timeAfter=first[2].timeAfter;first[1].timeAfter=first[2].timeAfter;}
      for(const item of first)if(!(item.rawTokenIndex<2&&Math.fround(item.x)===256&&Math.fround(item.y)===-500))accept(item);
    }else accept(selected);
    if(frames.length>1000000)return;
  }
  if(retained!==replay.frames.length||omitted!==receipt.omittedTokens.length||skipped!==d.skippedTokens.length||!frames.length)return;
  // This constructed stream is not the parser's retained stream. Its domain uses
  // explicit provided-frame provenance rather than forged parsed-frame sources.
  const reference:OsuReplay={...replay,frames,parseDiagnostics:undefined};
  return{reference,raws,first};
}

export async function prepareManualClockPlan(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,
  binding:LibraryNumericalBinding,checkpoint:()=>Promise<void>):Promise<ManualClockPlan|undefined>{
  const receipt=await getPreparedClockInput(replay,map,binding,checkpoint),d=replay.parseDiagnostics;
  if(!receipt||receipt.policy.kind!=="comparison"||!d||!map.hitObjects.length)return;
  const reconstructed=await reconstructClock(replay,receipt,checkpoint);if(!reconstructed)return;
  const {reference,raws}=reconstructed,frames=reference.frames,family=receipt.family;
  const boundary=stableNumericalInputBoundary(map);let firstActivation=Infinity;
  for(let index=0;index<map.hitObjects.length;index++){if(index%256===0)await checkpoint();const o=map.hitObjects[index];firstActivation=Math.min(firstActivation,o instanceof Spinner?o.startTime:o.spawnTime);}
  const before=Math.min(firstActivation,boundary??-Infinity),current=replay.frames;
  const initialBeforeActivation=[current[0],frames[0]].every(f=>f.time<before),effectBefore=Math.min(boundary??-Infinity,NOT_PRESSING);
  if(!Number.isFinite(before)||!initialBeforeActivation&&(family!=="manual"||[current[0],frames[0]].some(
    f=>f.time>=effectBefore||f.time>=firstActivation&&!released(f))))return;
  const initialReleased=[current[0],frames[0]].every(released);
  // The new held/history closure is manual-only. R16 Relax initialization and
  // format3 normalization retain their separate established contracts.
  if(!initialReleased&&family!=="manual")return;
  const consumed=await consumedClockDomain(replay,reference,raws,scoring,family,checkpoint);if(!consumed)return;
  let a=current.length-1,b=frames.length-1;
  while(a>=0&&b>=0&&d.frameSources[a].rawTokenIndex===raws[b]&&equalFrame(current[a],frames[b])){if(a%256===0)await checkpoint();a--;b--;}
  const commonA=a+1,commonB=b+1;
  const partial=()=>initialBeforeActivation&&initialReleased&&consumed.kind==="recorded-end"?{sourceEquivalent:false,reference,family}:undefined;
  if(commonA>=current.length||commonB>=frames.length)return partial();
  // Every consumed suffix tuple, including a possible final interpolated tuple,
  // must match after the independently mapped prefix. No provenance is erased.
  if(consumed.current.length-commonA!==consumed.referenceLength-commonB)return partial();
  for(let i=commonA,j=commonB;i<consumed.current.length;i++,j++){
    if(i%256===0)await checkpoint();const other=consumed.referenceEndpoint&&j===consumed.referenceLength-1?consumed.referenceEndpoint:consumed.reference[j];
    if(!equalFrame(consumed.current[i],other))return partial();
  }
  if(a===-1&&b===-1&&initialReleased&&initialBeforeActivation)return{sourceEquivalent:true,reference,family};
  const options={hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion,replayTimestamp:replay.timestamp} as const;
  const stateEqual=async(endA:number,endB:number,spawnOnly=false,releasedInitial=false)=>{
    if(endA>=MANUAL_CLOCK_HISTORY_FRAME_BUDGET||endB>=MANUAL_CLOCK_HISTORY_FRAME_BUDGET)return false;
    const left=defaultGameState(),right=defaultGameState(),leftEvaluator=new GameStateEvaluator(map,options),rightEvaluator=new GameStateEvaluator(map,options);
    for(let i=0;i<=endA;i++){await checkpoint();leftEvaluator.evaluate(left,current[i]);}
    for(let i=0;i<=endB;i++){await checkpoint();rightEvaluator.evaluate(right,frames[i]);}
    const eventsSafe=spawnOnly?left.eventIndex===right.eventIndex&&left.judgedObjects.length===0&&right.judgedObjects.length===0&&
      left.aliveSliderIds.size===0&&right.aliveSliderIds.size===0&&left.aliveSpinnerIds.size===0&&right.aliveSpinnerIds.size===0:
      left.eventIndex===0&&right.eventIndex===0;
    if(!eventsSafe)return false;
    if(!releasedInitial)return sameManualClockEvidence(left,right,checkpoint);
    if(spawnOnly||left.pressingSince.some(time=>time!==NOT_PRESSING)||right.pressingSince.some(time=>time!==NOT_PRESSING))return false;
    const {stablePreviousButtons:leftPrevious,stablePreviousPreviousButtons:leftOlder,...leftOther}=left,
      {stablePreviousButtons:rightPrevious,stablePreviousPreviousButtons:rightOlder,...rightOther}=right;
    void leftPrevious;void leftOlder;void rightPrevious;void rightOlder;
    return await sameManualClockEvidence(leftOther,rightOther,checkpoint)&&
      await sameManualClockEvidence(prefixCarry(leftEvaluator),prefixCarry(rightEvaluator),checkpoint);
  };
  // Preserve the accepted R15 all-released recorded-end branch. Its next common
  // input overwrites previousInputTime from the equal currentTime on both sides.
  if(initialReleased&&consumed.kind==="recorded-end"&&commonA<256&&commonB<256&&
    [...current.slice(0,commonA+1),...frames.slice(0,commonB+1)].every(f=>f.time<before&&released(f))){
    return{sourceEquivalent:await stateEqual(commonA,commonB),reference,family};
  }
  if(family!=="manual")return partial();
  // A newly pressed side becomes held only below this finite evaluator sentinel.
  // Above it, even duplicate observed held masks can shift logical history again;
  // neither the reduced-word nor the rolling transformation applies there.
  const historyBefore=effectBefore;
  // Preserve pre-activation history semantics. A separate spawn-only extension
  // permits active samples without fresh logical input: before the numerical boundary every timed
  // event is a head/circle spawn, and continuing held input makes no hit attempt.
  // Once spawn has been crossed, neither a newly pressed side nor a clock reversal is
  // admitted, even if its timestamp returns below activation.
  if(commonA+1>=MANUAL_CLOCK_HISTORY_FRAME_BUDGET||commonB+1>=MANUAL_CLOCK_HISTORY_FRAME_BUDGET)return partial();
  const leftPrefix=await prefixHistoryTransform(current,commonA-1,historyBefore,firstActivation,checkpoint),
    rightPrefix=await prefixHistoryTransform(frames,commonB-1,historyBefore,firstActivation,checkpoint);
  if(!leftPrefix||!rightPrefix)return partial();
  const leftHistory=leftPrefix.history,rightHistory=rightPrefix.history;
  let anchor=-1,spawnOnly=false,releasedInitial=false,leftSpawned=leftPrefix.spawned,rightSpawned=rightPrefix.spawned;
  for(let offset=0;commonA+offset+1<current.length&&commonB+offset+1<frames.length&&
    commonA+offset+1<MANUAL_CLOCK_HISTORY_FRAME_BUDGET&&commonB+offset+1<MANUAL_CLOCK_HISTORY_FRAME_BUDGET;offset++){
    await checkpoint();const frame=current[commonA+offset],next=current[commonA+offset+1];
    if(frame.time>=historyBefore)return partial();
    leftSpawned||=frame.time>=firstActivation;rightSpawned||=frame.time>=firstActivation;
    if((leftSpawned||rightSpawned)&&(!noFreshInput(frame,current[commonA+offset-1])||!noFreshInput(frame,frames[commonB+offset-1])||
      commonA+offset>0&&frame.time<current[commonA+offset-1].time||commonB+offset>0&&frame.time<frames[commonB+offset-1].time))return partial();
    // The complete raw/tuple suffix is already equal, so this is the same input
    // transition on both finite transformations; no frame is deleted or changed.
    advanceHistoryTransform(leftHistory,frame);advanceHistoryTransform(rightHistory,frame);
    const nextSpawned=leftSpawned||rightSpawned||next.time>=firstActivation;
    if(released(frame)&&next.time<historyBefore&&next.time<=scoring.endTime&&(!nextSpawned||released(next)&&next.time>=frame.time)){
      if(equivalentReleasedHistory(leftHistory,rightHistory,next)){anchor=offset;spawnOnly=nextSpawned;break;}
      if(!nextSpawned&&released(next)&&releasedInitialHistory(leftHistory,rightHistory)){
        anchor=offset;releasedInitial=true;break;
      }
    }
  }
  if(anchor<0)return partial();
  const endA=commonA+anchor+1,endB=commonB+anchor+1;
  // Release clears pressing ages. The next identical sample closes the input
  // bracket and fresh-button carry. In the spawn-only branch there can be no
  // pending scoring/tracking state; exact full state includes ordered alive
  // circles and event progress. Evaluate this selected prefix once per side.
  return await stateEqual(endA,endB,spawnOnly,releasedInitial)?{sourceEquivalent:true,reference,family}:partial();
}

const normalizedInputs=new WeakMap<OsuReplay,{original:OsuReplay;map:Beatmap;binding:LibraryNumericalBinding;snapshot:object;raws:readonly number[]}>();
/** Select an explicitly requested importer source, never an equivalence claim about
 * the original stream. Format3 retains its separate +24 initialization contract. */
export async function selectNormalizedClockReplay(map:Beatmap,replay:OsuReplay,binding:LibraryNumericalBinding,
  checkpoint:()=>Promise<void>):Promise<OsuReplay>{
  const receipt=await getPreparedClockInput(replay,map,binding,checkpoint);
  if(!receipt||receipt.policy.kind!=="normalized-source"||receipt.family!=="manual")return replay;
  const reconstructed=await reconstructClock(replay,receipt,checkpoint),boundary=stableNumericalInputBoundary(map);
  if(!reconstructed||boundary===undefined||!Number.isFinite(boundary))return replay;
  const {reference,raws,first}=reconstructed,initial=reference.frames[0];
  if(!initial||!released(initial)||initial.time>=boundary)return replay;
  if(receipt.policy.version===LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION){
    if(binding.clockNormalizationVersion!==LIBRARY_MANUAL_IMPORTER_CLOCK_VERSION)return replay;
    let activation=Infinity;
    for(let i=0;i<map.hitObjects.length;i++){if(i%256===0)await checkpoint();const object=map.hitObjects[i];
      activation=Math.min(activation,object instanceof Spinner?object.startTime:object.spawnTime);}
    // This policy begins from the actually selected released input. Discarded
    // dummy timestamps do not shift negative-time maps or establish input history.
    if(!Number.isFinite(activation)||initial.time>=Math.min(activation,NOT_PRESSING))return replay;
  }else if(first.some(f=>(f.rawButtonMask&15)!==0||f.timeBefore>=boundary||f.timeAfter>=boundary))return replay;
  const snapshot=await snapshotEvidence(reference,checkpoint);if(!snapshot)return replay;
  normalizedInputs.set(reference,{original:replay,map,binding,snapshot,raws:Object.freeze(raws)});return reference;
}
export async function hasNormalizedClockSource(map:Beatmap,replay:OsuReplay,scoring:PreparedScoringReplay,binding:LibraryNumericalBinding,
  checkpoint:()=>Promise<void>):Promise<boolean>{
  const proof=normalizedInputs.get(replay);if(!proof||proof.map!==map||proof.binding!==binding)return false;
  const receipt=await getPreparedClockInput(proof.original,map,binding,checkpoint);
  if(receipt?.policy.kind!=="normalized-source"||!await sameManualClockEvidence(replay,proof.snapshot,checkpoint)||
    scoring.domain.endpointBasis!=="recorded-end"||scoring.domain.synthesizedEndpoint||scoring.domain.endpointInputBracket!==undefined||
    scoring.endTime!==replay.frames.at(-1)?.time||scoring.domain.endTimeMs!==scoring.endTime||scoring.frames.length!==proof.raws.length)return false;
  // The selected stream has no parsed-source claim. Its exact raw-index inventory
  // remains in the private proof; scoring must consume the entire provided stream.
  if(scoring.domain.initialActionsKnown!==false||scoring.domain.frameSources?.length!==proof.raws.length||
    !await sameManualClockEvidence(scoring.domain.sourceCoverageLimits,["source-mapping-unavailable","initial-actions-unknown"],checkpoint))return false;
  for(let i=0;i<replay.frames.length;i++){if(i%256===0)await checkpoint();
    if(!equalFrame(replay.frames[i],scoring.frames[i])||!await sameManualClockEvidence(scoring.domain.frameSources[i],
      {origin:"provided-frame",preparedFrameIndex:i},checkpoint))return false;}
  return true;
}

async function snapshotEvidence(value:object,checkpoint:()=>Promise<void>):Promise<object|undefined>{
  const result:object=Array.isArray(value)?[]:{},pending:[object,object][]=[[value,result]],copies=new WeakMap<object,object>([[value,result]]);let work=0;
  while(pending.length){const pair=pending.pop();if(!pair)return;const [source,target]=pair;
    if(Object.getPrototypeOf(source)!==Object.prototype&&!Array.isArray(source))return;
    for(const key of Object.keys(source)){if(++work>1000000)return;if(work%256===0)await checkpoint();const v=(source as Record<string,unknown>)[key];
      if(v&&typeof v==="object"){const prior=copies.get(v);if(prior){(target as Record<string,unknown>)[key]=prior;continue;}
        if(pending.length>=200000)return;const copy=Array.isArray(v)?[]:{};(target as Record<string,unknown>)[key]=copy;copies.set(v,copy);pending.push([v,copy]);}
      else (target as Record<string,unknown>)[key]=v;
    }
  }
  await checkpoint();return result;
}
const performanceProofs=new WeakMap<LibraryMetricResult,{input:ReplayPerformanceInput;inputSnapshot:object;resultSnapshot:object}>();
export async function registerManualClockPerformance(result:LibraryMetricResult,input:ReplayPerformanceInput,checkpoint:()=>Promise<void>):Promise<boolean>{
  const inputSnapshot=await snapshotEvidence(input,checkpoint),resultSnapshot=await snapshotEvidence(result,checkpoint);
  if(!inputSnapshot||!resultSnapshot)return false;performanceProofs.set(result,{input,inputSnapshot,resultSnapshot});return true;
}
export async function hasManualClockPerformance(result:LibraryMetricResult,input:ReplayPerformanceInput,checkpoint:()=>Promise<void>):Promise<boolean>{
  const proof=performanceProofs.get(result);return !!proof&&proof.input===input&&
    await sameManualClockEvidence(input,proof.inputSnapshot,checkpoint)&&await sameManualClockEvidence(result,proof.resultSnapshot,checkpoint);
}
export function getManualClockPerformanceInput(result:LibraryMetricResult):ReplayPerformanceInput|undefined{
  return performanceProofs.get(result)?.input;
}
