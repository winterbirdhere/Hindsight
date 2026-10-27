import {
  attributePrimaryPresses,
  certifyPrimaryAttribution,
  rankAttributionCandidates,
  referenceComparisonCandidates,
  PressAttribution,
} from "./PrimaryAttribution";
import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { analyzePrimaryApproaches, PrimaryApproachContext, isPrimaryCursorPass } from "./PrimaryApproach";
import { PrimaryCandidate, PRIMARY_DIAGNOSIS_POLICY } from "./PrimaryDiagnosisPolicy";
import { PrimaryAllocationHypothesis } from "./PrimaryInvariantTiming";
import { ReplayTrace } from "../trace/ReplayTrace";
import { annotatePrimaryCadenceContext } from "./PrimaryCadenceContext";
import { annotateInitialAimOpportunity } from "./PrimaryAimOpportunity";
import {
  boundedMovingOutside,
  boundedBeatOutside,
  regenerateBeatOutsideBeforeFutureGroup,
} from "./PrimaryMovingOutside";
import { annotateBestWindowAimOpportunity } from "./BestWindowAimOpportunity";
import { recordedAttributionFailure } from "./RecordedAttributionValidity";
import { laterApproachStart, latestOtherReceiptBoundary } from "./PrimaryReceiptBoundary";

/** Pure comparison of explicitly scoped approaches; no ownership or chain recursion. */
export function comparePrimaryApproaches(
  evidence: CircleEvidence,
  map: Beatmap,
  context: PrimaryApproachContext,
  trace?: ReplayTrace,
  excluded: ReadonlySet<string> = new Set(),
  deferCertification = false,
  exclusiveInputs = false,
) {
  const geometry = evidence.geometry!;
  const relevant = evidence.inputs.filter((i) => context.pressIds.includes(i.record.id));
  const approaches = analyzePrimaryApproaches(evidence, context);
  // C alone owns this past receipt fence. Ordinary passes, timing/role selection
  // and the private chain-root comparison retain their existing context.
  const approachInputs = trace ? new Map(evidence.inputs.map(i=>[i.record.id,i.record])) : undefined;
  const receiptScopes = new Map<string,typeof approaches>();
  if (trace) for (const episode of approaches.episodes) {
    const press = approachInputs!.get(episode.inputId);
    if (!press || episode.status !== "supported") continue;
    const boundary = latestOtherReceiptBoundary(trace,map,evidence.targetId,press);
    if (!boundary) continue;
    const alreadyAfter = episode.eventIds.length > 0 && episode.eventIds.every(id=>{
      const r=approachInputs!.get(id);
      return r && (r.timeMs>boundary.timeMs || r.timeMs===boundary.timeMs && r.sequence>boundary.sequence);
    });
    if (!alreadyAfter) {
      let scopedApproaches = receiptScopes.get(boundary.eventId);
      if (!scopedApproaches) {
        scopedApproaches = analyzePrimaryApproaches(evidence,{...context,start:laterApproachStart(context.start,boundary)});
        receiptScopes.set(boundary.eventId,scopedApproaches);
      }
      const scoped = scopedApproaches.episodes.find(e=>e.inputId===episode.inputId);
      episode.farEdgeReturn = scoped?.status === "supported" ? scoped.farEdgeReturn : undefined;
    }
    if (episode.farEdgeReturn) episode.farEdgeReturn.receiptBoundary = boundary;
  }
  const candidates: PrimaryCandidate[] = [];
  const sourceScopedApproaches: typeof approaches.episodes = [];
  for (const episode of approaches.episodes) {
    if (episode.status !== "supported") continue;
    const inputIds = [episode.inputId],
      eventIds = [episode.inputId],
      offset = episode.pressOffsetMs,
      best = geometry.hitWindows[0];
    for (const spatial of episode.spatialCandidates)
      candidates.push({
        code: spatial.code,
        headline: spatial.label,
        family: "placement",
        strength: spatial.radialR,
        independent: episode.timingIndependent,
        relationId: "placement:" + episode.inputId,
        inputIds,
        eventIds: [...spatial.eventIds],
      });
    if (episode.deadlineArrival)
      candidates.push({
        code: "aim-late",
        headline: "Late entry",
        family: "arrival",
        strength: episode.deadlineArrival.entryOffsetMs / best,
        independent: false,
        relationId: "tap-phase:" + episode.inputId,
        inputIds,
        eventIds: [...episode.deadlineArrival.eventIds],
      });
    const pass = episode.properPass;
    // Keep every historical contact, but derive a temporal boundary from the
    // sole usable pass when an out-of-window visit created "between-passes".
    // Even an unproven live contact counts here: it must not be silently erased
    // to manufacture a unique usable approach.
    const liveContacts = episode.contacts.filter(
      (c) =>
        isPrimaryCursorPass(c) && c.exitTimeMs > evidence.target!.hitTimeMs - geometry.hitWindows[2] &&
        c.entryTimeMs < evidence.target!.hitTimeMs + geometry.hitWindows[2],
    );
    const soleLivePass =
      episode.relation === "between-passes" &&
      pass &&
      liveContacts.length === 1 &&
      liveContacts[0].placementSupport !== "unproven" &&
      liveContacts[0].entryTimeMs === pass.entryTimeMs &&
      liveContacts[0].exitTimeMs === pass.exitTimeMs &&
      liveContacts[0].eventIds.length === pass.eventIds.length &&
      liveContacts[0].eventIds.every((id) => pass.eventIds.includes(id));
    const temporalRelation =
      soleLivePass && episode.pressTimeMs < pass.entryTimeMs
        ? "before-pass"
        : soleLivePass && episode.pressTimeMs > pass.exitTimeMs
        ? "after-pass"
        : episode.relation;
    if (episode.relation === "between-passes") {
      const before = episode.contacts
        .filter(
          (c) => isPrimaryCursorPass(c) && c.placementSupport !== "unproven" && !c.rightCensored && c.exitTimeMs < episode.pressTimeMs,
        )
        .pop();
      const after = episode.contacts.find(
        (c) => isPrimaryCursorPass(c) && c.placementSupport !== "unproven" && !c.leftCensored && c.entryTimeMs > episode.pressTimeMs,
      );
      const press = relevant.find((i) => i.record.id === episode.inputId);
      // Historical contact outside the success window is still movement
      // evidence, but it cannot supply a second competing hit opportunity.
      if (
        before &&
        after &&
        press &&
        !press.inside &&
        before.exitTimeMs > evidence.target!.hitTimeMs - geometry.hitWindows[2] &&
        after.entryTimeMs < evidence.target!.hitTimeMs + geometry.hitWindows[2]
      )
        candidates.push({
          code: "between-passes",
          headline: "Between passes",
          family: "arrival",
          strength:
            Math.min(episode.pressTimeMs - before.exitTimeMs, after.entryTimeMs - episode.pressTimeMs) / best,
          independent: false,
          relationId: "tap-phase:" + episode.inputId,
          inputIds,
          eventIds: [...new Set([...eventIds, ...before.eventIds, ...after.eventIds])],
          briefDetail: { phrase: "Tapped between two circle passes" },
        });
    }
    const temporalSupported = !!pass || episode.timingIndependent;
    if (temporalSupported && offset !== 0 && (pass || Math.abs(offset) > best)) {
      const early = offset < 0,
        metric = {
          value: Math.round(Math.abs(offset) / map.gameClockRate),
          unit: early ? "ms early" : "ms late",
        };
      candidates.push({
        code: early ? "early-tap" : "late-tap",
        headline: early ? "Early tap" : "Late tap",
        family: "timing",
        strength: Math.abs(offset) / best,
        independent: episode.timingIndependent,
        relationId: "tap-phase:" + episode.inputId,
        inputIds,
        eventIds,
        ...(pass && !pass.leftCensored && !pass.rightCensored
          ? { timingPass: { entryTimeMs: pass.entryTimeMs, exitTimeMs: pass.exitTimeMs } }
          : {}),
        metric,
        briefDetail: { phrase: "", metric },
      });
    }
    if (pass && episode.placement !== "misplaced") {
      // Entry/exit are receptor boundaries. Later depth or a turn within a valid
      // pass must not invent (or inflate) an arrival timing error.
      const entryOffset = pass.entryTimeMs - evidence.target!.hitTimeMs;
      const exitOffset = pass.exitTimeMs - evidence.target!.hitTimeMs;
      const late = temporalRelation === "before-pass" && !pass.leftCensored && entryOffset > 0;
      const early = temporalRelation === "after-pass" && !pass.rightCensored && exitOffset < 0;
      if (late || early) {
        const boundaryTimeMs = late ? pass.entryTimeMs : pass.exitTimeMs;
        const brackets = evidence.inputs.slice(1).flatMap((b, k) => {
          const a = evidence.inputs[k],
            p = a.record,
            q = b.record;
          if (
            !trace ||
            trace.records[p.sequence] !== p ||
            trace.records[q.sequence] !== q ||
            !a.freshActionsKnown ||
            !b.freshActionsKnown ||
            !pass.eventIds.includes(p.id) ||
            !pass.eventIds.includes(q.id) ||
            !(p.timeMs < boundaryTimeMs && boundaryTimeMs < q.timeMs) ||
            p.source.origin !== "parsed" ||
            q.source.origin !== "parsed" ||
            p.source.discontinuityBefore?.length ||
            q.source.discontinuityBefore?.length ||
            q.source.parsedFrameIndex !== p.source.parsedFrameIndex + 1 ||
            ![p.timeMs, q.timeMs, p.position.x, p.position.y, q.position.x, q.position.y].every(
              Number.isFinite,
            ) ||
            ((p.source.rawTokenIndex !== undefined || q.source.rawTokenIndex !== undefined) &&
              (p.source.rawTokenIndex === undefined || q.source.rawTokenIndex !== p.source.rawTokenIndex + 1))
          )
            return [];
          return [[p.id, q.id] as [string, string]];
        });
        candidates.push({
          code: late ? "aim-late" : "left-early",
          headline: late ? "Late entry" : "Early exit",
          family: "arrival",
          strength: Math.abs(late ? entryOffset : exitOffset) / best,
          independent: false,
          relationId: "tap-phase:" + episode.inputId,
          inputIds,
          eventIds: [
            ...new Set([
              ...eventIds,
              ...pass.eventIds,
              ...pass.sampledEventIds,
              ...(soleLivePass ? episode.eventIds : []),
            ]),
          ],
          arrivalObservation: {
            targetId: evidence.targetId,
            boundary: late ? "entry" : "exit",
            boundaryTimeMs: late ? pass.entryTimeMs : pass.exitTimeMs,
            entryTimeMs: pass.entryTimeMs,
            exitTimeMs: pass.exitTimeMs,
            eventIds: [...pass.eventIds],
            sampledEventIds: [...pass.sampledEventIds],
            ...(brackets.length === 1 ? { boundaryEventIds: brackets[0] } : {}),
          },
        });
      }
    }
  }
  // An aim-only correction can establish broad aim failure where the sampled
  // trajectory has no directional subtype. It must reach this target at the
  // same actual fresh press, independently of nominal geometric ownership.
  for (const ep of approaches.episodes) {
    const press = relevant.find((i) => i.record.id === ep.inputId);
    if (
      ep.status !== "supported" ||
      ep.placement !== "unproven" ||
      ep.spatialCandidates.length ||
      ep.properPass ||
      !press ||
      press.inside ||
      ep.limitations.some((s) => s !== "no-positive-local-placement" && s !== "short-local-trajectory")
    )
      continue;
    const pulseMovement = boundedMovingOutside(evidence, ep, trace),
      beatMovement = !pulseMovement ? boundedBeatOutside(evidence, ep, trace) : undefined,
      movement = pulseMovement ?? beatMovement;
    if (Math.abs(ep.pressOffsetMs) > geometry.hitWindows[0] && !movement) continue;
    const closed = regenerateBeatOutsideBeforeFutureGroup(evidence, ep, context, trace);
    if (closed) sourceScopedApproaches.push(closed.episode);
    const radialR =
      Math.hypot(
        press.record.position.x - geometry.position.x,
        press.record.position.y - geometry.position.y,
      ) / geometry.radius;
    candidates.push({
      code: "misaim",
      headline: "Misaim",
      family: "placement",
      strength: radialR,
      independent: false,
      ...(movement || closed
        ? {
            placementBasis:
              beatMovement || closed ? ("beat-spanning-outside" as const) : ("moving-outside" as const),
          }
        : {}),
      ...(closed ? { sourceClosure: closed.closure } : {}),
      ...(closed ? { geometryWitnessEventIds: closed.geometryEventIds } : {}),
      relationId: "aim-correction:" + ep.inputId,
      inputIds: [ep.inputId],
      eventIds: [
        ...new Set([
          ...(movement ?? ep.eventIds),
          ...(closed?.geometryEventIds ?? []),
          ...(closed?.closure.eventIds ?? []),
        ]),
      ],
      requiresCertificate: !movement && !closed,
    });
  }
  // An ordered position jump just before a spatial witness can invalidate its
  // required leading source bracket. Reconstruct a new episode after that
  // boundary; never trim the old proof or relax canonical source validation.
  for (const ep of approaches.episodes)
    for (const spatial of ep.spatialCandidates) {
      const old = candidates.find(
        (c) =>
          c.code === spatial.code &&
          c.inputIds.length === 1 &&
          c.inputIds[0] === ep.inputId &&
          c.eventIds.length === spatial.eventIds.length &&
          c.eventIds.every((id) => spatial.eventIds.includes(id)),
      );
      if (ep.contacts.length || ep.properPass || ep.inputScope?.placementEnd) continue;
      const points = evidence.inputs.filter((i) => spatial.eventIds.includes(i.record.id)),
        first = points[0],
        at = evidence.inputs.indexOf(first),
        before = evidence.inputs[at - 1],
        next = evidence.inputs[at + 1],
        pressAt = evidence.inputs.findIndex((i) => i.record.id === ep.inputId);
      if (
        !first ||
        !before ||
        !next ||
        !spatial.eventIds.includes(next.record.id) ||
        next.record.timeMs <= first.record.timeMs ||
        before.record.timeMs !== first.record.timeMs ||
        (before.record.position.x === first.record.position.x &&
          before.record.position.y === first.record.position.y) ||
        at + 1 >= pressAt - 1
      )
        continue;
      const scope = context.inputScopes?.[ep.inputId],
        fresh = analyzePrimaryApproaches(evidence, {
          ...context,
          inputScopes: {
            ...context.inputScopes,
            [ep.inputId]: {
              ...scope,
              start: {
                timeMs: next.record.timeMs,
                sequence: next.record.sequence,
                inclusive: true,
                eventId: next.record.id,
              },
              eventIds: [...new Set([...(scope?.eventIds ?? []), next.record.id])],
            },
          },
        }).episodes.find((e) => e.inputId === ep.inputId),
        witness = fresh?.spatialCandidates.find(
          (s) =>
            s.code === spatial.code &&
            Math.abs(s.radialR - spatial.radialR) <= PRIMARY_DIAGNOSIS_POLICY.comparisonTolerance &&
            s.eventIds.every((id) => spatial.eventIds.includes(id)),
        );
      const geometryKey = (e: typeof ep) =>
          JSON.stringify(
            {
              placement: e.placement,
              relation: e.relation,
              closest: e.closest,
              landing: e.landing,
              lateralTraversal: e.lateralTraversal,
              lobeAlternatives: e.lobeAlternatives,
              continuingFlow: e.continuingFlow,
            },
            (key, value) =>
              key === "eventIds" || key === "progressEventIds" || key === "seedEventIds" ? undefined : value,
          ),
        retained = spatial.eventIds.filter((id) => id !== first.record.id);
      if (
        !fresh ||
        fresh.status !== "supported" ||
        fresh.contacts.length ||
        fresh.properPass ||
        fresh.timingIndependent !== ep.timingIndependent ||
        !witness ||
        witness.eventIds.length !== retained.length ||
        !retained.every((id) => witness.eventIds.includes(id)) ||
        geometryKey(fresh) !== geometryKey(ep) ||
        JSON.stringify(fresh.closest?.eventIds) !== JSON.stringify(ep.closest?.eventIds)
      )
        continue;
      const candidate: PrimaryCandidate = old ?? {
        code: spatial.code,
        headline: spatial.label,
        family: "placement",
        strength: spatial.radialR,
        independent: ep.timingIndependent,
        relationId: "placement:" + ep.inputId,
        inputIds: [ep.inputId],
        eventIds: [...spatial.eventIds],
      };
      if (!old) candidates.push(candidate);
      (ep.sourceScopedPlacements ??= []).push(fresh);
      if (recordedAttributionFailure(evidence, trace, ep.inputId, witness.eventIds, excluded)) continue;
      sourceScopedApproaches.push(fresh);
      candidates.push({ ...candidate, eventIds: [...witness.eventIds] });
    }
  // An earlier ordered update cannot supply an interpolation. A separately
  // regenerated inside-to-exit span may still prove the same exit after it.
  for (const ep of approaches.episodes) {
    const pass = ep.properPass;
    if (ep.relation !== "after-pass" || !pass || pass.rightCensored || !pass.deepSampled ||
      pass.placementSupport !== "sampled" || !isPrimaryCursorPass(pass)) continue;
    const old = candidates.find(c => c.code === "left-early" && c.inputIds.length === 1 &&
      c.inputIds[0] === ep.inputId && c.arrivalObservation?.boundaryTimeMs === pass.exitTimeMs);
    const bracket = old?.arrivalObservation?.boundaryEventIds;
    if (!old || !bracket || bracket.length !== 2 ||
      recordedAttributionFailure(evidence,trace,ep.inputId,pass.eventIds,excluded) !== "recorded-leading-position-discontinuity") continue;
    const firstAt = evidence.inputs.findIndex(i => pass.eventIds.includes(i.record.id)),
      first = evidence.inputs[firstAt], before = evidence.inputs[firstAt - 1];
    if (!first || !before || before.record.timeMs !== first.record.timeMs ||
      before.record.position.x === first.record.position.x && before.record.position.y === first.record.position.y) continue;
    let nextAt = firstAt + 1;
    while (nextAt < evidence.inputs.length && evidence.inputs[nextAt].record.timeMs === first.record.timeMs) nextAt++;
    const seed = evidence.inputs[nextAt], previous = evidence.inputs[nextAt - 1];
    if (!seed || !seed.inside || !seed.freshActionsKnown || seed.record.freshActions.length ||
      seed.record.timeMs <= previous.record.timeMs || seed.record.sequence <= previous.record.sequence ||
      seed.record.timeMs >= pass.exitTimeMs || context.contextBoundaryInputIds?.includes(seed.record.id) ||
      seed.record.source.origin !== "parsed" || previous.record.source.origin !== "parsed" ||
      seed.record.source.discontinuityBefore?.length ||
      seed.record.source.parsedFrameIndex !== previous.record.source.parsedFrameIndex + 1 ||
      JSON.stringify(seed.record.previousActions) !== JSON.stringify(previous.record.actions) ||
      ((seed.record.source.rawTokenIndex !== undefined || previous.record.source.rawTokenIndex !== undefined) &&
        (seed.record.source.rawTokenIndex === undefined || previous.record.source.rawTokenIndex === undefined ||
          seed.record.source.rawTokenIndex !== previous.record.source.rawTokenIndex + 1))) continue;
    const scope = context.inputScopes?.[ep.inputId];
    const fresh = analyzePrimaryApproaches(evidence,{...context,inputScopes:{...context.inputScopes,
      [ep.inputId]:{...scope,start:{timeMs:seed.record.timeMs,sequence:seed.record.sequence,inclusive:true,eventId:seed.record.id},
        eventIds:[...new Set([...(scope?.eventIds ?? []),seed.record.id])]}}}).episodes.find(e=>e.inputId===ep.inputId);
    const retained = fresh?.properPass;
    const coverage = (p: typeof pass) => [Math.max(p.entryTimeMs,evidence.target!.hitTimeMs-geometry.hitWindows[0]),
      Math.min(p.exitTimeMs,evidence.target!.hitTimeMs+geometry.hitWindows[0])];
    if (!fresh || fresh.status !== "supported" || fresh.relation !== "after-pass" || !retained ||
      retained.rightCensored || !retained.deepSampled || retained.placementSupport !== "sampled" || !isPrimaryCursorPass(retained) ||
      retained.exitTimeMs !== pass.exitTimeMs || !bracket.every(id=>retained.eventIds.includes(id)) ||
      JSON.stringify(coverage(retained)) !== JSON.stringify(coverage(pass))) continue;
    const witness = [...new Set([ep.inputId,...retained.eventIds])];
    if (recordedAttributionFailure(evidence,trace,ep.inputId,witness,excluded)) continue;
    // The crop starts inside. Identical co-timed samples do not establish an
    // observed entry, even when they precede the first positive-time segment.
    if (retained.entryTimeMs === seed.record.timeMs) retained.leftCensored = true;
    (ep.sourceScopedArrivals ??= []).push(fresh);
    sourceScopedApproaches.push(fresh);
    candidates.push({...old,geometryWitnessEventIds:witness});
  }
  annotatePrimaryCadenceContext(evidence, map, trace, candidates);
  annotateInitialAimOpportunity(evidence, approaches, candidates);
  annotateBestWindowAimOpportunity(evidence, map, trace, approaches, candidates, excluded);
  if (exclusiveInputs)
    for (const c of candidates) c.hypothesisIds = c.inputIds.map((id) => context.pressIds.indexOf(id));
  const recorded = attributePrimaryPresses(
    evidence,
    map,
    trace,
    approaches,
    candidates,
    relevant.map((i) => i.record.id),
    excluded,
  );
  // The dedicated cadence handler has its own source/flow proof. Preserve its
  // original counterevidence coverage contract without admitting an ordinary
  // observation whose selected movement witness is invalid or uncertified.
  const structuralComplete =
    !!relevant.length &&
    relevant.length === context.pressIds.length &&
    approaches.episodes.every((e) => e.status === "supported") &&
    relevant.every((i) => recorded.candidates.some((c) => c.inputIds.includes(i.record.id)));
  const complete =
    structuralComplete &&
    !recorded.attribution?.presses.some((p) => p.recordedFailure) &&
    relevant.every((i) =>
      recorded.candidates.some((c) => !c.requiresCertificate && c.inputIds.includes(i.record.id)),
    );
  const ranking = deferCertification
    ? { ...recorded, observationComplete: complete }
    : certifyPrimaryAttribution(evidence, map, trace, recorded, complete, excluded);
  return referenceComparisonCandidates({
    approaches,
    sourceScopedApproaches,
    candidates: ranking.candidates,
    ranking,
    structuralComplete,
    complete,
    admissible: ranking.selected.length > 0,
  });
}

/** Preserve source-fenced singleton allocations and independently usable
 * candidates from the combined raw sequence; neither asserts human ownership. */
export function comparePrimaryInputHypotheses(
  evidence: CircleEvidence,
  map: Beatmap,
  context: PrimaryApproachContext,
  mandatory: readonly string[],
  alternatives: readonly string[],
  trace?: ReplayTrace,
  excluded?: ReadonlySet<string>,
  deferCertification = false,
) {
  const unique = (ids: readonly string[]) => [...new Set(ids)],
    fixed = unique(mandatory),
    optional = unique(alternatives).filter((id) => !fixed.includes(id)),
    requested = unique([...fixed, ...optional]),
    inputs = evidence.inputs.filter((i) => requested.includes(i.record.id)),
    all = inputs.map((i) => i.record.id),
    known =
      inputs.every(
        (i) => i.freshActionsKnown && i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length > 0,
      ) &&
      requested.length === all.length &&
      requested.length === context.pressIds.length &&
      context.pressIds.every((id) => requested.includes(id)) &&
      new Set(context.pressIds).size === context.pressIds.length;
  const compare = (inputIds: string[]) =>
    comparePrimaryApproaches(
      evidence,
      map,
      {
        ...context,
        pressIds: inputIds,
        contextBoundaryInputIds: unique([
          ...(context.contextBoundaryInputIds ?? []),
          ...evidence.inputs
            .filter((i) => i.record.freshActions.length && !inputIds.includes(i.record.id))
            .map((i) => i.record.id),
        ]).filter((id) => !inputIds.includes(id)),
        inputScopes: context.inputScopes
          ? Object.fromEntries(
              Object.entries(context.inputScopes).filter(
                ([id]) => fixed.includes(id) && inputIds.includes(id),
              ),
            )
          : undefined,
      },
      trace,
      excluded,
      true,
    );
  const ordinary = compare(all),
    maximumVariantBytes = 8 * 1024 * 1024,
    maximumWitnessReferences = 32768;
  type Episode = typeof ordinary.approaches.episodes[number];
  const approachVariants: Episode[] = [],
    candidates: PrimaryCandidate[] = [],
    episodeKeys = new Map<string, number>(),
    candidateKeys = new Map<string, number>();
  let variantBytes = 0,
    witnessReferences = 0,
    limited = false;
  const intern = <T extends { eventIds: string[] }>(value: T, pool: T[], keys: Map<string, number>) => {
    const decision = "attribution" in value ? (value.attribution as PressAttribution | undefined) : undefined;
    const key = JSON.stringify([value, decision ? { ...decision } : undefined]),
      found = keys.get(key);
    if (found !== undefined) return found;
    if (
      variantBytes + 2 * key.length > maximumVariantBytes ||
      witnessReferences + value.eventIds.length > maximumWitnessReferences
    ) {
      limited = true;
      return -1;
    }
    variantBytes += 2 * key.length;
    witnessReferences += value.eventIds.length;
    const at = pool.length;
    pool.push(value);
    keys.set(key, at);
    return at;
  };
  const sets = optional.length
    ? [...(fixed.length ? [fixed] : []), ...optional.map((id) => [...fixed, id])]
    : [fixed];
  const hypotheses: PrimaryAllocationHypothesis[] = [];
  const pressDecisions: PressAttribution[] = [...(ordinary.ranking.attribution?.presses ?? [])];
  if (known && all.length <= PRIMARY_DIAGNOSIS_POLICY.maximumInputs)
    for (const set of sets) {
      const inputIds = inputs.filter((i) => set.includes(i.record.id)).map((i) => i.record.id),
        branch = inputIds.length === all.length ? ordinary : compare(inputIds),
        approachVariantIds = branch.approaches.episodes.map((ep) =>
          intern(ep, approachVariants, episodeKeys),
        ),
        candidateIds = branch.candidates.map((c) => intern(c, candidates, candidateKeys));
      pressDecisions.push(...(branch.ranking.attribution?.presses ?? []));
      hypotheses.push({
        inputIds,
        contextInputIds: unique([
          ...(context.contextBoundaryInputIds ?? []),
          ...evidence.inputs
            .filter((i) => i.record.freshActions.length && !inputIds.includes(i.record.id))
            .map((i) => i.record.id),
        ]).filter((id) => !inputIds.includes(id)),
        approachVariantIds,
        candidateIds,
        complete: !limited && branch.complete && branch.ranking.reason !== "primary-candidate-limit",
        primaryCodes: branch.ranking.selected.map((c) => c.code),
        scores: branch.ranking.scores.map((s) => ({
          code: s.code,
          strength: s.inputs.reduce((n, i) => n + i.strength, 0) / Math.max(1, inputIds.length),
        })),
        limitations: unique([
          ...branch.approaches.limitations,
          ...branch.approaches.episodes.flatMap((ep) => ep.limitations),
          ...(branch.ranking.reason === "primary-candidate-limit" ? [branch.ranking.reason] : []),
        ]),
      });
      if (limited) break;
    }
  const allocationsComplete =
    known && !limited && hypotheses.length === sets.length && hypotheses.every((h) => h.complete);
  const rawContextCandidateIds =
    known && !limited ? ordinary.candidates.map((c) => intern(c, candidates, candidateKeys)) : [];
  const candidateLimit = candidates.length > PRIMARY_DIAGNOSIS_POLICY.maximumCandidates;
  annotatePrimaryCadenceContext(evidence, map, trace, candidates);
  annotateInitialAimOpportunity(evidence, ordinary.approaches, candidates);
  annotateBestWindowAimOpportunity(evidence, map, trace, ordinary.approaches, candidates, excluded);
  const witnessed = candidates.map((candidate, id) => ({
    ...candidate,
    hypothesisIds: [
      ...hypotheses.flatMap((h, k) => (h.candidateIds.includes(id) ? [k] : [])),
      ...(rawContextCandidateIds.includes(id) ? ["raw-context" as const] : []),
    ],
  }));
  const decided = rankAttributionCandidates(witnessed, all, pressDecisions);
  const failure = !known
    ? "invalid-primary-allocation-inputs"
    : limited
    ? "primary-allocation-resource-limit"
    : candidateLimit
    ? "primary-candidate-limit"
    : undefined;
  const complete = allocationsComplete && !limited && !candidateLimit;
  const finalized =
    failure || deferCertification
      ? { ...decided, observationComplete: complete }
      : certifyPrimaryAttribution(evidence, map, trace, decided, complete, excluded);
  const ranking = {
    ...finalized,
    selected: failure ? [] : finalized.selected,
    hypotheses,
    reason: failure ?? finalized.reason,
  };
  return referenceComparisonCandidates({
    policyVersion: "primary-allocation-comparison-v5",
    approaches: ordinary.approaches,
    approachVariants,
    candidates: witnessed,
    ranking,
    hypotheses,
    rawContextCandidateIds,
    complete,
    reason: ranking.reason,
    invariantMandatoryTiming: undefined,
    admissible: ranking.selected.length > 0,
    resources: { variantBytes, maximumVariantBytes, witnessReferences, maximumWitnessReferences, limited },
  });
}
