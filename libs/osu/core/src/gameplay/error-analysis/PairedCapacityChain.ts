import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { isOwnedReplayTrace } from "../trace/ReplayTraceCollector";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { StableSliderTiming } from "../StableSliderTiming";
import { stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { completeCircle } from "./BoundedCircleRetiming";
import { errorCapabilities } from "./ErrorCapabilities";
import { InitiatingChain, rejectedInitiatingTraceIndex } from "./InterceptionChain";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import { rankSupportedPrimaryCandidates } from "./PrimaryDiagnosisPolicy";
import { certifyPrimaryOpportunity } from "./PrimaryOpportunity";
import { correctionRoutingHorizon, stableHoldHeadRouting } from "./StableHoldPreservation";
import { STREAM_INPUT_POLICY } from "./StreamInputEvidence";

type Attempt = Extract<ReplayTraceRecord, { kind: "attempt" }>;
type Selection = Extract<ReplayTraceRecord, { kind: "selection" }>;
type Policy = Extract<ReplayTraceRecord, { kind: "policy" }>;
type Receipt = Extract<ReplayTraceRecord, { kind: "resolution" }>;
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v) => b.includes(v));
const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y),
    m = b.length >>> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const grade = (offset: number, w: readonly number[]) =>
  Math.abs(offset) <= w[0] ? 3 : Math.abs(offset) <= w[1] ? 2 : Math.abs(offset) <= w[2] ? 1 : 0;
const result = (offset: number, w: readonly number[]) => ["MISS", "MEH", "OK", "GREAT"][grade(offset, w)];

const sequenceIntegrity = new WeakMap<ReplayTrace, boolean>();
function validRecordSequence(trace: ReplayTrace, index: ReturnType<typeof rejectedInitiatingTraceIndex>): boolean {
  const owned = isOwnedReplayTrace(trace);
  const cached = owned ? sequenceIntegrity.get(trace) : undefined;
  if (cached !== undefined) return cached;
  const valid = !trace.records.some(
    (r, k) =>
      index.byId.get(r.id) !== r || !Number.isSafeInteger(r.sequence) || r.sequence !== k || !Number.isFinite(r.timeMs),
  );
  if (owned) sequenceIntegrity.set(trace, valid);
  return valid;
}

export interface PairedCapacityProof {
  basis: "unchanged-two-action-stable-suffix";
  inputId: string;
  capacity: 2;
  actual: { ordinal: number; componentId: string; result: string; receiptId: string }[];
  hypothetical: { ordinal: number; componentId: string; result: string; offsetMs: number }[];
  rootCorrection: { inputId: string; sampleId: string; componentId: string; result: string; beforeResult: string };
  anchors: {
    firstId: string;
    secondId: string;
    phaseMs: number;
    widthMs: number;
    inputIds: string[];
    eventIds: string[];
  }[];
  phaseMs: number;
  residualMs: number;
  sourceSpan: { startInputId: string; endInputId: string; frameCount: number };
  recovery: { throughTerminalId: string; nextInputId: string; noOtherFreshBeforeTerminal: true };
}
/** Actual callback ordinal packet, never reconstructed receipts. */
export function stableCirclePacket(trace: ReplayTrace, q: InputRecord) {
  const index = rejectedInitiatingTraceIndex(trace),
    at = index.inputPositions.get(q.id);
  if (at === undefined || index.byId.get(q.id) !== q || q.freshActions.length < 1 || q.freshActions.length > 2) return;
  const next = index.inputs[at + 1],
    records =
      isOwnedReplayTrace(trace) && validRecordSequence(trace, index)
        ? trace.records.slice(q.sequence + 1, next?.sequence ?? trace.records.length)
        : trace.records.filter((r) => r.sequence > q.sequence && r.sequence < (next?.sequence ?? Infinity)),
    attempts = records.filter((r): r is Attempt => r.kind === "attempt" && r.inputId === q.id);
  if (
    attempts.length !== q.freshActions.length ||
    records.some(
      (r) =>
        (r.kind === "attempt" && r.inputId !== q.id) ||
        ((r.kind === "selection" || r.kind === "policy") && !attempts.some((a) => a.id === r.attemptId)) ||
        (r.kind === "resolution" &&
          (r.mechanism === "successful-input" || r.mechanism === "input-miss") &&
          !attempts.some((a) => a.id === r.triggerAttemptId)),
    )
  )
    return;
  const rows: { attempt: Attempt; selection: Selection; policy?: Policy; receipt?: Receipt; eventIds: string[] }[] = [];
  let previous = q.sequence;
  for (let k = 0; k < attempts.length; k++) {
    const a = attempts[k],
      routes = records.filter((r) => (r.kind === "selection" || r.kind === "policy") && r.attemptId === a.id),
      s = routes[0],
      p = routes[1],
      receipts = records.filter((r): r is Receipt => r.kind === "resolution" && r.triggerAttemptId === a.id),
      r = receipts[0];
    if (
      a.automated ||
      a.attemptOrdinal !== k ||
      a.timeMs !== q.timeMs ||
      a.sequence <= previous ||
      !same(a.actionCandidates, q.freshActions) ||
      (q.freshActions.length === 2
        ? a.knownAction !== undefined
        : a.knownAction !== undefined && a.knownAction !== q.freshActions[0]) ||
      s?.kind !== "selection" ||
      s.timeMs !== q.timeMs ||
      s.sequence <= a.sequence ||
      receipts.length > 1
    )
      return;
    if (s.componentId === null) {
      if (
        routes.length !== 1 ||
        s.component !== undefined ||
        s.inside !== null ||
        s.eligible ||
        s.selectionStopped ||
        r
      )
        return;
    } else if (
      routes.length !== 2 ||
      s.component !== "circle" ||
      !s.inside ||
      !s.eligible ||
      !s.selectionStopped ||
      p?.kind !== "policy" ||
      p.branch !== "stable:STABLE" ||
      p.componentId !== s.componentId ||
      p.timeMs !== q.timeMs ||
      p.sequence <= s.sequence ||
      (p.state === "rejected" && (r || !p.blockerId)) ||
      (p.state === "allowed" && p.blockerId !== undefined) ||
      p.state === "not-queried"
    )
      return;
    if (
      r &&
      (p?.kind !== "policy" ||
        r.component !== "circle" ||
        r.componentId !== s.componentId ||
        !r.previousUnresolved ||
        r.triggerAttemptId !== a.id ||
        r.sequence <= p.sequence ||
        r.timeMs !== q.timeMs)
    )
      return;
    previous = r?.sequence ?? routes[routes.length - 1].sequence;
    rows.push({
      attempt: a,
      selection: s,
      policy: p?.kind === "policy" ? p : undefined,
      receipt: r,
      eventIds: [a.id, ...routes.map((v) => v.id), ...(r ? [r.id] : [])],
    });
  }
  return rows;
}

/** Stable-only two-capacity consumption shift. Root role comes from prior
 * observed success pairs; a working repair alone does not establish that role. */
export function derivePairedCapacityChain(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  excluded: ReadonlySet<string> = new Set(),
): (InitiatingChain & { pairedCapacity: PairedCapacityProof }) | undefined {
  const caps = errorCapabilities(map, trace.identity.analysisProfileId),
    index = rejectedInitiatingTraceIndex(trace),
    w = stableHitWindowsForOD(map.stableOverallDifficulty),
    ti = map.hitObjects.findIndex((o) => o.id === e.targetId),
    ri = ti - 2,
    root = map.hitObjects[ri],
    receiver = map.hitObjects[ti - 1],
    target = map.hitObjects[ti];
  if (
    trace.identity.analysisProfileId !== "stable" ||
    trace.droppedRecordBoundary !== undefined ||
    caps.aim !== "manual" ||
    caps.tapping !== "manual" ||
    caps.scoring !== "supported" ||
    caps.geometry !== "supported" ||
    !completeCircle(e) ||
    e.terminal?.mechanism !== "automatic-expiry" ||
    e.terminal.result !== "MISS" ||
    e.directRejections.length ||
    JSON.stringify(e.identity) !== JSON.stringify(trace.identity) ||
    ti > 4096 ||
    ri < 2 * STREAM_INPUT_POLICY.recentPhaseAnchorCount + 1 ||
    ![root, receiver, target].every((o) => o instanceof HitCircle && !o.sliderId) ||
    !validRecordSequence(trace, index)
  )
    return;
  const components = new Set<string>(),
    ids = new Set<string>(),
    add = (...a: string[]) => a.forEach((id) => ids.add(id));
  const prepared = (o: HitCircle) => {
    components.add(o.id);
    const ce = deriveCircleEvidence(trace, map, o.id),
      g = ce.geometry;
    if (
      !completeCircle(ce) ||
      JSON.stringify(ce.identity) !== JSON.stringify(trace.identity) ||
      !g ||
      ce.target?.hitTimeMs !== o.hitTime ||
      ce.target.spawnTimeMs !== o.spawnTime ||
      g.profile !== "stable" ||
      g.position.x !== o.position.x ||
      g.position.y !== o.position.y ||
      g.radius !== Math.fround(stableGameplayRadius(o.radius)) ||
      g.hitWindows.length !== w.length ||
      g.hitWindows.some((v, k) => v !== w[k])
    )
      return;
    add(ce.terminal!.id);
    return ce;
  };
  const receipt = (o: HitCircle) => {
    const ce = prepared(o),
      r = ce?.terminal,
      a = r && index.byId.get(r.triggerAttemptId ?? ""),
      q = a?.kind === "attempt" ? index.byId.get(a.inputId) : undefined;
    if (
      !ce ||
      r?.kind !== "resolution" ||
      r.mechanism !== "successful-input" ||
      r.result === "MISS" ||
      q?.kind !== "input" ||
      !stableWithinHitRadius(o.position, q.position, stableGameplayRadius(o.radius))
    )
      return;
    const d = stableCirclePacket(trace, q)?.find((v) => v.attempt.id === a!.id);
    if (
      !d ||
      d.receipt?.id !== r.id ||
      d.selection.componentId !== o.id ||
      d.policy?.state !== "allowed" ||
      d.policy.offsetMs !== q.timeMs - o.hitTime ||
      d.policy.timingResult !== result(q.timeMs - o.hitTime, w) ||
      r.result !== d.policy.timingResult
    )
      return;
    add(q.id, ...d.eventIds);
    return { ce, q, d, r };
  };
  const oldRoot = receipt(root as HitCircle),
    oldReceiver = receipt(receiver as HitCircle),
    te = prepared(target as HitCircle);
  if (
    !oldRoot ||
    !oldReceiver ||
    !te ||
    oldRoot.q !== oldReceiver.q ||
    oldRoot.d.attempt.attemptOrdinal !== 0 ||
    oldReceiver.d.attempt.attemptOrdinal !== 1 ||
    oldReceiver.r.result !== "GREAT"
  )
    return;
  const q = oldRoot.q,
    qi = index.inputPositions.get(q.id)!,
    live = te.inputs.find((v) => v.record.id === q.id),
    packet = stableCirclePacket(trace, q);
  if (
    q.freshActions.length !== 2 ||
    !same(q.freshActions, [0, 1]) ||
    packet?.length !== 2 ||
    !live?.freshActionsKnown ||
    !live.inside ||
    !live.inLiveSuccess ||
    live.postTerminal ||
    te.terminal!.sequence <= q.sequence
  )
    return;
  let pi = qi - 1;
  while (pi >= 0 && !index.inputs[pi].freshActions.length) pi--;
  const p = index.inputs[pi],
    rootEvidence = oldRoot.ce,
    pd = p && stableCirclePacket(trace, p),
    first = map.hitObjects[ri - 1],
    current = first instanceof HitCircle && !first.sliderId ? receipt(first) : undefined;
  if (
    !p ||
    pi < 1 ||
    p.timeMs >= q.timeMs ||
    p.freshActions.length !== 1 ||
    pd?.length !== 1 ||
    pd[0].selection.componentId !== null ||
    !current ||
    current.r.result !== "GREAT" ||
    current.q.sequence >= p.sequence ||
    current.q.timeMs > p.timeMs ||
    current.q.freshActions.length !== 1 ||
    current.q.freshActions[0] === p.freshActions[0] ||
    p.timeMs - (root as HitCircle).hitTime >= -w[0] ||
    rootEvidence.directRejections.length
  )
    return;
  add(p.id, ...pd[0].eventIds);
  const anchors: {
    firstId: string;
    secondId: string;
    phaseMs: number;
    widthMs: number;
    inputIds: string[];
    eventIds: string[];
  }[] = [];
  for (let j = STREAM_INPUT_POLICY.recentPhaseAnchorCount - 1; j >= 0; j--) {
    const a = map.hitObjects[ri - 3 - 2 * j],
      b = map.hitObjects[ri - 2 - 2 * j];
    if (!(a instanceof HitCircle) || a.sliderId || !(b instanceof HitCircle) || b.sliderId) return;
    const ar = receipt(a),
      br = receipt(b);
    if (
      !ar ||
      !br ||
      ar.r.result !== "GREAT" ||
      br.q.timeMs - b.hitTime >= -w[0] ||
      br.r.sequence >= current.r.sequence ||
      br.r.sequence <= ar.r.sequence ||
      br.q.timeMs < ar.q.timeMs
    )
      return;
    anchors.push({
      firstId: a.id,
      secondId: b.id,
      phaseMs: br.q.timeMs - b.hitTime,
      widthMs: br.q.timeMs - ar.q.timeMs,
      inputIds: [...new Set([ar.q.id, br.q.id])],
      eventIds: [ar.q.id, br.q.id, ...ar.d.eventIds, ...br.d.eventIds],
    });
  }
  const notes = map.hitObjects.slice(ri - 2 * anchors.length - 1, ti + 1);
  if (notes.some((o) => !(o instanceof HitCircle) || o.sliderId)) return;
  const intervals = notes.slice(1).map((o, k) => (o as HitCircle).hitTime - (notes[k] as HitCircle).hitTime),
    interval = median(intervals),
    phaseMs = median(anchors.map((a) => a.phaseMs)),
    widthMs = median(anchors.map((a) => a.widthMs)),
    residualMs = p.timeMs - (root as HitCircle).hitTime - phaseMs;
  if (
    !(Math.min(...intervals) > 3) ||
    Math.max(...intervals) > STREAM_INPUT_POLICY.maximumIntervalMs ||
    Math.max(...intervals) / Math.min(...intervals) > STREAM_INPUT_POLICY.maximumIntervalRatio ||
    anchors.some(
      (a) =>
        a.widthMs > interval * STREAM_INPUT_POLICY.minimumAlternativeMarginFraction ||
        Math.abs(a.phaseMs - phaseMs) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction,
    ) ||
    Math.abs(residualMs) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction ||
    p.timeMs - current.q.timeMs > interval * STREAM_INPUT_POLICY.minimumAlternativeMarginFraction ||
    Math.abs(p.timeMs - current.q.timeMs - widthMs) > interval * STREAM_INPUT_POLICY.anchorConsistencyFraction
  )
    return;
  const firstAt = index.inputPositions.get(anchors[0].inputIds[0])!,
    lastAt = index.inputs.findIndex((v) => v.sequence > te.terminal!.sequence),
    span = index.inputs.slice(Math.max(0, firstAt - 1), lastAt + 1),
    allowed = new Set([...anchors.flatMap((a) => a.inputIds), current.q.id, p.id, q.id]);
  if (
    firstAt < 1 ||
    lastAt < qi ||
    lastAt - firstAt > 4096 ||
    span.some((v) => v.sequence <= te.terminal!.sequence && v.freshActions.length && !allowed.has(v.id))
  )
    return;
  for (let k = 0; k < span.length; k++) {
    const v = span[k],
      prev = span[k - 1],
      src = v.source;
    if (
      src.origin !== "parsed" ||
      !Number.isSafeInteger(src.parsedFrameIndex) ||
      src.parsedFrameIndex < 0 ||
      src.discontinuityBefore?.length ||
      ![v.timeMs, v.position.x, v.position.y].every(Number.isFinite) ||
      [v.actions, v.previousActions, v.freshActions].some(
        (a) => a.some((n) => n !== 0 && n !== 1) || new Set(a).size !== a.length,
      ) ||
      !same(
        v.freshActions,
        v.actions.filter((a) => !v.previousActions.includes(a)),
      ) ||
      (v.rawButtonMask !== undefined &&
        (!Number.isSafeInteger(v.rawButtonMask) ||
          v.rawButtonMask < 0 ||
          v.rawButtonMask > 31 ||
          !same(v.actions, [...(v.rawButtonMask & 5 ? [0] : []), ...(v.rawButtonMask & 10 ? [1] : [])]))) ||
      (src.rawTokenIndex !== undefined && (!Number.isSafeInteger(src.rawTokenIndex) || src.rawTokenIndex < 0)) ||
      (prev &&
        (prev.source.origin !== "parsed" ||
          src.parsedFrameIndex !== prev.source.parsedFrameIndex + 1 ||
          v.timeMs <= prev.timeMs ||
          v.timeMs - prev.timeMs > interval * STREAM_INPUT_POLICY.maximumLocalSampleGapFraction ||
          !same(v.previousActions, prev.actions) ||
          ((src.rawTokenIndex !== undefined || prev.source.rawTokenIndex !== undefined) &&
            (src.rawTokenIndex === undefined ||
              prev.source.rawTokenIndex === undefined ||
              src.rawTokenIndex !== prev.source.rawTokenIndex + 1))))
    )
      return;
    add(v.id);
  }
  const comparison = comparePrimaryApproaches(
      rootEvidence,
      map,
      { pressIds: [p.id], end: { timeMs: q.timeMs, sequence: q.sequence, inclusive: false } },
      trace,
      excluded,
    ),
    early = comparison.candidates.find(
      (c) => c.code === "early-tap" && c.inputIds.length === 1 && c.inputIds[0] === p.id,
    );
  if (
    !early?.support?.correction ||
    !early.attribution?.tapCorrection ||
    comparison.approaches.episodes[0]?.status !== "supported"
  )
    return;
  const candidates = rootEvidence.inputs.filter(
    (v) =>
      v.inside &&
      v.inLiveSuccess &&
      !v.postTerminal &&
      v.freshActionsKnown &&
      !v.record.freshActions.length &&
      v.record.sequence > p.sequence &&
      v.record.sequence < q.sequence &&
      grade(v.record.timeMs - (root as HitCircle).hitTime, w) >= grade(q.timeMs - (root as HitCircle).hitTime, w),
  );
  // Minimise edited existing frames; causal-role selection was established above.
  let correction: ReturnType<typeof certifyPrimaryOpportunity>;
  for (const s of candidates) {
    correction = certifyPrimaryOpportunity(
      rootEvidence,
      map,
      trace,
      p.id,
      [s.record.id],
      "sampled-pass-tap",
      [...ids, ...early.eventIds],
      excluded,
    );
    if (correction) break;
  }
  if (!correction || !correction.holdPreservation?.history?.converged || correction.relocatedRelease) return;
  const si = index.inputPositions.get(correction.sampleId)!,
    horizon = correctionRoutingHorizon(map, trace, index.inputs, si, (root as HitCircle).id);
  if (!horizon || horizon.terminal.sequence < te.terminal!.sequence) return;
  add(...correction.eventIds, ...horizon.eventIds);
  for (const o of map.hitObjects)
    if (o instanceof Slider && o.head.spawnTime <= horizon.terminal.timeMs) {
      const routing = stableHoldHeadRouting(o, trace, index.inputs, pi, pi, si, (root as HitCircle).id, horizon);
      if (!routing) return;
      components.add(o.id);
      components.add(o.head.id);
      add(...routing);
    }
  const circles = map.hitObjects.flatMap((o) => (o instanceof HitCircle ? [o] : o instanceof Slider ? [o.head] : []));
  for (const c of circles) if (c.spawnTime <= q.timeMs && !index.activations.has(c.id)) return;
  circles.sort(
    (a, b) => (index.activations.get(a.id)?.sequence ?? Infinity) - (index.activations.get(b.id)?.sequence ?? Infinity),
  );
  const select = (resolved: ReadonlySet<string>) => {
    for (const c of circles) {
      if (c.spawnTime > q.timeMs) continue;
      const activation = index.activations.get(c.id)!,
        terminal = index.terminals.get(c.id),
        parentEnd = index.terminals.get(c.sliderId ?? c.id);
      components.add(c.id);
      add(activation.id);
      if (terminal) add(terminal.id);
      if (parentEnd) add(parentEnd.id);
      if (
        activation.sequence >= q.sequence ||
        resolved.has(c.id) ||
        (terminal && terminal.sequence < q.sequence) ||
        (c.sliderId && parentEnd && parentEnd.sequence < q.sequence) ||
        q.timeMs > c.hitTime + w[2] + 1
      )
        continue;
      if (stableWithinHitRadius(c.position, q.position, stableGameplayRadius(c.radius))) return c;
    }
    return;
  };
  const allowedPolicy = (c: HitCircle, resolved: ReadonlySet<string>) => {
    for (const o of map.hitObjects) {
      if (o.id === (c.sliderId ?? c.id)) return true;
      components.add(o.id);
      const terminal = index.terminals.get(o.id);
      if (terminal) add(terminal.id);
      if (resolved.has(o.id) || (terminal && terminal.sequence < q.sequence)) continue;
      const end =
        o instanceof HitCircle ? o.hitTime : o instanceof Slider ? new StableSliderTiming(o).endTime : o.endTime;
      if (end + 3 < c.hitTime) return false;
    }
    return false;
  };
  for (const initial of [new Set<string>(), new Set([(root as HitCircle).id])]) {
    const expected = initial.size ? [receiver, target] : [root, receiver];
    for (const o of expected) {
      const selected = select(initial);
      if (selected !== o || !allowedPolicy(selected, initial) || !grade(q.timeMs - selected.hitTime, w)) return;
      initial.add(selected.id);
    }
  }
  if (
    [...components].some(
      (id) =>
        excluded.has(id) ||
        [...trace.failures, ...trace.domain.sourceCoverageLimits].some(
          (s) => s.startsWith("dependency-conflict:") && s.endsWith(":" + id),
        ),
    )
  )
    return;
  // The capacity repair establishes the chain; the shown tapping diagnosis
  // retains its independently certified correction inside the 300 window.
  const supported = {
      ...early,
      support: {
        ...early.support,
        context: {
          role: "cadence-continuation" as const,
          phaseMs,
          residualMs,
          eventIds: anchors.flatMap((a) => a.eventIds),
        },
      },
    },
    ranked = rankSupportedPrimaryCandidates([...comparison.candidates.filter((c) => c !== early), supported], [p.id]);
  if (!ranked.selected.some((c) => c.code === "early-tap")) return;
  return {
    pairedCapacity: {
      basis: "unchanged-two-action-stable-suffix",
      inputId: q.id,
      capacity: 2,
      actual: packet!.map((v) => ({
        ordinal: v.attempt.attemptOrdinal,
        componentId: v.selection.componentId!,
        result: v.receipt!.result,
        receiptId: v.receipt!.id,
      })),
      hypothetical: [receiver, target].map((o, ordinal) => ({
        ordinal,
        componentId: o.id,
        result: result(q.timeMs - (o as HitCircle).hitTime, w),
        offsetMs: q.timeMs - (o as HitCircle).hitTime,
      })),
      rootCorrection: {
        inputId: p.id,
        sampleId: correction.sampleId,
        componentId: root.id,
        result: result(correction.timeMs - (root as HitCircle).hitTime, w),
        beforeResult: oldRoot.r.result,
      },
      anchors,
      phaseMs,
      residualMs,
      sourceSpan: { startInputId: span[0].id, endInputId: span[span.length - 1].id, frameCount: span.length },
      recovery: {
        throughTerminalId: te.terminal!.id,
        nextInputId: span[span.length - 1].id,
        noOtherFreshBeforeTerminal: true,
      },
    },
    rootComponentId: (root as HitCircle).id,
    rootInputId: p.id,
    rootComparison: { ...comparison, candidates: ranked.candidates, ranking: ranked },
    causes: ranked.selected,
    componentIds: [...components],
    eventIds: [...ids, ...ranked.comparisonEventIds],
    links: [{ targetId: target.id, receiverId: (receiver as HitCircle).id, inputId: q.id, precedingInputId: p.id }],
    additionalInputIds: [q.id],
    additionalInputEvidence: [
      {
        inputId: q.id,
        receiverId: (receiver as HitCircle).id,
        kind: "next-slot-success",
        eventIds: packet!.flatMap((v) => v.eventIds),
      },
    ],
    basis: "bounded-cadence-and-model-dispatch",
  };
}
