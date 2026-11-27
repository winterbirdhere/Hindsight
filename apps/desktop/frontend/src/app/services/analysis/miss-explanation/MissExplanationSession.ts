import { Beatmap } from "../../../../../../../../libs/osu/core/src/beatmap/Beatmap";
import {
  ErrorAnalysis,
  assembleErrorAnalysis,
} from "../../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import { SavedScoreTimeline } from "../../../../../../../../libs/osu/core/src/replays/SavedScoreTimeline";
import { countErrorAtoms } from "../../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import { deriveCircleEvidence } from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleEvidence";
import {
  explainCircleMiss,
  MissDescriptorCode,
  MissExplanation,
} from "../../../../../../../../libs/osu/core/src/gameplay/miss-explanation/CircleMissExplanation";
import {
  ReplayTrace,
  ReplayTraceRecord,
  TraceRunIdentity,
} from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTrace";
import {
  prepareReplayTrace,
  serializeReplayTrace,
  traceUtf8Bytes,
} from "../../../../../../../../libs/osu/core/src/gameplay/trace/ReplayTraceCollector";

type CapturedSession = {
  readonly identity: TraceRunIdentity;
  readonly trace: ReplayTrace;
  readonly explanations: ReadonlyMap<string, MissExplanation>;
  readonly analysis?: ErrorAnalysis;
};
export type MissExplanationSessionState =
  | { readonly status: "empty" }
  | { readonly status: "not-captured"; readonly reasons: readonly string[] }
  | { readonly status: "building" }
  | (CapturedSession & { readonly status: "ready" })
  | (CapturedSession & { readonly status: "partial"; readonly reasons: readonly string[] })
  | { readonly status: "unsupported"; readonly reasons: readonly string[] }
  | { readonly status: "error"; readonly reasons: readonly string[] };

/** Storage bounds, not a claim about retained JavaScript heap or original-client coverage. */
export const MISS_EXPLANATION_LIMITS = Object.freeze({
  maxExplanationCount: 10000,
  maxFindingCount: 100000,
  maxFindingsPerExplanation: 10000,
  maxExportBytes: 64 * 1024 * 1024,
});

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Do not expose the backing Map through either methods or forEach's third argument. */
export function readonlyExplanationMap(values: Map<string, MissExplanation>): ReadonlyMap<string, MissExplanation> {
  const facade: ReadonlyMap<string, MissExplanation> = {
    get size() {
      return values.size;
    },
    get: (key) => values.get(key),
    has: (key) => values.has(key),
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    [Symbol.iterator]: () => values[Symbol.iterator](),
    forEach: (callback, thisArg) => values.forEach((value, key) => callback.call(thisArg, value, key, facade)),
  };
  return Object.freeze(facade);
}
const unique = (values: readonly string[]) => Array.from(new Set(values));
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function strings(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) if (!nonempty(value[index])) return false;
  return true;
}
function invalid(message: string): never {
  throw new Error(`Invalid miss explanation export: ${message}`);
}

/** Reject non-JSON/nonfinite values before JSON.stringify can omit or coerce them. */
function validateJson(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 32) invalid("structure limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("nonfinite number");
    return;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) invalid("non-JSON value");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    invalid("non-JSON object");
  ancestors.add(value);
  Object.values(value).forEach((entry) => {
    if (entry !== undefined) validateJson(entry, depth + 1, ancestors);
  });
  ancestors.delete(value);
}
function sameIdentity(a: TraceRunIdentity, b: TraceRunIdentity): boolean {
  return (
    !!a &&
    Object.keys(b).every((key) => a[key as keyof TraceRunIdentity] === b[key as keyof TraceRunIdentity]) &&
    Object.keys(a).length === Object.keys(b).length
  );
}
const terminalCodes = ["input-miss", "automatic-expiry", "ordered-force-miss"];
const descriptorCodes: Record<MissDescriptorCode, true> = {
  "press-outside": true,
  "entry-after-press": true,
  "exit-before-press": true,
  "overlap-without-fresh-action": true,
  "all-fresh-actions-outside": true,
  "no-fresh-action": true,
  "input-miss": true,
  "automatic-expiry": true,
  "ordered-force-miss": true,
  "dispatch-stopped": true,
  "order-blocked": true,
};
const bases = ["recorded", "reconstructed-path", "model-trace", "independent-client-observation"];
function missedCircleIds(trace: ReplayTrace): string[] {
  return unique(
    trace.records
      .filter((record) => record.kind === "resolution" && record.component === "circle" && record.result === "MISS")
      .map((record) => (record as Extract<ReplayTraceRecord, { kind: "resolution" }>).componentId),
  );
}
function validateExplanation(
  explanation: MissExplanation,
  key: string,
  trace: ReplayTrace,
  byId: ReadonlyMap<string, ReplayTraceRecord>,
  missedTargets: ReadonlySet<string>,
): void {
  validateJson(explanation);
  if (
    !explanation ||
    explanation.schemaVersion !== 1 ||
    explanation.targetId !== key ||
    !nonempty(key) ||
    !missedTargets.has(key) ||
    !sameIdentity(explanation.identity, trace.identity) ||
    !["supported", "unsupported", "not-missed", "unjudged"].includes(explanation.status) ||
    !Array.isArray(explanation.findings) ||
    !strings(explanation.limitations)
  )
    invalid("explanation schema or identity");
  if (explanation.findings.length > MISS_EXPLANATION_LIMITS.maxFindingsPerExplanation) invalid("finding limit");
  const findingIds = new Set<string>();
  for (const finding of explanation.findings) {
    if (
      !finding ||
      !nonempty(finding.id) ||
      findingIds.has(finding.id) ||
      !Object.prototype.hasOwnProperty.call(descriptorCodes, finding.code) ||
      typeof finding.applicable !== "boolean" ||
      !["supported", "not-supported", "indeterminate"].includes(finding.state) ||
      (!finding.applicable && finding.state !== "indeterminate") ||
      !strings(finding.bases) ||
      finding.bases.some((basis) => !bases.includes(basis)) ||
      !strings(finding.eventIds) ||
      finding.eventIds.some((id) => !byId.has(id)) ||
      !strings(finding.dependencies) ||
      finding.dependencies.some((channel) => !["input", "geometry", "routing", "lifecycle"].includes(channel)) ||
      !strings(finding.reasons) ||
      !finding.parameters ||
      typeof finding.parameters !== "object" ||
      Array.isArray(finding.parameters) ||
      Object.entries(finding.parameters).some(
        ([key, value]) => !nonempty(key) || typeof value !== "number" || !Number.isFinite(value),
      )
    )
      invalid("finding schema or event reference");
    findingIds.add(finding.id);
    if (terminalCodes.includes(finding.code)) {
      const terminal = byId.get(finding.eventIds[0]);
      if (
        !terminal ||
        terminal.kind !== "resolution" ||
        terminal.component !== "circle" ||
        terminal.componentId !== key ||
        terminal.result !== "MISS" ||
        terminal.mechanism !== finding.code
      )
        invalid("terminal reference");
      const expected = [terminal.id, terminal.triggerAttemptId, terminal.triggerResolutionId].filter(
        (id): id is string => !!id,
      );
      if (expected.some((id) => !finding.eventIds.includes(id))) invalid("terminal trigger reference");
    }
  }
  if (
    explanation.mainFindingId !== undefined &&
    (!findingIds.has(explanation.mainFindingId) ||
      explanation.findings.find((finding) => finding.id === explanation.mainFindingId)?.state !== "supported")
  )
    invalid("main finding reference");
}
function envelope(
  identity: TraceRunIdentity,
  trace: ReplayTrace | null,
  explanations: readonly MissExplanation[],
  limitations: readonly string[],
) {
  return { schemaVersion: 1, identity, trace, explanations, limitations };
}

type BuiltMissExplanationSession = Extract<
  MissExplanationSessionState,
  { status: "ready" | "partial" | "unsupported" | "error" }
>;

/** Shared assembly keeps synchronous and cooperative validation, bounds and coverage identical. */
function* assembleMissExplanationSession(
  trace: ReplayTrace,
  beatmap: Beatmap,
  additionalLimitations: string[],
  saved?: SavedScoreTimeline,
): Generator<void, BuiltMissExplanationSession, void> {
  try {
    const { trace: ownedTrace, byteLength } = yield* prepareReplayTrace(trace);
    if (!strings(additionalLimitations)) throw new Error("Invalid additional limitations");
    if (ownedTrace.identity.schemaVersion === 2) {
      const analysis = yield* assembleErrorAnalysis(
        ownedTrace,
        beatmap,
        saved,
        Math.min(ownedTrace.limits.maxExportBytes, MISS_EXPLANATION_LIMITS.maxExportBytes) - byteLength,
      );
      const explanations = new Map<string, MissExplanation>();
      const reasons = new Set([
        ...analysis.limitations,
        ...additionalLimitations,
        ...ownedTrace.failures,
        ...ownedTrace.domain.sourceCoverageLimits,
      ]);
      // Selected-only geometry is resolved per component by prepared geometry;
      // source, routing and lifecycle gaps remain session-level limitations.
      for (const channel of ["input", "routing", "lifecycle"] as const)
        if (ownedTrace.coverage[channel] !== "complete")
          reasons.add(`${channel}-coverage-${ownedTrace.coverage[channel]}`);
      const targets = missedCircleIds(ownedTrace),
        missedTargets = new Set(targets);
      if (targets.length > MISS_EXPLANATION_LIMITS.maxExplanationCount) reasons.add("explanation-count-limit");
      const byId = new Map<string, ReplayTraceRecord>();
      for (let index = 0; index < ownedTrace.records.length; index++) {
        const record = ownedTrace.records[index];
        byId.set(record.id, record);
        if ((index + 1) % 256 === 0) yield;
      }
      const byteLimit = Math.min(ownedTrace.limits.maxExportBytes, MISS_EXPLANATION_LIMITS.maxExportBytes);
      // Account for the actual v2 export envelope, including repeated identity,
      // property names, comma separators and diagnostic limitations.
      const fixedBytes =
        byteLength -
        4 +
        traceUtf8Bytes(
          JSON.stringify({
            ...envelope(ownedTrace.identity, null, [], []),
            schemaVersion: 2,
            analysis,
          }),
        );
      let findingCount = 0,
        explanationBytes = 0;
      const retainedSizes: Array<{ id: string; bytes: number }> = [];
      const totalBytes = (extraBytes = 0, count = explanations.size) =>
        fixedBytes +
        explanationBytes +
        extraBytes +
        Math.max(0, count - 1) +
        traceUtf8Bytes(JSON.stringify(Array.from(reasons).sort())) -
        2;
      if (totalBytes() > byteLimit) return freeze({ status: "error", reasons: ["analysis-export-byte-limit"] });
      yield;
      // Retain the existing circle evidence as developer diagnostics, not player copy.
      for (const id of targets.slice(0, MISS_EXPLANATION_LIMITS.maxExplanationCount)) {
        const result = explainCircleMiss(deriveCircleEvidence(ownedTrace, beatmap, id));
        if (
          result.findings.length > MISS_EXPLANATION_LIMITS.maxFindingsPerExplanation ||
          findingCount + result.findings.length > MISS_EXPLANATION_LIMITS.maxFindingCount
        ) {
          reasons.add("explanation-finding-limit");
          break;
        }
        validateExplanation(result, id, ownedTrace, byId, missedTargets);
        result.limitations.forEach((reason) => reasons.add(reason));
        const size = traceUtf8Bytes(JSON.stringify(result));
        if (totalBytes(size, explanations.size + 1) > byteLimit) {
          reasons.add("explanation-export-byte-limit");
          break;
        }
        explanations.set(id, freeze(result));
        retainedSizes.push({ id, bytes: size });
        findingCount += result.findings.length;
        explanationBytes += size;
        yield;
      }
      // The reason explaining truncation itself consumes bytes. Remove retained
      // diagnostics if necessary; never publish an oversized captured session.
      while (totalBytes() > byteLimit && retainedSizes.length) {
        const removed = retainedSizes.pop()!;
        explanations.delete(removed.id);
        explanationBytes -= removed.bytes;
        reasons.add("explanation-export-byte-limit");
        yield;
      }
      if (totalBytes() > byteLimit) return freeze({ status: "error", reasons: ["analysis-export-byte-limit"] });
      const captured = {
        identity: ownedTrace.identity,
        trace: ownedTrace,
        analysis: freeze(analysis),
        explanations: readonlyExplanationMap(explanations),
      };
      return reasons.size
        ? Object.freeze({ status: "partial", ...captured, reasons: Object.freeze(Array.from(reasons)) })
        : Object.freeze({ status: "ready", ...captured });
    }
    if (
      !["stable", "lazer"].includes(ownedTrace.identity.analysisProfileId) ||
      beatmap.appliedMods.length ||
      beatmap.lazerMods.length ||
      beatmap.gameClockRate !== 1
    )
      return freeze({ status: "unsupported", reasons: ["unsupported-analysis-profile"] });
    const missedTargets = new Set<string>();
    const byId = new Map<string, ReplayTraceRecord>();
    for (let index = 0; index < ownedTrace.records.length; index++) {
      const record = ownedTrace.records[index];
      byId.set(record.id, record);
      if (record.kind === "resolution" && record.component === "circle" && record.result === "MISS")
        missedTargets.add(record.componentId);
      if ((index + 1) % 256 === 0) yield;
    }
    const targets = Array.from(missedTargets);
    const reasons = new Set([
      ...ownedTrace.failures,
      ...ownedTrace.domain.sourceCoverageLimits,
      ...additionalLimitations,
    ]);
    if (targets.length > MISS_EXPLANATION_LIMITS.maxExplanationCount) reasons.add("explanation-count-limit");
    const explanations = new Map<string, MissExplanation>();
    const byteLimit = Math.min(ownedTrace.limits.maxExportBytes, MISS_EXPLANATION_LIMITS.maxExportBytes);
    let findingCount = 0,
      explanationBytes = 0,
      supported = 0;
    // Replace JSON's four-byte null token with the already validated trace size.
    const baseBytes = traceUtf8Bytes(JSON.stringify(envelope(ownedTrace.identity, null, [], []))) - 4 + byteLength;
    yield;
    for (const targetId of targets.slice(0, MISS_EXPLANATION_LIMITS.maxExplanationCount)) {
      const evidence = deriveCircleEvidence(ownedTrace, beatmap, targetId);
      const result = explainCircleMiss(evidence);
      for (const [dependency, coverage] of Object.entries(evidence.dependencies)) {
        if (coverage.status !== "complete") reasons.add(`${dependency}-coverage-${coverage.status}`);
      }
      result.limitations.forEach((reason) => reasons.add(reason));
      if (result.status === "supported") supported++;
      else reasons.add(`explanation-${result.status}`);
      if (
        result.findings.length > MISS_EXPLANATION_LIMITS.maxFindingsPerExplanation ||
        findingCount + result.findings.length > MISS_EXPLANATION_LIMITS.maxFindingCount
      ) {
        reasons.add("explanation-finding-limit");
        break;
      }
      const explanation = freeze({ ...result, limitations: unique([...result.limitations, ...additionalLimitations]) });
      validateExplanation(explanation, targetId, ownedTrace, byId, missedTargets);
      const size = traceUtf8Bytes(JSON.stringify(explanation));
      if (
        baseBytes +
          explanationBytes +
          size +
          explanations.size +
          traceUtf8Bytes(JSON.stringify(Array.from(reasons))) -
          2 >
        byteLimit
      ) {
        reasons.add("explanation-export-byte-limit");
        break;
      }
      explanations.set(targetId, explanation);
      findingCount += explanation.findings.length;
      explanationBytes += size;
      yield;
    }
    if (!targets.length) {
      for (const channel of ["input", "routing", "lifecycle"] as const)
        if (ownedTrace.coverage[channel] !== "complete")
          reasons.add(`${channel}-coverage-${ownedTrace.coverage[channel]}`);
    }
    if (
      baseBytes +
        explanationBytes +
        Math.max(0, explanations.size - 1) +
        traceUtf8Bytes(JSON.stringify(Array.from(reasons))) -
        2 >
      byteLimit
    )
      reasons.add("explanation-export-byte-limit");
    if (targets.length && !supported && !Array.from(reasons).some((reason) => reason.endsWith("limit")))
      return freeze({ status: "unsupported", reasons: Array.from(reasons) });
    const captured = {
      identity: ownedTrace.identity,
      trace: ownedTrace,
      explanations: readonlyExplanationMap(explanations),
    };
    // Preparation owns a deeply frozen trace; each explanation and the map facade
    // were frozen above. Only this new envelope and its reasons still need freezing.
    return reasons.size
      ? Object.freeze({ status: "partial", ...captured, reasons: Object.freeze(Array.from(reasons)) })
      : Object.freeze({ status: "ready", ...captured });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (["Trace export byte limit exceeded", "analysis-byte-limit"].includes(message))
      return freeze({ status: "error", reasons: ["analysis-resource-limit", ...trace.failures, message] });
    return freeze({ status: "error", reasons: ["explanation-generation-failed"] });
  }
}

/** Pure sidecar assembly: no playback, seeking, capture, filesystem or UI work. */
export function buildMissExplanationSession(
  trace: ReplayTrace,
  beatmap: Beatmap,
  additionalLimitations: string[] = [],
  saved?: SavedScoreTimeline,
): BuiltMissExplanationSession {
  const assembly = assembleMissExplanationSession(trace, beatmap, additionalLimitations, saved);
  let next = assembly.next();
  while (!next.done) next = assembly.next();
  return next.value;
}

/** The caller schedules yields and rejects checkpoints to cancel; cancellation stays outside assembly's catch. */
export async function buildMissExplanationSessionAsync(
  trace: ReplayTrace,
  beatmap: Beatmap,
  additionalLimitations: string[],
  checkpoint: () => Promise<void>,
  saved?: SavedScoreTimeline,
): Promise<BuiltMissExplanationSession> {
  await checkpoint();
  const assembly = assembleMissExplanationSession(trace, beatmap, additionalLimitations, saved);
  try {
    let next = assembly.next();
    while (!next.done) {
      await checkpoint();
      next = assembly.next();
    }
    await checkpoint();
    return next.value;
  } finally {
    assembly.return(undefined as never);
  }
}

/** Explicit headless export; validates the whole envelope, not merely its trace. */
export function serializeMissExplanationSession(state: MissExplanationSessionState): string {
  if (state.status !== "ready" && state.status !== "partial") invalid("session is not captured");
  serializeReplayTrace(state.trace);
  if (!sameIdentity(state.identity, state.trace.identity)) invalid("session identity");
  if (state.status === "partial" && (!strings(state.reasons) || !state.reasons.length)) invalid("partial reasons");
  if (!state.explanations || state.explanations.size > MISS_EXPLANATION_LIMITS.maxExplanationCount)
    invalid("explanation count limit");
  const byId = new Map(state.trace.records.map((record) => [record.id, record]));
  const missedTargets = new Set(missedCircleIds(state.trace));
  const entries = Array.from(state.explanations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length !== state.explanations.size) invalid("explanation map");
  let findingCount = 0;
  for (const [key, explanation] of entries) {
    validateExplanation(explanation, key, state.trace, byId, missedTargets);
    findingCount += explanation.findings.length;
    if (findingCount > MISS_EXPLANATION_LIMITS.maxFindingCount) invalid("finding limit");
  }
  const limitations = unique([
    ...(state.status === "partial" ? state.reasons : []),
    ...state.trace.failures,
    ...state.trace.domain.sourceCoverageLimits,
    ...entries.flatMap(([, explanation]) => explanation.limitations),
  ]).sort();
  const result = envelope(
    state.identity,
    state.trace,
    entries.map(([, explanation]) => explanation),
    limitations,
  );
  if (state.identity.schemaVersion === 2) {
    if (!state.analysis || state.analysis.schemaVersion !== 2) invalid("missing all-error analysis");
    validateJson(state.analysis);
    const atoms = state.analysis.inventory.atoms;
    if (atoms.length > MISS_EXPLANATION_LIMITS.maxExplanationCount) invalid("atom limit");
    const atomIds = new Set<string>();
    for (const atom of atoms) {
      if (
        atomIds.has(atom.id) ||
        !nonempty(atom.id) ||
        !sameIdentity(atom.identity, state.identity) ||
        !byId.has(atom.eventId)
      )
        invalid("atom identity or reference");
      atomIds.add(atom.id);
    }
    for (const atom of atoms) if (atom.relatedAtomIds.some((id) => !atomIds.has(id))) invalid("consequence reference");
    const excluded = new Set(state.analysis.excludedModelAtomIds);
    if (excluded.size !== state.analysis.excludedModelAtomIds.length || [...excluded].some((id) => !atomIds.has(id)))
      invalid("excluded atom reference");
    const countsMatch = (actual: ReturnType<typeof countErrorAtoms>, expected: ReturnType<typeof countErrorAtoms>) =>
      Object.keys(expected).every(
        (key) => actual[key as keyof typeof expected] === expected[key as keyof typeof expected],
      );
    if (
      !countsMatch(state.analysis.inventory.counts, countErrorAtoms(atoms)) ||
      !countsMatch(state.analysis.admittedCounts, countErrorAtoms(atoms.filter((atom) => !excluded.has(atom.id)))) ||
      !countsMatch(state.analysis.excludedModelCounts, countErrorAtoms(atoms.filter((atom) => excluded.has(atom.id))))
    )
      invalid("analysis counts");
    const displayed = new Set<string>(),
      incidentIds = new Set<string>();
    for (const incident of state.analysis.incidents) {
      if (
        !nonempty(incident.id) ||
        incidentIds.has(incident.id) ||
        !incident.atomIds.length ||
        incident.atomIds.some((id) => !atomIds.has(id) || excluded.has(id) || displayed.has(id)) ||
        incident.mechanism.eventIds.some((id) => !byId.has(id))
      )
        invalid("incident reference");
      incidentIds.add(incident.id);
      incident.atomIds.forEach((id) => displayed.add(id));
    }
    for (const classification of state.analysis.classifications)
      if (
        !atomIds.has(classification.atomId) ||
        excluded.has(classification.atomId) ||
        classification.mechanism.eventIds.some((id) => !byId.has(id))
      )
        invalid("classification reference");
    Object.assign(result, { schemaVersion: 2, analysis: state.analysis });
  }
  const text = JSON.stringify(result);
  if (traceUtf8Bytes(text) > Math.min(state.trace.limits.maxExportBytes, MISS_EXPLANATION_LIMITS.maxExportBytes))
    invalid("export byte limit exceeded");
  return text;
}
