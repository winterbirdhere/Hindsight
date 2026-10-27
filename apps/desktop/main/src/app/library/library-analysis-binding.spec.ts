import { describeLibraryNumericalResources } from "./library-analysis-binding";
import type { PreparedLibraryMap, PreparedLibraryReplay } from "./library-selected-resources";

function fixture() {
  const replay={data:{gameMode:0,gameVersion:20200101,replayContentSha256:"a".repeat(64),beatmapMD5:"c".repeat(32),mods:0},
    receipt:{sha256:"a".repeat(64),available:true}} as PreparedLibraryReplay;
  const map={map:{sha256:"b".repeat(64),md5:"c".repeat(32),bytes:Buffer.from("map")}} as PreparedLibraryMap;
  return {replay,map};
}
it("omits retired incident receipts while preserving numerical dependencies",()=>{
  const {replay,map}=fixture(),first=describeLibraryNumericalResources(replay,map,123);
  expect(first).not.toHaveProperty("incidentEvidence");
  replay.data.savedScoreSource={status:"absent",attempts:[]};
  const second=describeLibraryNumericalResources(replay,map,123);
  expect(second).toEqual(first);expect(second).not.toHaveProperty("incidentEvidence");
});
it("binds exact scalar input keys without depending on optional saved cause evidence or resource locations",()=>{
  const {replay,map}=fixture(),first=describeLibraryNumericalResources(replay,map,123);
  expect(first.input).toMatchObject({format:"resources",replayBytes:123,mapBytes:3,binding:{exactMapAndProfile:true}});
  expect(first.target).toMatchObject({slot:"numerical",stage:"S"});expect(first.target.inputKey).toMatch(/^[a-f0-9]{64}$/);
  replay.data.savedScoreSource={status:"unavailable",reason:"changed-optional-cause-evidence",attempts:[]};
  expect(describeLibraryNumericalResources(replay,map,456).target).toEqual(first.target);
  replay.data.sourceClient="lazer";replay.data.sourceProvenance="user-confirmed";
  const changed=describeLibraryNumericalResources(replay,map,456);expect(changed.target.inputKey).not.toBe(first.target.inputKey);
  expect(changed.input.binding.exactMapAndProfile).toBe(false);
});

it("preserves native mod settings and distinguishes absent mods from known no-mods",()=>{
  const {replay,map}=fixture();replay.data.gameVersion=30000016;
  const absent=describeLibraryNumericalResources(replay,map,123);expect(absent.input.binding.exactMapAndProfile).toBe(false);
  replay.data.lazerMods=[];const noMods=describeLibraryNumericalResources(replay,map,123);
  expect(noMods.input.binding.exactMapAndProfile).toBe(true);expect(noMods.target.inputKey).not.toBe(absent.target.inputKey);
  replay.data.lazerMods=[{acronym:"DT",settings:{speed_change:1.2}}];const slow=describeLibraryNumericalResources(replay,map,123);
  replay.data.lazerMods=[{acronym:"DT",settings:{speed_change:1.5}}];expect(describeLibraryNumericalResources(replay,map,123).target.inputKey).not.toBe(slow.target.inputKey);
});

it("qualifies native database fallback mods and rejects contradictory resources",()=>{
  const {replay,map}=fixture();replay.data.nativeSource={scoreId:"score",schemaFingerprint:"d".repeat(64),isLegacyScore:false,mods:[]};
  const native=describeLibraryNumericalResources(replay,map,123);expect(native.input.binding.exactMapAndProfile).toBe(true);
  replay.data.nativeSource.mods=null;expect(()=>describeLibraryNumericalResources(replay,map,123)).toThrow("native-mod-settings-unavailable");
  map.map.md5="f".repeat(32);expect(()=>describeLibraryNumericalResources(replay,map,123)).toThrow(/identity/);
  map.map.md5=replay.data.beatmapMD5;replay.receipt.sha256="f".repeat(64);expect(()=>describeLibraryNumericalResources(replay,map,123)).toThrow(/identity/);
});

it("normalizes irrelevant origin and native fallback hints when embedded mods win",()=>{
  const {replay,map}=fixture();replay.data.lazerMods=[];
  const first=describeLibraryNumericalResources(replay,map,123);
  replay.data.sourceClient="lazer";replay.data.sourceProvenance="user-confirmed";
  replay.data.nativeSource={scoreId:"score",isLegacyScore:false,schemaFingerprint:"d".repeat(64),mods:[{acronym:"DT",settings:{speed_change:1.2}}]};
  expect(describeLibraryNumericalResources(replay,map,123).target).toEqual(first.target);
  expect(first.recipe).toMatchObject({consumedModsSource:"embedded",embeddedModsHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
});

it("does not downgrade required native provenance when a selected record changes",()=>{
  const {replay,map}=fixture();replay.ticket={analysisRequiresNative:true} as PreparedLibraryReplay["ticket"];
  replay.data.nativeSource={scoreId:"score",schemaFingerprint:"d".repeat(64),isLegacyScore:true,mods:[]};
  expect(()=>describeLibraryNumericalResources(replay,map,123)).toThrow(/native.*profile/i);
  replay.data.nativeSource.isLegacyScore=false;
  expect(describeLibraryNumericalResources(replay,map,123).input.binding.exactMapAndProfile).toBe(true);
  replay.data.lazerMods=[];const embedded=describeLibraryNumericalResources(replay,map,123);
  replay.data.nativeSource.mods=[{acronym:"DT",settings:{speed_change:1.2}}];
  expect(describeLibraryNumericalResources(replay,map,123).target.inputKey).toBe(embedded.target.inputKey);
});
