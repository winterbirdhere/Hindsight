import { buildBeatmap, BucketedGameStateTimeMachine, LazerGameStateTimeMachine, parseBlueprint, parseReplayFramesWithDiagnostics } from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";
import type { CurrentReplayReuseBinding } from "../../library/library-current-replay";
import { projectCurrentReplayResults } from "../../library/library-current-replay";
import { LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../../../shared/library-analysis";

const rawMap=`osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1000,1,0,0:0:0:0:
`;
function fixture(mode:CurrentReplayReuseBinding["mode"]="stable") {
  const parsed=parseReplayFramesWithDiagnostics("0|256|-500|0,0|256|-500|0,0|100|100|0,1000|100|100|5,500|100|100|0,");
  const replay:OsuReplay={gameVersion:mode==="stable"?20240101:30000019,gameMode:0,md5hash:"fixture",player:"Fixture",mods:[],
    lazerMods:mode==="lazer-classic"?[{acronym:"CL"}]:mode==="lazer"?[]:undefined,
    beatmapMd5:"c".repeat(32),replayContentSha256:"a".repeat(64),frames:parsed.frames,parseDiagnostics:parsed.diagnostics};
  const map=buildBeatmap(parseBlueprint(rawMap),{lazerMods:replay.lazerMods});
  const binding:CurrentReplayReuseBinding={replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:replay.beatmapMd5,
    numericalInputKey:"d".repeat(64),mode,clockRate:map.gameClockRate,objectCount:1,
    parserVersion:LIBRARY_REPLAY_PARSER_VERSION,preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION};
  const options={beatmapContentSha256:binding.mapSha256,beatmapMd5:binding.mapMd5,libraryReuseBinding:binding};
  const simulator=new GameSimulator();
  return {simulator,replay,map,binding,options};
}
afterEach(()=>jest.restoreAllMocks());

it.each(["stable","lazer","lazer-classic"] as const)("projects the retained %s recording state despite comparison focus",async mode=>{
  const {simulator,map,replay,binding,options}=fixture(mode);simulator.simulateReplay(map,replay,options);
  const context=simulator.getLibraryReplayContext()!;
  simulator.setRulesetFocus(mode==="stable"?"lazer":"stable");
  const stable=jest.spyOn(BucketedGameStateTimeMachine.prototype,"gameStateAt"),native=jest.spyOn(LazerGameStateTimeMachine.prototype,"gameStateAt");
  const numerical=await simulator.captureLibraryNumerical(context,async()=>undefined);
  expect(stable).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled();
  expect(numerical.projected.fields).toMatchObject({completion:{state:"known",value:"passed"},accuracy:{state:"known",value:1},
    misses:{state:"known",value:0},fc:{state:"known",value:true},perfectCombo:{state:"known",value:true},ur:{state:"known",value:0}});
  expect(numerical.projected.errorStrip).toMatchObject({state:"known",value:{ruleset:mode==="stable"?"stable":"lazer",miss:[]}});
  expect(context.binding.mode).toBe(mode);expect(context.performanceInput.mode).toBe(mode);
  expect(projectCurrentReplayResults(binding,{binding:context.binding,numerical}).projections[0].metrics.fields).toEqual(numerical.projected.fields);
});

it("keeps unavailable parser evidence unknown without reusing plausible display values",async()=>{
  const {simulator,map,replay,options}=fixture();replay.parseDiagnostics=undefined;simulator.simulateReplay(map,replay,options);
  const numerical=await simulator.captureLibraryNumerical(simulator.getLibraryReplayContext()!,async()=>undefined);
  expect(numerical.projected.fields.completion.state).toBe("unknown");expect(numerical.projected.fields.fc.state).toBe("unknown");
  expect(numerical.projected.fields.accuracy.state).toBe("unknown");
});

it("propagates cancellation without caching partial evidence and can retry from the same retained state",async()=>{
  const {simulator,map,replay,options}=fixture();simulator.simulateReplay(map,replay,options);
  const context=simulator.getLibraryReplayContext()!;let checkpoints=0;
  await expect(simulator.captureLibraryNumerical(context,async()=>{if(++checkpoints===3)throw Error("cancel capture");})).rejects.toThrow("cancel capture");
  const result=await simulator.captureLibraryNumerical(context,async()=>undefined);
  expect(result.projected.fields.fc).toEqual({state:"known",value:true});
  let cachedChecks=0;expect((await simulator.captureLibraryNumerical(context,async()=>{cachedChecks++;})).projected).toEqual(result.projected);
  expect(cachedChecks).toBeLessThanOrEqual(2);
  result.projected.fields.fc={state:"known",value:false};
  if(result.projected.errorStrip?.state==="known")result.projected.errorStrip.value.miss.push(1000);
  const again=await simulator.captureLibraryNumerical(context,async()=>undefined);
  expect(again.projected.fields.fc).toEqual({state:"known",value:true});
  expect(again.projected.errorStrip).toMatchObject({state:"known",value:{miss:[]}});
});

it("retains the admitted binding and final state while the viewer seeks during cooperative capture",async()=>{
  const {simulator,map,replay,options}=fixture();simulator.simulateReplay(map,replay,options);
  const context=simulator.getLibraryReplayContext()!;options.libraryReuseBinding.numericalInputKey="e".repeat(64);
  let time=0;
  const result=await simulator.captureLibraryNumerical(context,async()=>{simulator.simulate(time);time=time===0?1500:0;});
  expect(context.binding.numericalInputKey).toBe("d".repeat(64));
  expect(result.projected.fields.fc).toEqual({state:"known",value:true});
  expect(simulator.isLibraryReplayCurrent(context)).toBe(true);
});

it.each(["clear","reload"])("rejects late projection after %s, including an identical replay loaded again",async action=>{
  const {simulator,map,replay,options}=fixture();simulator.simulateReplay(map,replay,options);
  const context=simulator.getLibraryReplayContext()!;let changed=false;
  await expect(simulator.captureLibraryNumerical(context,async()=>{
    if(!changed){changed=true;if(action==="clear")simulator.clear();else simulator.simulateReplay(map,replay,options);}
  })).rejects.toThrow(/changed/i);
  expect(simulator.isLibraryReplayCurrent(context)).toBe(false);
});

it.each(["unbound","hash","mode","rate","version"])("declines %s capture without preventing normal viewer preparation",kind=>{
  const {simulator,map,replay,options}=fixture();
  if(kind==="unbound")options.libraryReuseBinding=undefined as never;
  if(kind==="hash")options.beatmapContentSha256="e".repeat(64);
  if(kind==="mode")options.libraryReuseBinding.mode="lazer";
  if(kind==="rate")options.libraryReuseBinding.clockRate=1.5;
  if(kind==="version")options.libraryReuseBinding.parserVersion="old";
  expect(()=>simulator.simulateReplay(map,replay,options)).not.toThrow();
  expect(simulator.getPrimaryReplay()).toBe(replay);expect(simulator.getLibraryReplayContext()).toBeUndefined();
});
