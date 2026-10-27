import { metricInputKey } from "./library-source-metrics";
import type { LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";
export type { LibraryNumericalInputRecipe } from "../../../../shared/library-analysis";

/** Main-only recipe for invalidation, not a metric or raw replay payload. Immutable decoded
 * evidence is represented by hashes; only effective profile dependencies are reconciled later. */
export type LibraryNativeModEvidence={state:"known";hash:string}|{state:"absent"|"unavailable"|"conflicting"};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
export function numericalModsHash(value:unknown):string|undefined {
  if(!Array.isArray(value)||value.length>128||value.some(mod=>!object(mod)||typeof mod.acronym!=="string"||!mod.acronym.trim()||
    (mod.settings!==undefined&&!object(mod.settings))))return undefined;
  try{return metricInputKey(value);}catch{return undefined;}
}
/** Caller supplies only exact-SHA, nonlegacy native observations. Empty observations != NM. */
export function nativeModEvidence(values:readonly unknown[]):LibraryNativeModEvidence {
  if(!values.length)return{state:"absent"};
  const hashes=values.map(numericalModsHash);if(hashes.some(value=>value===undefined))return{state:"unavailable"};
  const unique=new Set(hashes);return unique.size===1?{state:"known",hash:hashes[0] as string}:{state:"conflicting"};
}
export function validateNumericalRecipe(value:unknown):asserts value is LibraryNumericalInputRecipe {
  const fields=["version","replaySha256","fixedKey","intrinsicNative","embeddedModsHash","legacyModsHash","modeQualified","consumedModsSource"];
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(key=>!fields.includes(key))||value.version!==1||
    !hash(value.replaySha256)||!hash(value.fixedKey)||!hash(value.legacyModsHash)||(value.embeddedModsHash!==null&&!hash(value.embeddedModsHash))||
    typeof value.intrinsicNative!=="boolean"||typeof value.modeQualified!=="boolean"||!["embedded","native-database","legacy-mask"].includes(String(value.consumedModsSource)))
    throw new Error("Invalid numerical input recipe");
}
export function numericalProfileKey(recipe:LibraryNumericalInputRecipe,evidence:{origin:"stable"|"lazer"|"unknown"|null;native:LibraryNativeModEvidence}):
  {state:"known";inputKey:string;qualified:boolean}|{state:"unavailable"|"conflicting";reason:string} {
  validateNumericalRecipe(recipe);
  let native=recipe.intrinsicNative,modsHash=recipe.legacyModsHash,representation="legacy-mask";
  if(recipe.embeddedModsHash!==null){native=true;modsHash=recipe.embeddedModsHash;representation="native-mods";}
  else if(evidence.native.state==="known"){
    if(!hash(evidence.native.hash))throw new Error("Invalid native mod digest");
    native=true;modsHash=evidence.native.hash;representation="native-mods";
  }else if(evidence.native.state==="conflicting")return{state:"conflicting",reason:"conflicting-native-mod-settings"};
  else if(evidence.native.state==="unavailable"||recipe.consumedModsSource==="native-database")return{state:"unavailable",reason:"native-mod-settings-unavailable"};
  else if(!native&&evidence.origin==="unknown")return{state:"unavailable",reason:"recording-origin-unavailable"};
  else native=native||evidence.origin==="lazer";
  const qualified=recipe.modeQualified&&(!native||representation==="native-mods");
  return{state:"known",qualified,inputKey:metricInputKey({fixedKey:recipe.fixedKey,profile:"effective-native-v2",native,modsHash,representation,qualified})};
}
