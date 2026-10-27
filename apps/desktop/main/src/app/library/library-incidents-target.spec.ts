import type { LibraryMetricTargetInput } from "../../../../shared/replay-library-metrics";
import { LIBRARY_INCIDENT_DEPENDENCIES, LIBRARY_INCIDENT_TRACE_LIMITS, LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION,
  LibraryIncidentEvidenceReceipt, LibraryIncidentDependencies } from "../../../../shared/library-incidents";
import * as target from "./library-incidents-target";
import { libraryTimelineTarget } from "./library-timeline-target";
import { libraryFcTarget } from "./library-fc-target";
import { execFileSync } from "child_process";
import { resolve } from "path";

it("checks the generated C semantic and independent query algorithm source closures",()=>{
  const workspace=resolve(__dirname,"../../../../../..");
  const result=execFileSync(process.execPath,[resolve(workspace,"tools/library/incident-semantic-identity.cjs")],{cwd:workspace,encoding:"utf8",timeout:30000});
  expect(JSON.parse(result)).toMatchObject({mode:"check",digest:LIBRARY_INCIDENT_DEPENDENCIES.model});
},35000);

const numerical: LibraryMetricTargetInput = { replayId: "replay", slot: "numerical", stage: "S", inputKey: "a".repeat(64), producerVersion: "library-numeric-v2" };
const absent: LibraryIncidentEvidenceReceipt = { version: 1, state: "absent", replaySha256: "b".repeat(64), mapMd5: "c".repeat(32),
  validationVersion: LIBRARY_INCIDENT_EVIDENCE_VALIDATION_VERSION };
it("qualifies query witnesses with every C dependency and both trace limits",()=>{
  const current=target.libraryIncidentDependencyRevision();
  for(const field of Object.keys(LIBRARY_INCIDENT_DEPENDENCIES))expect(target.libraryIncidentDependencyRevision({...LIBRARY_INCIDENT_DEPENDENCIES,[field]:"next"})).not.toBe(current);
  for(const field of Object.keys(LIBRARY_INCIDENT_TRACE_LIMITS))expect(target.libraryIncidentDependencyRevision(undefined,{...LIBRARY_INCIDENT_TRACE_LIMITS,[field]:1})).not.toBe(current);
  expect(target.libraryIncidentDependencyRevision(Object.fromEntries(Object.entries(LIBRARY_INCIDENT_DEPENDENCIES).reverse()) as unknown as LibraryIncidentDependencies)).toBe(current);
});
const validated: LibraryIncidentEvidenceReceipt = { ...absent, state: "validated", schema: "stable-saved-score-v1",
  pairedReplaySha256: absent.replaySha256, timelineSha256: "d".repeat(64), sourceVersion: 20200101 };
type Target = (numerical: LibraryMetricTargetInput, receipt: LibraryIncidentEvidenceReceipt,
  versions?: Readonly<LibraryIncidentDependencies>, limits?: { maxRecords: number; maxExportBytes: number }) => LibraryMetricTargetInput;
const derive: Target = (...args) => (target as unknown as { libraryIncidentTarget: Target }).libraryIncidentTarget(...args);

it("provides the separate C target entrypoint", () => {
  expect((target as unknown as Record<string, unknown>).libraryIncidentTarget).toEqual(expect.any(Function));
});
it("invalidates C for absent→validated→changed→removed evidence while preserving numerical, timeline and FC keys", () => {
  const before = JSON.stringify(numerical), timeline = libraryTimelineTarget(numerical), fc = libraryFcTarget(numerical);
  const initial = derive(numerical, absent), loaded = derive(numerical, validated);
  expect(loaded.inputKey).not.toBe(initial.inputKey);
  expect(derive(numerical, { ...validated, timelineSha256: "e".repeat(64) }).inputKey).not.toBe(loaded.inputKey);
  expect(derive(numerical, absent)).toEqual(initial);
  expect(JSON.stringify(numerical)).toBe(before); expect(libraryTimelineTarget(numerical)).toEqual(timeline); expect(libraryFcTarget(numerical)).toEqual(fc);
  expect(initial).toMatchObject({ replayId: numerical.replayId, slot: "incidents", stage: "C", producerVersion: LIBRARY_INCIDENT_DEPENDENCIES.projection });
});
it("keys independent evidence availability and validation/source versions", () => {
  expect(new Set(["absent", "rejected", "unavailable"].map(state => derive(numerical, { ...absent, state } as LibraryIncidentEvidenceReceipt).inputKey)).size).toBe(3);
  const current = derive(numerical, validated).inputKey;
  expect(derive(numerical, { ...validated, validationVersion: "library-saved-evidence-v2" }).inputKey).not.toBe(current);
  expect(derive(numerical, { ...validated, sourceVersion: 20200102 }).inputKey).not.toBe(current);
});
it("canonicalizes property order and keys every C dependency and trace limit independently", () => {
  const current = derive(numerical, validated);
  expect(derive({ ...numerical }, Object.fromEntries(Object.entries(validated).reverse()) as LibraryIncidentEvidenceReceipt)).toEqual(current);
  for (const field of Object.keys(LIBRARY_INCIDENT_DEPENDENCIES)) {
    expect(derive(numerical, validated, { ...LIBRARY_INCIDENT_DEPENDENCIES, [field]: "updated-v2" }).inputKey).not.toBe(current.inputKey);
  }
  expect(derive(numerical, validated, undefined, { ...LIBRARY_INCIDENT_TRACE_LIMITS, maxRecords: 200001 }).inputKey).not.toBe(current.inputKey);
  expect(derive(numerical, validated, undefined, { ...LIBRARY_INCIDENT_TRACE_LIMITS, maxExportBytes: 64000 }).inputKey).not.toBe(current.inputKey);
  expect(derive({ ...numerical, producerVersion: "library-numeric-next" }, validated).inputKey).not.toBe(current.inputKey);
  expect(derive({ ...numerical, inputKey: "e".repeat(64) }, validated).inputKey).not.toBe(current.inputKey);
});
it("rejects invalid source targets, dependency descriptors, bounds and unvalidated receipts", () => {
  for (const invalid of [{ ...numerical, slot: "incidents" }, { ...numerical, stage: "C" }, { ...numerical, inputKey: "bad" },
    { ...numerical, producerVersion: "" }, { ...numerical, replayId: "" }]) expect(() => derive(invalid as LibraryMetricTargetInput, absent)).toThrow();
  expect(() => derive(numerical, { ...validated, pairedReplaySha256: "f".repeat(64) })).toThrow();
  expect(() => derive(numerical, absent, { ...LIBRARY_INCIDENT_DEPENDENCIES, model: "" })).toThrow();
  expect(() => derive(numerical, absent, undefined, { maxRecords: -1, maxExportBytes: 1000 })).toThrow();
  expect(() => derive(numerical, absent, undefined, { maxRecords: 1000, maxExportBytes: Infinity })).toThrow();
});
