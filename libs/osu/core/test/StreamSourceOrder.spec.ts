import { deriveStreamInputEvidence } from "../src/gameplay/error-analysis/StreamInputEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

function orderedContact(contactOrder: "before" | "after") {
  const taps = [1035, 1115, 1195, 1275];
  const times = [
    ...new Set([...Array.from({ length: 90 }, (_, index) => 800 + 8 * index), ...taps, ...taps.map((tap) => tap + 25)]),
  ].sort((a, b) => a - b);
  const frames: ReturnType<typeof traceFrame>[] = [];
  for (const time of times) {
    const x = time < 1080 ? 100 : time < 1160 ? 150 : time <= 1275 ? 200 : 400;
    const actions = taps.flatMap((tap, index) => (time >= tap && time < tap + 25 ? [index % 2] : []));
    if (time === 1275 && contactOrder === "before") frames.push(traceFrame(time, 400));
    frames.push(traceFrame(time, x, actions));
    if (time === 1275 && contactOrder === "after") frames.push(traceFrame(time, 400, actions));
  }
  const fixture = errorFixture("100,192,1000,1,0\n150,192,1080,1,0\n200,192,1160,1,0\n400,192,1240,1,0", frames);
  const evidence = deriveCircleEvidence(fixture.trace, fixture.map, "3");
  const press = evidence.inputs.find((input) => input.record.timeMs === 1275 && input.record.freshActions.length);
  const contact = evidence.inputs.find((input) => input.record.timeMs === 1275 && input.inside);
  if (!press || !contact) throw new Error("Missing ordered raw fixture witnesses");
  const result = deriveStreamInputEvidence(evidence, fixture.map, fixture.trace);
  return { fixture, evidence, press, contact, result };
}

describe("stream ownership respects equal-time input sequence", () => {
  it("does not corroborate an earlier tap using a later same-time cursor contact", () => {
    const { fixture, evidence, press, contact, result } = orderedContact("after");
    expect(fixture.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(press.record.sequence).toBeLessThan(contact.record.sequence);
    expect(press.inside).toBe(false);
    expect(contact.record.freshActions).toEqual([]);
    const priorSamples = evidence.inputs.filter(
      (input) => input.record.timeMs >= 1160 && input.record.sequence <= press.record.sequence,
    );
    expect(priorSamples.length).toBeGreaterThan(3);
    expect(priorSamples.every((input) => input.record.position.x === 200)).toBe(true);

    // The only near-target sample is ordered after the fresh action. It cannot
    // turn a >5-radius pre-press path into a corroborated stream ownership.
    expect(result.status).toBe("ambiguous");
    expect(result.relevantInputIds).not.toContain(press.record.id);
    expect(result.assignments).not.toContainEqual(
      expect.objectContaining({
        componentId: "3",
        inputId: press.record.id,
        relation: "matched",
        confidence: "corroborated",
      }),
    );
    expect(result.missingTargetTap).toBe(false);
  });

  it("retains a contact ordered before the press even when their timestamps match", () => {
    const { fixture, press, contact, result } = orderedContact("before");
    expect(fixture.state.hitCircleVerdict["3"].type).toBe("MISS");
    expect(contact.record.sequence).toBeLessThan(press.record.sequence);
    expect(contact.record.freshActions).toEqual([]);
    expect(result.status).toBe("supported");
    const assignment = result.assignments.find((row) => row.componentId === "3" && row.inputId === press.record.id);
    expect(assignment).toMatchObject({ relation: "matched", confidence: "corroborated" });
    expect(assignment?.geometry?.minimumSampledR).toBe(0);
    expect(assignment?.geometry?.eventIds).toContain(contact.record.id);
  });
});
