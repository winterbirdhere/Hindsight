import { CircleEvidence, CircleInputEvidence, EvidenceBoundary } from "../miss-explanation/CircleEvidence";
import { derivePrimaryDeadlineArrival, PrimaryDeadlineArrival } from "./PrimaryDeadlineArrival";

/** Morphology tolerances are evidence policy, never gameplay hit-test tolerances. */
export const PRIMARY_APPROACH_POLICY = {
  version: "primary-approach-v25",
  minimumApproachR: 0.5,
  deepSampleR: 0.95,
  /** Contacts that never get closer than this are grazes, not attribution passes. */
  grazeThresholdR: 0.75,
  brakeRatio: 0.5,
  settledSpeedRatio: 0.1,
  noiseR: 0.025,
  footprintR: 0.2,
  minimumTurnRadians: Math.PI / 6,
  maximumInputs: 4096,
  maximumPresses: 128,
  bypassDepartureR: 0.2,
  maximumOrderedInstantChangeR: 0.2,
  maximumTraversalChecks: 32768,
} as const;

export interface PrimaryApproachContext {
  pressIds: readonly string[];
  contextBoundaryInputIds?: readonly string[];
  start?: EvidenceBoundary;
  end?: EvidenceBoundary;
  /** Caller-proven multi-note scope. This module does not infer input ownership. */
  inputScopes?: Readonly<Record<string, PrimaryApproachInputScope>>;
}
export interface PrimaryApproachInputScope {
  start?: EvidenceBoundary;
  end?: EvidenceBoundary;
  /** Spatial witnesses end here; the press and contact interpolation may extend later. */
  placementEnd?: EvidenceBoundary;
  eventIds?: readonly string[];
}
export interface PrimaryContact {
  entryTimeMs: number;
  exitTimeMs: number;
  closestTimeMs: number;
  closestOffsetMs: number;
  minRadialR: number;
  sampledMinimumRadius: number | null;
  deepSampled: boolean;
  sampledEventIds: string[];
  placementSupport: "sampled" | "reconstructed-coherent" | "reconstructed-boundary" | "unproven";
  /** Observed heading corroboration, not a claim about an unrecorded cursor curve. */
  curvedHeadingEnvelope?: {
    intersection: { x: number; y: number };
    forwardR: number;
    backwardR: number;
    transverseSliceR: [number, number];
    eventIds: string[];
  };
  /** Three directed normal-plane witnesses with material inside clearance.
   * Reconstruction policy, not a fitted or historically observed cursor curve. */
  headingBand?: {
    transverseSliceR: [number, number];
    maximumNormalR: number;
    clearanceR: number;
    eventIds: string[];
  };
  eventIds: string[];
  reconstructedBoundary: boolean;
  leftCensored: boolean;
  rightCensored: boolean;
  relation: "same-approach" | "later-correction";
}

/** Coaching coverage only. Gameplay still uses the unchanged full hit radius. */
export function isPrimaryCursorPass(contact: Pick<PrimaryContact, "minRadialR">): boolean {
  return Number.isFinite(contact.minRadialR) && contact.minRadialR >= 0 && contact.minRadialR < PRIMARY_APPROACH_POLICY.grazeThresholdR;
}
export interface PrimaryLanding {
  provenance: "sampled" | "reconstructed";
  timeMs: number;
  offsetMs: number;
  radialR: number;
  alongR: number | null;
  transverseR: number | null;
  footprintStartTimeMs: number;
  footprintDurationMs: number;
  brakeRatio: number;
  turnRadians: number;
  eventIds: string[];
}
export interface PrimarySpatialCandidate {
  code: "overshoot" | "undershoot" | "misaim" | "wide-aim";
  label: "Overshoot" | "Undershoot" | "Misaim" | "Wide aim";
  radialR: number;
  clearanceR: number;
  eventIds: string[];
}
/** Direction is a refinement of established placement, not weaker aim evidence. */
export function refineDirectionalPlacement(code: PrimarySpatialCandidate["code"], transverseR: number,
  earlierProperContact: boolean): PrimarySpatialCandidate["code"] {
  if ((code === "overshoot" || code === "undershoot") &&
    (!(transverseR >= 0 && transverseR < PRIMARY_APPROACH_POLICY.grazeThresholdR) ||
      code === "overshoot" && !earlierProperContact)) return "misaim";
  return code;
}
export interface PrimaryApproachEpisode {
  inputId: string;
  status: "supported" | "unavailable";
  pressTimeMs: number;
  pressOffsetMs: number;
  placement: "misplaced" | "proper-pass" | "unproven";
  relation: "before-pass" | "inside-pass" | "after-pass" | "between-passes" | "no-proper-pass";
  properPass?: PrimaryContact;
  /** Arrival-only reconstruction outside the live domain; never a proper pass. */
  deadlineArrival?: PrimaryDeadlineArrival;
  landing?: PrimaryLanding;
  /** A completed deep passage followed by a material far-edge excursion and
   * return before this press. Refines a selected cursor cause only. */
  farEdgeReturn?: PrimaryFarEdgeReturn;
  /** Measured drifting outside footprint; causal admission also needs a usable target correction. */
  boundedOutsideDwell?: { eventIds:string[] };
  /** Complete outside lobe below the directional noise margin. Broad aim
   * admission requires an independently usable same-time correction. */
  boundedOutsideLobe?: { eventIds:string[] };
  /** A recorded outside flow crossing, without an inferred halt or future arrival. */
  lateralTraversal?: {
    basis?: "source-local-outside-traversal";
    axis: { x: number; y: number };
    startAlongR: number;
    endAlongR: number;
    minimumTransverseR: number;
    minimumRadialR?: number;
    planeTimeMs?: number;
    seedEventIds?: string[];
    progressEventIds: string[];
    eventIds: string[];
  };
  /** Source-local continuation which contradicts a purported short landing. */
  continuingFlow?: {
    basis?: "sampled-duplicate-contact" | "sampled-departure";
    startTimeMs: number;
    endTimeMs: number;
    radialProgressR: number;
    maximumTurnRadians: number;
    eventIds: string[];
  };
  lobeAlternatives?: PrimaryLanding[];
  spatialCandidates: PrimarySpatialCandidate[];
  timingIndependent: boolean;
  sampledMinimumRadius: number | null;
  reconstructedMinimumRadius: number | null;
  closest?: {
    timeMs: number;
    offsetMs: number;
    radialR: number;
    provenance: "sampled" | "reconstructed";
    eventIds: string[];
  };
  contacts: PrimaryContact[];
  eventIds: string[];
  limitations: string[];
  inputScope?: PrimaryApproachInputScope;
  /** Independently regenerated geometry after a leading source boundary.
   * The original refused witness is retained alongside this review evidence. */
  sourceScopedPlacements?: PrimaryApproachEpisode[];
  sourceScopedArrivals?: PrimaryApproachEpisode[];
}
export interface PrimaryApproachResult {
  policyVersion: string;
  episodes: PrimaryApproachEpisode[];
  limitations: string[];
}

type Point = { input: CircleInputEvidence; x: number; y: number; r: number; time: number };
type Segment = { a: Point; b: Point; dx: number; dy: number; length: number; speed: number; index: number };
export interface PrimaryFarEdgeReturn {
  /** Successful foreign receipt which bounds this witness, never its geometry. */
  receiptBoundary?: import("./PrimaryReceiptBoundary").OtherReceiptBoundary;
  axis: { x: number; y: number };
  axisIds: string[];
  priorContactEventIds: string[];
  deep: number;
  press: { offsetMs: number; radialR: number; alongR: number; sideR: number };
  crest: { inputId: string; offsetMs: number; excursionR: number; returnedR: number };
  eventIds: string[];
}
const norm = (x: number, y: number) => Math.hypot(x, y);
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x));
const ids = (values: string[]) => [...new Set(values)];

function measureFarEdgeReturn(peak: Segment, points: Point[], press: Point,
  contacts: PrimaryContact[], beat: number, originBracketId: string | undefined): PrimaryFarEdgeReturn | undefined {
  const axis = { x: peak.dx / peak.length, y: peak.dy / peak.length };
  const along = (p: Point) => p.x * axis.x + p.y * axis.y;
  const side = (p: Point) => p.x * axis.y - p.y * axis.x;
  const pressSide = side(press), pressAlong = along(press);
  if (!(Math.abs(pressSide) < PRIMARY_APPROACH_POLICY.grazeThresholdR &&
    pressAlong > Math.sqrt(1 - pressSide * pressSide))) return;
  const prior = contacts.filter(c => c.placementSupport !== "unproven" && isPrimaryCursorPass(c) &&
    c.relation === "same-approach" && c.exitTimeMs < press.time).at(-1);
  if (!prior) return;
  let crest: PrimaryFarEdgeReturn["crest"] | undefined;
  for (const p of points) {
    if (p.input.record.id === originBracketId || p.time < prior.exitTimeMs || p.time >= press.time || Math.abs(side(p)) >= 1) continue;
    const excursionR = along(p) - Math.sqrt(1 - side(p) * side(p)), returnedR = along(p) - pressAlong;
    // Both measurements belong to this same recorded point. Source order wins ties.
    if (excursionR > PRIMARY_APPROACH_POLICY.noiseR && returnedR > PRIMARY_APPROACH_POLICY.noiseR &&
      (!crest || excursionR > crest.excursionR))
      crest = { inputId: p.input.record.id, offsetMs: p.time - beat, excursionR, returnedR };
  }
  if (!crest) return;
  return { axis, axisIds: [peak.a.input.record.id, peak.b.input.record.id], priorContactEventIds: prior.eventIds,
    deep: prior.minRadialR, press: { offsetMs: press.time - beat, radialR: press.r, alongR: pressAlong, sideR: Math.abs(pressSide) }, crest,
    eventIds: ids([...prior.eventIds, ...points.filter(p => p.time >= peak.a.time && p.time <= press.time).map(p => p.input.record.id)]) };
}

/**
 * A bend can corroborate an already deep reconstructed chord without requiring
 * straight motion. Its directed incoming/outgoing rays must turn consistently,
 * meet forwards inside the chord's longitudinal span, and bound a normal-plane
 * slice wholly within the receptor. No fitted curve or new contact is inferred.
 */
function curvedHeadingEnvelope(incoming: Segment, crossing: Segment, outgoing: Segment): PrimaryContact["curvedHeadingEnvelope"] {
  const noise=PRIMARY_APPROACH_POLICY.noiseR;
  if([incoming,crossing,outgoing].some(s=>s.length<=noise || s.b.time<=s.a.time))return;
  const ux=incoming.dx/incoming.length,uy=incoming.dy/incoming.length,
    vx=outgoing.dx/outgoing.length,vy=outgoing.dy/outgoing.length,
    cx=crossing.dx/crossing.length,cy=crossing.dy/crossing.length;
  const turnIn=ux*cy-uy*cx,turnOut=cx*vy-cy*vx;
  if(turnIn*turnOut<=0 || ux*cx+uy*cy<=0 || cx*vx+cy*vy<=0)return;
  const denominator=ux*vy-uy*vx;
  if(Math.abs(denominator)<=1e-12)return;
  const forwardR=(crossing.dx*vy-crossing.dy*vx)/denominator,
    backwardR=(ux*crossing.dy-uy*crossing.dx)/denominator;
  if(!(forwardR>0 && backwardR>0))return;
  const a=crossing.a,b=crossing.b,t={x:a.x+forwardR*ux,y:a.y+forwardR*uy};
  const along=(p:{x:number;y:number})=>p.x*cx+p.y*cy;
  const start=along(a),end=along(b),middle=along(t);
  if(!(start<0 && end>0 && middle>=start && middle<=end))return;
  const slice:number[]=[];
  for(const [left,right] of [[a,b],[a,t],[t,b]]) {
    const l=along(left),r=along(right);
    if(l*r>0 || l===r)continue;
    const fraction=l/(l-r),x=left.x+fraction*(right.x-left.x),y=left.y+fraction*(right.y-left.y);
    slice.push(x*cy-y*cx);
  }
  if(slice.length<2 || slice.some(value=>!Number.isFinite(value)||Math.abs(value)>=1))return;
  return {intersection:t,forwardR,backwardR,transverseSliceR:[Math.min(...slice),Math.max(...slice)],eventIds:[]};
}

function withinBoundary(item: CircleInputEvidence, boundary: EvidenceBoundary, start: boolean): boolean {
  const record = item.record;
  const comparison =
    record.timeMs - boundary.timeMs || (boundary.sequence === undefined ? 0 : record.sequence - boundary.sequence);
  return start
    ? comparison > 0 || (comparison === 0 && boundary.inclusive)
    : comparison < 0 || (comparison === 0 && boundary.inclusive);
}

function shallowHeadingBand(incoming: Segment, crossing: Segment, outgoing: Segment): PrimaryContact["headingBand"] {
  const ux=crossing.dx/crossing.length,uy=crossing.dy/crossing.length;
  const along=(p:Point)=>p.x*ux+p.y*uy,normal=(p:{x:number;y:number})=>p.y*ux-p.x*uy;
  if(!(along(crossing.a)<0 && along(crossing.b)>0))return;
  const project=(segment:Segment,point:Point,forward:boolean)=>{
    const dot=segment.dx*ux+segment.dy*uy;
    if(!(dot>0))return;
    const fraction=-along(point)/dot;
    if(forward ? fraction<0 : fraction>0)return;
    return normal({x:point.x+fraction*segment.dx,y:point.y+fraction*segment.dy});
  };
  const before=project(incoming,incoming.b,true),after=project(outgoing,outgoing.a,false);
  if(before===undefined || after===undefined)return;
  const band=[normal(crossing.a),before,after],maximumNormalR=Math.max(...band.map(Math.abs));
  if(band.some(n=>!Number.isFinite(n)) || maximumNormalR>1-PRIMARY_APPROACH_POLICY.noiseR)return;
  return {transverseSliceR:[Math.min(...band),Math.max(...band)],maximumNormalR,clearanceR:1-maximumNormalR,eventIds:[]};
}

function continuous(a: CircleInputEvidence, b: CircleInputEvidence, radius: number): boolean {
  return (
    a.record.source.origin === "parsed" &&
    b.record.source.origin === "parsed" &&
    b.record.source.parsedFrameIndex === a.record.source.parsedFrameIndex + 1 &&
    !b.record.source.discontinuityBefore?.length &&
    b.record.sequence > a.record.sequence &&
    (b.record.timeMs > a.record.timeMs ||
      (b.record.timeMs === a.record.timeMs &&
        norm(a.record.position.x - b.record.position.x, a.record.position.y - b.record.position.y) <=
          radius * PRIMARY_APPROACH_POLICY.maximumOrderedInstantChangeR))
  );
}

/** Pure local geometry only. The caller owns input-to-target relevance and primary-cause selection. */
export function analyzePrimaryApproaches(
  evidence: CircleEvidence,
  context: PrimaryApproachContext,
): PrimaryApproachResult {
  const policy = PRIMARY_APPROACH_POLICY;
  const limitations: string[] = [];
  if (context.pressIds.length > policy.maximumPresses) limitations.push("approach-press-limit");
  const blocked =
    evidence.limits.truncated ||
    evidence.inputs.length > policy.maximumInputs ||
    !evidence.geometry ||
    !evidence.target ||
    !evidence.terminal ||
    evidence.domains.interaction.state !== "nonempty" ||
    evidence.status !== "supported" ||
    Object.values(evidence.dependencies).some((dep) =>
      dep.reasons.some((reason) => reason.startsWith("dependency-conflict:")),
    );
  const contexts = new Set(context.contextBoundaryInputIds ?? []);
  const episodes = ids([...context.pressIds])
    .slice(0, policy.maximumPresses)
    .map((inputId) => {
      const pressIndex = evidence.inputs.findIndex((item) => item.record.id === inputId);
      const press = evidence.inputs[pressIndex];
      const inputScope = context.inputScopes?.[inputId];
      const beat = evidence.target?.hitTimeMs ?? 0;
      const result: PrimaryApproachEpisode = {
        inputId,
        status: "unavailable",
        pressTimeMs: press?.record.timeMs ?? 0,
        pressOffsetMs: (press?.record.timeMs ?? beat) - beat,
        placement: "unproven",
        relation: "no-proper-pass",
        spatialCandidates: [],
        timingIndependent: false,
        sampledMinimumRadius: null,
        reconstructedMinimumRadius: null,
        contacts: [],
        eventIds: [],
        limitations: [],
      };
      if (inputScope) {
        const validBoundary = (boundary: EvidenceBoundary | undefined) =>
          !boundary ||
          (Number.isFinite(boundary.timeMs) &&
            typeof boundary.inclusive === "boolean" &&
            (boundary.sequence === undefined || (Number.isSafeInteger(boundary.sequence) && boundary.sequence >= 0)));
        if (
          ![inputScope.start, inputScope.end, inputScope.placementEnd].every(validBoundary) ||
          (inputScope.eventIds &&
            (inputScope.eventIds.length > policy.maximumInputs ||
              inputScope.eventIds.some((id) => typeof id !== "string")))
        ) {
          result.limitations.push("invalid-primary-input-scope");
          return result;
        }
        result.inputScope = {
          ...(inputScope.start ? { start: { ...inputScope.start } } : {}),
          ...(inputScope.end ? { end: { ...inputScope.end } } : {}),
          ...(inputScope.placementEnd ? { placementEnd: { ...inputScope.placementEnd } } : {}),
          ...(inputScope.eventIds ? { eventIds: [...inputScope.eventIds] } : {}),
        };
      }
      if (blocked || !press || !evidence.geometry || !evidence.target || !evidence.terminal) {
        result.limitations.push(blocked ? "incomplete-or-invalid-approach-evidence" : "missing-relevant-input");
        return result;
      }
      const geometry = evidence.geometry;
      if (!(geometry.radius > 0) || !Number.isFinite(geometry.radius)) {
        result.limitations.push("invalid-approach-geometry");
        return result;
      }
      const terminal: EvidenceBoundary = {
        timeMs: evidence.terminal.timeMs,
        sequence: evidence.terminal.sequence,
        inclusive: false,
      };
      const interaction = evidence.domains.interaction;
      // The expiry update can contain an earlier rejected attempt at the same
      // timestamp. This is approach evidence only, never a live hit opportunity;
      // admission still independently certifies the canonical receiver/policy.
      const expiryReceipt = press.record.timeMs===evidence.terminal.timeMs &&
        evidence.terminal.mechanism==="automatic-expiry" && evidence.terminal.result==="MISS" &&
        evidence.routing.some(r=>r.kind==="policy"&&r.timeMs===press.record.timeMs&&r.state==="rejected"&&
          r.blockerId===evidence.targetId&&r.sequence<evidence.terminal!.sequence&&
          evidence.attempts.some(a=>a.id===r.attemptId&&a.inputId===press.record.id));
      const allowed = (item: CircleInputEvidence) =>
        item.record.source.origin === "parsed" &&
        !item.postTerminal &&
        withinBoundary(item, terminal, false) &&
        (!interaction.start || withinBoundary(item, interaction.start, true)) &&
        (!interaction.end || withinBoundary(item, interaction.end, false) || item.record.id===press.record.id&&expiryReceipt) &&
        (!context.start || withinBoundary(item, context.start, true)) &&
        (!context.end || withinBoundary(item, context.end, false)) &&
        (!inputScope?.start || withinBoundary(item, inputScope.start, true)) &&
        (!inputScope?.end || withinBoundary(item, inputScope.end, false));
      if (!allowed(press)) {
        result.limitations.push("outside-live-approach-scope");
        return result;
      }
      const great = geometry.hitWindows[0],
        success = geometry.hitWindows[2];
      if (!(great > 0) || !(success > 0) || !Number.isFinite(great) || !Number.isFinite(success)) {
        result.limitations.push("invalid-approach-windows");
        return result;
      }
      // One local success window on either side of the beat/press. A nearby assigned
      // action or source boundary shortens this; previous-object centres never define the axis.
      const horizon = Math.max(4 * great, success);
      const fromTime = Math.min(beat, press.record.timeMs) - horizon;
      const toTime = Math.max(beat, press.record.timeMs) + horizon;
      const sourceRadius = (item: CircleInputEvidence) => norm(item.record.position.x-geometry.position.x,item.record.position.y-geometry.position.y)/geometry.radius;
      let first = pressIndex,
        last = pressIndex;
      while (first > 0) {
        const previous = evidence.inputs[first - 1],
          current = evidence.inputs[first];
        if (
          !allowed(previous) ||
          (previous.record.timeMs < fromTime && (
            sourceRadius(previous) + policy.noiseR < sourceRadius(current) ||
            (previous.record.freshActions.length > 0 && !context.pressIds.includes(previous.record.id))
          )) ||
          contexts.has(previous.record.id) ||
          !continuous(previous, current, geometry.radius)
        )
          break;
        first--;
      }
      while (last + 1 < evidence.inputs.length) {
        const current = evidence.inputs[last],
          next = evidence.inputs[last + 1];
        if (
          !allowed(next) ||
          next.record.timeMs > toTime ||
          contexts.has(next.record.id) ||
          !continuous(current, next, geometry.radius)
        )
          break;
        last++;
      }
      // Keep the immediately adjacent inside endpoint of a departure crossing
      // the duration horizon. This is a measured exit, not permission to borrow
      // an earlier approach across action, source or explicit scope boundaries.
      const departureOrigin=evidence.inputs[first-1],departureEnd=evidence.inputs[first];
      if(departureOrigin && departureOrigin.record.timeMs<fromTime && departureEnd.record.timeMs>=fromTime &&
        allowed(departureOrigin) && !contexts.has(departureOrigin.record.id) && !contexts.has(departureEnd.record.id) &&
        departureOrigin.inside && !departureEnd.inside && departureOrigin.freshActionsKnown && departureEnd.freshActionsKnown &&
        !departureOrigin.record.freshActions.length && departureEnd.record.timeMs>departureOrigin.record.timeMs &&
        continuous(departureOrigin,departureEnd,geometry.radius) &&
        departureOrigin.record.source.origin==="parsed" && departureEnd.record.source.origin==="parsed" &&
        (departureOrigin.record.source.rawTokenIndex===undefined && departureEnd.record.source.rawTokenIndex===undefined ||
          departureOrigin.record.source.rawTokenIndex!==undefined &&
          departureEnd.record.source.rawTokenIndex===departureOrigin.record.source.rawTokenIndex+1))first--;
      // The previous assigned action ends the earlier episode, but its exact
      // adjacent outside coordinate can still bracket the beginning of this
      // inward segment. It supplies no previous landing/contact or earlier
      // motion. Require the whole bracket to remain outside and approach the
      // current target monotonically before admitting that single endpoint.
      let originBracketId: string | undefined;
      const origin=evidence.inputs[first-1], originEnd=evidence.inputs[first];
      if(origin && contexts.has(origin.record.id) && allowed(origin) && origin.record.timeMs >= fromTime &&
        continuous(origin,originEnd,geometry.radius) && sourceRadius(originEnd)>1 &&
        sourceRadius(origin)>sourceRadius(originEnd)+policy.noiseR) {
        const round=geometry.profile === "stable" ? Math.fround : (value:number)=>value;
        const ax=round(origin.record.position.x)-round(geometry.position.x),
          ay=round(origin.record.position.y)-round(geometry.position.y),
          bx=round(originEnd.record.position.x)-round(geometry.position.x),
          by=round(originEnd.record.position.y)-round(geometry.position.y);
        if(bx*(bx-ax)+by*(by-ay)<=0) {originBracketId=origin.record.id;first--;}
      }
      // An arbitrary duration horizon must not remove the next valid source
      // bracket from one of two presses sharing the same local passage. It may
      // support contact only, never a borrowed downstream spatial landing.
      let horizonBracketIndex = -1;
      const bracket=evidence.inputs[last+1], edge=evidence.inputs[last];
      if(bracket && edge.record.timeMs <= toTime && bracket.record.timeMs > toTime && allowed(bracket) &&
         !contexts.has(bracket.record.id) && continuous(edge,bracket,geometry.radius) &&
         (!bracket.record.freshActions.length || context.pressIds.includes(bracket.record.id))) {
        last++;horizonBracketIndex=last-first;
      }
      const rounded = geometry.profile === "stable" ? Math.fround : (value: number) => value;
      const centerX = rounded(geometry.position.x),
        centerY = rounded(geometry.position.y),
        radius = Math.fround(geometry.radius);
      const points: Point[] = evidence.inputs.slice(first, last + 1).map((input) => {
        const x = (rounded(input.record.position.x) - centerX) / radius,
          y = (rounded(input.record.position.y) - centerY) / radius;
        return { input, x, y, r: norm(x, y), time: input.record.timeMs };
      });
      if (points.some((point) => ![point.x, point.y, point.time].every(Number.isFinite))) {
        result.limitations.push("nonfinite-approach-source");
        return result;
      }
      result.status = "supported";
      result.eventIds = points.map((point) => point.input.record.id);
      result.sampledMinimumRadius = Math.min(...points.map((point) => point.r));
      result.reconstructedMinimumRadius = result.sampledMinimumRadius;
      const sampledClosest = points.reduce((best, point) => (point.r < best.r ? point : best));
      result.closest = {
        timeMs: sampledClosest.time,
        offsetMs: sampledClosest.time - beat,
        radialR: sampledClosest.r,
        provenance: "sampled",
        eventIds: [sampledClosest.input.record.id],
      };
      const segments: Segment[] = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i],
          dt = b.time - a.time;
        if (dt <= 0) {
          if (a.x !== b.x || a.y !== b.y) result.limitations.push("ordered-zero-time-position-change");
          continue;
        }
        const dx = b.x - a.x,
          dy = b.y - a.y,
          length = norm(dx, dy);
        const segment = { a, b, dx, dy, length, speed: length / dt, index: i - 1 };
        segments.push(segment);
        const fraction = length ? clamp(-(a.x * dx + a.y * dy) / (length * length), 0, 1) : 0;
        const radial = norm(a.x + fraction * dx, a.y + fraction * dy),
          time = a.time + fraction * dt;
        if (radial < (result.reconstructedMinimumRadius ?? Number.MAX_VALUE)) {
          result.reconstructedMinimumRadius = radial;
          result.closest = {
            timeMs: time,
            offsetMs: time - beat,
            radialR: radial,
            provenance: fraction > 0 && fraction < 1 ? "reconstructed" : "sampled",
            eventIds: [a.input.record.id, b.input.record.id],
          };
        }
        const A = length * length,
          B = 2 * (a.x * dx + a.y * dy),
          C = a.r * a.r - 1,
          D = B * B - 4 * A * C;
        if (A === 0 ? a.r > 1 : D < 0) continue;
        const entry = A === 0 ? 0 : Math.max(0, (-B - Math.sqrt(D)) / (2 * A));
        const exit = A === 0 ? 1 : Math.min(1, (-B + Math.sqrt(D)) / (2 * A));
        if (entry > exit || exit < 0 || entry > 1) continue;
        const start = a.time + entry * dt,
          end = a.time + exit * dt;
        const prev = result.contacts[result.contacts.length - 1];
        const contact: PrimaryContact =
          prev && Math.abs(prev.exitTimeMs - start) < 1e-7
            ? prev
            : {
                entryTimeMs: start,
                exitTimeMs: end,
                closestTimeMs: time,
                closestOffsetMs: time - beat,
                minRadialR: radial,
                sampledMinimumRadius: null,
                deepSampled: false,
                sampledEventIds: [],
                placementSupport: "unproven",
                eventIds: [],
                reconstructedBoundary: entry > 0 || exit < 1,
                leftCensored: i === 1 && a.r <= 1,
                rightCensored: false,
                relation: "same-approach",
              };
        if (contact !== prev) result.contacts.push(contact);
        contact.exitTimeMs = end;
        contact.rightCensored = i === points.length - 1 && b.r <= 1;
        if (radial < contact.minRadialR) {
          contact.minRadialR = radial;
          contact.closestTimeMs = time;
          contact.closestOffsetMs = time - beat;
        }
        contact.reconstructedBoundary ||= entry > 0 || exit < 1;
        contact.eventIds = ids([...contact.eventIds, a.input.record.id, b.input.record.id]);
        for (const point of [a, b])
          if (point.r <= 1) {
            contact.sampledMinimumRadius = Math.min(contact.sampledMinimumRadius ?? point.r, point.r);
            contact.deepSampled ||= point.r <= policy.deepSampleR;
            contact.sampledEventIds = ids([...contact.sampledEventIds, point.input.record.id]);
          }
      }
      const localMotionSegments=originBracketId
        ? segments.filter(segment=>segment.a.input.record.id!==originBracketId) : segments;
      for (const contact of result.contacts) {
        if (contact.sampledEventIds.length) {
          contact.placementSupport = "sampled";
          continue;
        }
        if (contact.leftCensored || contact.rightCensored) continue;
        const crossingIndex = localMotionSegments.findIndex(
          (s) => s.a.time < contact.entryTimeMs && s.b.time > contact.exitTimeMs,
        );
        const crossing = localMotionSegments[crossingIndex];
        // Key changes may repeat a cursor position. They do not erase the
        // contiguous moving witnesses, and are never counted as deceleration.
        let before = crossingIndex - 1, after = crossingIndex + 1;
        while (before >= 0 && localMotionSegments[before].length === 0) before--;
        while (after < localMotionSegments.length && localMotionSegments[after].length === 0) after++;
        const incoming = localMotionSegments[before], outgoing = localMotionSegments[after];
        if (!crossing || !incoming || !outgoing) continue;
        const aligned = (s: Segment) =>
          s.length > policy.noiseR &&
          crossing.length > policy.noiseR &&
          (s.dx * crossing.dx + s.dy * crossing.dy) / (s.length * crossing.length) >=
            Math.cos(policy.minimumTurnRadians);
        if(contact.minRadialR>policy.deepSampleR) {
          // A shallow chord alone is insufficient. Both immediate directed
          // headings must corroborate a whole inside normal band, in this
          // episode's own complete source and spatial scope. Keep exact key-only
          // duplicates in the witness; a changed zero-time position is a fence.
          const bridge=points.slice(incoming.index,outgoing.index+2);
          const same=(a:readonly number[],b:readonly number[])=>a.length===b.length && a.every(v=>b.includes(v));
          const rawOffsets=bridge.flatMap(p=>p.input.record.source.origin==="parsed" && p.input.record.source.rawTokenIndex!==undefined
            ? [p.input.record.source.rawTokenIndex-p.input.record.source.parsedFrameIndex] : []);
          const valid=Object.values(evidence.dependencies).every(d=>d.status==="complete") &&
            new Set(rawOffsets).size<=1 &&
            bridge.every((p,k)=>{
              const q=p.input.record,previous=evidence.inputs[first+incoming.index+k-1]?.record,
                previousSource=k ? bridge[k-1].input.record.source : undefined;
              return p.input.freshActionsKnown && p!==points[horizonBracketIndex] &&
                (!inputScope?.placementEnd || withinBoundary(p.input,inputScope.placementEnd,false)) &&
                !contexts.has(q.id) && q.source.origin==="parsed" && !q.source.discontinuityBefore?.length &&
                Number.isSafeInteger(q.source.parsedFrameIndex) && q.source.parsedFrameIndex>=0 &&
                (q.source.rawTokenIndex===undefined || (Number.isSafeInteger(q.source.rawTokenIndex) && q.source.rawTokenIndex>=0)) &&
                q.actions.every(v=>v===0 || v===1) && new Set(q.actions).size===q.actions.length &&
                q.previousActions.every(v=>v===0 || v===1) && new Set(q.previousActions).size===q.previousActions.length &&
                (q.rawButtonMask===undefined || (Number.isSafeInteger(q.rawButtonMask) && q.rawButtonMask>=0 &&
                  same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))) &&
                same(q.freshActions,q.actions.filter(v=>!q.previousActions.includes(v))) &&
                (!previous || same(q.previousActions,previous.actions)) &&
                (!q.freshActions.length || context.pressIds.includes(q.id)) &&
                (!k || (p.time>=bridge[k-1].time && (p.time!==bridge[k-1].time ||
                  (p.x===bridge[k-1].x && p.y===bridge[k-1].y)) &&
                  (q.source.rawTokenIndex===undefined || previousSource?.origin!=="parsed" ||
                    previousSource.rawTokenIndex===undefined || q.source.rawTokenIndex===previousSource.rawTokenIndex+1)));
            });
          const band=valid && aligned(incoming) && aligned(outgoing) ? shallowHeadingBand(incoming,crossing,outgoing) : undefined;
          if(band) {
            contact.placementSupport="reconstructed-coherent";
            contact.eventIds=ids([...contact.eventIds,...bridge.map(p=>p.input.record.id)]);
            contact.headingBand={...band,eventIds:[...contact.eventIds]};
          }
          continue;
        }
        const envelope=!(aligned(incoming) && aligned(outgoing)) &&
          !result.limitations.includes("ordered-zero-time-position-change")
          ? curvedHeadingEnvelope(incoming,crossing,outgoing) : undefined;
        if ((aligned(incoming) && aligned(outgoing)) || envelope) {
          contact.placementSupport = "reconstructed-coherent";
          contact.eventIds = ids([...contact.eventIds, ...points.slice(incoming.index, outgoing.index + 2).map(p => p.input.record.id)]);
          if(envelope)contact.curvedHeadingEnvelope={...envelope,eventIds:[...contact.eventIds]};
        }
      }
      const placementOnlyClosest=result.closest;
      // A raw input dispatched immediately before expiry can bracket the live
      // deadline without itself being a playable sample. Keep it outside the
      // sampled/placement episode. Only the clipped continuous entry is evidence.
      const boundaryInput=evidence.inputs[last+1], boundaryLeft=points[points.length-1];
      const liveEnd=evidence.domains.liveSuccess.end;
      if(boundaryInput && liveEnd && interaction.end && boundaryLeft.r > 1 &&
         boundaryLeft.time < liveEnd.timeMs && boundaryInput.record.timeMs > interaction.end.timeMs &&
         boundaryInput.record.timeMs > boundaryLeft.time && boundaryInput.record.source.origin === "parsed" &&
         !boundaryInput.postTerminal && withinBoundary(boundaryInput,terminal,false) &&
         continuous(boundaryLeft.input,boundaryInput,geometry.radius) && !contexts.has(boundaryInput.record.id) &&
         !boundaryInput.record.freshActions.length &&
         (!context.end || withinBoundary(boundaryInput,context.end,false)) &&
         (!inputScope?.end || withinBoundary(boundaryInput,inputScope.end,false))) {
        const x=(rounded(boundaryInput.record.position.x)-centerX)/radius,
          y=(rounded(boundaryInput.record.position.y)-centerY)/radius;
        const dx=x-boundaryLeft.x,dy=y-boundaryLeft.y,length=norm(dx,dy);
        const incoming=[...localMotionSegments].reverse().find(s=>s.length > policy.noiseR);
        const dt=boundaryInput.record.timeMs-boundaryLeft.time,
          clip=Math.min(liveEnd.timeMs,interaction.end.timeMs), fraction=(clip-boundaryLeft.time)/dt;
        const a=length*length,b=2*(boundaryLeft.x*dx+boundaryLeft.y*dy),c=boundaryLeft.r*boundaryLeft.r-1,
          discriminant=b*b-4*a*c;
        if(incoming && norm(x,y) <= policy.deepSampleR && length > policy.noiseR && discriminant >= 0 &&
           (incoming.dx*dx+incoming.dy*dy)/(incoming.length*length) >= Math.cos(policy.minimumTurnRadians)) {
          const entry=(-b-Math.sqrt(discriminant))/(2*a),exit=(-b+Math.sqrt(discriminant))/(2*a);
          if(entry >= 0 && entry < fraction && fraction <= exit && fraction < 1) {
            const closestFraction=clamp(-b/(2*a),entry,fraction),time=boundaryLeft.time+closestFraction*dt,
              radial=norm(boundaryLeft.x+closestFraction*dx,boundaryLeft.y+closestFraction*dy);
            const eventIds=ids([...points.slice(incoming.index).map(p=>p.input.record.id),boundaryInput.record.id]);
            result.contacts.push({entryTimeMs:boundaryLeft.time+entry*dt,exitTimeMs:clip,
              closestTimeMs:time,closestOffsetMs:time-beat,minRadialR:radial,sampledMinimumRadius:null,
              deepSampled:false,sampledEventIds:[],placementSupport:"reconstructed-boundary",eventIds,
              reconstructedBoundary:true,leftCensored:false,rightCensored:true,relation:"same-approach"});
            result.eventIds=ids([...result.eventIds,...eventIds]);
            if(radial < (result.reconstructedMinimumRadius ?? Infinity)) {
              result.reconstructedMinimumRadius=radial;
              result.closest={timeMs:time,offsetMs:time-beat,radialR:radial,provenance:"reconstructed",eventIds};
            }
          }
        }
      }
      const pi = pressIndex - first,
        pressPoint = points[pi];
      // Keep contacts and the press in their full episode: a fence may precede a
      // late press, and the next recorded point may bracket its exit. Only spatial
      // proofs lose the downstream samples. This is not a global clip of jumps.
      const placementAllowed = (point: Point) =>
        point !== points[horizonBracketIndex] && (!inputScope?.placementEnd || withinBoundary(point.input, inputScope.placementEnd, false));
      const placementPoints = inputScope?.placementEnd || horizonBracketIndex >= 0 ? points.filter(placementAllowed) : points;
      const boundedPlacementSegments = inputScope?.placementEnd || horizonBracketIndex >= 0
        ? segments.filter((segment) => placementAllowed(segment.a) && placementAllowed(segment.b))
        : segments;
      // The boundary coordinate measures inward progress only. Its preceding
      // assigned action cannot supply the speed/direction, brake or turn used
      // to classify this press's own placement.
      const placementSegments=originBracketId
        ? boundedPlacementSegments.filter(segment=>segment.a.input.record.id!==originBracketId)
        : boundedPlacementSegments;
      const placementSampledClosest = placementPoints.reduce<Point | undefined>(
        (best, point) => (!best || point.r < best.r ? point : best),
        undefined,
      );
      let placementClosest: PrimaryApproachEpisode["closest"] = placementSampledClosest
        ? {
            timeMs: placementSampledClosest.time,
            offsetMs: placementSampledClosest.time - beat,
            radialR: placementSampledClosest.r,
            provenance: "sampled",
            eventIds: [placementSampledClosest.input.record.id],
          }
        : undefined;
      if (!inputScope?.placementEnd && horizonBracketIndex < 0) placementClosest = placementOnlyClosest;
      else
        for (const segment of placementSegments) {
          const { a, b, dx, dy, length } = segment;
          const fraction = length ? clamp(-(a.x * dx + a.y * dy) / (length * length), 0, 1) : 0;
          const radialR = norm(a.x + fraction * dx, a.y + fraction * dy);
          if (!placementClosest || radialR < placementClosest.radialR) {
            const timeMs = a.time + fraction * (b.time - a.time);
            placementClosest = {
              timeMs,
              offsetMs: timeMs - beat,
              radialR,
              provenance: fraction > 0 && fraction < 1 ? "reconstructed" : "sampled",
              eventIds: [a.input.record.id, b.input.record.id],
            };
          }
        }
      // Derive the approach direction from observed inbound motion. A brake uses a
      // positive local speed change and measurable approach, never an assumed intended centre.
      const inbound = placementSegments.filter(
        (s) => s.b.time <= pressPoint.time && s.a.r > s.b.r && s.length > policy.noiseR,
      );
      const peak = inbound.reduce<Segment | undefined>(
        (best, s) => (!best || s.speed > best.speed ? s : best),
        undefined,
      );
      // Speed establishes a local direction; it does not mark the beginning of
      // the approach. Keep the uninterrupted inward run before that speed peak.
      // A radial reversal, source/context boundary or spatial fence ends the run.
      const inwardRun = (segment: Segment) => {
        let start = segment.index;
        while (
          start > 0 &&
          placementAllowed(points[start - 1]) &&
          points[start].r <= points[start - 1].r + policy.noiseR
        ) start--;
        return points.slice(start, segment.index + 2);
      };
      if (peak && pressPoint.r > 1) {
        // An older precursor may establish approach progress, but its speed
        // cannot turn long subsequent travel into a local settled footprint.
        const extendedPeak=peak.a.time < fromTime;
        const incomingRun = inwardRun(peak);
        const progress =
          incomingRun[0].r -
          Math.min(
            ...points
              .slice(peak.index, pi + 1)
              .filter(placementAllowed)
              .map((point) => point.r),
          );
        const ux = peak.dx / peak.length,
          uy = peak.dy / peak.length;
        // The slow footprint must reach the relevant press. Otherwise a previous
        // object's landing or an earlier correction cannot supply this tap's cause.
        const before = placementSegments.filter((s) => s.b.time <= pressPoint.time + great && s.index >= peak.index);
        // A short accelerating correction does not erase a positively observed
        // misplaced footprint shared by the same nearby tap episode.
        const nearby = before.filter(
          (s) =>
            s.b.time >= pressPoint.time - great &&
            s.speed / peak.speed <= policy.brakeRatio &&
            s.a.r > 1 &&
            s.b.r > 1 &&
            (!extendedPeak || (norm(s.a.x-pressPoint.x,s.a.y-pressPoint.y) <= policy.footprintR &&
              norm(s.b.x-pressPoint.x,s.b.y-pressPoint.y) <= policy.footprintR)) &&
            !points.slice(s.index + 1, pi + 1).some((point) => point.r <= 1),
        );
        const near = [...nearby].reverse().find((s) => s.b.time <= pressPoint.time) ?? nearby[0];
        if (near && progress >= policy.minimumApproachR && near.speed / peak.speed <= policy.brakeRatio) {
          const footprintSpeed = Math.min(
            peak.speed * policy.brakeRatio,
            Math.max(near.speed * 2, policy.noiseR / great),
          );
          let slowIndex = before.indexOf(near);
          while (
            slowIndex > 0 &&
            (!extendedPeak || norm(before[slowIndex - 1].a.x-pressPoint.x,before[slowIndex - 1].a.y-pressPoint.y) <= policy.footprintR) &&
            (before[slowIndex - 1].speed <= footprintSpeed ||
              (before[slowIndex - 1].speed <= peak.speed * policy.brakeRatio &&
                norm(before[slowIndex - 1].a.x - pressPoint.x, before[slowIndex - 1].a.y - pressPoint.y) <=
                  policy.footprintR))
          )
            slowIndex--;
          const slow = before[slowIndex];
          const footprint = points.slice(slow.index, near.index + 2);
          const outside = footprint.filter((point) => point.r > 1);
          const allOutside = outside.length === footprint.length;
          const anchor = allOutside ? footprint[0] : pressPoint;
          // If the first deceleration point is inside, the observed outside endpoint
          // is the candidate footprint; no interpolated outside plateau is invented.
          const along = anchor.x * ux + anchor.y * uy,
            transverse = Math.abs(anchor.x * uy - anchor.y * ux);
          const next = placementSegments.find((s) => s.a.time >= pressPoint.time && s.length > policy.noiseR);
          const turn = Math.max(
            0,
            ...[near, next]
              .filter((s): s is Segment => !!s && s.length > policy.noiseR)
              .map((s) => Math.acos(clamp((s.dx * ux + s.dy * uy) / s.length, -1, 1))),
          );
          const start = allOutside ? slow.a.time : pressPoint.time;
          const earlierContact = result.contacts.some((contact) => contact.entryTimeMs < anchor.time);
          let code: PrimarySpatialCandidate["code"] | undefined;
          let clearance = 0;
          if (transverse > 1) {
            code = "misaim";
            clearance = transverse - 1;
          } else {
            const edge = Math.sqrt(Math.max(0, 1 - transverse * transverse));
            const nextContact = result.contacts.find((contact) => contact.entryTimeMs > anchor.time);
            const reverseBeforeContact = placementSegments.some(
              (s) =>
                s.a.time >= near.b.time &&
                (!nextContact || s.b.time < nextContact.entryTimeMs) &&
                s.a.r > 1 &&
                s.b.r > 1 &&
                s.length > policy.noiseR &&
                s.dx * ux + s.dy * uy < 0,
            );
            if (
              along < -edge &&
              !earlierContact &&
              (near.speed / peak.speed <= policy.settledSpeedRatio || reverseBeforeContact)
            ) {
              code = "undershoot";
              clearance = -edge - along;
            } else if (along > edge && earlierContact && (allOutside || turn >= policy.minimumTurnRadians)) {
              // A slow segment spanning the circle can be ordinary flow after a
              // much faster correction. Overshoot needs an actual outside brake
              // footprint or observed turn, not a substituted zero-duration tap.
              code = "overshoot";
              clearance = along - edge;
            }
            // A changed approach line can end beyond the circle without ever crossing
            // it. That is lateral placement only with a witnessed turn, not overshoot.
            else if (!earlierContact && turn >= policy.minimumTurnRadians) {
              code = "misaim";
              clearance = anchor.r - 1;
            }
          }
          // An isolated repeated coordinate can be a key-only replay update while
          // movement continues. Its zero speed alone does not establish a landing.
          // Retain short genuine braking/turns and sustained sampled footprints.
          const corroboratedBrake =
            near.length > 0 ||
            footprint.length >= 3 ||
            near.b.time - slow.a.time >= great ||
            turn >= policy.minimumTurnRadians;
          // Slowing relative to an earlier fast sample does not establish a
          // landing while this same tap's source continues materially inward.
          // Check the complete claimed footprint-to-tap interval. This leaves
          // genuine short outside brakes and a later separate correction intact.
          const toTap=points.slice(slow.index,Math.max(near.index+2,pi+1)).filter(placementAllowed);
          const continuesInward=toTap.length>1 && toTap[0].r-toTap[toTap.length-1].r>=policy.minimumApproachR &&
            toTap.every((point,i)=>i===0 || point.r<=toTap[i-1].r+policy.noiseR) &&
            result.contacts.some(contact=>contact.placementSupport!=="unproven" && contact.entryTimeMs>pressPoint.time);
          // A short exact coordinate repeat has no moving heading of its own.
          // Its immediately adjacent inward segments can independently show that
          // the cursor is still returning into a sampled deep contact. Do not
          // borrow the historical speed peak or relax the general three-segment
          // continuation gate; a real turn, dwell or separate action still wins.
          const duplicateContactFlow = (() => {
            const duplicate=placementSegments.find(s=>s.length===0 && s.a.time<=pressPoint.time && s.b.time>=pressPoint.time);
            if(!duplicate)return undefined;
            let left=duplicate.index,right=duplicate.index+1;
            while(left>0 && points[left-1].x===points[left].x && points[left-1].y===points[left].y)left--;
            while(right+1<points.length && points[right+1].x===points[right].x && points[right+1].y===points[right].y)right++;
            if(left<1 || right+1>=points.length || anchor.time<points[left-1].time || anchor.time>points[right].time ||
              near.index>right ||
              points[right].time-points[left].time<=0 || points[right].time-points[left].time>=great)return undefined;
            const repeat=points.slice(left,right+1);
            if(repeat.some(p=>p.x!==repeat[0].x || p.y!==repeat[0].y || p.r<=1))return undefined;
            const flow=points.slice(left-1,right+2);
            if(flow.some(p=>!placementAllowed(p) || p.input.record.id===originBracketId || !p.input.freshActionsKnown ||
              (p.input.record.freshActions.length>0 && !context.pressIds.includes(p.input.record.id))))return undefined;
            const incoming=placementSegments.find(s=>s.index===left-1),outgoing=placementSegments.find(s=>s.index===right);
            if(!incoming || !outgoing || incoming.length<=policy.noiseR || outgoing.length<=policy.noiseR ||
              incoming.a.r-incoming.b.r<=policy.noiseR || outgoing.a.r-outgoing.b.r<=policy.noiseR ||
              incoming.b.time<=incoming.a.time || outgoing.b.time<=outgoing.a.time ||
              outgoing.b.r>policy.deepSampleR)return undefined;
            const contact=result.contacts.find(c=>c.deepSampled && c.placementSupport==="sampled" &&
              c.entryTimeMs>pressPoint.time && c.entryTimeMs>=outgoing.a.time && c.entryTimeMs<=outgoing.b.time &&
              c.sampledEventIds.includes(outgoing.b.input.record.id));
            if(!contact)return undefined;
            const radialProgressR=incoming.a.r-outgoing.b.r;
            const maximumTurnRadians=Math.acos(clamp((incoming.dx*outgoing.dx+incoming.dy*outgoing.dy)/
              (incoming.length*outgoing.length),-1,1));
            if(radialProgressR<policy.minimumApproachR || maximumTurnRadians>policy.minimumTurnRadians)return undefined;
            return {basis:"sampled-duplicate-contact" as const,startTimeMs:flow[0].time,endTimeMs:flow[flow.length-1].time,
              radialProgressR,maximumTurnRadians,eventIds:flow.map(p=>p.input.record.id)};
          })();
          const departingFlow = (() => {
            const contact=[...result.contacts].reverse().find(c=>c.deepSampled && c.placementSupport==="sampled" &&
              !c.rightCensored && c.exitTimeMs<pressPoint.time);
            if(!contact || anchor.time<contact.exitTimeMs)return undefined;
            const sampled=points.filter(p=>contact.sampledEventIds.includes(p.input.record.id) && placementAllowed(p));
            if(!sampled.length)return undefined;
            const minimum=sampled.reduce((a,b)=>b.r<=a.r ? b : a),left=points.indexOf(minimum);
            const end=points.findIndex(p=>p.time>Math.max(pressPoint.time,near.b.time) && p.time<=Math.max(pressPoint.time,near.b.time)+great &&
              placementAllowed(p) && norm(p.x-near.b.x,p.y-near.b.y)>policy.noiseR);
            if(end<=pi || end<=left)return undefined;
            const flow=points.slice(left,end+1);
            if(flow.some((p,i)=>!placementAllowed(p) || p.input.record.id===originBracketId || !p.input.freshActionsKnown ||
              (p.input.record.freshActions.length>0 && !context.pressIds.includes(p.input.record.id)) ||
              (i>0 && p.r<flow[i-1].r-policy.noiseR)))return undefined;
            const motion=placementSegments.filter(s=>s.index>=left && s.index<end && s.length>policy.noiseR);
            if(motion.length<3)return undefined;
            const radialProgressR=flow[flow.length-1].r-flow[0].r;
            let maximumTurnRadians=0;
            for(let i=1;i<motion.length;i++)maximumTurnRadians=Math.max(maximumTurnRadians,
              Math.acos(clamp((motion[i-1].dx*motion[i].dx+motion[i-1].dy*motion[i].dy)/
                (motion[i-1].length*motion[i].length),-1,1)));
            if(radialProgressR<policy.minimumApproachR || maximumTurnRadians>policy.minimumTurnRadians)return undefined;
            let stationary=flow[0];
            for(const p of flow){
              if(norm(p.x-stationary.x,p.y-stationary.y)>policy.noiseR)stationary=p;
              else if(p.time-stationary.time>=great)return undefined;
            }
            // Keep a real short outside brake. Compare its immediate moving
            // neighbours, not a historical inbound peak from before the pass.
            const positiveLocal=placementSegments.filter(s=>s.index>=left && s.index<end && s.length>0);
            const beforeNear=[...positiveLocal].reverse().find(s=>s.index<near.index),
              afterNear=positiveLocal.find(s=>s.index>near.index);
            // A later tap in the same small footprint cannot forget the brake
            // at its beginning. Account for every positive outside segment in
            // that claimed footprint, including sub-noise motion.
            const outsideMotion=positiveLocal.filter(s=>s.index>=slow.index && s.a.r>1 && s.b.r>1);
            const footprintIncoming=outsideMotion.length ? [...positiveLocal].reverse().find(s=>s.index<outsideMotion[0].index) : undefined;
            for(const segment of outsideMotion){
              const previous=[...positiveLocal].reverse().find(s=>s.index<segment.index);
              if(!previous || !footprintIncoming || segment.speed/previous.speed<=policy.brakeRatio ||
                segment.speed/footprintIncoming.speed<=policy.brakeRatio)return undefined;
            }
            if(near.length===0 && (!beforeNear || !afterNear || afterNear.speed/beforeNear.speed<=policy.brakeRatio))return undefined;
            return {basis:"sampled-departure" as const,startTimeMs:flow[0].time,endTimeMs:flow[flow.length-1].time,
              radialProgressR,maximumTurnRadians,eventIds:flow.map(p=>p.input.record.id)};
          })();
          const continuingFlow = duplicateContactFlow ?? departingFlow ?? (() => {
            const contact=result.contacts.find(c=>c.placementSupport!=="unproven" && c.entryTimeMs>pressPoint.time);
            if(!contact)return undefined;
            const end=points.findIndex(p=>p.time>=contact.entryTimeMs);
            if(end<=pi)return undefined;
            const flow=points.slice(slow.index,end+1);
            if(flow.length<3 || flow.some((point,i)=>!placementAllowed(point) ||
                (point.input.record.freshActions.length>0 && !context.pressIds.includes(point.input.record.id)) ||
                (i>0 && point.r>flow[i-1].r+policy.noiseR)))return undefined;
            const radialProgressR=flow[0].r-flow[flow.length-1].r;
            if(radialProgressR<policy.minimumApproachR)return undefined;
            const motion=placementSegments.filter(s=>s.index>=slow.index && s.index<end && s.length>policy.noiseR);
            if(motion.length<3)return undefined;
            let maximumTurnRadians=0;
            for(let i=1;i<motion.length;i++)maximumTurnRadians=Math.max(maximumTurnRadians,
              Math.acos(clamp((motion[i-1].dx*motion[i].dx+motion[i-1].dy*motion[i].dy)/
                (motion[i-1].length*motion[i].length),-1,1)));
            if(maximumTurnRadians>policy.minimumTurnRadians)return undefined;
            // A real outside dwell separates a landing from its later correction.
            // Tiny key-only coordinate repeats do not establish such a dwell.
            let stationary=flow[0];
            for(const point of flow){
              if(norm(point.x-stationary.x,point.y-stationary.y)>policy.noiseR)stationary=point;
              else if(point.time-stationary.time>=great)return undefined;
            }
            return {startTimeMs:flow[0].time,endTimeMs:flow[flow.length-1].time,radialProgressR,
              maximumTurnRadians,eventIds:flow.map(point=>point.input.record.id)};
          })();
          if(continuingFlow)result.continuingFlow=continuingFlow;
          if (code && corroboratedBrake && !continuesInward && !continuingFlow && clearance > policy.noiseR && placementAllowed(anchor)) {
            code = refineDirectionalPlacement(code, transverse,
              result.contacts.some(c => c.entryTimeMs < anchor.time &&
                c.placementSupport !== "unproven" && isPrimaryCursorPass(c)));
            result.landing = {
              provenance: "sampled",
              timeMs: anchor.time,
              offsetMs: anchor.time - beat,
              radialR: anchor.r,
              alongR: along,
              transverseR: transverse,
              footprintStartTimeMs: start,
              footprintDurationMs: Math.max(0, pressPoint.time - start),
              brakeRatio: near.speed / peak.speed,
              turnRadians: turn,
              eventIds: ids([
                ...incomingRun.map(p => p.input.record.id),
                ...footprint.map((p) => p.input.record.id),
              ]),
            };
            result.spatialCandidates = [
              {
                code,
                label: code === "misaim" ? "Misaim" : code === "undershoot" ? "Undershoot" : "Overshoot",
                radialR: anchor.r,
                clearanceR: clearance,
                eventIds: [...result.landing.eventIds],
              },
            ];
            result.placement = "misplaced";
            result.timingIndependent = result.landing.footprintDurationMs >= great && start <= beat - great;
            for (const contact of result.contacts)
              if (contact.entryTimeMs > anchor.time) contact.relation = "later-correction";
          }
        }
      }
      // A completed flow arc which stays outside is positive lateral placement too;
      // requiring a halt here would erase ordinary moving aim errors. Both approach
      // and departure must be present in the same uninterrupted, live episode.
      if (
        !result.landing &&
        placementClosest &&
        placementSampledClosest &&
        placementClosest.radialR > 1 &&
        Math.abs(placementClosest.timeMs - pressPoint.time) <= 2 * great
      ) {
        const closest = placementClosest;
        const approach = placementSegments
          .filter((s) => s.b.time <= closest.timeMs && s.a.r > s.b.r && s.length > policy.noiseR)
          .reduce<Segment | undefined>((best, s) => (!best || s.speed > best.speed ? s : best), undefined);
        const departed = placementPoints.find(
          (point) => point.time > closest.timeMs && point.r - closest.radialR >= policy.bypassDepartureR,
        );
        const incomingRun = approach ? inwardRun(approach) : [];
        if (approach && departed && incomingRun[0].r - closest.radialR >= policy.minimumApproachR) {
          const ux = approach.dx / approach.length,
            uy = approach.dy / approach.length;
          const turnSegment = placementSegments.find((s) => s.a.time >= closest.timeMs && s.length > policy.noiseR);
          const turn = turnSegment
            ? Math.acos(clamp((turnSegment.dx * ux + turnSegment.dy * uy) / turnSegment.length, -1, 1))
            : 0;
          const p = placementSampledClosest,
            along = p.x * ux + p.y * uy,
            transverse = Math.abs(p.x * uy - p.y * ux);
          if (transverse > 1 || turn >= policy.minimumTurnRadians) {
            const eventIds = ids([
              ...closest.eventIds,
              ...incomingRun.map(p => p.input.record.id),
              departed.input.record.id,
            ]);
            result.landing = {
              provenance: closest.provenance,
              timeMs: closest.timeMs,
              offsetMs: closest.offsetMs,
              radialR: closest.radialR,
              alongR: along,
              transverseR: transverse,
              footprintStartTimeMs: closest.timeMs,
              footprintDurationMs: 0,
              brakeRatio: turnSegment ? turnSegment.speed / approach.speed : 1,
              turnRadians: turn,
              eventIds,
            };
            result.spatialCandidates = [
              { code: "misaim", label: "Misaim", radialR: closest.radialR, clearanceR: closest.radialR - 1, eventIds },
            ];
            result.placement = "misplaced";
          }
        }
      }
      let broadOutsideLobe:{landing:PrimaryLanding;candidate:PrimarySpatialCandidate;belowExtentMargin:boolean}[]|undefined;
      // A press belongs to an observed approach/retreat lobe even if its turn is
      // farther away than the short brake horizon. Require a completed outside
      // lobe and retain its whole source chain; an unrelated next action cannot
      // supply the departure. No contact is converted into a placement failure.
      if (!result.landing && placementAllowed(pressPoint)) {
        const lobes: Array<{landing:PrimaryLanding;candidate:PrimarySpatialCandidate;broadOnly:boolean;belowExtentMargin:boolean}> = [];
        const bounds: Array<{left:number;right:number}> = [];
        let phase: "seeking" | "inbound" | "outbound" = "seeking";
        let start=-1, minimumIndex=-1, peak=-1, peakFirst=-1, peakLast=-1, previous=-1;
        // A contiguous crest band has a total radial range <= noiseR. A
        // monotone minimum queue keeps this scan linear and source-bounded.
        const crestMinima: number[] = [];
        let crestHead = 0;
        const beginCrest = (k:number) => {
          peak=peakFirst=peakLast=k;crestMinima.length=0;crestMinima.push(k);crestHead=0;
        };
        const extendCrest = (k:number) => {
          if(points[k].r>points[peak].r)peak=k;
          while(crestMinima.length>crestHead && points[crestMinima[crestMinima.length-1]].r>=points[k].r)crestMinima.pop();
          crestMinima.push(k);
          while(crestHead<crestMinima.length && points[peak].r-points[crestMinima[crestHead]].r>policy.noiseR)
            peakFirst=crestMinima[crestHead++]+1;
          peakLast=k;
        };
        const emit = (right:number) => {
          if(start>=0 && start<=pi && pi<=right)bounds.push({left:start,right});
        };
        const reset = () => {phase="seeking";start=minimumIndex=peak=peakFirst=peakLast=previous=-1;crestMinima.length=0;crestHead=0;};
        // Confirm turns against running extrema. Tiny adjacent radial steps may
        // accumulate into a real turn; they must not merge unrelated basins.
        // Only the containing basin (or both at a shared crest) is retained.
        for(let k=0;k<points.length;k++) {
          if(!placementAllowed(points[k])) {
            if(phase==="outbound")emit(previous);
            reset();continue;
          }
          previous=k;
          if(start<0){start=minimumIndex=k;beginCrest(k);continue;}
          if(phase==="seeking") {
            if(points[peak].r-points[k].r>policy.noiseR){phase="inbound";minimumIndex=k;}
            else {extendCrest(k);start=peakFirst;}
          } else if(phase==="inbound") {
            if(points[k].r<points[minimumIndex].r)minimumIndex=k;
            else if(points[k].r-points[minimumIndex].r>policy.noiseR){phase="outbound";beginCrest(k);}
          } else {
            if(points[peak].r-points[k].r>policy.noiseR){
              emit(peakLast);start=peakFirst;minimumIndex=k;phase="inbound";
            } else extendCrest(k);
          }
        }
        if(phase==="outbound")emit(previous);
        for(const {left,right} of bounds) {
          const lobe=points.slice(left,right+1), localSegments=placementSegments.filter(s=>s.index>=left && s.index<right);
          const minimum=lobe.reduce((best,p)=>p.r<best.r ? p : best);
          if(lobe.some(p=>!p.input.freshActionsKnown ||
              (p.input.record.freshActions.length && p.input.record.id!==originBracketId && !context.pressIds.includes(p.input.record.id))) ||
            result.contacts.some(c=>c.entryTimeMs<=points[right].time && c.exitTimeMs>=points[left].time))continue;
          let closest={timeMs:minimum.time,radialR:minimum.r,provenance:"sampled" as "sampled"|"reconstructed"};
          for(const segment of localSegments) {
            const fraction=segment.length ? clamp(-(segment.a.x*segment.dx+segment.a.y*segment.dy)/(segment.length*segment.length),0,1) : 0;
            const radialR=norm(segment.a.x+fraction*segment.dx,segment.a.y+fraction*segment.dy);
            if(radialR<closest.radialR)closest={timeMs:segment.a.time+fraction*(segment.b.time-segment.a.time),radialR,
              provenance:fraction>0 && fraction<1 ? "reconstructed" : "sampled"};
          }
          const sampled=lobe.reduce((best,p)=>p.r<best.r ? p : best);
          const materialDeparture=lobe.find(p=>p.time>sampled.time && p.r-closest.radialR>=policy.bypassDepartureR),
            observedDeparture=lobe.find(p=>p.time>sampled.time && p.r-closest.radialR>policy.noiseR),
            belowExtentMargin=!materialDeparture || points[left].r-closest.radialR<policy.minimumApproachR,
            departure=materialDeparture??observedDeparture;
          const incoming=localSegments.filter(s=>s.b.time<=sampled.time && s.a.r>s.b.r && s.length>policy.noiseR)
            .reduce<Segment|undefined>((best,s)=>!best || s.speed>best.speed ? s : best,undefined);
          if(!departure || !incoming || closest.radialR<=1 ||
            points[left].r-closest.radialR<=policy.noiseR)continue;
          const ux=incoming.dx/incoming.length,uy=incoming.dy/incoming.length,
            along=sampled.x*ux+sampled.y*uy,transverse=Math.abs(sampled.x*uy-sampled.y*ux),
            dx=departure.x-sampled.x,dy=departure.y-sampled.y,length=norm(dx,dy),
            turn=length ? Math.acos(clamp((dx*ux+dy*uy)/length,-1,1)) : 0;
          const edge=Math.sqrt(Math.max(0,1-transverse*transverse)),
            nearSide=transverse<=1 && along<-edge-policy.noiseR && dx*ux+dy*uy<-policy.noiseR;
          // Exact sampled/chord non-contact can support broad aim evidence
          // without enough clearance to name a direction. Causal admission
          // for this narrow lobe is deferred to a usable aim correction.
          const broadOnly=belowExtentMargin||!nearSide&&closest.radialR<=1+policy.noiseR;
          const eventIds=lobe.map(p=>p.input.record.id);
          const code = refineDirectionalPlacement(!belowExtentMargin&&nearSide ? "undershoot" : "misaim",transverse,false);
          lobes.push({landing:{provenance:closest.provenance,timeMs:closest.timeMs,offsetMs:closest.timeMs-beat,
            radialR:closest.radialR,alongR:along,transverseR:transverse,footprintStartTimeMs:sampled.time,
            footprintDurationMs:0,brakeRatio:1,turnRadians:turn,eventIds},
            candidate:{code,label:code === "undershoot" ? "Undershoot" : "Misaim",
              radialR:closest.radialR,clearanceR:closest.radialR-1,eventIds},broadOnly,belowExtentMargin});
        }
        // A tap within a bounded crest can border two different episodes.
        // Preserve both witnesses, but do not choose a morphology by enumeration.
        if(lobes.length)result.lobeAlternatives=lobes.map(l=>l.landing);
        // A short or near-rim broad witness cannot contradict a completed
        // material descriptor. Compare genuine material alternatives first;
        // retain every measured lobe in diagnostics even when it is less specific.
        const material=lobes.filter(l=>!l.broadOnly),comparable=material.length?material:lobes;
        if(comparable.length && comparable.every(l=>l.candidate.code===comparable[0].candidate.code)) {
          if(material.length){
            result.landing=material[0].landing;
            result.spatialCandidates=material.map(l=>l.candidate);
            result.placement="misplaced";
          }else broadOutsideLobe=lobes;
        } else if(lobes.length)result.limitations.push("competing-local-placement-lobes");
      }
      // Flow need not stop at a circle. A coherent, entirely outside corridor
      // that has already crossed the target-normal plane proves lateral placement.
      // Keep the origin's progress role separate from this episode's own direction.
      if (!result.landing && !result.contacts.length && peak && placementClosest &&
          placementAllowed(pressPoint) && !result.limitations.includes("ordered-zero-time-position-change") &&
          Math.abs(placementClosest.timeMs-pressPoint.time) <= 2*great) {
        const corridor=placementPoints.filter(point=>point.input.record.id!==originBracketId);
        const moving=placementSegments.filter(segment=>segment.length>policy.noiseR);
        const ux=peak.dx/peak.length,uy=peak.dy/peak.length;
        const start=corridor[0],end=corridor[corridor.length-1];
        const transverse=corridor.map(point=>point.x*uy-point.y*ux);
        const startAlong=start ? start.x*ux+start.y*uy : 0;
        const endAlong=end ? end.x*ux+end.y*uy : 0;
        const minimumTransverse=Math.min(...transverse.map(Math.abs));
        // Noise is a total excursion budget, not permission to discard many
        // individually tiny samples of a different ongoing approach.
        const offAxisTravel=placementSegments.reduce((total,segment)=>total+
          (segment.length>0 && (segment.dx*ux+segment.dy*uy)/segment.length<Math.cos(policy.minimumTurnRadians)
            ? segment.length : 0),0);
        if (moving.length>=3 && start && end &&
            offAxisTravel<=policy.noiseR &&
            moving.every(segment=>(segment.dx*ux+segment.dy*uy)/segment.length>=Math.cos(policy.minimumTurnRadians)) &&
            transverse.every(value=>Math.abs(value)>1+policy.noiseR && Math.sign(value)===Math.sign(transverse[0])) &&
            startAlong < -policy.noiseR && endAlong >= policy.bypassDepartureR &&
            inwardRun(peak)[0].r-placementClosest.radialR>=policy.minimumApproachR &&
            !corridor.some(point=>point.input.record.freshActions.length && !context.pressIds.includes(point.input.record.id))) {
          const progressEventIds=inwardRun(peak).map(point=>point.input.record.id);
          const eventIds=[...new Set([...progressEventIds,...corridor.map(point=>point.input.record.id)])];
          result.lateralTraversal={axis:{x:ux,y:uy},startAlongR:startAlong,endAlongR:endAlong,
            minimumTransverseR:minimumTransverse,progressEventIds,eventIds};
          result.landing={provenance:placementClosest.provenance,timeMs:placementClosest.timeMs,
            offsetMs:placementClosest.offsetMs,radialR:placementClosest.radialR,alongR:null,
            transverseR:null,footprintStartTimeMs:placementClosest.timeMs,
            footprintDurationMs:0,brakeRatio:1,turnRadians:0,eventIds};
          result.spatialCandidates=[{code:"misaim",label:"Misaim",radialR:placementClosest.radialR,
            clearanceR:minimumTransverse-1,eventIds}];
          result.placement="misplaced";
        }
      }
      // Positive stationary placement is not a missing-morphology fallback. Require
      // A turning stream can bound a coherent outside crossing without first
      // approaching radially or stopping. Its first material direction supplies
      // the axis; later turns are fences, never alternative convenient axes.
      if (!result.landing && !result.contacts.length && placementAllowed(pressPoint) && press.inLiveSuccess &&
          !result.limitations.includes("ordered-zero-time-position-change") &&
          Object.values(evidence.dependencies).every(d=>d.status==="complete")) {
        const byIndex=new Map(placementSegments.map(s=>[s.index,s])),cosine=Math.cos(policy.minimumTurnRadians);
        let checks=0;
        for(const seed of placementSegments) {
          if(seed.length<=policy.noiseR || seed.b.time>pressPoint.time)continue;
          const ux=seed.dx/seed.length,uy=seed.dy/seed.length;
          const admissible=(k:number)=>{
            if(++checks>policy.maximumTraversalChecks)return false;
            const p=points[k];return !!p && placementAllowed(p) && p.input.record.id!==originBracketId && !contexts.has(p.input.record.id);
          };
          const aligned=(s:Segment|undefined)=>!!s && (s.length<=policy.noiseR || (s.dx*ux+s.dy*uy)/s.length>=cosine);
          let left=seed.index,right=seed.index+1;
          while(left>0 && admissible(left-1) && aligned(byIndex.get(left-1)))left--;
          while(right+1<points.length && admissible(right+1) && aligned(byIndex.get(right)))right++;
          if(checks>policy.maximumTraversalChecks){result.limitations.push("source-local-traversal-check-limit");break;}
          if(!(left<pi && pi<right))continue;
          const localSegments=placementSegments.filter(s=>s.index>=left&&s.index<right),material=localSegments.filter(s=>s.length>policy.noiseR);
          if(material[0]!==seed || material.length<3 || !material.some(s=>s.b.time<=pressPoint.time) ||
            !material.some(s=>s.a.time>=pressPoint.time))continue;
          const run=points.slice(left,right+1),rawOffsets=run.flatMap(p=>p.input.record.source.origin==="parsed"&&p.input.record.source.rawTokenIndex!==undefined
            ?[p.input.record.source.rawTokenIndex-p.input.record.source.parsedFrameIndex]:[]);
          const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
          if(new Set(rawOffsets).size>1 || run.some((p,k)=>{
            const q=p.input.record,prior=evidence.inputs[first+left+k-1]?.record;
            return !p.input.freshActionsKnown || !admissible(left+k) || q.source.origin!=="parsed" ||
              q.source.discontinuityBefore?.length || !Number.isSafeInteger(q.source.parsedFrameIndex) || q.source.parsedFrameIndex<0 ||
              (q.source.rawTokenIndex!==undefined&&(!Number.isSafeInteger(q.source.rawTokenIndex)||q.source.rawTokenIndex<0)) ||
              q.actions.some(a=>a!==0&&a!==1) || new Set(q.actions).size!==q.actions.length ||
              q.previousActions.some(a=>a!==0&&a!==1) || new Set(q.previousActions).size!==q.previousActions.length ||
              !same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a))) ||
              (prior&&!same(q.previousActions,prior.actions)) || (q.freshActions.length>0&&q.id!==press.record.id) ||
              (q.rawButtonMask!==undefined&&(!Number.isSafeInteger(q.rawButtonMask)||q.rawButtonMask<0||
                !same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))) ||
              (k>0&&!continuous(run[k-1].input,p.input,geometry.radius));
          }))continue;
          const along=(p:Point)=>p.x*ux+p.y*uy,normal=(p:Point)=>p.x*uy-p.y*ux,
            normals=run.map(normal),startAlong=along(run[0]),endAlong=along(run[run.length-1]),
            offAxis=localSegments.reduce((n,s)=>n+(s.length>0&&(s.dx*ux+s.dy*uy)/s.length<cosine?s.length:0),0);
          if(offAxis>policy.noiseR || !(startAlong < -policy.noiseR && endAlong >= policy.bypassDepartureR) ||
            normals.some(n=>Math.abs(n)<=1+policy.noiseR || Math.sign(n)!==Math.sign(normals[0])))continue;
          const crossing=localSegments.find(s=>along(s.a)<=0&&along(s.b)>0);
          if(!crossing)continue;
          let minimum=Infinity;
          for(const s of localSegments){const u=s.length?clamp(-(s.a.x*s.dx+s.a.y*s.dy)/(s.length*s.length),0,1):0;
            minimum=Math.min(minimum,norm(s.a.x+u*s.dx,s.a.y+u*s.dy));}
          const eventIds=run.map(p=>p.input.record.id),minimumNormal=Math.min(...normals.map(Math.abs)),
            fraction=-along(crossing.a)/(along(crossing.b)-along(crossing.a));
          result.lateralTraversal={basis:"source-local-outside-traversal",axis:{x:ux,y:uy},startAlongR:startAlong,endAlongR:endAlong,
            minimumTransverseR:minimumNormal,minimumRadialR:minimum,planeTimeMs:crossing.a.time+fraction*(crossing.b.time-crossing.a.time),
            seedEventIds:[seed.a.input.record.id,seed.b.input.record.id],progressEventIds:[...eventIds],eventIds};
          result.spatialCandidates=[{code:"wide-aim",label:"Wide aim",radialR:minimum,clearanceR:minimumNormal-1,eventIds}];
          result.placement="misplaced";result.timingIndependent=false;
          break;
        }
      }
      // Positive stationary placement is not a missing-morphology fallback. Require
      // independent recorded samples on both sides of this tap, a bounded footprint,
      // and a meaningful observed duration. A single off-target coordinate is insufficient.
      if (!result.landing && !result.spatialCandidates.length && pressPoint.r > 1 && placementAllowed(pressPoint)) {
        let left = pi,
          right = pi;
        const inFootprint = (point: Point) =>
          placementAllowed(point) &&
          point.input.record.id !== originBracketId &&
          point.r > 1 &&
          norm(point.x - pressPoint.x, point.y - pressPoint.y) <= policy.noiseR;
        while (left > 0 && inFootprint(points[left - 1])) left--;
        while (right + 1 < points.length && inFootprint(points[right + 1])) right++;
        if (
          (left < pi || (right-pi >= 2 && new Set(points.slice(pi,right+1).map(p=>p.time)).size >= 3)) &&
          right > pi &&
          points[left].time <= pressPoint.time &&
          points[right].time > pressPoint.time &&
          points[right].time - points[left].time >= great
        ) {
          const eventIds = points.slice(left, right + 1).map((point) => point.input.record.id);
          result.landing = {
            provenance: "sampled",
            timeMs: pressPoint.time,
            offsetMs: pressPoint.time - beat,
            radialR: pressPoint.r,
            alongR: null,
            transverseR: null,
            footprintStartTimeMs: points[left].time,
            footprintDurationMs: pressPoint.time - points[left].time,
            brakeRatio: 0,
            turnRadians: 0,
            eventIds,
          };
          result.spatialCandidates = [
            { code: "misaim", label: "Misaim", radialR: pressPoint.r, clearanceR: pressPoint.r - 1, eventIds },
          ];
          result.placement = "misplaced";
          result.timingIndependent = pressPoint.time - points[left].time >= great && points[left].time <= beat - great;
        }
      }
      // A small drifting dwell is positive placement evidence even without a
      // direction-specific landing. Contacts remain timing evidence; never let
      // an outside fragment replace a recorded usable passage.
      if (!result.landing && !result.spatialCandidates.length && !result.contacts.length &&
          press.inLiveSuccess && press.freshActionsKnown && press.record.freshActions.length>0 && placementAllowed(pressPoint) &&
          Object.values(evidence.dependencies).every(d=>d.status==="complete") &&
          !result.limitations.includes("ordered-zero-time-position-change")) {
        const same=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every(v=>b.includes(v));
        const inDwell=(point:Point)=>placementAllowed(point) && point.input.record.id!==originBracketId &&
          !contexts.has(point.input.record.id) && point.r>1+policy.noiseR &&
          norm(point.x-pressPoint.x,point.y-pressPoint.y)<=policy.footprintR;
        let left=pi,right=pi;
        while(left>0&&inDwell(points[left-1]))left--;
        while(right+1<points.length&&inDwell(points[right+1]))right++;
        const run=points.slice(left,right+1),rawOffsets=run.flatMap(p=>p.input.record.source.origin==="parsed"&&p.input.record.source.rawTokenIndex!==undefined
          ?[p.input.record.source.rawTokenIndex-p.input.record.source.parsedFrameIndex]:[]);
        const sourceValid=run.every((p,k)=>{
          const q=p.input.record,prior=evidence.inputs[first+left+k-1]?.record,previousSource=run[k-1]?.input.record.source;
          return inDwell(p) && p.input.freshActionsKnown && q.source.origin==="parsed" &&
            !q.source.discontinuityBefore?.length && Number.isSafeInteger(q.source.parsedFrameIndex) && q.source.parsedFrameIndex>=0 &&
            (q.source.rawTokenIndex===undefined||(Number.isSafeInteger(q.source.rawTokenIndex)&&q.source.rawTokenIndex>=0)) &&
            q.actions.every(a=>a===0||a===1) && new Set(q.actions).size===q.actions.length &&
            q.previousActions.every(a=>a===0||a===1) && new Set(q.previousActions).size===q.previousActions.length &&
            same(q.freshActions,q.actions.filter(a=>!q.previousActions.includes(a))) &&
            (!prior||same(q.previousActions,prior.actions)) && (!q.freshActions.length||q.id===press.record.id) &&
            (q.rawButtonMask===undefined||(Number.isSafeInteger(q.rawButtonMask)&&q.rawButtonMask>=0&&
              same(q.actions,[...(q.rawButtonMask&5?[0]:[]),...(q.rawButtonMask&10?[1]:[])]))) &&
            (k===0||(continuous(run[k-1].input,p.input,geometry.radius)&&
              (previousSource?.origin!=="parsed"||
                (previousSource.rawTokenIndex===undefined&&q.source.rawTokenIndex===undefined)||
                (previousSource.rawTokenIndex!==undefined&&q.source.rawTokenIndex!==undefined&&
                  q.source.rawTokenIndex===previousSource.rawTokenIndex+1))));
        });
        const outsideChords=run.every((p,k)=>{
          if(!k)return true;
          const a=run[k-1],dx=p.x-a.x,dy=p.y-a.y,length2=dx*dx+dy*dy;
          const u=length2?clamp(-(a.x*dx+a.y*dy)/length2,0,1):0;
          return norm(a.x+u*dx,a.y+u*dy)>1+policy.noiseR;
        });
        if(left<pi&&right>pi&&points[left].time<pressPoint.time&&points[right].time>pressPoint.time&&
            points[right].time-points[left].time>=great&&sourceValid&&new Set(rawOffsets).size<=1&&outsideChords){
          const eventIds=run.map(p=>p.input.record.id);
          result.boundedOutsideDwell={eventIds};
          result.landing={provenance:"sampled",timeMs:pressPoint.time,offsetMs:pressPoint.time-beat,radialR:pressPoint.r,
            alongR:null,transverseR:null,footprintStartTimeMs:points[left].time,
            footprintDurationMs:pressPoint.time-points[left].time,brakeRatio:0,turnRadians:0,eventIds};
          result.spatialCandidates=[{code:"misaim",label:"Misaim",radialR:pressPoint.r,clearanceR:pressPoint.r-1,eventIds}];
          result.placement="misplaced";
          result.timingIndependent=pressPoint.time-points[left].time>=great&&points[left].time<=beat-great;
        }
      }
      // Keep rim contacts as geometry, but they do not establish a coaching pass.
      // This never changes whether the evaluator accepts an off-centre hit.
      const proper = result.contacts.filter(
        (contact) => isPrimaryCursorPass(contact) && contact.placementSupport !== "unproven" && contact.relation === "same-approach",
      );
      if (result.placement !== "misplaced" && proper.length) {
        const nearest = proper.reduce((best, contact) =>
          Math.abs(contact.closestTimeMs - pressPoint.time) < Math.abs(best.closestTimeMs - pressPoint.time)
            ? contact
            : best,
        );
        result.properPass = nearest;
        result.placement = "proper-pass";
        result.timingIndependent = true;
        const before = proper.some((contact) => contact.exitTimeMs < pressPoint.time),
          after = proper.some((contact) => contact.entryTimeMs > pressPoint.time);
        result.relation = proper.some(
          (contact) => contact.entryTimeMs <= pressPoint.time && contact.exitTimeMs >= pressPoint.time,
        )
          ? "inside-pass"
          : before && after
          ? "between-passes"
          : before
          ? "after-pass"
          : "before-pass";
      }
      // The broad, sub-noise lobe must not prevent a later directional witness
      // or an actual usable passage from being examined. Keep its measured
      // alternatives, and use it only if those stronger descriptions are absent.
      if(broadOutsideLobe&&!result.properPass&&!result.landing&&!result.spatialCandidates.length){
        result.landing=broadOutsideLobe[0].landing;
        result.spatialCandidates=broadOutsideLobe.map(l=>l.candidate);
        result.placement="misplaced";
        result.boundedOutsideLobe={eventIds:[...new Set(broadOutsideLobe.flatMap(l=>l.candidate.eventIds))]};
        result.limitations.push(broadOutsideLobe.some(l=>l.belowExtentMargin)?"movement-extent-below-subtype-margin":"directional-subtype-below-noise");
      }
      if (peak && placementAllowed(pressPoint))
        result.farEdgeReturn = measureFarEdgeReturn(peak, placementPoints, pressPoint, result.contacts, beat, originBracketId);
      if (!result.properPass && !result.landing) result.limitations.push("no-positive-local-placement");
      if (points.length < 3) result.limitations.push("short-local-trajectory");
      const arrival = derivePrimaryDeadlineArrival(evidence, context, result, policy);
      if (arrival) {
        result.deadlineArrival = arrival;
        result.eventIds = ids([...result.eventIds, ...arrival.eventIds]);
      }
      return result;
    });
  return { policyVersion: policy.version, episodes, limitations };
}
