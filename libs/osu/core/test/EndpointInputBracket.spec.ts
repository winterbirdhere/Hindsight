import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { traceBeatmap, traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";

function fixture(profile: "stable" | "lazer") {
  const map = traceBeatmap("300,192,1000,1,0");
  const frames = [800,1000,1108,1112].map(t=>traceFrame(t,500,[],0));
  const domain = {
    endTimeMs:1112,endpointBasis:"health-derived" as const,synthesizedEndpoint:true,initialActionsKnown:false,
    sourceCoverageLimits:["initial-actions-unknown"],
    frameSources:[...frames.slice(0,3).map((_,i)=>({origin:"parsed" as const,parsedFrameIndex:i,rawTokenIndex:i+2})),
      {origin:"synthetic" as const,reason:"scoring-endpoint-interpolation"}],
    endpointInputBracket:{
      previous:{timeMs:1108,source:{origin:"parsed" as const,parsedFrameIndex:2,rawTokenIndex:4},actions:[],rawButtonMask:0},
      next:{timeMs:1120,source:{origin:"parsed" as const,parsedFrameIndex:3,rawTokenIndex:5},actions:[0],rawButtonMask:5},
    },
  };
  const capture = createReplayTraceCollector({schemaVersion:2,replayContentSha256:null,beatmapContentSha256:null,
    beatmapMd5:null,generationKey:"endpoint-bracket",recordingClient:profile,analysisProfileId:profile,
    analysisProfileFingerprint:"endpoint-bracket",parserVersion:"test",inputPreparationVersion:"test"},domain,
    {maxRecords:200000,maxExportBytes:64*1024*1024});
  const machine = profile === "stable"
    ? new BucketedGameStateTimeMachine(frames,map,{noteLockStyle:"STABLE",hitWindowStyle:"OSU_STABLE"},undefined,capture)
    : new LazerGameStateTimeMachine(frames,map,undefined,{},capture);
  const plain = profile === "stable"
    ? new BucketedGameStateTimeMachine(frames,map,{noteLockStyle:"STABLE",hitWindowStyle:"OSU_STABLE"})
    : new LazerGameStateTimeMachine(frames,map);
  const state = machine.gameStateAt(Infinity);
  expect(normalizeTraceState(state)).toEqual(normalizeTraceState(plain.gameStateAt(Infinity)));
  return {map,trace:capture.seal(),domain};
}

describe.each(["stable","lazer"] as const)("%s exact endpoint action bracket", profile => {
  it("proves the local action boundary without using synthetic geometry or the later press", () => {
    const f = fixture(profile), e = deriveCircleEvidence(f.trace,f.map,"0");
    expect(f.trace.records.some(r=>r.kind === "input" && r.timeMs === 1120)).toBe(false);
    expect(f.trace.domain.frameSources?.[3].origin).toBe("synthetic");
    expect(f.trace.coverage.input).toBe("partial");
    expect(e.dependencies.input.status).toBe("complete");
    expect(e.inputs.filter(i=>i.inLiveSuccess && i.record.freshActions.length)).toEqual([]);
    expect(e.insideIntervals).toEqual([]);
    expect(classifyCircleLoss(e,f.map,f.trace).headline).toBe("No tap");
    expect(e.limitations).toContain("inferred-or-synthetic-endpoint");
    const json = serializeReplayTrace(f.trace);
    f.domain.endpointInputBracket.next.actions.push(1);
    expect(serializeReplayTrace(f.trace)).toBe(json);
    expect(serializeReplayTrace(JSON.parse(json))).toBe(json);
  });
  it("rejects a forged adjacent source witness", () => {
    const f = fixture(profile);
    const forged = JSON.parse(serializeReplayTrace(f.trace));
    forged.domain.endpointInputBracket.previous.actions = [1];
    expect(()=>serializeReplayTrace(forged)).toThrow();
  });
  it.each(["synthetic-reason","raw-index","parsed-index","time","discontinuity","fresh","held"])("rejects contradictory %s endpoint provenance", kind=>{
    const forged=JSON.parse(serializeReplayTrace(fixture(profile).trace));
    const bracket=forged.domain.endpointInputBracket, endpoint=forged.records.filter((r:{kind:string})=>r.kind === "input").pop();
    if(kind === "synthetic-reason") forged.domain.frameSources.at(-1).reason="different-synthesis";
    if(kind === "raw-index") bracket.next.source.rawTokenIndex++;
    if(kind === "parsed-index") bracket.next.source.parsedFrameIndex++;
    if(kind === "time") bracket.next.timeMs=forged.domain.endTimeMs;
    if(kind === "discontinuity") bracket.next.source.discontinuityBefore=["gap"];
    if(kind === "fresh") endpoint.freshActions=[0];
    if(kind === "held") endpoint.actions=[0];
    expect(()=>serializeReplayTrace(forged)).toThrow();
  });
});
