import { createHash } from "crypto";
import {
  associateSavedScoreGroups,
  reconcileSavedScoreGroups,
  SavedScorePairing,
  validateSavedScoreTimeline,
} from "../src/replays/SavedScoreTimeline";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const replayBytes = Uint8Array.of(1, 2, 3);
const mapMd5 = "1".repeat(32);
type Counts = [number, number, number, number, number, number];
const row = (time: number, counts: Counts, score = 100, maximumCombo = 1, combo = 1) => ({
  time,
  counts,
  score,
  maximumCombo,
  combo,
});

function fixture(rows = [row(1000, [1, 0, 0, 1, 0, 0])]) {
  const bytes = new Uint8Array(8 + rows.length * 29);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 20260711, true);
  view.setInt32(4, rows.length, true);
  rows.forEach((value, i) => {
    const offset = 8 + i * 29;
    view.setInt32(offset, value.time, true);
    value.counts.forEach((n, j) => view.setUint16(offset + 5 + j * 2, n, true));
    view.setInt32(offset + 17, value.score, true);
    view.setUint16(offset + 21, value.maximumCombo, true);
    view.setUint16(offset + 23, value.combo, true);
  });
  const last = rows[rows.length - 1];
  const pairing: SavedScorePairing = {
    timelineSha256: hash(bytes),
    loadedReplaySha256: hash(replayBytes),
    loadedMapMd5: mapMd5,
    pairedReplay: {
      sha256: hash(replayBytes),
      source: "stable-osr",
      mode: 0,
      version: 20260711,
      mapMd5,
      counts: last.counts,
      score: last.score,
      maximumCombo: last.maximumCombo,
    },
  };
  return { bytes, pairing };
}

async function validated(rows?: ReturnType<typeof row>[]) {
  const f = fixture(rows);
  const result = await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, hash);
  if (result.status !== "validated") throw new Error(JSON.stringify(result));
  return result.timeline;
}

describe("paired saved score timeline", () => {
  it("preserves cumulative multi-judgement groups without inventing an internal order", async () => {
    const timeline = await validated([
      row(1000, [1, 0, 0, 1, 0, 0]),
      row(1000, [1, 0, 0, 1, 0, 0], 150, 2, 2),
      row(1020, [2, 0, 1, 1, 1, 0], 300, 3, 3),
    ]);
    expect(timeline.rows).toHaveLength(3);
    expect(timeline.groups).toHaveLength(2);
    expect(timeline.groups[1]).toMatchObject({
      row: 2,
      time: 1020,
      ordinalStart: 1,
      count: 2,
      grades: { GREAT: 1, OK: 0, MEH: 1, MISS: 0 },
    });
    expect(timeline.groups[1]).not.toHaveProperty("objectId");
    expect(timeline.groups[1]).not.toHaveProperty("orderedGrades");
  });

  it.each([
    "timeline-bytes-changed",
    "paired-replay-bytes-changed",
    "replay-provenance-mismatch",
    "map-provenance-mismatch",
    "version-mismatch",
    "terminal-mismatch",
  ] as const)("rejects %s independently of a superficially matching score", async (reason) => {
    const f = fixture();
    let pairedBytes = replayBytes;
    if (reason === "timeline-bytes-changed") f.bytes[12] = 1;
    if (reason === "paired-replay-bytes-changed") pairedBytes = Uint8Array.of(9);
    if (reason === "replay-provenance-mismatch") f.pairing.loadedReplaySha256 = "2".repeat(64);
    if (reason === "map-provenance-mismatch") f.pairing.loadedMapMd5 = "2".repeat(32);
    if (reason === "version-mismatch") f.pairing.pairedReplay.version++;
    if (reason === "terminal-mismatch") f.pairing.pairedReplay.maximumCombo++;
    expect(await validateSavedScoreTimeline(f.bytes, pairedBytes, f.pairing, hash)).toMatchObject({
      status: "rejected",
      reason,
    });
  });

  it.each([
    [row(1000, [1, 0, 0, 0, 0, 0]), row(999, [2, 0, 0, 0, 0, 0])],
    [row(1000, [1, 0, 0, 0, 0, 0]), row(1001, [0, 1, 0, 0, 0, 0])],
    [row(1000, [1, 0, 0, 1, 0, 0]), row(1001, [2, 0, 0, 0, 0, 0])],
  ])("rejects non-monotone time or any of the six counters", async (first, second) => {
    const f = fixture([first, second]);
    expect(await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, hash)).toMatchObject({
      status: "rejected",
      reason: "non-monotone-row",
    });
  });

  it("rejects invalid layout and resource caps before hashing", async () => {
    const f = fixture();
    const digest = jest.fn(hash);
    expect(await validateSavedScoreTimeline(f.bytes.slice(0, -1), replayBytes, f.pairing, digest)).toMatchObject({
      reason: "unsupported-layout",
    });
    expect(await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, digest, { maxRows: 0 })).toMatchObject({
      reason: "resource-limit",
    });
    expect(digest).not.toHaveBeenCalled();
  });

  it("snapshots bytes before awaiting digest so caller mutation cannot alter the parsed rows", async () => {
    const f = fixture();
    const result = validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, async (bytes) => {
      await Promise.resolve();
      return hash(bytes);
    });
    f.bytes.fill(0);
    expect(await result).toMatchObject({ status: "validated", timeline: { groups: [{ time: 1000 }] } });
  });

  it("also owns snapshots of Node Buffer inputs, whose slice method shares storage", async () => {
    const f = fixture();
    const bytes = Buffer.from(f.bytes);
    const paired = Buffer.from(replayBytes);
    const result = validateSavedScoreTimeline(bytes, paired, f.pairing, async (value) => {
      await Promise.resolve();
      return hash(value);
    });
    bytes.fill(0);
    paired.fill(0);
    expect(await result).toMatchObject({ status: "validated", timeline: { groups: [{ time: 1000 }] } });
  });

  it.each([
    // Exact terminal tuples from the three inconsistent local pairs, not altered expected outcomes.
    {
      id: "03eb4416768c3449052cd703cb2c87b6-133497731967201264",
      saved: [175, 6, 0, 51, 6, 1],
      paired: [175, 6, 0, 51, 6, 0],
      savedScore: 1242340,
      pairedScore: 1242340,
      savedCombo: 224,
      pairedCombo: 231,
    },
    {
      id: "2c41c0d2d88e615658ebb05b4f041ed9-134330828105409108",
      saved: [116, 4, 0, 27, 1, 6],
      paired: [121, 5, 0, 29, 2, 0],
      savedScore: 248800,
      pairedScore: 801930,
      savedCombo: 77,
      pairedCombo: 208,
    },
    {
      id: "57a3776cde328a338df8f35d049ec5d1-134330838092779147",
      saved: [166, 12, 0, 43, 8, 6],
      paired: [173, 11, 0, 49, 7, 0],
      savedScore: 339804,
      pairedScore: 1248186,
      savedCombo: 110,
      pairedCombo: 283,
    },
  ])("rejects the recorded inconsistent terminal tuple $id", async (pair) => {
    const f = fixture([row(1000, pair.saved as Counts, pair.savedScore, pair.savedCombo)]);
    Object.assign(f.pairing.pairedReplay, {
      counts: pair.paired,
      score: pair.pairedScore,
      maximumCombo: pair.pairedCombo,
    });
    expect(await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, hash)).toMatchObject({
      reason: "terminal-mismatch",
    });
  });

  it("honours cancellation after hash and between row batches without publishing partial validation", async () => {
    const f = fixture();
    let cancelled = false;
    const afterHash = validateSavedScoreTimeline(
      f.bytes,
      replayBytes,
      f.pairing,
      async (bytes) => {
        cancelled = true;
        return hash(bytes);
      },
      { isCancelled: () => cancelled },
    );
    expect(await afterHash).toMatchObject({ reason: "cancelled" });
    const larger = fixture(Array.from({ length: 1025 }, (_, i) => row(i, [i + 1, 0, 0, 0, 0, 0])));
    cancelled = false;
    const checkpoint = jest.fn(async () => {
      cancelled = true;
    });
    expect(
      await validateSavedScoreTimeline(larger.bytes, replayBytes, larger.pairing, hash, {
        checkpoint,
        isCancelled: () => cancelled,
      }),
    ).toMatchObject({ reason: "cancelled" });
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it("does not admit native or other-mode metadata as this locally validated Stable layout", async () => {
    const f = fixture();
    f.pairing.pairedReplay.source = "native-osr";
    expect(await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, hash)).toMatchObject({
      reason: "unsupported-profile",
    });
    f.pairing.pairedReplay.source = "stable-osr";
    f.pairing.pairedReplay.mode = 1;
    expect(await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, hash)).toMatchObject({
      reason: "unsupported-profile",
    });
  });

  it("treats hash failure as unavailable corroboration", async () => {
    const f = fixture();
    expect(
      await validateSavedScoreTimeline(f.bytes, replayBytes, f.pairing, () => {
        throw new Error("read failure");
      }),
    ).toMatchObject({ reason: "hash-unavailable" });
  });
});

describe("saved outcome association, separate from reconstructed verdicts", () => {
  const candidate = (componentId: string, earliestTime = 950, latestTime = 1050) => ({
    componentId,
    kind: "circle" as const,
    earliestTime,
    latestTime,
  });

  it("corroborates or disproves an independently unique component without altering simulation", async () => {
    const timeline = await validated();
    const association = associateSavedScoreGroups(timeline, [candidate("circle:3")]);
    expect(association.status).toBe("complete");
    expect(association.groups[0]).toMatchObject({ association: "unique-component", componentIds: ["circle:3"] });
    const model = [{ componentId: "circle:3", grade: "MISS" as const }];
    expect(reconcileSavedScoreGroups(association, model).groups[0]).toMatchObject({ consistency: "conflict" });
    expect(model).toEqual([{ componentId: "circle:3", grade: "MISS" }]);
    expect(
      reconcileSavedScoreGroups(association, [{ componentId: "circle:3", grade: "GREAT" }]).groups[0],
    ).toMatchObject({ consistency: "corroborated" });
  });

  it("keeps overlapping candidates ambiguous even if one model grade happens to match", async () => {
    const association = associateSavedScoreGroups(await validated(), [candidate("a"), candidate("b")]);
    expect(association.groups[0].association).toBe("ambiguous");
    expect(
      reconcileSavedScoreGroups(association, [
        { componentId: "a", grade: "GREAT" },
        { componentId: "b", grade: "MISS" },
      ]).groups[0].consistency,
    ).toBe("unavailable");
  });

  it("can use independent profile grade windows for the observed saved grade, without a model verdict", async () => {
    const association = associateSavedScoreGroups(await validated(), [
      { ...candidate("a", 600, 1400), gradeTimeRanges: { GREAT: [980, 1020] } },
      { ...candidate("b", 700, 1500), gradeTimeRanges: { GREAT: [1080, 1120] } },
    ]);
    expect(association.groups[0]).toMatchObject({ association: "unique-component", componentIds: ["a"] });
  });

  it("does not attribute a lower saved grade inside that candidate's better-grade window", async () => {
    const timeline = await validated([row(1000, [0, 1, 0, 0, 0, 0])]);
    const association = associateSavedScoreGroups(timeline, [
      { ...candidate("a"), gradeTimeRanges: { OK: [901, 1099] }, gradeTimeExclusions: { OK: [951, 1049] } },
    ]);
    expect(association.groups[0].association).toBe("unmatched");
  });

  it("does not map a singleton when the same candidate can belong to another group", async () => {
    const timeline = await validated([row(1000, [1, 0, 0, 0, 0, 0]), row(1010, [2, 0, 0, 0, 0, 0])]);
    expect(associateSavedScoreGroups(timeline, [candidate("a")]).groups.map((g) => g.association)).toEqual([
      "ambiguous",
      "ambiguous",
    ]);
  });

  it("retains a uniquely constrained component set as a group, not invented per-object grades", async () => {
    const timeline = await validated([row(1000, [1, 0, 1, 0, 0, 0])]);
    const association = associateSavedScoreGroups(timeline, [
      candidate("a"),
      { ...candidate("b"), kind: "slider-parent" },
    ]);
    expect(association.groups[0]).toMatchObject({ association: "unique-component-set", componentIds: ["a", "b"] });
    expect(
      reconcileSavedScoreGroups(association, [
        { componentId: "a", grade: "MEH" },
        { componentId: "b", grade: "GREAT" },
      ]).groups[0].consistency,
    ).toBe("corroborated");
    expect(
      reconcileSavedScoreGroups(association, [
        { componentId: "a", grade: "MISS" },
        { componentId: "b", grade: "GREAT" },
      ]).groups[0].consistency,
    ).toBe("conflict");
  });

  it("does not invent a component-set correspondence when its independent grade windows cannot fill the group", async () => {
    const timeline = await validated([row(1000, [1, 0, 1, 0, 0, 0])]);
    const association = associateSavedScoreGroups(timeline, [
      { ...candidate("a"), gradeTimeRanges: { GREAT: [990, 1010], MEH: [2000, 2100] } },
      { ...candidate("b"), gradeTimeRanges: { GREAT: [990, 1010], MEH: [2000, 2100] } },
    ]);
    expect(association.groups[0].association).toBe("ambiguous");
  });

  it("uses independently proven order ranges, never the model verdict, to narrow same-time candidates", async () => {
    const timeline = await validated([row(1000, [1, 0, 0, 0, 0, 0]), row(1000, [1, 1, 0, 0, 0, 0])]);
    const association = associateSavedScoreGroups(timeline, [
      { ...candidate("first"), ordinalRange: [0, 0] },
      { ...candidate("second"), ordinalRange: [1, 1] },
    ]);
    expect(association.groups.map((g) => g.componentIds)).toEqual([["first"], ["second"]]);
  });

  it("rejects duplicate or invalid candidate identities and keeps resource exhaustion explicit", async () => {
    const timeline = await validated();
    expect(associateSavedScoreGroups(timeline, [candidate("a"), candidate("a")]).status).toBe("invalid-candidates");
    expect(associateSavedScoreGroups(timeline, [candidate("a", 2000, 1000)]).status).toBe("invalid-candidates");
    expect(associateSavedScoreGroups(timeline, [candidate("a"), candidate("b")], { maxAssociations: 1 }).status).toBe(
      "resource-limit",
    );
  });
});
