import { createHash } from "crypto";
import { parseLibraryScoreEvents } from "./library-scores";
import type { LibrarySavedScore, LibraryScoreGroupSpan, LibraryScoreRecordSpan } from "./library-scores";
import { setImmediate } from "timers/promises";

export interface LibraryScoreDeletionRequest {
  databaseSha256: string;
  selections: { sourceKey: string; occurrences: number }[];
}
export interface LibraryScoreDeletionPreparation {
  bytes: Buffer;
  beforeSha256: string;
  afterSha256: string;
  removedOccurrences: number;
  selected: { sourceKey: string; occurrences: number; score: LibrarySavedScore; cacheRelativePath: string }[];
  cachePaths: {
    relativePath: string;
    removedOccurrences: number;
    retainedOccurrences: number;
    retainedReferences: { sourceKey: string; occurrences: number }[];
  }[];
}

function* digestSteps(bytes: Buffer): Generator<void, string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    hash.update(bytes.subarray(offset, offset + 1024 * 1024)); yield;
  }
  return hash.digest("hex");
}
const cachePath = (score: LibrarySavedScore) => `Data/r/${score.header.beatmapMD5}-${BigInt(score.header.playedAtTicks) - BigInt("504911232000000000")}.osr`;
type Selection = { expected: number; found: number; score?: LibrarySavedScore };
type Edit = { start: number; end: number; group?: number };

function* retainedRecords(bytes: Buffer, selections: ReadonlyMap<string, Selection>) {
  let span: Readonly<LibraryScoreRecordSpan> | undefined;
  let count = 0, lastPosition = 0;
  for (const score of parseLibraryScoreEvents(bytes, { onScore: (_score, observed) => { span = observed; } })) {
    if (score === null || ++count % 64 === 0 || span && span.end - lastPosition >= 1024 * 1024) {
      lastPosition = span?.end ?? lastPosition; yield null;
    }
    if (score !== null && !selections.has(score.sourceKey)) {
      if (!span) throw new Error("Missing saved score framing");
      yield { score, span };
    }
  }
}
function* nextRetained(records: ReturnType<typeof retainedRecords>): Generator<void, { score: LibrarySavedScore; span: Readonly<LibraryScoreRecordSpan> } | undefined> {
  while (true) {
    const next = records.next(); if (next.done) return undefined;
    if (next.value) return next.value;
    yield;
  }
}

/** Pure preparation only: no filesystem access, file quarantine or source mutation.
 * Every raw-record occurrence selected by a key must be explicitly acknowledged.
 * Cache paths are relative resolver names; any retained occurrence requires keeping that file.
 * The caller must separately establish a fresh, stable source lease before committing these bytes.
 */
export function prepareLibraryScoreDeletion(bytes: Buffer, request: LibraryScoreDeletionRequest): LibraryScoreDeletionPreparation {
  const steps = prepareSteps(bytes, request);
  let next = steps.next(); while (!next.done) next = steps.next(); return next.value;
}

/** Same transformation and verification steps, cooperatively consumed by the resource utility. */
export async function prepareLibraryScoreDeletionAsync(bytes: Buffer, request: LibraryScoreDeletionRequest,
  options: { signal?: AbortSignal; checkpoint?: () => Promise<void>; maxRetainedReferences?: number } = {}): Promise<LibraryScoreDeletionPreparation> {
  if (options.maxRetainedReferences !== undefined && (!Number.isSafeInteger(options.maxRetainedReferences) || options.maxRetainedReferences < 0 || options.maxRetainedReferences > 1_000_000)) throw new Error("Invalid retained reference limit");
  const steps = prepareSteps(bytes, request, options.maxRetainedReferences), checkpoint = options.checkpoint ?? (() => setImmediate());
  try {
    options.signal?.throwIfAborted(); let next = steps.next();
    while (!next.done) { await checkpoint(); options.signal?.throwIfAborted(); next = steps.next(); }
    options.signal?.throwIfAborted(); return next.value;
  } finally { steps.return(undefined as never); }
}

function* prepareSteps(bytes: Buffer, request: LibraryScoreDeletionRequest, maxRetainedReferences?: number): Generator<void, LibraryScoreDeletionPreparation> {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024 * 1024) throw new Error("Invalid saved score database size");
  if (!request || typeof request !== "object" || !/^[a-f0-9]{64}$/.test(request.databaseSha256) || !Array.isArray(request.selections) || !request.selections.length || request.selections.length > 4096) throw new Error("Invalid saved score deletion request");
  const selections = new Map<string, Selection>();
  let requested = 0;
  for (const selection of request.selections) {
    if (!selection || typeof selection !== "object" || typeof selection.sourceKey !== "string" || !/^[a-f0-9]{64}$/.test(selection.sourceKey) || !Number.isSafeInteger(selection.occurrences) || selection.occurrences < 1 || selection.occurrences > 1_000_000 || selections.has(selection.sourceKey)) throw new Error("Invalid saved score deletion selection");
    requested += selection.occurrences;
    if (requested > 1_000_000) throw new Error("Saved score deletion occurrence limit exceeded");
    selections.set(selection.sourceKey, { expected: selection.occurrences, found: 0 });
  }
  const beforeSha256 = yield* digestSteps(bytes);
  if (beforeSha256 !== request.databaseSha256) throw new Error("Saved score database digest changed");
  const groups: Readonly<LibraryScoreGroupSpan>[] = [], edits: Edit[] = [], removedByGroup = new Map<number, number>();
  let removedBytes = 0, rawPosition = 0;
  // One strict grammar supplies both the selected raw spans and all group boundaries.
  const inputEvents = parseLibraryScoreEvents(bytes, {
    onGroup: group => { groups.push(group); },
    onScore: (score, span) => {
      rawPosition = span.end;
      const selected = selections.get(score.sourceKey);
      if (!selected) return;
      selected.found++; selected.score = score;
      if (!removedByGroup.has(span.group)) {
        const countOffset = groups[span.group].countOffset;
        edits.push({ start: countOffset, end: countOffset + 4, group: span.group });
      }
      removedByGroup.set(span.group, (removedByGroup.get(span.group) ?? 0) + 1);
      edits.push({ start: span.start, end: span.end }); removedBytes += span.end - span.start;
    },
  });
  let eventCount = 0, parsedPosition = 0;
  for (const event of inputEvents) {
    const position = rawPosition;
    if (event === null || ++eventCount % 64 === 0 || position - parsedPosition >= 1024 * 1024) {
      parsedPosition = position; yield;
    }
  }
  for (const selected of selections.values()) if (selected.found !== selected.expected) throw new Error("Saved score occurrence count changed or selection is missing");

  const output = Buffer.allocUnsafe(bytes.length - removedBytes);
  let inputOffset = 0, outputOffset = 0, editCount = 0;
  for (const edit of edits) {
    if (edit.start < inputOffset) throw new Error("Overlapping saved score edits");
    while (inputOffset < edit.start) {
      const end = Math.min(edit.start, inputOffset + 1024 * 1024);
      const copied = end - inputOffset;
      outputOffset += bytes.copy(output, outputOffset, inputOffset, end); inputOffset = end;
      if (copied >= 1024 * 1024) yield;
    }
    if (edit.group !== undefined) {
      output.writeInt32LE(groups[edit.group].count - (removedByGroup.get(edit.group) ?? 0), outputOffset); outputOffset += 4;
    }
    inputOffset = edit.end;
    if (++editCount % 64 === 0) yield;
  }
  while (inputOffset < bytes.length) {
    const end = Math.min(bytes.length, inputOffset + 1024 * 1024);
    outputOffset += bytes.copy(output, outputOffset, inputOffset, end); inputOffset = end; yield;
  }
  if (outputOffset !== output.length) throw new Error("Saved score deletion byte conservation failed");

  const paths = new Map<string, { removed: number; retained: number; references: Map<string, number> }>();
  const selected = [...selections].map(([sourceKey, selection]) => {
    if (!selection.score) throw new Error("Missing selected saved score");
    const relativePath = cachePath(selection.score), existing = paths.get(relativePath);
    if (existing) existing.removed += selection.found;
    else paths.set(relativePath, { removed: selection.found, retained: 0, references: new Map() });
    return { sourceKey, occurrences: selection.found, score: selection.score, cacheRelativePath: relativePath };
  });
  const remaining = retainedRecords(bytes, selections);
  let outputSpan: Readonly<LibraryScoreRecordSpan> | undefined, groupCount = 0, referenceCount = 0;
  // Reparse output and compare every retained raw record and group key in original order.
  try {
  for (const score of parseLibraryScoreEvents(output, {
    onGroup: group => {
      const original = groups[group.index]; groupCount++;
      if (!original || group.count !== original.count - (removedByGroup.get(group.index) ?? 0) || !output.subarray(group.start, group.countOffset).equals(bytes.subarray(original.start, original.countOffset))) throw new Error("Saved score group conservation failed");
    },
    onScore: (_score, span) => { outputSpan = span; },
  })) {
    if (score === null) { yield; continue; }
    const original = yield* nextRetained(remaining);
    if (!original || !outputSpan || score.sourceKey !== original.score.sourceKey || !output.subarray(outputSpan.start, outputSpan.end).equals(bytes.subarray(original.span.start, original.span.end))) throw new Error("Saved score record conservation failed");
    const path = paths.get(cachePath(score));
    if (path) {
      if (!path.references.has(score.sourceKey) && ++referenceCount > (maxRetainedReferences ?? 1_000_000)) throw new Error("Retained saved score references exceed response limit");
      path.retained++; path.references.set(score.sourceKey, (path.references.get(score.sourceKey) ?? 0) + 1);
    }
    if (++eventCount % 64 === 0) yield;
  }
  if ((yield* nextRetained(remaining)) || groupCount !== groups.length || !output.subarray(0, 8).equals(bytes.subarray(0, 8))) throw new Error("Saved score database conservation failed");
  } finally { remaining.return(); }
  if ((yield* digestSteps(bytes)) !== beforeSha256) throw new Error("Saved score database digest changed during preparation");
  const afterSha256 = yield* digestSteps(output);
  return {
    bytes: output, beforeSha256, afterSha256, removedOccurrences: requested, selected,
    cachePaths: [...paths].sort(([a], [b]) => a.localeCompare(b)).map(([relativePath, path]) => ({
      relativePath, removedOccurrences: path.removed, retainedOccurrences: path.retained,
      retainedReferences: [...path.references].sort(([a], [b]) => a.localeCompare(b)).map(([sourceKey, occurrences]) => ({ sourceKey, occurrences })),
    })),
  };
}
