import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { ReplayTrace, ReplayTraceRecord, TraceRunIdentity } from "../trace/ReplayTrace";
import { errorCapabilities } from "./ErrorCapabilities";

export type ErrorComponent =
  | "circle"
  | "slider-head"
  | "slider-tick"
  | "slider-repeat"
  | "slider-legacy-tail"
  | "slider-end"
  | "slider-parent"
  | "spinner";
export interface ErrorAtom {
  id: string;
  identity: TraceRunIdentity;
  componentId: string;
  parentId: string;
  component: ErrorComponent;
  eventId: string;
  scoringOrder: number;
  objectTimeMs: number;
  resolutionTimeMs: number;
  result: string;
  role: "primary" | "consequence";
  accuracyLoss: boolean;
  comboPenalty: boolean;
  comboBroken: boolean;
  relatedAtomIds: string[];
  pendingContributionIds: string[];
}
export interface ErrorInventory {
  schemaVersion: 2;
  atoms: ErrorAtom[];
  counts: {
    primary: number;
    consequences: number;
    misses: number;
    timingLosses: number;
    sliderLosses: number;
    spinnerLosses: number;
    comboBreaks: number;
  };
  limitations: string[];
}
export function countErrorAtoms(atoms: readonly ErrorAtom[]): ErrorInventory["counts"] {
  const counts = {
    primary: 0,
    consequences: 0,
    misses: 0,
    timingLosses: 0,
    sliderLosses: 0,
    spinnerLosses: 0,
    comboBreaks: 0,
  };
  for (const a of atoms) {
    if (a.comboBroken) counts.comboBreaks++;
    if (a.role === "consequence") {
      counts.consequences++;
      continue;
    }
    counts.primary++;
    if (a.result === "MISS") counts.misses++;
    if ((a.component === "circle" || a.component === "slider-head") && (a.result === "OK" || a.result === "MEH"))
      counts.timingLosses++;
    if (a.component.startsWith("slider-")) counts.sliderLosses++;
    if (a.component === "spinner") counts.spinnerLosses++;
  }
  return counts;
}
/** Walk actual evaluator resolution order, not timestamp-sorted display events. */
export function inventoryErrors(trace: ReplayTrace, map: Beatmap): ErrorInventory {
  const result: ErrorInventory = {
    schemaVersion: 2,
    atoms: [],
    counts: {
      primary: 0,
      consequences: 0,
      misses: 0,
      timingLosses: 0,
      sliderLosses: 0,
      spinnerLosses: 0,
      comboBreaks: 0,
    },
    limitations: [],
  };
  if (trace.identity.schemaVersion !== 2) {
    result.limitations.push("requires-component-trace-v2");
    return result;
  }
  const profile = trace.identity.analysisProfileId,
    stable = profile === "stable",
    caps = errorCapabilities(map, profile);
  if (caps.scoring !== "supported") {
    result.limitations.push(...caps.reasons);
    return result;
  }
  const perParent = new Map<string, ErrorAtom[]>();
  const pendingParents: Array<{ atom: ErrorAtom; record: Extract<ReplayTraceRecord, { kind: "slider-parent" }> }> = [];
  let combo = 0,
    order = 0;
  for (const record of trace.records) {
    if (!["resolution", "slider-checkpoint", "slider-parent", "spinner-resolution"].includes(record.kind)) continue;
    order++;
    let component: ErrorComponent, componentId: string, parentId: string, objectTimeMs: number, grade: string;
    let loss = false,
      accuracy = true,
      resets = true,
      increments = true,
      consequence = false;
    if (record.kind === "resolution") {
      const object = map.getHitObject(record.componentId);
      if (!(object instanceof HitCircle)) {
        result.limitations.push(`missing-circle:${record.componentId}`);
        continue;
      }
      component = record.component;
      componentId = record.componentId;
      parentId = object.sliderId ?? object.id;
      objectTimeMs = object.hitTime;
      grade = record.result;
      accuracy = component === "circle" || !stable;
      loss =
        grade === "MISS" ||
        (grade !== "GREAT" &&
          (component === "circle" || (!stable && caps.classicHeadAccuracy) || (stable && caps.scoreV2)));
    } else if (record.kind === "slider-checkpoint") {
      component = record.component;
      componentId = record.componentId;
      parentId = record.parentId;
      objectTimeMs = record.objectTimeMs;
      grade = record.hit ? "HIT" : "MISS";
      loss = !record.hit;
      accuracy = !stable;
      resets = component !== "slider-legacy-tail" && component !== "slider-end";
      increments = component !== "slider-end" || caps.classicHeadAccuracy;
    } else if (record.kind === "slider-parent") {
      if (!record.scoring) continue;
      component = "slider-parent";
      componentId = record.componentId;
      parentId = componentId;
      objectTimeMs = record.objectTimeMs;
      grade = record.result;
      loss = grade !== "GREAT";
      resets = !stable;
      increments = !stable;
      consequence = true;
    } else if (record.kind === "spinner-resolution") {
      component = "spinner";
      componentId = record.componentId;
      parentId = componentId;
      objectTimeMs = record.objectTimeMs;
      grade = record.result;
      loss = grade !== "GREAT";
    } else continue;
    const comboBefore = combo;
    if (grade === "MISS") {
      if (resets) combo = 0;
    } else if (increments) combo++;
    if (!loss) continue;
    if (result.atoms.length >= 10000) {
      result.limitations.push("error-atom-limit:10000");
      break;
    }
    // Content/profile/run identity plus actual component and resolution identity, never a display ordinal.
    const id = JSON.stringify([
      trace.identity.replayContentSha256 ?? trace.identity.generationKey,
      trace.identity.beatmapContentSha256 ?? trace.identity.beatmapMd5,
      trace.identity.analysisProfileFingerprint,
      component,
      componentId,
      record.id,
    ]);
    const atom: ErrorAtom = {
      id,
      identity: trace.identity,
      componentId,
      parentId,
      component,
      eventId: record.id,
      scoringOrder: order,
      objectTimeMs,
      resolutionTimeMs: record.timeMs,
      result: grade,
      role: consequence ? "consequence" : "primary",
      accuracyLoss: accuracy,
      comboPenalty: grade === "MISS" && resets,
      comboBroken: grade === "MISS" && resets && comboBefore > 0,
      relatedAtomIds: [],
      pendingContributionIds: record.kind === "slider-parent" ? [...record.pendingIds] : [],
    };
    result.atoms.push(atom);
    const relatives = perParent.get(parentId) ?? [];
    relatives.push(atom);
    perParent.set(parentId, relatives);
    if (record.kind === "slider-parent") pendingParents.push({ atom, record });
  }
  for (const { atom, record } of pendingParents) {
    atom.relatedAtomIds = (perParent.get(atom.parentId) ?? [])
      .filter(
        (a) =>
          a.role === "primary" &&
          (a.componentId === record.headId || record.checkpointIds.includes(a.componentId)) &&
          (a.scoringOrder < atom.scoringOrder || (a.componentId === record.headId && record.headResult === undefined)),
      )
      .map((a) => a.id);
    // Short Stable sliders can finish while the head remains unresolved. This
    // links the same missing contribution; it does not make a later input the
    // cause of the already-resolved parent grade.
    if (record.headResult === undefined) atom.pendingContributionIds.unshift(record.headId);
  }
  result.counts = countErrorAtoms(result.atoms);
  result.limitations.push(...trace.failures);
  return result;
}
