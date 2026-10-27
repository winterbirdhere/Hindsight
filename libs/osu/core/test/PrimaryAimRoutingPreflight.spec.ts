import { collectCanonicalControls, certifyCanonicalControl } from "../src/gameplay/error-analysis/CanonicalReplayVerifier";
import { inspectPrimaryOpportunity } from "../src/gameplay/error-analysis/PrimaryOpportunity";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function fixture(earlier = "100,192,950,1,0", target = "300,192,1000,1,0") {
  return errorFixture(`${earlier}\n${target}`, [traceFrame(700, 0), traceFrame(1000, 0, [0]),
    traceFrame(1010, 0), traceFrame(1300, 0)]);
}
function request(f: ReturnType<typeof fixture>, id = "1") {
  const e = deriveCircleEvidence(f.trace, f.map, id),
    q = e.inputs.find(i => i.record.timeMs === 1000)!.record;
  return collectCanonicalControls(f.map, f.trace, () => inspectPrimaryOpportunity(
    e, f.map, f.trace, q.id, [q.id], "same-time-aim", [q.id]));
}
describe("same-time aim controls with an unchanged pending-circle prefix", () => {
  it.each([100, 300])("does not simulate an impossible repair with earlier circle at x=%s", x => {
    const f = fixture(`${x},192,950,1,0`), q = f.trace.records.find(r => r.kind === "input" && r.timeMs === 1000)!;
    // Independent full control confirms failure both when target centering would
    // select the unrelated neighbour and when the neighbour blocks the target.
    expect(certifyCanonicalControl(f.map, f.trace, { targetId: "1", relatedComponentIds: ["1"],
      changes: [{ inputId: q.id, position: { x: 300, y: 192 } }] })).toBeUndefined();
    const fresh = fixture(`${x},192,950,1,0`), result = request(fresh);
    expect(result.value.proof).toBeUndefined();
    expect(result.value.refusals).toContainEqual({ stage: "canonical", reason: "canonical-control-not-certified" });
    expect(result.queue).toHaveLength(0);
  });
  it("also refuses an expired-but-unresolved circle and a target slider head", () => {
    for (const [earlier, target, id] of [
      ["100,192,800,1,0", "300,192,1000,1,0", "1"],
      ["100,192,950,1,0", "300,192,1000,2,0,L|400:192,1,100", "1/HEAD"],
    ]) expect(request(fixture(earlier, target), id).queue).toHaveLength(0);
  });
  it("preserves the strict 3 ms exception", () => {
    const f = fixture("100,192,997,1,0"), result = request(f);
    expect(result.queue).toHaveLength(1);
    const q = f.trace.records.find(r => r.kind === "input" && r.timeMs === 1000)!;
    expect(certifyCanonicalControl(f.map, f.trace, { targetId: "1", relatedComponentIds: ["1"],
      changes: [{ inputId: q.id, position: { x: 300, y: 192 } }] })?.outcomes[0].after.type).toBe("GREAT");
  });
  it("permits a resolved earlier circle", () => {
    const f = errorFixture("100,192,950,1,0\n300,192,1000,1,0", [traceFrame(700, 0),
      traceFrame(950, 100, [0]), traceFrame(960, 0), traceFrame(1000, 0, [0]), traceFrame(1010, 0), traceFrame(1300, 0)]);
    expect(request(f).value.proof).toBeDefined();
  });
  it.each(["activation", "terminal"])("falls through when the earlier %s is unavailable", kind => {
    const f = fixture();
    f.trace = JSON.parse(JSON.stringify(f.trace));
    const record = f.trace.records.find(r => r.kind === (kind === "activation" ? "lifecycle" : "resolution") && r.componentId === "0")!;
    Object.assign(record, { componentId: "unrelated" });
    expect(request(f).queue).toHaveLength(1);
  });
  it("leaves prefix slider analysis to the existing verifier", () => {
    expect(request(fixture("100,192,950,2,0,L|200:192,1,100")).queue).toHaveLength(1);
  });
});
