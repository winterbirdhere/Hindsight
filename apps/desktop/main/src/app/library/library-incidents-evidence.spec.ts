import type { SavedScoreSourceResult, SavedScoreTimeline } from "../../../../../../libs/osu/core/src/replays/SavedScoreTimeline";
import * as receipts from "../../../../shared/library-incidents";
import * as evidence from "./library-incidents-evidence";

const binding = { replaySha256: "a".repeat(64), mapMd5: "b".repeat(32) };
const timeline: SavedScoreTimeline = { schema: "stable-saved-score-v1", provenance: {
  timelineSha256: "c".repeat(64), pairedReplaySha256: binding.replaySha256, mapMd5: binding.mapMd5, version: 20200101,
}, rows: [], groups: [] };
type Project = (source: SavedScoreSourceResult | undefined, bound: typeof binding) => receipts.LibraryIncidentEvidenceReceipt;
const project: Project = (...args) => (evidence as unknown as { projectLibraryIncidentEvidence: Project }).projectLibraryIncidentEvidence(...args);
type Validate = (value: unknown, bound?: typeof binding) => void;
const validate: Validate = (...args) => (receipts as unknown as { validateLibraryIncidentEvidence: Validate }).validateLibraryIncidentEvidence(...args);

it("provides strict receipt projection and validation entrypoints", () => {
  expect((evidence as unknown as Record<string, unknown>).projectLibraryIncidentEvidence).toEqual(expect.any(Function));
  expect((receipts as unknown as Record<string, unknown>).validateLibraryIncidentEvidence).toEqual(expect.any(Function));
});
it("distinguishes absent, rejected, unavailable and not-yet-loaded evidence", () => {
  for (const state of ["absent", "rejected", "unavailable"] as const) {
    expect(project({ status: state, attempts: [], reason: "never persist this path: D:/private/file.osg" }, binding)).toEqual({
      version: 1, state, ...binding, validationVersion: receipts.LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION,
    });
  }
  expect(project(undefined, binding).state).toBe("unavailable");
});
it("projects only loaded validated identities without inspecting rows, paths, attempts or causes", () => {
  const loaded = { ...timeline };
  Object.defineProperty(loaded, "rows", { get: () => { throw new Error("Rows must not be traversed"); } });
  Object.defineProperty(loaded, "groups", { get: () => { throw new Error("Groups must not be traversed"); } });
  const source = { status: "validated" as const, timeline: loaded, attempts: [] };
  Object.defineProperty(source, "attempts", { get: () => { throw new Error("Paths must not be inspected"); } });
  const result = project(source, binding);
  expect(result).toEqual({ version: 1, state: "validated", ...binding,
    validationVersion: receipts.LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION, schema: timeline.schema,
    timelineSha256: timeline.provenance.timelineSha256, pairedReplaySha256: binding.replaySha256, sourceVersion: 20200101 });
  expect(JSON.stringify(result).length).toBeLessThan(1024);
  expect(() => validate(result, binding)).not.toThrow();
});
it("rejects missing, contradictory or malformed validated source provenance", () => {
  const source = { status: "validated" as const, timeline, attempts: [] };
  for (const invalid of [undefined, { ...timeline, schema: "other" },
    ...[{ pairedReplaySha256: "d".repeat(64) }, { mapMd5: "e".repeat(32) }, { timelineSha256: "bad" }, { version: 0 }]
      .map(change => ({ ...timeline, provenance: { ...timeline.provenance, ...change } }))]) {
    expect(() => project({ ...source, timeline: invalid } as SavedScoreSourceResult, binding)).toThrow();
  }
  expect(() => project({ status: "absent", timeline, attempts: [] }, binding)).toThrow();
  expect(() => project(source, { ...binding, mapMd5: "bad" })).toThrow();
});
it("rejects noncanonical receipts, extra payloads, accessors and pairing mismatches", () => {
  const valid = project({ status: "validated", timeline, attempts: [] }, binding);
  const accessor = { ...valid };
  Object.defineProperty(accessor, "timelineSha256", { get: () => { throw new Error("accessor invoked"); } });
  for (const invalid of [null, [], { ...valid, version: 2 }, { ...valid, state: "pending" }, { ...valid, causes: [] },
    { ...valid, rows: [] }, { ...valid, path: "D:/test.osg" }, { ...valid, validationVersion: "x".repeat(129) },
    { ...valid, pairedReplaySha256: "e".repeat(64) }, { ...valid, timelineSha256: "C".repeat(64) },
    { ...valid, sourceVersion: Infinity }, Object.assign(Object.create({ inherited: true }), valid), accessor]) expect(() => validate(invalid)).toThrow();
  expect(() => validate(valid, { ...binding, replaySha256: "e".repeat(64) })).toThrow();
  expect(() => validate(valid, { ...binding, mapMd5: "e".repeat(32) })).toThrow();
});
it("rejects coercible state objects without invoking caller code", () => {
  const state = { toString: jest.fn(() => "absent") };
  const receipt = { version: 1, state, ...binding, validationVersion: receipts.LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION };
  expect(() => validate(receipt)).toThrow();
  expect(state.toString).not.toHaveBeenCalled();
});
