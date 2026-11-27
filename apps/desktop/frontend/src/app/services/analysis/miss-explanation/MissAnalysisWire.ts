import { hydratePreparedBeatmap } from "../../common/game/PreparedBeatmapWire";
import type { MissExplanation } from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleMissExplanation";
import type { MissAnalysisInput } from "./MissAnalysisRunner";
import { readonlyExplanationMap, type MissExplanationSessionState } from "./MissExplanationSession";
import { referenceComparisonCandidates } from "../../../../../../../../libs/osu/core/src/gameplay/error-analysis/PrimaryAttribution";

export type MissAnalysisWireInput = MissAnalysisInput & { hitObjectKinds: string[] };

/** postMessage clones the graph once, preserving cycles and aliases. Never rebuild prepared geometry. */
export function encodeMissAnalysisInput(input: MissAnalysisInput): MissAnalysisWireInput {
  return { ...input, hitObjectKinds: input.beatmap.hitObjects.map((object) => object.type) };
}

export function decodeMissAnalysisInput(input: MissAnalysisWireInput): MissAnalysisInput {
  hydratePreparedBeatmap(input.beatmap, input.hitObjectKinds);
  return input;
}

type JsonAliasKind = "omit" | "comparison-candidates";
type JsonAlias = { target: object; kind: JsonAliasKind };
type Entries = { explanationEntries: Array<[string, MissExplanation]>; jsonAliases?: JsonAlias[] };
export type MissAnalysisWireSession =
  | Exclude<MissExplanationSessionState, { status: "ready" | "partial" }>
  | (Omit<Extract<MissExplanationSessionState, { status: "ready" }>, "explanations"> & Entries)
  | (Omit<Extract<MissExplanationSessionState, { status: "partial" }>, "explanations"> & Entries);

export function encodeMissAnalysisSession(session: MissExplanationSessionState): MissAnalysisWireSession {
  if (session.status !== "ready" && session.status !== "partial") return session;
  const { explanations, ...data } = session;
  const wire = { ...data, explanationEntries: [...explanations] };
  const seen = new Set<object>(),
    pending: unknown[] = [wire],
    jsonAliases: JsonAlias[] = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const kind = diagnosticJsonKind(value);
    if (kind) jsonAliases.push({ target: value, kind });
    for (const child of Object.values(value)) pending.push(child);
  }
  return jsonAliases.length ? { ...wire, jsonAliases } : wire;
}

/** Only the two existing, key-independent diagnostic hooks cross this boundary.
 * References preserve exact ownership: spread copies deliberately have no hook. */
function diagnosticJsonKind(value: object): JsonAliasKind | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, "toJSON");
  if (!descriptor) return undefined;
  if (descriptor.enumerable || typeof descriptor.value !== "function")
    throw new Error("Unsupported miss-analysis diagnostic JSON hook");
  const result: unknown = descriptor.value.call(value);
  if (result === undefined) return "omit";
  const expected = { ...value, candidates: undefined, candidatePool: "ranking.candidates" };
  if (
    result &&
    typeof result === "object" &&
    "candidates" in value &&
    "ranking" in value &&
    Object.keys(result).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, child]) =>
        Object.prototype.hasOwnProperty.call(result, key) && (result as Record<string, unknown>)[key] === child,
    )
  )
    return "comparison-candidates";
  throw new Error("Unsupported miss-analysis diagnostic JSON hook");
}

/** Clone removes frozen state. Visit aliases once and yield while restoring it before publication. */
export async function decodeMissAnalysisSession(
  data: MissAnalysisWireSession,
  checkpoint: () => Promise<void>,
): Promise<MissExplanationSessionState> {
  const aliases = new Map<object, JsonAliasKind>();
  if (data.status === "ready" || data.status === "partial") {
    if (data.jsonAliases !== undefined && !Array.isArray(data.jsonAliases))
      throw new Error("Invalid miss-analysis diagnostic JSON aliases");
    for (const entry of data.jsonAliases ?? []) {
      if (
        !entry?.target ||
        typeof entry.target !== "object" ||
        aliases.has(entry.target) ||
        !["omit", "comparison-candidates"].includes(entry.kind)
      )
        throw new Error("Invalid miss-analysis diagnostic JSON alias");
      aliases.set(entry.target, entry.kind);
    }
  }
  const seen = new Set<object>(),
    pending: unknown[] = [data];
  let work = 0;
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const kind = aliases.get(value);
    if (kind) {
      const existing = diagnosticJsonKind(value);
      if (existing && existing !== kind) throw new Error("Conflicting miss-analysis diagnostic JSON alias");
      if (!existing) {
        if (kind === "omit") Object.defineProperty(value, "toJSON", { value: () => undefined });
        else {
          if (!("candidates" in value) || !("ranking" in value))
            throw new Error("Invalid miss-analysis comparison alias");
          referenceComparisonCandidates(value as Parameters<typeof referenceComparisonCandidates>[0]);
        }
      }
      aliases.delete(value);
    }
    Object.freeze(value);
    for (const [key, child] of Object.entries(value)) if (value !== data || key !== "jsonAliases") pending.push(child);
    if (++work % 256 === 0) await checkpoint();
  }
  if (aliases.size) throw new Error("Unreachable miss-analysis diagnostic JSON alias");
  await checkpoint();
  if (data.status !== "ready" && data.status !== "partial") return data;
  const { explanationEntries, jsonAliases: _jsonAliases, ...session } = data;
  return Object.freeze({ ...session, explanations: readonlyExplanationMap(new Map(explanationEntries)) });
}
