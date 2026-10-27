import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import type { CircleMechanism } from "./CircleMechanisms";
import { errorCapabilities } from "./ErrorCapabilities";
import { derivePrimaryInputEvidence } from "./PrimaryInputEvidence";
import { analyzePrimaryApproaches } from "./PrimaryApproach";
import {
  PRIMARY_DIAGNOSIS_POLICY,
  rankPrimaryCandidates,
  rankSupportedPrimaryCandidates,
} from "./PrimaryDiagnosisPolicy";
import { comparePrimaryApproaches, comparePrimaryInputHypotheses } from "./PrimaryApproachComparison";
import { deriveInitiatingChain, InitiatingChain } from "./InterceptionChain";
import { deriveRejectedPlacementChain } from "./RejectedPlacementChain";
import { derivePairedCapacityChain } from "./PairedCapacityChain";
import { cadenceFlowApplicable, deriveTargetCadence } from "./StreamCadenceEvidence";
import { compareTargetCadence } from "./PrimaryCadenceComparison";
import { deriveTargetLocalArrival, TargetLocalArrival } from "./TargetLocalArrival";
import {
  deriveReceiverRejectionConsequence,
  ReceiverRejectionConsequence,
} from "./ReceiverRejectionConsequence";
import { deriveAnchoredTimingDrift } from "./AnchoredTimingDrift";
import { deriveLateSequenceContinuation } from "./LateSequenceContinuation";
import { deriveLateReceptorSequence } from "./LateReceptorSequence";
import { deriveLateCapacityRecovery } from "./LateCapacityRecovery";
import { deriveUpstreamLateArrival } from "./UpstreamLateArrival";
import { deriveReconstructedSharedPass } from "./ReconstructedSharedPass";
import { certifyPrimaryAttribution } from "./PrimaryAttribution";

export interface PrimaryCircleDiagnostics {
  contestedPress?: { inputId?: string; contested: boolean; nearestForOtherTargetIds: string[] };
  policy: typeof PRIMARY_DIAGNOSIS_POLICY;
  association: ReturnType<typeof derivePrimaryInputEvidence>;
  observedMechanism: { codes: string[]; headline: string; eventIds: string[] };
  approaches?: ReturnType<typeof analyzePrimaryApproaches>;
  ranking?: ReturnType<typeof rankPrimaryCandidates>;
  phaseComparison?: {
    inputIds: string[];
    approaches: ReturnType<typeof analyzePrimaryApproaches>;
    correctionComparison?: ReturnType<typeof comparePrimaryApproaches>;
    reason: string;
  };
  routingWithoutOwnership?: { inputIds: string[]; policyEventIds: string[]; reason: string };
  directRejections?: CircleEvidence["directRejections"];
  initiatingChain?: InitiatingChain;
  inputHypotheses?: { inputIds: string[]; reason: string };
  cadenceComparison?: ReturnType<typeof compareTargetCadence>;
  allocationComparison?: ReturnType<typeof comparePrimaryInputHypotheses>;
  targetLocalArrival?: TargetLocalArrival;
  receiverConsequence?: ReceiverRejectionConsequence;
  timingDrift?: ReturnType<typeof deriveAnchoredTimingDrift>;
  upstreamArrival?: ReturnType<typeof deriveUpstreamLateArrival>;
  reconstructedPass?: ReturnType<typeof deriveReconstructedSharedPass>;
  lateSequence?:
    | ReturnType<typeof deriveLateSequenceContinuation>
    | ReturnType<typeof deriveLateReceptorSequence>
    | ReturnType<typeof deriveLateCapacityRecovery>;
  unconsumedContextComparison?: {
    inputIds: string[];
    comparison: ReturnType<typeof comparePrimaryApproaches>;
    ranking: ReturnType<typeof rankSupportedPrimaryCandidates>;
    basis: "usable-correction-with-inferred-neighbour-claim";
  };
  rawOpportunityComparison?: {
    inputIds: string[];
    comparison: ReturnType<typeof comparePrimaryApproaches>;
    ranking: ReturnType<typeof rankPrimaryCandidates>;
    basis: "strongest-raw-evidence-with-usable-correction";
  };
}

/** Direct mechanisms remain separate from inferred input attribution and coaching comparisons. */
export function primaryCircleDiagnosis(
  evidence: CircleEvidence,
  map: Beatmap,
  observed: CircleMechanism,
  trace?: ReplayTrace,
  excludedComponentIds?: ReadonlySet<string>,
): CircleMechanism {
  const finalize = (mechanism: CircleMechanism): CircleMechanism => {
    const p = mechanism.diagnostics?.primary;
    if (!p) return mechanism;
    const container = [p.rawOpportunityComparison, p.unconsumedContextComparison, p].find(
      (c) =>
        c?.ranking?.attribution &&
        JSON.stringify(c.ranking.selected.map((x) => x.code)) === JSON.stringify(mechanism.codes),
    );
    if (!container?.ranking?.selected.length) return mechanism;
    const ranked = certifyPrimaryAttribution(
      evidence,
      map,
      trace,
      container.ranking,
      container.ranking.observationComplete === true,
      excludedComponentIds,
    );
    const originalRanking = container.ranking;
    container.ranking = ranked;
    for (const compared of [
      p.rawOpportunityComparison?.comparison,
      p.unconsumedContextComparison?.comparison,
      p.phaseComparison?.correctionComparison,
      p.allocationComparison,
    ])
      if (compared?.ranking === originalRanking) compared.ranking = ranked as typeof compared.ranking;
    const selected = ranked.selected,
      single = selected.length === 1 ? selected[0] : undefined;
    return {
      ...mechanism,
      status: selected.length ? "supported" : "unavailable",
      codes: selected.map((c) => c.code),
      headline: selected.map((c) => c.headline).join(" · "),
      description: selected.length ? mechanism.description : "",
      metric: single?.metric,
      briefDetail: single?.briefDetail,
    };
  };
  const scoped = scopedPrimaryCircleDiagnosis(evidence, map, observed, trace, excludedComponentIds),
    primary = scoped.diagnostics?.primary;
  const scopedRanking = primary?.unconsumedContextComparison?.ranking ?? primary?.ranking;
  const ordinary =
    scopedRanking?.attribution &&
    JSON.stringify(scopedRanking.selected.map((c) => c.code)) === JSON.stringify(scoped.codes);
  if (
    scopedRanking?.reason === "no-observed-departure" ||
    (scoped.status === "supported" && (!ordinary || scopedRanking?.observationComplete)) ||
    !primary ||
    !trace ||
    evidence.terminal?.mechanism !== "automatic-expiry" ||
    evidence.terminal.result !== "MISS"
  )
    return finalize(scoped);
  // Inferred sequence ownership can omit a later usable opportunity or fence
  // off its motion. Compare the complete raw live sequence without rewriting
  // any receipt or ownership claim. Keep every competing geometric candidate;
  // merely being the first repair that works cannot make it dominant.
  const inputIds = evidence.inputs
    .filter(
      (i) => i.inLiveSuccess && !i.postTerminal && i.freshActionsKnown && i.record.freshActions.length === 1,
    )
    .map((i) => i.record.id);
  if (!inputIds.length) return finalize(scoped);
  const comparison = comparePrimaryApproaches(
      evidence,
      map,
      { pressIds: inputIds },
      trace,
      excludedComponentIds,
      true,
    ),
    ranking = comparison.ranking,
    selected = ranking.selected,
    diagnostics = {
      ...scoped.diagnostics,
      opportunities: scoped.diagnostics?.opportunities ?? [],
      primary: {
        ...primary,
        rawOpportunityComparison: {
          inputIds,
          comparison,
          ranking,
          basis: "strongest-raw-evidence-with-usable-correction" as const,
        },
      },
    };
  const reconstructedPass = deriveReconstructedSharedPass(
    evidence,
    map,
    trace,
    comparison,
    excludedComponentIds,
  );
  if (reconstructedPass)
    return {
      ...scoped,
      status: "supported",
      codes: ["off-beat"],
      headline: "Off beat",
      description: "Both presses straddled the same on-time movement passage.",
      metric: undefined,
      briefDetail: { phrase: "Taps straddled the passage" },
      eventIds: [evidence.terminal.id, ...reconstructedPass.eventIds],
      limitations: [...scoped.limitations, "declared-linear-timing-control-not-recorded-input"],
      diagnostics: { ...diagnostics, primary: { ...diagnostics.primary, reconstructedPass } },
    };
  // Keep one diagnostic and request one certificate when raw expansion has
  // reproduced the exact scoped facts, candidates and role decision. Compare
  // the entire recorded ranking so different geometry scopes cannot alias.
  if (ordinary && JSON.stringify(scopedRanking) === JSON.stringify(ranking)) return finalize(scoped);
  if (ranking.reason === "no-observed-departure")
    return finalize({ ...scoped, diagnostics, status: "unavailable", codes: [], headline: "", description: "", metric: undefined, briefDetail: undefined });
  if (!selected.length) return finalize({ ...scoped, diagnostics });
  const single = selected.length === 1 ? selected[0] : undefined;
  return finalize({
    ...scoped,
    status: "supported",
    codes: selected.map((c) => c.code),
    headline: selected.map((c) => c.headline).join(" · "),
    description: single
      ? single.headline + " in the relevant approach."
      : "Distinct supported errors occurred during the approach.",
    metric: single?.metric,
    briefDetail: single?.briefDetail,
    eventIds: [
      ...new Set([
        evidence.terminal.id,
        ...ranking.comparisonEventIds,
        ...selected.flatMap(
          (c) =>
            c.support?.correction?.eventIds ??
            c.support?.compound?.eventIds ??
            c.support?.sharedPass?.corrections.flatMap((p) => p.eventIds) ??
            [],
        ),
      ]),
    ],
    limitations: [...scoped.limitations, "raw-opportunity-comparison-not-intended-ownership"],
    diagnostics,
  });
}

function scopedPrimaryCircleDiagnosis(
  evidence: CircleEvidence,
  map: Beatmap,
  observed: CircleMechanism,
  trace?: ReplayTrace,
  excludedComponentIds?: ReadonlySet<string>,
): CircleMechanism {
  const { target, geometry, terminal } = evidence;
  if (!target || !geometry || !terminal) return observed;
  const capability = errorCapabilities(map, evidence.identity.analysisProfileId);
  if (capability.tapping !== "manual" || capability.aim !== "manual") return observed;
  const association = derivePrimaryInputEvidence(evidence, map, trace, excludedComponentIds);
  const baseDiagnostics = {
    ...observed.diagnostics,
    opportunities: observed.diagnostics?.opportunities ?? [],
    primary: {
      policy: PRIMARY_DIAGNOSIS_POLICY,
      association,
      observedMechanism: { codes: observed.codes, headline: observed.headline, eventIds: observed.eventIds },
      directRejections: evidence.directRejections,
    } as PrimaryCircleDiagnostics,
  };
  const result = (
    codes: string[],
    headline: string,
    eventIds: string[],
    extra: Partial<CircleMechanism> = {},
  ): CircleMechanism => ({
    ...observed,
    codes,
    headline,
    eventIds: [...new Set(eventIds)],
    diagnostics: baseDiagnostics,
    ...extra,
  });
  const invalidAssociation = association.limitations.filter(
    (reason) => reason === "trace-identity-mismatch" || reason === "invalid-trace-index",
  );
  if (invalidAssociation.length)
    return result([], "", [], {
      status: "unavailable",
      description: "",
      metric: undefined,
      briefDetail: undefined,
      limitations: [...new Set([...observed.limitations, ...invalidAssociation])],
    });
  // An otherwise-usable target rejection is direct model evidence even when
  // cadence owns its press elsewhere. It neither reassigns nor duplicates it.
  // The evidence extractor validates the complete local dispatch/lifecycle chain;
  // no complete-window absence or inferred phase is required for this positive fact.
  if (
    terminal.mechanism === "automatic-expiry" &&
    terminal.result === "MISS" &&
    evidence.directRejections.length
  ) {
    const witnesses = evidence.directRejections;
    return result(
      ["notelock"],
      "Notelock",
      witnesses.flatMap((w) => w.eventIds),
      {
        status: "supported",
        description: "The note order blocked an otherwise usable tap.",
        metric: undefined,
        briefDetail: undefined,
        limitations: [...observed.limitations, "routing-does-not-establish-intended-target"],
        diagnostics: {
          ...baseDiagnostics,
          primary: {
            ...baseDiagnostics.primary,
            routingWithoutOwnership: {
              inputIds: [...new Set(witnesses.map((w) => w.inputId))],
              policyEventIds: witnesses.map((w) => w.policyId),
              reason: "validated-direct-target-rejection-independent-of-rhythm-ownership",
            },
          },
        },
      },
    );
  }
  if (observed.status !== "supported") return observed;
  if (terminal.mechanism === "ordered-force-miss")
    return result(["out-of-order"], "Out of order", observed.eventIds);
  if (terminal.mechanism === "input-miss" || terminal.mechanism === "successful-input") {
    if (association.harmfulSurplus)
      return result(["extra-tap"], "Extra tap", [terminal.id, ...association.harmfulSurplus.eventIds], {
        description: "A surplus press ended this note before its later usable tap.",
        metric: undefined,
        briefDetail: { phrase: "An extra press came first" },
      });
    const terminalInputId = evidence.attempts.find(a => a.id === terminal.triggerAttemptId)?.inputId;
    const anotherRelevantPress = terminal.mechanism === "input-miss" && evidence.inputs.some(i =>
      i.record.id !== terminalInputId && association.relevantInputIds.includes(i.record.id) &&
      i.inLiveSuccess && !i.postTerminal && i.freshActionsKnown && i.record.freshActions.length > 0);
    if (!anotherRelevantPress) return {
        ...observed,
        diagnostics: baseDiagnostics,
        ...(observed.metric ? { briefDetail: { phrase: "", metric: observed.metric } } : {}),
      };
  }
  if (terminal.mechanism !== "automatic-expiry" && terminal.mechanism !== "input-miss") return observed;
  const upstreamArrival = trace && deriveUpstreamLateArrival(evidence, map, trace, excludedComponentIds);
  if (upstreamArrival)
    return result(["aim-late"], "Late entry", upstreamArrival.eventIds, {
      status: "supported",
      description: "Late aim on the preceding note consumed this note's later opportunity.",
      metric: undefined,
      briefDetail: undefined,
      limitations: [
        ...observed.limitations,
        "reconstructed-upstream-arrival-not-direct-target-rejection",
        "model-causal-chain-not-intent-proof",
      ],
      diagnostics: { ...baseDiagnostics, primary: { ...baseDiagnostics.primary, upstreamArrival } },
    });
  const initiatingChain =
    trace &&
    (deriveInitiatingChain(evidence, association, map, trace, excludedComponentIds) ??
      deriveRejectedPlacementChain(evidence, association, map, trace, excludedComponentIds) ??
      derivePairedCapacityChain(evidence, map, trace, excludedComponentIds));
  const receiverConsequence =
    trace && deriveReceiverRejectionConsequence(evidence, association, map, trace, excludedComponentIds);
  if (receiverConsequence)
    return result(
      ["notelock"],
      "Notelock",
      [...receiverConsequence.eventIds, ...(initiatingChain?.eventIds ?? [])],
      {
        status: "supported",
        description: "An earlier rejected tap left a note in the way of this opportunity.",
        metric: undefined,
        briefDetail: undefined,
        limitations: [
          ...observed.limitations,
          "reconstructed-receiver-consequence-not-direct-target-rejection",
          "model-causal-chain-not-intent-proof",
        ],
        diagnostics: {
          ...baseDiagnostics,
          primary: {
            ...baseDiagnostics.primary,
            ...(initiatingChain ? { initiatingChain } : {}),
            receiverConsequence,
          },
        },
      },
    );
  const cadence = trace && deriveTargetCadence(evidence, map, trace, excludedComponentIds);
  if (cadence) {
    const comparison = compareTargetCadence(evidence, map, association, cadence, initiatingChain),
      selected = comparison.selected;
    baseDiagnostics.primary.cadenceComparison = comparison;
    // Failed neighbouring-flow prerequisites make cadence inapplicable. Keep
    // its measured facts, then use the independently supported ordinary path.
    if (cadenceFlowApplicable(cadence)) {
      const phrase =
        selected[0]?.code === "slow-tapping"
          ? "Taps stayed slower than the notes"
          : "During the relevant approach";
      return result(
        selected.map((c) => c.code),
        selected.map((c) => c.headline).join(" · "),
        comparison.comparisonEventIds,
        {
          status: selected.length ? "supported" : "unavailable",
          description: selected.length ? phrase + "." : "",
          metric: undefined,
          briefDetail: selected.length ? { phrase } : undefined,
          limitations: [
            ...observed.limitations,
            "collective-cadence-not-unique-omission",
            ...(selected.length ? [] : [comparison.reason]),
          ],
          diagnostics: {
            ...baseDiagnostics,
            primary: {
              ...baseDiagnostics.primary,
              ...(initiatingChain ? { initiatingChain } : {}),
              cadenceComparison: comparison,
            },
          },
        },
      );
    }
  }
  const timingDrift = trace && deriveAnchoredTimingDrift(evidence, map, trace, excludedComponentIds);
  const lateSequence =
    !timingDrift &&
    trace &&
    (deriveLateSequenceContinuation(evidence, map, trace, excludedComponentIds) ??
      deriveLateReceptorSequence(evidence, map, trace, excludedComponentIds) ??
      deriveLateCapacityRecovery(evidence, map, trace, excludedComponentIds));
  if (lateSequence)
    return result(["late-tap"], "Late tap", lateSequence.eventIds, {
      status: "supported",
      description: "The established tapping cadence reached this note after its hit window.",
      metric: undefined,
      briefDetail: undefined,
      limitations: [
        ...observed.limitations,
        "bounded-sequence-control-not-intended-ownership",
        lateSequence.basis === "observed-preceding-drift-with-declared-capacity"
          ? "hypothetical-extra-capacity-not-observed-omission"
          : "related-successful-receipts-retimed",
      ],
      diagnostics: { ...baseDiagnostics, primary: { ...baseDiagnostics.primary, lateSequence } },
    });
  if (timingDrift)
    return result(["late-tap"], "Late tap", timingDrift.eventIds, {
      status: "supported",
      description: "The tapping sequence drifted later while the cursor stayed with the notes.",
      metric: undefined,
      briefDetail: { phrase: "Taps drifted late" },
      limitations: [...observed.limitations, "anchored-rhythm-not-intended-ownership"],
      diagnostics: {
        ...baseDiagnostics,
        primary: { ...baseDiagnostics.primary, timingDrift, ...(initiatingChain ? { initiatingChain } : {}) },
      },
    });
  if (initiatingChain) {
    const causes = initiatingChain.causes;
    const recoveryPrimary = initiatingChain.combinedRanking?.selected.some(
      (c) => !c.relationId.startsWith("initiating:"),
    );
    const phrase = recoveryPrimary
      ? "During the recovery"
      : "Following an earlier " + causes.map((c) => c.headline.toLowerCase()).join(" and ");
    return result(
      causes.map((c) => c.code),
      causes.map((c) => c.headline).join(" \u00b7 "),
      initiatingChain.eventIds,
      {
        status: "supported",
        description: phrase + ".",
        metric: undefined,
        briefDetail: { phrase },
        limitations: [
          ...observed.limitations,
          "inherited-initiating-error",
          "model-causal-chain-not-intent-proof",
        ],
        diagnostics: { ...baseDiagnostics, primary: { ...baseDiagnostics.primary, initiatingChain } },
      },
    );
  }
  const stream = association.stream;
  const activeAlternatives = stream?.phaseAlternatives?.filter((a) => a.active) ?? [];
  const sameInputSet = (a: readonly string[], b: readonly string[]) =>
    new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));
  // Distinct phase estimates do not create competing attribution when both
  // identify the same recorded actions. Keep them diagnostic and compare the
  // actual approach once with the ordinary scope/geometry safeguards below.
  const distinctPhaseInputs =
    stream && activeAlternatives.some((a) => !sameInputSet(a.targetInputIds, stream.relevantInputIds));
  if (stream && activeAlternatives.length && distinctPhaseInputs) {
    const inputIds = [
      ...new Set([...stream.relevantInputIds, ...activeAlternatives.flatMap((a) => a.targetInputIds)]),
    ];
    const inputs = evidence.inputs.filter((i) => inputIds.includes(i.record.id));
    // These are competing sequence hypotheses, never two independent causes.
    // Compare every live candidate. A shared timing diagnosis requires a proper
    // on-time passage and timing departure under *both* assignments.
    const fence = stream.relevantInputIds.map((id) => stream.inputScopes?.[id]?.placementEnd).find(Boolean);
    const scopes = fence
      ? Object.fromEntries(inputIds.map((id) => [id, { placementEnd: fence }]))
      : undefined;
    const approaches = analyzePrimaryApproaches(evidence, {
      pressIds: inputIds,
      // Only context shared by every hypothesis can bound the comparison.
      // An alternative input must not erase another candidate's circle passage.
      contextBoundaryInputIds: association.contextInputIds.filter((id) => !inputIds.includes(id)),
      inputScopes: scopes,
    });
    const valid =
      inputs.length === inputIds.length &&
      inputIds.length >= 2 &&
      !stream.limitations.includes("unresolved-stream-input") &&
      inputs.every(
        (i) =>
          i.inLiveSuccess &&
          !i.postTerminal &&
          i.freshActionsKnown &&
          i.record.freshActions.length &&
          !i.inside,
      ) &&
      approaches.episodes.length === inputIds.length &&
      approaches.episodes.every(
        (e) =>
          e.status === "supported" &&
          e.placement === "proper-pass" &&
          e.properPass &&
          !e.spatialCandidates.length &&
          Math.abs(e.pressOffsetMs) > geometry.hitWindows[0] &&
          !e.properPass.leftCensored &&
          !e.properPass.rightCensored &&
          e.properPass.entryTimeMs <= evidence.target!.hitTimeMs + geometry.hitWindows[0] &&
          e.properPass.exitTimeMs >= evidence.target!.hitTimeMs - geometry.hitWindows[0] &&
          (e.pressTimeMs < e.properPass.entryTimeMs || e.pressTimeMs > e.properPass.exitTimeMs),
      );
    const diagnostics: CircleMechanism["diagnostics"] = {
      ...baseDiagnostics,
      primary: {
        ...baseDiagnostics.primary,
        phaseComparison: {
          inputIds,
          approaches,
          reason: valid ? "timing-departure-under-every-live-phase" : "phase-cause-not-invariant",
        },
      },
    };
    // Geometric phase agreement remains an observation. The same press-bound
    // feasibility gate below is required before showing its timing diagnosis.
    // A phase disagreement is uncertainty about allocation, not a whole-target
    // evidence failure. Keep the common scope and all competitors, but allow
    // an independently usable correction to establish the coaching diagnosis.
    // Distinct phases are alternatives; never combine them as two mistakes.
    const correctionComparison = comparePrimaryApproaches(
      evidence,
      map,
      {
        pressIds: inputIds,
        contextBoundaryInputIds: association.contextInputIds.filter((id) => !inputIds.includes(id)),
        inputScopes: scopes,
      },
      trace,
      excludedComponentIds,
      true,
      true,
    );
    const ranking = correctionComparison.ranking;
    diagnostics.primary!.phaseComparison!.correctionComparison = correctionComparison;
    diagnostics.primary!.ranking = ranking;
    if (ranking.selected.length) {
      diagnostics.primary!.phaseComparison!.reason = "positive-correction-among-competing-phases";
      const selected = ranking.selected;
      return result(
        selected.map((c) => c.code),
        selected.map((c) => c.headline).join(" · "),
        [...new Set([terminal.id, ...inputIds, ...selected.flatMap((c) => c.eventIds)])],
        {
          status: "supported",
          description: "During the relevant approach.",
          metric: selected.length === 1 ? selected[0].metric : undefined,
          briefDetail: selected.length === 1 ? selected[0].briefDetail : undefined,
          limitations: [...observed.limitations, "stream-ownership-alternatives-compared"],
          diagnostics,
        },
      );
    }
    return result([], "", [], {
      status: "unavailable",
      description: "",
      metric: undefined,
      briefDetail: undefined,
      diagnostics,
      limitations: [...observed.limitations, "ambiguous-stream-phase-cause"],
    });
  }
  const uncertainIds = association.associations.filter((a) => a.role === "ambiguous").map((a) => a.inputId);
  const competingOtherOwners = stream?.assignments.some(
    (a) =>
      uncertainIds.includes(a.inputId ?? "") &&
      a.competingClaims?.length &&
      a.competingClaims.every((c) => c.componentId !== evidence.targetId),
  );
  if (competingOtherOwners)
    return result([], "", [], {
      status: "unavailable",
      description: "",
      metric: undefined,
      briefDetail: undefined,
      limitations: [...observed.limitations, ...(stream?.limitations ?? []), "competing-other-input-claims"],
    });
  const relevant = evidence.inputs.filter(
    (item) =>
      (association.relevantInputIds.includes(item.record.id) || uncertainIds.includes(item.record.id)) &&
      item.inLiveSuccess &&
      !item.postTerminal,
  );
  if (!relevant.length) {
    if (association.associations.some((a) => a.role === "ambiguous"))
      return {
        ...observed,
        status: "unavailable",
        codes: [],
        headline: "",
        description: "",
        diagnostics: baseDiagnostics,
        limitations: [...observed.limitations, "ambiguous-target-input"],
      };
    // Absence needs complete raw actions, or a positively bracketed missing
    // cadence slot. Holding is not an explanation and filtering is not proof.
    const rawFresh = evidence.inputs.filter(
      (i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length,
    );
    const missing =
      evidence.dependencies.input.status === "complete" &&
      (rawFresh.length === 0 ||
        association.missingAction ||
        (association.stream?.status === "supported" && association.stream.missingTargetTap));
    const targetLocalArrival =
      !missing && trace && deriveTargetLocalArrival(evidence, map, trace, association, excludedComponentIds);
    if (targetLocalArrival)
      return result(["aim-late"], "Late entry", targetLocalArrival.eventIds, {
        status: "supported",
        description: "The cursor reached the circle after its best timing window.",
        metric: undefined,
        briefDetail: { phrase: "Reached the circle late" },
        limitations: [...observed.limitations, "target-local-movement-not-input-ownership-or-intent"],
        diagnostics: { ...baseDiagnostics, primary: { ...baseDiagnostics.primary, targetLocalArrival } },
      });
    if (!missing) {
      const comparisonIds = association.targetDependentRejections?.map((w) => w.inputId) ?? [];
      relevant.push(...evidence.inputs.filter((i) => comparisonIds.includes(i.record.id) && !i.postTerminal));
    }
    if (!missing && !relevant.length && trace) {
      // An inferred neighbour claim is not an actual successful receipt. Keep
      // it in the association and compare only correction-certified evidence;
      // the certificate rejects consumed actions and recomputes target access.
      const inputIds = evidence.inputs
          .filter(
            (i) =>
              association.contextInputIds.includes(i.record.id) &&
              i.inLiveSuccess &&
              !i.postTerminal &&
              i.freshActionsKnown &&
              i.record.freshActions.length === 1,
          )
          .map((i) => i.record.id),
        comparison = comparePrimaryApproaches(
          evidence,
          map,
          {
            pressIds: inputIds,
            contextBoundaryInputIds: association.contextInputIds.filter((id) => !inputIds.includes(id)),
            inputScopes: association.stream?.inputScopes,
          },
          trace,
          excludedComponentIds,
          true,
          true,
        ),
        ranking = comparison.ranking;
      baseDiagnostics.primary.unconsumedContextComparison = {
        inputIds,
        comparison,
        ranking,
        basis: "usable-correction-with-inferred-neighbour-claim",
      };
      if (ranking.selected.length) {
        const selected = ranking.selected,
          single = selected.length === 1 ? selected[0] : undefined;
        return result(
          selected.map((c) => c.code),
          selected.map((c) => c.headline).join(" · "),
          [
            terminal.id,
            ...ranking.comparisonEventIds,
            ...selected.flatMap(
              (c) => (c.roleEvidence?.bestWindowAim ?? c.support?.bestWindowAim)?.eventIds ?? [],
            ),
          ],
          {
            status: "supported",
            description: single
              ? single.headline + " in the relevant approach."
              : "Distinct supported errors occurred during the approach.",
            metric: single?.metric,
            briefDetail: single?.briefDetail,
            limitations: [
              ...observed.limitations,
              ...comparison.approaches.limitations,
              ...comparison.approaches.episodes.flatMap((ep) => ep.limitations),
              "inferred-neighbour-claim-not-successful-receipt",
              ...(!comparison.complete ? ["incomplete-secondary-context"] : []),
            ],
            diagnostics: baseDiagnostics,
          },
        );
      }
    }
    if (!missing && !relevant.length)
      return result([], "", [], {
        status: "unavailable",
        description: "",
        metric: undefined,
        briefDetail: undefined,
        limitations: [...observed.limitations, "target-input-ownership-unresolved"],
      });
    if (missing)
      return result(
        ["no-tap"],
        "No tap",
        [
          terminal.id,
          ...(association.missingAction?.eventIds ?? []),
          ...(association.stream?.missingTargetTap
            ? association.stream.assignments
                .filter((row) => row.componentId === evidence.targetId && row.relation === "missing")
                .flatMap((row) => row.eventIds)
            : []),
          ...evidence.inputs
            .filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.sequence < terminal.sequence)
            .map((i) => i.record.id),
        ],
        {
          description: "No separate tap accompanied this note.",
          metric: undefined,
          briefDetail: undefined,
        },
      );
  }
  const comparisonContext = {
    pressIds: relevant.map((i) => i.record.id),
    contextBoundaryInputIds: association.contextInputIds.filter(
      (id) => !relevant.some((i) => i.record.id === id),
    ),
    // A disputed edge must not erase a separate, already proven placement fence.
    inputScopes: association.stream?.inputScopes
      ? Object.fromEntries(
          Object.entries(association.stream.inputScopes).filter(([id]) => !uncertainIds.includes(id)),
        )
      : undefined,
  };
  const allocationComparison = uncertainIds.length
    ? comparePrimaryInputHypotheses(
        evidence,
        map,
        comparisonContext,
        relevant.filter((i) => !uncertainIds.includes(i.record.id)).map((i) => i.record.id),
        relevant.filter((i) => uncertainIds.includes(i.record.id)).map((i) => i.record.id),
        trace,
        excludedComponentIds,
        true,
      )
    : undefined;
  const comparison =
      allocationComparison ??
      comparePrimaryApproaches(evidence, map, comparisonContext, trace, excludedComponentIds, true),
    { approaches, complete } = comparison,
    ranking = comparison.ranking,
    admissible = comparison.admissible;
  const diagnostics = {
    ...baseDiagnostics,
    primary: {
      ...baseDiagnostics.primary,
      approaches,
      ranking,
      ...(allocationComparison
        ? {
            allocationComparison,
            inputHypotheses: {
              inputIds: uncertainIds,
              reason: "compare-positive-local-evidence-without-reassigning-ownership",
            },
          }
        : {}),
    },
  };
  const limitations = [
    ...new Set([
      ...observed.limitations,
      ...(uncertainIds.length ? stream?.limitations ?? [] : []),
      ...approaches.limitations,
      ...approaches.episodes.flatMap((e) => e.limitations),
      ...(allocationComparison?.hypotheses.flatMap((h) => h.limitations) ?? []),
      ...(!complete && allocationComparison ? [allocationComparison.reason] : []),
    ]),
  ];
  // Completeness describes all compared episodes. A candidate-free secondary
  // episode does not negate a separately certified usable correction.
  if (!complete && !admissible && !allocationComparison?.invariantMandatoryTiming)
    return result([], "", [], {
      status: "unavailable",
      description: "",
      metric: undefined,
      briefDetail: undefined,
      diagnostics,
      limitations: [...limitations, "incomplete-primary-comparison"],
    });
  if (!ranking.selected.length)
    return {
      ...observed,
      status: "unavailable",
      codes: [],
      headline: "",
      description: "",
      diagnostics,
      limitations: [...limitations, "primary-episode-not-established"],
    };
  const selected = ranking.selected;
  const single = selected.length === 1 ? selected[0] : undefined;
  return result(
    selected.map((c) => c.code),
    selected.map((c) => c.headline).join(" · "),
    [
      terminal.id,
      ...ranking.comparisonEventIds,
      ...selected.flatMap((c) => (c.roleEvidence?.bestWindowAim ?? c.support?.bestWindowAim)?.eventIds ?? []),
    ],
    {
      description: single
        ? single.headline + " in the relevant approach."
        : "Distinct supported errors were comparably strong across the relevant attempts.",
      metric: uncertainIds.length ? undefined : single?.metric,
      briefDetail: uncertainIds.length ? undefined : single?.briefDetail,
      diagnostics,
      limitations,
    },
  );
}
