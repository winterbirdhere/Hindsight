import { automatedInputRetention, retainPlannedInputs } from "../src/gameplay/trace/PlannedTraceCapture";
import { createReplayTraceCollector, serializeReplayTrace } from "../src/gameplay/trace/ReplayTraceCollector";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { stableSavedScoreCandidates } from "../src/replays/SavedScoreCandidates";
import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { normalizeTraceState, traceFrame } from "./ReplayTraceFixtures";

describe("bounded planned input retention",()=>{
  it("never scopes manual input or a non-monotone source from automated policy",()=>{
    const frames=[traceFrame(0),traceFrame(1200)];
    const manual=errorFixture("300,192,1000,1,0",frames);
    expect(automatedInputRetention(manual.map,frames,manual.state,"stable")).toBeUndefined();
    const auto=errorFixture("300,192,1000,1,0",frames,"stable",["RELAX"]);
    expect(automatedInputRetention(auto.map,[frames[1],frames[0]],auto.state,"stable")).toBeUndefined();
  });
  it("keeps action/release/discontinuity predecessors and exact dispatch order outside planned windows",()=>{
    const frames=Array.from({length:100},(_,i)=>traceFrame(i*10,300,i>=30 && i<40 ? [0] : []));
    const f=errorFixture("300,192,300,1,0",frames);
    const base=createReplayTraceCollector(f.trace.identity,{...f.trace.domain,sourceCoverageLimits:["planned-input-retention"]},f.trace.limits);
    const c=retainPlannedInputs(base,[0,1,98,99]);
    new BucketedGameStateTimeMachine(frames,f.map,{noteLockStyle:"STABLE",hitWindowStyle:"OSU_STABLE"},undefined,c).gameStateAt(Infinity);
    const t=c.seal(),times=t.records.filter(r=>r.kind==="input").map(r=>r.timeMs);
    expect(times).toEqual(expect.arrayContaining([290,300,390,400]));
    expect(t.failures).toEqual([]);
    expect(t.records.filter(r=>r.kind!=="input" && r.kind!=="coverage").map(({sequence,...r})=>r))
      .toEqual(f.trace.records.filter(r=>r.kind!=="input" && r.kind!=="coverage").map(({sequence,...r})=>r));
  });
  it("rejects invalid omitted observations and ignores data after disposal",()=>{
    const f=errorFixture("300,192,1000,1,0",[traceFrame(0),traceFrame(1200)]);
    const base=createReplayTraceCollector(f.trace.identity,f.trace.domain,f.trace.limits),c=retainPlannedInputs(base,[]);
    const input=f.trace.records.find(r=>r.kind==="input")!;
    c.record({...input,id:c.reserveId(),timeMs:NaN});
    expect(c.seal().failures).toContain("planned-capture-invalid-or-buffer-limit");
    const d=retainPlannedInputs(createReplayTraceCollector(f.trace.identity,f.trace.domain,f.trace.limits),[]);
    d.dispose();expect(d.reserveId()).toBe("");expect(d.seal().records).toEqual([]);
  });
  it("bounds buffered bytes before collector admission",()=>{
    const f=errorFixture("300,192,1000,1,0",[traceFrame(0),traceFrame(1200)]);
    const base=createReplayTraceCollector(f.trace.identity,f.trace.domain,{maxRecords:200000,maxExportBytes:4096});
    const c=retainPlannedInputs(base,[]),input=f.trace.records.find(r=>r.kind==="input")!;
    c.record({...input,id:c.reserveId(),source:{origin:"parsed",parsedFrameIndex:0,discontinuityBefore:["x".repeat(8192)]}} as typeof input);
    expect(c.reserveId()).toBe("");
    expect(c.seal().failures).toContain("planned-capture-byte-limit");
  });
  it.each(["stable","lazer"] as const)("retains exact %s error windows and all dispatch while evaluating every original input",profile=>{
    const frames=Array.from({length:12201},(_,i)=>traceFrame(i*5,i*5<50000 ? 300 : 600));
    const f=errorFixture("300,192,1000,1,0\n300,192,30000,2,0,L|400:192,1,100\n300,192,60000,1,0",frames,profile,["RELAX"]);
    const indices=automatedInputRetention(f.map,frames,f.state,profile);
    expect(indices).toBeDefined();
    expect(indices!.length).toBeLessThan(frames.length/2);
    const base=createReplayTraceCollector(f.trace.identity,{...f.trace.domain,sourceCoverageLimits:["planned-input-retention"]},f.trace.limits);
    const capture=retainPlannedInputs(base,indices!);
    const state=(profile === "stable" ? new BucketedGameStateTimeMachine(frames,f.map,{noteLockStyle:"STABLE",hitWindowStyle:"OSU_STABLE"},undefined,capture)
      : new LazerGameStateTimeMachine(frames,f.map,undefined,{},capture)).gameStateAt(Infinity);
    const trace=capture.seal();
    expect(normalizeTraceState(state)).toEqual(normalizeTraceState(f.state));
    expect(trace.failures).toEqual([]);
    expect(()=>serializeReplayTrace(trace)).not.toThrow();
    expect(trace.coverage.input).toBe("partial");
    const strip=(rows:typeof trace.records)=>rows.filter(r=>r.kind!=="input" && r.kind!=="coverage").map(({sequence,...r})=>r);
    expect(strip(trace.records)).toEqual(strip(f.trace.records));
    const times=trace.records.filter(r=>r.kind === "input").map(r=>({time:r.timeMs}));
    expect(stableSavedScoreCandidates(f.map,times)).toEqual(stableSavedScoreCandidates(f.map,frames));
    const evidence=deriveCircleEvidence(trace,f.map,"2"),full=deriveCircleEvidence(f.trace,f.map,"2");
    expect(evidence.dependencies).toEqual(full.dependencies);
    expect(classifyCircleLoss(evidence,f.map,trace).codes).toEqual(classifyCircleLoss(full,f.map,f.trace).codes);
    const stripInputs=(e:typeof evidence)=>e.inputs.map(({record:{sequence,...r},...i})=>({record:r,...i}));
    expect(stripInputs(evidence)).toEqual(stripInputs(full));
    // Native Relax dispatches attempts throughout this successful live window,
    // so mandatory attempt/predecessor retention also preserves that local span.
    expect(deriveCircleEvidence(trace,f.map,"0").dependencies.input.status).toBe(profile === "stable" ? "partial" : "complete");
  });
});
