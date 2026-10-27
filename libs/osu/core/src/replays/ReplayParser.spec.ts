import { OsuAction, ReplayButtonState, ReplayFrame } from "./Replay";
import { parseReplayFramesFromRaw, parseReplayFramesWithDiagnostics, parseReplayFramesWithDiagnosticsAsync } from "./ReplayParser";

it.each(["", "3279|100|192|5,1|100|192|0,"])("attests the earlier all-neutral multi-reset checkpoint before later gameplay: %s",async suffix=>{
  const raw="0|256|-500|0,10695|256|-500|0,-10673|100|192|0,0|100|192|0,10779|100|192|0,-10|100|192|0,23|100|192|0,"+suffix;
  const parsed=parseReplayFramesWithDiagnostics(raw);
  expect(parsed.diagnostics).toMatchObject({neutralPrefixWitness:{version:"stable-neutral-multi-reset-v1",releaseFrameIndex:2,
    tokens:expect.arrayContaining([{rawTokenIndex:6,delta:23,x:100,y:192,rawButtonMask:0,timeBefore:10791,timeAfter:10814}])}});
  expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
  expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
  expect(parsed.diagnostics.leadingResetWitness).toBeUndefined();
  expect(await parseReplayFramesWithDiagnosticsAsync(raw,{maxRawLength:4096,maxTokenLength:128,maxTokens:64,maxFrames:64},async()=>undefined)).toEqual(parsed);
});
it.each([
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,50|100|192|5,-10|100|192|0,20|100|192|0,",
  "0|256|-500|1,100|256|-500|0,-100|100|192|0,0|100|192|0,50|100|192|0,-10|100|192|0,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,bad,-10|100|192|0,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,-10|100|192|0,20|100|192|0,bad",
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,-10|100|192|0,20|100|192|0,-12345|0|0|7,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,-10|100|192|0,",
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,20|100|192|0,",
])("does not substitute neutral multi-reset evidence for held/missing/ambiguous input: %s",raw=>{
  const parsed=parseReplayFramesWithDiagnostics(raw);
  expect(parsed.diagnostics.neutralPrefixWitness).toBeUndefined();expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
});
it.each([250,251])("bounds the complete neutral prefix at its existing raw-token cap: %s",count=>{
  const raw="0|256|-500|0,0|256|-500|0,-1|100|192|0,1|100|192|0,"+"0|100|192|0,".repeat(count)+"-1|100|192|0,1|100|192|0,1000|100|192|5,";
  const parsed=parseReplayFramesWithDiagnostics(raw),w=parsed.diagnostics.neutralPrefixWitness;
  expect(w!==undefined).toBe(count===250);if(w)expect(w.tokens).toHaveLength(256);
  expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));expect(parsed.frames).toHaveLength(count+3);
});
it.each(["",",","-12345|0|0|7","-12345|0|0|7,"])("serializes the complete optional neutral-prefix terminal inventory: %s",tail=>{
  const prefix="0|256|-500|0,0|256|-500|0,-1|100|192|0,1|100|192|0,-1|100|192|0,1|100|192|0";
  const parsed=parseReplayFramesWithDiagnostics(prefix+(tail.startsWith("-12345")?",":"")+tail),w=parsed.diagnostics.neutralPrefixWitness;
  expect(w).toMatchObject({frameCount:2,releaseFrameIndex:1});
  expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  if(!w)throw Error("Expected neutral witness");const before=JSON.stringify(parsed.frames);w.tokens[5].x++;expect(JSON.stringify(parsed.frames)).toBe(before);
});

it("attests the released checkpoint only after the final startup reset without rewriting held frames", async () => {
  const raw="0|256|-500|0,2491|256|-500|0,-2491|140|166|5,43|140|166|0,2483|150|166|5,-1|150|166|0,79|193|182|0,2288|100|192|5,100|100|192|0,";
  const parsed=parseReplayFramesWithDiagnostics(raw);
  expect(parsed.diagnostics).toMatchObject({releasedPrefixWitness:{version:"stable-released-prefix-v1",releaseFrameIndex:2,
    tokens:expect.arrayContaining([{rawTokenIndex:6,delta:79,x:193,y:182,rawButtonMask:0,timeBefore:2525,timeAfter:2604}])}});
  expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
  expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
  expect(await parseReplayFramesWithDiagnosticsAsync(raw,{maxRawLength:4096,maxTokenLength:128,maxTokens:64,maxFrames:64},async()=>undefined)).toEqual(parsed);
});
it.each([
  "0|256|-500|1,0|256|-500|0,-1|100|192|5,1|100|192|5,1|100|192|0,",
  "0|256|-500|0,0|256|-500|0,-1|100|192|5,1|100|192|0,",
  "0|256|-500|0,0|256|-500|0,-1|100|192|5,1|100|192|5,bad,1|100|192|0,",
  "0|256|-500|0,0|256|-500|0,-1|100|192|5,1|100|192|5,1|100|192|0,-1|100|192|5,",
  "0|256|-500|0,0|256|-500|0,-1|100|192|5,1|100|192|5,1|100|192|0,-12345|0|0|1,1|100|192|5,",
])("does not attest an incomplete/ambiguous released prefix: %s",raw=>{
  expect(parseReplayFramesWithDiagnostics(raw).diagnostics.releasedPrefixWitness).toBeUndefined();
});
it("bounds optional prefix evidence without truncating the retained replay",()=>{
  const prefix="0|256|-500|0,0|256|-500|0,-1|100|192|5,";
  for(const [held,admitted]of [[252,true],[253,false]] as const){
    const raw=prefix+"1|100|192|5,".repeat(held)+"1|100|192|0,1000|100|192|5,";
    const parsed=parseReplayFramesWithDiagnostics(raw);
    expect(parsed.diagnostics.releasedPrefixWitness!==undefined).toBe(admitted);
    expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));expect(parsed.frames.length).toBe(held+2);
  }
});

// w, x, y, z
// w time since last action
// x, y coordinates
// z bitmask of what was pressed
describe("Parsing rawReplayData (from node-osr)", function () {
  it.each([
    {prefix:"0|256|-500|0,-1|256|-500|0,-1093|298.6667|184|0,16|298.6667|184|0,",time:-1078,x:298.6667,y:184},
    {prefix:"0|256|-500|0,-1|256|-500|0,-1106|302.6667|176|0,17|302.6667|176.4444|0,",time:-1090,x:302.6667,y:176.4444},
    {prefix:"0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|301|192|0,",time:15,x:301,y:192},
  ])("attests released leading convergence without altering the positive-delta frame at $time",async fixture=>{
    const raw=fixture.prefix+"20|300|192|0,-12345|0|0|7,",parsed=parseReplayFramesWithDiagnostics(raw);
    expect(parsed.diagnostics.leadingResetWitness).toMatchObject({version:"stable-released-leading-reset-v2",frameCount:2,rawTokenCount:7});
    expect(parsed.frames[0]).toEqual({time:fixture.time,position:{x:fixture.x,y:fixture.y},actions:[],rawButtonMask:0});
    expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
    expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
    expect(await parseReplayFramesWithDiagnosticsAsync(raw,{maxRawLength:1024,maxTokenLength:128,maxTokens:32,maxFrames:32},async()=>undefined)).toEqual(parsed);
  });
  it("attests a distinct released native initial-negative prefix in sync and async parsing",async()=>{
    const raw="-900|280|180|0,20|300|192|0,5880|300|192|1,100|300|192|0,-12345|0|0|7";
    const parsed=parseReplayFramesWithDiagnostics(raw),asyncParsed=await parseReplayFramesWithDiagnosticsAsync(raw,
      {maxRawLength:1024,maxTokenLength:128,maxTokens:32,maxFrames:32},async()=>undefined);
    expect(parsed.diagnostics).toMatchObject({initialNegativeWitness:{version:"native-zero-initial-negative-v1",parserVersion:parsed.diagnostics.parserVersion,
      frameCount:3,rawTokenCount:5,tokens:[{rawTokenIndex:0,delta:-900,x:280,y:180,rawButtonMask:0,timeBefore:0,timeAfter:-900},
        {rawTokenIndex:1,delta:20,x:300,y:192,rawButtonMask:0,timeBefore:-900,timeAfter:-880}]}});
    expect(asyncParsed).toEqual(parsed);expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
    expect(parsed.diagnostics.leadingResetWitness).toBeUndefined();expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
    expect(parsed.diagnostics.frameSources[0].discontinuityBefore).toEqual(["parser-negative-delta"]);
  });
  it.each([
    "-900|280|180|1,20|300|192|0,",
    "-900|280|180|0,20|300|192|1,",
    "-900|280|180|0,0|300|192|0,",
    "-900|280|180|0,-20|300|192|0,",
    "-900|256|-500|0,20|300|192|0,",
    "-900|280|180|0,20|256|-500|0,",
    "-12345|0|0|1,20|300|192|0,",
    "bad,20|300|192|0,",
    "-900|280|180|0,bad,20|300|192|0,",
    "-900|280|180|0,20|300|192|0,-1|300|192|0,",
    "-900|280|180|0,20|300|192|0,bad",
    "-900|280|180|0,20|300|192|0,,30|300|192|0,",
    "-900|280|180|0,20|300|192|0,-12345|0|0|1,30|300|192|0,",
    "-900|280|180|0,20|300|192|0,-12345|0|0|1,-12345|0|0|1,",
    "-900|280|180|0,20|300|192|0,-1|300|192|0",
  ])("does not attest nonneutral or incomplete native initial-negative input: %s",raw=>{
    const parsed=parseReplayFramesWithDiagnostics(raw);expect(parsed.diagnostics.initialNegativeWitness).toBeUndefined();
    expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
  });
  it.each(["",",","-12345|0|0|9","-12345|0|0|9,"])("attests exact native terminal seed/delimiter inventory %s",tail=>{
    const prefix="-900|280|180|0,20|300|192|0",raw=tail.startsWith("-12345")?prefix+","+tail:prefix+tail;
    const parsed=parseReplayFramesWithDiagnostics(raw),witness=parsed.diagnostics.initialNegativeWitness;
    expect(witness?.frameCount).toBe(1);if(!witness)throw new Error("Expected initial-negative witness fixture");
    const frames=JSON.stringify(parsed.frames);witness.tokens[1].x=1;expect(JSON.stringify(parsed.frames)).toBe(frames);
  });
  it("attests a neutral canonical leading reset without changing frames or warnings",()=>{
    const raw="0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,4985|300|192|5,100|300|192|0,-12345|0|0|7,";
    const parsed=parseReplayFramesWithDiagnostics(raw),proof=(parsed.diagnostics as unknown as Record<string,unknown>).leadingResetWitness;
    expect(proof).toMatchObject({version:"stable-released-leading-reset-v2",parserVersion:parsed.diagnostics.parserVersion,frameCount:3,rawTokenCount:8,
      tokens:[{rawTokenIndex:0,delta:0,timeBefore:0,timeAfter:0,rawButtonMask:0},{rawTokenIndex:1,delta:1000,timeBefore:0,timeAfter:1000,rawButtonMask:0},
        {rawTokenIndex:2,delta:-985,timeBefore:1000,timeAfter:15,rawButtonMask:0},{rawTokenIndex:3,delta:0,timeBefore:15,timeAfter:15,rawButtonMask:0}]});
    expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));expect(parsed.frames.map(frame=>frame.time)).toEqual([15,5000,5100]);
    expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
    expect(parsed.diagnostics.frameSources[0].discontinuityBefore).toEqual(["parser-negative-delta"]);expect(parsed.diagnostics.initialActionsKnown).toBe(false);
  });
  it.each([
    "0|255|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,",
    "0|256|-500|1,1000|256|-500|0,-985|300|192|0,0|300|192|0,",
    "0|256|-500|0,1000|256|-500|1,-985|300|192|0,0|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|1,0|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|1,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,-1|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,-1|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,bad",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,,100|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,-12345|0|0|1,100|300|192|0,",
    "0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,-12345|0|0|1,-12345|0|0|1,",
  ])("does not attest a noncanonical or later/trailing-discontinuous prefix: %s",raw=>{
    const parsed=parseReplayFramesWithDiagnostics(raw);
    expect(parsed.diagnostics.leadingResetWitness).toBeUndefined();expect(parsed.frames).toEqual(parseReplayFramesFromRaw(raw));
  });
  it.each(["",",","-12345|0|0|9","-12345|0|0|9,"])("accounts for exact optional terminal seed/delimiter %s",tail=>{
    const prefix="0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0";
    const raw=tail.startsWith("-12345")?prefix+","+tail:prefix+tail,parsed=parseReplayFramesWithDiagnostics(raw);
    expect(parsed.diagnostics.leadingResetWitness?.frameCount).toBe(1);
    const witness=parsed.diagnostics.leadingResetWitness;if(!witness)throw new Error("Expected reset witness fixture");
    const before=JSON.stringify(parsed.frames);witness.tokens[3].x=1;expect(JSON.stringify(parsed.frames)).toBe(before);
  });
  it.each([
    "NaN|256|192|1",
    "Infinity|256|192|0",
    "100|NaN|192|1",
    "100|256|NaN|0",
    "100|256|192|NaN",
    "1e308|256|192|0,1e308|256|192|0",
  ])("rejects non-finite frame data before simulation: %s", (raw) => {
    expect(() => parseReplayFramesFromRaw(raw)).toThrow(/non-finite|overflow/i);
  });
  it("should ignore the first three frames from legacy due to negative", function () {
    // From RyuK +HDDT Akatsuki Zukuyo replay
    const raw = "0|256|-500|0,-1|256|-500|0,-1171|257.0417|124.7764|1";
    const actual = parseReplayFramesFromRaw(raw);
    expect(actual).toStrictEqual([]);
  });
  it("should have the first correct frame", function () {
    // From RyuK +HDDT Akatsuki Zukuyo replay
    const raw = "0|256|-500|0,-1|256|-500|0,-1171|257.0417|124.7764|1,13|256.8854|124.8789|1";
    const f1: ReplayFrame = {
      time: -1171 - 1 + 13,
      position: { x: 256.8854, y: 124.8789 },
      actions: [OsuAction.leftButton],
      rawButtonMask: ReplayButtonState.Left1,
    };
    const actual = parseReplayFramesFromRaw(raw);
    expect(actual).toEqual([f1]);
  });

  it("retains each zero-delta position and input state in recorded order", () => {
    const raw = "0|256|-500|0,0|256|-500|0,1000|100|100|1,0|120|100|0";
    expect(parseReplayFramesFromRaw(raw)).toEqual([
      {
        time: 1_000,
        position: { x: 100, y: 100 },
        actions: [OsuAction.leftButton],
        rawButtonMask: ReplayButtonState.Left1,
      },
      {
        time: 1_000,
        position: { x: 120, y: 100 },
        actions: [],
        rawButtonMask: ReplayButtonState.None,
      },
    ]);
  });
});

// R11: preserve the exact initial negative/held/released source shape.
it("attests the bounded initial-negative held-to-released prefix without rewriting frames",async()=>{
  const raw="-1575|281|248|0,13|281|248|1,17|282|247|1,0|283|246|1,1|284|245|0,1969|300|192|1,1|300|192|0,-12345|0|0|7,";
  const parsed=parseReplayFramesWithDiagnostics(raw);
  expect(parsed.diagnostics).toMatchObject({initialHeldPrefixWitness:{version:"native-initial-held-release-v1",releaseFrameIndex:3,frameCount:6,rawTokenCount:9}});
  expect(parsed.diagnostics.initialNegativeWitness).toBeUndefined();
  expect(parsed.frames.map(f=>[f.time,f.rawButtonMask])).toEqual([[-1562,1],[-1545,1],[-1545,1],[-1544,0],[425,1],[426,0]]);
});

it.each([
  "-900|280|180|1,20|300|192|1,20|300|192|0,",
  "-900|280|180|0,20|300|192|0,20|300|192|1,20|300|192|0,",
  "-900|280|180|0,20|300|192|16,20|300|192|0,",
  "-900|280|180|0,20|300|192|1,-1|300|192|1,20|300|192|0,",
  "-900|280|180|0,20|300|192|1,bad,20|300|192|0,",
  "-900|280|180|0,20|300|192|1,20|300|192|0,-1|300|192|0,",
  "-900|280|180|0,20|300|192|1,20|300|192|0,,",
])("never attests a held-initial prefix with missing or contradictory inventory: %s",raw=>{
  expect(parseReplayFramesWithDiagnostics(raw).diagnostics.initialHeldPrefixWitness).toBeUndefined();
});
it("serialises optional held-initial facts independently of mutable frames and without upgrading old witnesses",()=>{
  const parsed=parseReplayFramesWithDiagnostics("-900|280|180|0,20|300|192|1,0|301|192|0,1|300|192|1,");
  const before=JSON.parse(JSON.stringify(parsed.diagnostics));expect(before.initialHeldPrefixWitness.tokens).toHaveLength(3);
  parsed.frames[1].position.x++;
  expect(parsed.diagnostics).toEqual(before);expect(parsed.diagnostics.initialNegativeWitness).toBeUndefined();
});

it("attests a distinct one-later-reset neutral prefix after genuine retained input",()=>{
  const raw="0|256|-500|0,5870|256|-500|0,50|143.3076|222.4999|0,15|141.9343|218.7231|0,-11|141.2476|216.3197|0,17|140.5609|213.573|0,4059|100|192|5,1|100|192|0,";
  const parsed=parseReplayFramesWithDiagnostics(raw);
  expect(parsed.diagnostics).toMatchObject({neutralPrefixWitness:{version:"stable-neutral-later-reset-v1",releaseFrameIndex:2,frameCount:5,rawTokenCount:9}});
  expect(parsed.frames.map(f=>f.time)).toEqual([5920,5935,5941,10000,10001]);
  expect(parsed.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
});

it.each([
  "0|256|-500|0,100|256|-500|0,-100|100|192|0,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,20|100|192|0,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,20|100|192|5,-10|100|192|0,20|100|192|0,",
  "0|256|-500|0,100|256|-500|0,bad,-10|100|192|0,20|100|192|0,",
])("does not invent single-later-reset proof without complete neutral retained-before-reset input: %s",raw=>{
  expect(parseReplayFramesWithDiagnostics(raw).diagnostics.neutralPrefixWitness).toBeUndefined();
});
