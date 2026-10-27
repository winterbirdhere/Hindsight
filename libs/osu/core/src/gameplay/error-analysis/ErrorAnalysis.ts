import { Beatmap } from "../../beatmap/Beatmap";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { deriveCircleEvidence, reuseCircleEvidence } from "../miss-explanation/CircleEvidence";
import { ErrorAtom, ErrorInventory, inventoryErrors, countErrorAtoms } from "./ErrorInventory";
import { errorCapabilities } from "./ErrorCapabilities";
import { classifyCircleLoss } from "./CircleMechanisms";
import { collectCanonicalControls, completeCanonicalControls } from "./CanonicalReplayVerifier";
import { classifySliderLoss, classifySpinnerLoss, ComponentMechanism } from "./ComponentMechanisms";
import {
  SavedScoreTimeline,
  SavedScoreGrade,
  associateSavedScoreGroups,
  reconcileSavedScoreGroups,
} from "../../replays/SavedScoreTimeline";
import { stableSavedScoreCandidates } from "../../replays/SavedScoreCandidates";
import { traceUtf8Bytes } from "../trace/ReplayTraceCollector";
import { classifyParentCause } from "./ParentCause";
import { contestedPrimaryPresses, AttributionRanking } from "./PrimaryAttribution";
import type { PrimaryCircleDiagnostics } from "./PrimaryCircleDiagnosis";
import { recordedInputChains } from "./RecordedInputChain";

export interface ErrorIncident {
  id: string;
  atomIds: string[];
  parentId: string;
  componentId: string;
  objectTimeMs: number;
  resolutionTimeMs: number;
  mechanism: ComponentMechanism;
}
export interface ErrorAnalysis {
  schemaVersion: 2;
  policyVersion:
    | "all-errors-v1"
    | "all-errors-primary-v2"
    | "all-errors-stream-v3"
    | "all-errors-direct-v4"
    | "all-errors-recovery-v5"
    | "all-errors-initiating-v6"
    | "all-errors-cadence-v9"
    | "all-errors-local-allocation-v10"
    | "all-errors-short-head-v11"
    | "all-errors-player-action-v12"
    | "all-errors-target-arrival-v13"
    | "all-errors-invariant-timing-v14"
    | "all-errors-input-routing-v16"
    | "all-errors-initiating-context-v17"
    | "all-errors-advisory-admission-v18"
    | "all-errors-supported-coverage-v20"
    | "all-errors-supported-coverage-v22"
    | "all-errors-feasible-attribution-v23"
    | "all-errors-graze-tap-attribution-v26"
    | "all-errors-placement-routing-v28"
    | "all-errors-recorded-chain-v29"
    | "all-errors-root-receipt-boundary-v33";
  inventory: ErrorInventory;
  capabilities: ReturnType<typeof errorCapabilities>;
  incidents: ErrorIncident[];
  classifications: Array<{ atomId: string; mechanism: ComponentMechanism }>;
  limitations: string[];
  /** Diagnostics distinguish computed mechanism from saved outcome corroboration. */
  outcomeBasis: "model-reconstruction";
  corroboration?: ReturnType<typeof reconcileSavedScoreGroups>;
  excludedModelAtomIds: string[];
  /** Reconstructed counts; optional historical corroboration does not exclude errors. */
  admittedCounts: ErrorInventory["counts"];
  excludedModelCounts: ErrorInventory["counts"];
}
const unavailable = (reason: string): ComponentMechanism => ({
  status: "unavailable",
  codes: [],
  headline: "Analysis incomplete",
  description: "This replay could not be explained reliably.",
  eventIds: [],
  limitations: [reason],
});

/** Cooperative per-target work; each indexed tracking history belongs to one parent. */
export function assembleErrorAnalysis(
  trace: ReplayTrace,
  map: Beatmap,
  saved?: SavedScoreTimeline,
  maxBytes = trace.limits.maxExportBytes
): Generator<void, ErrorAnalysis, void> {
  return reuseCircleEvidence(trace, map, assembleErrorAnalysisWorker(trace, map, saved, maxBytes));
}

function* assembleErrorAnalysisWorker(
  trace: ReplayTrace,
  map: Beatmap,
  saved: SavedScoreTimeline | undefined,
  maxBytes: number,
): Generator<void, ErrorAnalysis, void> {
  const inventory = inventoryErrors(trace, map),
    capabilities = errorCapabilities(map, trace.identity.analysisProfileId);
  const analysis: ErrorAnalysis = {
    schemaVersion: 2,
    policyVersion: "all-errors-root-receipt-boundary-v33",
    inventory,
    capabilities,
    incidents: [],
    classifications: [],
    limitations: [...inventory.limitations],
    outcomeBasis: "model-reconstruction",
    excludedModelAtomIds: [],
    admittedCounts: { ...inventory.counts },
    excludedModelCounts: countErrorAtoms([]),
  };
  const bytes = (value: unknown) => traceUtf8Bytes(JSON.stringify(value));
  let retainedBytes = bytes(analysis);
  const reserve = (additional: number) => {
    retainedBytes += additional;
    if (retainedBytes > Math.min(maxBytes, 64 * 1024 * 1024)) throw new Error("analysis-byte-limit");
  };
  reserve(0);
  const byId = new Map<string, ReplayTraceRecord>();
  const tracking = new Map<string, Array<Extract<ReplayTraceRecord, { kind: "slider-tracking" }>>>();
  for (let i = 0; i < trace.records.length; i++) {
    const record = trace.records[i];
    byId.set(record.id, record);
    if (record.kind === "slider-tracking") {
      const list = tracking.get(record.componentId) ?? [];
      list.push(record);
      tracking.set(record.componentId, list);
    }
    if (i % 256 === 255) yield;
  }
  yield;
  if (saved) {
    if (
      trace.identity.analysisProfileId !== "stable" ||
      saved.provenance.pairedReplaySha256 !== trace.identity.replayContentSha256 ||
      saved.provenance.mapMd5 !== trace.identity.beatmapMd5
    )
      analysis.limitations.push("saved-score-provenance-mismatch");
    else {
      const candidates = stableSavedScoreCandidates(
        map,
        trace.records.filter((r) => r.kind === "input").map((r) => ({ time: r.timeMs }))
      );
      const model = trace.records.flatMap((r) =>
        (r.kind === "resolution" && r.component === "circle") ||
        r.kind === "slider-parent" ||
        r.kind === "spinner-resolution"
          ? [{ componentId: r.componentId, grade: r.result as SavedScoreGrade }]
          : []
      );
      analysis.corroboration = reconcileSavedScoreGroups(associateSavedScoreGroups(saved, candidates), model);
      reserve(bytes(analysis.corroboration) + 18);
      // A saved outcome disagreement is historical corroboration data, not a
      // concrete failure of the reconstructed input, routing or lifecycle.
      if (analysis.corroboration.conflictingComponentIds.length)
        analysis.limitations.push("saved-outcome-model-conflict");
      if (analysis.corroboration.status !== "complete")
        analysis.limitations.push(`saved-association:${analysis.corroboration.status}`);
    }
  }
  yield;
  const lastIncident = new Map<string, ErrorIncident>();
  const atomsById = new Map(inventory.atoms.map((a) => [a.id, a]));
  const addIncident = (atom: ErrorAtom, mechanism: ComponentMechanism) => {
    let previous = lastIncident.get(atom.parentId);
    if (previous && atom.component !== "circle" && atom.component !== "spinner") {
      const lastSequence =
        byId.get(atomsById.get(previous.atomIds[previous.atomIds.length - 1])?.eventId ?? "")?.sequence ?? -1;
      const record = byId.get(atom.eventId);
      const recovered = (tracking.get(atom.parentId) ?? []).some(
        (t) => t.sequence > lastSequence && t.sequence < (record?.sequence ?? Infinity) && t.tracking.tracking
      );
      // A head judgement alone does not establish a continued body lapse.
      // Parent consequences retain their explicit links to both contributors.
      const previousAtoms = previous.atomIds.map((id) => atomsById.get(id)!);
      const independentHead =
        atom.component === "slider-head" || previousAtoms.some((a) => a.component === "slider-head");
      if (recovered || independentHead) previous = undefined;
    } else previous = undefined;
    if (previous) {
      const beforeBytes = bytes(previous);
      previous.atomIds.push(atom.id);
      const codes = Array.from(new Set([...previous.mechanism.codes, ...mechanism.codes]));
      if (
        codes.length !== previous.mechanism.codes.length ||
        previous.mechanism.status !== mechanism.status
      ) {
        const first = previous.mechanism;
        // Preserve all gate diagnoses. A group cannot silently discard a competing loss.
        previous.mechanism = {
          status:
            first.status === "supported" && mechanism.status === "supported" ? "supported" : "unavailable",
          codes,
          ...bodyLapseCopy(codes),
          eventIds: Array.from(new Set([...first.eventIds, ...mechanism.eventIds])),
          limitations: Array.from(new Set([...first.limitations, ...mechanism.limitations])),
        };
      } else
        previous.mechanism = {
          ...previous.mechanism,
          eventIds: Array.from(new Set([...previous.mechanism.eventIds, ...mechanism.eventIds])),
        };
      reserve(bytes(previous) - beforeBytes);
    } else {
      const incident: ErrorIncident = {
        id: `incident:${atom.id}`,
        atomIds: [atom.id],
        parentId: atom.parentId,
        componentId: atom.componentId,
        objectTimeMs: atom.objectTimeMs,
        resolutionTimeMs: atom.resolutionTimeMs,
        mechanism,
      };
      reserve(bytes(incident) + 1);
      analysis.incidents.push(incident);
      lastIncident.set(atom.parentId, incident);
    }
  };
  const primaryComparisons: Array<{
    targetId: string;
    ranking: AttributionRanking;
    primary: PrimaryCircleDiagnostics;
  }> = [];
  const chains = recordedInputChains(map, trace), ordinaryByAtom = new Map<string, ComponentMechanism>();
  for (const atom of inventory.atoms) {
    if (atom.role === "consequence") continue;
    const record = byId.get(atom.eventId);
    let mechanism: ComponentMechanism;
    if (record?.kind === "resolution") {
      const evidence = deriveCircleEvidence(trace, map, atom.componentId);
      const classify = () => classifyCircleLoss(evidence, map, trace);
      let pass = collectCanonicalControls(map, trace, classify);
      while (pass.queue.length) {
        yield* completeCanonicalControls(map, trace, pass.queue);
        pass = collectCanonicalControls(map, trace, classify);
      }
      const ordinary = pass.value;
      ordinaryByAtom.set(atom.id, ordinary);
      if (record.result === "MISS") {
        pass = collectCanonicalControls(map, trace, () => chains.apply(evidence, ordinary));
        while (pass.queue.length) {
          yield* completeCanonicalControls(map, trace, pass.queue);
          pass = collectCanonicalControls(map, trace, () => chains.apply(evidence, ordinary));
        }
        chains.commit();
      }
      mechanism = pass.value;
      const primary = pass.value.diagnostics?.primary;
      const ranking =
        primary?.rawOpportunityComparison?.ranking ??
        primary?.unconsumedContextComparison?.ranking ??
        primary?.ranking;
      if (primary && ranking?.attribution)
        primaryComparisons.push({ targetId: atom.componentId, ranking, primary });
    } else if (record?.kind === "slider-checkpoint")
      mechanism = classifySliderLoss(
        record,
        tracking.get(atom.parentId) ?? [],
        map.getSlider(atom.parentId),
        trace.identity.analysisProfileId === "stable" ? "stable" : "lazer",
        capabilities
      );
    else if (record?.kind === "spinner-resolution") mechanism = classifySpinnerLoss(record, capabilities);
    else mechanism = unavailable("missing-component-observation");
    if (!ordinaryByAtom.has(atom.id)) ordinaryByAtom.set(atom.id, mechanism);
    const classification = { atomId: atom.id, mechanism };
    reserve(bytes(classification) + 1);
    analysis.classifications.push(classification);
    if (mechanism.status !== "supported") analysis.limitations.push(`unclassified:${atom.componentId}`);
    addIncident(atom, mechanism);
    yield;
  }
  for (const atom of inventory.atoms.filter((a) => a.role === "consequence")) {
    const mechanism = classifyParentCause(
      atom,
      atomsById,
      atom.result === "MISS" ? new Map(analysis.classifications.map((c) => [c.atomId, c.mechanism])) : ordinaryByAtom,
      trace,
      map,
      byId,
      tracking.get(atom.parentId) ?? [],
      new Set()
    );
    const classification = { atomId: atom.id, mechanism };
    reserve(bytes(classification) + 1);
    analysis.classifications.push(classification);
    if (mechanism.status !== "supported") analysis.limitations.push(`unclassified:${atom.componentId}`);
    const linked = analysis.incidents.filter((i) => i.atomIds.some((id) => atom.relatedAtomIds.includes(id)));
    if (linked.length) {
      reserve(bytes(atom.id) + 1);
      linked[0].atomIds.push(atom.id);
    } else {
      addIncident(atom, mechanism);
      analysis.limitations.push(`unclassified:${atom.componentId}`);
    }
    yield;
  }
  for (const [index, competition] of contestedPrimaryPresses(primaryComparisons).entries()) {
    const { targetId, ...diagnostic } = competition;
    primaryComparisons[index].primary.contestedPress = diagnostic;
    // Circle classifications and incidents each serialize this one field.
    reserve(2 * (bytes({ contestedPress: diagnostic }) + 1));
  }
  analysis.limitations = Array.from(new Set(analysis.limitations));
  reserve(bytes(analysis.limitations));
  return analysis;
}
function bodyLapseCopy(codes: string[]): Pick<ComponentMechanism, "headline" | "description"> {
  const spatial = codes.filter((code) =>
    ["off-track", "ran-ahead", "fell-behind", "turned-early"].includes(code)
  );
  const holding = codes.filter((code) => ["no-hold", "wrong-hold", "released-early"].includes(code));
  const labels: Record<string, [string, string, string]> = {
    "off-track": ["Off track", "Off-track", "the cursor outside the slider ball"],
    "ran-ahead": ["Ran ahead", "Ahead", "the cursor ahead of the slider ball"],
    "fell-behind": ["Fell behind", "Behind", "the cursor behind the slider ball"],
    "turned-early": ["Turned early", "Early-turn", "the cursor turning back too soon"],
    "no-hold": ["No hold", "Unheld", "no button held"],
    "wrong-hold": ["Wrong hold", "Wrong-hold", "the wrong button held"],
    "released-early": ["Released early", "Released", "the button released too soon"],
    "changing-hold": ["Hold interrupted", "Interrupted-hold", "the required hold interrupted"],
    "started-late": ["Started late", "Late-start", "the head hit too late"],
    "late-pickup": ["Late pickup", "Late-pickup", "tracking picked up too late"],
  };
  // Several directional states in one uninterrupted lapse establish loss of
  // tracking as a whole, not one arbitrarily selected direction. Atomic
  // classifications keep every individual state and witness.
  const selected = [
    ...(spatial.length ? [spatial.length === 1 ? spatial[0] : "off-track"] : []),
    ...(holding.length ? [holding.length === 1 ? holding[0] : "changing-hold"] : []),
    ...codes.filter((code) => code === "started-late" || code === "late-pickup"),
  ];
  const words = selected.map((code) => labels[code]);
  const expanded = words.map((label) => label[0]).join(" · ");
  return {
    headline:
      expanded.split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length <= 4
        ? expanded
        : words.map((label) => label[1]).join(" · "),
    description: `The slider lost parts with ${words.map((label) => label[2]).join(" and ")}.`,
  };
}
export function buildErrorAnalysis(
  trace: ReplayTrace,
  map: Beatmap,
  saved?: SavedScoreTimeline
): ErrorAnalysis {
  const work = assembleErrorAnalysis(trace, map, saved);
  let next = work.next();
  while (!next.done) next = work.next();
  return next.value;
}
