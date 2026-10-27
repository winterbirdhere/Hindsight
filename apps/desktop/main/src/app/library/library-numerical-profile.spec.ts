import { numericalProfileKey, nativeModEvidence, numericalModsHash, LibraryNumericalInputRecipe } from "./library-numerical-profile";
const recipe:LibraryNumericalInputRecipe={version:1,replaySha256:"a".repeat(64),fixedKey:"b".repeat(64),intrinsicNative:false,
  embeddedModsHash:null,legacyModsHash:"c".repeat(64),modeQualified:true,consumedModsSource:"legacy-mask"};
const dt=(speed:number)=>[{acronym:"DT",settings:{speed_change:speed}}];
it("ignores duplicate fallback locations but keeps missing, NM and conflicting mods distinct",()=>{
  const first=nativeModEvidence([dt(1.2)]);expect(first.state).toBe("known");expect(nativeModEvidence([dt(1.2),dt(1.2)])).toEqual(first);
  expect(nativeModEvidence([])).toEqual({state:"absent"});expect(nativeModEvidence([[]]).state).toBe("known");
  expect(nativeModEvidence([null]).state).toBe("unavailable");expect(nativeModEvidence([dt(1.2),dt(1.5)]).state).toBe("conflicting");
});
it("keeps embedded NM usable across changes to irrelevant native hints and confirmed origin",()=>{
  const embedded={...recipe,intrinsicNative:true,embeddedModsHash:numericalModsHash([])!,consumedModsSource:"embedded" as const};
  const first=numericalProfileKey(embedded,{origin:null,native:nativeModEvidence([])});
  expect(numericalProfileKey(embedded,{origin:"lazer",native:nativeModEvidence([dt(1.2),dt(1.5)])})).toEqual(first);
  expect(numericalProfileKey(embedded,{origin:"unknown",native:nativeModEvidence([null])})).toEqual(first);
});
it("keys effective rules/mods, not the recording hint or mod-location representation",()=>{
  const native=nativeModEvidence([dt(1.2)]),fallback={...recipe,consumedModsSource:"native-database" as const};
  const first=numericalProfileKey(fallback,{origin:null,native});
  expect(numericalProfileKey(fallback,{origin:"stable",native})).toEqual(first);
  expect(numericalProfileKey({...fallback,consumedModsSource:"embedded",embeddedModsHash:numericalModsHash(dt(1.2))!},{origin:null,native:{state:"absent"}})).toEqual(first);
  expect(numericalProfileKey(fallback,{origin:null,native:nativeModEvidence([dt(1.5)])})).not.toEqual(first);
});
it("does not downgrade lost native provenance and excludes conflicting fallbacks",()=>{
  const fallback={...recipe,consumedModsSource:"native-database" as const};
  expect(numericalProfileKey(fallback,{origin:null,native:{state:"absent"}})).toMatchObject({state:"unavailable"});
  expect(numericalProfileKey(recipe,{origin:null,native:nativeModEvidence([dt(1.2),dt(1.5)])})).toMatchObject({state:"conflicting"});
  expect(numericalProfileKey(recipe,{origin:"unknown",native:{state:"absent"}})).toMatchObject({state:"unavailable"});
});
it("changes a legacy wrapper profile only for an effective lazer origin and rejects malformed recipes",()=>{
  const stable=numericalProfileKey(recipe,{origin:null,native:{state:"absent"}});
  expect(numericalProfileKey(recipe,{origin:"stable",native:{state:"absent"}})).toEqual(stable);
  const lazer=numericalProfileKey(recipe,{origin:"lazer",native:{state:"absent"}});expect(lazer).not.toEqual(stable);
  expect(lazer).toMatchObject({state:"known",qualified:false});
  expect(()=>numericalProfileKey({...recipe,embeddedModsHash:"bad"},{origin:null,native:{state:"absent"}})).toThrow(/recipe/i);
});
