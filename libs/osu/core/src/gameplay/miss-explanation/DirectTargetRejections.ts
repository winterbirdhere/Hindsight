import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { Spinner } from "../../hitobjects/Spinner";
import { StableSliderTiming } from "../StableSliderTiming";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import type { CircleEvidence, InputRecord, ResolutionRecord } from "./CircleEvidence";

/** A model dispatch witness, independent of inferred rhythmic input ownership. */
export interface DirectTargetRejection {
  inputId: string;
  attemptId: string;
  selectionId: string;
  policyId: string;
  blockerId: string;
  targetActivationId: string;
  blockerActivationId?: string;
  blockerResolutionId?: string;
  timingResult: "GREAT" | "OK" | "MEH";
  offsetMs: number;
  eventIds: string[];
}

/** Uses the existing sealed evidence index; no per-target whole-trace scan. */
export interface DirectRejectionIndex {
  byId: ReadonlyMap<string, ReplayTraceRecord>;
  inputs: readonly InputRecord[];
  routing: ReadonlyMap<string, readonly Extract<ReplayTraceRecord, { kind: "selection" | "policy" }>[]>;
  activations: ReadonlyMap<string, Extract<ReplayTraceRecord, { kind: "lifecycle" }>>;
  resolutions: ReadonlyMap<string, ResolutionRecord>;
  parentResolutions: ReadonlyMap<string, Extract<ReplayTraceRecord, { kind: "slider-parent" }>>;
  spinnerResolutions: ReadonlyMap<string, Extract<ReplayTraceRecord, { kind: "spinner-resolution" }>>;
}

const sameActions = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((action) => b.includes(action));

const mapOrders = new WeakMap<Beatmap, { parents: Map<string, number>; circles: HitCircle[] }>();
const stableEnds = new WeakMap<Slider, number>();
function orderFor(map: Beatmap) {
  let order = mapOrders.get(map);
  if (!order) {
    const parents = new Map(map.hitObjects.map((object, i) => [object.id, i]));
    const circles = map.hitObjects.flatMap((object) =>
      object instanceof HitCircle ? [object] : object instanceof Slider ? [object.head] : [],
    );
    circles.sort(
      (a, b) =>
        a.hitTime - b.hitTime || (parents.get(a.sliderId ?? a.id) ?? 0) - (parents.get(b.sliderId ?? b.id) ?? 0),
    );
    order = { parents, circles };
    mapOrders.set(map, order);
  }
  return order;
}
function stableEnd(slider: Slider): number {
  let end = stableEnds.get(slider);
  if (end === undefined) {
    end = new StableSliderTiming(slider).endTime;
    stableEnds.set(slider, end);
  }
  return end;
}

export function deriveDirectTargetRejections(
  evidence: CircleEvidence,
  map: Beatmap,
  trace: ReplayTrace,
  index: DirectRejectionIndex,
  includeRecovered = false,
): DirectTargetRejection[] {
  return derivePolicyRejections(evidence, map, trace, index, includeRecovered, false) as DirectTargetRejection[];
}

/** A blocked walk step need not itself have been a hittable target opportunity.
 * This separate API retains the same source, geometry, lifecycle and actual
 * blocker recomputation, without adding anything to directRejections. */
export function deriveRecordedPolicyRejections(evidence: CircleEvidence, map: Beatmap, trace: ReplayTrace, index: DirectRejectionIndex) {
  return derivePolicyRejections(evidence, map, trace, index, true, true);
}
function derivePolicyRejections(
  evidence: CircleEvidence, map: Beatmap, trace: ReplayTrace, index: DirectRejectionIndex,
  includeRecovered: boolean, recordedInteraction: boolean,
): Array<Omit<DirectTargetRejection, "timingResult"> & { timingResult: string | null }> {
  const { target, geometry, terminal } = evidence;
  if (
    (evidence.status !== "supported" && !(recordedInteraction && evidence.status === "not-missed")) ||
    !target ||
    !geometry ||
    !terminal ||
    !(
      (terminal.result === "MISS" && terminal.mechanism === "automatic-expiry") ||
      (includeRecovered && terminal.mechanism === "successful-input" && terminal.result !== "MISS") ||
      recordedInteraction
    ) ||
    !terminal.previousUnresolved ||
    evidence.limits.truncated ||
    trace.droppedRecordBoundary !== undefined ||
    [evidence.dependencies.geometry, evidence.dependencies.routing, evidence.dependencies.lifecycle].some(
      (d) => d.status !== "complete",
    ) ||
    Object.values(evidence.dependencies).some((d) => d.reasons.some((r) => r.startsWith("dependency-conflict:"))) ||
    trace.failures.some((r) => r !== "global-totals-mismatch" && !r.startsWith("dependency-conflict:"))
  )
    return [];
  const targetObject = map.getHitObject(evidence.targetId);
  const activated = index.activations.get(evidence.targetId);
  if (!(targetObject instanceof HitCircle) || !activated) return [];
  const targetParent = targetObject.sliderId ?? targetObject.id;
  const order = orderFor(map);
  const targetOrder = order.parents.get(targetParent) ?? -1;
  const inputs = new Map(evidence.inputs.map((item) => [item.record.id, item]));
  const attempts = new Map(evidence.attempts.map((attempt) => [attempt.id, attempt]));
  const witnesses: Array<Omit<DirectTargetRejection, "timingResult"> & { timingResult: string | null }> = [];
  for (const policy of evidence.routing) {
    if (
      policy.kind !== "policy" ||
      policy.componentId !== evidence.targetId ||
      policy.state !== "rejected" ||
      !policy.blockerId
    )
      continue;
    const attempt = attempts.get(policy.attemptId);
    const item = attempt && inputs.get(attempt.inputId);
    if (
      !attempt ||
      !item ||
      attempt.automated ||
      !item.inside ||
      !(recordedInteraction ? item.inInteraction : item.inLiveSuccess) ||
      item.postTerminal ||
      !item.freshActionsKnown
    )
      continue;
    const input = item.record;
    const fresh = input.actions.filter((action) => !input.previousActions.includes(action));
    if (
      !fresh.length ||
      input.actions.some((a) => a !== 0 && a !== 1) ||
      input.previousActions.some((a) => a !== 0 && a !== 1) ||
      new Set(input.actions).size !== input.actions.length ||
      new Set(input.previousActions).size !== input.previousActions.length ||
      !sameActions(fresh, input.freshActions) ||
      !sameActions(fresh, attempt.actionCandidates) ||
      !Number.isSafeInteger(attempt.attemptOrdinal) ||
      attempt.attemptOrdinal < 0 ||
      attempt.attemptOrdinal >= fresh.length ||
      (attempt.knownAction !== undefined && !fresh.includes(attempt.knownAction))
    )
      continue;
    const routes = index.routing.get(attempt.id) ?? [];
    const selections = routes.filter((r) => r.kind === "selection");
    const selection = selections[0];
    if (
      selections.length !== 1 ||
      !selection ||
      selection.kind !== "selection" ||
      selection.componentId !== evidence.targetId ||
      selection.component !== (targetObject.sliderId ? "slider-head" : "circle") ||
      !selection.inside ||
      !selection.eligible ||
      !selection.selectionStopped ||
      routes.filter((r) => r.kind === "policy").length !== 1 ||
      !(
        activated.sequence < input.sequence &&
        input.sequence < attempt.sequence &&
        attempt.sequence < selection.sequence &&
        selection.sequence < policy.sequence &&
        policy.sequence < terminal.sequence
      ) ||
      [attempt, selection, policy].some((r) => r.timeMs !== input.timeMs) ||
      activated.timeMs > input.timeMs ||
      terminal.timeMs < input.timeMs
    )
      continue;
    // Source order matters even for equal timestamps and multiple logical attempts.
    let lo = 0,
      hi = index.inputs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.inputs[mid].sequence <= input.sequence) lo = mid + 1;
      else hi = mid;
    }
    if (index.inputs[lo] && index.inputs[lo].sequence < policy.sequence) continue;
    const previous = index.inputs[lo - 2];
    if (!sameActions(input.previousActions, previous?.actions ?? [])) continue;
    const offset = input.timeMs - target.hitTimeMs;
    const grade =
      Math.abs(offset) <= geometry.hitWindows[0]
        ? "GREAT"
        : Math.abs(offset) <= geometry.hitWindows[1]
        ? "OK"
        : Math.abs(offset) <= geometry.hitWindows[2]
        ? "MEH"
        : recordedInteraction ? Math.abs(offset) <= geometry.hitWindows[3] ? "MISS" : null : undefined;
    if (grade === undefined || policy.timingResult !== grade || policy.offsetMs !== offset) continue;
    const blocker = map.getHitObject(policy.blockerId);
    if (
      !(blocker instanceof HitCircle || blocker instanceof Slider || blocker instanceof Spinner) ||
      blocker.id === targetObject.id ||
      blocker.id === targetParent ||
      blocker.spawnTime > input.timeMs
    )
      continue;
    const dependencies = new Set([
      targetParent,
      blocker.id,
      ...(blocker instanceof Slider
        ? [blocker.head.id]
        : blocker instanceof HitCircle && blocker.sliderId
        ? [blocker.sliderId]
        : []),
    ]);
    if (
      trace.failures.some(
        (reason) => reason.startsWith("dependency-conflict:") && dependencies.has(reason.split(":").slice(2).join(":")),
      )
    )
      continue;
    const blockerActivation = index.activations.get(blocker instanceof Slider ? blocker.head.id : blocker.id);
    const blockerTerminal =
      blocker instanceof Slider
        ? index.parentResolutions.get(blocker.id)
        : blocker instanceof Spinner
        ? index.spinnerResolutions.get(blocker.id)
        : index.resolutions.get(blocker.id);
    if (
      ((blocker instanceof HitCircle || blocker instanceof Slider) &&
        (!blockerActivation ||
          blockerActivation.sequence >= policy.sequence ||
          blockerActivation.timeMs > input.timeMs)) ||
      (blockerTerminal && (blockerTerminal.sequence <= policy.sequence || blockerTerminal.timeMs < input.timeMs)) ||
      trace.domain.endTimeMs < input.timeMs
    )
      continue;
    if (policy.branch === "native:start-time-ordered") {
      if (
        geometry.profile !== "lazer" ||
        map.lazerModSettings.classic?.classicNoteLock ||
        !(blocker instanceof HitCircle) ||
        blocker.hitTime >= target.hitTimeMs ||
        input.timeMs >= blocker.hitTime
      )
        continue;
      let left = 0,
        right = order.circles.length;
      while (left < right) {
        const mid = (left + right) >>> 1;
        if (order.circles[mid].hitTime < target.hitTimeMs) left = mid + 1;
        else right = mid;
      }
      if (order.circles[left - 1]?.id !== blocker.id) continue;
    } else if (policy.branch === "stable:STABLE" || policy.branch === "native:classic-note-lock") {
      if ((policy.branch === "stable:STABLE") !== (geometry.profile === "stable")) continue;
      if (policy.branch === "native:classic-note-lock" && !map.lazerModSettings.classic?.classicNoteLock) continue;
      // These policies name earlier parents, not a slider head's independent result.
      const blockerOrder = order.parents.get(blocker.id) ?? -1;
      if (blockerOrder < 0 || targetOrder <= blockerOrder) continue;
      const end =
        blocker instanceof HitCircle
          ? blocker.hitTime
          : policy.branch === "stable:STABLE" && blocker instanceof Slider
          ? stableEnd(blocker)
          : blocker.endTime;
      if (end + 3 >= target.hitTimeMs) continue;
      // The dispatch names the first eligible unresolved parent, not any earlier
      // live object. All terminal lookups use the shared index and event order.
      let firstBlocker: string | undefined;
      for (let i = 0; i <= blockerOrder; i++) {
        const earlier = map.hitObjects[i];
        if (policy.branch === "native:classic-note-lock" && earlier.spawnTime > input.timeMs) continue;
        const resolved =
          earlier instanceof HitCircle
            ? index.resolutions.get(earlier.id)
            : earlier instanceof Slider
            ? index.parentResolutions.get(earlier.id)
            : index.spinnerResolutions.get(earlier.id);
        if (resolved && resolved.sequence < policy.sequence) continue;
        const earlierEnd =
          earlier instanceof HitCircle
            ? earlier.hitTime
            : policy.branch === "stable:STABLE" && earlier instanceof Slider
            ? stableEnd(earlier)
            : earlier.endTime;
        if (earlierEnd + 3 < target.hitTimeMs) {
          firstBlocker = earlier.id;
          break;
        }
      }
      if (firstBlocker !== blocker.id) continue;
    } else continue;
    const parentTerminal = targetObject.sliderId && index.parentResolutions.get(targetObject.sliderId);
    if (parentTerminal && parentTerminal.sequence <= policy.sequence) continue;
    witnesses.push({
      inputId: input.id,
      attemptId: attempt.id,
      selectionId: selection.id,
      policyId: policy.id,
      blockerId: blocker.id,
      targetActivationId: activated.id,
      blockerActivationId: blockerActivation?.id,
      blockerResolutionId: blockerTerminal?.id,
      timingResult: grade,
      offsetMs: offset,
      eventIds: [
        input.id,
        attempt.id,
        selection.id,
        policy.id,
        activated.id,
        terminal.id,
        ...(blockerActivation ? [blockerActivation.id] : []),
        ...(blockerTerminal ? [blockerTerminal.id] : []),
      ],
    });
  }
  return witnesses;
}
