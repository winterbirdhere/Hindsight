import { Beatmap } from "../../beatmap/Beatmap";
import { CircleEvidence } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import { PrimaryApproachResult, isPrimaryCursorPass } from "./PrimaryApproach";
import { PrimaryCandidate, PRIMARY_DIAGNOSIS_POLICY } from "./PrimaryDiagnosisPolicy";

/** One original best-window opportunity can explain the shared passage even
 * when earlier/later alternative repairs have larger normalized offsets. */
export function annotateBestWindowAimOpportunity(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  approaches: PrimaryApproachResult,
  candidates: PrimaryCandidate[],
  excluded: ReadonlySet<string> = new Set()
): void {
  for (const c of candidates) {
    if (c.support) delete c.support.bestWindowAim;
    if (c.roleEvidence) delete c.roleEvidence.bestWindowAim;
  }
  if (
    !trace ||
    e.status !== "supported" ||
    e.limits.truncated ||
    !e.target ||
    !e.geometry ||
    e.terminal?.mechanism !== "automatic-expiry" ||
    e.terminal.result !== "MISS" ||
    e.directRejections.length ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    candidates.length > PRIMARY_DIAGNOSIS_POLICY.maximumCandidates
  )
    return;
  const raw = e.inputs.filter((i) => i.inLiveSuccess && !i.postTerminal && i.record.freshActions.length),
    eps = approaches.episodes,
    best = e.geometry.hitWindows[0],
    beat = e.target.hitTimeMs;
  if (
    raw.length < 3 ||
    raw.length > 16 ||
    raw.some((i) => !i.freshActionsKnown || i.inside || i.record.freshActions.length !== 1) ||
    eps.length !== raw.length ||
    new Set(eps.map((ep) => ep.inputId)).size !== raw.length ||
    eps.some(
      (ep) =>
        ep.status !== "supported" ||
        ep.inputScope ||
        ep.limitations.length ||
        !raw.some((i) => i.record.id === ep.inputId)
    )
  )
    return;
  const onBest = raw.filter((i) => Math.abs(i.record.timeMs - beat) <= best);
  if (onBest.length !== 1) return;
  const middle = onBest[0],
    lo = beat - e.geometry.hitWindows[2],
    hi = beat + e.geometry.hitWindows[2],
    live = (ep: typeof eps[number]) => ep.contacts.filter((c) => isPrimaryCursorPass(c) && c.exitTimeMs > lo && c.entryTimeMs < hi),
    pass = live(eps[0])[0];
  const sameIds = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id)),
    samePass = (c: typeof pass | undefined) =>
      !!c &&
      c.entryTimeMs === pass?.entryTimeMs &&
      c.exitTimeMs === pass?.exitTimeMs &&
      sameIds(c.eventIds, pass.eventIds) &&
      sameIds(c.sampledEventIds, pass.sampledEventIds);
  if (
    !pass ||
    pass.leftCensored ||
    pass.rightCensored ||
    !pass.deepSampled ||
    pass.placementSupport === "unproven" ||
    pass.entryTimeMs > beat + best ||
    pass.exitTimeMs < beat - best ||
    eps.some(
      (ep) =>
        live(ep).length !== 1 ||
        !samePass(live(ep)[0]) ||
        live(ep)[0].leftCensored ||
        live(ep)[0].rightCensored ||
        live(ep)[0].placementSupport === "unproven"
    )
  )
    return;
  const flanks = raw.filter((i) => i !== middle);
  if (
    !flanks.some((i) => i.record.timeMs < pass.entryTimeMs) ||
    !flanks.some((i) => i.record.timeMs > pass.exitTimeMs) ||
    flanks.some((i) => {
      const ep = eps.find((ep) => ep.inputId === i.record.id)!;
      return ep.spatialCandidates.length || ep.placement !== "proper-pass" || !samePass(ep.properPass);
    })
  )
    return;
  const receipts: string[] = [];
  for (const i of raw) {
    const q = i.record,
      attempts = e.attempts.filter((a) => a.inputId === q.id),
      a = attempts[0],
      routes = e.routing.filter((r) => r.attemptId === a?.id),
      selection = routes[0];
    if (
      trace.records[q.sequence] !== q ||
      attempts.length !== 1 ||
      !a ||
      a.automated ||
      a.attemptOrdinal !== 0 ||
      a.knownAction !== q.freshActions[0] ||
      a.actionCandidates.length !== 1 ||
      a.actionCandidates[0] !== q.freshActions[0] ||
      a.timeMs !== q.timeMs ||
      a.sequence <= q.sequence ||
      routes.length !== 1 ||
      selection.kind !== "selection" ||
      selection.componentId !== null ||
      selection.inside !== null ||
      selection.eligible ||
      selection.selectionStopped ||
      selection.timeMs !== q.timeMs ||
      selection.sequence <= a.sequence ||
      trace.records[a.sequence] !== a ||
      trace.records[selection.sequence] !== selection ||
      trace.records.some((r) => r.kind === "resolution" && r.triggerAttemptId === a.id)
    )
      return;
    receipts.push(a.id, selection.id);
  }

  if (
    candidates.some(
      (c) =>
        c.inputIds.length !== 1 ||
        !raw.some((i) => i.record.id === c.inputIds[0]) ||
        c.support?.context ||
        c.support?.aimOpportunity ||
        (c.family === "placement" && c.inputIds[0] !== middle.record.id) ||
        (c.family === "timing" &&
          (!["early-tap", "late-tap"].includes(c.code) ||
            c.timingPass?.entryTimeMs !== pass.entryTimeMs ||
            c.timingPass?.exitTimeMs !== pass.exitTimeMs)) ||
        (c.family === "arrival" &&
          (!["aim-late", "left-early"].includes(c.code) ||
            c.arrivalObservation?.entryTimeMs !== pass.entryTimeMs ||
            c.arrivalObservation?.exitTimeMs !== pass.exitTimeMs))
    )
  )
    return;
  const aims = candidates.filter((c) => c.inputIds[0] === middle.record.id && c.family !== "timing"),
    positive = aims.filter((c) => !c.independent);
  if (!positive.length || new Set(aims.map((c) => c.code)).size !== 1) return;
  if (
    flanks.some(
      (i) =>
        !candidates.some(
          (c) =>
            c.inputIds[0] === i.record.id &&
            c.family === "timing" &&
            c.timingPass?.entryTimeMs === pass.entryTimeMs &&
            c.timingPass.exitTimeMs === pass.exitTimeMs
        )
    )
  )
    return;
  const witness = [
    ...new Set([...eps.flatMap((ep) => ep.eventIds), ...candidates.flatMap((c) => c.eventIds), ...receipts]),
  ];
  const marker = {
    inputId: middle.record.id,
    entryTimeMs: pass.entryTimeMs,
    exitTimeMs: pass.exitTimeMs,
    eventIds: witness,
  };
  for (const c of candidates) {
    const selected = positive.includes(c);
    (c.roleEvidence ??= {}).bestWindowAim = {
      ...marker,
      role: selected ? "best-window-aim" : "same-passage-alternative",
    };
    if (c.support) c.support.bestWindowAim = c.roleEvidence.bestWindowAim;
  }
}
