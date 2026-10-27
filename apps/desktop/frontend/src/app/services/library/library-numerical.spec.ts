import { buildBeatmap, BucketedGameStateTimeMachine, defaultGameState, GameStateEvaluator, LazerGameStateEvaluator, LazerGameStateTimeMachine, LazerMod, NOT_PRESSING, parseBlueprint, parseReplayFramesWithDiagnostics, Slider, Spinner } from "@osujs/core";
import { legacyModsFromLazerMods, OsuReplay } from "../../model/OsuReplay";
import { traceMapText } from "../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { projectLibraryNumerical, runLibraryNumerical } from "./library-numerical";
import { buildReplayPerformanceInput } from "../analysis/performance/replay-performance-input";

const binding = { replaySha256: "a".repeat(64), mapSha256: "b".repeat(64), mapMd5: "c".repeat(32), exactMapAndProfile: true };
const circles = "300,192,1000,1,0\n300,192,2000,1,0";
const slider = "100,192,1000,2,0,L|300:192,1,200";
function source(samples: number[][], native = false, extra: Partial<OsuReplay> = {}): OsuReplay {
  let previous = 0;
  const raw = "0|256|-500|0,0|256|-500|0," + samples.map(([time,x=300,mask=0]) => {
    const delta = time-previous; previous=time; return `${delta}|${x}|192|${mask},`;
  }).join("");
  const parsed = parseReplayFramesWithDiagnostics(raw);
  return { md5hash:"fixture",beatmapMd5:binding.mapMd5,player:"test",gameVersion:native?30000016:20200101,
    mods:[],frames:parsed.frames,parseDiagnostics:parsed.diagnostics,...extra };
}
const map = (objects=circles, classic?: boolean) => buildBeatmap(parseBlueprint(traceMapText(objects)), {
  mods:[],addStacking:false,...(classic===undefined?{}:{ lazerMods:[{ acronym:"CL",settings:{no_slider_head_accuracy:classic} }] }),
});
const completeFrames = [[0],[1000,300,5],[1001],[2000,300,5],[2100]];
const checkpoint = async () => undefined;
function heldPrefix(raw:string):OsuReplay {
  const parsed=parseReplayFramesWithDiagnostics(raw);return {...source([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
}
function neutralMultiReset():OsuReplay {
  return heldPrefix("0|256|-500|0,10695|256|-500|0,-10673|100|192|0,0|100|192|0,10779|100|192|0,-10|100|192|0,23|100|192|0,3279|100|192|5,1|100|192|0,1999|300|192|5,1|300|192|0,");
}
it.each(["100,192,14064,1,0","100,192,14064,2,0,L|300:192,1,200","256,192,14064,8,0,15064"])(
  "qualifies a complete neutral multi-reset prefix independently of the later held release: %s",async first=>{
    const beatmap=map(first+"\n300,192,16064,1,0\n300,192,19000,1,0"),replay=neutralMultiReset(),before=JSON.stringify(replay);
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    const clean=await runLibraryNumerical(beatmap,source(replay.frames.map(f=>[f.time,f.position.x,f.rawButtonMask??0])),binding,checkpoint);
    expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-neutral-multi-reset-v1"});
    expect(actual.state).toEqual(clean.state);expect(actual.metrics.fields).toEqual(clean.metrics.fields);expect(actual.metrics.errorStrip).toEqual(clean.metrics.errorStrip);
    expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");
    expect(JSON.stringify(replay)).toBe(before);
  });
it.each(["missing","version","parser","diagnostic-parser","shape","token-shape","count","raw-count","release-index","nonfinite","sum","clock","raw-index",
  "position","mask","action","held-token","coordinate","first-mark","suffix-mark","suffix-gap","skipped","warning","initial-known","oversize","reversed-prefix","reversed-suffix"])(
  "rejects incomplete or contradictory neutral multi-reset evidence: %s",async fault=>{
    const replay=neutralMultiReset(),d=replay.parseDiagnostics,w=d?.neutralPrefixWitness;
    if(!d||!w)throw Error("Expected neutral multi-reset witness fixture");
    if(fault==="missing")delete d.neutralPrefixWitness;if(fault==="version")Object.assign(w,{version:"unknown"});if(fault==="parser")w.parserVersion="unknown";
    if(fault==="diagnostic-parser")d.parserVersion="unknown";if(fault==="shape")Object.assign(w,{extra:true});if(fault==="token-shape")Object.assign(w.tokens[0],{extra:true});
    if(fault==="count")w.frameCount++;if(fault==="raw-count")w.rawTokenCount++;if(fault==="release-index")w.releaseFrameIndex--;
    if(fault==="nonfinite")w.tokens[0].timeAfter=Infinity;if(fault==="sum")w.tokens[2].timeAfter++;if(fault==="clock")w.tokens[0].timeBefore=1;
    if(fault==="raw-index")w.tokens[2].rawTokenIndex++;if(fault==="position")replay.frames[0].position.x++;if(fault==="mask")replay.frames[0].rawButtonMask=5;
    if(fault==="action")replay.frames[0].actions=[0];if(fault==="held-token")w.tokens[2].rawButtonMask=5;if(fault==="coordinate")w.tokens[2].x=131073;
    if(fault==="first-mark")delete d.frameSources[0].discontinuityBefore;if(fault==="suffix-mark")d.frameSources[w.releaseFrameIndex+1].discontinuityBefore=["parser-negative-delta"];
    if(fault==="suffix-gap")d.frameSources[w.releaseFrameIndex+1].rawTokenIndex++;if(fault==="skipped")d.skippedTokens.pop();if(fault==="warning")d.sourceCoverageLimits.push("parser-malformed-token");
    if(fault==="initial-known")d.initialActionsKnown=true;if(fault==="oversize")w.tokens.push(...Array.from({length:256},()=>({...w.tokens[0]})));
    if(fault==="reversed-prefix")replay.frames[1].time=replay.frames[0].time-1;if(fault==="reversed-suffix")replay.frames[4].time=replay.frames[3].time-1;
    const actual=await runLibraryNumerical(map("100,192,14064,1,0"),replay,binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.ur.state).toBe("unknown");expect(actual.metrics.errorStrip?.state).toBe("unknown");
  });
it.each(["RELAX","AUTO_PLAY","AUTO_PILOT"] as const)("keeps neutral multi-reset qualification manual for %s",async mod=>{
  for(const mods of [[mod],["SPUN_OUT",mod]] as OsuReplay["mods"][]){
    const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,14064,1,0")),{mods,addStacking:false}),replay=neutralMultiReset();replay.mods=mods;
    expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  }
});
it.each(["native","nonstandard","unsupported"])("does not extend neutral multi-reset admission to %s sources",async fault=>{
  const replay=neutralMultiReset();if(fault==="native")replay.gameVersion=30000016;if(fault==="nonstandard")replay.gameMode=1;
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,14064,1,0")),{mods:[],addStacking:false,...(fault==="unsupported"?{lazerMods:[{acronym:"UNKNOWN"}]}:{})});
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("retains supported SO manual input with neutral multi-reset evidence",async()=>{
  const replay=neutralMultiReset();replay.mods=["SPUN_OUT"];
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,14064,1,0\n300,192,16064,1,0")),{mods:["SPUN_OUT"],addStacking:false});
  const result=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(result.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-neutral-multi-reset-v1"});expect(result.metrics.fields.ur.state).toBe("known");
});
it.each([
  {object:"100,192,1000,1,0",boundary:601},
  {object:"100,192,1000,2,0,L|300:192,1,200",boundary:601},
  {object:"256,192,1000,8,0,2000",boundary:1000},
])("keeps every neutral prefix clock endpoint strictly before the actual boundary: $object",async({object,boundary})=>{
  for(const highWater of [boundary-1,boundary,boundary+1]){
    const replay=heldPrefix(`0|256|-500|0,${highWater}|256|-500|0,${-highWater}|100|192|0,0|100|192|0,50|100|192|0,-10|100|192|0,20|100|192|0,940|100|192|5,1|100|192|0,`);
    expect((await runLibraryNumerical(map(object),replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(highWater<boundary);
  }
  const atBoundary=heldPrefix(`0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,50|100|192|0,-10|100|192|0,${boundary-40}|100|192|0,1|100|192|5,1|100|192|0,`);
  expect((await runLibraryNumerical(map(object),atBoundary,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("rejects a retained prefix clock reversal even when the final release precedes every object",async()=>{
  const replay=heldPrefix("0|256|-500|0,100|256|-500|0,-100|100|192|0,500|100|192|0,-400|100|192|0,100|100|192|0,13893|100|192|5,1|100|192|0,");
  expect(replay.parseDiagnostics?.neutralPrefixWitness).toBeDefined();
  expect((await runLibraryNumerical(map("100,192,14064,1,0"),replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("converges all finite prior button histories and compares direct versus production state structurally",async()=>{
  const replay=neutralMultiReset(),beatmap=map("100,192,14064,2,0,L|300:192,1,200\n300,192,16064,1,0");
  const result=await runLibraryNumerical(beatmap,replay,binding,checkpoint),options={hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion} as const;
  const direct=defaultGameState(),evaluator=new GameStateEvaluator(beatmap,options);
  for(const frame of result.scoring.frames)evaluator.evaluate(direct,frame);
  // Production starts with a cloned state, whose property insertion order differs.
  // Structural equality, not JSON serialization order, is the parity criterion.
  expect(direct).toEqual(result.state);
  for(let current=0;current<4;current++)for(let previous=0;previous<4;previous++)for(let older=0;older<4;older++){
    const state=defaultGameState(),machine=new GameStateEvaluator(beatmap,options);
    state.pressingSince=[current&1?-1000:NOT_PRESSING,current&2?-1000:NOT_PRESSING];state.stablePreviousButtons=previous;state.stablePreviousPreviousButtons=older;
    for(const frame of result.scoring.frames)machine.evaluate(state,frame);
    expect(state).toEqual(result.state);
  }
});
it("keeps neutral source suffix validation cooperative and cancellable",async()=>{
  const raw="0|256|-500|0,100|256|-500|0,-100|100|192|0,0|100|192|0,50|100|192|0,-10|100|192|0,20|100|192|0,"+"1|100|192|0,".repeat(1024);
  const replay=heldPrefix(raw),beatmap=map("100,192,14064,1,0");let calls=0;
  const result=await runLibraryNumerical(beatmap,replay,binding,async()=>{calls++;});expect(result.metrics.provenance.coverageQualified).toBe(true);expect(calls).toBeGreaterThan(4);
  let checkpoints=0;await expect(projectLibraryNumerical(beatmap,replay,result.scoring,result.state,binding,async()=>{if(++checkpoints===3)throw Error("neutral cancellation");})).rejects.toThrow("neutral cancellation");
});
it.each([
  {name:"multiple resets before spawn",objects:"100,192,4892,2,0,L|300:192,1,200",ar:9.4,
    raw:"0|256|-500|0,2491|256|-500|0,-2491|140|166|5,43|140|166|0,2483|150|166|5,-1|150|166|0,79|193|182|0,2288|100|192|5,1000|300|192|0,"},
  {name:"post-spawn release before slider MISS",objects:"100,192,1291,2,0,L|300:192,1,200",ar:9.2,
    raw:"0|256|-500|0,-1|256|-500|0,-507|261|145|10,4|261|145|10,1318|271|166|0,473|100|192|5,1000|300|192|0,"},
  {name:"long held prefix before first MISS",objects:"100,192,30111,2,0,L|300:192,1,200",ar:4.9,
    raw:"0|256|-500|0,27110|256|-500|0,-27095|235|150|1,0|235|150|1,28888|229|146|0,1208|100|192|5,1000|300|192|0,"},
])("qualifies the attested Stable released prefix: $name",async fixture=>{
  const beatmap=buildBeatmap(parseBlueprint(traceMapText(fixture.objects).replace("ApproachRate:9",`ApproachRate:${fixture.ar}`)),{mods:[],addStacking:false});
  const replay=heldPrefix(fixture.raw),before=JSON.stringify(replay);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.provenance.sourceCoverageEvidence).toBe("stable-released-prefix-v1");
  expect(actual.metrics.fields.ur.state).toBe("known");expect(JSON.stringify(replay)).toBe(before);
});
function boundedHeldPrefix(release=500):OsuReplay {
  return heldPrefix(`0|256|-500|0,100|256|-500|0,-100|100|192|5,100|100|192|5,${release-100}|100|192|0,${1000-release}|100|192|5,1|100|192|0,2000|300|192|0,`);
}
it.each(["100,192,1000,1,0","100,192,1000,2,0,L|300:192,1,200"])(
  "uses strict MISS input boundaries for released held-prefix qualification: %s",async objects=>{
    for(const [release,qualifies]of [[600,true],[601,false],[602,false]] as const){
      const actual=await runLibraryNumerical(map(objects),boundedHeldPrefix(release),binding,checkpoint);
      expect(actual.metrics.provenance.coverageQualified).toBe(qualifies);
    }
  });
it.each(["missing","version","parser","count","raw-count","release-index","nonfinite","sum","clock","raw-index","position","mask","action",
  "held-checkpoint","unknown-mask","unreleased-sentinel","sentinel-time","future-prefix","first-mark","suffix-mark","suffix-gap","skipped","warning","oversize"])(
  "rejects inconsistent or incomplete released-prefix evidence: %s",async fault=>{
    const replay=boundedHeldPrefix(),d=replay.parseDiagnostics,w=d?.releasedPrefixWitness;
    if(!d||!w)throw Error("Expected held-prefix witness");
    if(fault==="missing")delete d.releasedPrefixWitness;if(fault==="version")Object.assign(w,{version:"unknown"});if(fault==="parser")w.parserVersion="unknown";
    if(fault==="count")w.frameCount++;if(fault==="raw-count")w.rawTokenCount++;if(fault==="release-index")w.releaseFrameIndex--;
    if(fault==="nonfinite")w.tokens[2].timeAfter=Infinity;if(fault==="sum")w.tokens[2].timeAfter++;if(fault==="clock")w.tokens[0].timeBefore=1;
    if(fault==="raw-index")w.tokens[2].rawTokenIndex++;if(fault==="position")replay.frames[0].position.x++;
    if(fault==="mask")replay.frames[0].rawButtonMask=0;if(fault==="action")replay.frames[0].actions=[];
    if(fault==="held-checkpoint")replay.frames[w.releaseFrameIndex].actions=[0];if(fault==="unknown-mask")w.tokens[2].rawButtonMask=32;
    if(fault==="unreleased-sentinel")w.tokens[0].rawButtonMask=1;if(fault==="sentinel-time")w.tokens[1].timeAfter=1000;
    if(fault==="future-prefix")w.tokens[3].timeAfter=700;if(fault==="first-mark")delete d.frameSources[0].discontinuityBefore;
    if(fault==="suffix-mark")d.frameSources[w.releaseFrameIndex+1].discontinuityBefore=["parser-negative-delta"];
    if(fault==="suffix-gap")d.frameSources[w.releaseFrameIndex+1].rawTokenIndex++;
    if(fault==="skipped")d.skippedTokens.push({rawTokenIndex:w.rawTokenCount,reason:"negative-delta"});if(fault==="warning")d.sourceCoverageLimits.push("unknown");
    if(fault==="oversize")w.tokens.push(...Array.from({length:256},()=>({...w.tokens[0]})));
    const actual=await runLibraryNumerical(map("100,192,1000,1,0"),replay,binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.fc.state).toBe("unknown");
  });
it.each(["AUTO_PLAY","RELAX","AUTO_PILOT"] as const)("keeps released-prefix admission manual for tapping/aim mod %s",async mod=>{
  const replay=boundedHeldPrefix();replay.mods=[mod];
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,1000,1,0")),{mods:[mod],addStacking:false});
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("does not reuse the Stable witness for native input, started spinner, or a reset after gameplay",async()=>{
  const native=boundedHeldPrefix();native.gameVersion=30000016;native.lazerMods=[];
  expect((await runLibraryNumerical(map("100,192,1000,1,0"),native,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  expect((await runLibraryNumerical(map("256,192,400,8,0,2000"),boundedHeldPrefix(),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  const later=heldPrefix("0|256|-500|0,100|256|-500|0,-100|100|192|5,100|100|192|5,400|100|192|0,500|100|192|5,-1|100|192|0,1|100|192|0,1000|100|192|0,");
  expect((await runLibraryNumerical(map("100,192,1000,1,0"),later,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("does not promote partial source coverage into whole-play Result or FC",async()=>{
  const replay=boundedHeldPrefix(),actual=await runLibraryNumerical(map("100,192,1000,1,0\n100,192,9000,1,0"),replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields.ur.state).toBe("known");expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");
});
it("retains cancellation checkpoints in the additive source validation",async()=>{
  const stop=Error("fixture cancellation"),replay=boundedHeldPrefix(),beatmap=map("100,192,1000,1,0");
  const baseline=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  await expect(projectLibraryNumerical(beatmap,replay,baseline.scoring,baseline.state,binding,async()=>{throw stop;})).rejects.toBe(stop);
});
function nativeInitialNegative(samples:number[][],extra:Partial<OsuReplay>={},initial=-900,first=-880):OsuReplay {
  let previous=first;const suffix=samples.map(([time,x=300,mask=0])=>{const delta=time-previous;previous=time;return `${delta}|${x}|192|${mask},`;}).join("");
  const parsed=parseReplayFramesWithDiagnostics(`${initial}|280|180|0,${first-initial}|300|192|0,${suffix}`);
  return {...source([],true,{lazerMods:[],...extra}),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
}
it("qualifies an attested native initial-negative prefix while preserving warnings and usual completion/FC",async()=>{
  const beatmap=map("300,192,5000,1,0\n300,192,6000,1,0"),replay=nativeInitialNegative([[5000,300,1],[5001],[6000,300,1],[6100]]);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields).toMatchObject({completion:{state:"known",value:"passed"},fc:{state:"known",value:true},perfectCombo:{state:"known",value:true}});
  expect(replay.parseDiagnostics?.sourceCoverageLimits).toEqual(["initial-actions-unknown","parser-negative-delta"]);
});
const nativeObjects=[
  {name:"circle",objects:"300,192,5000,1,0\n300,192,7000,1,0",samples:[[5000,300,1],[5000,300,0],[5000,300,1],[5100],[7000,300,1],[7100]]},
  {name:"slider",objects:"100,192,5000,2,0,L|300:192,1,200\n300,192,7000,1,0",samples:[[5000,100,1],[5500,200,1],[6000,300,1],[6100],[7000,300,1],[7100]]},
  {name:"spinner",objects:"256,192,5000,8,0,6000\n300,192,7000,1,0",samples:[[5000,300,1],[5500,100,1],[6100],[7000,300,1],[7100]]},
];
const nativeProfiles:{name:string;mods:LazerMod[]}[]=[{name:"NM",mods:[]},{name:"HR",mods:[{acronym:"HR"}]},{name:"DT",mods:[{acronym:"DT"}]},
  {name:"custom-rate",mods:[{acronym:"DT",settings:{speed_change:1.2}}]},
  {name:"DA",mods:[{acronym:"DA",settings:{approach_rate:3,circle_size:5,overall_difficulty:7}}]}];
it.each(nativeProfiles.flatMap(profile=>nativeObjects.map(object=>({profile,...object}))))(
  "converges with explicit omitted neutral input for native $profile.name $name",async({profile,objects,samples})=>{
    const mods=legacyModsFromLazerMods(profile.mods),beatmap=buildBeatmap(parseBlueprint(traceMapText(objects)),{mods,lazerMods:profile.mods,addStacking:false});
    const replay=nativeInitialNegative(samples,{mods,lazerMods:profile.mods}),d=replay.parseDiagnostics,w=d?.initialNegativeWitness;
    if(!w)throw new Error("Expected initial-negative witness fixture");
    const initial={time:w.tokens[0].timeAfter,position:{x:w.tokens[0].x,y:w.tokens[0].y},actions:[],rawButtonMask:0};
    const retainedState=await new LazerGameStateTimeMachine(replay.frames.slice(0,1),beatmap).evaluateReplayAsync(checkpoint);
    const explicitState=await new LazerGameStateTimeMachine([initial,...replay.frames.slice(0,1)],beatmap).evaluateReplayAsync(checkpoint);
    expect(explicitState).toEqual(retainedState);
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    const reference=await new LazerGameStateTimeMachine([initial,...actual.scoring.frames],beatmap).evaluateReplayAsync(checkpoint);
    expect(actual.state).toEqual(reference);expect(actual.metrics).toEqual(await projectLibraryNumerical(beatmap,replay,actual.scoring,reference,binding,checkpoint));
    expect(actual.metrics.provenance.coverageQualified).toBe(true);expect(actual.metrics.fields.accuracy.state).toBe("known");
    const activation=Math.min(...beatmap.hitObjects.map(object=>object instanceof Spinner?object.startTime:object.spawnTime));
    for(const [first,qualifies]of [[activation-1,true],[activation,false],[activation+1,false]] as const){
      const boundary=nativeInitialNegative(samples,{mods,lazerMods:profile.mods},-900,first);
      expect((await runLibraryNumerical(beatmap,boundary,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(qualifies);
    }
  });
it.each([-232,0,-1])("qualifies released native timestamps before activation %s despite the synthetic zero origin",async activation=>{
  const text=traceMapText("300,192,5000,1,0"),base=buildBeatmap(parseBlueprint(text),{mods:[],lazerMods:[],addStacking:false});
  const hit=5000-base.hitObjects[0].spawnTime+activation;
  const beatmap=buildBeatmap(parseBlueprint(traceMapText(`300,192,${hit},1,0\n300,192,${hit+1000},1,0`)),{mods:[],lazerMods:[],addStacking:false});
  expect(beatmap.hitObjects[0].spawnTime).toBeCloseTo(activation);
  // Exact released prefix observed in Troll; only the following simple map/hits are synthetic.
  const parsed=parseReplayFramesWithDiagnostics(`-1632|301.18497|208.94887|0,17|302.54495|209.92876|0,${hit+1615}|300|192|1,1|300|192|0,999|300|192|1,100|300|192|0,`);
  const replay={...source([],true,{lazerMods:[]}),frames:parsed.frames,parseDiagnostics:parsed.diagnostics},before=JSON.stringify(parsed);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields).toMatchObject({completion:{state:"known",value:"passed"},accuracy:{state:"known",value:1},
    sampleCount:{state:"known",value:2},ur:{state:"known",value:0}});
  const explicit={time:-1632,position:{x:301.18497,y:208.94887},actions:[],rawButtonMask:0};
  const reference=await new LazerGameStateTimeMachine([explicit,...actual.scoring.frames],beatmap).evaluateReplayAsync(checkpoint);
  expect(actual.state).toEqual(reference);
  expect(actual.metrics).toEqual(await projectLibraryNumerical(beatmap,replay,actual.scoring,reference,binding,checkpoint));
  expect(JSON.stringify(parsed)).toBe(before);
});
it.each([
  {initial:-250,retained:-233,qualified:true},
  {initial:-250,retained:-232,qualified:false},
  {initial:-250,retained:-231,qualified:false},
  {initial:-232,retained:-215,qualified:false},
  {initial:-231,retained:-214,qualified:false},
])("checks actual native timestamp boundaries at negative activation: $initial to $retained",async({initial,retained,qualified})=>{
  const base=map("300,192,5000,1,0"),hit=5000-base.hitObjects[0].spawnTime-232;
  const beatmap=buildBeatmap(parseBlueprint(traceMapText(`300,192,${hit},1,0`)),{mods:[],lazerMods:[],addStacking:false});
  expect(beatmap.hitObjects[0].spawnTime).toBeCloseTo(-232);
  const actual=await runLibraryNumerical(beatmap,nativeInitialNegative([[hit,300,1],[hit+100]],{},initial,retained),binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(qualified);
  expect(actual.metrics.fields.ur.state).toBe(qualified?"known":"unknown");
});
it.each(["missing","version","parser-version","diagnostic-version","raw-index","sum","nonfinite","before","held-proof","coordinate","token-shape","proof-shape","token-count","count","raw-count","retained-time","retained-position","retained-mask","retained-actions","first-mark","extra-first-mark","later-mark","suffix-gap","skipped-inventory","global-warning","initial-known","initial-sign","retained-sign"])(
  "refuses missing/mismatched native initial-negative proof: %s",async fault=>{
    const beatmap=map("300,192,5000,1,0"),replay=nativeInitialNegative([[5000,300,1],[5100]]),d=replay.parseDiagnostics,w=d?.initialNegativeWitness;
    if(!d||!w)throw new Error("Expected initial-negative witness fixture");
    if(fault==="missing")delete d.initialNegativeWitness;if(fault==="version")Object.assign(w,{version:"other"});if(fault==="parser-version")w.parserVersion="other";
    if(fault==="diagnostic-version")d.parserVersion="other";if(fault==="raw-index")w.tokens[0].rawTokenIndex=2;if(fault==="sum")w.tokens[0].timeAfter++;
    if(fault==="nonfinite")w.tokens[1].timeAfter=Infinity;if(fault==="before")w.tokens[0].timeBefore=1;if(fault==="held-proof")w.tokens[0].rawButtonMask=1;
    if(fault==="coordinate")w.tokens[0].x=131073;if(fault==="token-shape")Object.assign(w.tokens[0],{extra:0});if(fault==="proof-shape")Object.assign(w,{extra:0});
    if(fault==="token-count")w.tokens.push({...w.tokens[1]});if(fault==="count")w.frameCount++;if(fault==="raw-count")w.rawTokenCount++;
    if(fault==="retained-time")replay.frames[0].time++;if(fault==="retained-position")replay.frames[0].position.y++;
    if(fault==="retained-mask")delete replay.frames[0].rawButtonMask;if(fault==="retained-actions")replay.frames[0].actions=[0];
    if(fault==="first-mark")delete d.frameSources[0].discontinuityBefore;if(fault==="extra-first-mark")d.frameSources[0].discontinuityBefore?.push("other");
    if(fault==="later-mark")d.frameSources[1].discontinuityBefore=["parser-negative-delta"];if(fault==="suffix-gap")d.frameSources[1].rawTokenIndex++;
    if(fault==="skipped-inventory")d.skippedTokens.push({rawTokenIndex:w.rawTokenCount,reason:"negative-delta"});if(fault==="global-warning")d.sourceCoverageLimits.pop();
    if(fault==="initial-known")d.initialActionsKnown=true;if(fault==="initial-sign")w.tokens[0].delta=0;if(fault==="retained-sign")w.tokens[1].delta=0;
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.fc.state).toBe("unknown");
  });
it.each(["CL","RX","AP","AT","SO","UNKNOWN"])("refuses native initial-negative exception for excluded profile %s",async acronym=>{
  const lazerMods=[{acronym}],mods=legacyModsFromLazerMods(lazerMods),beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,5000,1,0")),{mods,lazerMods,addStacking:false});
  const result=await runLibraryNumerical(beatmap,nativeInitialNegative([[5000,300,1],[5100]],{mods,lazerMods}),binding,checkpoint);
  expect(result.metrics.provenance.coverageQualified).toBe(false);
});
it("keeps native authority and Classic gates while separately attesting Stable initial-negative input",async()=>{
  const beatmap=map("300,192,5000,1,0"),base=nativeInitialNegative([[5000,300,1],[5100]]);
  for(const replay of [{...base,lazerMods:undefined},{...base,lazerMods:[{acronym:"CL"}]}])
    expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  expect((await runLibraryNumerical(beatmap,{...base,gameVersion:20200101,lazerMods:undefined},binding,checkpoint)).metrics.provenance)
    .toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-initial-negative-v1"});
  expect((await runLibraryNumerical(map("300,192,5000,1,0",true),base,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  expect((await runLibraryNumerical(beatmap,base,{...binding,exactMapAndProfile:false},checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["-1|300|192|0,","bad","20|300|192|0,,20|300|192|0,"])("keeps native later/trailing anomalies unqualified: %s",tail=>{
  const parsed=parseReplayFramesWithDiagnostics("-900|280|180|0,20|300|192|0,5880|300|192|1,100|300|192|0,"+tail);
  const replay={...nativeInitialNegative([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
  return runLibraryNumerical(map("300,192,5000,1,0"),replay,binding,checkpoint).then(actual=>expect(actual.metrics.provenance.coverageQualified).toBe(false));
});
it("does not infer native completion/FC from prefix qualification with absent future outcomes or a health cutoff",async()=>{
  const beatmap=map("300,192,5000,1,0\n300,192,6000,1,0");
  for(const [replay,perfectCombo] of [
    [nativeInitialNegative([[5000,300,1],[5001]]),{state:"unknown",reason:"exact-map-combo-unavailable"}],
    [nativeInitialNegative([[5000,300,1],[5001],[6000,300,1],[6100]],{lifeBar:[{time:6100,health:0}]}),{state:"known",value:true}],
  ] as const){
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);expect(actual.metrics.provenance.coverageQualified).toBe(true);
    expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");expect(actual.metrics.fields.perfectCombo).toEqual(perfectCombo);
  }
});
function leadingReset(samples:number[][],extra:Partial<OsuReplay>={},highWater=1000,resetTime=15,firstX=300):OsuReplay {
  let previous=resetTime;const suffix=samples.map(([time,x=300,mask=0])=>{const delta=time-previous;previous=time;return `${delta}|${x}|192|${mask},`;}).join("");
  const parsed=parseReplayFramesWithDiagnostics(`0|256|-500|0,${highWater}|256|-500|0,${resetTime-highWater}|${firstX}|192|0,0|${firstX}|192|0,${suffix}`);
  return {...source([],false,extra),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
}
function canonicalEarlyStart(fault=""):OsuReplay {
  const firstDelta=fault==="first-sentinel"?1:0,secondDelta=fault==="second-sentinel"?-2:-1;
  const target=fault==="target-at"?-431:fault==="target-after"?-430:-1462;
  const retained=fault==="retained-at"?-431:fault==="retained-after"?-430:target+14;
  const raw=`${firstDelta}|256|-500|${fault==="held-sentinel"?1:0},${secondDelta}|256|-500|0,${target-firstDelta-secondDelta}|137.3333|174.6667|${fault==="held-reset"?1:0},${retained-target}|139.5556|175.1111|${fault==="held-retained"?1:0},${169-retained}|300|192|5,1|300|192|0,999|300|192|5,100|300|192|0,${fault==="later-gap"?"-1|300|192|0,":""}`;
  const parsed=parseReplayFramesWithDiagnostics(raw),w=parsed.diagnostics.leadingResetWitness;
  if(fault==="nonfinite"&&w)w.tokens[0].timeAfter=Infinity;
  if(fault==="wrong-sum"&&w)w.tokens[2].timeBefore++;
  if(fault==="wrong-position"&&w)w.tokens[0].x++;
  if(fault==="missing-witness")delete parsed.diagnostics.leadingResetWitness;
  if(fault==="suffix-gap")parsed.diagnostics.frameSources[1].rawTokenIndex++;
  return {...source([]),gameVersion:20211122,frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
}
it("distinguishes canonical Stable startup anchors from retained input before negative map spawn",async()=>{
  const beatmap=map("300,192,169,1,0\n300,192,1169,1,0"),replay=canonicalEarlyStart();
  expect(beatmap.hitObjects[0].spawnTime).toBe(-431);
  expect(replay.frames[0].time).toBe(-1448);
  const before=JSON.stringify(replay),actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields).toMatchObject({completion:{state:"known",value:"passed"},accuracy:{state:"known",value:1},misses:{state:"known",value:0},fc:{state:"known",value:true}});
  const explicit={time:-1462,position:{x:137.3333,y:174.6667},actions:[],rawButtonMask:0};
  const reference=await new BucketedGameStateTimeMachine([explicit,...actual.scoring.frames],beatmap,
    {hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:20211122}).evaluateReplayAsync(checkpoint);
  expect(actual.state).toEqual(reference);expect(JSON.stringify(replay)).toBe(before);
  expect(replay.parseDiagnostics?.sourceCoverageLimits).toContain("parser-negative-delta");
});
it.each(["first-sentinel","second-sentinel","held-sentinel","held-reset","held-retained","target-at","target-after","retained-at","retained-after","later-gap","nonfinite","wrong-sum","wrong-position","missing-witness","suffix-gap"])(
  "refuses unsafe canonical-start evidence before negative spawn: %s",async fault=>{
    const actual=await runLibraryNumerical(map("300,192,169,1,0\n300,192,1169,1,0"),canonicalEarlyStart(fault),binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.completion.state).toBe("unknown");
  });
it.each([
  {prefix:"0|256|-500|0,-1|256|-500|0,-1093|298.6667|184|0,16|298.6667|184|0,",toHit:6078},
  {prefix:"0|256|-500|0,-1|256|-500|0,-1106|302.6667|176|0,17|302.6667|176.4444|0,",toHit:6090},
])("qualifies a released positive-delta lead-in before activation: $toHit",async({prefix,toHit})=>{
  const parsed=parseReplayFramesWithDiagnostics(prefix+`${toHit}|300|192|5,1|300|192|0,999|300|192|5,100|300|192|0,`);
  const replay={...source([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
  const before=JSON.stringify(parsed),actual=await runLibraryNumerical(map("300,192,5000,1,0\n300,192,6000,1,0"),replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields).toMatchObject({completion:{state:"known",value:"passed"},misses:{state:"known",value:0},fc:{state:"known",value:true}});
  expect(JSON.stringify(parsed)).toBe(before);
});
it.each(["held-reset","held-retained","at-activation","after-activation","later-gap","legacy-proof","wrong-retained-position"])(
  "refuses unsafe positive-delta leading convergence: %s",async fault=>{
    const beatmap=map("300,192,5000,1,0"),activation=beatmap.hitObjects[0].spawnTime;
    const first=fault==="at-activation"?activation:fault==="after-activation"?activation+1:-1090;
    const raw=`0|256|-500|0,-1|256|-500|0,-1106|302.6667|176|${fault==="held-reset"?1:0},${first+1107}|302.6667|176.4444|${fault==="held-retained"?1:0},${5000-first}|300|192|5,100|300|192|0,${fault==="later-gap"?"-1|300|192|0,":""}`;
    const parsed=parseReplayFramesWithDiagnostics(raw),replay={...source([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
    if(fault==="legacy-proof")Object.assign(parsed.diagnostics.leadingResetWitness??{}, {version:"stable-zero-leading-reset-v1"});
    if(fault==="wrong-retained-position")replay.frames[0].position.y++;
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.completion.state).toBe("unknown");
  });
it("qualifies only an attested neutral leading reset while preserving its original warning",async()=>{
  const beatmap=map("300,192,5000,1,0\n300,192,6000,1,0"),replay=leadingReset([[5000,300,5],[5001],[6000,300,5],[6100]]);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const clean=await runLibraryNumerical(beatmap,source([[15],[5000,300,5],[5001],[6000,300,5],[6100]]),binding,checkpoint);
  expect(actual.metrics).toEqual(clean.metrics);expect(actual.metrics.provenance.coverageQualified).toBe(true);
  expect(actual.metrics.fields).toMatchObject({completion:{state:"known",value:"passed"},fc:{state:"known",value:true},perfectCombo:{state:"known",value:true}});
  expect(replay.parseDiagnostics?.sourceCoverageLimits).toContain("parser-negative-delta");
});
it.each([
  {name:"circle",objects:"300,192,5000,1,0\n300,192,6000,1,0",samples:[[5000,300,5],[5001],[6000,300,5],[6100]],x:300},
  {name:"slider",objects:"100,192,5000,2,0,L|300:192,1,200\n300,192,7000,1,0",samples:[[5000,100,5],[5500,200,5],[6000,300,5],[6100],[7000,300,5],[7100]],x:100},
  {name:"spinner",objects:"256,192,5000,8,0,6000\n300,192,7000,1,0",samples:[[5000],[6100],[7000,300,5],[7100]],x:300},
])("preserves clean numerical/state parity for a neutral reset before first $name activation",async fixture=>{
  const beatmap=map(fixture.objects),replay=leadingReset(fixture.samples,{},1000,15,fixture.x),clean=source([[15,fixture.x,0],...fixture.samples]);
  expect(replay.frames).toEqual(clean.frames);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint),expected=await runLibraryNumerical(beatmap,clean,binding,checkpoint);
  expect(actual.metrics).toEqual(expected.metrics);expect(actual.state).toEqual(expected.state);expect(actual.metrics.provenance.coverageQualified).toBe(true);
});
it.each([{mods:[]},{mods:["HARD_ROCK"]},{mods:["DOUBLE_TIME"]}] as {mods:OsuReplay["mods"]}[])("uses strict prepared-map activation/envelope boundaries with mods=$mods",async({mods})=>{
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,5000,1,0\n300,192,6000,1,0")),{mods,addStacking:false});
  const activation=beatmap.hitObjects[0].spawnTime,samples=[[5000,300,5],[5001],[6000,300,5],[6100]];
  for(const [highWater,qualifies]of [[activation-1,true],[activation,false],[activation+1,false]] as const){
    const actual=await runLibraryNumerical(beatmap,leadingReset(samples,{mods},highWater),binding,checkpoint);expect(actual.metrics.provenance.coverageQualified).toBe(qualifies);
    if(qualifies)expect(actual.metrics).toEqual((await runLibraryNumerical(beatmap,source([[15],...samples],false,{mods}),binding,checkpoint)).metrics);
    if(!qualifies){expect(actual.metrics.fields.fc.state).toBe("unknown");expect(actual.metrics.fields.accuracy.state).toBe("unknown");}
  }
});
it("rejects an envelope crossing circle spawn even below nominal hit time and reset-at-activation",async()=>{
  const beatmap=map("300,192,5000,1,0"),activation=beatmap.hitObjects[0].spawnTime;
  expect(activation).toBeLessThan(5000);
  for(const replay of [leadingReset([[5000,300,5],[5100]],{},(activation+5000)/2),leadingReset([[5000,300,5],[5100]],{},activation+100,activation)])
    expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["missing","version","parser-version","diagnostic-version","raw-index","sum","nonfinite","before","held-proof","count","raw-count","retained-position","retained-mask","retained-actions","first-mark","later-mark","suffix-gap","skipped-inventory","global-warning"])(
  "refuses missing/mismatched leading-reset proof: %s",async fault=>{
    const beatmap=map("300,192,5000,1,0"),replay=leadingReset([[5000,300,5],[5100]]),d=replay.parseDiagnostics,w=d?.leadingResetWitness;
    if(!d||!w)throw new Error("Expected reset witness fixture");
    if(fault==="missing")delete d.leadingResetWitness;if(fault==="version")Object.assign(w,{version:"other"});if(fault==="parser-version")w.parserVersion="other";
    if(fault==="diagnostic-version")d.parserVersion="other";if(fault==="raw-index")w.tokens[2].rawTokenIndex=4;if(fault==="sum")w.tokens[2].timeAfter++;
    if(fault==="nonfinite")w.tokens[1].timeAfter=Infinity;if(fault==="before")w.tokens[0].timeBefore=1;if(fault==="held-proof")w.tokens[2].rawButtonMask=1;
    if(fault==="count")w.frameCount++;if(fault==="raw-count")w.rawTokenCount++;if(fault==="retained-position")replay.frames[0].position.x++;
    if(fault==="retained-mask")delete replay.frames[0].rawButtonMask;if(fault==="retained-actions")replay.frames[0].actions=[0];
    if(fault==="first-mark")delete d.frameSources[0].discontinuityBefore;if(fault==="later-mark")d.frameSources[1].discontinuityBefore=["parser-negative-delta"];
    if(fault==="suffix-gap")d.frameSources[1].rawTokenIndex++;
    if(fault==="skipped-inventory")d.skippedTokens.push({rawTokenIndex:w.rawTokenCount,reason:"negative-delta"});if(fault==="global-warning")d.sourceCoverageLimits.pop();
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.fc.state).toBe("unknown");
  });
it.each(["-1|300|192|0,","bad",",100|300|192|0,","-12345|0|0|1,100|300|192|0,"])("refuses later/trailing dropped gameplay or unexplained suffix: %s",async tail=>{
  const parsed=parseReplayFramesWithDiagnostics("0|256|-500|0,1000|256|-500|0,-985|300|192|0,0|300|192|0,4985|300|192|5,100|300|192|0,"+tail);
  const replay={...source([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics},actual=await runLibraryNumerical(map("300,192,5000,1,0"),replay,binding,checkpoint);
  expect(parsed.diagnostics.leadingResetWitness).toBeUndefined();expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.fc.state).toBe("unknown");
});
it("retains same-time release/repress order after an admitted leading reset",async()=>{
  const samples=[[5000,300,5],[5000,300,0],[5000,300,5],[6100]],replay=leadingReset(samples),clean=source([[15],...samples]),beatmap=map("300,192,5000,1,0\n300,192,6000,1,0");
  expect(replay.frames).toEqual(clean.frames);expect(replay.frames.slice(1,4).map(frame=>frame.actions)).toEqual([[0],[],[0]]);
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics).toEqual((await runLibraryNumerical(beatmap,clean,binding,checkpoint)).metrics);
});
it.each(["AUTO_PLAY","RELAX","AUTO_PILOT"] as const)("does not admit the Stable reset exception for automated tapping/aim %s",async mod=>{
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,5000,1,0")),{mods:[mod],addStacking:false}),replay=leadingReset([[5000,300,5],[5100]],{mods:[mod]});
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
const spunOutMap=(objects:string)=>buildBeatmap(parseBlueprint(traceMapText(objects)),{mods:["SPUN_OUT"],addStacking:false});
it.each([
  {name:"circle",objects:"300,192,5000,1,0",samples:[[5010,300,5],[5011]]},
  {name:"slider",objects:"100,192,5000,2,0,L|300:192,1,200",samples:[[5010,100,5],[5500,200,5],[6000,300,5],[6100]]},
  {name:"spinner",objects:"256,192,5000,8,0,6000",samples:[[5000],[6100]]},
])("qualifies neutral SO reset before first $name without claiming a partial play complete",async fixture=>{
  const beatmap=spunOutMap(fixture.objects+"\n300,192,7000,1,0\n300,192,9000,1,0"),samples=[...fixture.samples,[7010,300,5],[7011]];
  const replay=leadingReset(samples,{mods:["SPUN_OUT"]},1000,15,fixture.name==="slider"?100:300),before=JSON.stringify(replay);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const clean=await runLibraryNumerical(beatmap,source([[15,fixture.name==="slider"?100:300,0],...samples],false,{mods:["SPUN_OUT"]}),binding,checkpoint);
  expect(actual.metrics).toEqual(clean.metrics);expect(actual.state).toEqual(clean.state);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);expect(actual.metrics.fields.ur.state).toBe("known");
  expect(actual.metrics.errorStrip?.state).toBe("known");expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");
  expect(actual.metrics.fields.pp).toBeUndefined();expect(actual.metrics.fields.peakPp).toBeUndefined();expect(JSON.stringify(replay)).toBe(before);
  if(fixture.name==="spinner"){
    const performance=buildReplayPerformanceInput({beatmap,replay,state:actual.state,mode:"stable",finalReplayTime:actual.scoring.endTime,stateIsScoringBounded:true});
    expect(performance.limitations).toContain("Exact Stable spinner bonus data is unavailable; Stable PP uses osu!'s combo-based estimate.");
    expect(performance.states.at(-1)?.legacyScoreByDifficultyMultiplier).toBeUndefined();
  }
});
it.each(["100,192,1000,1,0","100,192,1000,2,0,L|300:192,1,200","256,192,1000,8,0,2000"])(
  "qualifies SO held-prefix release before first input/event opportunity: %s",async object=>{
    // Observe spinner completion before the next press; a single jump directly
    // to that press still has the unresolved spinner in Stable's input order.
    const replay=heldPrefix("0|256|-500|0,100|256|-500|0,-100|100|192|5,100|100|192|5,400|100|192|0,500|100|192|5,1|100|192|0,1099|100|192|0,900|300|192|5,1|300|192|0,");
    replay.mods=["SPUN_OUT"];const before=JSON.stringify(replay);
    const actual=await runLibraryNumerical(spunOutMap(object+"\n300,192,3000,1,0\n300,192,9000,1,0"),replay,binding,checkpoint);
    expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-released-prefix-v1"});
    expect(actual.metrics.fields.ur.state).toBe("known");expect(actual.metrics.errorStrip?.state).toBe("known");
    expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");expect(JSON.stringify(replay)).toBe(before);
  });
it.each(["unsupported-mod","missing-witness","corrupt-witness","later-discontinuity","reversed-frame"])(
  "keeps SO source evidence strict: %s",async fault=>{
    const beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,5000,1,0")),{mods:["SPUN_OUT"],addStacking:false,
      ...(fault==="unsupported-mod"?{lazerMods:[{acronym:"UNKNOWN"}]}:{})}),replay=leadingReset([[5000,300,5],[5100]],{mods:["SPUN_OUT"]});
    const diagnostics=replay.parseDiagnostics,witness=diagnostics?.leadingResetWitness;
    if(!diagnostics||!witness)throw Error("Expected SO reset witness fixture");
    if(fault==="missing-witness")delete diagnostics.leadingResetWitness;
    if(fault==="corrupt-witness")witness.tokens[2].timeAfter++;
    if(fault==="later-discontinuity")diagnostics.frameSources[1].discontinuityBefore=["parser-negative-delta"];
    if(fault==="reversed-frame")replay.frames[2].time=replay.frames[1].time-1;
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.ur.state).toBe("unknown");
  });
it.each([999,1000,1001])("keeps the SO spinner-start boundary strict at release %s",async release=>{
  const replay=boundedHeldPrefix(release);replay.mods=["SPUN_OUT"];
  const actual=await runLibraryNumerical(spunOutMap("256,192,1000,8,0,2000"),replay,binding,checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(release<1000);
});
it.each(["RELAX","AUTO_PLAY","AUTO_PILOT"] as const)("does not let SO admit automated tapping/aim from %s",async mod=>{
  const mods:OsuReplay["mods"]=["SPUN_OUT",mod];
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,5000,1,0")),{mods,addStacking:false});
  const released=boundedHeldPrefix();released.mods=mods;
  for(const replay of [leadingReset([[5000,100,5],[5100]],{mods},1000,15,100),released]){
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    expect(actual.metrics.provenance.coverageQualified).toBe(false);expect(actual.metrics.fields.ur.state).toBe("unknown");
  }
});
it("refuses native reset provenance and a dropped held input followed by released slider input",async()=>{
  const objects="100,192,5000,2,0,L|300:192,1,200",beatmap=map(objects),samples=[[5000,100,5],[5500,200,5],[6000,300,5],[6100]];
  const native=leadingReset(samples,{gameVersion:30000016},1000,15,100);
  expect((await runLibraryNumerical(beatmap,native,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  const parsed=parseReplayFramesWithDiagnostics("0|256|-500|0,1000|256|-500|5,-985|100|192|5,0|100|192|0,4985|100|192|5,500|200|192|5,500|300|192|5,100|300|192|0,");
  const held={...source([]),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
  expect((await runLibraryNumerical(beatmap,held,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("does not turn reset qualification alone into completion/FC for a partial or health-cutoff play",async()=>{
  const beatmap=map("300,192,5000,1,0\n300,192,6000,1,0");
  for(const [replay,perfectCombo] of [
    [leadingReset([[5000,300,5],[5001]]),{state:"unknown",reason:"exact-map-combo-unavailable"}],
    [leadingReset([[5000,300,5],[5001],[6000,300,5],[6100]],{lifeBar:[{time:6100,health:0}]}),{state:"known",value:true}],
  ] as const){
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);expect(actual.metrics.provenance.coverageQualified).toBe(true);
    expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");expect(actual.metrics.fields.perfectCombo).toEqual(perfectCombo);
  }
});
it("publishes a bounded raw strip for a partial observed prefix without completing whole-map scalar counts",async()=>{
  const result=await runLibraryNumerical(map(),source([[0],[1060,300,5],[1061]]),binding,checkpoint);
  expect(result.metrics.fields.accuracy.state).toBe("unknown");
  expect(result.metrics.errorStrip).toMatchObject({state:"known",value:{ruleset:"stable",ok:[1000],miss:[],mapStartMs:1000,mapEndMs:2000}});
});
it("publishes unknown strip for unqualified coverage and preserves early marker times",async()=>{
  const early=await runLibraryNumerical(map(),source([[0],[1000,300,5],[1001],[1940,300,5]]),binding,checkpoint);
  expect(early.metrics.errorStrip).toMatchObject({state:"known",value:{ok:[2000],evaluatedThrough:1940}});
  const absent=await runLibraryNumerical(map(),{...source(completeFrames),parseDiagnostics:undefined},binding,checkpoint);
  expect(absent.metrics.errorStrip).toMatchObject({state:"unknown"});
});

it.each([false,true])("projects complete parsed numerical evidence without a trace/classifier, native=%s", async native => {
  const result = await runLibraryNumerical(map(),source(completeFrames,native),binding,checkpoint);
  expect(result.metrics.fields).toMatchObject({ completion:{value:"passed"},accuracy:{value:1},misses:{value:0},maxCombo:{value:2},
    fc:{value:true},perfectCombo:{value:true},ur:{value:0},biasMs:{value:0},sampleCount:{value:2},comboLosses:{value:0} });
  expect(result.metrics.fields.sliderBreaks).toEqual(native?{state:"not-applicable",reason:"stable-slider-breaks-only"}:{state:"known",value:0});
  expect(JSON.stringify(result.metrics)).not.toMatch(/trace|cause|frames|judgedObjects/);
});

it.each([false,true])("accepts an early resolved final circle without advancing to nominal end, native=%s", async native => {
  const result = await runLibraryNumerical(map(),source([[0],[1000,300,5],[1001],[1980,300,5]],native),binding,checkpoint);
  expect(result.metrics.fields.completion).toEqual({state:"known",value:"passed"}); expect(result.state.currentTime).toBe(1980);
});

it.each([false,true])("rejects fabricated completion from one late frame, gaps, absent diagnostics and unbound map, native=%s", async native => {
  const base = source(completeFrames,native);
  if(!base.parseDiagnostics)throw new Error("Expected parsed fixture");
  const gap = {...base,parseDiagnostics:{...base.parseDiagnostics,sourceCoverageLimits:["initial-actions-unknown","parser-malformed-token"]}};
  for (const replay of [source([[2400]],native),gap,{...base,parseDiagnostics:undefined},source([[0],[1000,300,5]],native)]) {
    const result=await runLibraryNumerical(map(),replay,binding,checkpoint);
    expect(result.metrics.fields.completion.state).toBe("unknown"); expect(result.metrics.fields.fc.state).toBe("unknown");
  }
  const unbound=await runLibraryNumerical(map(),base,{...binding,exactMapAndProfile:false},checkpoint);
  expect(unbound.metrics.fields.completion.state).toBe("unknown"); expect(unbound.metrics.fields.accuracy.state).toBe("unknown");
});

it("does not confuse native final slider head coverage with resolved parent/tail coverage", async () => {
  const result=await runLibraryNumerical(map(slider),source([[0,100],[1000,100,5]],true),binding,checkpoint);
  expect(result.state.lazerJudgements.filter(j=>j.kind==="SLIDER_HEAD")).toHaveLength(1);
  expect(result.metrics.fields.completion.state).toBe("unknown"); expect(result.metrics.fields.fc.state).toBe("unknown");
});

it("native tail loss preserves ordinary FC while exact maximum disqualifies perfect combo", async () => {
  const result=await runLibraryNumerical(map(slider),source([[0,100],[1000,100,5],[1500,200,5],[1900,280,5],[1950,500],[2100,500]],true),binding,checkpoint);
  expect(result.metrics.fields).toMatchObject({ completion:{value:"passed"},misses:{value:0},sliderEndMisses:{value:1},comboLosses:{value:0},
    fc:{value:true},perfectCombo:{value:false} });
});

it.each([true,false])("qualifies Classic component coverage with actual head setting=%s", async classic => {
  const beatmap=map(slider,classic), replay=source([[0,100],[1000,100,5],[1500,200,5],[2000,300,5],[2100,300,5]],true);
  const result=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  expect(result.metrics.fields).toMatchObject({ completion:{value:"passed"},fc:{value:true},perfectCombo:{value:true} });
  const body=beatmap.hitObjects[0] as Slider;
  result.state.lazerJudgements=result.state.lazerJudgements.filter(j=>j.hitObjectId!==body.head.id);
  const missing=await projectLibraryNumerical(beatmap,replay,result.scoring,result.state,binding,checkpoint);
  expect(missing.fields.fc.state).toBe("unknown"); expect(missing.fields.accuracy.state).toBe("unknown");
  expect(missing.errorStrip?.state).toBe("unknown");
});

it("counts zero-combo native head/tick losses and never infers FC from zero main misses", async () => {
  const result=await runLibraryNumerical(map(slider,true),source([[0,500],[1300,500],[1500,200,5],[2000,300,5],[2100,300,5]],true),binding,checkpoint);
  expect(result.metrics.fields.misses).toEqual({state:"known",value:0});
  expect(result.metrics.fields.comboLosses).toMatchObject({state:"known"});
  expect(result.metrics.fields.comboLosses).not.toEqual({state:"known",value:0}); expect(result.metrics.fields.fc).toEqual({state:"known",value:false});
});

it.each([
  { name: "head loss at zero combo", objects: slider, samples: [[0,500],[1300,500],[1500,200,5],[1964,300,5],[2000,300,5],[2100,300,5]],
    head: "MISS", checkpoints: [true,true], parent: "OK", misses: 0, losses: 1, max: 2, accuracy: 1/3, fc: false, ends: 0 },
  { name: "head and tick losses at zero combo", objects: slider, samples: [[0,500],[1300,500],[1500,500],[1900,280,5],[1964,300,5],[2000,300,5],[2100,300,5]],
    head: "MISS", checkpoints: [false,true], parent: "MEH", misses: 0, losses: 2, max: 1, accuracy: 1/6, fc: false, ends: 0 },
  { name: "legacy tail loss preserves ordinary FC", objects: slider, samples: [[0,100],[1000,100,5],[1500,200,5],[1900,500],[1964,500],[2000,500],[2100,500]],
    head: "GREAT", checkpoints: [true,false], parent: "OK", misses: 0, losses: 0, max: 2, accuracy: 1/3, fc: true, ends: 1 },
  { name: "whole-slider miss after combo", objects: "100,192,700,1,0\n" + slider, samples: [[0,100],[700,100,5],[701,500],[1300,500],[1500,500],[1964,500],[2000,500],[2100,500]],
    head: "MISS", checkpoints: [false,false], parent: "MISS", misses: 1, losses: 2, max: 1, accuracy: 1/2, fc: false, ends: 1 },
])("preserves Stable $name without equating displayed SB with complete break evidence", async fixture => {
  const beatmap=map(fixture.objects), body=beatmap.hitObjects.at(-1) as Slider;
  const result=await runLibraryNumerical(beatmap,source(fixture.samples),binding,checkpoint);
  expect(result.state.hitCircleVerdict[body.head.id].type).toBe(fixture.head);
  expect(body.checkPoints.map(point=>result.state.checkPointVerdict[point.id].hit)).toEqual(fixture.checkpoints);
  expect(body.checkPoints.every(point=>Number.isFinite(result.state.checkPointVerdict[point.id].judgementTime))).toBe(true);
  expect(result.state.sliderVerdict[body.id]).toBe(fixture.parent);
  expect(result.metrics.fields).toMatchObject(Object.fromEntries(Object.entries({ completion:"passed", misses:fixture.misses,
    sliderBreaks:0,comboLosses:fixture.losses,maxCombo:fixture.max,accuracy:fixture.accuracy,fc:fixture.fc,perfectCombo:false,
    sliderEndMisses:fixture.ends }).map(([key,value])=>[key,{state:"known",value}])));
});

it("keeps health cutoff unqualified, and NoFail still requires whole observed coverage", async () => {
  const health={lifeBar:[{time:2100,health:0}]};
  const failed=await runLibraryNumerical(map(),source(completeFrames,false,health),binding,checkpoint);
  expect(failed.metrics.fields.completion.state).toBe("unknown");
  const nf=await runLibraryNumerical(map(),source(completeFrames,false,{...health,mods:["NO_FAIL"]}),binding,checkpoint);
  expect(nf.metrics.fields.completion).toEqual({state:"known",value:"passed"});
});

it("keeps empty evidence unknown and propagates cancellation before publication", async () => {
  const result=await runLibraryNumerical(map(),source([],false),binding,checkpoint);
  expect(result.metrics.fields.accuracy.state).toBe("unknown"); expect(result.metrics.fields.ur.state).toBe("unknown");
  const error=new Error("cancel numerical owner");
  await expect(runLibraryNumerical(map(),source(completeFrames),binding,async()=>{throw error;})).rejects.toBe(error);
});

it("does not project standard-mode completion or metrics for a nonstandard replay", async () => {
  const result=await runLibraryNumerical(map(),source(completeFrames,false,{gameMode:3}),binding,checkpoint);
  expect(result.metrics.fields.completion.state).toBe("unknown"); expect(result.metrics.fields.fc.state).toBe("unknown");
  expect(result.metrics.fields.accuracy.state).toBe("unknown");
});

it("rejects explicit digest contradictions and malformed verified bindings", async () => {
  for(const replay of [source(completeFrames,false,{beatmapMd5:"d".repeat(32)}),source(completeFrames,false,{replayContentSha256:"e".repeat(64)})]) {
    await expect(runLibraryNumerical(map(),replay,binding,checkpoint)).rejects.toThrow(/binding/);
  }
  await expect(runLibraryNumerical(map(),source(completeFrames),{...binding,mapSha256:"bad"},checkpoint)).rejects.toThrow(/binding/);
});

function initialHeldNative(samples:number[][],extra:Partial<OsuReplay>={},release=-1544):OsuReplay {
  let previous=release;const suffix=samples.map(([time,x=300,mask=0])=>{const delta=time-previous;previous=time;return `${delta}|${x}|192|${mask},`;}).join("");
  const parsed=parseReplayFramesWithDiagnostics(`-1575|281|248|0,13|281|248|1,17|282|247|1,0|283|246|1,${release+1545}|284|245|0,${suffix}`);
  return {...source([],true,{lazerMods:[],...extra}),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
}
it.each(([[],["AUTO_PLAY"]] as OsuReplay["mods"][]).map(mods=>({mods})))("qualifies exact Stable initial-negative recorded input $mods without changing state",async({mods})=>{
  const replay=nativeInitialNegative([[1789,300,1],[1790],[2801,300,1],[2900]],{gameVersion:20260711,mods,lazerMods:undefined},-100000,289);
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,1789,1,0\n300,192,2789,1,0")),{mods,addStacking:false}),before=JSON.stringify(replay);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const clean=await runLibraryNumerical(beatmap,source(replay.frames.map(f=>[f.time,f.position.x,f.rawButtonMask??0]),false,{mods}),binding,checkpoint);
  expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-initial-negative-v1"});
  expect(actual.state).toEqual(clean.state);expect(actual.metrics.fields).toEqual(clean.metrics.fields);expect(actual.metrics.errorStrip).toEqual(clean.metrics.errorStrip);
  expect(actual.metrics.fields.ur).toMatchObject({state:"known",value:60});expect(JSON.stringify(replay)).toBe(before);
});
it.each(["300,192,425,1,0","100,192,425,2,0,L|300:192,1,200","256,192,425,8,0,1425"])(
  "qualifies native initial held input released before activation, preserving structural state: %s",async object=>{
    const beatmap=map(object+"\n300,192,2500,1,0"),replay=initialHeldNative([[425,100,1],[1426],[2500,300,1],[2600]]),before=JSON.stringify(replay);
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    const explicit={time:-1575,position:{x:281,y:248},actions:[],rawButtonMask:0};
    const reference=await new LazerGameStateTimeMachine([explicit,...actual.scoring.frames],beatmap).evaluateReplayAsync(checkpoint);
    expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"native-initial-held-release-v1"});
    expect(actual.state).toEqual(reference);expect(actual.metrics).toEqual(await projectLibraryNumerical(beatmap,replay,actual.scoring,reference,binding,checkpoint));
    expect(actual.metrics.fields.ur.state).toBe("known");expect(JSON.stringify(replay)).toBe(before);
  });

function stableInitialReplay(mods:OsuReplay["mods"]=[],first=289):OsuReplay {
  return nativeInitialNegative([[1789,300,1],[1790],[2801,300,1],[2900]],{gameVersion:20260711,mods,lazerMods:undefined},-100000,first);
}
it.each(["stable","native"])("rejects malformed initial capability evidence independently: %s",async kind=>{
  const beatmap=map("300,192,1789,1,0\n300,192,2789,1,0"),make=()=>kind==="stable"?stableInitialReplay():initialHeldNative([[1789,300,1],[1790],[2801,300,1],[2900]]);
  const baseline=await runLibraryNumerical(beatmap,make(),binding,checkpoint);
  for(const fault of ["missing","version","parser","diagnostic-parser","shape","token-shape","count","raw-count","release-index","nonfinite","sum","clock","raw-index",
    "position","mask","action","initial-held","coordinate","first-mark","suffix-mark","suffix-gap","skipped","warning","initial-known","oversize","negative-later","reversed-suffix","missing-source"]){
    const replay=make(),d=replay.parseDiagnostics;if(!d)throw Error("Missing fixture diagnostics");
    const w=kind==="stable"?d.initialNegativeWitness:d.initialHeldPrefixWitness;if(!w)throw Error("Missing fixture initial witness");
    const release=kind==="stable"?0:d.initialHeldPrefixWitness?.releaseFrameIndex??0;
    if(fault==="missing"){delete d.initialNegativeWitness;delete d.initialHeldPrefixWitness;}
    if(fault==="version")Object.assign(w,{version:"unknown"});if(fault==="parser")w.parserVersion="unknown";if(fault==="diagnostic-parser")d.parserVersion="unknown";
    if(fault==="shape")Object.assign(w,{extra:true});if(fault==="token-shape")Object.assign(w.tokens[0],{extra:true});if(fault==="count")w.frameCount++;
    if(fault==="raw-count")w.rawTokenCount++;if(fault==="release-index")Object.assign(w,{releaseFrameIndex:9999});
    if(fault==="nonfinite")w.tokens[0].timeAfter=Infinity;if(fault==="sum")w.tokens[1].timeAfter++;if(fault==="clock")w.tokens[0].timeBefore=1;
    if(fault==="raw-index")w.tokens[1].rawTokenIndex++;if(fault==="position")replay.frames[0].position.x++;if(fault==="mask")replay.frames[0].rawButtonMask=16;
    if(fault==="action")replay.frames[0].actions=[1];if(fault==="initial-held")w.tokens[0].rawButtonMask=5;if(fault==="coordinate")w.tokens[0].x=131073;
    if(fault==="first-mark")delete d.frameSources[0].discontinuityBefore;if(fault==="suffix-mark")d.frameSources[release+1].discontinuityBefore=["parser-negative-delta"];
    if(fault==="suffix-gap")d.frameSources[release+1].rawTokenIndex++;if(fault==="skipped")d.skippedTokens.pop();if(fault==="warning")d.sourceCoverageLimits.push("parser-malformed-token");
    if(fault==="initial-known")d.initialActionsKnown=true;if(fault==="oversize")w.tokens.push(...Array.from({length:256},()=>({...w.tokens[0]})));
    if(fault==="negative-later")w.tokens[1].delta=-1;if(fault==="reversed-suffix")replay.frames[release+1].time=replay.frames[release].time-1;
    if(fault==="missing-source")d.frameSources.pop();
    const result=await projectLibraryNumerical(beatmap,replay,baseline.scoring,baseline.state,binding,checkpoint);
    expect({kind,fault,qualified:result.provenance.coverageQualified}).toEqual({kind,fault,qualified:false});expect(result.fields.ur.state).toBe("unknown");expect(result.errorStrip?.state).toBe("unknown");
  }
});
it.each(["RELAX","AUTO_PILOT"] as const)("does not admit Stable initial-negative unsupported input %s",async mod=>{
  const mods=[mod],beatmap=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods,addStacking:false});
  expect((await runLibraryNumerical(beatmap,stableInitialReplay(mods),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["RELAX","AUTO_PILOT"] as const)("keeps other automation excluded from supported AT combinations: %s",async other=>{
  const mods:OsuReplay["mods"]=["AUTO_PLAY",other],beatmap=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods,addStacking:false});
  expect((await runLibraryNumerical(beatmap,stableInitialReplay(mods),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["CL","RX","AP","AT","SO","UNKNOWN"])("keeps native held-initial profile exclusions: %s",async acronym=>{
  const lazerMods=[{acronym}],mods=legacyModsFromLazerMods(lazerMods),beatmap=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods,lazerMods,addStacking:false});
  expect((await runLibraryNumerical(beatmap,initialHeldNative([[1000,300,1],[2100]],{mods,lazerMods}),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["stable","native"])("retains strict activation, map/profile binding and partial outcome gates: %s",async kind=>{
  for(const first of ["300,192,1789,1,0","100,192,1789,2,0,L|300:192,1,200","256,192,1789,8,0,2789"]){
    const beatmap=map(first+"\n300,192,4000,1,0"),boundary=Math.min(...beatmap.hitObjects.map(o=>o instanceof Spinner?o.startTime:o.spawnTime));
    for(const time of [boundary-1,boundary,boundary+1]){
      const replay=kind==="stable"?stableInitialReplay([],time):initialHeldNative([[2900]],{},time);
      const result=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
      expect(result.metrics.provenance.coverageQualified).toBe(time<boundary);
      expect(result.metrics.fields.completion.state).toBe("unknown");expect(result.metrics.fields.fc.state).toBe("unknown");
    }
    const replay=kind==="stable"?stableInitialReplay():initialHeldNative([[2900]]);
    expect((await runLibraryNumerical(beatmap,replay,{...binding,exactMapAndProfile:false},checkpoint)).metrics.provenance.coverageQualified).toBe(false);
    replay.gameMode=1;expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  }
});
it.each([[],["AUTO_PLAY"],["AUTO_PLAY","DOUBLE_TIME","HIDDEN"],["AUTO_PLAY","HARD_ROCK"],["AUTO_PLAY","SPUN_OUT"]].map(mods=>({mods:mods as OsuReplay["mods"]})))("proves Stable initial-negative finite-history and recorded mechanics for $mods",async({mods})=>{
  const replay=stableInitialReplay(mods),beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,1789,2,0,L|400:192,1,100\n300,192,2789,1,0")),{mods,addStacking:false});
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint),options={hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion} as const;
  for(let current=0;current<4;current++)for(let previous=0;previous<4;previous++)for(let older=0;older<4;older++){
    const state=defaultGameState(),evaluator=new GameStateEvaluator(beatmap,options);
    state.pressingSince=[current&1?-100001:NOT_PRESSING,current&2?-100001:NOT_PRESSING];state.stablePreviousButtons=previous;state.stablePreviousPreviousButtons=older;
    evaluator.evaluate(state,{time:-100000,position:{x:280,y:180},actions:[],rawButtonMask:0});
    for(const frame of actual.scoring.frames)evaluator.evaluate(state,frame);
    expect(state).toEqual(actual.state);
  }
  if(mods.includes("AUTO_PLAY")){
    const absent=stableInitialReplay(mods);for(const f of absent.frames){f.rawButtonMask=0;f.actions=[];}
    const absentResult=await runLibraryNumerical(beatmap,absent,binding,checkpoint);
    expect(absentResult.metrics.provenance.coverageQualified).toBe(true);expect(absentResult.metrics.fields.ur.state).toBe("unknown");
    expect(absentResult.state.hitCircleVerdict).not.toEqual(actual.state.hitCircleVerdict);
  }
});
it("proves native held-prefix latch/cursor convergence at release and source versus clean structural state",async()=>{
  const replay=initialHeldNative([[425,300,1],[426],[1425,300,1],[1500]]),beatmap=map("300,192,425,1,0\n300,192,1425,1,0");
  const prefix=replay.frames.slice(0,4),actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const checkpointState=await new LazerGameStateTimeMachine(prefix,beatmap).evaluateReplayAsync(checkpoint);
  for(let buttons=0;buttons<4;buttons++)for(const position of [{x:-100,y:100},{x:512,y:384}]){
    const state=defaultGameState(),evaluator=new LazerGameStateEvaluator(beatmap);
    state.pressingSince=[buttons&1?-2000:NOT_PRESSING,buttons&2?-2000:NOT_PRESSING];state.cursorPosition=position;
    evaluator.evaluate(state,{time:-1575,position:{x:281,y:248},actions:[],rawButtonMask:0});
    for(const frame of prefix)evaluator.evaluate(state,frame);
    expect(state).toEqual(checkpointState);
    for(const frame of actual.scoring.frames.slice(4))evaluator.evaluate(state,frame);
    expect(state).toEqual(actual.state);
  }
});
it.each(["stable","native"])("keeps initial capability suffix validation cooperative and cancellable: %s",async kind=>{
  const raw=(kind==="stable"?"-100000|280|180|0,100289|300|192|0,":"-1575|281|248|0,13|281|248|1,17|282|247|1,1|284|245|0,")+"1|300|192|0,".repeat(1024);
  const parsed=parseReplayFramesWithDiagnostics(raw),replay={...(kind==="stable"?stableInitialReplay():initialHeldNative([])),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
  const beatmap=map("300,192,5000,1,0");let calls=0;const actual=await runLibraryNumerical(beatmap,replay,binding,async()=>{calls++;});
  expect(actual.metrics.provenance.coverageQualified).toBe(true);expect(calls).toBeGreaterThan(4);
  let count=0;await expect(projectLibraryNumerical(beatmap,replay,actual.scoring,actual.state,binding,async()=>{if(++count===3)throw Error("initial cancellation");})).rejects.toThrow("initial cancellation");
});

it("keeps unrecognised mechanics outside Stable initial-negative support",async()=>{
  const beatmap=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods:[],lazerMods:[{acronym:"UNKNOWN"}],addStacking:false});
  expect((await runLibraryNumerical(beatmap,stableInitialReplay(),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(([[],["HARD_ROCK"],["DOUBLE_TIME"],["SPUN_OUT"],["SCORE_V2"],["AUTO_PLAY"]] as OsuReplay["mods"][]).flatMap(mods=>[
  "300,192,1789,1,0","100,192,1789,2,0,L|300:192,1,200","256,192,1789,8,0,2289",
].map(object=>({mods,object}))))("preserves Stable initial-negative source versus clean circle/slider/spinner mechanics $mods $object",async({mods,object})=>{
  const replay=stableInitialReplay(mods),beatmap=buildBeatmap(parseBlueprint(traceMapText(object+"\n300,192,2789,1,0")),{mods,addStacking:false});
  const clean=source(replay.frames.map(f=>[f.time,f.position.x,f.rawButtonMask??0]),false,{mods});
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint),reference=await runLibraryNumerical(beatmap,clean,binding,checkpoint);
  expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-initial-negative-v1"});
  expect(actual.state).toEqual(reference.state);expect(actual.metrics.fields).toEqual(reference.metrics.fields);expect(actual.metrics.errorStrip).toEqual(reference.metrics.errorStrip);
});
it.each(nativeProfiles)("preserves native held-prefix fixed/custom supported clock $name",async profile=>{
  const mods=legacyModsFromLazerMods(profile.mods),replay=initialHeldNative([[5000,100,1],[5500,200,1],[6000,300,1],[6100],[7000,300,1],[7100]],{mods,lazerMods:profile.mods});
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,5000,2,0,L|300:192,1,200\n300,192,7000,1,0")),{mods,lazerMods:profile.mods,addStacking:false});
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const reference=await new LazerGameStateTimeMachine([{time:-1575,position:{x:281,y:248},actions:[],rawButtonMask:0},...actual.scoring.frames],beatmap).evaluateReplayAsync(checkpoint);
  expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"native-initial-held-release-v1"});expect(actual.state).toEqual(reference);
});

it("preserves native same-time held/release/repress ordering after a qualified initial prefix",async()=>{
  const beatmap=map("300,192,425,1,0\n300,192,425,1,0\n300,192,1425,1,0");
  const replay=initialHeldNative([[425,300,1],[425,301,0],[425,300,2],[426],[1425,300,1],[1500]]),before=JSON.stringify(replay.frames);
  const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const reference=await new LazerGameStateTimeMachine([{time:-1575,position:{x:281,y:248},actions:[],rawButtonMask:0},...actual.scoring.frames],beatmap).evaluateReplayAsync(checkpoint);
  expect(actual.metrics.provenance.coverageQualified).toBe(true);expect(actual.state).toEqual(reference);
  expect(actual.state.hitCircleVerdict).toEqual(reference.hitCircleVerdict);expect(JSON.stringify(replay.frames)).toBe(before);
});

const supportedAutoPlayCombinations:OsuReplay["mods"][]=[
  ["AUTO_PLAY","DOUBLE_TIME","HIDDEN"],["AUTO_PLAY","HARD_ROCK"],["AUTO_PLAY","SPUN_OUT"],["AUTO_PLAY","EASY"],
  ["AUTO_PLAY","HALF_TIME"],["AUTO_PLAY","DOUBLE_TIME","NIGHT_CORE"],["AUTO_PLAY","FLASH_LIGHT"],
  ["AUTO_PLAY","NO_FAIL"],["AUTO_PLAY","SUDDEN_DEATH"],["AUTO_PLAY","PERFECT"],["AUTO_PLAY","TOUCH_DEVICE"],["AUTO_PLAY","SCORE_V2"],
];
it.each(supportedAutoPlayCombinations.flatMap(mods=>[
  "300,192,1789,1,0","100,192,1789,2,0,L|300:192,1,200","256,192,1789,8,0,2289",
].map(object=>({mods,object}))))("qualifies supported AT combination without changing recorded mechanics: $mods $object",async({mods,object})=>{
  const replay=stableInitialReplay(mods),beatmap=buildBeatmap(parseBlueprint(traceMapText(object+"\n300,192,2789,1,0")),{mods,addStacking:false});
  const before=JSON.stringify(replay),actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
  const clean=source(replay.frames.map(f=>[f.time,f.position.x,f.rawButtonMask??0]),false,{mods});
  const reference=await runLibraryNumerical(beatmap,clean,binding,checkpoint);
  expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-initial-negative-v1"});
  expect(actual.state).toEqual(reference.state);expect(actual.metrics.fields).toEqual(reference.metrics.fields);expect(actual.metrics.errorStrip).toEqual(reference.metrics.errorStrip);
  expect(JSON.stringify(replay)).toBe(before);
});

it.each(["missing-AT-on-map","missing-AT-on-source","different-mods","unsupported","invalid-clock","native-RX","native-AP"])(
  "rejects unsupported or mismatched AT combination: %s",async fault=>{
    const mods:OsuReplay["mods"]=["AUTO_PLAY","DOUBLE_TIME","HIDDEN"],replay=stableInitialReplay(mods);
    const beatmap=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods,addStacking:false});
    const baseline=await runLibraryNumerical(beatmap,replay,binding,checkpoint);
    if(fault==="missing-AT-on-map")Object.assign(beatmap,{appliedMods:["DOUBLE_TIME","HIDDEN"]});if(fault==="missing-AT-on-source")replay.mods=["DOUBLE_TIME","HIDDEN"];
    if(fault==="different-mods")replay.mods=["AUTO_PLAY","HARD_ROCK"];if(fault==="unsupported")Object.assign(beatmap,{lazerMods:[{acronym:"UNKNOWN"}]});
    if(fault==="invalid-clock")Object.assign(beatmap,{gameClockRate:NaN});
    if(fault==="native-RX")Object.assign(beatmap,{lazerMods:[{acronym:"RX"}]});if(fault==="native-AP")Object.assign(beatmap,{lazerMods:[{acronym:"AP"}]});
    const result=await projectLibraryNumerical(beatmap,replay,baseline.scoring,baseline.state,binding,checkpoint);
    expect(result.provenance.coverageQualified).toBe(false);expect(result.fields.ur.state).toBe("unknown");
  });
it("uses the modified activation boundary for AT+DT+HD instead of relaxing it for automation",async()=>{
  const mods:OsuReplay["mods"]=["AUTO_PLAY","DOUBLE_TIME","HIDDEN"],beatmap=buildBeatmap(parseBlueprint(traceMapText("300,192,1789,1,0")),{mods,addStacking:false});
  const boundary=beatmap.hitObjects[0].spawnTime;
  for(const first of [boundary-1,boundary,boundary+1]){
    expect((await runLibraryNumerical(beatmap,stableInitialReplay(mods,first),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(first<boundary);
  }
});

function neutralLaterReset():OsuReplay {
  return heldPrefix("0|256|-500|0,5870|256|-500|0,50|143.3076|222.4999|0,15|141.9343|218.7231|0,-11|141.2476|216.3197|0,17|140.5609|213.573|0,4059|100|192|5,1|100|192|0,1999|300|192|5,1|300|192|0,");
}
it.each(["100,192,10000,1,0","100,192,10000,2,0,L|300:192,1,200","256,192,10000,8,0,11000"])(
  "qualifies the complete neutral single-later-reset shape without changing state: %s",async first=>{
    const beatmap=map(first+"\n300,192,12000,1,0\n300,192,15000,1,0"),replay=neutralLaterReset(),before=JSON.stringify(replay);let prior=0;
    const clean=heldPrefix("0|256|-500|0,0|256|-500|0,"+replay.frames.map(f=>{const delta=f.time-prior;prior=f.time;return `${delta}|${f.position.x}|${f.position.y}|${f.rawButtonMask},`;}).join(""));
    const actual=await runLibraryNumerical(beatmap,replay,binding,checkpoint),reference=await runLibraryNumerical(beatmap,clean,binding,checkpoint);
    expect(actual.metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-neutral-later-reset-v1"});
    expect(actual.state).toEqual(reference.state);expect(actual.metrics.fields).toEqual(reference.metrics.fields);expect(actual.metrics.errorStrip).toEqual(reference.metrics.errorStrip);
    expect(actual.metrics.fields.ur.state).toBe(first.includes(",8,")?"unknown":"known");expect(actual.metrics.fields.completion.state).toBe("unknown");expect(actual.metrics.fields.fc.state).toBe("unknown");expect(JSON.stringify(replay)).toBe(before);
  });

it("rejects incomplete single-later-reset facts and never substitutes missing older witnesses",async()=>{
  const beatmap=map("100,192,10000,1,0\n300,192,12000,1,0"),baseline=await runLibraryNumerical(beatmap,neutralLaterReset(),binding,checkpoint);
  for(const fault of ["missing","wrong-tag","count","raw-count","release-index","extra-shape","held","raw-gap","bad-sum","high-water","equal-boundary","position","source-gap","source-mark","skip","chronology","suffix-clock","zero-reset"]){
    const replay=neutralLaterReset(),d=replay.parseDiagnostics,w=d?.neutralPrefixWitness;if(!d||!w)throw Error("Expected later reset fixture");
    if(fault==="missing")delete d.neutralPrefixWitness;if(fault==="wrong-tag")Object.assign(w,{version:"stable-neutral-multi-reset-v1"});
    if(fault==="count")w.frameCount++;if(fault==="raw-count")w.rawTokenCount++;if(fault==="release-index")w.releaseFrameIndex--;
    if(fault==="extra-shape")Object.assign(w,{extra:true});if(fault==="held")w.tokens[2].rawButtonMask=5;if(fault==="raw-gap")w.tokens[3].rawTokenIndex++;
    if(fault==="bad-sum")w.tokens[4].timeAfter++;if(fault==="high-water")w.tokens[1].timeAfter=10000;if(fault==="equal-boundary")w.tokens[5].timeAfter=9400;
    if(fault==="position")replay.frames[0].position.x++;if(fault==="source-gap")d.frameSources[3].rawTokenIndex++;if(fault==="source-mark")delete d.frameSources[2].discontinuityBefore;
    if(fault==="skip")d.skippedTokens.splice(2,1);if(fault==="chronology")replay.frames[2].time=5921;if(fault==="suffix-clock")replay.frames[3].time=5900;
    if(fault==="zero-reset")w.tokens[4].delta=0;
    const result=await projectLibraryNumerical(beatmap,replay,baseline.scoring,baseline.state,binding,checkpoint);
    expect({fault,qualified:result.provenance.coverageQualified}).toEqual({fault,qualified:false});
  }
  const canonical=heldPrefix("0|256|-500|0,100|256|-500|0,-100|100|192|0,20|100|192|0,9980|100|192|5,1|100|192|0,");
  expect(canonical.parseDiagnostics?.leadingResetWitness).toBeDefined();delete canonical.parseDiagnostics?.leadingResetWitness;
  expect(canonical.parseDiagnostics?.neutralPrefixWitness).toBeUndefined();expect((await runLibraryNumerical(beatmap,canonical,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  const multi=neutralMultiReset();if(!multi.parseDiagnostics?.neutralPrefixWitness)throw Error("Expected older multi witness");
  Object.assign(multi.parseDiagnostics.neutralPrefixWitness,{version:"stable-neutral-later-reset-v1"});
  expect((await runLibraryNumerical(map("100,192,14064,1,0"),multi,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  delete multi.parseDiagnostics.neutralPrefixWitness;
  expect((await runLibraryNumerical(map("100,192,14064,1,0"),multi,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it.each(["100,192,10000,1,0","100,192,10000,2,0,L|300:192,1,200","256,192,10000,8,0,11000"])(
  "keeps complete later-reset clocks strictly before effect and retained chronology: %s",async object=>{
    const beatmap=map(object),boundary=object.includes(",8,")?10000:9601;
    for(const high of [boundary-1,boundary,boundary+1]){
      const raw=`0|256|-500|0,100|256|-500|0,${high-100}|100|192|0,-10|100|192|0,10|100|192|0,${11000-high}|100|192|0,`;
      const replay=heldPrefix(raw);expect(replay.parseDiagnostics?.neutralPrefixWitness?.version).toBe("stable-neutral-later-reset-v1");
      expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(high<boundary);
    }
    const reversed=heldPrefix("0|256|-500|0,100|256|-500|0,50|100|192|0,-20|100|192|0,10|100|192|0,10000|100|192|0,");
    expect(reversed.parseDiagnostics?.neutralPrefixWitness).toBeDefined();expect((await runLibraryNumerical(beatmap,reversed,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  });
it.each(["RELAX","AUTO_PLAY","AUTO_PILOT"] as const)("does not broaden later-reset automation domain to %s",async mod=>{
  const mods=[mod],replay=neutralLaterReset();replay.mods=mods;
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,10000,1,0")),{mods,addStacking:false});
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("preserves supported SO later-reset input while native/nonstandard/unknown mechanics stay excluded",async()=>{
  const replay=neutralLaterReset();replay.mods=["SPUN_OUT"];
  const beatmap=buildBeatmap(parseBlueprint(traceMapText("100,192,10000,1,0\n300,192,12000,1,0")),{mods:replay.mods,addStacking:false});
  expect((await runLibraryNumerical(beatmap,replay,binding,checkpoint)).metrics.provenance).toMatchObject({coverageQualified:true,sourceCoverageEvidence:"stable-neutral-later-reset-v1"});
  for(const changed of [{...replay,gameVersion:30000019,lazerMods:[]},{...replay,gameMode:1}])
    expect((await runLibraryNumerical(beatmap,changed,binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
  const unsupported=buildBeatmap(parseBlueprint(traceMapText(circles)),{mods:[],lazerMods:[{acronym:"UNKNOWN"}],addStacking:false});
  expect((await runLibraryNumerical(unsupported,neutralLaterReset(),binding,checkpoint)).metrics.provenance.coverageQualified).toBe(false);
});
it("proves later-reset finite-history convergence and structural direct/production equality",async()=>{
  const replay=neutralLaterReset(),beatmap=map("100,192,10000,2,0,L|300:192,1,200\n300,192,12000,1,0");
  const result=await runLibraryNumerical(beatmap,replay,binding,checkpoint),options={hitWindowStyle:"OSU_STABLE",noteLockStyle:"STABLE",replayGameVersion:replay.gameVersion} as const;
  for(let current=0;current<4;current++)for(let previous=0;previous<4;previous++)for(let older=0;older<4;older++){
    const state=defaultGameState(),evaluator=new GameStateEvaluator(beatmap,options);state.pressingSince=[current&1?-1000:NOT_PRESSING,current&2?-1000:NOT_PRESSING];state.stablePreviousButtons=previous;state.stablePreviousPreviousButtons=older;
    for(const frame of result.scoring.frames)evaluator.evaluate(state,frame);expect(state).toEqual(result.state);
  }
});
it("keeps later-reset source validation cancellable through a long suffix",async()=>{
  const replay=heldPrefix("0|256|-500|0,100|256|-500|0,50|100|192|0,-10|100|192|0,20|100|192|0,"+"1|100|192|0,".repeat(1024));
  const beatmap=map("100,192,10000,1,0");let calls=0;const result=await runLibraryNumerical(beatmap,replay,binding,async()=>{calls++;});
  expect(result.metrics.provenance.coverageQualified).toBe(true);expect(calls).toBeGreaterThan(4);
  let checks=0;await expect(projectLibraryNumerical(beatmap,replay,result.scoring,result.state,binding,async()=>{if(++checks===3)throw Error("later reset cancellation");})).rejects.toThrow("later reset cancellation");
});
