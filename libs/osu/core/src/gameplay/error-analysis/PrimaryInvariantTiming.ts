import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { PrimaryApproachEpisode } from "./PrimaryApproach";
import { PrimaryCandidate } from "./PrimaryDiagnosisPolicy";

export interface PrimaryAllocationHypothesis {
  inputIds: string[];
  contextInputIds: string[];
  approachVariantIds: number[];
  candidateIds: number[];
  complete: boolean;
  primaryCodes: string[];
  scores: Array<{ code: string; strength: number }>;
  limitations: string[];
}

const ids = (values: readonly string[]) => [...new Set(values)].sort();
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** This certificate concerns an invariant positive fact, not completeness of
 * every optional mistake. An unclassified optional press is never harmless by
 * implication, and contributes zero *supported-code* weight only. */
export function certifyInvariantMandatoryTiming(
  evidence: CircleEvidence,
  mandatory: readonly string[],
  optional: readonly string[],
  hypotheses: readonly PrimaryAllocationHypothesis[],
  episodes: readonly PrimaryApproachEpisode[],
  candidates: readonly PrimaryCandidate[],
  selected: readonly PrimaryCandidate[],
) {
  if (
    !mandatory.length ||
    !optional.length ||
    hypotheses.length !== optional.length + 1 ||
    selected.length !== 1 ||
    evidence.status !== "supported" ||
    evidence.limits.truncated ||
    evidence.inputs.length > 4096 ||
    Object.values(evidence.dependencies).some((d) => d.status !== "complete") ||
    !hypotheses[0].complete ||
    hypotheses[0].inputIds.length !== mandatory.length ||
    !mandatory.every((id) => hypotheses[0].inputIds.includes(id))
  )
    return;
  const primary = selected[0];
  if (
    primary.family !== "timing" ||
    !primary.independent ||
    !["early-tap", "late-tap"].includes(primary.code) ||
    !(primary.strength > 0)
  )
    return;

  // Source completeness is local. Session parser warnings outside this evidence
  // are deliberately not a veto. Check actions and raw adjacency as well as the
  // parsed sequence: a gap must not turn a censored optional episode into zero.
  for (let k = 0; k < evidence.inputs.length; k++) {
    const item = evidence.inputs[k],
      r = item.record,
      s = r.source,
      p = evidence.inputs[k - 1]?.record;
    if (
      !item.freshActionsKnown ||
      s.origin !== "parsed" ||
      s.discontinuityBefore?.length ||
      !Number.isSafeInteger(s.parsedFrameIndex) ||
      s.parsedFrameIndex < 0 ||
      (s.rawTokenIndex !== undefined && (!Number.isSafeInteger(s.rawTokenIndex) || s.rawTokenIndex < 0)) ||
      ![r.timeMs, r.position.x, r.position.y].every(Number.isFinite) ||
      !Number.isSafeInteger(r.sequence) ||
      r.sequence < 0 ||
      [r.actions, r.previousActions, r.freshActions].some(
        (a) => a.some((x) => x !== 0 && x !== 1) || new Set(a).size !== a.length,
      ) ||
      !same(
        r.freshActions,
        r.actions.filter((a) => !r.previousActions.includes(a)),
      ) ||
      (r.rawButtonMask !== undefined &&
        (!Number.isSafeInteger(r.rawButtonMask) ||
          r.rawButtonMask < 0 ||
          !!(r.rawButtonMask & 5) !== r.actions.includes(0) ||
          !!(r.rawButtonMask & 10) !== r.actions.includes(1)))
    )
      return;
    if (
      p &&
      (p.source.origin !== "parsed" ||
        s.parsedFrameIndex !== p.source.parsedFrameIndex + 1 ||
        r.sequence <= p.sequence ||
        r.timeMs < p.timeMs ||
        !same(r.previousActions, p.actions) ||
        (r.timeMs === p.timeMs && (r.position.x !== p.position.x || r.position.y !== p.position.y)) ||
        ((s.rawTokenIndex !== undefined || p.source.rawTokenIndex !== undefined) &&
          (!Number.isSafeInteger(p.source.rawTokenIndex) || s.rawTokenIndex !== p.source.rawTokenIndex! + 1)))
    )
      return;
  }

  const unresolved = new Set<string>();
  for (const h of hypotheses) {
    if (
      h.approachVariantIds.length !== h.inputIds.length ||
      h.limitations.some((l) => l !== "no-positive-local-placement")
    )
      return;
    for (const id of h.inputIds) {
      const episode = h.approachVariantIds.map((k) => episodes[k]).find((e) => e?.inputId === id);
      if (!episode || episode.status !== "supported") return;
      const positive = h.candidateIds.some((k) => candidates[k]?.inputIds.includes(id));
      if (positive) {
        if (episode.limitations.length) return;
      } else {
        if (
          !optional.includes(id) ||
          episode.limitations.length !== 1 ||
          episode.limitations[0] !== "no-positive-local-placement" ||
          episode.placement !== "unproven" ||
          episode.contacts.length ||
          episode.properPass ||
          episode.landing ||
          episode.deadlineArrival ||
          episode.spatialCandidates.length ||
          episode.timingIndependent ||
          episode.eventIds.length < 3
        )
          return;
        unresolved.add(id);
      }
    }
  }
  if (!unresolved.size) return;

  const eventIds: string[] = [],
    witnesses: Array<{ inputId: string; candidateIds: number[]; approachVariantIds: number[] }> = [];
  for (const id of mandatory) {
    let semanticKey: string | undefined;
    const witness = { inputId: id, candidateIds: [] as number[], approachVariantIds: [] as number[] };
    for (const h of hypotheses) {
      const candidateIds = h.candidateIds.filter(
        (k) => candidates[k]?.code === primary.code && candidates[k]?.inputIds.includes(id),
      );
      const episodeIds = h.approachVariantIds.filter((k) => episodes[k]?.inputId === id);
      if (candidateIds.length !== 1 || episodeIds.length !== 1) return;
      const c = candidates[candidateIds[0]],
        e = episodes[episodeIds[0]],
        pass = e.properPass;
      if (
        !c.independent ||
        c.family !== "timing" ||
        c.inputIds.length !== 1 ||
        !(c.strength > 0) ||
        e.placement !== "proper-pass" ||
        !e.timingIndependent ||
        e.limitations.length ||
        !pass ||
        pass.leftCensored ||
        pass.rightCensored ||
        !["sampled", "reconstructed-coherent"].includes(pass.placementSupport)
      )
        return;
      // Context grows/shrinks with optional allocations. Compare the actual
      // supporting passage and proof IDs, never the whole episode's context IDs.
      const proof = {
        ...pass,
        eventIds: ids(pass.eventIds),
        sampledEventIds: ids(pass.sampledEventIds),
        ...(pass.headingBand ? { headingBand: { ...pass.headingBand, eventIds: ids(pass.headingBand.eventIds) } } : {}),
        ...(pass.curvedHeadingEnvelope
          ? {
              curvedHeadingEnvelope: {
                ...pass.curvedHeadingEnvelope,
                eventIds: ids(pass.curvedHeadingEnvelope.eventIds),
              },
            }
          : {}),
      };
      const key = JSON.stringify({
        code: c.code,
        family: c.family,
        strength: c.strength,
        independent: c.independent,
        relationId: c.relationId,
        inputIds: ids(c.inputIds),
        eventIds: ids(c.eventIds),
        placement: e.placement,
        relation: e.relation,
        timingIndependent: e.timingIndependent,
        pass: proof,
      });
      if (semanticKey !== undefined && key !== semanticKey) return;
      semanticKey = key;
      witness.candidateIds.push(candidateIds[0]);
      witness.approachVariantIds.push(episodeIds[0]);
      eventIds.push(
        ...c.eventIds,
        ...pass.eventIds,
        ...pass.sampledEventIds,
        ...(pass.headingBand?.eventIds ?? []),
        ...(pass.curvedHeadingEnvelope?.eventIds ?? []),
      );
    }
    witnesses.push(witness);
  }
  return {
    basis: "invariant-mandatory-timing" as const,
    code: primary.code,
    mandatoryInputIds: ids(mandatory),
    unresolvedOptionalInputIds: ids([...unresolved]),
    minimumSupport: primary.strength,
    witnesses,
    eventIds: ids(eventIds),
  };
}
