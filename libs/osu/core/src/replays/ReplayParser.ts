import {
  OsuAction,
  ParsedReplayFrames,
  ReplayButtonState,
  ReplayFrame,
  ReplayParseDiagnostics,
  ReplaySkippedTokenReason,
  ReplayLeadingResetToken,
  REPLAY_LEADING_RESET_WITNESS_VERSION,
  REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION,
  REPLAY_RELEASED_PREFIX_WITNESS_VERSION,
  REPLAY_RELEASED_PREFIX_MAX_TOKENS,
  REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION,
  REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION,
  REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION,
} from "./Replay";

const MAX_COORDINATE_VALUE = 131072;
export const REPLAY_PARSER_VERSION = "replay-parser-provenance-v1";
/** Opt-in allocation budgets for worker-owned input. Legacy callers retain their existing limits. */
export interface ReplayParserLimits {
  maxRawLength: number;
  maxTokenLength: number;
  maxTokens: number;
  maxFrames: number;
  maxSkippedTokens?: number;
  signal?: AbortSignal;
}
// LegacyScoreDecoder.cs
// PowerOfTwo bit
const bitmaskCheck = (mask: number, bit: number): boolean => (mask & bit) !== 0;

/** Retain the legacy array API and frame shapes without allocating diagnostics. */
export const parseReplayFramesFromRaw = (rawString: string): ReplayFrame[] => parseReplayFrames(rawString);

export const parseReplayFramesWithDiagnostics = (rawString: string, limits?: ReplayParserLimits): ParsedReplayFrames => {
  const diagnostics = createDiagnostics();
  return { frames: parseReplayFrames(rawString, diagnostics, limits), diagnostics };
};

/** Worker callers supply a macrotask checkpoint so cancellation messages can run. */
export async function parseReplayFramesWithDiagnosticsAsync(rawString: string, limits: ReplayParserLimits,
  checkpoint: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0))): Promise<ParsedReplayFrames> {
  const diagnostics = createDiagnostics();
  const steps = parseReplayFrameSteps(rawString, diagnostics, limits);
  let next = steps.next();
  while (!next.done) {
    await checkpoint(); limits.signal?.throwIfAborted(); next = steps.next();
  }
  await checkpoint(); limits.signal?.throwIfAborted();
  return { frames: next.value, diagnostics };
}

function createDiagnostics(): ReplayParseDiagnostics {
  return {
    parserVersion: REPLAY_PARSER_VERSION,
    frameSources: [],
    skippedTokens: [],
    sourceCoverageLimits: ["initial-actions-unknown"],
    initialActionsKnown: false,
  };
}

function parseReplayFrames(rawString: string, diagnostics?: ReplayParseDiagnostics, limits?: ReplayParserLimits): ReplayFrame[] {
  const steps = parseReplayFrameSteps(rawString, diagnostics, limits);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

function* parseReplayFrameSteps(rawString: string, diagnostics?: ReplayParseDiagnostics, limits?: ReplayParserLimits): Generator<void, ReplayFrame[]> {
  if (limits) {
    for (const value of [limits.maxRawLength, limits.maxTokenLength, limits.maxTokens, limits.maxFrames, limits.maxSkippedTokens ?? limits.maxTokens])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid replay parser limit");
    if (rawString.length > limits.maxRawLength) throw new Error("Replay raw input exceeds parser limit");
    limits.signal?.throwIfAborted();
  }
  let lastTime = 0;
  const frames: ReplayFrame[] = [];
  const prefix: ReplayLeadingResetToken[] = [];
  const releasedPrefix: ReplayLeadingResetToken[] = [];
  let finalReset=-1, releasedFrame=-1, heldRetained=false;
  let neutralFrame=-1, resetCount=0;
  let rawTokenCount = 0, adjacentSuffix = true, initialNegativeSuffix = true;
  let discontinuityBefore: string[] = [];
  const skipped = (rawTokenIndex: number, reason: ReplaySkippedTokenReason) => {
    if (!diagnostics) return;
    if (limits && diagnostics.skippedTokens.length >= (limits.maxSkippedTokens ?? limits.maxTokens)) throw new Error("Replay diagnostic count exceeds parser limit");
    diagnostics.skippedTokens.push({ rawTokenIndex, reason });
    if (reason !== "malformed-token" && reason !== "negative-delta") return;
    const limitation = `parser-${reason}`;
    if (!diagnostics.sourceCoverageLimits.includes(limitation)) diagnostics.sourceCoverageLimits.push(limitation);
    if (!discontinuityBefore.includes(limitation)) discontinuityBefore.push(limitation);
  };
  let tokenStart = 0, scannedCharacters = 0;
  for (let i = 0; tokenStart <= rawString.length; i++) {
    rawTokenCount = i + 1;
    if (i > 0 && i % 1024 === 0) yield;
    if (limits) {
      limits.signal?.throwIfAborted();
      if (i >= limits.maxTokens) throw new Error("Replay token count exceeds parser limit");
    }
    let comma: number;
    if (limits) {
      let cursor = tokenStart;
      while (cursor < rawString.length && rawString.charCodeAt(cursor) !== 44) {
        if (cursor - tokenStart >= limits.maxTokenLength) throw new Error("Replay token length exceeds parser limit");
        cursor++;
        if (++scannedCharacters % 32768 === 0) { yield; limits.signal?.throwIfAborted(); }
      }
      comma = cursor === rawString.length ? -1 : cursor;
    } else comma = rawString.indexOf(",", tokenStart);
    const tokenEnd = comma < 0 ? rawString.length : comma;
    if (limits && tokenEnd - tokenStart > limits.maxTokenLength) throw new Error("Replay token length exceeds parser limit");
    const token = rawString.slice(tokenStart, tokenEnd);
    tokenStart = tokenEnd + 1;
    // Only the first four fields have meaning; avoid allocating arbitrary extra fields.
    const split = token.split("|", 4);
    if (split.length < 4) {
      // The final empty token is the ordinary stream delimiter, not lost input.
      skipped(i, comma < 0 && token === "" ? "empty-token" : "malformed-token");
      continue;
    }

    if (split[0] === "-12345") {
      // osu-lazer-comment: The seed is provided in split[3], which we'll need to use at some point
      skipped(i, "seed");
      continue;
    }

    const diff = parseFloat(split[0]);
    const mouseX = parseFloat(split[1]);
    const mouseY = parseFloat(split[2]);
    const b = parseInt(split[3]);
    if (![diff, mouseX, mouseY, b].every(Number.isFinite)) {
      throw Error("Replay frame contains a non-finite time, position or button mask");
    }
    if (Math.abs(mouseX) > MAX_COORDINATE_VALUE || Math.abs(mouseY) > MAX_COORDINATE_VALUE) {
      throw Error("Value overflow while parsing mouse coordinates");
    }
    const timeBefore = lastTime;
    lastTime += diff;
    if (!Number.isFinite(lastTime)) throw Error("Value overflow while parsing replay time");
    if (diagnostics && i < 4) prefix.push({ rawTokenIndex:i, delta:diff, x:mouseX, y:mouseY, rawButtonMask:b, timeBefore, timeAfter:lastTime });
    if (diagnostics && i < REPLAY_RELEASED_PREFIX_MAX_TOKENS)
      releasedPrefix.push({rawTokenIndex:i,delta:diff,x:mouseX,y:mouseY,rawButtonMask:b,timeBefore,timeAfter:lastTime});
    if (i < 2 && mouseX === 256 && mouseY === -500) {
      // at the start of the replay, stable places two replay frames, at time 0 and SkipBoundary - 1, respectively.
      // both frames use a position of (256, -500).
      // ignore these frames as they serve no real purpose (and can even mislead ruleset-specific handlers - see mania)
      skipped(i, "stable-sentinel");
      continue;
    }

    // osu-lazer-comment: At some point we probably want to rewind and play back the negative-time frames
    // but for now we'll achieve equal playback to stable by skipping negative frames

    if (diff < 0) {
      finalReset=i; releasedFrame=-1;
      neutralFrame=-1; resetCount++;
      skipped(i, "negative-delta");
      continue;
    }
    if (limits && frames.length >= limits.maxFrames) throw new Error("Replay frame count exceeds parser limit");
    const actions: OsuAction[] = [];

    if (bitmaskCheck(b, ReplayButtonState.Left1) || bitmaskCheck(b, ReplayButtonState.Left2))
      actions.push(OsuAction.leftButton);
    if (bitmaskCheck(b, ReplayButtonState.Right1) || bitmaskCheck(b, ReplayButtonState.Right2))
      actions.push(OsuAction.rightButton);

    if (diagnostics) {
      if (i !== frames.length + 3 || frames.length > 0 && discontinuityBefore.length > 0) adjacentSuffix = false;
      if (i !== frames.length + 1 || frames.length > 0 && discontinuityBefore.length > 0) initialNegativeSuffix = false;
      diagnostics.frameSources.push({
        origin: "parsed",
        parsedFrameIndex: frames.length,
        rawTokenIndex: i,
        ...(discontinuityBefore.length ? { discontinuityBefore } : {}),
      });
      discontinuityBefore = [];
    }
    frames.push({ actions, position: { x: mouseX, y: mouseY }, rawButtonMask: b, time: lastTime });
    if(diagnostics&&finalReset>=2){
      if(neutralFrame<0&&b===0)neutralFrame=frames.length-1;
      if(actions.length)heldRetained=true;
      if(releasedFrame<0&&b===0&&heldRetained)releasedFrame=frames.length-1;
    }
  }

  // Zero-delta samples can move the cursor or release/re-press a key. Keep each
  // recorded position paired with its own input for both gameplay and display.
  limits?.signal?.throwIfAborted();
  if (diagnostics && adjacentSuffix && frames.length && prefix.length === 4 && prefix.every((token,index)=>token.rawTokenIndex===index&&token.rawButtonMask===0) &&
    prefix[0].x===256 && prefix[0].y===-500 && prefix[1].x===256 && prefix[1].y===-500 && prefix[2].delta<0 && prefix[3].delta>=0) {
    const skipped = diagnostics.skippedTokens;
    let next=frames.length+3,index=3;
    const leading=skipped[0]?.rawTokenIndex===0&&skipped[0]?.reason==="stable-sentinel"&&skipped[1]?.rawTokenIndex===1&&skipped[1]?.reason==="stable-sentinel"&&
      skipped[2]?.rawTokenIndex===2&&skipped[2]?.reason==="negative-delta";
    if(skipped[index]?.reason==="seed"&&skipped[index].rawTokenIndex===next){index++;next++;}
    if(skipped[index]?.reason==="empty-token"&&skipped[index].rawTokenIndex===next){index++;next++;}
    if(leading&&index===skipped.length&&next===rawTokenCount)diagnostics.leadingResetWitness={version:REPLAY_LEADING_RESET_WITNESS_VERSION,
      parserVersion:REPLAY_PARSER_VERSION,tokens:prefix.map(token=>({...token})),frameCount:frames.length,rawTokenCount};
  }
  if (diagnostics && initialNegativeSuffix && frames.length && prefix.length>=2 &&
    prefix[0].rawTokenIndex===0 && prefix[0].delta<0 && prefix[0].rawButtonMask===0 &&
    prefix[1].rawTokenIndex===1 && prefix[1].delta>0 && prefix[1].rawButtonMask===0) {
    const skipped=diagnostics.skippedTokens;
    let next=frames.length+1,index=1;
    const initial=skipped[0]?.rawTokenIndex===0&&skipped[0]?.reason==="negative-delta";
    if(skipped[index]?.reason==="seed"&&skipped[index].rawTokenIndex===next){index++;next++;}
    if(skipped[index]?.reason==="empty-token"&&skipped[index].rawTokenIndex===next){index++;next++;}
    if(initial&&index===skipped.length&&next===rawTokenCount)diagnostics.initialNegativeWitness={version:REPLAY_INITIAL_NEGATIVE_WITNESS_VERSION,
      parserVersion:REPLAY_PARSER_VERSION,tokens:prefix.slice(0,2).map(token=>({...token})),frameCount:frames.length,rawTokenCount};
  }
  // Reuse the bounded consumed-prefix inventory; never search or copy an unbounded prefix.
  if(diagnostics&&initialNegativeSuffix&&!diagnostics.initialNegativeWitness&&releasedPrefix[0]?.delta<0&&
    releasedPrefix[0].rawButtonMask===0&&(releasedPrefix[1]?.rawButtonMask&15)!==0){
    const releaseRaw=releasedPrefix.findIndex((token,index)=>index>0&&token.rawButtonMask===0);
    if(releaseRaw>=2){
      const skipped=diagnostics.skippedTokens;let next=frames.length+1,index=1;
      const initial=skipped[0]?.rawTokenIndex===0&&skipped[0]?.reason==="negative-delta";
      if(skipped[index]?.reason==="seed"&&skipped[index]?.rawTokenIndex===next){index++;next++;}
      if(skipped[index]?.reason==="empty-token"&&skipped[index]?.rawTokenIndex===next){index++;next++;}
      if(initial&&index===skipped.length&&next===rawTokenCount)diagnostics.initialHeldPrefixWitness={
        version:REPLAY_INITIAL_HELD_PREFIX_WITNESS_VERSION,parserVersion:REPLAY_PARSER_VERSION,
        tokens:releasedPrefix.slice(0,releaseRaw+1),releaseFrameIndex:releaseRaw-1,frameCount:frames.length,rawTokenCount};
    }
  }
  if(diagnostics&&!diagnostics.leadingResetWitness&&releasedFrame>=0&&finalReset>=2){
    const releaseRaw=diagnostics.frameSources[releasedFrame].rawTokenIndex,tokens=releasedPrefix.slice(0,releaseRaw+1);
    const a=tokens[0],b=tokens[1],skipped=diagnostics.skippedTokens;
    // This additional witness never substitutes for a missing/corrupted old neutral witness.
    // A genuinely held retained prefix, released sentinels and complete token inventory are required.
    if(releaseRaw<REPLAY_RELEASED_PREFIX_MAX_TOKENS&&tokens.length===releaseRaw+1&&tokens.every((t,i)=>t.rawTokenIndex===i)&&
      a?.x===256&&a.y===-500&&a.rawButtonMask===0&&b?.x===256&&b.y===-500&&b.rawButtonMask===0&&
      skipped.length<=REPLAY_RELEASED_PREFIX_MAX_TOKENS+2){
      const expected=tokens.flatMap((t,i)=>i<2?[{rawTokenIndex:i,reason:"stable-sentinel"}]:t.delta<0?[{rawTokenIndex:i,reason:"negative-delta"}]:[]);
      let next=releaseRaw+1+(frames.length-releasedFrame-1);
      if(skipped[expected.length]?.rawTokenIndex===next&&skipped[expected.length]?.reason==="seed"){expected.push({rawTokenIndex:next++,reason:"seed"});}
      if(skipped[expected.length]?.rawTokenIndex===next&&skipped[expected.length]?.reason==="empty-token"){expected.push({rawTokenIndex:next++,reason:"empty-token"});}
      if(next===rawTokenCount&&JSON.stringify(expected)===JSON.stringify(skipped))diagnostics.releasedPrefixWitness={
        version:REPLAY_RELEASED_PREFIX_WITNESS_VERSION,parserVersion:REPLAY_PARSER_VERSION,tokens,releaseFrameIndex:releasedFrame,frameCount:frames.length,rawTokenCount};
    }
  }
  // Earlier explicit neutrality is a separate proof shape. Do not wait for
  // ordinary gameplay to introduce a held->released transition into its bound.
  if(diagnostics&&!diagnostics.leadingResetWitness&&!diagnostics.initialNegativeWitness&&(resetCount>=2||resetCount===1&&finalReset>2)&&neutralFrame>=0){
    const releaseRaw=diagnostics.frameSources[neutralFrame].rawTokenIndex,tokens=releasedPrefix.slice(0,releaseRaw+1);
    const a=tokens[0],b=tokens[1],skipped=diagnostics.skippedTokens;
    if(releaseRaw<REPLAY_RELEASED_PREFIX_MAX_TOKENS&&tokens.length===releaseRaw+1&&
      tokens.every((t,i)=>t.rawTokenIndex===i&&t.rawButtonMask===0)&&
      a?.x===256&&a.y===-500&&a.delta===0&&b?.x===256&&b.y===-500&&
      skipped.length<=REPLAY_RELEASED_PREFIX_MAX_TOKENS+2){
      const expected=tokens.flatMap((t,i)=>i<2?[{rawTokenIndex:i,reason:"stable-sentinel"}]:t.delta<0?[{rawTokenIndex:i,reason:"negative-delta"}]:[]);
      let next=releaseRaw+1+(frames.length-neutralFrame-1);
      if(skipped[expected.length]?.rawTokenIndex===next&&skipped[expected.length]?.reason==="seed"){expected.push({rawTokenIndex:next++,reason:"seed"});}
      if(skipped[expected.length]?.rawTokenIndex===next&&skipped[expected.length]?.reason==="empty-token"){expected.push({rawTokenIndex:next++,reason:"empty-token"});}
      if(next===rawTokenCount&&JSON.stringify(expected)===JSON.stringify(skipped))diagnostics.neutralPrefixWitness={
        version:resetCount===1?REPLAY_NEUTRAL_LATER_RESET_WITNESS_VERSION:REPLAY_NEUTRAL_PREFIX_WITNESS_VERSION,parserVersion:REPLAY_PARSER_VERSION,tokens,releaseFrameIndex:neutralFrame,frameCount:frames.length,rawTokenCount};
    }
  }
  return frames;
}
