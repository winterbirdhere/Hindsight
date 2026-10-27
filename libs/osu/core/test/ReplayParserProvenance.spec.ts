import { OsuAction } from "../src/replays/Replay";
import * as ReplayParser from "../src/replays/ReplayParser";

const parse = ReplayParser.parseReplayFramesWithDiagnostics;

describe("replay parser source provenance", () => {
  it("assigns raw token and emitted frame indices without changing same-time frame order", () => {
    const raw = "0|256|-500|0,-1|256|-500|0,101|100|120|1,0|200|120|0,-12345|0|0|42,0|300|120|2,";
    const result = parse(raw);
    expect(result.frames).toEqual([
      { time: 100, position: { x: 100, y: 120 }, actions: [OsuAction.leftButton], rawButtonMask: 1 },
      { time: 100, position: { x: 200, y: 120 }, actions: [], rawButtonMask: 0 },
      { time: 100, position: { x: 300, y: 120 }, actions: [OsuAction.rightButton], rawButtonMask: 2 },
    ]);
    expect(result.diagnostics.frameSources).toEqual([
      { origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 2 },
      { origin: "parsed", parsedFrameIndex: 1, rawTokenIndex: 3 },
      { origin: "parsed", parsedFrameIndex: 2, rawTokenIndex: 5 },
    ]);
    expect(result.diagnostics.skippedTokens).toEqual([
      { rawTokenIndex: 0, reason: "stable-sentinel" },
      { rawTokenIndex: 1, reason: "stable-sentinel" },
      { rawTokenIndex: 4, reason: "seed" },
      { rawTokenIndex: 6, reason: "empty-token" },
    ]);
    expect(ReplayParser.parseReplayFramesFromRaw(raw)).toEqual(result.frames);
  });

  it("marks dropped malformed and negative-delta samples as a discontinuity while retaining cumulative time", () => {
    const result = parse("100|10|20|1,short,-40|30|40|0,10|50|60|2,0|70|80|0");
    expect(result.frames.map((frame: { time: number }) => frame.time)).toEqual([100, 70, 70]);
    expect(result.diagnostics.frameSources).toEqual([
      { origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 0 },
      {
        origin: "parsed",
        parsedFrameIndex: 1,
        rawTokenIndex: 3,
        discontinuityBefore: ["parser-malformed-token", "parser-negative-delta"],
      },
      { origin: "parsed", parsedFrameIndex: 2, rawTokenIndex: 4 },
    ]);
    expect(result.diagnostics.skippedTokens).toEqual([
      { rawTokenIndex: 1, reason: "malformed-token" },
      { rawTokenIndex: 2, reason: "negative-delta" },
    ]);
    expect(result.diagnostics.sourceCoverageLimits).toEqual([
      "initial-actions-unknown",
      "parser-malformed-token",
      "parser-negative-delta",
    ]);
  });

  it("retains a trailing dropped sample as a global limitation when there is no following frame", () => {
    const result = parse("100|10|20|0,bad");
    expect(result.diagnostics.frameSources).toEqual([{ origin: "parsed", parsedFrameIndex: 0, rawTokenIndex: 0 }]);
    expect(result.diagnostics.sourceCoverageLimits).toContain("parser-malformed-token");
  });

  it("marks interior empty tokens as gaps but does not mistake the terminal delimiter for missing input", () => {
    const result = parse("100|10|20|0,,10|30|40|1,");
    expect(result.diagnostics.frameSources[1].discontinuityBefore).toEqual(["parser-malformed-token"]);
    expect(result.diagnostics.skippedTokens).toEqual([
      { rawTokenIndex: 1, reason: "malformed-token" },
      { rawTokenIndex: 3, reason: "empty-token" },
    ]);
  });

  it.each(["0|256|-500|0,0|256|-500|0,100|10|20|1,", "0|10|20|0,", ""])(
    "never invents an initial released action state from sentinels or synthetic emptiness: %s",
    (raw) => {
      const result = parse(raw);
      expect(result.diagnostics.initialActionsKnown).toBe(false);
      expect(result.diagnostics.sourceCoverageLimits).toEqual(["initial-actions-unknown"]);
      expect(result.diagnostics.parserVersion).toEqual(expect.any(String));
    },
  );

  it.each([
    "NaN|256|192|1",
    "Infinity|256|192|0",
    "100|NaN|192|1",
    "100|256|192|NaN",
    "100|131073|192|0",
    "1e308|256|192|0,1e308|256|192|0",
  ])("preserves parser rejection rather than dropping malformed numeric data: %s", (raw) => {
    expect(() => parse(raw)).toThrow(/non-finite|overflow/i);
    expect(() => ReplayParser.parseReplayFramesFromRaw(raw)).toThrow(/non-finite|overflow/i);
  });

  it("retains legacy numeric parsing, sentinel position rules and seed matching exactly", () => {
    const raw = "bad,0|256|-500|0,1junk|256|-500|5extra,-12345|invalid|invalid|seed";
    expect(parse(raw).frames).toEqual([
      { time: 1, position: { x: 256, y: -500 }, actions: [OsuAction.leftButton], rawButtonMask: 5 },
    ]);
  });
});
