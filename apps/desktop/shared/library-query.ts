import type { LibraryMetricResult, LibraryMetricSlot, LibraryMetricStage } from "./replay-library-metrics";
/** v34 library controls. Parsing is explicit; ordinary search always remains literal. */
export const LIBRARY_SORTS = {
  pp: { label: "PP", direction: "desc" }, peak: { label: "Peak PP", direction: "desc" },
  fc: { label: "PP if FC", direction: "desc" }, acc: { label: "Accuracy", direction: "desc" },
  combo: { label: "Combo", direction: "desc" }, miss: { label: "Misses", direction: "asc" },
  ur: { label: "UR", direction: "asc" }, sr: { label: "Star rating", direction: "desc" },
  bpm: { label: "BPM", direction: "desc" }, len: { label: "Length", direction: "desc" },
  title: { label: "Title", direction: "asc" }, date: { label: "Date played", direction: "desc" },
} as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;
export const LIBRARY_FILTER_FIELDS = ["stars", "mods", "acc", "miss", "pp", "played", "bpm", "len", "status", "mapper", "grade", "result", "player", "playedon", "ur", "bias", "source", "collection", "review", "astate"] as const;
export type LibraryFilterField = typeof LIBRARY_FILTER_FIELDS[number];
export type LibraryFacetField = "status" | "mapper" | "grade" | "result" | "player" | "playedon" | "source" | "collection" | "review" | "astate";
export type LibraryRecordingClient = "stable" | "lazer" | "unknown";
export type LibraryFilter =
  | { field: "stars"; basis: "map" | "replay"; min: number | null; max: number | null }
  | { field: "bpm" | "len" | "pp" | "bias"; min: number | null; max: number | null }
  | { field: "acc" | "miss" | "ur"; op: "atLeast" | "atMost" | "between"; a: number; b: number | null }
  | { field: "mods"; mode: "includes" | "exactly" | "excludes"; match: "all" | "any" | null; mods: string[] }
  | { field: "played"; preset: "today" | "7d" | "30d" }
  | { field: "played"; preset: "custom"; from: string; to: string }
  | { field: "player"; values: string[]; me?: boolean }
  | { field: Exclude<LibraryFacetField, "player">; values: string[] };
export type LibraryScope = { kind: "all" | "recent" | "favourites" } | { kind: "collection"; id: string };
export interface LibraryQuery {
  search?: string; filters?: LibraryFilter[]; scope?: LibraryScope; sort?: LibrarySort;
  direction?: "asc" | "desc"; limit?: number; cursor?: string;
}
export type LibraryAnalysisState = "none" | "queued" | "analysing" | "paused" | "analysed" | "failed";
export interface LibraryQueryItem {
  id: string; title: string | null; artist: string | null; difficulty: string | null;
  mapper: string | null; player: string | null; mods: string[] | null; grade: string | null;
  status: string | null; completion: string | null; recordingClient: LibraryRecordingClient; fullCombo: boolean | null; perfectCombo: boolean | null;
  favourite: boolean; review: string; isNew: boolean; sourceKinds: string[]; collectionIds: string[]; collectionCount: number;
  analysis: LibraryAnalysisState; analysisError: string | null; available: boolean;
  values: Record<Exclude<LibrarySort, "title"> | "mapStars" | "bias" | "incidents" | "sliderBreaks", number | null>;
  band: { key: string; label: string };
}
export interface LibraryResultExcluded { unknownOutcome: number; missingBreakEvidence: number }
export interface LibraryQueryPage { items: LibraryQueryItem[]; total: number; analysisExcluded: number; resultExcluded?: LibraryResultExcluded; revision?: string; next?: string }
export interface LibraryQueryPreview { count: number; analysisExcluded: number; resultExcluded?: LibraryResultExcluded }
export interface LibraryFacetPage { items: { value: string; count: number; label?: string; parentId?: string | null; parentLabel?: string | null }[]; revision?: string; next?: string }
export interface LibraryCollectionCount { id: string; name: string; parentId: string | null; paletteIndex: number; sequence: number; count: number; childCount?:number }
export interface LibraryQueryBandPage { items: { key: string; label: string; count: number; anchorId: string }[]; revision?: string; next?: string }
export type LibraryQueryReveal = { state: "found"; position: number; page: LibraryQueryPage } | { state: "not-found" };
export interface LibraryQueryDetail {
  item: LibraryQueryItem; mapIdentity: string | null;
  metrics: { slot: LibraryMetricSlot; stage: LibraryMetricStage; fields: LibraryMetricResult["fields"]; provenance: LibraryMetricResult["provenance"] }[];
  /** Indexed saved statistics; absent/conflicting native members remain null individually. */
  savedJudgements?:{great:number|null;ok:number|null;meh:number|null;miss:number|null;origin:"stable-header"|"native-score"|null};
  /** Current exact calculated map capacity, never the replay's achieved combo. */
  exactMapMaxCombo?:number|null;
}
export interface LibraryCollectionPage { items: LibraryCollectionCount[]; total: number; revision?: string; next?: string }
export interface LibraryMembershipPage { items: { id: string; name: string; parentId: string | null; parentName: string | null }[]; total: number; revision?: string; next?: string }
export interface LibrarySnapshotReference { snapshotId: string; total: number; position: number; scopeLabel: string; sortLabel: string }
export interface LibrarySnapshotNeighbors extends LibrarySnapshotReference { items: { id: string; position: number }[] }
export const LIBRARY_QUERY_MAX_RESPONSE_BYTES = 1024 * 1024;

const multi = new Set<string>(["status", "mapper", "grade", "result", "player", "playedon", "source", "collection", "review", "astate"]);
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
function fail(): never { throw new Error("Invalid library filter"); }
/** Boundary validation is shared by main and renderer; it never modifies a query or admits work. */
export function validateLibraryFilter(input: unknown): asserts input is LibraryFilter {
  if (!plain(input) || !LIBRARY_FILTER_FIELDS.includes(input.field as LibraryFilterField)) fail();
  const field = String(input.field);
  if (multi.has(field)) {
    if (!Array.isArray(input.values) || (!input.values.length && field !== "grade" && !(field === "player" && input.me === true)) || input.values.length > 100 || input.values.some(v => typeof v !== "string" || !v.length || v.length > 65536) || new Set(input.values).size !== input.values.length) fail();
    if (field === "player" && input.me !== undefined && typeof input.me !== "boolean" || field === "result" && input.values.length !== 1) fail();
    const enums: Record<string, string[]> = { result: ["passed", "fc", "failed", "unknown"], playedon: ["stable", "lazer", "unknown"], source: ["stable", "replays", "lazer", "imported"], review: ["not-reviewed", "reviewed", "needs-another-look"], astate: ["analysed", "none", "active", "failed"], grade: ["SS", "SSH", "S", "SH", "A", "B", "C", "D", "F"], status: ["ranked", "loved", "qualified", "graveyard", "approved", "pending", "wip"] };
    if (enums[field] && input.values.some(v => !enums[field].includes(v as string))) fail();
  } else if (field === "mods") {
    if (typeof input.mode !== "string" || !["includes", "exactly", "excludes"].includes(input.mode) || !Array.isArray(input.mods) || input.mods.length > 32 || input.mods.some(v => typeof v !== "string" || !/^[A-Z0-9]{1,8}$/.test(v)) || new Set(input.mods).size !== input.mods.length) fail();
    if (input.mode === "includes" ? !input.mods.length || !["all", "any"].includes(String(input.match)) : input.match !== null || input.mode === "excludes" && !input.mods.length) fail();
  } else if (field === "played") {
    if (input.preset === "custom") { if (!date(input.from) || !date(input.to) || input.from > input.to) fail(); }
    else if (!["today", "7d", "30d"].includes(String(input.preset))) fail();
  } else if ("op" in input) {
    if (!["acc", "miss", "ur"].includes(field) || !["atLeast", "atMost", "between"].includes(String(input.op)) || !finite(input.a) || input.a < 0 || (field === "acc" && input.a > 100)) fail();
    if (input.op === "between" ? !finite(input.b) || input.b < input.a || (field === "acc" && input.b > 100) : input.b !== null) fail();
    if (field === "miss" && (!Number.isSafeInteger(input.a) || input.b !== null && !Number.isSafeInteger(input.b))) fail();
  } else {
    if (!["stars", "bpm", "len", "pp", "bias"].includes(field) || (input.min === null && input.max === null) || (input.min !== null && !finite(input.min)) || (input.max !== null && !finite(input.max))) fail();
    if (field === "stars" && !["map", "replay"].includes(String(input.basis))) fail();
    if (input.min !== null && input.max !== null && Number(input.min) > Number(input.max)) fail();
    if (field !== "bias" && (Number(input.min) < 0 || Number(input.max) < 0)) fail();
  }
}
export function validateLibraryQuery(input: unknown): asserts input is LibraryQuery {
  if (!plain(input)) throw new Error("Invalid library query");
  if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 4096)) throw new Error("Invalid library search");
  if (input.sort !== undefined && !Object.prototype.hasOwnProperty.call(LIBRARY_SORTS, String(input.sort))) throw new Error("Invalid library sort");
  if (input.direction !== undefined && !["asc", "desc"].includes(String(input.direction))) throw new Error("Invalid library direction");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 128)) throw new Error("Invalid library limit");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 131072)) throw new Error("Invalid library cursor");
  if (input.scope !== undefined && (!plain(input.scope) || !["all", "recent", "favourites", "collection"].includes(String(input.scope.kind)) || input.scope.kind === "collection" && (typeof input.scope.id !== "string" || !input.scope.id.length || input.scope.id.length > 512))) throw new Error("Invalid library scope");
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters) || input.filters.length > 20) fail();
    const seen = new Set<string>();
    for (const filter of input.filters) { validateLibraryFilter(filter); if (seen.has(filter.field)) fail(); seen.add(filter.field); }
  }
}
const quote = (value: string) => /^[\w.-]+$/.test(value) ? value : JSON.stringify(value);
const range = (min: number | null, max: number | null) => min === null ? `<=${max}` : max === null ? `>=${min}` : `:${min}..${max}`;
export function formatLibraryQueryText(query: Pick<LibraryQuery, "search" | "filters">): string {
  validateLibraryQuery(query);
  const tokens = (query.filters ?? []).map(filter => {
    if ("values" in filter) return `${filter.field}:${[...(filter.field === "player" && filter.me ? ["me"] : []), ...filter.values.map(value => filter.field === "player" && value === "me" ? JSON.stringify(value) : quote(value))].join(",")}`;
    if (filter.field === "mods") return `mods:${filter.mode === "includes" ? `includes-${filter.match}` : filter.mode}(${filter.mods.join(",") || "none"})`;
    if (filter.field === "played") return `played:${filter.preset === "custom" ? `${filter.from}..${filter.to}` : filter.preset}`;
    if ("op" in filter) return `${filter.field}${filter.op === "between" ? range(filter.a, filter.b) : filter.op === "atMost" ? range(null, filter.a) : range(filter.a, null)}`;
    return `${filter.field === "stars" ? `${filter.basis}stars` : filter.field}${range(filter.min, filter.max)}`;
  });
  // A quoted free-text clause cannot accidentally become a recognized filter on reparse.
  return [...(query.search ? [JSON.stringify(query.search)] : []), ...tokens].join(" ");
}
function splitOutsideQuotes(text: string, separator: RegExp): string[] {
  const parts: string[] = []; let start = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; if (escaped) { escaped = false; continue; } if (c === "\\" && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    else if (!quoted && separator.test(c)) { if (i > start) parts.push(text.slice(start, i)); start = i + 1; }
  }
  if (quoted) throw new Error("Unterminated quoted query value");
  if (start < text.length) parts.push(text.slice(start)); return parts;
}
/** Called only by the explicit “Use query” action. Unrecognized text remains literal search. */
export function parseLibraryQueryText(text: string): Pick<LibraryQuery, "search" | "filters"> {
  if (typeof text !== "string" || text.length > 16384) throw new Error("Invalid library query text");
  const filters: LibraryFilter[] = [], search: string[] = [];
  for (const token of splitOutsideQuotes(text, /\s/)) {
    const match = /^([a-z]+)(:|>=|<=)(.*)$/.exec(token); let filter: LibraryFilter | undefined;
    if (match) {
      const [, key, operator, value] = match;
      if (multi.has(key) && operator === ":") {
        const parts = splitOutsideQuotes(value, /,/), me = key === "player" && parts.includes("me");
        filter = { field: key as LibraryFacetField, values: parts.filter(v => !(me && v === "me")).map(v => v.startsWith('"') ? JSON.parse(v) as string : v), ...(me ? { me: true } : {}) };
      }
      else if (key === "played" && operator === ":") { const dates = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value); filter = dates ? { field: "played", preset: "custom", from: dates[1], to: dates[2] } : { field: "played", preset: value as "today" }; }
      else if (key === "mods" && operator === ":") { const mods = /^(includes(?:-all|-any)?|exactly|excludes)\(([^)]*)\)$/.exec(value); if (mods) filter = { field: "mods", mode: mods[1] === "exactly" ? "exactly" : mods[1] === "excludes" ? "excludes" : "includes", match: ["exactly", "excludes"].includes(mods[1]) ? null : mods[1] === "includes-any" ? "any" : "all", mods: mods[2] === "none" ? [] : mods[2].split(",") }; }
      else if (["mapstars", "replaystars", "bpm", "len", "pp", "bias", "acc", "miss", "ur"].includes(key)) {
        const pair = value.split(".."), min = operator === "<=" ? null : Number(pair[0]), max = operator === ">=" ? null : Number(pair[pair.length - 1]);
        if (value && pair.length <= 2 && (operator !== ":" || pair.length === 2)) {
          if (["acc", "miss", "ur"].includes(key)) filter = { field: key as "acc", op: operator === ":" ? "between" : operator === ">=" ? "atLeast" : "atMost", a: operator === "<=" ? max as number : min as number, b: operator === ":" ? max : null };
          else if (key.endsWith("stars")) filter = { field: "stars", basis: key === "mapstars" ? "map" : "replay", min, max };
          else filter = { field: key as "bpm", min, max };
        }
      }
    }
    if (filter) { validateLibraryFilter(filter); const old = filters.findIndex(f => f.field === filter?.field); if (old >= 0) filters.splice(old, 1); filters.push(filter); }
    else search.push(token.startsWith('"') ? JSON.parse(token) as string : token);
  }
  const result = { search: search.join(" "), filters }; validateLibraryQuery(result); return result;
}
