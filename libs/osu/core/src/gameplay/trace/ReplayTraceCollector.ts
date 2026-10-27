import {
  ReplayTrace,
  ReplayTraceObservation,
  ReplayTraceRecord,
  ScoringDomain,
  TraceCapture,
  TraceChannel,
  TraceLimits,
  TraceRunIdentity,
  TraceSource,
} from "./ReplayTrace";
import { validErrorObservation } from "../error-analysis/ErrorObservations";
import { validEndpointBracketDomain, capturedEndpointBracketIsValid } from "./EndpointInputBracket";

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function finite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(finite);
  return true;
}
function copy<T>(value: T): T {
  // Trace data is plain JSON data. Copy once without a stringify/parse round trip.
  if (Array.isArray(value)) return value.map((entry) => copy(entry === undefined ? null : entry)) as T;
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    Object.keys(value).forEach((key) => {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        if (key === "__proto__")
          Object.defineProperty(result, key, {
            value: copy(entry),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        else result[key] = copy(entry);
      }
    });
    return result as T;
  }
  return value;
}
const channels: TraceChannel[] = ["input", "geometry", "routing", "lifecycle"];
// Only collector-owned/deeply frozen values enter this cache; foreign shallow freezes cannot bypass ownership.
const ownedTraceBytes = new WeakMap<ReplayTrace, number>();
/** Collector/prepared ownership proves deep immutability; a shallow freeze does not. */
export function isOwnedReplayTrace(trace: ReplayTrace): boolean {
  return ownedTraceBytes.has(trace);
}
function finish<T>(steps: Generator<void, T, void>): T {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
const nonnegativeInteger = (n: number) => Number.isSafeInteger(n) && n >= 0;
const nonempty = (s: string) => typeof s === "string" && s.length > 0;
function validSource(source: TraceSource): boolean {
  if (!source) return false;
  switch (source.origin) {
    case "parsed":
      return (
        nonnegativeInteger(source.parsedFrameIndex) &&
        (source.rawTokenIndex === undefined || nonnegativeInteger(source.rawTokenIndex)) &&
        (source.discontinuityBefore === undefined ||
          (Array.isArray(source.discontinuityBefore) && source.discontinuityBefore.every(nonempty)))
      );
    case "synthetic":
      return nonempty(source.reason);
    case "provided-frame":
      return nonnegativeInteger(source.preparedFrameIndex);
    default:
      return false;
  }
}
function validIdentityDomain(identity: TraceRunIdentity, domain: ScoringDomain): boolean {
  if (!validEndpointBracketDomain(domain)) return false;
  if (domain.synthesizedEndpoint && domain.frameSources?.[domain.frameSources.length - 1]?.origin !== "synthetic")
    return false;
  const digest = (value: string | null, length: number) =>
    value === null || (typeof value === "string" && new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value));
  return (
    (identity.schemaVersion === 1 || identity.schemaVersion === 2) &&
    [
      identity.generationKey,
      identity.recordingClient,
      identity.analysisProfileId,
      identity.analysisProfileFingerprint,
      identity.parserVersion,
      identity.inputPreparationVersion,
    ].every(nonempty) &&
    digest(identity.replayContentSha256, 64) &&
    digest(identity.beatmapContentSha256, 64) &&
    digest(identity.beatmapMd5, 32) &&
    finite(domain) &&
    Number.isFinite(domain.endTimeMs) &&
    ["recorded-end", "health-derived", "aggregate-inferred"].includes(domain.endpointBasis) &&
    typeof domain.synthesizedEndpoint === "boolean" &&
    (domain.initialActionsKnown === undefined || typeof domain.initialActionsKnown === "boolean") &&
    Array.isArray(domain.sourceCoverageLimits) &&
    domain.sourceCoverageLimits.every(nonempty) &&
    (domain.frameSources === undefined ||
      (Array.isArray(domain.frameSources) && domain.frameSources.every(validSource)))
  );
}
export function traceUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const point = text.codePointAt(index) ?? 0;
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (point >= 65536) index++;
  }
  return bytes;
}
export function validTraceObservation(o: ReplayTraceObservation, schemaVersion: 1 | 2): boolean {
  if (!o || !finite(o) || typeof o.id !== "string" || !Number.isFinite(o.timeMs)) return false;
  const actions = (a: number[]): boolean => Array.isArray(a) && a.every((x) => x === 0 || x === 1);
  const component = (c: string) => c === "circle" || c === "slider-head";
  switch (o.kind) {
    case "slider-tracking":
    case "slider-checkpoint":
    case "slider-parent":
    case "spinner-resolution":
      return schemaVersion === 2 && (o.phase === "lifecycle" || o.phase === "resolution") && validErrorObservation(o);
    case "lifecycle":
      return (
        o.phase === "lifecycle" && nonempty(o.componentId) && component(o.component) && o.transition === "activated"
      );
    case "input":
      return (
        o.phase === "input" &&
        Number.isFinite(o.position?.x) &&
        Number.isFinite(o.position?.y) &&
        actions(o.actions) &&
        actions(o.previousActions) &&
        actions(o.freshActions) &&
        validSource(o.source) &&
        nonnegativeInteger(o.groupMemberIndex) &&
        (o.rawButtonMask === undefined || nonnegativeInteger(o.rawButtonMask))
      );
    case "attempt":
      return (
        o.phase === "attempt" &&
        nonempty(o.inputId) &&
        nonnegativeInteger(o.attemptOrdinal) &&
        actions(o.actionCandidates) &&
        (o.automated === undefined || (schemaVersion === 2 && typeof o.automated === "boolean")) &&
        (!o.automated || (o.actionCandidates.length === 0 && o.knownAction === undefined)) &&
        (o.knownAction === undefined || o.actionCandidates.includes(o.knownAction))
      );
    case "selection":
      return (
        o.phase === "dispatch" &&
        nonempty(o.attemptId) &&
        (o.componentId === null || (nonempty(o.componentId) && component(o.component ?? ""))) &&
        (o.inside === null || typeof o.inside === "boolean") &&
        typeof o.eligible === "boolean" &&
        typeof o.selectionStopped === "boolean"
      );
    case "policy":
      return (
        o.phase === "dispatch" &&
        nonempty(o.attemptId) &&
        nonempty(o.componentId) &&
        nonempty(o.branch) &&
        ["allowed", "rejected", "not-queried"].includes(o.state) &&
        Number.isFinite(o.offsetMs)
      );
    case "resolution":
      return (
        o.phase === "resolution" &&
        nonempty(o.componentId) &&
        component(o.component) &&
        ["MISS", "GREAT", "OK", "MEH"].includes(o.result) &&
        [
          "input-miss",
          "successful-input",
          "automatic-expiry",
          "ordered-force-miss",
          "other-supported-resolution",
        ].includes(o.mechanism) &&
        typeof o.previousUnresolved === "boolean"
      );
    case "coverage":
      return (
        o.phase === "coverage" &&
        channels.includes(o.channel) &&
        ["complete", "partial", "unsupported"].includes(o.status) &&
        nonempty(o.reason) &&
        Number.isFinite(o.startTimeMs) &&
        Number.isFinite(o.endTimeMs) &&
        o.startTimeMs <= o.endTimeMs
      );
    default:
      return false;
  }
}

function* referenceFailures(
  records: readonly ReplayTraceRecord[],
  existingIndex?: Map<string, ReplayTraceRecord>,
): Generator<void, string[], void> {
  const byId = existingIndex ?? new Map<string, ReplayTraceRecord>();
  let work = 0;
  if (!existingIndex)
    for (const record of records) {
      byId.set(record.id, record);
      if (++work % 256 === 0) yield;
    }
  const failures = new Set<string>();
  let parsedIndex = -1,
    rawIndex = -1;
  for (const record of records) {
    if (++work % 256 === 0) yield;
    const refs: Array<[string | undefined, string, boolean]> =
      record.kind === "attempt"
        ? [[record.inputId, "input", false]]
        : record.kind === "selection" || record.kind === "policy"
        ? [[record.attemptId, "attempt", false]]
        : record.kind === "resolution"
        ? [
            [record.triggerAttemptId, "attempt", false],
            [record.triggerResolutionId, "resolution", true],
          ]
        : [];
    for (const [id, kind, forward] of refs)
      if (id !== undefined) {
        const target = byId.get(id);
        if (!target || target.kind !== kind || id === record.id || (!forward && target.sequence >= record.sequence))
          failures.add("broken-reference");
      }
    if (record.kind === "input" && record.source.origin === "parsed") {
      if (record.source.parsedFrameIndex <= parsedIndex) failures.add("invalid-source-order");
      parsedIndex = record.source.parsedFrameIndex;
      if (record.source.rawTokenIndex !== undefined) {
        if (record.source.rawTokenIndex <= rawIndex) failures.add("invalid-source-order");
        rawIndex = record.source.rawTokenIndex;
      }
    }
  }
  // Iterative cycle detection avoids recursion on long causal chains.
  const done = new Set<string>();
  for (const record of records) {
    if (++work % 256 === 0) yield;
    if (done.has(record.id)) continue;
    const path = new Set<string>();
    let current: ReplayTraceRecord | undefined = record;
    while (current && !done.has(current.id)) {
      if (++work % 256 === 0) yield;
      if (path.has(current.id)) {
        failures.add("broken-reference");
        break;
      }
      path.add(current.id);
      current =
        current.kind === "resolution" && current.triggerResolutionId
          ? byId.get(current.triggerResolutionId)
          : undefined;
    }
    for (const id of path) {
      done.add(id);
      if (++work % 256 === 0) yield;
    }
  }
  return Array.from(failures);
}

export function createReplayTraceCollector(
  identity: TraceRunIdentity,
  domain: ScoringDomain,
  limits: TraceLimits,
): TraceCapture {
  const records: ReplayTraceRecord[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  let reserved = 0,
    bytes = 0,
    disabled = false,
    sealing = false,
    sealed: ReplayTrace | undefined;
  let droppedRecordBoundary: number | undefined;
  const ownedIdentity = freeze(copy(identity)),
    ownedDomain = freeze(copy(domain)),
    ownedLimits = freeze(copy(limits));
  const coverage: Record<TraceChannel, "complete" | "partial" | "unsupported"> = {
    input: "partial",
    geometry: "partial",
    routing: "partial",
    lifecycle: "partial",
  };
  const covered = new Set<TraceChannel>();
  const recordSizes: number[] = [];
  const coverageUndo: Array<{
    sequence: number;
    channel: TraceChannel;
    status: typeof coverage.input;
    covered: boolean;
  }> = [];
  let failureBytes = 2; // UTF8 JSON [] until a new reason is actually recorded.
  // Serialize immutable source provenance once. Only the small live metadata
  // changes at admission; exact caps do not reserve imaginary future failures.
  const initialMetadata = { coverage, complete: false, failures: [] };
  const fixedEnvelopeBytes =
    traceUtf8Bytes(
      JSON.stringify({
        identity: ownedIdentity,
        domain: ownedDomain,
        records: [],
        ...initialMetadata,
        limits: ownedLimits,
      }),
    ) - traceUtf8Bytes(JSON.stringify(initialMetadata));
  const metadata = (value = coverage, includeFailures = true) => {
    const effective = { ...value };
    if (failures.length)
      for (const channel of channels) if (effective[channel] === "complete") effective[channel] = "partial";
    return {
      coverage: effective,
      complete: !failures.length && channels.every((c) => effective[c] === "complete"),
      failures: includeFailures ? [...failures] : [],
      droppedRecordBoundary,
    };
  };
  const byteLength = (recordBytes = bytes, value = coverage) =>
    fixedEnvelopeBytes +
    traceUtf8Bytes(JSON.stringify(metadata(value, false))) +
    failureBytes -
    2 +
    (recordBytes ? recordBytes - 1 : 0);
  const fail = (reason: string) => {
    if (sealed) return;
    if (!failures.includes(reason)) {
      failures.push(reason);
      failureBytes = traceUtf8Bytes(JSON.stringify(failures));
    }
    disabled = true;
    droppedRecordBoundary ??= records.length;
  };
  if (
    !validIdentityDomain(identity, domain) ||
    !nonnegativeInteger(limits.maxRecords) ||
    !nonnegativeInteger(limits.maxExportBytes) ||
    limits.maxExportBytes < 1
  )
    fail("invalid-identity-or-domain");
  function* seal(): Generator<void, ReplayTrace, void> {
    if (sealed) return sealed;
    sealing = true;
    const invalidReferences = yield* referenceFailures(records);
    if (sealed) return sealed;
    invalidReferences.forEach(fail);
    if (!capturedEndpointBracketIsValid(ownedDomain, records, failures.length > 0))
      fail("invalid-endpoint-input-bracket");
    // No suspension after the final snapshot: disposal/failure at a checkpoint
    // must be reflected in both the immutable result and its exact byte count.
    yield;
    if (sealed) return sealed;
    // A late validation/cancellation failure may enlarge metadata. Retain a
    // deterministic prefix; never shrink provenance or omit failure reasons.
    while (byteLength() > ownedLimits.maxExportBytes) {
      fail("export-byte-limit");
      let work = 0;
      while (records.length && byteLength() > ownedLimits.maxExportBytes) {
        const removed = records.pop()!;
        bytes -= recordSizes.pop()!;
        seen.delete(removed.id);
        const undo = coverageUndo[coverageUndo.length - 1];
        if (undo?.sequence === records.length) {
          coverageUndo.pop();
          coverage[undo.channel] = undo.status;
          if (!undo.covered) covered.delete(undo.channel);
        }
        droppedRecordBoundary = Math.min(droppedRecordBoundary ?? records.length, records.length);
        if (++work % 256 === 0) {
          yield;
          if (sealed) return sealed;
        }
      }
      // Preserve earlier failures and expose any forward reference lost with
      // the suffix. Such a trace remains explicitly invalid for export.
      (yield* referenceFailures(records)).forEach(fail);
      if (sealed) return sealed;
      if (!capturedEndpointBracketIsValid(ownedDomain, records, failures.length > 0))
        fail("invalid-endpoint-input-bracket");
      if (!records.length) break; // An immutable envelope alone may exceed the cap.
    }
    if (sealed) return sealed;
    const finalMetadata = metadata();
    const result: ReplayTrace = {
      identity: ownedIdentity,
      domain: ownedDomain,
      records: [...records],
      ...finalMetadata,
      limits: ownedLimits,
    };
    const sealedBytes = byteLength();
    // Owned records, identity and domain are already deeply frozen.
    Object.freeze(result.records);
    Object.freeze(finalMetadata.coverage);
    Object.freeze(result.failures);
    sealed = Object.freeze(result);
    ownedTraceBytes.set(sealed, sealedBytes);
    return sealed;
  }
  return {
    limits: ownedLimits,
    observationVersion: ownedIdentity.schemaVersion,
    domain: ownedDomain,
    reserveId: () => (disabled || sealed || sealing ? "" : `r${reserved++}`),
    fail,
    record(observation) {
      if (disabled || sealed || sealing) return;
      try {
        if (
          !validTraceObservation(observation, ownedIdentity.schemaVersion) ||
          !/^r\d+$/.test(observation.id) ||
          Number(observation.id.slice(1)) >= reserved ||
          seen.has(observation.id)
        ) {
          fail("invalid-observation");
          return;
        }
        if (records.length >= ownedLimits.maxRecords) {
          fail("record-limit");
          return;
        }
        const record = { ...copy(observation), sequence: records.length };
        const size = traceUtf8Bytes(JSON.stringify(record)) + 1;
        const nextCoverage = { ...coverage };
        if (
          record.kind === "coverage" &&
          (!covered.has(record.channel) ||
            record.status === "unsupported" ||
            (record.status === "partial" && coverage[record.channel] === "complete"))
        )
          nextCoverage[record.channel] = record.status;
        if (byteLength(bytes + size, nextCoverage) > ownedLimits.maxExportBytes) {
          fail("export-byte-limit");
          return;
        }
        if (record.kind === "coverage") {
          coverageUndo.push({
            sequence: records.length,
            channel: record.channel,
            status: coverage[record.channel],
            covered: covered.has(record.channel),
          });
          coverage[record.channel] = nextCoverage[record.channel];
          covered.add(record.channel);
        }
        records.push(freeze(record));
        recordSizes.push(size);
        seen.add(record.id);
        bytes += size;
      } catch {
        fail("recorder-failure");
      }
    },
    seal() {
      return finish(seal());
    },
    async sealAsync(checkpoint) {
      const steps = seal();
      try {
        await checkpoint();
        let next = steps.next();
        while (!next.done) {
          await checkpoint();
          next = steps.next();
        }
        return next.value;
      } finally {
        steps.return(undefined as never);
      }
    },
    dispose() {
      if (!sealed) fail("disposed");
      records.length = 0;
      bytes = 0;
      seen.clear();
      recordSizes.length = 0;
      coverageUndo.length = 0;
      covered.clear();
      for (const channel of channels) coverage[channel] = "partial";
    },
  };
}

/** Shared full validation; both cooperative assembly and explicit export retain the same checks. */
function* validateReplayTrace(trace: ReplayTrace): Generator<void, void, void> {
  if (
    (!ownedTraceBytes.has(trace) && !finite(trace)) ||
    !validIdentityDomain(trace.identity, trace.domain) ||
    !finite({ ...trace, records: [] }) ||
    !nonnegativeInteger(trace.limits.maxRecords) ||
    !nonnegativeInteger(trace.limits.maxExportBytes) ||
    trace.limits.maxExportBytes < 1 ||
    trace.records.length > trace.limits.maxRecords ||
    trace.failures.some((f) =>
      ["invalid-identity-or-domain", "invalid-observation", "broken-reference", "invalid-source-order"].includes(f),
    )
  )
    throw new Error("Invalid trace export");
  const byId = new Map<string, ReplayTraceRecord>();
  for (let index = 0; index < trace.records.length; index++) {
    const r = trace.records[index];
    if (!validTraceObservation(r, trace.identity.schemaVersion) || r.sequence !== index || byId.has(r.id))
      throw new Error("Invalid trace records");
    byId.set(r.id, r);
    if (index % 256 === 255) yield;
  }
  if ((yield* referenceFailures(trace.records, byId)).length) throw new Error("Invalid trace references");
  if (!capturedEndpointBracketIsValid(trace.domain, trace.records, trace.failures.length > 0))
    throw new Error("Invalid endpoint input bracket");
  const coverage: Record<TraceChannel, "complete" | "partial" | "unsupported"> = {
    input: "partial",
    geometry: "partial",
    routing: "partial",
    lifecycle: "partial",
  };
  const covered = new Set<TraceChannel>();
  let index = 0;
  for (const r of trace.records) {
    if (++index % 256 === 0) yield;
    if (r.kind !== "coverage") continue;
    if (
      !covered.has(r.channel) ||
      r.status === "unsupported" ||
      (r.status === "partial" && coverage[r.channel] === "complete")
    )
      coverage[r.channel] = r.status;
    covered.add(r.channel);
  }
  if (trace.failures.length)
    channels.forEach((c) => {
      if (coverage[c] === "complete") coverage[c] = "partial";
    });
  if (
    channels.some((c) => trace.coverage[c] !== coverage[c]) ||
    trace.complete !== (!trace.failures.length && channels.every((c) => coverage[c] === "complete"))
  )
    throw new Error("Invalid trace coverage");
}

/** Validated, owned input for session assembly; byte counting never grants a validation shortcut. */
export function* prepareReplayTrace(
  trace: ReplayTrace,
): Generator<void, { trace: ReplayTrace; byteLength: number }, void> {
  if (!ownedTraceBytes.has(trace)) {
    // Foreign values need a stable snapshot before the first suspension. Keep
    // the old nonfinite check before JSON can coerce a value to null.
    if (!finite(trace)) throw new Error("Invalid trace export");
    trace = freeze(copy(trace));
  }
  yield* validateReplayTrace(trace);
  let byteLength = ownedTraceBytes.get(trace);
  if (byteLength === undefined) {
    const text = JSON.stringify(trace);
    byteLength = traceUtf8Bytes(text);
    trace = freeze(JSON.parse(text));
    ownedTraceBytes.set(trace, byteLength);
  }
  if (byteLength > trace.limits.maxExportBytes) throw new Error("Trace export byte limit exceeded");
  return { trace, byteLength };
}

/** Headless export refuses invalid/oversized data; it is never called by gameplay. */
export function serializeReplayTrace(trace: ReplayTrace): string {
  finish(validateReplayTrace(trace));
  const text = JSON.stringify(trace);
  if (traceUtf8Bytes(text) > trace.limits.maxExportBytes) throw new Error("Trace export byte limit exceeded");
  return text;
}
