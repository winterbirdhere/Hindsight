/** Bounded indexed-resource freshness evidence; never analysis admission. */
export const LIBRARY_RESOURCE_CHANGE_IDS = 256;
export type LibraryResourceChanges =
  | { from: string; to: string; scope: "replays"; replayIds: string[] }
  | { from: string; to: string; scope: "all" };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const libraryResourceReplayId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^a-zA-Z0-9_.:+-]/.test(value);
const parts = (value: unknown): string[] | undefined => typeof value === "string" && value.length <= 39 && !/[^0-9:]/.test(value) && /^(?:0|[1-9]\d{0,18})(?::(?:0|[1-9]\d{0,18}))?$/.test(value) ? value.split(":") : undefined;
const before = (a: string, b: string) => a.length < b.length || a.length === b.length && a <= b;

/** Copy only a complete valid envelope. An absent/invalid extension cannot certify freshness. */
export function readLibraryResourceChanges(value: unknown, to: string): LibraryResourceChanges | undefined {
  if (!record(value) || value.to !== to || typeof value.scope !== "string" || !["all", "replays"].includes(value.scope)) return;
  const fromParts = parts(value.from), toParts = parts(value.to);
  if (!fromParts || !toParts || fromParts.length !== toParts.length ||
    fromParts.length === 2 && fromParts[0] !== toParts[0] || !before(fromParts[fromParts.length - 1], toParts[toParts.length - 1])) return;
  if (value.scope === "all") {
    if (Object.keys(value).some(key => !["from", "to", "scope"].includes(key))) return;
    return { from: value.from as string, to, scope: "all" };
  }
  if (value.scope !== "replays" || Object.keys(value).some(key => !["from", "to", "scope", "replayIds"].includes(key)) ||
    !Array.isArray(value.replayIds) || value.replayIds.length > LIBRARY_RESOURCE_CHANGE_IDS ||
    value.from !== to && !value.replayIds.length || ![...value.replayIds].every(libraryResourceReplayId)) return;
  const replayIds = [...new Set(value.replayIds as string[])].sort();
  return { from: value.from as string, to, scope: "replays", replayIds };
}

/** Call only for a changed token. Missing evidence and non-contiguous intervals stay global. */
export function appendLibraryResourceChanges(previous: LibraryResourceChanges | undefined, from: string, to: string,
  incoming: unknown): LibraryResourceChanges {
  const next = readLibraryResourceChanges(incoming, to), start = previous?.from ?? from;
  if (!next || next.from !== from || previous && (previous.to !== from || previous.scope === "all") || next.scope === "all")
    return { from: start, to, scope: "all" };
  const replayIds = [...new Set([...(previous?.scope === "replays" ? previous.replayIds : []), ...next.replayIds])].sort();
  return replayIds.length > LIBRARY_RESOURCE_CHANGE_IDS ? { from: start, to, scope: "all" } : { from: start, to, scope: "replays", replayIds };
}
