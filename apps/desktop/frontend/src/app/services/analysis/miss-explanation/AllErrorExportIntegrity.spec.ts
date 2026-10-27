import { buildMissExplanationSession, serializeMissExplanationSession } from "./MissExplanationSession";
import { errorFixture } from "../../../../../../../../libs/osu/core/test/ErrorAnalysisFixtures";
import { traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
function fixture() {
  const f = errorFixture("300,192,1000,1,0", [traceFrame(0, 300), traceFrame(950, 300, [0]), traceFrame(1200, 300)]);
  const state = buildMissExplanationSession(f.trace, f.map);
  if (state.status !== "ready" && state.status !== "partial") throw Error(state.status);
  return { ...state, analysis: JSON.parse(JSON.stringify(state.analysis)) as NonNullable<typeof state.analysis> };
}
it.each(["inventory", "admitted", "excluded"] as const)("rejects incorrect %s counts", (kind) => {
  const state = fixture();
  const counts =
    kind === "inventory"
      ? state.analysis.inventory.counts
      : kind === "admitted"
      ? state.analysis.admittedCounts
      : state.analysis.excludedModelCounts;
  counts.primary++;
  expect(() => serializeMissExplanationSession(state)).toThrow(/count/);
});
it("rejects a conflicting atom still shown as a player incident", () => {
  const state = fixture();
  state.analysis.excludedModelAtomIds.push(state.analysis.inventory.atoms[0].id);
  expect(() => serializeMissExplanationSession(state)).toThrow();
});
it("rejects duplicate incidents and broken classification witnesses", () => {
  const state = fixture();
  state.analysis.incidents.push({ ...state.analysis.incidents[0] });
  expect(() => serializeMissExplanationSession(state)).toThrow(/incident/);
  const another = fixture();
  another.analysis.classifications[0].mechanism.eventIds.push("absent");
  expect(() => serializeMissExplanationSession(another)).toThrow(/classification/);
});
