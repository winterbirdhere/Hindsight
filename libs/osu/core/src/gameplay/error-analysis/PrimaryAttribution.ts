import { Beatmap } from "../../beatmap/Beatmap";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { PrimaryApproachResult, PrimaryContact, isPrimaryCursorPass } from "./PrimaryApproach";
import { PrimaryCandidate, PRIMARY_DIAGNOSIS_POLICY } from "./PrimaryDiagnosisPolicy";
import { inspectPrimaryOpportunity, PrimaryOpportunity, OpportunityRefusal } from "./PrimaryOpportunity";
import { recordedAttributionFailure } from "./RecordedAttributionValidity";

export interface PressAttributionFacts {
  tapOffsetMs: number;
  bestWindowMs: number;
  hitWindowMs?: number;
  originalInside?: boolean;
  /** Historical certificate flags are accepted as diagnostics, never decision inputs. */
  tapFeasible?: boolean;
  aimFeasible?: boolean;
  /** Source-validated, non-graze contacts only; filtering happens before this comparison. */
  passes: Array<{ entryMs: number; exitMs: number; minRadialR?: number }>;
  /** Beat-containing physical grazes may supply a correct tap, never cursor coverage. */
  grazes?: Array<{ entryMs: number; exitMs: number; minRadialR?: number; recordedFailure?: string }>;
  /** Includes censored/unproven deeper contacts in H: unknown is not absent. */
  deeperContactExists?: boolean;
}

function isBeatContainingGraze(graze: NonNullable<PressAttributionFacts["grazes"]>[number]) {
  return !graze.recordedFailure && graze.entryMs <= 0 && graze.exitMs >= 0;
}

/** Quantities share one reference: the prepared 300 window. Distance is never
 * an ordering input. Availability is recorded geometry, not certification. */
export function decidePressAttribution(facts: PressAttributionFacts) {
  const { tapOffsetMs, bestWindowMs } = facts;
  const grazeTapAvailable = Math.abs(tapOffsetMs) > bestWindowMs && (facts.grazes ?? []).some(
    isBeatContainingGraze,
  );
  const grazeOnlyComparison = grazeTapAvailable && !facts.passes.length && !facts.deeperContactExists;
  const tapFeasible = grazeTapAvailable || facts.passes.some(
    (pass) => Math.max(-bestWindowMs, pass.entryMs) <= Math.min(bestWindowMs, pass.exitMs),
  );
  const aimFeasible = Math.abs(tapOffsetMs) < (facts.hitWindowMs ?? Infinity) && !facts.originalInside;
  const tapTolerance = Math.abs(tapOffsetMs) / bestWindowMs;
  const boundaries = facts.passes.map((pass) =>
    tapOffsetMs < pass.entryMs
      ? Math.max(0, (pass.entryMs + bestWindowMs) / bestWindowMs)
      : tapOffsetMs > pass.exitMs
      ? Math.max(0, (bestWindowMs - pass.exitMs) / bestWindowMs)
      : 0,
  );
  // The full width of G is 2w. A graze makes a tap physically hittable while
  // leaving all of that cursor coverage absent under the placement policy.
  const cursorTolerance = boundaries.length ? Math.min(...boundaries) : grazeOnlyComparison ? 2 : undefined;
  const cursorBoundaryIndex = boundaries.length ? boundaries.indexOf(cursorTolerance!) : undefined;
  let channel: "cursor" | "tapping" | "unresolved" = "unresolved";
  let rule = "joint-failure";
  // A hittable press already inside is not a tapping departure merely because
  // another point in its pass intersects G. Routing alone cannot invent one.
  if (Math.abs(tapOffsetMs) < (facts.hitWindowMs ?? Infinity) && facts.originalInside) {
    rule = "no-observed-departure";
  } else if (aimFeasible && !tapFeasible) {
    channel = "cursor";
    rule = "only-aim-feasible";
  } else if (tapFeasible && !aimFeasible) {
    channel = "tapping";
    rule = "only-tap-feasible";
  } else if (aimFeasible && tapFeasible) {
    rule = "shared-best-window-tolerance";
    if (cursorTolerance === undefined || !(bestWindowMs > 0) || !Number.isFinite(tapTolerance)) {
      rule = "missing-comparable-boundary";
    } else if (tapTolerance > 0 || cursorTolerance > 0) {
      channel = tapTolerance > cursorTolerance ? "tapping" : "cursor";
    } else rule = "no-observed-departure";
  }
  const largest = Math.max(tapTolerance, cursorTolerance ?? 0);
  const smallest = Math.min(tapTolerance, cursorTolerance ?? 0);
  const nearTie =
    aimFeasible &&
    tapFeasible &&
    largest > 0 &&
    smallest + PRIMARY_DIAGNOSIS_POLICY.comparisonTolerance >=
      largest * PRIMARY_DIAGNOSIS_POLICY.nearTieRatio &&
    largest - smallest <=
      PRIMARY_DIAGNOSIS_POLICY.nearTieDifference + PRIMARY_DIAGNOSIS_POLICY.comparisonTolerance;
  return {
    channel,
    rule,
    tapTolerance,
    cursorTolerance,
    cursorBoundaryIndex,
    nearTie,
    tapFeasible,
    aimFeasible,
    grazeTapAvailable,
    grazeOnlyComparison,
  };
}

export interface PressAttribution extends ReturnType<typeof decidePressAttribution> {
  inputId: string;
  tapOffsetMs: number;
  bestWindowMs: number;
  hitWindowMs: number;
  tapFeasible: boolean;
  aimFeasible: boolean;
  tapCorrection?: Pick<PrimaryOpportunity, "kind" | "inputId" | "sampleId" | "timeMs">;
  aimCorrection?: Pick<PrimaryOpportunity, "kind" | "inputId" | "sampleId" | "timeMs">;
  passes: PressAttributionFacts["passes"];
  grazes?: Array<{ entryMs: number; exitMs: number; minRadialR: number; eventIds: string[];
    recordedFailure?: string }>;
  cursorDistanceR?: number;
  /** A non-300 tap remains an observation when cursor placement wins. */
  tapOffsetObservationMs?: number;
  routingObservation?: {
    provenance: "model-reconstructed";
    outcomes: Array<{ status: "consumed" | "consumed-miss" | "blocked" | "unresolved"; attemptId: string;
      receiverId?: string; blockerId?: string; eventIds: string[] }>;
  };
  bestOverlapMs: number;
  narrowOverlap: boolean;
  /** Absence of a proof is not proof of geometric impossibility. */
  feasibilityStatus:
    | "certified"
    | "observation-only"
    | "no-observed-departure"
    | "geometric-joint-failure"
    | "uncertified-joint-failure";
  observationOnly?: boolean;
  originalInside: boolean;
  clearOriginalPrefix: boolean;
  sourceSequence: number;
  roleEventIds: string[];
  selectedCodes: string[];
  certification?: Array<{
    code: string;
    channel: "tapping" | "cursor";
    status: "certified" | "observation-only";
    refusals: OpportunityRefusal[];
  }>;
  pendingPreviousObjectId?: string;
  pendingPrefixObjectIds?: string[];
  recordedFailure?: string;
}

export interface AttributionRanking {
  selected: PrimaryCandidate[];
  candidates: PrimaryCandidate[];
  comparisonInputIds: string[];
  comparisonEventIds: string[];
  scores: Array<{ code: string; inputs: Array<{ inputId: string; strength: number }> }>;
  reason: string;
  attribution?: {
    version: "recorded-correct-play-v4";
    presses: PressAttribution[];
    roles: {
      firstClearInputId?: string;
      nearestInputId?: string;
      contextualInputId?: string;
      chosenInputId?: string;
      rule: string;
      disagreement: boolean;
    };
    crossUnitDecisions: 0;
  };
  observationComplete?: boolean;
  proposed?: PrimaryCandidate[];
}

/** Capacity warning only: shared recorded presses do not determine ownership. */
export function contestedPrimaryPresses(
  entries: readonly { targetId: string; ranking: AttributionRanking }[],
) {
  const nearest = new Map<string, Set<string>>();
  for (const entry of entries) {
    const id = entry.ranking.attribution?.roles.nearestInputId;
    if (id) {
      const targets = nearest.get(id) ?? new Set<string>();
      targets.add(entry.targetId);
      nearest.set(id, targets);
    }
  }
  return entries.map((entry) => {
    const inputId = entry.ranking.attribution?.roles.chosenInputId;
    const nearestForOtherTargetIds = inputId
      ? [...(nearest.get(inputId) ?? [])].filter((id) => id !== entry.targetId)
      : [];
    return {
      targetId: entry.targetId,
      inputId,
      contested: !!nearestForOtherTargetIds.length,
      nearestForOtherTargetIds,
    };
  });
}

/** Keep the in-memory API intact, but serialize an explicit alias instead of
 * repeating a candidate pool already present verbatim in the same comparison. */
export function referenceComparisonCandidates<
  T extends { candidates: PrimaryCandidate[]; ranking: AttributionRanking },
>(comparison: T): T {
  Object.defineProperty(comparison, "toJSON", {
    value: () => ({
      ...comparison,
      candidates: undefined,
      candidatePool: "ranking.candidates",
    }),
  });
  return comparison;
}

const unique = (ids: readonly string[]) => [...new Set(ids)].sort();
type Receipt = Extract<ReplayTrace["records"][number], { kind: "resolution" }>;
const receiptIndexes = new WeakMap<ReplayTrace, Map<string, Receipt[]>>();

/** Passive provenance for a locally correct press. Never infer ownership or a
 * blocker from a pending predecessor, and never manufacture a direct rejection. */
function observePressRouting(evidence: CircleEvidence, trace: ReplayTrace | undefined, inputId: string):
  NonNullable<PressAttribution["routingObservation"]> {
  const outcomes: NonNullable<PressAttribution["routingObservation"]>["outcomes"] = [];
  if (!trace) return { provenance: "model-reconstructed", outcomes };
  let receipts = receiptIndexes.get(trace);
  if (!receipts) {
    receipts = new Map();
    for (const r of trace.records) if (r.kind === "resolution" && r.triggerAttemptId) {
      const rows = receipts.get(r.triggerAttemptId) ?? [];
      rows.push(r); receipts.set(r.triggerAttemptId, rows);
    }
    receiptIndexes.set(trace, receipts);
  }
  const press = evidence.inputs.find(i => i.record.id === inputId)?.record;
  if (!press || trace.records[press.sequence] !== press) return { provenance: "model-reconstructed", outcomes };
  for (const attempt of evidence.attempts.filter(a => a.inputId === inputId)) {
    if (trace.records[attempt.sequence] !== attempt || attempt.sequence <= press.sequence ||
      attempt.timeMs !== press.timeMs || attempt.automated) continue;
    const routes = evidence.routing.filter(r => r.attemptId === attempt.id &&
      trace.records[r.sequence] === r && r.sequence > attempt.sequence && r.timeMs === press.timeMs);
    const selections = routes.filter(r => r.kind === "selection" && r.eligible && r.selectionStopped && r.inside);
    const successful = (receipts.get(attempt.id) ?? []).filter(r => r.mechanism === "successful-input" && r.result !== "MISS" &&
      r.timeMs === press.timeMs && selections.some(s => s.componentId === r.componentId && s.sequence < r.sequence));
    for (const receipt of successful) outcomes.push({ status: "consumed", attemptId: attempt.id,
      receiverId: receipt.componentId, eventIds: [inputId, attempt.id, ...routes.filter(r => r.componentId === receipt.componentId).map(r => r.id), receipt.id] });
    // Dispatch can consume the press by resolving an earlier receiver as MISS.
    // Keep that actual input receipt distinct from a successful hit or a veto.
    const inputMisses = (receipts.get(attempt.id) ?? []).filter(r => r.mechanism === "input-miss" && r.result === "MISS" &&
      r.timeMs === press.timeMs && selections.some(s => s.componentId === r.componentId && s.sequence < r.sequence) &&
      routes.some(p => p.kind === "policy" && p.componentId === r.componentId && p.state === "allowed" &&
        p.timingResult === "MISS" && p.sequence < r.sequence));
    for (const receipt of inputMisses) outcomes.push({ status: "consumed-miss", attemptId: attempt.id,
      receiverId: receipt.componentId, eventIds: [inputId, attempt.id, ...routes.filter(r => r.componentId === receipt.componentId).map(r => r.id), receipt.id] });
    const rejected = routes.filter(r => r.kind === "policy" && r.state === "rejected");
    for (const policy of rejected) if (policy.kind === "policy") outcomes.push({ status: "blocked", attemptId: attempt.id,
      receiverId: policy.componentId, blockerId: policy.blockerId, eventIds: [inputId, attempt.id, policy.id] });
    if (!successful.length && !inputMisses.length && !rejected.length) outcomes.push({ status: "unresolved", attemptId: attempt.id,
      eventIds: [inputId, attempt.id, ...routes.map(r => r.id)] });
  }
  return { provenance: "model-reconstructed", outcomes };
}
const roleIndexes = new WeakMap<ReplayTrace, Map<string, { id: string; sequence: number }>>();
export function prefixBeforePress(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  sequence: number,
) {
  if (!trace)
    return {
      clear: false,
      eventIds: [] as string[],
      pendingObjectIds: [] as string[],
      pendingPreviousObjectId: undefined as string | undefined,
    };
  let terminals = roleIndexes.get(trace);
  if (!terminals) {
    terminals = new Map();
    for (const row of trace.records)
      if (row.kind === "resolution" || row.kind === "slider-parent" || row.kind === "spinner-resolution")
        terminals.set(row.componentId, row);
    roleIndexes.set(trace, terminals);
  }
  const at = map.hitObjects.findIndex(
    (o) => o.id === evidence.targetId || (o instanceof Slider && o.head.id === evidence.targetId),
  );
  if (at < 0)
    return {
      clear: false,
      eventIds: [] as string[],
      pendingObjectIds: [] as string[],
      pendingPreviousObjectId: undefined as string | undefined,
    };
  const parents = map.hitObjects.slice(0, at).map((o) => terminals!.get(o.id));
  const clear = parents.every((row) => row && row.sequence < sequence);
  const latest = clear
    ? parents.reduce<typeof parents[number]>((a, b) => (!a || b!.sequence > a.sequence ? b : a), undefined)
    : undefined;
  const pendingObjectIds = map.hitObjects
    .slice(0, at)
    .filter((o, k) => !parents[k] || parents[k]!.sequence >= sequence)
    .map((o) => o.id);
  const previousId = map.hitObjects[at - 1]?.id;
  return {
    clear,
    eventIds: latest ? [latest.id] : [],
    pendingObjectIds,
    pendingPreviousObjectId: previousId && pendingObjectIds.includes(previousId) ? previousId : undefined,
  };
}

function validAimProof(
  proof: PrimaryOpportunity | undefined,
  inputId: string,
  timeMs: number,
  targetId: string,
) {
  if (!proof || proof.kind !== "same-time-aim" || proof.inputId !== inputId || proof.timeMs !== timeMs)
    return undefined;
  const outcome = proof.canonicalControl?.outcomes.find((o) => o.componentId === targetId)?.after;
  return proof.canonicalControl && (!outcome || outcome.type === "MISS" || outcome.judgementTime !== timeMs)
    ? undefined
    : proof;
}

function arrivalForPress(contacts: readonly PrimaryContact[], pressTimeMs: number) {
  const before = contacts
    .filter((c) => !c.rightCensored && c.exitTimeMs < pressTimeMs)
    .sort((a, b) => b.exitTimeMs - a.exitTimeMs)[0];
  const after = contacts
    .filter((c) => !c.leftCensored && c.entryTimeMs > pressTimeMs)
    .sort((a, b) => a.entryTimeMs - b.entryTimeMs)[0];
  if (before && after)
    return {
      code: "between-passes",
      headline: "Between passes",
      gap: Math.min(pressTimeMs - before.exitTimeMs, after.entryTimeMs - pressTimeMs),
      events: [...before.eventIds, ...after.eventIds],
      phrase: "Tapped between circle passes",
    };
  if (before)
    return {
      code: "left-early",
      headline: "Early exit",
      gap: pressTimeMs - before.exitTimeMs,
      events: before.eventIds,
      phrase: "Cursor left before tap",
    };
  if (after)
    return {
      code: "aim-late",
      headline: "Late entry",
      gap: after.entryTimeMs - pressTimeMs,
      events: after.eventIds,
      phrase: "Cursor arrived after tap",
    };
  return undefined;
}

/** Specificity refines the same cursor correction; it never weighs radial
 * distance against time or borrows a certificate from another action. */
export function selectCursorDescription(
  candidates: readonly PrimaryCandidate[],
  inputId: string,
  proof?: PrimaryOpportunity,
  observationOnly = false,
) {
  const sameProof = (candidate: PrimaryCandidate) => {
    const own = candidate.support?.correction;
    if (!proof) return observationOnly;
    if (
      !own ||
      own.kind !== "same-time-aim" ||
      own.inputId !== inputId ||
      own.sampleId !== proof.sampleId ||
      own.timeMs !== proof.timeMs
    )
      return false;
    const key = (value: unknown) =>
      JSON.stringify(value, (name, item) => (name === "eventIds" ? undefined : item));
    return (
      key(own.prefix) === key(proof.prefix) &&
      key(own.headRoutingPreservation) === key(proof.headRoutingPreservation)
    );
  };
  const spatial = candidates.filter(
    (c) => c.inputIds.length === 1 && c.inputIds[0] === inputId && c.family === "placement" && sameProof(c),
  );
  const specific = spatial.filter((c) => c.code !== "misaim");
  const codes = unique(specific.map((c) => c.code));
  return codes.length === 1 ? specific[0] : spatial.find((c) => c.code === "misaim");
}

/** Collect recorded per-press decisions. No certificate is requested here. */
export function attributePrimaryPresses(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  approaches: PrimaryApproachResult,
  original: readonly PrimaryCandidate[],
  inputIds: readonly string[],
  excluded: ReadonlySet<string> = new Set(),
): AttributionRanking {
  const candidates = original.map((c) => ({ ...c }));
  const pressDecisions: PressAttribution[] = [];
  if (!evidence.geometry || !evidence.target) return rankAttributionCandidates(candidates, inputIds);
  const beat = evidence.target.hitTimeMs,
    best = evidence.geometry.hitWindows[0];
  const hitWindow = evidence.geometry.hitWindows[2];
  for (const inputId of inputIds) {
    const episode = approaches.episodes.find((ep) => ep.inputId === inputId);
    const press = evidence.inputs.find((i) => i.record.id === inputId);
    if (!episode || !press) continue;
    const own = candidates.filter((c) => c.inputIds.length === 1 && c.inputIds[0] === inputId);
    const witnessIds = unique([...episode.eventIds, ...own.flatMap((c) => c.eventIds)]);
    const pressFailure = recordedAttributionFailure(evidence, trace, inputId, [inputId], excluded);
    const validOwn = own.filter(
      (c) =>
        !recordedAttributionFailure(
          evidence,
          trace,
          inputId,
          c.geometryWitnessEventIds ?? c.eventIds,
          excluded,
        ),
    );
    const episodeFailure = recordedAttributionFailure(evidence, trace, inputId, episode.eventIds, excluded);
    const locallyCorrect = press.inside && Math.abs(press.record.timeMs - beat) < hitWindow;
    const recordedFailure = pressFailure ?? (!locallyCorrect && !validOwn.length ? episodeFailure : undefined);
    const aimCorrection: PrimaryOpportunity | undefined = undefined;
    const tapCorrection: PrimaryOpportunity | undefined = undefined;
    const liveContacts = episode.contacts.filter(
      (c) =>
        c.placementSupport !== "unproven" &&
        c.exitTimeMs >= beat - hitWindow &&
        c.entryTimeMs <= beat + hitWindow,
    );
    const contacts = liveContacts.filter(isPrimaryCursorPass);
    const grazes = episode.contacts.filter((c) => c.placementSupport !== "unproven" &&
      !isPrimaryCursorPass(c) && Number.isFinite(c.minRadialR) && c.minRadialR >= 0);
    const passes = contacts
      .filter(
        (c) =>
          !(press.record.timeMs < c.entryTimeMs && c.leftCensored) &&
          !(press.record.timeMs > c.exitTimeMs && c.rightCensored),
      )
      .map((c) => ({ entryMs: c.entryTimeMs - beat, exitMs: c.exitTimeMs - beat, minRadialR: c.minRadialR }));
    const bestOverlapMs = Math.max(
      0,
      ...passes.map((p) => Math.min(best, p.exitMs) - Math.max(-best, p.entryMs)),
    );
    const tapOffsetMs = press.record.timeMs - beat;
    const grazeFacts = grazes.map(c => ({ entryMs: c.entryTimeMs - beat, exitMs: c.exitTimeMs - beat,
      minRadialR: c.minRadialR, eventIds: [...c.eventIds],
      recordedFailure: Math.abs(tapOffsetMs) > best && c.entryTimeMs <= beat + best &&
        c.exitTimeMs >= beat - best
        ? recordedAttributionFailure(evidence, trace, inputId, c.eventIds, excluded) : undefined }));
    const deepTapAvailable = passes.some(p => Math.max(-best, p.entryMs) <= Math.min(best, p.exitMs));
    const deeperContactExists = episode.contacts.some(c => isPrimaryCursorPass(c) &&
      c.exitTimeMs >= beat - hitWindow && c.entryTimeMs <= beat + hitWindow);
    const observationOnly = true;
    const decision = decidePressAttribution({
      tapOffsetMs,
      bestWindowMs: best,
      hitWindowMs: hitWindow,
      originalInside: press.inside,
      passes,
      grazes: grazeFacts,
      deeperContactExists,
    });
    const { tapFeasible, aimFeasible } = decision;
    const prefix = prefixBeforePress(evidence, map, trace, press.record.sequence);
    const reference = (proof: PrimaryOpportunity | undefined) =>
      proof && { kind: proof.kind, inputId: proof.inputId, sampleId: proof.sampleId, timeMs: proof.timeMs };
    const attribution: PressAttribution = {
      ...decision,
      inputId,
      tapOffsetMs,
      bestWindowMs: best,
      hitWindowMs: hitWindow,
      tapFeasible,
      aimFeasible,
      observationOnly,
      tapCorrection: reference(tapCorrection),
      aimCorrection: reference(aimCorrection),
      passes,
      grazes: grazeFacts,
      cursorDistanceR: Math.hypot(press.record.position.x - evidence.geometry.position.x,
        press.record.position.y - evidence.geometry.position.y) / evidence.geometry.radius,
      bestOverlapMs,
      narrowOverlap: bestOverlapMs > 0 && bestOverlapMs < 2,
      originalInside: press.inside,
      clearOriginalPrefix: prefix.clear,
      sourceSequence: press.record.sequence,
      roleEventIds: prefix.eventIds,
      pendingPreviousObjectId: prefix.pendingPreviousObjectId,
      pendingPrefixObjectIds: prefix.pendingObjectIds,
      selectedCodes: [],
      recordedFailure,
      feasibilityStatus: decision.rule === "no-observed-departure" ? "no-observed-departure" :
        tapFeasible || aimFeasible ? "observation-only" : "geometric-joint-failure",
    };
    if (decision.rule === "no-observed-departure")
      attribution.routingObservation = observePressRouting(evidence, trace, inputId);
    // Candidates carry an in-memory link. Serialize each decision once in its
    // ranking pool instead of copying it into every witness and selected row.
    Object.defineProperty(attribution, "toJSON", { value: () => undefined });
    pressDecisions.push(attribution);

    let cursor = selectCursorDescription(validOwn, inputId, aimCorrection, observationOnly);
    // A pre-live passage cannot certify correct tapping, but it can still
    // describe a separately certified same-time cursor correction.
    const grazeOnly = grazes.length > 0 && !deeperContactExists;
    const descriptionContacts = grazeOnly ? [] : contacts.length
      ? contacts
      : episode.contacts.filter((c) => isPrimaryCursorPass(c) && c.placementSupport !== "unproven");
    const arrival = arrivalForPress(descriptionContacts, press.record.timeMs);
    if (!cursor && grazeOnly && aimFeasible) {
      cursor = {
        code: "misaim", headline: "Misaim", family: "placement", strength: attribution.cursorDistanceR!,
        independent: false, relationId: "placement:" + inputId, inputIds: [inputId],
        eventIds: unique([inputId, ...grazes.flatMap(c => c.eventIds)]),
      };
      candidates.push(cursor);
    }
    if (!cursor && arrival && aimFeasible) {
      const metric = { value: Math.round(arrival.gap / map.gameClockRate), unit: "ms" };
      const established = validOwn.find((c) => c.code === arrival.code && c.family === "arrival");
      const description: PrimaryCandidate = {
        code: arrival.code,
        headline: arrival.headline,
        family: "arrival",
        strength: decision.cursorTolerance ?? 0,
        independent: false,
        relationId: "tap-phase:" + inputId,
        inputIds: [inputId],
        eventIds: unique([inputId, ...arrival.events]),
        ...(aimCorrection
          ? {
              support: {
                ...established?.support,
                compound: undefined,
                sharedPass: undefined,
                correction: aimCorrection,
              },
            }
          : {}),
        metric,
        briefDetail: { phrase: arrival.phrase, metric },
      };
      cursor = established ? Object.assign(established, description) : description;
      if (!established) candidates.push(cursor);
    }
    if (cursor && aimCorrection)
      cursor.support = {
        ...cursor.support,
        compound: undefined,
        sharedPass: undefined,
        correction: aimCorrection,
      };
    const tapCode = tapOffsetMs === 0 ? "off-beat" : tapOffsetMs < 0 ? "early-tap" : "late-tap";
    let tapping = validOwn.find((c) => c.family === "timing" && c.code === tapCode);
    if (!tapping && tapFeasible && (!locallyCorrect || deepTapAvailable)) {
      tapping = {
        code: tapCode,
        headline: tapOffsetMs === 0 ? "Off beat" : tapOffsetMs < 0 ? "Early tap" : "Late tap",
        family: "timing",
        strength: decision.tapTolerance,
        independent: episode.timingIndependent,
        relationId: "tap-phase:" + inputId,
        inputIds: [inputId],
        eventIds: witnessIds,
        ...(tapCorrection ? { support: { correction: tapCorrection } } : {}),
      };
      candidates.push(tapping);
    }
    // A bare timing descriptor is not evidence of the newly available physical
    // correction. Bind it to its source-validated graze, without changing old
    // deep-pass witnesses or inventing timing departures for locally correct taps.
    if (tapping && decision.grazeTapAvailable && !deepTapAvailable && !locallyCorrect) {
      const grazeWitnessIds = grazeFacts.filter(isBeatContainingGraze).flatMap(c => c.eventIds);
      tapping.geometryWitnessEventIds = unique([
        ...(tapping.geometryWitnessEventIds ?? tapping.eventIds), ...grazeWitnessIds,
      ]);
      tapping.eventIds = unique([...tapping.eventIds, ...grazeWitnessIds]);
    }
    if (tapping && tapCorrection)
      tapping.support = {
        ...tapping.support,
        compound: undefined,
        sharedPass: undefined,
        correction: tapCorrection,
      };
    // Refine only a cursor verdict that would otherwise select the gap label.
    // Keep the original candidate and both contacts in the diagnostic pool.
    // Same-press placement specificity was already considered above.
    if (decision.channel === "cursor" && cursor?.code === "between-passes") {
      cursor = { ...cursor, code: "misaim", headline: "Misaim", family: "placement",
        strength: attribution.cursorDistanceR!, independent: false };
      candidates.push(cursor);
    }
    // Direction refines the already chosen cursor channel. Keep the unrefined
    // candidates for the existing independence test and for diagnostics.
    const unrefinedCursor = cursor;
    const farReturn = decision.channel === "cursor" && episode.farEdgeReturn;
    if (cursor && cursor.code !== "overshoot" && farReturn &&
      !recordedAttributionFailure(evidence, trace, inputId, farReturn.eventIds, excluded)) {
      cursor = { ...cursor, code: "overshoot", headline: "Overshoot", family: "placement",
        geometryWitnessEventIds: unique([...(cursor.geometryWitnessEventIds ?? cursor.eventIds), ...farReturn.eventIds]),
        eventIds: unique([...cursor.eventIds, ...farReturn.eventIds]) };
      candidates.push(cursor);
    }
    const winner =
      decision.channel === "cursor" ? cursor : decision.channel === "tapping" ? tapping : undefined;
    const alternative = decision.channel === "cursor" ? tapping : cursor;
    if (winner && !recordedFailure && (winner.family === "timing" ? tapFeasible : aimFeasible)) {
      if (decision.channel === "cursor" && Math.abs(tapOffsetMs) > best)
        attribution.tapOffsetObservationMs = tapOffsetMs;
      attribution.selectedCodes.push(winner.code);
      const grazePair = decision.grazeOnlyComparison && alternative &&
        [winner, alternative].every(c => c.inputIds.length === 1 && c.inputIds[0] === inputId) &&
        new Set([winner.family, alternative.family]).has("placement") &&
        new Set([winner.family, alternative.family]).has("timing");
      if (decision.nearTie && alternative && (grazePair || independentPair(
        winner === cursor ? unrefinedCursor! : winner, alternative === cursor ? unrefinedCursor! : alternative)))
        attribution.selectedCodes.push(alternative.code);
      if (decision.nearTie && grazePair) {
        for (const candidate of [winner, alternative!]) {
          const metric = candidate.family === "timing"
            ? { value: Math.round(Math.abs(tapOffsetMs) / map.gameClockRate),
                unit: tapOffsetMs < 0 ? "ms early" : "ms late" }
            : { value: Math.round(2 * best / map.gameClockRate), unit: "ms" };
          candidate.metric = metric;
          candidate.briefDetail = { phrase: candidate.family === "timing" ? "" : "300 window left uncovered", metric };
        }
      }
      if (winner.family === "timing") {
        const correctionGap = beat - press.record.timeMs;
        const metric = {
          value: Math.round(Math.abs(tapOffsetMs || correctionGap) / map.gameClockRate),
          unit: tapOffsetMs === 0 ? "ms" : tapOffsetMs < 0 ? "ms early" : "ms late",
        };
        winner.metric = metric;
        winner.briefDetail = {
          phrase:
            tapOffsetMs === 0
              ? correctionGap > 0
                ? "Tap before usable passage"
                : "Tap after usable passage"
              : "",
          metric,
        };
      } else if (winner.family === "placement") {
        const clearance = Math.max(
          0,
          Math.hypot(
            press.record.position.x - evidence.geometry.position.x,
            press.record.position.y - evidence.geometry.position.y,
          ) - evidence.geometry.radius,
        );
        const metric = {
          value: Math.round(arrival ? arrival.gap / map.gameClockRate : clearance),
          unit: arrival ? "ms" : "px",
        };
        winner.metric = metric;
        winner.briefDetail = { phrase: arrival?.phrase ?? "Cursor outside at tap", metric };
      }
      if (decision.channel === "cursor" && decision.rule === "shared-best-window-tolerance") {
        const metric = {
          value: Math.round((decision.cursorTolerance! * best) / map.gameClockRate),
          unit: "ms",
        };
        winner.metric = metric;
        winner.briefDetail = { phrase: "300 window left uncovered", metric };
      }
    }
    for (const candidate of candidates.filter((c) => c.inputIds.length === 1 && c.inputIds[0] === inputId)) {
      candidate.recordedFailure = recordedAttributionFailure(
        evidence,
        trace,
        inputId,
        candidate.geometryWitnessEventIds ?? candidate.eventIds,
        excluded,
      );
      candidate.attribution = attribution;
      candidate.observationOnly = observationOnly;
    }
  }
  return rankAttributionCandidates(candidates, inputIds, pressDecisions);
}

/** Certify the already selected verdict, never its alternatives. Admission of
 * an uncertified observation uses the caller's unchanged v22 completeness. */
export function certifyPrimaryAttribution(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  ranking: AttributionRanking,
  complete: boolean,
  excluded: ReadonlySet<string> = new Set(),
): AttributionRanking {
  const proposed = ranking.selected;
  const originalDecisions = new Map(
    proposed.flatMap((c) =>
      c.attribution ? [[JSON.stringify({ ...c.attribution }), c.attribution] as const] : [],
    ),
  );
  for (const candidate of proposed) {
    const decision = candidate.attribution;
    if (!decision || !evidence.target) continue;
    const tapping = candidate.family === "timing";
    const tapContacts = decision.grazeTapAvailable
      ? [...decision.passes, ...(decision.grazes ?? []).filter(isBeatContainingGraze)]
      : decision.passes;
    const samples = tapping
      ? evidence.inputs
          .filter(
            (i) =>
              i.inside &&
              !i.postTerminal &&
              tapContacts.some(pass => i.record.timeMs - evidence.target!.hitTimeMs >= pass.entryMs &&
                i.record.timeMs - evidence.target!.hitTimeMs <= pass.exitMs) &&
              Math.abs(i.record.timeMs - evidence.target!.hitTimeMs) <= decision.bestWindowMs,
          )
          .map((i) => i.record.id)
      : [decision.inputId];
    const result = inspectPrimaryOpportunity(
      evidence,
      map,
      trace,
      decision.inputId,
      samples,
      tapping ? "sampled-pass-tap" : "same-time-aim",
      candidate.geometryWitnessEventIds ?? candidate.eventIds,
      excluded,
    );
    const proof = tapping
      ? result.proof
      : validAimProof(
          result.proof,
          decision.inputId,
          evidence.target.hitTimeMs + decision.tapOffsetMs,
          evidence.targetId,
        );
    candidate.observationOnly = !proof;
    if (proof) {
      candidate.support = {
        correction: proof,
        hypothesisIds: candidate.hypothesisIds,
        ...candidate.roleEvidence,
      };
      const reference = {
        kind: proof.kind,
        inputId: proof.inputId,
        sampleId: proof.sampleId,
        timeMs: proof.timeMs,
      };
      if (tapping) decision.tapCorrection = reference;
      else decision.aimCorrection = reference;
    } else candidate.support = undefined;
    (decision.certification ??= []).push({
      code: candidate.code,
      channel: tapping ? "tapping" : "cursor",
      status: proof ? "certified" : "observation-only",
      refusals: proof ? [] : result.refusals,
    });
    decision.observationOnly = decision.certification.some((c) => c.status === "observation-only");
    decision.feasibilityStatus = decision.observationOnly ? "observation-only" : "certified";
  }
  const selected = proposed.filter((c) => !c.observationOnly || (complete && !c.requiresCertificate));
  const attribution = ranking.attribution && {
    ...ranking.attribution,
    presses: ranking.attribution.presses.map((p) => {
      const decision = originalDecisions.get(JSON.stringify(p));
      return decision ? { ...decision } : p;
    }),
  };
  return {
    ...ranking,
    attribution,
    proposed,
    selected,
    observationComplete: complete,
    reason: proposed.length && !selected.length ? "incomplete-primary-observation" : ranking.reason,
  };
}

function independentPair(a: PrimaryCandidate, b: PrimaryCandidate) {
  const families = new Set([a.family, b.family]);
  return (
    families.has("placement") &&
    families.has("timing") &&
    a.independent &&
    b.independent &&
    a.relationId !== b.relationId &&
    compatibleAssignments(a, b)
  );
}

function compatibleAssignments(a: PrimaryCandidate, b: PrimaryCandidate) {
  const left = a.hypothesisIds ?? a.support?.hypothesisIds;
  const right = b.hypothesisIds ?? b.support?.hypothesisIds;
  return (!left && !right) || !!left?.some((id) => right?.includes(id));
}

/** Select an attempt from positive role evidence; numerical departures never
 * choose a press. Keep both measured role rules for sensitivity reporting. */
export function rankAttributionCandidates(
  original: readonly PrimaryCandidate[],
  inputs?: readonly string[],
  additionalPresses: readonly PressAttribution[] = [],
): AttributionRanking {
  const candidates = [...original],
    comparisonInputIds = unique(inputs ?? candidates.flatMap((c) => c.inputIds));
  const base: AttributionRanking = {
    selected: [],
    candidates,
    comparisonInputIds,
    comparisonEventIds: unique(candidates.flatMap((c) => c.eventIds)),
    scores: [],
    reason: "attribution-feasibility-unavailable",
  };
  if (
    candidates.length > PRIMARY_DIAGNOSIS_POLICY.maximumCandidates ||
    comparisonInputIds.length > PRIMARY_DIAGNOSIS_POLICY.maximumInputs
  )
    return { ...base, reason: "primary-candidate-limit" };
  // This cache lives only for this pure ranking call. Facts may be changed by
  // callers between calls, so no key is retained across comparisons.
  const decisionKeys = new Map<PressAttribution, string>();
  const decisionKey = (decision: PressAttribution) => {
    let key = decisionKeys.get(decision);
    if (key === undefined) {
      key = JSON.stringify({ ...decision });
      decisionKeys.set(decision, key);
    }
    return key;
  };
  const decisions = [
    ...new Map(
      [...additionalPresses, ...candidates.flatMap((c) => (c.attribution ? [c.attribution] : []))].map(
        (d) => [decisionKey(d), d],
      ),
    ).values(),
  ];
  if (!decisions.length) return base;
  const eligible = decisions.filter((d) => !d.recordedFailure &&
    (d.tapFeasible || d.aimFeasible || d.rule === "no-observed-departure"));
  const roleIds = unique(
    candidates.flatMap((c) =>
      (c.roleEvidence?.context ?? c.support?.context)?.role === "cadence-continuation" ||
      (c.roleEvidence?.bestWindowAim ?? c.support?.bestWindowAim)?.role === "best-window-aim" ||
      (c.roleEvidence?.aimOpportunity ?? c.support?.aimOpportunity)?.role === "initial-best-window"
        ? c.inputIds
        : [],
    ),
  );
  const contextualInputId =
    roleIds.length === 1 && eligible.some((d) => d.inputId === roleIds[0]) ? roleIds[0] : undefined;
  const nearestInputId = [...eligible].sort(
    (a, b) => Math.abs(a.tapOffsetMs) - Math.abs(b.tapOffsetMs) || a.sourceSequence - b.sourceSequence,
  )[0]?.inputId;
  const eligibleIds = unique(eligible.map((d) => d.inputId));
  const chosenInputId = roleIds.length > 1 ? undefined : contextualInputId ?? nearestInputId;
  const rule =
    roleIds.length > 1
      ? "conflicting-contextual-roles"
      : contextualInputId
      ? "witnessed-contextual-attempt"
      : chosenInputId
      ? "nearest-recorded-opportunity"
      : "attempt-role-unresolved";
  const rawDecisions = candidates
    .filter(
      (c) =>
        c.inputIds[0] === chosenInputId &&
        (c.hypothesisIds ?? c.support?.hypothesisIds)?.includes("raw-context") &&
        c.attribution?.selectedCodes.includes(c.code),
    )
    .map((c) => c.attribution!);
  // The complete recorded sequence precedes optional allocation variants. A
  // certificate never chooses the variant, press, channel or description.
  const variants = rawDecisions.length
    ? [...new Set(rawDecisions)]
    : eligible.filter((d) => d.inputId === chosenInputId);
  const samePress = variants.every(
    (d) => d.tapOffsetMs === variants[0].tapOffsetMs && d.sourceSequence === variants[0].sourceSequence,
  );
  const chosen = samePress ? variants.slice(0, 1) : [];
  const chosenKeys = new Set(chosen.map(decisionKey));
  const chosenWitness = (c: PrimaryCandidate) =>
    !!c.attribution && chosenKeys.has(decisionKey(c.attribution));
  const selectedCodes = unique(chosen.flatMap((d) => d.selectedCodes));
  // Different recorded allocations may support a broader established label;
  // they do not create a new subtype or a second independent mistake.
  const agreed =
    chosen.length && chosen.every((d) => d.selectedCodes.join("|") === chosen[0].selectedCodes.join("|"));
  const selected = agreed
    ? chosen[0].selectedCodes.flatMap((code) => {
        const witnesses = candidates.filter(
          (c) =>
            !c.recordedFailure &&
            c.inputIds.length === 1 &&
            c.inputIds[0] === chosenInputId &&
            c.code === code &&
            c.attribution?.selectedCodes.includes(code) &&
            chosenWitness(c),
        );
        const witness = witnesses.find((c) => c.briefDetail) ?? witnesses[0];
        return witness ? [witness] : [];
      })
    : chosen.every((d) => d.channel === "cursor") && selectedCodes.includes("misaim")
    ? candidates
        .filter(
          (c) =>
            c.code === "misaim" &&
            c.inputIds[0] === chosenInputId &&
            c.attribution?.selectedCodes.includes("misaim") &&
            chosenWitness(c),
        )
        .slice(0, 1)
    : [];
  // A second mistake needs its own complete passage and independent departure.
  // The primary attempt was already chosen by role, never by these magnitudes.
  const primary = selected.length === 1 ? selected[0] : undefined;
  if (primary?.family === "timing" && primary.independent && primary.timingPass) {
    const coherentPass = (inputId: string) => {
      const witnesses = candidates.filter(
        (c) => c.inputIds.length === 1 && c.inputIds[0] === inputId && c.family === "timing",
      );
      const pass = witnesses[0]?.timingPass;
      return pass &&
        witnesses.every(
          (c) =>
            c.independent &&
            c.timingPass?.entryTimeMs === pass.entryTimeMs &&
            c.timingPass?.exitTimeMs === pass.exitTimeMs,
        )
        ? pass
        : undefined;
    };
    const primaryPass = coherentPass(chosenInputId!);
    const independent = eligibleIds
      .filter((id) => id !== chosenInputId)
      .flatMap((id) => {
        const alternatives = eligible.filter((d) => d.inputId === id);
        const pass = coherentPass(id);
        if (
          !primaryPass ||
          !pass ||
          !(primaryPass.exitTimeMs < pass.entryTimeMs || pass.exitTimeMs < primaryPass.entryTimeMs) ||
          !alternatives.every(
            (d) =>
              d.channel === "tapping" &&
              d.selectedCodes.length === 1 &&
              d.selectedCodes[0] === alternatives[0].selectedCodes[0],
          )
        )
          return [];
        const alternativeKeys = new Set(alternatives.map(decisionKey));
        const witness = candidates.find(
          (c) =>
            !c.recordedFailure &&
            c.inputIds.length === 1 &&
            c.inputIds[0] === id &&
            c.code === alternatives[0].selectedCodes[0] &&
            c.attribution &&
            alternativeKeys.has(decisionKey(c.attribution)) &&
            c.attribution.channel === "tapping" &&
            c.attribution.selectedCodes.includes(c.code),
        );
        if (!witness || !primary.attribution || !compatibleAssignments(primary, witness)) return [];
        const larger = Math.max(primary.attribution.tapTolerance, witness.attribution!.tapTolerance);
        const smaller = Math.min(primary.attribution.tapTolerance, witness.attribution!.tapTolerance);
        return smaller >= larger * PRIMARY_DIAGNOSIS_POLICY.nearTieRatio &&
          larger - smaller <= PRIMARY_DIAGNOSIS_POLICY.nearTieDifference
          ? [witness]
          : [];
      });
    if (independent.length === 1) selected.push(independent[0]);
  }
  for (const c of selected)
    base.scores.push({
      code: c.code,
      inputs: [
        {
          inputId: c.attribution!.inputId,
          strength: c.family === "timing" ? c.attribution!.tapTolerance : c.attribution!.cursorTolerance ?? 0,
        },
      ],
    });
  return {
    ...base,
    selected,
    reason: selected.length
      ? chosen[0].rule
      : chosen.some(d => d.rule === "no-observed-departure")
      ? "no-observed-departure"
      : decisions.every((d) => d.rule === "joint-failure")
      ? "joint-failure"
      : chosen.length
      ? "selected-recorded-description-unavailable"
      : rule,
    attribution: {
      version: "recorded-correct-play-v4",
      presses: decisions.map((d) => ({ ...d })),
      roles: {
        nearestInputId,
        contextualInputId,
        chosenInputId,
        rule,
        disagreement: !!nearestInputId && !!contextualInputId && nearestInputId !== contextualInputId,
      },
      crossUnitDecisions: 0,
    },
  };
}

/** A witnessed upstream loss precedes a failed recovery. The caller proves
 * that chain; this adapter only arbitrates the retained descriptions. */
export function rankInitiatingAndRecovery(
  root: readonly PrimaryCandidate[],
  recovery: AttributionRanking,
  inputIds: readonly string[],
): AttributionRanking {
  const candidates = [...root, ...recovery.candidates];
  const selected = [...root];
  const first = root.length === 1 ? root[0] : undefined;
  const later = recovery.selected.length === 1 ? recovery.selected[0] : undefined;
  const distinctTiming =
    first?.family === "timing" &&
    later?.family === "timing" &&
    first.independent &&
    later.independent &&
    compatibleAssignments(first, later) &&
    first.timingPass &&
    later.timingPass &&
    first.timingPass.exitTimeMs < later.timingPass.entryTimeMs;
  if (distinctTiming && first?.attribution && later?.attribution) {
    const larger = Math.max(first.attribution.tapTolerance, later.attribution.tapTolerance);
    const smaller = Math.min(first.attribution.tapTolerance, later.attribution.tapTolerance);
    if (
      smaller >= larger * PRIMARY_DIAGNOSIS_POLICY.nearTieRatio &&
      larger - smaller <= PRIMARY_DIAGNOSIS_POLICY.nearTieDifference
    )
      selected.push(later);
  }
  return {
    selected,
    candidates,
    comparisonInputIds: unique(inputIds),
    comparisonEventIds: unique(candidates.flatMap((c) => c.eventIds)),
    scores: [],
    reason:
      selected.length > root.length
        ? "initiating-and-independent-recovery"
        : "initiating-loss-before-failed-recovery",
  };
}

/** Collective cadence is observation-only. Keep its domain proof in its
 * handler, while removing distance-versus-timing arithmetic here. */
export function selectCadenceAttribution<T extends { code: string }>(
  cadence: T,
  cadenceEligible: boolean,
  approaches: AttributionRanking,
  chain: readonly PrimaryCandidate[] = [],
): { selected: Array<T | PrimaryCandidate>; reason: string; observationOnly: boolean } {
  const certifiedChain = chain.filter((c) => c.support && !c.observationOnly);
  const certifiedApproaches = approaches.selected.filter((c) => c.support && !c.observationOnly);
  if (certifiedChain.length)
    return { selected: certifiedChain, reason: "certified-initiating-cause", observationOnly: false };
  if (certifiedApproaches.length)
    return {
      selected: certifiedApproaches,
      reason: "certified-approach-before-cadence-observation",
      observationOnly: false,
    };
  if (!cadenceEligible)
    return {
      selected: chain.length ? [...chain] : approaches.selected,
      reason: "cadence-flow-inapplicable",
      observationOnly: true,
    };
  const conflictingCursor = [...chain, ...approaches.selected].some((c) => c.family !== "timing");
  if (conflictingCursor)
    return { selected: [], reason: "cadence-and-cursor-observations-unordered", observationOnly: true };
  return { selected: [cadence], reason: "observed-target-cadence", observationOnly: true };
}
