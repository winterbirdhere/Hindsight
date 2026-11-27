/**
 * Optional saved-score corroboration. This is the locally validated Stable OSG
 * layout, not a claim that OSG is an authenticated historical object-id log.
 * The loader must parse pairedReplay metadata from the exact paired bytes and
 * derive loaded identities from the canonical replay/map byte provenance.
 */
export type SavedScoreGrade = "GREAT" | "OK" | "MEH" | "MISS";
export type SavedScoreCounts = readonly [number, number, number, number, number, number];
export type SavedGradeCounts = Readonly<Record<SavedScoreGrade, number>>;

export interface SavedScorePairing {
  timelineSha256: string;
  loadedReplaySha256: string;
  loadedMapMd5: string;
  pairedReplay: {
    sha256: string;
    source: "stable-osr" | "native-osr";
    mode: number;
    version: number;
    mapMd5: string;
    counts: SavedScoreCounts;
    score: number;
    maximumCombo: number;
  };
}

export interface SavedScoreRow {
  readonly time: number;
  readonly playerByte: number;
  readonly counts: SavedScoreCounts;
  readonly score: number;
  readonly maximumCombo: number;
  readonly combo: number;
  /** Preserved without pretending to understand flags outside the validated layout. */
  readonly trailingBytes: readonly number[];
}

export interface SavedScoreGroup {
  readonly id: string;
  readonly row: number;
  readonly time: number;
  readonly ordinalStart: number;
  readonly count: number;
  /** An unordered multiset. A row can contain several judgements. */
  readonly grades: SavedGradeCounts;
  readonly cumulativeCounts: SavedScoreCounts;
}

export interface SavedScoreTimeline {
  readonly schema: "stable-saved-score-v1";
  readonly provenance: Readonly<{
    timelineSha256: string;
    pairedReplaySha256: string;
    mapMd5: string;
    version: number;
  }>;
  readonly rows: readonly SavedScoreRow[];
  readonly groups: readonly SavedScoreGroup[];
}

/** Optional loader diagnostics; never an ordinary player-cause panel. */
export interface SavedScoreSourceResult {
  readonly status: "validated" | "absent" | "rejected" | "unavailable";
  readonly timeline?: SavedScoreTimeline;
  readonly reason?: string;
  readonly attempts: readonly {
    timelinePath: string;
    pairedReplayPath: string;
    status: "validated" | "rejected" | "unavailable";
    reason?: string;
  }[];
}

export type SavedScoreRejection =
  | "unsupported-layout"
  | "unsupported-profile"
  | "invalid-provenance"
  | "resource-limit"
  | "timeline-bytes-changed"
  | "paired-replay-bytes-changed"
  | "replay-provenance-mismatch"
  | "map-provenance-mismatch"
  | "version-mismatch"
  | "non-monotone-row"
  | "invalid-combo"
  | "terminal-mismatch"
  | "hash-unavailable"
  | "cancelled";

export type SavedScoreValidation =
  | { status: "validated"; timeline: SavedScoreTimeline }
  | { status: "rejected"; reason: SavedScoreRejection; row?: number };

export interface SavedScoreValidationOptions {
  maxRows?: number;
  maxReplayBytes?: number;
  isCancelled?: () => boolean;
  /** Use the owning analysis job's scheduler; no independent background job. */
  checkpoint?: () => Promise<void>;
}

const grades: readonly SavedScoreGrade[] = ["GREAT", "OK", "MEH", "MISS"];
const emptyGrades = (): Record<SavedScoreGrade, number> => ({ GREAT: 0, OK: 0, MEH: 0, MISS: 0 });
const reject = (reason: SavedScoreRejection, row?: number): SavedScoreValidation => ({
  status: "rejected",
  reason,
  ...(row === undefined ? {} : { row }),
});
const isHash = (value: string, length: number) =>
  typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);

/**
 * Hashing is injected so Node and the renderer use their existing byte-identity
 * implementation. Both inputs are copied before the first await. No filesystem
 * access, source mutation, simulation override or cache lookup happens here.
 */
export async function validateSavedScoreTimeline(
  timelineBytes: Uint8Array,
  pairedReplayBytes: Uint8Array,
  pairing: SavedScorePairing,
  sha256: (bytes: Uint8Array) => string | Promise<string>,
  options: SavedScoreValidationOptions = {},
): Promise<SavedScoreValidation> {
  if (options.isCancelled?.()) return reject("cancelled");
  if (timelineBytes.byteLength < 8 || (timelineBytes.byteLength - 8) % 29 !== 0) return reject("unsupported-layout");
  const header = new DataView(timelineBytes.buffer, timelineBytes.byteOffset, timelineBytes.byteLength);
  const rowCount = header.getInt32(4, true);
  if (rowCount <= 0 || timelineBytes.byteLength !== 8 + rowCount * 29) return reject("unsupported-layout");
  if (
    rowCount > (options.maxRows ?? 250_000) ||
    pairedReplayBytes.byteLength > (options.maxReplayBytes ?? 64 * 1024 * 1024)
  )
    return reject("resource-limit");
  const paired = { ...pairing.pairedReplay, counts: [...pairing.pairedReplay.counts] as unknown as SavedScoreCounts };
  if (paired.source !== "stable-osr" || paired.mode !== 0) return reject("unsupported-profile");
  const timelineSha256 = pairing.timelineSha256?.toLowerCase();
  const replaySha256 = paired.sha256?.toLowerCase();
  const loadedReplaySha256 = pairing.loadedReplaySha256?.toLowerCase();
  const mapMd5 = paired.mapMd5?.toLowerCase();
  const loadedMapMd5 = pairing.loadedMapMd5?.toLowerCase();
  if (
    !isHash(timelineSha256, 64) ||
    !isHash(replaySha256, 64) ||
    !isHash(loadedReplaySha256, 64) ||
    !isHash(mapMd5, 32) ||
    !isHash(loadedMapMd5, 32) ||
    !Number.isInteger(paired.version) ||
    paired.version <= 0 ||
    paired.counts.length !== 6 ||
    paired.counts.some((n) => !Number.isInteger(n) || n < 0 || n > 65535) ||
    !Number.isInteger(paired.score) ||
    !Number.isInteger(paired.maximumCombo) ||
    paired.maximumCombo < 0 ||
    paired.maximumCombo > 65535
  )
    return reject("invalid-provenance");
  if (loadedReplaySha256 !== replaySha256) return reject("replay-provenance-mismatch");
  if (loadedMapMd5 !== mapMd5) return reject("map-provenance-mismatch");
  if (header.getInt32(0, true) !== paired.version) return reject("version-mismatch");
  // Uint8Array construction also copies Buffer input; Buffer.slice() would alias.
  const bytes = new Uint8Array(timelineBytes);
  const replayBytes = new Uint8Array(pairedReplayBytes);
  try {
    const [timelineDigest, replayDigest] = await Promise.all([sha256(bytes), sha256(replayBytes)]);
    if (timelineDigest.toLowerCase() !== timelineSha256) return reject("timeline-bytes-changed");
    if (replayDigest.toLowerCase() !== replaySha256) return reject("paired-replay-bytes-changed");
  } catch {
    return reject("hash-unavailable");
  }
  if (options.isCancelled?.()) return reject("cancelled");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: SavedScoreRow[] = [];
  const groups: SavedScoreGroup[] = [];
  let previous: SavedScoreCounts = [0, 0, 0, 0, 0, 0];
  let previousTime = -Infinity;
  let previousMaximumCombo = 0;
  let ordinal = 0;
  for (let i = 0; i < rowCount; i++) {
    if (i > 0 && i % 512 === 0) {
      await options.checkpoint?.();
      if (options.isCancelled?.()) return reject("cancelled");
    }
    const at = 8 + i * 29;
    const time = view.getInt32(at, true);
    const counts = Object.freeze(
      Array.from({ length: 6 }, (_, j) => view.getUint16(at + 5 + j * 2, true)),
    ) as unknown as SavedScoreCounts;
    if (time < previousTime || counts.some((n, j) => n < previous[j])) return reject("non-monotone-row", i);
    const maximumCombo = view.getUint16(at + 21, true);
    const combo = view.getUint16(at + 23, true);
    if (maximumCombo < previousMaximumCombo || combo > maximumCombo) return reject("invalid-combo", i);
    const row: SavedScoreRow = Object.freeze({
      time,
      playerByte: view.getUint8(at + 4),
      counts,
      score: view.getInt32(at + 17, true),
      maximumCombo,
      combo,
      trailingBytes: Object.freeze(Array.from(bytes.subarray(at + 25, at + 29))),
    });
    rows.push(row);
    const delta = {
      GREAT: counts[0] - previous[0],
      OK: counts[1] - previous[1],
      MEH: counts[2] - previous[2],
      MISS: counts[5] - previous[5],
    };
    const count = grades.reduce((sum, grade) => sum + delta[grade], 0);
    if (count) {
      groups.push(
        Object.freeze({
          id: `${timelineSha256}:row:${i}`,
          row: i,
          time,
          ordinalStart: ordinal,
          count,
          grades: Object.freeze(delta),
          cumulativeCounts: counts,
        }),
      );
      ordinal += count;
    }
    previous = counts;
    previousTime = time;
    previousMaximumCombo = maximumCombo;
  }
  const terminal = rows[rows.length - 1];
  if (
    terminal.counts.some((n, j) => n !== paired.counts[j]) ||
    terminal.score !== paired.score ||
    terminal.maximumCombo !== paired.maximumCombo
  )
    return reject("terminal-mismatch");
  return {
    status: "validated",
    timeline: Object.freeze({
      schema: "stable-saved-score-v1",
      provenance: Object.freeze({ timelineSha256, pairedReplaySha256: replaySha256, mapMd5, version: paired.version }),
      rows: Object.freeze(rows),
      groups: Object.freeze(groups),
    }),
  };
}

export interface SavedScoreCandidate {
  componentId: string;
  kind: "circle" | "slider-parent" | "spinner";
  /** Inclusive bounds derived independently from map/profile/source timing, never model result. */
  earliestTime: number;
  latestTime: number;
  /** Optional bounds from the exact profile windows for an observed saved grade. */
  gradeTimeRanges?: Partial<Record<SavedScoreGrade, readonly [number, number]>>;
  /** Better-grade windows excluded from a lower timing grade, both ends inclusive. */
  gradeTimeExclusions?: Partial<Record<SavedScoreGrade, readonly [number, number]>>;
  /** Only supply when order is independently constrained; model judgedObjects order is insufficient. */
  ordinalRange?: readonly [number, number];
}

export interface SavedScoreAssociationGroup {
  readonly saved: SavedScoreGroup;
  readonly association: "unique-component" | "unique-component-set" | "ambiguous" | "unmatched";
  readonly componentIds: readonly string[];
}

export interface SavedScoreAssociation {
  readonly status: "complete" | "invalid-candidates" | "resource-limit";
  readonly groups: readonly SavedScoreAssociationGroup[];
}

/**
 * Conservative correspondence: every member must fit one group exclusively,
 * and the group must contain exactly that many members. Ambiguity is retained;
 * grades are deliberately absent from the candidate input to prevent fitting.
 */
export function associateSavedScoreGroups(
  timeline: SavedScoreTimeline,
  candidates: readonly SavedScoreCandidate[],
  limits: { maxAssociations?: number; maxCandidateChecks?: number } = {},
): SavedScoreAssociation {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate.componentId ||
      ids.has(candidate.componentId) ||
      !["circle", "slider-parent", "spinner"].includes(candidate.kind) ||
      !Number.isFinite(candidate.earliestTime) ||
      !Number.isFinite(candidate.latestTime) ||
      candidate.earliestTime > candidate.latestTime ||
      (candidate.gradeTimeRanges &&
        Object.entries(candidate.gradeTimeRanges).some(
          ([grade, range]) =>
            !grades.includes(grade as SavedScoreGrade) ||
            range.length !== 2 ||
            range.some((n) => !Number.isFinite(n)) ||
            range[0] > range[1],
        )) ||
      (candidate.gradeTimeExclusions &&
        Object.entries(candidate.gradeTimeExclusions).some(
          ([grade, range]) =>
            !grades.includes(grade as SavedScoreGrade) ||
            range.length !== 2 ||
            range.some((n) => !Number.isFinite(n)) ||
            range[0] > range[1],
        )) ||
      (candidate.ordinalRange &&
        (candidate.ordinalRange.length !== 2 ||
          candidate.ordinalRange.some((n) => !Number.isInteger(n) || n < 0) ||
          candidate.ordinalRange[0] > candidate.ordinalRange[1]))
    ) {
      return { status: "invalid-candidates", groups: [] };
    }
    ids.add(candidate.componentId);
  }
  const sorted = [...candidates].sort(
    (a, b) => a.earliestTime - b.earliestTime || a.componentId.localeCompare(b.componentId),
  );
  let active: SavedScoreCandidate[] = [];
  const occurrences = new Map<string, number>();
  const matches: string[][] = [];
  const allowedGradeMasks: number[][] = [];
  let next = 0;
  let edges = 0;
  let checks = 0;
  for (const group of timeline.groups) {
    active = active.filter((candidate) => candidate.latestTime >= group.time);
    while (next < sorted.length && sorted[next].earliestTime <= group.time) {
      const candidate = sorted[next++];
      if (candidate.latestTime >= group.time) active.push(candidate);
    }
    const matching: string[] = [];
    const masks: number[] = [];
    for (const candidate of active) {
      if (++checks > (limits.maxCandidateChecks ?? 2_000_000)) return { status: "resource-limit", groups: [] };
      if (
        candidate.ordinalRange &&
        (candidate.ordinalRange[1] < group.ordinalStart ||
          candidate.ordinalRange[0] >= group.ordinalStart + group.count)
      )
        continue;
      const mask = grades.reduce((mask, grade, index) => {
        if (!group.grades[grade]) return mask;
        const range = candidate.gradeTimeRanges?.[grade];
        const exclusion = candidate.gradeTimeExclusions?.[grade];
        if (exclusion && group.time >= exclusion[0] && group.time <= exclusion[1]) return mask;
        return !range || (group.time >= range[0] && group.time <= range[1]) ? mask | (1 << index) : mask;
      }, 0);
      if (!mask) continue;
      if (++edges > (limits.maxAssociations ?? 250_000)) return { status: "resource-limit", groups: [] };
      matching.push(candidate.componentId);
      masks.push(mask);
      occurrences.set(candidate.componentId, (occurrences.get(candidate.componentId) ?? 0) + 1);
    }
    matches.push(matching.sort());
    allowedGradeMasks.push(masks);
  }
  return {
    status: "complete",
    groups: timeline.groups.map((saved, i) => {
      const componentIds = matches[i];
      // Hall's condition on the four grade buckets prevents a group with (say)
      // one 300 and one 50 being assigned to two candidates that can only be 300.
      const feasibleGrades = Array.from({ length: 15 }, (_, i) => i + 1).every((subset) => {
        const needed = allowedGradeMasks[i].filter((mask) => (mask & ~subset) === 0).length;
        const available = grades.reduce(
          (count, grade, index) => count + (subset & (1 << index) ? saved.grades[grade] : 0),
          0,
        );
        return needed <= available;
      });
      const unique =
        componentIds.length === saved.count && componentIds.every((id) => occurrences.get(id) === 1) && feasibleGrades;
      return Object.freeze({
        saved,
        componentIds: Object.freeze(componentIds),
        association: unique
          ? saved.count === 1
            ? "unique-component"
            : "unique-component-set"
          : componentIds.length
          ? "ambiguous"
          : "unmatched",
      });
    }),
  };
}

export interface SavedScoreReconciliationGroup extends SavedScoreAssociationGroup {
  readonly consistency: "corroborated" | "conflict" | "unavailable";
  readonly reconstructedGrades?: SavedGradeCounts;
}

/** Compare only after association; never rewrite simulated state or select an identity by verdict. */
export function reconcileSavedScoreGroups(
  association: SavedScoreAssociation,
  model: readonly { componentId: string; grade: SavedScoreGrade }[],
): {
  status: SavedScoreAssociation["status"];
  groups: readonly SavedScoreReconciliationGroup[];
  conflictingComponentIds: readonly string[];
} {
  const outcomes = new Map<string, SavedScoreGrade>();
  const duplicateIds = new Set<string>();
  for (const outcome of model) {
    if (outcomes.has(outcome.componentId)) duplicateIds.add(outcome.componentId);
    outcomes.set(outcome.componentId, outcome.grade);
  }
  const conflictingComponentIds: string[] = [];
  const groups = association.groups.map((group) => {
    if (
      (group.association !== "unique-component" && group.association !== "unique-component-set") ||
      group.componentIds.some((id) => !grades.includes(outcomes.get(id) as SavedScoreGrade) || duplicateIds.has(id))
    ) {
      return { ...group, consistency: "unavailable" as const };
    }
    const reconstructedGrades = emptyGrades();
    for (const id of group.componentIds) reconstructedGrades[outcomes.get(id) as SavedScoreGrade]++;
    const same = grades.every((grade) => reconstructedGrades[grade] === group.saved.grades[grade]);
    if (!same) conflictingComponentIds.push(...group.componentIds);
    return {
      ...group,
      consistency: same ? ("corroborated" as const) : ("conflict" as const),
      reconstructedGrades: Object.freeze(reconstructedGrades),
    };
  });
  return { status: association.status, groups, conflictingComponentIds: Object.freeze(conflictingComponentIds) };
}
