import { hitWindowsForOD } from "@osujs/math";
import { Beatmap } from "../../beatmap/Beatmap";
import { HitCircle } from "../../hitobjects/HitCircle";
import { Slider } from "../../hitobjects/Slider";
import {
  CircleEvidence,
  deriveCircleEvidence,
  deriveRecordedRejections,
  InputRecord,
} from "../miss-explanation/CircleEvidence";
import { stableGameplayRadius, stableWithinHitRadius, nativeWithinHitRadius } from "../StableHitGeometry";
import { stableHitWindowsForOD } from "../StableDifficulty";
import { ReplayTrace, ReplayTraceRecord } from "../trace/ReplayTrace";
import { classifyCircleLoss, CircleMechanism } from "./CircleMechanisms";
import { comparePrimaryApproaches } from "./PrimaryApproachComparison";
import type { CanonicalControl } from "./CanonicalReplayVerifier";
import { PrimaryCandidate } from "./PrimaryDiagnosisPolicy";
import { errorCapabilities } from "./ErrorCapabilities";
import { latestOtherReceiptBoundary } from "./PrimaryReceiptBoundary";

type Resolution = Extract<ReplayTraceRecord, { kind: "resolution" }>;
type Attempt = Extract<ReplayTraceRecord, { kind: "attempt" }>;
type Kind = "normal" | "early-miss" | "late-receipt" | "blocked" | "hit-nothing";
interface Note {
  id: string;
  parentId: string;
  time: number;
  index: number;
  resolution?: Resolution;
  receiptId?: string;
}
interface Opportunity {
  kind: "taken" | "blocked";
  inputId: string;
  receiverId?: string;
  receiverResult?: string;
  blockerId?: string;
  eventIds: string[];
}
export interface RecordedInputChain {
  policy: "recorded-input-chain-v1";
  chained: true;
  start: { componentId: string; inputId: string; timeMs: number; kind: Kind };
  opportunities: Opportunity[];
  pressIds: string[];
  durationMs: number;
  stop: string;
  disposition: "inherited" | "protected";
  cause: { codes: string[]; headline: string; observationOnly: boolean; reason: string; eventIds: string[] };
  certification: { status: "certified" | "observation"; reason: string; control?: CanonicalControl };
}
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v) => b.includes(v));
const unique = <T>(values: T[]) => [...new Set(values)];
const protectedLabels = new Set(["Notelock", "No tap", "Slow taps", "Extra tap", "Out of order"]);
type RootCause = { mechanism: CircleMechanism; selected: PrimaryCandidate[]; reason: string };

/** Recorded receipt ancestry, independent of rhythm ownership. This session index
 * never edits a trace. Root comparisons are committed only after queued model
 * controls finish, so a provisional refusal cannot become a cached verdict. */
export function recordedInputChains(map: Beatmap, trace: ReplayTrace) {
  const attempts = new Map<string, Attempt>(),
    routes = new Map<string, ReplayTraceRecord[]>(),
    activations = new Map<string, ReplayTraceRecord>(),
    resolutions = new Map<string, Resolution>(),
    inputs: InputRecord[] = [];
  for (const r of trace.records) {
    if (r.kind === "attempt") attempts.set(r.id, r);
    if (r.kind === "resolution") resolutions.set(r.componentId, r);
    if (r.kind === "input") inputs.push(r);
    if (r.kind === "lifecycle" && !activations.has(r.componentId)) activations.set(r.componentId, r);
  }
  for (const r of trace.records) {
    const attemptId = "attemptId" in r ? r.attemptId : r.kind === "resolution" ? r.triggerAttemptId : undefined;
    const a = attemptId ? attempts.get(attemptId) : undefined;
    if (a) {
      const list = routes.get(a.inputId) ?? [];
      list.push(r);
      routes.set(a.inputId, list);
    }
  }
  const windows =
    trace.identity.analysisProfileId === "stable"
      ? stableHitWindowsForOD(map.stableOverallDifficulty ?? map.difficulty.overallDifficulty)
      : hitWindowsForOD(map.difficulty.overallDifficulty, true);
  const notes: Note[] = map.hitObjects.flatMap((o) => {
    if (!(o instanceof HitCircle) && !(o instanceof Slider)) return [];
    const h = o instanceof Slider ? o.head : o,
      resolution = resolutions.get(h.id),
      a = resolution?.triggerAttemptId ? attempts.get(resolution.triggerAttemptId) : undefined;
    return [{ id: h.id, parentId: o.id, time: h.hitTime, index: 0, resolution, receiptId: a?.inputId }];
  });
  notes.forEach((n, i) => (n.index = i));
  const noteById = new Map(notes.map((n) => [n.id, n])),
    parentNote = new Map(notes.map((n) => [n.parentId, n])),
    inputIndex = new Map(inputs.map((p, i) => [p.id, i]));
  const capability = errorCapabilities(map, trace.identity.analysisProfileId);
  const usable =
    capability.aim === "manual" &&
    capability.tapping === "manual" &&
    !trace.failures.some((s) => s !== "global-totals-mismatch") &&
    trace.droppedRecordBoundary === undefined;
  const invalidPrefix = [0];
  for (let i = 0; i < inputs.length; i++) {
    const p = inputs[i],
      q = inputs[i - 1];
    const valid =
      p.source.origin === "parsed" &&
      !p.source.discontinuityBefore?.length &&
      [p.timeMs, p.position.x, p.position.y].every(Number.isFinite) &&
      [p.actions, p.previousActions, p.freshActions].every(
        (a) => new Set(a).size === a.length && a.every((v) => v === 0 || v === 1),
      ) &&
      same(
        p.freshActions,
        p.actions.filter((a) => !p.previousActions.includes(a)),
      ) &&
      (p.rawButtonMask === undefined ||
        (Number.isSafeInteger(p.rawButtonMask) &&
          p.rawButtonMask >= 0 &&
          p.rawButtonMask <= 31 &&
          same(p.actions, [...(p.rawButtonMask & 5 ? [0] : []), ...(p.rawButtonMask & 10 ? [1] : [])]))) &&
      (!q ||
        (q.source.origin === "parsed" &&
          p.timeMs >= q.timeMs &&
          p.sequence > q.sequence &&
          p.source.parsedFrameIndex === q.source.parsedFrameIndex + 1 &&
          same(p.previousActions, q.actions) &&
          ((p.source.rawTokenIndex === undefined && q.source.rawTokenIndex === undefined) ||
            (p.source.rawTokenIndex !== undefined &&
              q.source.rawTokenIndex !== undefined &&
              p.source.rawTokenIndex === q.source.rawTokenIndex + 1))));
    invalidPrefix.push(invalidPrefix[i] + (valid ? 0 : 1));
  }
  const sourceValid = (first: number, last: number) => first > 0 && invalidPrefix[last + 1] === invalidPrefix[first];
  const rejectedPolicies = new Map<string, Set<string>>();
  const validBlock = (r: Extract<ReplayTraceRecord, { kind: "policy" }>) => {
    let ids = rejectedPolicies.get(r.componentId);
    if (!ids) {
      const e = deriveCircleEvidence(trace, map, r.componentId);
      ids = new Set(deriveRecordedRejections(e, map, trace).map((w) => w.policyId));
      rejectedPolicies.set(r.componentId, ids);
    }
    return ids.has(r.id);
  };
  const validReceipt = (r: Resolution, p: InputRecord) => {
    const a = r.triggerAttemptId && attempts.get(r.triggerAttemptId),
      route = routes.get(p.id) ?? [],
      selections = route.filter((s) => s.kind === "selection" && s.attemptId === r.triggerAttemptId),
      policies = route.filter((s) => s.kind === "policy" && s.attemptId === r.triggerAttemptId),
      s = selections[0],
      q = policies[0],
      n = noteById.get(r.componentId),
      object = n && map.getHitObject(n.id),
      active = activations.get(r.componentId),
      next = inputs[inputIndex.get(p.id)! + 1];
    if (
      !a ||
      a.automated ||
      a.inputId !== p.id ||
      !same(a.actionCandidates, p.freshActions) ||
      !Number.isSafeInteger(a.attemptOrdinal) ||
      a.attemptOrdinal < 0 ||
      a.attemptOrdinal >= p.freshActions.length ||
      (a.knownAction !== undefined && !p.freshActions.includes(a.knownAction)) ||
      !n ||
      !(object instanceof HitCircle) ||
      selections.length !== 1 ||
      policies.length !== 1 ||
      s?.kind !== "selection" ||
      q?.kind !== "policy" ||
      s.componentId !== n.id ||
      q.componentId !== n.id ||
      !s.inside ||
      !s.eligible ||
      !s.selectionStopped ||
      q.state !== "allowed" ||
      !active ||
      active.sequence >= p.sequence ||
      !r.previousUnresolved ||
      !(p.sequence < a.sequence && a.sequence < s.sequence && s.sequence < q.sequence && q.sequence < r.sequence) ||
      (next && next.sequence < r.sequence) ||
      [a, s, q, r].some((v) => v.timeMs !== p.timeMs)
    )
      return false;
    const offset = p.timeMs - n.time,
      magnitude = Math.abs(offset),
      grade =
        magnitude <= windows[0] ? "GREAT" : magnitude <= windows[1] ? "OK" : magnitude <= windows[2] ? "MEH" : "MISS";
    const inside =
      trace.identity.analysisProfileId === "stable"
        ? stableWithinHitRadius(p.position, object.position, stableGameplayRadius(object.radius))
        : nativeWithinHitRadius(p.position, object.position, object.radius);
    return (
      inside &&
      q.offsetMs === offset &&
      q.timingResult === grade &&
      r.result === grade &&
      (grade === "MISS" ? r.mechanism === "input-miss" : r.mechanism === "successful-input")
    );
  };
  const invalidPackets = new Set<string>();
  const kind = (p: InputRecord): Kind => {
    const route = routes.get(p.id) ?? [];
    const receipts = route.filter(
      (r): r is Resolution =>
        r.kind === "resolution" &&
        r.timeMs === p.timeMs &&
        (r.mechanism === "successful-input" || r.mechanism === "input-miss"),
    );
    const blocks = route.filter(
      (r): r is Extract<ReplayTraceRecord, { kind: "policy" }> => r.kind === "policy" && r.state === "rejected",
    );
    if (receipts.some((r) => !validReceipt(r, p)) || blocks.some((r) => !validBlock(r))) invalidPackets.add(p.id);
    const offset = (r: Resolution) => p.timeMs - (noteById.get(r.componentId)?.time ?? Infinity);
    if (receipts.some((r) => r.result === "GREAT" || (["OK", "MEH"].includes(r.result) && offset(r) <= 0)))
      return "normal";
    if (receipts.some((r) => r.mechanism === "input-miss" && offset(r) < 0)) return "early-miss";
    if (receipts.some((r) => ["OK", "MEH", "MISS"].includes(r.result) && offset(r) > 0)) return "late-receipt";
    return route.some((r) => r.kind === "policy" && r.state === "rejected" && r.blockerId) ? "blocked" : "hit-nothing";
  };
  // Open/resolve events include sequence order at equal timestamps. A head's
  // actual resolution governs waiting; its comparison retains lifecycle limits.
  const events: Array<{ time: number; sequence: number; delta: number }> = [];
  for (const n of notes) {
    const open = n.time - windows[2],
      r = n.resolution;
    if (r && r.timeMs < open) continue;
    events.push({ time: open, sequence: -Infinity, delta: 1 });
    if (r) events.push({ time: r.timeMs, sequence: r.sequence, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.sequence - b.sequence);
  const cmp = (a: { time: number; sequence: number }, b: { time: number; sequence: number }) =>
    a.time === b.time ? a.sequence - b.sequence : a.time - b.time;
  const empty: Array<{ start: { time: number; sequence: number }; end: { time: number; sequence: number } }> = [];
  let waiting = 0,
    lastEmpty = { time: -Infinity, sequence: -Infinity };
  for (const e of events) {
    const before = waiting;
    waiting += e.delta;
    if (before === 0 && waiting > 0) empty.push({ start: lastEmpty, end: e });
    if (waiting === 0) lastEmpty = e;
  }
  if (waiting === 0) empty.push({ start: lastEmpty, end: { time: Infinity, sequence: Infinity } });
  const presses = inputs.flatMap((p, i) =>
    p.freshActions.length
      ? [{ p, index: i, kind: kind(p), start: -1, stop: "", root: undefined as Note | undefined }]
      : [],
  );
  let emptyAt = 0,
    earliest = 0;
  for (let i = 0; i < presses.length; i++) {
    const row = presses[i],
      previous = presses[i - 1],
      current = { time: row.p.timeMs, sequence: row.p.sequence };
    while (earliest < notes.length && (notes[earliest].resolution?.sequence ?? Infinity) < row.p.sequence) earliest++;
    row.root = notes[earliest]?.time - windows[2] <= row.p.timeMs ? notes[earliest] : undefined;
    while (
      previous &&
      emptyAt < empty.length &&
      cmp(empty[emptyAt].end, { time: previous.p.timeMs, sequence: previous.p.sequence }) <= 0
    )
      emptyAt++;
    const gap = !!previous && !!empty[emptyAt] && cmp(empty[emptyAt].start, current) < 0;
    if (!sourceValid(row.index, row.index) || invalidPackets.has(row.p.id)) {
      row.stop = "invalid-source-press";
      continue;
    }
    row.start = i;
    if (row.kind === "hit-nothing" || row.kind === "early-miss" || row.kind === "normal") row.stop = row.kind;
    else if (!previous) row.stop = "source-start";
    else if (gap) row.stop = "nothing-waiting";
    else if (previous.kind === "normal") row.stop = "before-normal-hit";
    else if (!sourceValid(previous.index, row.index) || previous.start < 0) {
      row.start = -1;
      row.stop = "invalid-source-path";
    } else {
      row.start = previous.start;
      row.stop = previous.stop;
    }
  }
  const pressIndex = new Map(presses.map((p, i) => [p.p.id, i])),
    rootCache = new Map<string, RootCause | undefined>(),
    draft = new Map<string, RootCause | undefined>();
  function rootCause(at: number): RootCause | undefined {
    const row = presses[at],
      n = row.root;
    if (!n) return;
    const key = n.id + ":" + row.p.id;
    if (rootCache.has(key)) return rootCache.get(key);
    const e = deriveCircleEvidence(trace, map, n.id);
    let result: RootCause | undefined;
    if (n.receiptId === row.p.id && row.kind === "late-receipt" && ["OK", "MEH"].includes(n.resolution?.result ?? "")) {
      const mechanism = classifyCircleLoss(e, map);
      if (mechanism.status === "supported" && mechanism.codes.length)
        result = { mechanism, selected: [], reason: "existing-exact-receipt-diagnosis" };
    } else if (e.geometry && e.inputs.some((i) => i.record.id === row.p.id)) {
      const next = presses[at + 1]?.p,
        previousReceipt = latestOtherReceiptBoundary(trace, map, n.id, row.p),
        c = comparePrimaryApproaches(
          e,
          map,
          {
            pressIds: [row.p.id],
            ...(previousReceipt ? { start: previousReceipt } : {}),
            ...(next
              ? { end: { timeMs: next.timeMs, sequence: next.sequence, inclusive: false, eventId: next.id } }
              : {}),
          },
          trace,
        );
      const selected = c.ranking.selected,
        single = selected.length === 1 ? selected[0] : undefined;
      if (selected.length)
        result = {
          selected,
          reason: c.ranking.reason,
          mechanism: {
            status: "supported",
            codes: selected.map((s) => s.code),
            headline: selected.map((s) => s.headline).join(" · "),
            description: "The initiating error at the recorded start press.",
            metric: single?.metric,
            briefDetail: single?.briefDetail,
            eventIds: unique([row.p.id, ...c.ranking.comparisonEventIds, ...selected.flatMap((s) => s.eventIds)]),
            limitations: [],
          },
        };
    }
    draft.set(key, result);
    return result;
  }
  function opportunities(e: CircleEvidence, n: Note): Opportunity[] {
    return e.inputs.flatMap((item) => {
      const p = item.record;
      if (!item.inside || !item.inLiveSuccess || item.postTerminal || !item.freshActionsKnown || !p.freshActions.length)
        return [];
      const at = pressIndex.get(p.id);
      if (at === undefined || presses[at].start < 0 || presses[at].kind === "normal") return [];
      const route = routes.get(p.id) ?? [],
        found: Opportunity[] = [];
      for (const r of route) {
        if (r.sequence <= p.sequence || r.timeMs !== p.timeMs) continue;
        const attemptId = r.kind === "resolution" ? r.triggerAttemptId : r.kind === "policy" ? r.attemptId : undefined;
        const a = attemptId ? attempts.get(attemptId) : undefined;
        if (!a || a.automated || a.timeMs !== p.timeMs || a.sequence <= p.sequence) continue;
        const selection = route.find((s) => s.kind === "selection" && s.attemptId === a.id);
        if (selection?.kind !== "selection" || !selection.inside || selection.sequence <= a.sequence) continue;
        if (r.kind === "resolution" && ["successful-input", "input-miss"].includes(r.mechanism)) {
          const previous = notes[n.index - 1],
            policy = route.find((s) => s.kind === "policy" && s.attemptId === a.id);
          if (
            previous?.id !== r.componentId ||
            !["OK", "MEH", "MISS"].includes(r.result) ||
            p.timeMs <= previous.time ||
            selection.componentId !== previous.id ||
            policy?.kind !== "policy" ||
            policy.state !== "allowed" ||
            policy.componentId !== previous.id ||
            policy.sequence >= r.sequence
          )
            continue;
          found.push({
            kind: "taken",
            inputId: p.id,
            receiverId: previous.id,
            receiverResult: r.result,
            eventIds: [p.id, a.id, selection.id, policy.id, r.id],
          });
        } else if (
          r.kind === "policy" &&
          r.state === "rejected" &&
          r.blockerId &&
          r.componentId === n.id &&
          selection.componentId === n.id &&
          validBlock(r) &&
          ["GREAT", "OK", "MEH"].includes(r.timingResult ?? "")
        ) {
          const prior = noteById.get(r.blockerId) ?? parentNote.get(r.blockerId);
          if (prior && prior.index < n.index)
            found.push({
              kind: "blocked",
              inputId: p.id,
              blockerId: r.blockerId,
              eventIds: [p.id, a.id, selection.id, r.id],
            });
        }
      }
      return found;
    });
  }
  return {
    commit() {
      for (const [key, value] of draft) rootCache.set(key, value);
      draft.clear();
    },
    apply(e: CircleEvidence, original: CircleMechanism): CircleMechanism {
      draft.clear();
      const n = e.target && noteById.get(e.targetId);
      if (
        !usable ||
        !n ||
        e.status !== "supported" ||
        e.terminal?.result !== "MISS" ||
        e.limits.truncated ||
        [e.dependencies.geometry, e.dependencies.routing, e.dependencies.lifecycle].some((d) => d.status !== "complete")
      )
        return original;
      const ops = opportunities(e, n);
      if (!ops.length) return original;
      const ends = ops.map((o) => pressIndex.get(o.inputId)!),
        starts = unique(ends.map((i) => presses[i].start));
      if (starts.length !== 1 || starts[0] < 0) return original;
      const start = starts[0],
        row = presses[start],
        root = row.root,
        cause = rootCause(start);
      if (!root || !cause) return original;
      const protectedCause = original.headline.split(/\s*·\s*/).some((label) => protectedLabels.has(label));
      const end = Math.max(...ends),
        chain: RecordedInputChain = {
          policy: "recorded-input-chain-v1",
          chained: true,
          start: { componentId: root.id, inputId: row.p.id, timeMs: row.p.timeMs, kind: row.kind },
          opportunities: ops,
          pressIds: presses.slice(start, end + 1).map((p) => p.p.id),
          durationMs: presses[end].p.timeMs - row.p.timeMs,
          stop: presses[end].stop,
          disposition: protectedCause ? "protected" : "inherited",
          cause: {
            codes: cause.mechanism.codes,
            headline: cause.mechanism.headline,
            observationOnly: cause.selected.some((s) => s.observationOnly),
            reason: cause.reason,
            eventIds: cause.mechanism.eventIds,
          },
          // Recorded chain evidence is distinct from the root diagnosis certificate.
          certification: { status: "observation", reason: "downstream-certification-not-requested" },
        };
      if (protectedCause) return { ...original, chain };
      return {
        ...original,
        ...cause.mechanism,
        diagnostics: original.diagnostics,
        eventIds: unique([...original.eventIds, ...cause.mechanism.eventIds, ...ops.flatMap((o) => o.eventIds)]),
        limitations: original.limitations,
        chain,
      };
    },
  };
}
