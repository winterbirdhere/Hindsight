import { hitWindowsForOD } from "@osujs/math";
import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { CircleEvidence, deriveCircleEvidence, InputRecord } from "../miss-explanation/CircleEvidence";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { nativeWithinHitRadius, stableGameplayRadius, stableWithinHitRadius } from "../StableHitGeometry";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { derivePreterminalReceiverRejection } from "./PreterminalReceiverRejection";
import { errorCapabilities } from "./ErrorCapabilities";
import { analyzePrimaryApproaches } from "./PrimaryApproach";
import { certifyStableAimPreservation, StableAimPreservation } from "./StableAimPreservation";
import { certifyTimingHoldPreservation, TimingHoldCertificate } from "./TimingHoldPreservation";
import { certifyAimHeadRouting } from "./StableHoldPreservation";
import { certifyCanonicalControl, CanonicalControl } from "./CanonicalReplayVerifier";

/** Model correction opportunity; not an observed successful target receipt. */
export interface PrimaryOpportunity {
  kind: "same-time-aim" | "sampled-pass-tap";
  inputId: string;
  sampleId: string;
  timeMs: number;
  eventIds: string[];
  /** When delaying beyond its old release, both endpoints move using existing
   * frames. The next frame is already key-up, preserving every other pulse. */
  relocatedRelease?: { originalReleaseId: string; releaseId: string; timeMs: number };
  trackingPreservation?: StableAimPreservation[];
  holdPreservation?: TimingHoldCertificate;
  headRoutingPreservation?: { componentId: string; eventIds: string[] }[];
  canonicalControl?: CanonicalControl;
  /** Every preceding parent was checked. Retain the maximal sequence witness
   * and prefix boundary rather than copying O(prefix length) IDs per candidate. */
  prefix: {
    parentCount: number;
    throughComponentId?: string;
    latestTerminalId?: string;
    basis?: "canonical-causal-routing";
  };
}
const indexes = new WeakMap<ReplayTrace, ReturnType<typeof buildIndex>>();
function buildIndex(trace: ReplayTrace) {
  const records = new Map<string, ReplayTraceRecord>(),
    inputs: InputRecord[] = [],
    positions = new Map<string, number>(),
    activations = new Map<string, ReplayTraceRecord>(),
    terminals = new Map<string, ReplayTraceRecord>(),
    attempts = new Map<string, Extract<ReplayTraceRecord, { kind: "attempt" }>[]>(),
    consumed = new Set<string>();
  let invalid = trace.records.length > trace.limits.maxRecords,
    sequence = -1;
  for (const r of trace.records) {
    if (
      records.has(r.id) ||
      !Number.isSafeInteger(r.sequence) ||
      r.sequence < 0 ||
      !Number.isFinite(r.timeMs) ||
      r.sequence <= sequence
    )
      invalid = true;
    sequence = r.sequence;
    records.set(r.id, r);
    if (r.kind === "input") {
      positions.set(r.id, inputs.length);
      inputs.push(r);
    }
    if (r.kind === "lifecycle" && !activations.has(r.componentId)) activations.set(r.componentId, r);
    if (r.kind === "resolution" || r.kind === "slider-parent" || r.kind === "spinner-resolution")
      terminals.set(r.componentId, r);
    if (r.kind === "attempt") {
      const list = attempts.get(r.inputId) ?? [];
      list.push(r);
      attempts.set(r.inputId, list);
    }
    if (r.kind === "resolution" && r.mechanism === "successful-input" && r.triggerAttemptId) {
      const attempt = records.get(r.triggerAttemptId);
      if (attempt?.kind === "attempt") consumed.add(attempt.inputId);
    }
  }
  return { records, inputs, positions, activations, terminals, attempts, consumed, invalid };
}
const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v) => b.includes(v));

export interface OpportunityRefusal {
  stage: "local" | "canonical";
  reason: string;
  sampleId?: string;
  componentIds?: string[];
}
type Refusals = OpportunityRefusal[] | undefined;
const refuse = (
  rows: Refusals,
  stage: OpportunityRefusal["stage"],
  reason: string,
  sampleId?: string,
  componentIds?: string[]
) => {
  rows?.push({
    stage,
    reason,
    ...(sampleId ? { sampleId } : {}),
    ...(componentIds?.length ? { componentIds } : {}),
  });
};

/** Same sufficient checks as the public certifier, with refusal provenance. */
export function inspectPrimaryOpportunity(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  inputId: string,
  sampleIds: readonly string[],
  kind: PrimaryOpportunity["kind"],
  witnessIds: readonly string[],
  excluded: ReadonlySet<string> = new Set()
) {
  const refusals: OpportunityRefusal[] = [];
  const proof =
    certifyOpportunity(e, map, trace, inputId, sampleIds, kind, witnessIds, excluded, undefined, refusals) ??
    (kind === "same-time-aim"
      ? certifyCanonicalAim(e, map, trace, inputId, witnessIds, excluded, refusals)
      : undefined);
  if (!proof && !sampleIds.length) refuse(refusals, "local", "no-recorded-correction-sample");
  return { proof, refusals };
}

/** Sufficient clear-prefix certificate, deliberately independent of inferred
 * ownership. Hypothetical aim is centered; timing uses an actual inside sample. */
export function certifyPrimaryOpportunity(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  inputId: string,
  sampleIds: readonly string[],
  kind: PrimaryOpportunity["kind"],
  witnessIds: readonly string[],
  excluded: ReadonlySet<string> = new Set()
): PrimaryOpportunity | undefined {
  return (
    certifyOpportunity(e, map, trace, inputId, sampleIds, kind, witnessIds, excluded) ??
    (kind === "same-time-aim" ? certifyCanonicalAim(e, map, trace, inputId, witnessIds, excluded) : undefined)
  );
}

/** A complete canonical replay can prove a related rejection cascade that a
 * local clear-prefix/head shortcut cannot. Geometry still needs its original
 * continuous source witness; the hypothetical repair never supplies a label. */
function certifyCanonicalAim(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  inputId: string,
  witnessIds: readonly string[],
  excluded: ReadonlySet<string>,
  refusals?: OpportunityRefusal[]
): PrimaryOpportunity | undefined {
  if (
    !trace ||
    e.status !== "supported" ||
    e.limits.truncated ||
    !e.target ||
    !e.geometry ||
    e.terminal?.mechanism !== "automatic-expiry" ||
    e.terminal.result !== "MISS" ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    !sameIdentity(e.identity, trace.identity)
  ) {
    refuse(refusals, "canonical", "canonical-evidence-or-identity-unavailable");
    return;
  }
  const object = map.getHitObject(e.targetId),
    at = map.hitObjects.findIndex(
      (o) => o.id === e.targetId || (o instanceof Slider && o.head.id === e.targetId)
    ),
    q = e.inputs.find((i) => i.record.id === inputId);
  let index = indexes.get(trace);
  if (!index) {
    index = buildIndex(trace);
    indexes.set(trace, index);
  }
  if (index.invalid) {
    refuse(refusals, "canonical", "invalid-trace-index");
    return;
  }
  const windows = stableHitWindowsForOD(map.stableOverallDifficulty);
  if (
    !(object instanceof HitCircle) ||
    at < 0 ||
    !q ||
    !q.inLiveSuccess ||
    q.postTerminal ||
    q.inside ||
    !q.freshActionsKnown ||
    q.record.freshActions.length !== 1 ||
    trace.identity.analysisProfileId !== "stable" ||
    JSON.stringify(index.records.get(inputId)) !== JSON.stringify(q.record) ||
    JSON.stringify(index.terminals.get(e.targetId)) !== JSON.stringify(e.terminal) ||
    object.hitTime !== e.target.hitTimeMs ||
    object.spawnTime !== e.target.spawnTimeMs ||
    object.position.x !== e.geometry.position.x ||
    object.position.y !== e.geometry.position.y ||
    e.geometry.profile !== "stable" ||
    e.geometry.radius !== Math.fround(stableGameplayRadius(object.radius)) ||
    e.geometry.hitWindows.length !== windows.length ||
    windows.some((w, k) => w !== e.geometry!.hitWindows[k])
  ) {
    refuse(refusals, "canonical", "canonical-target-press-or-geometry-mismatch");
    return;
  }
  const ids = new Set([inputId, ...witnessIds]),
    points = index.inputs,
    indices = [...ids].flatMap((id) => (index!.positions.has(id) ? [index!.positions.get(id)!] : []));
  if (!indices.length || witnessIds.some((id) => !index!.records.has(id))) {
    refuse(refusals, "canonical", "canonical-witness-unavailable");
    return;
  }
  const first = Math.min(...indices) - 1,
    last = Math.max(...indices) + 1;
  if (first < 0 || last >= points.length || last - first > 4096) {
    refuse(refusals, "canonical", "canonical-source-span-unavailable");
    return;
  }
  for (let k = first; k <= last; k++) {
    const r = points[k],
      p = points[k - 1];
    if (
      r.source.origin !== "parsed" ||
      r.source.discontinuityBefore?.length ||
      (p && r.timeMs === p.timeMs && (r.position.x !== p.position.x || r.position.y !== p.position.y))
    ) {
      refuse(refusals, "canonical", "canonical-source-discontinuity");
      return;
    }
  }
  const attempts = index.attempts.get(inputId) ?? [],
    selection = attempts.length === 1 ? trace.records[attempts[0].sequence + 1] : undefined;
  if (attempts.length !== 1 || selection?.kind !== "selection" || selection.componentId !== null) {
    refuse(refusals, "canonical", "canonical-aim-requires-null-selection");
    return;
  }
  const related = new Set<string>([e.targetId, ...(object.sliderId ? [object.sliderId] : [])]);
  // Each expansion cites an actual target-dependent rejection. A nearby miss,
  // successful consumption or arbitrary later head grants no causal scope.
  for (let pass = 0; pass < 16; pass++) {
    const size = related.size;
    for (const r of trace.records)
      if (
        r.kind === "policy" &&
        r.state === "rejected" &&
        r.blockerId &&
        related.has(r.blockerId) &&
        r.timeMs >= q.record.timeMs &&
        r.timingResult !== "MISS" &&
        r.timingResult !== null
      ) {
        const receiver = map.getHitObject(r.componentId);
        if (!(receiver instanceof HitCircle)) {
          refuse(refusals, "canonical", "canonical-related-receiver-not-circle");
          return;
        }
        related.add(receiver.id);
        if (receiver.sliderId) related.add(receiver.sliderId);
      }
    if (size === related.size) break;
    if (related.size > 32) {
      refuse(refusals, "canonical", "canonical-related-scope-limit");
      return;
    }
  }
  // The control changes one cursor point and no action. A recorded pending
  // earlier circle either remains a Stable blocker, or the edited point selects
  // an earlier component. The latter cannot certify either: every earlier
  // component is outside the related scope, whose dispatch must stay identical.
  // Missing lifecycle evidence falls through to the full verifier. This is only
  // a necessary negative check, never a replacement positive certificate.
  const prefix = map.hitObjects.slice(0, at);
  const unrelatedPrefix = prefix.every(
    (parent) => !related.has(parent.id) && !(parent instanceof Slider && related.has(parent.head.id))
  );
  if (
    unrelatedPrefix &&
    prefix.some((parent) => {
      if (!(parent instanceof HitCircle) || parent.sliderId || parent.hitTime + 3 >= object.hitTime)
        return false;
      const activation = index!.activations.get(parent.id),
        terminal = index!.terminals.get(parent.id);
      return (
        activation?.kind === "lifecycle" &&
        activation.component === "circle" &&
        activation.transition === "activated" &&
        activation.sequence < attempts[0].sequence &&
        activation.timeMs <= q.record.timeMs &&
        terminal?.kind === "resolution" &&
        terminal.component === "circle" &&
        terminal.previousUnresolved &&
        terminal.sequence > attempts[0].sequence &&
        terminal.timeMs >= q.record.timeMs
      );
    })
  ) {
    refuse(refusals, "canonical", "canonical-control-not-certified");
    return;
  }
  const correction = certifyCanonicalControl(
    map,
    trace,
    {
      targetId: e.targetId,
      relatedComponentIds: [...related],
      changes: [{ inputId, position: object.position }],
    },
    excluded
  );
  if (!correction) {
    refuse(refusals, "canonical", "canonical-control-not-certified");
    return;
  }
  return {
    kind: "same-time-aim",
    inputId,
    sampleId: inputId,
    timeMs: q.record.timeMs,
    canonicalControl: correction,
    prefix: {
      parentCount: at,
      throughComponentId: map.hitObjects[at - 1]?.id,
      basis: "canonical-causal-routing",
    },
    eventIds: [...new Set([...witnessIds, ...correction.eventIds])],
  };
}
const sameIdentity = (a: CircleEvidence["identity"], b: ReplayTrace["identity"]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The virtual resolution is private and only supplied after the distinct
 * predecessor correction and both selector queries below have been proved. */
function certifyOpportunity(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  inputId: string,
  sampleIds: readonly string[],
  kind: PrimaryOpportunity["kind"],
  witnessIds: readonly string[],
  excluded: ReadonlySet<string>,
  correctedParent?: { id: string; sequence: number },
  refusals?: OpportunityRefusal[]
): PrimaryOpportunity | undefined {
  if (
    !trace ||
    e.status !== "supported" ||
    e.limits.truncated ||
    !e.target ||
    !e.geometry ||
    !e.terminal ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    Object.keys(trace.identity).length !== Object.keys(e.identity).length ||
    Object.entries(e.identity).some(([k, v]) => trace.identity[k as keyof typeof trace.identity] !== v)
  ) {
    refuse(refusals, "local", "evidence-dependency-or-identity-unavailable");
    return;
  }
  let index = indexes.get(trace);
  if (!index) {
    index = buildIndex(trace);
    indexes.set(trace, index);
  }
  if (index.invalid) {
    refuse(refusals, "local", "invalid-trace-index");
    return;
  }
  const object = map.getHitObject(e.targetId),
    at = map.hitObjects.findIndex(
      (o) => o.id === e.targetId || (o instanceof Slider && o.head.id === e.targetId)
    );
  if (
    !(object instanceof HitCircle) ||
    at < 0 ||
    at > 4096 ||
    !Number.isFinite(object.hitTime) ||
    !Number.isFinite(object.radius)
  ) {
    refuse(refusals, "local", "target-or-prefix-boundary-unavailable");
    return;
  }
  const stable = e.identity.analysisProfileId === "stable",
    windows = stable
      ? stableHitWindowsForOD(map.stableOverallDifficulty)
      : hitWindowsForOD(map.difficulty.overallDifficulty, true),
    radius = Math.fround(stable ? stableGameplayRadius(object.radius) : object.radius),
    parent = map.hitObjects[at];
  if (
    e.target.hitTimeMs !== object.hitTime ||
    e.target.spawnTimeMs !== object.spawnTime ||
    e.geometry.profile !== (stable ? "stable" : "lazer") ||
    e.geometry.position.x !== object.position.x ||
    e.geometry.position.y !== object.position.y ||
    e.geometry.radius !== radius ||
    e.geometry.hitWindows.length !== windows.length ||
    e.geometry.hitWindows.some((w, k) => w !== windows[k]) ||
    !(radius > 0)
  ) {
    refuse(refusals, "local", "prepared-geometry-mismatch");
    return;
  }
  const prefix = map.hitObjects.slice(0, at),
    components = [
      object.id,
      parent.id,
      ...prefix.flatMap((o) => (o instanceof Slider ? [o.id, o.head.id] : [o.id])),
    ];
  if (
    components.some(
      (id) =>
        excluded.has(id) ||
        [...trace.failures, ...trace.domain.sourceCoverageLimits].some(
          (s) => s.startsWith("dependency-conflict:") && s.endsWith(":" + id)
        )
    )
  ) {
    refuse(refusals, "local", "excluded-or-conflicting-component");
    return;
  }
  // Both native and Classic Lazer prefer the later equal-time receptor.
  if (
    !stable &&
    map.hitObjects
      .slice(at + 1)
      .some((o) => (o instanceof HitCircle ? o.hitTime : o.startTime) === object.hitTime)
  ) {
    refuse(refusals, "local", "later-equal-time-receptor");
    return;
  }
  const press = e.inputs.find((i) => i.record.id === inputId),
    canonical = index.records.get(inputId),
    attempts = index.attempts.get(inputId) ?? [];
  const tail =
    press && !press.inLiveSuccess && kind === "sampled-pass-tap"
      ? derivePreterminalReceiverRejection(e, map, trace, inputId, excluded)
      : undefined;
  if (
    !press?.freshActionsKnown ||
    (!press.inLiveSuccess && !tail) ||
    press.postTerminal ||
    press.record.freshActions.length !== 1 ||
    canonical?.kind !== "input" ||
    JSON.stringify(canonical) !== JSON.stringify(press.record) ||
    index.consumed.has(inputId) ||
    attempts.length !== 1 ||
    attempts[0].automated ||
    attempts[0].attemptOrdinal !== 0 ||
    !same(attempts[0].actionCandidates, press.record.freshActions) ||
    (attempts[0].knownAction !== undefined && attempts[0].knownAction !== press.record.freshActions[0])
  ) {
    refuse(refusals, "local", "press-consumed-or-dispatch-unusable");
    return;
  }
  const activation = index.activations.get(object.id),
    terminal = index.terminals.get(object.id);
  if (
    !activation ||
    !terminal ||
    terminal.id !== e.terminal.id ||
    !same([terminal.sequence, terminal.timeMs], [e.terminal.sequence, e.terminal.timeMs])
  ) {
    refuse(refusals, "local", "target-lifecycle-mismatch");
    return;
  }
  for (const sampleId of sampleIds) {
    const sample = e.inputs.find((i) => i.record.id === sampleId),
      q = sample?.record;
    if (
      !sample ||
      !q ||
      JSON.stringify(index.records.get(sampleId)) !== JSON.stringify(q) ||
      !sample.inLiveSuccess ||
      sample.postTerminal ||
      !sample.freshActionsKnown ||
      q.timeMs < object.spawnTime ||
      Math.abs(q.timeMs - object.hitTime) >= windows[2] ||
      activation.sequence >= q.sequence ||
      activation.timeMs > q.timeMs ||
      terminal.sequence <= q.sequence ||
      (parent instanceof Slider && (index.terminals.get(parent.id)?.sequence ?? Infinity) <= q.sequence) ||
      (kind === "same-time-aim" && sampleId !== inputId) ||
      (kind === "sampled-pass-tap" &&
        ((q.freshActions.length > 0 && sampleId !== inputId) ||
          !sample.inside ||
          !(stable
            ? stableWithinHitRadius(object.position, q.position, stableGameplayRadius(object.radius))
            : nativeWithinHitRadius(object.position, q.position, radius))))
    ) {
      refuse(refusals, "local", "correction-sample-unusable", sampleId);
      continue;
    }
    const prefixTerminals = prefix.map((o) => index!.terminals.get(o.id));
    if (
      prefixTerminals.some((r, k) =>
        prefix[k].id === correctedParent?.id
          ? correctedParent.sequence >= q.sequence
          : !r || r.sequence >= q.sequence
      )
    ) {
      refuse(
        refusals,
        "local",
        "unresolved-prefix",
        sampleId,
        prefix
          .filter((o, k) =>
            o.id === correctedParent?.id
              ? correctedParent.sequence >= q.sequence
              : !prefixTerminals[k] || prefixTerminals[k]!.sequence >= q.sequence
          )
          .map((o) => o.id)
      );
      continue;
    }
    // A cursor edit changes BOTH adjacent interpolation intervals. Any other
    // long object overlapping them can lose tracking, including one after the
    // target in object order. Its already-terminal state at the press is not
    // enough. The target's own slider parent remains a related consequence.
    const samplePosition = index.positions.get(sampleId)!,
      beforeSample = index.inputs[samplePosition - 1],
      afterSample = index.inputs[samplePosition + 1];
    const trackingPreservation: StableAimPreservation[] = [];
    let headRoutingPreservation: PrimaryOpportunity["headRoutingPreservation"];
    if (kind === "same-time-aim") {
      if (!beforeSample || !afterSample) {
        refuse(refusals, "local", "adjacent-source-samples-unavailable", sampleId);
        continue;
      }
      headRoutingPreservation = certifyAimHeadRouting(
        map,
        trace,
        index.inputs,
        samplePosition,
        parent.id,
        excluded
      );
      if (!headRoutingPreservation) {
        refuse(refusals, "local", "head-routing-preservation-not-certified", sampleId);
        continue;
      }
      const overlaps = map.hitObjects.filter(
        (o) =>
          o.id !== parent.id &&
          !(o instanceof HitCircle) &&
          (stable && o instanceof Slider
            ? o.startTime <= q.timeMs && (index!.terminals.get(o.id)?.sequence ?? Infinity) >= q.sequence
            : o.startTime < afterSample.timeMs && o.endTime > beforeSample.timeMs)
      );
      for (const other of overlaps) {
        const proof =
          stable && other instanceof Slider
            ? certifyStableAimPreservation(
                other,
                trace,
                q,
                afterSample,
                object.position,
                excluded,
                beforeSample
              )
            : undefined;
        if (proof) trackingPreservation.push(proof);
      }
      if (trackingPreservation.length !== overlaps.length) {
        refuse(refusals, "local", "tracking-preservation-not-certified", sampleId);
        continue;
      }
    }
    let relocatedRelease: PrimaryOpportunity["relocatedRelease"];
    let holdPreservation: TimingHoldCertificate | undefined;
    if (kind === "sampled-pass-tap") {
      const originalAt = index.positions.get(inputId)!,
        sampleAt = index.positions.get(sampleId)!,
        action = press.record.freshActions[0];
      // Keep other pulses intact. Delaying past this pulse's release requires
      // an existing key-up frame immediately after the new press, so moving
      // both endpoints neither adds a frame nor merges the next fresh edge.
      if (
        sampleAt < originalAt &&
        index.inputs.slice(Math.max(0, sampleAt - 1), originalAt).some((r) => r.actions.includes(action))
      ) {
        refuse(refusals, "local", "earlier-correction-overlaps-held-action", sampleId);
        continue;
      }
      if (sampleAt > originalAt) {
        const between = index.inputs.slice(originalAt + 1, sampleAt + 1);
        if (between.some((r) => r.freshActions.includes(action))) {
          refuse(refusals, "local", "later-correction-crosses-fresh-action", sampleId);
          continue;
        }
        const originalRelease = between.find((r) => !r.actions.includes(action));
        if (originalRelease) {
          const release = index.inputs[sampleAt + 1];
          if (
            q.actions.includes(action) ||
            !release ||
            release.actions.includes(action) ||
            release.timeMs <= q.timeMs
          ) {
            refuse(refusals, "local", "release-relocation-unavailable", sampleId);
            continue;
          }
          relocatedRelease = {
            originalReleaseId: originalRelease.id,
            releaseId: release.id,
            timeMs: release.timeMs,
          };
        }
      }
      const preserved = certifyTimingHoldPreservation(
        map,
        trace,
        index.inputs,
        originalAt,
        sampleAt,
        parent.id,
        excluded
      );
      if (!preserved) {
        refuse(refusals, "local", "timing-hold-preservation-not-certified", sampleId);
        continue;
      }
      holdPreservation = preserved;
    }
    const ids = [
        ...new Set([
          inputId,
          sampleId,
          ...witnessIds,
          ...(tail?.eventIds ?? []),
          ...(kind === "same-time-aim" ? [beforeSample.id, afterSample.id] : []),
          ...trackingPreservation.flatMap((p) => p.eventIds),
          ...(headRoutingPreservation?.flatMap((p) => p.eventIds) ?? []),
          ...(holdPreservation?.eventIds ?? []),
          ...(relocatedRelease ? [relocatedRelease.originalReleaseId, relocatedRelease.releaseId] : []),
        ]),
      ],
      inputWitnesses = ids.map((id) => index!.records.get(id));
    if (inputWitnesses.some((r) => !r)) {
      refuse(refusals, "local", "witness-record-unavailable", sampleId);
      continue;
    }
    const positions = inputWitnesses.flatMap((r) =>
        r?.kind === "input" ? [index!.positions.get(r.id)!] : []
      ),
      first = Math.min(...positions),
      last = Math.max(...positions);
    if (last - first > 4096 || first < 0 || (first === 0 && !trace.domain.initialActionsKnown)) {
      refuse(refusals, "local", "source-span-or-initial-actions-unavailable", sampleId);
      continue;
    }
    const run = index.inputs.slice(Math.max(0, first - 1), last + 1),
      offsets: number[] = [];
    const valid = run.every((r, k) => {
      const previous = run[k - 1];
      if (
        ![r.timeMs, r.position.x, r.position.y].every(Number.isFinite) ||
        r.source.origin !== "parsed" ||
        r.source.discontinuityBefore?.length ||
        !Number.isSafeInteger(r.source.parsedFrameIndex) ||
        r.source.parsedFrameIndex < 0 ||
        !r.actions.every((a) => a === 0 || a === 1) ||
        new Set(r.actions).size !== r.actions.length ||
        !r.previousActions.every((a) => a === 0 || a === 1) ||
        new Set(r.previousActions).size !== r.previousActions.length ||
        new Set(r.freshActions).size !== r.freshActions.length ||
        !same(
          r.freshActions,
          r.actions.filter((a) => !r.previousActions.includes(a))
        ) ||
        (r.rawButtonMask !== undefined &&
          (!Number.isSafeInteger(r.rawButtonMask) ||
            r.rawButtonMask < 0 ||
            r.rawButtonMask > 31 ||
            !same(r.actions, [...(r.rawButtonMask & 5 ? [0] : []), ...(r.rawButtonMask & 10 ? [1] : [])])))
      )
        return false;
      if (r.source.rawTokenIndex !== undefined) {
        if (!Number.isSafeInteger(r.source.rawTokenIndex) || r.source.rawTokenIndex < 0) return false;
        offsets.push(r.source.rawTokenIndex - r.source.parsedFrameIndex);
      }
      if (
        previous &&
        (previous.source.origin !== "parsed" ||
          r.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
          r.timeMs < previous.timeMs ||
          !same(r.previousActions, previous.actions) ||
          (r.timeMs === previous.timeMs &&
            r.sequence <= terminal.sequence &&
            (r.position.x !== previous.position.x || r.position.y !== previous.position.y)) ||
          ((r.source.rawTokenIndex !== undefined || previous.source.rawTokenIndex !== undefined) &&
            (r.source.rawTokenIndex === undefined ||
              previous.source.rawTokenIndex === undefined ||
              r.source.rawTokenIndex !== previous.source.rawTokenIndex + 1)))
      )
        return false;
      return true;
    });
    if (!valid || new Set(offsets).size > 1) {
      refuse(refusals, "local", "source-or-action-continuity-invalid", sampleId);
      continue;
    }
    const latest = prefixTerminals
      .filter((_r, k) => prefix[k].id !== correctedParent?.id)
      .reduce<ReplayTraceRecord | undefined>((a, b) => (!a || b!.sequence > a.sequence ? b : a), undefined);
    return {
      kind,
      inputId,
      sampleId,
      timeMs: q.timeMs,
      ...(relocatedRelease ? { relocatedRelease } : {}),
      ...(trackingPreservation.length ? { trackingPreservation } : {}),
      ...(headRoutingPreservation?.length ? { headRoutingPreservation } : {}),
      ...(holdPreservation ? { holdPreservation } : {}),
      prefix: {
        parentCount: prefix.length,
        throughComponentId: prefix[prefix.length - 1]?.id,
        latestTerminalId: latest?.id,
      },
      eventIds: [
        ...new Set([
          ...ids,
          ...run.map((r) => r.id),
          activation.id,
          terminal.id,
          attempts[0].id,
          ...(latest ? [latest.id] : []),
        ]),
      ],
    };
  }
  return;
}

export interface IndependentAimPair {
  scope: "two-distinct-aim-corrections";
  priorComponentId: string;
  priorInputId: string;
  inputId: string;
  priorCorrection: PrimaryOpportunity;
  /** Conditional opportunity, not a clear-prefix or observed receipt claim. */
  targetOpportunity: Omit<PrimaryOpportunity, "prefix">;
  targetPolicy: { actualBlockers: string[]; afterPriorAimCorrection: string[] };
  selector: { priorCentered: string; targetCentered: string; afterPriorAimCorrection: string };
  sourceSpan: { startInputId: string; endInputId: string; frameCount: number };
  eventIds: string[];
}

/** Two nearby standalone notes can have distinct aim errors. Reconstruct the
 * target's centered selector with and without the separately certified prior
 * correction. Never turn consumption or this virtual query into a receipt. */
export function certifyIndependentAimPair(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace | undefined,
  inputId: string,
  witnessIds: readonly string[],
  excluded: ReadonlySet<string> = new Set()
): IndependentAimPair | undefined {
  if (
    !trace ||
    !e.target ||
    !e.geometry ||
    e.terminal?.mechanism !== "automatic-expiry" ||
    e.terminal.result !== "MISS" ||
    !e.terminal.previousUnresolved ||
    e.directRejections.length
  )
    return;
  const classic =
      trace.identity.analysisProfileId === "lazer" && !!map.lazerModSettings.classic?.classicNoteLock,
    caps = errorCapabilities(map, trace.identity.analysisProfileId),
    at = map.hitObjects.findIndex((o) => o.id === e.targetId),
    target = map.hitObjects[at],
    prior = map.hitObjects[at - 1];
  if (
    (trace.identity.analysisProfileId !== "stable" && !classic) ||
    caps.aim !== "manual" ||
    caps.tapping !== "manual" ||
    caps.scoring !== "supported" ||
    caps.geometry !== "supported" ||
    trace.droppedRecordBoundary !== undefined ||
    !(target instanceof HitCircle) ||
    target.sliderId ||
    !(prior instanceof HitCircle) ||
    prior.sliderId ||
    target.hitTime - prior.hitTime <= 3 ||
    target.hitTime - prior.hitTime > 200
  )
    return;
  let index = indexes.get(trace);
  if (!index) {
    index = buildIndex(trace);
    indexes.set(trace, index);
  }
  if (index.invalid) return;
  const q = e.inputs.find((i) => i.record.id === inputId),
    end = index.positions.get(inputId);
  if (
    !q ||
    !q.freshActionsKnown ||
    !q.inLiveSuccess ||
    q.postTerminal ||
    q.inside ||
    q.record.freshActions.length !== 1 ||
    end === undefined ||
    Math.abs(q.record.timeMs - target.hitTime) > e.geometry.hitWindows[0]
  )
    return;
  // Exactly the immediately preceding pulse; skipped/extra actions cannot be
  // silently reassigned into a convenient two-note correction.
  let begin = end - 1;
  while (begin >= 0 && end - begin <= 4096 && !index.inputs[begin].freshActions.length) begin--;
  const p = index.inputs[begin];
  if (!p || begin < 1 || end - begin > 4096 || p.timeMs >= q.record.timeMs) return;
  const own = deriveCircleEvidence(trace, map, prior.id),
    pi = own.inputs.find((i) => i.record.id === p.id);
  if (
    !pi ||
    pi.inside ||
    own.terminal?.mechanism !== "automatic-expiry" ||
    own.terminal.result !== "MISS" ||
    !own.terminal.previousUnresolved ||
    own.directRejections.length ||
    own.terminal.sequence <= q.record.sequence
  )
    return;
  const episode = analyzePrimaryApproaches(own, { pressIds: [p.id] }).episodes[0];
  if (
    episode?.status !== "supported" ||
    (Math.abs(p.timeMs - prior.hitTime) > own.geometry!.hitWindows[0] && !episode.spatialCandidates.length)
  )
    return;
  const priorCorrection = certifyPrimaryOpportunity(
    own,
    map,
    trace,
    p.id,
    [p.id],
    "same-time-aim",
    [p.id, ...episode.spatialCandidates.flatMap((c) => c.eventIds)],
    excluded
  );
  if (!priorCorrection) return;
  const span = index.inputs.slice(begin - 1, end + 1);
  if (
    span.some((r, k) => k > 0 && r.freshActions.length && ![p.id, q.record.id].includes(r.id)) ||
    [begin, end].some(
      (k) =>
        index!.inputs[k - 1]?.timeMs === index!.inputs[k].timeMs ||
        index!.inputs[k + 1]?.timeMs === index!.inputs[k].timeMs
    )
  )
    return;
  // A later receipt would be new causal evidence, not harmless empty motion.
  const lastPriorRoute = Math.max(
    p.sequence,
    ...trace.records
      .filter(
        (r) =>
          (r.kind === "attempt" && r.inputId === p.id) ||
          ((r.kind === "selection" || r.kind === "policy") &&
            (index!.attempts.get(p.id) ?? []).some((a) => a.id === r.attemptId))
      )
      .map((r) => r.sequence)
  );
  if (
    trace.records.some(
      (r) =>
        r.sequence > lastPriorRoute &&
        r.sequence < q.record.sequence &&
        (r.kind === "attempt" ||
          r.kind === "selection" ||
          r.kind === "policy" ||
          (r.kind === "resolution" && r.mechanism === "successful-input"))
    )
  )
    return;
  const ids = new Set<string>([...priorCorrection.eventIds, own.terminal.id, e.terminal.id]),
    components = new Set([prior.id, target.id]);
  const add = (id: string | undefined) => {
    if (id) ids.add(id);
  };
  const unresolved = map.hitObjects.slice(0, at).filter((o) => {
    components.add(o.id);
    if (o instanceof Slider) components.add(o.head.id);
    const terminal = index!.terminals.get(o.id);
    add(terminal?.id);
    return !terminal || terminal.sequence >= q.record.sequence;
  });
  if (unresolved.length !== 1 || unresolved[0].id !== prior.id || (classic && prior.stackHeight > 0)) return;
  const circles = map.hitObjects
    .flatMap((o, order) =>
      o instanceof HitCircle ? [{ circle: o, order }] : o instanceof Slider ? [{ circle: o.head, order }] : []
    )
    .sort((a, b) => a.circle.hitTime - b.circle.hitTime || (classic ? b.order - a.order : a.order - b.order));
  const selector = (pulse: InputRecord, position: HitCircle["position"], corrected = false) => {
    for (const { circle } of circles) {
      if (circle.spawnTime > pulse.timeMs || (corrected && circle.id === prior.id)) continue;
      const parent = circle.sliderId ?? circle.id,
        activation = index!.activations.get(circle.id),
        terminal = index!.terminals.get(circle.id),
        parentTerminal = index!.terminals.get(parent);
      components.add(circle.id);
      components.add(parent);
      add(activation?.id);
      add(terminal?.id);
      add(parentTerminal?.id);
      if (!activation || activation.sequence >= pulse.sequence) return;
      const parentLive = !!circle.sliderId && (!parentTerminal || parentTerminal.sequence >= pulse.sequence);
      if (
        (terminal && terminal.sequence < pulse.sequence && !(classic && parentLive)) ||
        (circle.sliderId && !parentLive)
      )
        continue;
      if (!classic && pulse.timeMs > circle.hitTime + e.geometry!.hitWindows[2] + 1) continue;
      if (
        classic
          ? nativeWithinHitRadius(circle.position, position, Math.fround(circle.radius))
          : stableWithinHitRadius(circle.position, position, stableGameplayRadius(circle.radius))
      )
        return circle.id;
    }
    return;
  };
  if (
    selector(p, prior.position) !== prior.id ||
    selector(q.record, target.position) !== target.id ||
    selector(q.record, target.position, true) !== target.id
  )
    return;
  if (
    [...components].some(
      (id) =>
        excluded.has(id) ||
        [...trace.failures, ...trace.domain.sourceCoverageLimits].some(
          (s) => s.startsWith("dependency-conflict:") && s.endsWith(":" + id)
        )
    )
  )
    return;
  const opportunity = certifyOpportunity(
    e,
    map,
    trace,
    inputId,
    [inputId],
    "same-time-aim",
    [...witnessIds, ...ids, p.id],
    excluded,
    { id: prior.id, sequence: p.sequence }
  );
  if (!opportunity) return;
  const { prefix: conditionalPrefix, ...targetOpportunity } = opportunity;
  void conditionalPrefix;
  return {
    scope: "two-distinct-aim-corrections",
    priorComponentId: prior.id,
    priorInputId: p.id,
    inputId,
    priorCorrection,
    targetOpportunity,
    targetPolicy: { actualBlockers: [prior.id], afterPriorAimCorrection: [] },
    selector: { priorCentered: prior.id, targetCentered: target.id, afterPriorAimCorrection: target.id },
    sourceSpan: { startInputId: span[0].id, endInputId: q.record.id, frameCount: span.length },
    eventIds: [...new Set([...ids, ...opportunity.eventIds])],
  };
}
