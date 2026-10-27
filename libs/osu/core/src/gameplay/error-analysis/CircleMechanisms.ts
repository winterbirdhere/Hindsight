import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import { RELAX_LENIENCY } from "../../mods/Mods";
import { CircleEvidence, CircleInputEvidence } from "../miss-explanation/CircleEvidence";
import { ComponentMechanism } from "./ComponentMechanisms";
import { errorCapabilities } from "./ErrorCapabilities";
import { classifyMovementEpisodes, MovementEpisodeResult, MovementLabel } from "./MovementEpisode";
import { ReplayTrace } from "../trace/ReplayTrace";
import { primaryCircleDiagnosis, PrimaryCircleDiagnostics } from "./PrimaryCircleDiagnosis";

export interface CircleMechanism extends ComponentMechanism {
  diagnostics?: {
    opportunities: { inputId: string; codes: string[]; eventIds: string[] }[];
    movement?: MovementEpisodeResult;
    primary?: PrimaryCircleDiagnostics;
    absence?: { scope: "complete-live-opportunity"; freshInputCount: 0; heldAtContact: boolean };
  };
}
const shapeCodes: Record<MovementLabel, string> = {
  Overshoot: "overshoot",
  Undershoot: "undershoot",
  "Wide aim": "wide-aim",
};
const presentation: Record<string, { headline: string; description: string }> = {
  overshoot: { headline: "Overshoot", description: "Passed beyond the circle and tapped outside it." },
  undershoot: { headline: "Undershoot", description: "The approach stopped or turned before reaching the circle." },
  "wide-aim": { headline: "Wide aim", description: "Moved past the side of the circle while tapping." },
  "aim-late": { headline: "Aim late", description: "Tapped before the cursor entered the circle." },
  "left-early": { headline: "Left early", description: "Tapped after the cursor left the circle." },
  "between-passes": { headline: "Between passes", description: "Tapped between two passes through the circle." },
  "off-target": { headline: "Off target", description: "Taps during this note were outside the circle." },
  "edge-miss": { headline: "Edge miss", description: "Tapped just outside the circle's edge." },
  notelock: { headline: "Notelock", description: "The note order blocked this tap." },
  "tap-taken": { headline: "Tap taken", description: "Another note took the tap." },
};

/** Consumes already-prepared geometry and rule-owned dispatch; it never resimulates selection. */
export function classifyCircleLoss(
  evidence: CircleEvidence,
  map: Beatmap,
  trace?: ReplayTrace,
  excludedComponentIds?: ReadonlySet<string>,
): CircleMechanism {
  return primaryCircleDiagnosis(evidence, map, observeCircleLoss(evidence, map), trace, excludedComponentIds);
}

/** Retained observational relations, not the primary diagnosis policy. */
function observeCircleLoss(evidence: CircleEvidence, map: Beatmap): CircleMechanism {
  const diagnostics: NonNullable<CircleMechanism["diagnostics"]> = { opportunities: [] };
  const unavailable = (reason: string): CircleMechanism => ({
    status: "unavailable",
    codes: [],
    headline: "",
    description: "",
    eventIds: [],
    limitations: [...new Set([...evidence.limitations, reason])],
    diagnostics,
  });
  const supported = (
    codes: string[],
    headline: string,
    description: string,
    eventIds: string[],
    metric?: ComponentMechanism["metric"],
  ): CircleMechanism => ({
    status: "supported",
    codes,
    headline,
    description,
    eventIds: [...new Set(eventIds)],
    limitations: [...evidence.limitations],
    ...(metric ? { metric } : {}),
    diagnostics,
  });
  const { terminal, target, geometry } = evidence;
  if (evidence.status !== "supported" || !terminal || !target || !geometry)
    return unavailable("not-a-verified-circle-loss");
  const capability = errorCapabilities(map, evidence.identity.analysisProfileId);
  const automaticEligible = (time: number) =>
    evidence.identity.analysisProfileId === "stable"
      ? time > target.hitTimeMs - RELAX_LENIENCY
      : time >= target.hitTimeMs - RELAX_LENIENCY;
  if (capability.scoring !== "supported" || capability.geometry !== "supported")
    return unavailable("unsupported-profile");
  if (
    Object.values(evidence.dependencies).some((dep) =>
      dep.reasons.some((reason) => reason.startsWith("dependency-conflict:")),
    )
  )
    return unavailable("conflicting-evidence");
  const targetObject = map.getHitObject(evidence.targetId);
  if (!(targetObject instanceof HitCircle)) return unavailable("missing-circle-component");
  if (
    targetObject.sliderId !== undefined &&
    terminal.result !== "MISS" &&
    (evidence.identity.analysisProfileId === "stable" ? !capability.scoreV2 : !capability.classicHeadAccuracy)
  )
    return unavailable("non-scoring-head-timing");
  if (evidence.dependencies.lifecycle.reasons.includes("missing-terminal-reference"))
    return unavailable("missing-terminal-reference");
  if (terminal.mechanism === "ordered-force-miss") {
    const cause = evidence.terminalReferences.find(
      (record) => record.kind === "resolution" && record.id === terminal.triggerResolutionId,
    );
    const causeObject = cause?.kind === "resolution" && map.getHitObject(cause.componentId);
    // Native reserves the causal result ID, then resolves earlier notes first.
    // The referenced later result can therefore appear after this terminal.
    if (
      !cause ||
      cause.id === terminal.id ||
      !(causeObject instanceof HitCircle) ||
      causeObject.id === targetObject.id ||
      causeObject.hitTime < target.hitTimeMs ||
      cause.timeMs !== terminal.timeMs
    )
      return unavailable("unverified-forced-resolution");
    return supported(["out-of-order"], "Out of order", "A later note resolved first.", [terminal.id, cause.id]);
  }
  if (terminal.mechanism === "input-miss" || terminal.mechanism === "successful-input") {
    const attempt = evidence.terminalReferences.find(
      (record) => record.kind === "attempt" && record.id === terminal.triggerAttemptId,
    );
    const press =
      attempt?.kind === "attempt" &&
      evidence.terminalReferences.find((record) => record.kind === "input" && record.id === attempt.inputId);
    if (
      !attempt ||
      !press ||
      press.kind !== "input" ||
      attempt.sequence >= terminal.sequence ||
      press.sequence >= attempt.sequence
    )
      return unavailable("missing-terminal-input");
    const offset = press.timeMs - target.hitTimeMs;
    const expectedGrade =
      Math.abs(offset) <= geometry.hitWindows[0]
        ? "GREAT"
        : Math.abs(offset) <= geometry.hitWindows[1]
        ? "OK"
        : Math.abs(offset) <= geometry.hitWindows[2]
        ? "MEH"
        : "MISS";
    if (!Number.isFinite(offset) || terminal.result !== expectedGrade) return unavailable("timing-result-conflict");
    if (capability.tapping === "automated") {
      const lateEntry = evidence.insideIntervals.find(
        (interval) =>
          !interval.leftCensored &&
          interval.startTimeMs > target.hitTimeMs + geometry.hitWindows[0] &&
          interval.startTimeMs <= press.timeMs &&
          !interval.postTerminal,
      );
      // Relax evaluates recorded updates. A reconstructed crossing between two
      // outside updates is not an automatic hit opportunity.
      const earlierContact = evidence.inputs.some(
        (item) =>
          item.inLiveSuccess &&
          !item.postTerminal &&
          item.inside &&
          item.record.timeMs <= target.hitTimeMs + geometry.hitWindows[0] &&
          automaticEligible(item.record.timeMs),
      );
      const at=evidence.inputs.findIndex(i=>i.record.id === press.id), prior=evidence.inputs[at-1];
      // Ordered raw updates can cross the edge at one timestamp. They must not
      // borrow a later post-terminal interval or interpolate a zero-time jump.
      const orderedEntry=prior && !prior.inside && prior.record.timeMs===press.timeMs &&
        prior.record.sequence<press.sequence && prior.record.source.origin==="parsed" && press.source.origin==="parsed" &&
        press.source.parsedFrameIndex===prior.record.source.parsedFrameIndex+1 && !press.source.discontinuityBefore?.length &&
        prior.record.timeMs>target.hitTimeMs+geometry.hitWindows[0];
      if (
        capability.aim === "manual" &&
        offset > 0 &&
        (lateEntry || orderedEntry) &&
        !earlierContact &&
        evidence.dependencies.input.status === "complete"
      )
        return supported(
          ["aim-late"],
          "Aim late",
          "The cursor was inside for a hit after the best timing window.",
          [terminal.id, attempt.id, press.id, ...(lateEntry?.eventIds ?? [prior.record.id])],
          { value: Math.round(offset / map.gameClockRate), unit: "ms late" },
        );
      return unavailable("automated-tapping-loss-conflict");
    }
    if (offset === 0) return unavailable("timing-result-conflict");
    const early = offset < 0;
    return supported(
      [early ? "early-tap" : "late-tap"],
      early ? "Early tap" : "Late tap",
      early ? "Tapped before the best timing window." : "Tapped after the best timing window.",
      [terminal.id, attempt.id, press.id],
      // Judgement predicates use exact map time; player milliseconds use playback time.
      { value: Math.round(Math.abs(offset) / map.gameClockRate), unit: early ? "ms early" : "ms late" },
    );
  }
  if (terminal.mechanism !== "automatic-expiry") return unavailable("unaccounted-terminal-mechanism");
  const live = evidence.domains.liveSuccess;
  if (live.state !== "nonempty" || !live.start || !live.end) return unavailable("no-complete-live-opportunity");
  const liveStart = live.start,
    liveEnd = live.end;
  if (Object.values(evidence.dependencies).some((dep) => dep.status !== "complete") || evidence.limits.truncated)
    return unavailable("incomplete-local-opportunity");
  const fresh = evidence.inputs.filter(
    (item) => item.inLiveSuccess && !item.postTerminal && item.freshActionsKnown && item.record.freshActions.length > 0,
  );
  const contacts = evidence.insideIntervals.filter(
    (interval) =>
      !interval.postTerminal && interval.endTimeMs >= liveStart.timeMs && interval.startTimeMs <= liveEnd.timeMs,
  );
  if (capability.tapping === "automated") {
    if (capability.aim !== "manual") return unavailable("automated-aim-loss-conflict");
    const localInputs = evidence.inputs.filter((item) => item.inLiveSuccess && !item.postTerminal);
    const localAttempts = new Map(
      evidence.attempts
        .filter((attempt) => evidence.identity.analysisProfileId !== "stable" || attempt.automated)
        .map((attempt) => [attempt.id, attempt]),
    );
    const codes: string[] = [];
    const ids: string[] = [terminal.id];
    // A prior object's automated hit is not this target's opportunity before
    // Relax can hit the target. Keep that route in raw evidence, but do not let
    // it replace a completed early passage with consumed-input attribution.
    for (const item of localInputs.filter((item) => item.inside && automaticEligible(item.record.timeMs))) {
      const routes = evidence.routing.filter(
        (route) => localAttempts.get(route.attemptId)?.inputId === item.record.id && route.sequence < terminal.sequence,
      );
      const itemCodes: string[] = [];
      if (
        routes.some(
          (route) =>
            route.kind === "policy" &&
            route.componentId === evidence.targetId &&
            route.state === "rejected" &&
            route.timingResult !== null &&
            route.timingResult !== "MISS" &&
            Math.abs(route.offsetMs) <= geometry.hitWindows[2],
        )
      )
        itemCodes.push("notelock");
      if (
        routes.some(
          (route) =>
            route.kind === "selection" &&
            route.componentId !== null &&
            route.componentId !== evidence.targetId &&
            route.selectionStopped,
        )
      )
        itemCodes.push("tap-taken");
      if (itemCodes.length) {
        codes.push(...itemCodes);
        ids.push(item.record.id, ...routes.map((route) => route.id));
        diagnostics.opportunities.push({
          inputId: item.record.id,
          codes: itemCodes,
          eventIds: [item.record.id, ...routes.map((route) => route.id)],
        });
      } else if (automaticEligible(item.record.timeMs)) return unavailable("unaccounted-automatic-contact");
    }
    const distinct = [...new Set(codes)];
    // Selection of a neighbour alone does not establish a primary player cause.
    // Retain every routing witness in diagnostics instead of renaming it or
    // choosing a separate notelock observation from the same mixed evidence.
    if (distinct.includes("tap-taken")) return unavailable("automated-consumed-input-primary-unresolved");
    if (distinct.length) return supported(distinct, "Notelock", "The note order blocked this hit.", ids);
    const firstEligible = localInputs.find((item) => automaticEligible(item.record.timeMs));
    const lastContact=[...contacts].sort((a,b)=>b.endTimeMs-a.endTimeMs)[0];
    if (
      firstEligible &&
      contacts.length &&
      lastContact && !lastContact.rightCensored &&
      contacts.every((interval) => interval.endTimeMs < firstEligible.record.timeMs) &&
      !localInputs.some(item=>automaticEligible(item.record.timeMs) && item.inside)
    )
      return supported(
        ["left-early"],
        "Left early",
        "The cursor passed through the circle before it could register a hit.",
        [terminal.id, firstEligible.record.id, ...contacts.flatMap((interval) => interval.eventIds)],
      );
    if (!contacts.length && !localInputs.some((item) => item.inside))
      return supported(["off-target"], "Off target", "The cursor stayed outside the circle while it could be hit.", [
        terminal.id,
        ...localInputs.map((item) => item.record.id),
      ]);
    return unavailable("automated-tapping-loss-conflict");
  }
  if (!fresh.length) {
    const heldAtContact =
      evidence.inputs.some((item) => item.inLiveSuccess && item.inside && item.record.actions.length > 0) ||
      contacts.some((interval) => {
        const time = Math.max(interval.startTimeMs, liveStart.timeMs);
        const preceding = evidence.inputs
          .filter((item) => item.pathGroup === interval.pathGroup && item.record.timeMs <= time && !item.postTerminal)
          .pop();
        return !!preceding?.record.actions.length;
      });
    diagnostics.absence = { scope: "complete-live-opportunity", freshInputCount: 0, heldAtContact };
    // Autopilot owns aim, while all recorded tapping remains manual. Complete
    // raw absence can name No tap; holding is internal context, not a separate
    // player category. Manual-aim observations still feed the primary policy.
    const heldObservation = heldAtContact && capability.aim === "manual";
    return supported(
      [heldObservation ? "no-retap" : "no-tap"],
      heldObservation ? "No re-tap" : "No tap",
      heldObservation
        ? "A button stayed held while the cursor crossed the circle."
        : "No new tap was recorded during this note.",
      [terminal.id, ...evidence.inputs.filter((item) => item.inLiveSuccess).map((item) => item.record.id)],
    );
  }
  const attempts = new Map(evidence.attempts.map((attempt) => [attempt.id, attempt]));
  const routesFor = (item: CircleInputEvidence) =>
    evidence.routing.filter(
      (route) => attempts.get(route.attemptId)?.inputId === item.record.id && route.sequence < terminal.sequence,
    );
  const receptors = map.hitObjects
    .map((object) => (object instanceof HitCircle ? object : object instanceof Slider ? object.head : undefined))
    .filter((object): object is HitCircle => !!object);
  const uniqueTimeOpportunity = (item: CircleInputEvidence) =>
    !receptors.some(
      (other) =>
        other.id !== evidence.targetId &&
        item.record.timeMs >= other.spawnTime &&
        Math.abs(item.record.timeMs - other.hitTime) <= geometry.hitWindows[2],
    );
  const shapeEligible = fresh.filter(
    (item) =>
      !item.inside &&
      capability.aim === "manual" &&
      routesFor(item).every(
        (route) => route.kind !== "selection" || !route.selectionStopped || route.componentId === evidence.targetId,
      ) &&
      (routesFor(item).some((route) => route.componentId === evidence.targetId) || uniqueTimeOpportunity(item)),
  );
  const boundaryOrder = (boundary: NonNullable<typeof live.start>, end: boolean) => ({
    time: boundary.timeMs,
    sequence: boundary.sequence ?? (end ? Number.MAX_SAFE_INTEGER : -1),
  });
  const movement = classifyMovementEpisodes({
    center: geometry.position,
    radius: geometry.radius,
    geometryProfile: geometry.profile,
    scope: { start: boundaryOrder(live.start, false), end: boundaryOrder(live.end, true) },
    samples: evidence.inputs.map((item, index) => ({
      time: item.record.timeMs,
      sequence: item.record.sequence,
      position: item.record.position,
      discontinuityBefore:
        item.record.source.origin !== "parsed" ||
        !!item.record.source.discontinuityBefore?.length ||
        (index > 0 &&
          evidence.inputs[index - 1].record.source.origin === "parsed" &&
          item.record.source.origin === "parsed" &&
          item.record.source.parsedFrameIndex !==
            (evidence.inputs[index - 1].record.source as { parsedFrameIndex: number }).parsedFrameIndex + 1),
    })),
    failedPresses: shapeEligible.map((item) => ({
      id: item.record.id,
      time: item.record.timeMs,
      sequence: item.record.sequence,
      position: item.record.position,
      association: "target-routing" as const,
    })),
    competingInputs: evidence.routing
      .filter(
        (route) => route.kind === "selection" && route.selectionStopped && route.componentId !== evidence.targetId,
      )
      .flatMap((route) => {
        const attempt = attempts.get(route.attemptId);
        const item = evidence.inputs.find((candidate) => candidate.record.id === attempt?.inputId);
        return item ? [{ time: item.record.timeMs, sequence: item.record.sequence }] : [];
      }),
  });
  diagnostics.movement = movement;
  for (const item of fresh) {
    const routes = routesFor(item);
    const ids = [item.record.id, ...routes.map((route) => route.id)];
    const codes: string[] = [];
    if (item.inside) {
      if (
        routes.some(
          (route) =>
            route.kind === "policy" &&
            route.componentId === evidence.targetId &&
            route.state === "rejected" &&
            route.timingResult !== null &&
            route.timingResult !== "MISS" &&
            Math.abs(route.offsetMs) <= geometry.hitWindows[2],
        )
      )
        codes.push("notelock");
      if (
        routes.some(
          (route) =>
            route.kind === "selection" &&
            route.componentId !== null &&
            route.componentId !== evidence.targetId &&
            route.selectionStopped,
        )
      )
        codes.push("tap-taken");
      if (!codes.length) return unavailable("unaccounted-in-circle-action");
    } else {
      if (capability.aim === "automated") return unavailable("automated-aim-loss-conflict");
      const shape = movement.opportunities.find((opportunity) => opportunity.pressId === item.record.id);
      if (shape?.status === "supported") codes.push(...shape.labels.map((label) => shapeCodes[label]));
      else {
        const continuous = contacts.filter((interval) => interval.pathGroup === item.pathGroup);
        const before = continuous
          .filter(
            (interval) =>
              !interval.rightCensored &&
              interval.endTimeMs < item.record.timeMs &&
              interval.endTimeMs >= liveStart.timeMs,
          )
          .pop();
        const after = continuous.find(
          (interval) =>
            !interval.leftCensored &&
            interval.startTimeMs > item.record.timeMs &&
            interval.startTimeMs <= liveEnd.timeMs,
        );
        if (before && after) {
          codes.push("between-passes");
          ids.push(...before.eventIds, ...after.eventIds);
        } else if (after) {
          codes.push("aim-late");
          ids.push(...after.eventIds);
        } else if (before) {
          codes.push("left-early");
          ids.push(...before.eventIds);
        } else {
          const x =
            geometry.profile === "stable"
              ? Math.fround(item.record.position.x) - Math.fround(geometry.position.x)
              : item.record.position.x - geometry.position.x;
          const y =
            geometry.profile === "stable"
              ? Math.fround(item.record.position.y) - Math.fround(geometry.position.y)
              : item.record.position.y - geometry.position.y;
          const margin = Math.hypot(x, y) - geometry.radius;
          codes.push(margin > 0 && margin <= geometry.radius * 0.1 ? "edge-miss" : "off-target");
        }
      }
    }
    diagnostics.opportunities.push({ inputId: item.record.id, codes, eventIds: [...new Set(ids)] });
  }
  const codes = [...new Set(diagnostics.opportunities.flatMap((opportunity) => opportunity.codes))];
  const eventIds = [terminal.id, ...diagnostics.opportunities.flatMap((opportunity) => opportunity.eventIds)];
  if (!codes.length) return unavailable("unaccounted-live-actions");
  if (codes.length === 1)
    return supported(codes, presentation[codes[0]].headline, presentation[codes[0]].description, eventIds);
  const routingCodes = codes.filter((code) => code === "notelock" || code === "tap-taken");
  const aimCodes = codes.filter((code) => code !== "notelock" && code !== "tap-taken");
  const synchronizationCodes = ["aim-late", "left-early", "between-passes"];
  const synchronizationMismatch = aimCodes.filter((code) => synchronizationCodes.includes(code)).length > 1;
  const otherAimCodes = synchronizationMismatch
    ? aimCodes.filter((code) => !synchronizationCodes.includes(code))
    : aimCodes;
  const aimHeadline = synchronizationMismatch
    ? ["Aim–tap mismatch", ...otherAimCodes.map((code) => presentation[code].headline)].join(" · ")
    : aimCodes.map((code) => presentation[code].headline).join(" · ");
  if (!routingCodes.length) {
    const compact: Record<string, string> = {
      overshoot: "Overshoot",
      undershoot: "Undershoot",
      "wide-aim": "Wide",
      "aim-late": "Late aim",
      "left-early": "Early departure",
      "between-passes": "Between passes",
      "edge-miss": "Edge",
      "off-target": "Off target",
    };
    const headline =
      aimHeadline.split(/\s+/).filter((word) => word !== "·").length <= 4
        ? aimHeadline
        : aimCodes.map((code) => compact[code]).join(" · ");
    return supported(
      codes,
      headline,
      synchronizationMismatch && !otherAimCodes.length
        ? "The taps and the cursor's passes through the circle did not line up."
        : "Different taps missed at different points of the approach.",
      eventIds,
    );
  }
  const hasAim = codes.length > routingCodes.length;
  const headline =
    routingCodes.map((code) => presentation[code].headline).join(" · ") +
    (hasAim && routingCodes.length === 1
      ? " · " +
        (synchronizationMismatch
          ? "Aim–tap mismatch"
          : aimCodes.length === 1
          ? presentation[aimCodes[0]].headline
          : "Off target")
      : "");
  const description =
    routingCodes.length === 2
      ? hasAim
        ? "Some taps were blocked, taken by another note, or outside this circle."
        : "Some taps were blocked; another note took the others."
      : routingCodes[0] === "notelock"
      ? "Some taps were blocked; others missed the circle."
      : "Another note took some taps; others missed this circle.";
  return supported(codes, headline, description, eventIds);
}
