import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { PrimaryApproachResult } from "./PrimaryApproach";
import { PrimaryCandidate } from "./PrimaryDiagnosisPolicy";

/** Prefer an already certified best-window aim opportunity over a comparable
 * later observation of the same uninterrupted outside approach. This records
 * causal opportunity, not intended ownership or the purpose of a later tap. */
export function annotateInitialAimOpportunity(
  e: CircleEvidence,
  approaches: PrimaryApproachResult,
  candidates: PrimaryCandidate[]
): void {
  // Allocation pooling can introduce independent evidence. Never carry a role
  // from a narrower comparison into a pool that no longer satisfies its proof.
  for (const c of candidates) {
    if (c.support) delete c.support.aimOpportunity;
    if (c.roleEvidence) delete c.roleEvidence.aimOpportunity;
  }
  const positive = candidates,
    ids = [...new Set(positive.flatMap((c) => c.inputIds))];
  if (
    !e.target ||
    !e.geometry ||
    e.status !== "supported" ||
    e.limits.truncated ||
    ids.length !== 2 ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    positive.some(
      (c) => c.family !== "placement" || c.independent || c.roleEvidence?.context || c.inputIds.length !== 1
    )
  )
    return;
  const pulses = ids
    .map((id) => e.inputs.find((i) => i.record.id === id))
    .sort((a, b) => (a?.record.sequence ?? 0) - (b?.record.sequence ?? 0));
  if (
    pulses.some(
      (i) =>
        !i ||
        !i.inLiveSuccess ||
        i.postTerminal ||
        i.inside ||
        !i.freshActionsKnown ||
        i.record.freshActions.length !== 1
    )
  )
    return;
  const [p, q] = pulses,
    first = p!.record,
    last = q!.record,
    best = e.geometry.hitWindows[0];
  if (
    Math.abs(first.timeMs - e.target.hitTimeMs) > best ||
    last.timeMs - e.target.hitTimeMs <= best ||
    last.timeMs <= first.timeMs
  )
    return;
  const early = approaches.episodes.find((ep) => ep.inputId === first.id),
    late = approaches.episodes.find((ep) => ep.inputId === last.id),
    lobe = early?.boundedOutsideLobe,
    geometryIds = late?.spatialCandidates.flatMap((s) => s.eventIds);
  if (
    !lobe ||
    early?.status !== "supported" ||
    late?.status !== "supported" ||
    early.properPass ||
    late.properPass ||
    !geometryIds?.length ||
    geometryIds.some((id) => !lobe.eventIds.includes(id))
  )
    return;
  const earlier = positive.filter((c) => c.inputIds[0] === first.id);
  if (!earlier.some((c) => c.code === "misaim")) return;
  const run = e.inputs.filter(
    (i) => i.record.sequence >= first.sequence && i.record.sequence <= last.sequence
  );
  if (
    run.length < 2 ||
    run.length > 4096 ||
    run[0] !== p ||
    run[run.length - 1] !== q ||
    run.some(
      (i) =>
        i.pathGroup !== p!.pathGroup ||
        i.inside ||
        !lobe.eventIds.includes(i.record.id) ||
        (i.record.freshActions.length && !ids.includes(i.record.id))
    )
  )
    return;
  // A union of lobes around a shared crest does not prove one approach.
  const sharedLobe = early.lobeAlternatives?.find((l) =>
    [...geometryIds, ...run.map((i) => i.record.id), ...positive.flatMap((c) => c.eventIds)].every((id) =>
      l.eventIds.includes(id)
    )
  );
  if (!sharedLobe) return;
  const receipts: string[] = [];
  for (const pulse of pulses) {
    const attempts = e.attempts.filter((a) => a.inputId === pulse!.record.id),
      selections = e.routing.filter(
        (r) => r.kind === "selection" && attempts.some((a) => a.id === r.attemptId)
      );
    if (
      attempts.length !== 1 ||
      attempts[0].automated ||
      selections.length !== 1 ||
      selections[0].kind !== "selection" ||
      selections[0].componentId !== null
    )
      return;
    receipts.push(attempts[0].id, selections[0].id);
  }
  // Certificates already validate the canonical source span, actions and
  // prefix. Check the intervening chords too: sampled absence is insufficient.
  for (let k = 1; k < run.length; k++) {
    const a = run[k - 1].record,
      b = run[k].record,
      dx = b.position.x - a.position.x,
      dy = b.position.y - a.position.y,
      x = a.position.x - e.geometry.position.x,
      y = a.position.y - e.geometry.position.y,
      length2 = dx * dx + dy * dy,
      t = length2 ? Math.max(0, Math.min(1, -(x * dx + y * dy) / length2)) : 0;
    if (
      a.source.origin !== "parsed" ||
      b.source.origin !== "parsed" ||
      b.source.parsedFrameIndex !== a.source.parsedFrameIndex + 1 ||
      b.source.discontinuityBefore?.length ||
      Math.hypot(x + t * dx, y + t * dy) <= e.geometry.radius
    )
      return;
  }
  const eventIds = [...new Set([...sharedLobe.eventIds, ...geometryIds, ...receipts])];
  for (const c of positive) {
    (c.roleEvidence ??= {}).aimOpportunity = {
      role: c.inputIds[0] === first.id ? "initial-best-window" : "later-same-approach",
      initialInputId: first.id,
      laterInputId: last.id,
      eventIds,
    };
    if (c.support) c.support.aimOpportunity = c.roleEvidence.aimOpportunity;
  }
}
