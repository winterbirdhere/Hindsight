import { parseReplayFramesWithDiagnostics, parseReplayFramesWithDiagnosticsAsync } from "./ReplayParser";

const limits = { maxRawLength: 4096, maxTokenLength: 256, maxTokens: 32, maxFrames: 16 };
const parse = parseReplayFramesWithDiagnostics;

describe("bounded replay parsing", () => {
  it("retains neutral-prefix evidence across yields and cancels without publishing it",async()=>{
    const raw="0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,50|100|192|0,-10|100|192|0,20|100|192|0,"+"1|100|192|0,".repeat(2048);
    const bounded={...limits,maxRawLength:40000,maxTokens:3000,maxFrames:3000};let yields=0;
    const parsed=await parseReplayFramesWithDiagnosticsAsync(raw,bounded,async()=>{yields++;});
    expect(parsed.diagnostics.neutralPrefixWitness).toBeDefined();expect(parsed).toEqual(parse(raw,bounded));expect(yields).toBeGreaterThan(1);
    const controller=new AbortController();let cancelledYields=0;
    await expect(parseReplayFramesWithDiagnosticsAsync(raw,{...bounded,signal:controller.signal},async()=>{cancelledYields++;controller.abort();})).rejects.toThrow(/abort/i);
    expect(cancelledYields).toBe(1);
    expect(()=>parse(raw,{...bounded,maxSkippedTokens:3})).toThrow(/diagnostic.*limit/i);
  });
  it("preserves zero-delta order, sentinels, discontinuities and trailing-token provenance", () => {
    const result = parse("0|256|-500|0,-1|256|-500|0,-2|1|1|0,bad,10|2|3|5,0|4|5|0,-12345|0|0|99,", limits);
    expect(result.frames).toEqual([
      { time: 7, position: { x: 2, y: 3 }, rawButtonMask: 5, actions: [0] },
      { time: 7, position: { x: 4, y: 5 }, rawButtonMask: 0, actions: [] },
    ]);
    expect(result.diagnostics.frameSources).toEqual([
      { origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 4, discontinuityBefore: ["parser-negative-delta", "parser-malformed-token"] },
      { origin: "parsed", parsedFrameIndex: 1, rawTokenIndex: 5 },
    ]);
    expect(result.diagnostics.skippedTokens).toEqual([
      { rawTokenIndex: 0, reason: "stable-sentinel" }, { rawTokenIndex: 1, reason: "stable-sentinel" },
      { rawTokenIndex: 2, reason: "negative-delta" }, { rawTokenIndex: 3, reason: "malformed-token" },
      { rawTokenIndex: 6, reason: "seed" }, { rawTokenIndex: 7, reason: "empty-token" },
    ]);
  });
  it("refuses oversized raw input before attempting to interpret it", () => {
    expect(() => parse("NaN|0|0|0", { ...limits, maxRawLength: 8 })).toThrow(/raw.*limit/i);
  });
  it("bounds malformed-token diagnostics including the trailing token", () => {
    expect(() => parse(",,,", { ...limits, maxTokens: 3 })).toThrow(/token.*limit/i);
    expect(parse(",,", { ...limits, maxTokens: 3 }).diagnostics.skippedTokens).toHaveLength(3);
    expect(() => parse("bad,bad", { ...limits, maxSkippedTokens: 1 })).toThrow(/diagnostic.*limit/i);
  });
  it("rejects an oversized individual token without splitting all its fields", () => {
    expect(() => parse("0|0|0|0||||||||", { ...limits, maxTokenLength: 8 })).toThrow(/token.*limit/i);
  });
  it("bounds emitted frames while preserving exact-limit inputs", () => {
    expect(() => parse("0|0|0|0,0|0|0|0", { ...limits, maxFrames: 1 })).toThrow(/frame.*limit/i);
    expect(parse("0|0|0|0,", { ...limits, maxFrames: 1 }).frames).toHaveLength(1);
  });
  it("rejects invalid budgets rather than silently disabling them", () => {
    for (const value of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => parse("", { ...limits, maxTokens: value })).toThrow(/invalid.*limit/i);
    }
  });
  it("honours pre-cancelled work before publishing frames", () => {
    const controller = new AbortController(); controller.abort();
    expect(() => parse("0|0|0|0", { ...limits, signal: controller.signal })).toThrow(/abort/i);
  });
  it("yields between batches so cancellation can stop work without a partial result", async () => {
    const controller = new AbortController(); let checkpoints = 0;
    const pending = parseReplayFramesWithDiagnosticsAsync("0|1|2|1,".repeat(2048),
      { ...limits, maxRawLength: 30000, maxTokens: 3000, maxFrames: 3000, signal: controller.signal }, async () => {
        checkpoints++; controller.abort();
      });
    await expect(pending).rejects.toThrow(/abort/i); expect(checkpoints).toBe(1);
  });
  it("checks cancellation while scanning a delimiter-free token and before publication", async () => {
    for (const raw of ["x".repeat(100000), "0|1|2|0"]) {
      const controller = new AbortController(); let checkpoints = 0;
      await expect(parseReplayFramesWithDiagnosticsAsync(raw,
        { ...limits, maxRawLength: 200000, maxTokenLength: 200000, signal: controller.signal }, async () => {
          checkpoints++; controller.abort();
        })).rejects.toThrow(/abort/i);
      expect(checkpoints).toBe(1);
    }
  });
  it("keeps async output equal to the legacy provenance through several yields", async () => {
    const raw = "0|256|-500|0,-1|256|-500|0," + "5|1.25|2.5|0x10,broken,-1|0|0|0,0|4|5|2|ignored,".repeat(800) + "-12345|NaN|NaN|seed,";
    let yields = 0;
    const result = await parseReplayFramesWithDiagnosticsAsync(raw,
      { ...limits, maxRawLength: 100000, maxTokens: 4000, maxFrames: 2000 }, async () => { yields++; });
    expect(result).toEqual(parseReplayFramesWithDiagnostics(raw)); expect(yields).toBeGreaterThan(1);
  });
});

it("bounds native held-initial witness to the existing256 tokens and preserves async cancellation",async()=>{
  for(const releaseRaw of [255,256]){
    const raw="-10000|280|180|0,"+"1|300|192|1,".repeat(releaseRaw-1)+"0|301|192|0,1|300|192|1,";
    const limits={maxRawLength:100000,maxTokenLength:4096,maxTokens:3000,maxFrames:3000};
    let yields=0;const actual=await parseReplayFramesWithDiagnosticsAsync(raw,limits,async()=>{yields++;});
    expect(actual).toEqual(parseReplayFramesWithDiagnostics(raw));expect(yields).toBeGreaterThan(0);
    expect(actual.frames).toHaveLength(releaseRaw+1);
    expect(actual.diagnostics.initialHeldPrefixWitness!==undefined).toBe(releaseRaw===255);
    if(releaseRaw===255)expect(actual.diagnostics.initialHeldPrefixWitness?.tokens).toHaveLength(256);
    const controller=new AbortController();
    await expect(parseReplayFramesWithDiagnosticsAsync(raw,{...limits,signal:controller.signal},async()=>controller.abort())).rejects.toThrow(/abort/i);
  }
});

it("bounds single-later-reset evidence without cutting the suffix or replacing prior witness shapes",async()=>{
  for(const releaseRaw of [255,256]){
    const raw="0|256|-500|0,100|256|-500|0,0|100|192|0,"+"1|100|192|0,".repeat(releaseRaw-4)+"-1|100|192|0,1|100|192|0,1|100|192|0,";
    const limits={maxRawLength:100000,maxTokenLength:4096,maxTokens:3000,maxFrames:3000};let yields=0;
    const actual=await parseReplayFramesWithDiagnosticsAsync(raw,limits,async()=>{yields++;});
    expect(actual).toEqual(parseReplayFramesWithDiagnostics(raw));expect(actual.frames).toHaveLength(releaseRaw-1);expect(yields).toBeGreaterThan(0);
    expect(actual.diagnostics.neutralPrefixWitness!==undefined).toBe(releaseRaw===255);
    if(releaseRaw===255)expect(actual.diagnostics.neutralPrefixWitness).toMatchObject({version:"stable-neutral-later-reset-v1",tokens:expect.any(Array)});
    const controller=new AbortController();await expect(parseReplayFramesWithDiagnosticsAsync(raw,{...limits,signal:controller.signal},async()=>controller.abort())).rejects.toThrow(/abort/i);
  }
});
