import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import {
  AttemptRecord,
  CircleEvidence,
  InputRecord,
  ResolutionRecord,
  RoutingRecord,
  deriveCircleEvidence,
} from "../miss-explanation/CircleEvidence";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { StableSliderTiming } from "../StableSliderTiming";
import { errorCapabilities } from "./ErrorCapabilities";
import type { PrimaryInputEvidence } from "./PrimaryInputEvidence";

interface OmissionIndex {
  inputs: InputRecord[];
  inputPositions: Map<string, number>;
  attemptsByInput: Map<string, AttemptRecord[]>;
  resolutionsByAttempt: Map<string, ResolutionRecord[]>;
  routesByInput: Map<string, RoutingRecord[]>;
  activations: Map<string, Extract<ReplayTraceRecord, { kind: "lifecycle" }>>;
}
type ParentTerminal = Extract<ReplayTraceRecord, { kind: "resolution" | "slider-parent" | "spinner-resolution" }>;
const terminalIndexes = new WeakMap<ReplayTrace, Map<string, ParentTerminal>>();
function parentTerminals(trace: ReplayTrace) {
  let index = terminalIndexes.get(trace);
  if (!index) {
    index = new Map();
    for (const r of trace.records)
      if (r.kind === "resolution" || r.kind === "slider-parent" || r.kind === "spinner-resolution")
        index.set(r.componentId, r);
    terminalIndexes.set(trace, index);
  }
  return index;
}
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** A complete recorded head gap, not absence inferred from filtered inputs or
 * holding. Earlier successful edges are accounted individually; the head has
 * its own sampled, on-time, unblocked opportunity after them. */
export function deriveSliderHeadOmission(
  e: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  index: OmissionIndex,
  excluded?: ReadonlySet<string>,
): PrimaryInputEvidence["missingAction"] {
  const object = map.getHitObject(e.targetId),
    terminal = e.terminal,
    g = e.geometry,
    target = e.target;
  const conflicts = [...trace.failures, ...trace.domain.sourceCoverageLimits];
  const conflicted = (id: string) =>
    excluded?.has(id) ||
    conflicts.some((reason) => reason.startsWith("dependency-conflict:") && reason.endsWith(":" + id));
  if (
    !(object instanceof HitCircle) ||
    !object.sliderId ||
    !terminal ||
    !g ||
    !target ||
    terminal.result !== "MISS" ||
    terminal.mechanism !== "automatic-expiry" ||
    e.limits.truncated ||
    Object.values(e.dependencies).some((d) => d.status !== "complete") ||
    e.directRejections.length ||
    conflicted(object.id) ||
    conflicted(object.sliderId) ||
    errorCapabilities(map, e.identity.analysisProfileId).tapping !== "manual"
  )
    return;
  const slider = map.getSlider(object.sliderId),
    live = e.domains.liveSuccess;
  if (
    !slider ||
    !(slider.endTime - slider.startTime > 0) ||
    live.state !== "nonempty" ||
    !live.start ||
    !live.end
  )
    return;
  // Stable may resolve the parent before its unresolved head expires. Trust
  // that narrower opportunity only when the actual parent receipt can legally
  // close it; an impossible cutoff must not erase a later fresh edge.
  if (live.end.eventId && live.end.eventId !== terminal.id) {
    const cutoff = parentTerminals(trace).get(slider.id);
    if (
      e.identity.analysisProfileId !== "stable" ||
      cutoff?.kind !== "slider-parent" ||
      cutoff.id !== live.end.eventId ||
      cutoff.headId !== object.id ||
      cutoff.timeMs !== live.end.timeMs ||
      cutoff.sequence !== live.end.sequence ||
      !cutoff.scoring ||
      (cutoff.headResult !== undefined && cutoff.headResult !== "MISS") ||
      cutoff.timeMs < new StableSliderTiming(slider).endTime ||
      cutoff.sequence >= terminal.sequence
    )
      return;
    let lo = 0,
      hi = index.inputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.inputs[mid].sequence < cutoff.sequence) lo = mid + 1;
      else hi = mid;
    }
    // Stable parent grading follows the input of its owning update. A second
    // same-time input can genuinely follow grading, but the first cannot.
    const owner = index.inputs[lo - 1];
    if (!owner || owner.timeMs !== cutoff.timeMs || owner.source.origin !== "parsed") return;
  }
  const local = e.inputs.filter((i) => i.inLiveSuccess && !i.postTerminal),
    fresh = local.filter((i) => i.record.freshActions.length);
  if (!fresh.length || fresh.length > 128 || local.some((i) => !i.freshActionsKnown)) return;
  const first = index.inputPositions.get(local[0]?.record.id),
    last = index.inputPositions.get(local[local.length - 1]?.record.id);
  if (
    first === undefined ||
    last === undefined ||
    first < 1 ||
    last + 1 >= index.inputs.length ||
    last - first + 3 > e.limits.maxInputs
  )
    return;
  const bridge = index.inputs.slice(first - 1, last + 2),
    witnessIds: string[] = [];
  let rawOffset: number | undefined, hasRaw: boolean | undefined;
  for (let k = 0; k < bridge.length; k++) {
    const r = bridge[k],
      previous = bridge[k - 1];
    if (
      r.source.origin !== "parsed" ||
      r.source.discontinuityBefore?.length ||
      r.actions.some((a) => a !== 0 && a !== 1) ||
      new Set(r.actions).size !== r.actions.length ||
      r.previousActions.some((a) => a !== 0 && a !== 1) ||
      new Set(r.previousActions).size !== r.previousActions.length ||
      !same(
        r.freshActions,
        r.actions.filter((a) => !r.previousActions.includes(a)),
      )
    )
      return;
    if (
      previous &&
      (previous.source.origin !== "parsed" ||
        r.source.parsedFrameIndex !== previous.source.parsedFrameIndex + 1 ||
        r.sequence <= previous.sequence ||
        r.timeMs < previous.timeMs ||
        !same(r.previousActions, previous.actions))
    )
      return;
    if (
      r.rawButtonMask !== undefined &&
      (!Number.isSafeInteger(r.rawButtonMask) ||
        r.rawButtonMask < 0 ||
        !!(r.rawButtonMask & 5) !== r.actions.includes(0) ||
        !!(r.rawButtonMask & 10) !== r.actions.includes(1))
    )
      return;
    const raw = r.source.rawTokenIndex !== undefined;
    if (hasRaw !== undefined && hasRaw !== raw) return;
    hasRaw = raw;
    if (raw) {
      const offset = r.source.rawTokenIndex! - r.source.parsedFrameIndex;
      if (rawOffset !== undefined && offset !== rawOffset) return;
      rawOffset = offset;
    }
    witnessIds.push(r.id);
  }
  if (bridge[0].timeMs > live.start.timeMs || bridge[bridge.length - 1].timeMs < live.end.timeMs) return;
  const receipts: Array<{ object: HitCircle; input: InputRecord; receipt: ResolutionRecord }> = [];
  for (const item of fresh) {
    const r = item.record,
      attempts = index.attemptsByInput.get(r.id) ?? [],
      routes = index.routesByInput.get(r.id) ?? [];
    const attempt = attempts[0],
      selection = routes.find((q) => q.kind === "selection"),
      policy = routes.find((q) => q.kind === "policy");
    if (
      r.timeMs >= target.hitTimeMs - g.hitWindows[0] ||
      r.freshActions.length !== 1 ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.automated ||
      attempt.attemptOrdinal !== 0 ||
      attempt.knownAction !== r.freshActions[0] ||
      !same(attempt.actionCandidates, r.freshActions) ||
      routes.length !== 2 ||
      selection?.kind !== "selection" ||
      policy?.kind !== "policy" ||
      selection.componentId === null ||
      !selection.inside ||
      !selection.eligible ||
      !selection.selectionStopped ||
      policy.state !== "allowed" ||
      policy.componentId !== selection.componentId
    )
      return;
    const consumed = map.getHitObject(selection.componentId),
      resolved = index.resolutionsByAttempt.get(attempt.id) ?? [],
      receipt = resolved[0];
    if (
      !(consumed instanceof HitCircle) ||
      consumed.hitTime >= target.hitTimeMs ||
      resolved.length !== 1 ||
      !receipt ||
      conflicted(consumed.id) ||
      (consumed.sliderId && conflicted(consumed.sliderId))
    )
      return;
    const c = deriveCircleEvidence(trace, map, consumed.id),
      activation = index.activations.get(consumed.id),
      ci = c.inputs.find((i) => i.record.id === r.id),
      offset = r.timeMs - consumed.hitTime,
      windows = c.geometry?.hitWindows;
    const grade =
      windows &&
      (Math.abs(offset) <= windows[0]
        ? "GREAT"
        : Math.abs(offset) <= windows[1]
        ? "OK"
        : Math.abs(offset) <= windows[2]
        ? "MEH"
        : undefined);
    const kind = consumed.sliderId ? "slider-head" : "circle",
      next = index.inputs[(index.inputPositions.get(r.id) ?? -1) + 1];
    if (
      c.limits.truncated ||
      Object.values(c.dependencies).some((d) => d.status !== "complete") ||
      c.terminal?.id !== receipt.id ||
      !ci?.inside ||
      !ci.inLiveSuccess ||
      ci.postTerminal ||
      !ci.freshActionsKnown ||
      !activation ||
      activation.sequence >= r.sequence ||
      selection.component !== kind ||
      receipt.component !== kind ||
      receipt.componentId !== consumed.id ||
      receipt.mechanism !== "successful-input" ||
      !receipt.previousUnresolved ||
      !grade ||
      receipt.result !== grade ||
      policy.timingResult !== grade ||
      policy.offsetMs !== offset ||
      !(
        r.sequence < attempt.sequence &&
        attempt.sequence < selection.sequence &&
        selection.sequence < policy.sequence &&
        policy.sequence < receipt.sequence
      ) ||
      [attempt, selection, policy, receipt].some((q) => q.timeMs !== r.timeMs) ||
      (next && receipt.sequence >= next.sequence)
    )
      return;
    witnessIds.push(activation.id, attempt.id, selection.id, policy.id, receipt.id);
    receipts.push({ object: consumed, input: r, receipt });
  }
  const parentOrder = map.hitObjects.findIndex((o) => o.id === slider.id);
  // Explicit bounded certificate: a refusal is preferable to unbounded prefix
  // work or a fabricated available opportunity. Existing diagnoses stay intact.
  if (parentOrder < 1 || parentOrder > 4096) return;
  const previous = map.hitObjects[parentOrder - 1],
    preceding = previous instanceof HitCircle ? previous : previous instanceof Slider ? previous.head : undefined,
    lastReceipt = receipts[receipts.length - 1];
  if (!preceding || lastReceipt.object.id !== preceding.id) return;
  const spacing = target.hitTimeMs - preceding.hitTime;
  // The exact successful receipt above establishes which earlier receptor
  // consumed the action. Nearest-half-spacing is an intent guess and cannot
  // veto a later fully recorded head gap. On-best-window consumed actions are
  // still excluded before receipt collection; the clear prefix is checked below.
  if (!(spacing > 0)) return;
  const contact = local.find(
    (i) =>
      i.inside &&
      i.record.timeMs >= target.hitTimeMs &&
      i.record.timeMs <= target.hitTimeMs + g.hitWindows[0] &&
      i.record.sequence > lastReceipt.receipt.sequence,
  );
  const beforeContact =
    contact &&
    local.find(
      (i) =>
        i.inside &&
        i.record.timeMs >= target.hitTimeMs - g.hitWindows[0] &&
        i.record.timeMs < contact.record.timeMs &&
        i.record.timeMs <= target.hitTimeMs,
    );
  if (!contact || !beforeContact) return;
  // A previous success can be allowed by the three-ms exception while an older
  // parent still blocks this head. Require every earlier parent resolved before
  // this exact on-time sample; use actual profile-owned parent receipts.
  const terminals = parentTerminals(trace),
    earlierResolutionIds: string[] = [];
  for (let k = 0; k < parentOrder; k++) {
    const earlier = map.hitObjects[k],
      resolution = terminals.get(earlier.id);
    if (
      conflicted(earlier.id) ||
      (earlier instanceof Slider && conflicted(earlier.head.id)) ||
      !resolution ||
      resolution.sequence >= contact.record.sequence ||
      resolution.timeMs > contact.record.timeMs ||
      (earlier instanceof HitCircle
        ? resolution.kind !== "resolution"
        : earlier instanceof Slider
        ? resolution.kind !== "slider-parent"
        : resolution.kind !== "spinner-resolution")
    )
      return;
    earlierResolutionIds.push(resolution.id);
  }
  if (witnessIds.length + earlierResolutionIds.length > e.limits.maxRelatedRecords) return;
  return {
    scope: "complete-recorded-head-gap",
    previousComponentId: preceding.id,
    eventIds: [
      ...new Set(
        [
          ...witnessIds,
          ...earlierResolutionIds,
          beforeContact.record.id,
          contact.record.id,
          live.end.eventId!,
          terminal.id,
        ].filter(Boolean),
      ),
    ],
    contextEventIds: [...new Set(receipts.flatMap((r) => [r.input.id, r.receipt.id]))],
    headOpportunity: {
      inputId: contact.record.id,
      earlierResolutionIds,
      liveEnd: live.end,
      eventIds: [beforeContact.record.id, contact.record.id],
    },
  };
}
