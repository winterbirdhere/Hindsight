import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace } from "../trace/ReplayTrace";
import type { PrimaryCandidate } from "./PrimaryDiagnosisPolicy";
import { deriveStreamInputEvidence, STREAM_INPUT_POLICY } from "./StreamInputEvidence";

const sourceIndexes = new WeakMap<ReplayTrace, { inputs: InputRecord[]; positions: Map<string, number> }>();
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

/** Coaching preference among independently usable timing corrections. Recent
 * geometric cadence is corroboration, never a fabricated successful receipt. */
export function annotatePrimaryCadenceContext(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  candidates: PrimaryCandidate[]
): void {
  const positive = candidates,
    inputIds = [...new Set(positive.flatMap((c) => c.inputIds))];
  if (
    !trace ||
    !e.target ||
    !e.geometry ||
    inputIds.length < 2 ||
    positive.some((c) => c.inputIds.length !== 1)
  )
    return;
  const stream = deriveStreamInputEvidence(e, map, trace),
    policy = STREAM_INPUT_POLICY;
  if (
    stream.status === "unavailable" ||
    stream.status === "not-stream" ||
    stream.phaseAlternatives?.some((a) => a.active)
  )
    return;
  const at = map.hitObjects.findIndex(
      (o) => o.id === e.targetId || (o instanceof Slider && o.head.id === e.targetId)
    ),
    target = map.getHitObject(e.targetId),
    preceding = map.hitObjects.slice(Math.max(0, at - policy.recentPhaseAnchorCount), at);
  if (
    !(target instanceof HitCircle) ||
    preceding.length !== policy.recentPhaseAnchorCount ||
    preceding.some((o) => !(o instanceof HitCircle) || !!o.sliderId)
  )
    return;
  const notes = [...(preceding as HitCircle[]), target],
    intervals = notes.slice(1).map((o, k) => o.hitTime - notes[k].hitTime),
    interval = Math.min(...intervals);
  if (
    !(interval > 0) ||
    Math.max(...intervals) > policy.maximumIntervalMs ||
    Math.max(...intervals) / interval > policy.maximumIntervalRatio ||
    notes
      .slice(1)
      .some(
        (o, k) =>
          Math.hypot(o.position.x - notes[k].position.x, o.position.y - notes[k].position.y) /
            Math.min(o.radius, notes[k].radius) >
          policy.maximumSpacingR
      )
  )
    return;
  const rows = preceding.map((o) =>
    stream.assignments.filter((a) => a.componentId === o.id && a.relation === "matched")
  );
  if (
    rows.some(
      (r) =>
        r.length !== 1 ||
        !r[0].inputId ||
        !Number.isFinite(r[0].offsetMs) ||
        r[0].confidence === "ambiguous" ||
        r[0].competingClaims?.length ||
        r[0].competingEvidence?.length
    )
  )
    return;
  const inputs = rows.map((r, k) => {
    const own = deriveCircleEvidence(trace, map, preceding[k].id),
      item = own.inputs.find((i) => i.record.id === r[0].inputId);
    if (
      own.status !== "supported" ||
      own.limits.truncated ||
      Object.values(own.dependencies).some((d) => d.status !== "complete") ||
      !item?.freshActionsKnown ||
      !item.inLiveSuccess ||
      item.postTerminal ||
      item.record.freshActions.length !== 1 ||
      item.record.timeMs - (preceding[k] as HitCircle).hitTime !== r[0].offsetMs ||
      (r[0].confidence !== "anchored" &&
        (!r[0].geometry ||
          !Number.isFinite(r[0].geometry.minimumSampledR) ||
          r[0].geometry.minimumSampledR > policy.maximumSampledDistanceR))
    )
      return;
    return item;
  });
  if (inputs.some((i) => !i) || inputs.filter((i) => i!.inside).length < 2) return;
  const offsets = rows.map((r) => r[0].offsetMs!).sort((a, b) => a - b),
    phase = offsets[offsets.length >>> 1];
  if (
    offsets.some((o) => Math.abs(o - phase) > interval * policy.anchorConsistencyFraction) ||
    inputs
      .slice(1)
      .some(
        (i, k) =>
          Math.abs(i!.record.timeMs - inputs[k]!.record.timeMs - intervals[k]) >
          interval * policy.maximumResidualFraction
      )
  )
    return;
  const attempts = inputIds
    .map((id) => e.inputs.find((i) => i.record.id === id))
    .sort((a, b) => (a?.record.sequence ?? 0) - (b?.record.sequence ?? 0));
  if (
    attempts.some(
      (i) =>
        !i || !i.freshActionsKnown || !i.inLiveSuccess || i.postTerminal || i.record.freshActions.length !== 1
    )
  )
    return;
  let index = sourceIndexes.get(trace);
  if (!index) {
    const all = trace.records.filter((r): r is InputRecord => r.kind === "input");
    index = { inputs: all, positions: new Map(all.map((r, k) => [r.id, k])) };
    sourceIndexes.set(trace, index);
  }
  const pulses = [...inputs.map((i) => i!.record), ...attempts.map((i) => i!.record)],
    first = index.positions.get(pulses[0].id),
    last = index.positions.get(pulses[pulses.length - 1].id);
  if (
    first === undefined ||
    last === undefined ||
    first < 1 ||
    last - first > 4096 ||
    pulses.some((q, k) => k > 0 && q.sequence <= pulses[k - 1].sequence)
  )
    return;
  const run = index.inputs.slice(first - 1, last + 1),
    pulseIds = new Set(pulses.map((q) => q.id));
  if (
    run
      .slice(1)
      .filter((q) => q.freshActions.length)
      .map((q) => q.id)
      .join("|") !== pulses.map((q) => q.id).join("|")
  )
    return;
  for (let k = 0; k < run.length; k++) {
    const q = run[k],
      previous = run[k - 1];
    if (
      q.source.origin !== "parsed" ||
      q.source.discontinuityBefore?.length ||
      ![q.timeMs, q.position.x, q.position.y].every(Number.isFinite) ||
      !Number.isSafeInteger(q.source.parsedFrameIndex) ||
      q.source.parsedFrameIndex < 0 ||
      q.actions.some((a) => a !== 0 && a !== 1) ||
      new Set(q.actions).size !== q.actions.length ||
      q.previousActions.some((a) => a !== 0 && a !== 1) ||
      new Set(q.previousActions).size !== q.previousActions.length ||
      new Set(q.freshActions).size !== q.freshActions.length ||
      !same(
        q.freshActions,
        q.actions.filter((a) => !q.previousActions.includes(a))
      ) ||
      (pulseIds.has(q.id) && q.freshActions.length !== 1) ||
      (q.rawButtonMask !== undefined &&
        (!Number.isSafeInteger(q.rawButtonMask) ||
          q.rawButtonMask < 0 ||
          q.rawButtonMask > 31 ||
          !same(q.actions, [...(q.rawButtonMask & 5 ? [0] : []), ...(q.rawButtonMask & 10 ? [1] : [])])))
    )
      return;
    if (
      previous &&
      (previous.source.origin !== "parsed" ||
        q.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
        q.timeMs < previous.timeMs ||
        q.timeMs - previous.timeMs > interval * policy.maximumLocalSampleGapFraction ||
        !same(q.previousActions, previous.actions) ||
        (q.timeMs === previous.timeMs &&
          (q.position.x !== previous.position.x || q.position.y !== previous.position.y)) ||
        ((q.source.rawTokenIndex !== undefined || previous.source.rawTokenIndex !== undefined) &&
          (q.source.rawTokenIndex === undefined ||
            previous.source.rawTokenIndex === undefined ||
            q.source.rawTokenIndex !== previous.source.rawTokenIndex + 1)))
    )
      return;
  }
  const continuing = attempts.filter(
    (i) =>
      Math.abs(i!.record.timeMs - target.hitTime - phase) <= interval * policy.maximumResidualFraction &&
      Math.abs(
        i!.record.timeMs - inputs[inputs.length - 1]!.record.timeMs - intervals[intervals.length - 1]
      ) <=
        intervals[intervals.length - 1] * policy.maximumResidualFraction
  );
  if (continuing.length !== 1) return;
  const targetRows = stream.assignments.filter(
    (row) => row.componentId === e.targetId && row.relation === "matched"
  );
  const targetRow = targetRows.length === 1 ? targetRows[0] : undefined;
  const explicitContinuation =
    targetRow?.inputId === continuing[0]!.record.id &&
    targetRow.confidence !== "ambiguous" &&
    targetRow.basis === "cadence" &&
    !targetRow.competingClaims?.length &&
    !targetRow.competingEvidence?.length &&
    Number.isFinite(targetRow.phaseMs) &&
    Math.abs(targetRow.phaseMs! - phase) <= interval * policy.anchorConsistencyFraction &&
    stream.relevantInputIds.length === 1 &&
    stream.relevantInputIds[0] === targetRow.inputId;
  if (
    !explicitContinuation &&
    attempts.some((i) => i !== continuing[0] && i!.record.sequence < continuing[0]!.record.sequence)
  )
    return;
  const eventIds = [
    ...new Set([
      ...run.map((q) => q.id),
      ...rows.flatMap((r) => r[0].eventIds),
      ...(explicitContinuation ? targetRow!.eventIds : []),
    ]),
  ];
  for (const candidate of positive) {
    const input = attempts.find((i) => i!.record.id === candidate.inputIds[0])!;
    (candidate.roleEvidence ??= {}).context = {
      role:
        input === continuing[0]
          ? "cadence-continuation"
          : input!.record.sequence < continuing[0]!.record.sequence
          ? "earlier-alternative"
          : "failed-recovery",
      phaseMs: phase,
      residualMs: input!.record.timeMs - target.hitTime - phase,
      eventIds,
    };
    if (candidate.support) candidate.support.context = candidate.roleEvidence.context;
    candidate.eventIds = [...new Set([...candidate.eventIds, ...eventIds])];
  }
}
