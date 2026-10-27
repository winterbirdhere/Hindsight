import { DEFAULT_OSU_SKIN_ID, DEFAULT_REWIND_SKIN_ID, SkinId } from "../../model/SkinId";

export interface SkinOption {
  id: SkinId;
  label: string;
  note?: "built in";
  usedInOsu?: true;
}

const BUILT_INS: readonly SkinOption[] = [
  { id: DEFAULT_REWIND_SKIN_ID, label: "Hindsight", note: "built in" },
  { id: DEFAULT_OSU_SKIN_ID, label: "osu! default", note: "built in" },
];

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/**
 * The skins the list offers: the one osu! currently uses (when it is a folder skin), the two built-ins, then the other
 * folder skins A–Z with numbers in order. A skin is listed once.
 */
export function buildSkinOptions(folderSkins: readonly string[], skinInUse: string | undefined): SkinOption[] {
  const unique = Array.from(new Set(folderSkins));
  const wanted = skinInUse?.toLowerCase();
  const inUse = wanted === undefined ? undefined : unique.find((name) => name.toLowerCase() === wanted);
  const rest = unique.filter((name) => name !== inUse).sort(byName);
  const options: SkinOption[] = [];
  if (inUse !== undefined) options.push({ id: { source: "osu", name: inUse }, label: inUse, usedInOsu: true });
  options.push(...BUILT_INS.map((option) => ({ ...option })));
  options.push(...rest.map((name): SkinOption => ({ id: { source: "osu", name }, label: name })));
  return options;
}

/** The options whose label contains the trimmed query, without regard to case; an empty query keeps them all. */
export function filterSkinOptions(options: readonly SkinOption[], query: string): SkinOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}
