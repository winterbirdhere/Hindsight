import type { ReplayAnalysisEvent } from "@osujs/core";
import * as grouping from "./incidents";
import * as lookups from "./error-analysis-lookups";
import type { ReplayError } from "./replay-events";

const fixture = (count = 600) => {
  const errors: ReplayError[] = Array.from({ length: count }, (_, index) => ({
    id: `miss:${index}`, time: 1000 + index, type: "MISS", hitObjectId: String(index),
  }));
  const events: ReplayAnalysisEvent[] = errors.map((error, index) => ({
    type: "HitObjectJudgement", hitObjectId: String(index), eventId: `stable:${index}`,
    time: error.time, objectTime: error.time, judgementTime: error.time, ruleset: "stable",
    position: { x: 0, y: 0 }, verdict: "MISS",
    ...(index ? { notelockCause: { kind: "STABLE_BLOCKED_VALID_PRESS" as const, targetHitObjectId: String(index),
      blockerHitObjectId: String(index - 1), pressTime: error.time, cursorDistance: 0, objectRadius: 32, wouldHaveHit: "GREAT" as const } } : {}),
  }));
  return { errors, events };
};

it("provides cooperative canonical grouping and lookup entrypoints", () => {
  expect((grouping as unknown as Record<string, unknown>).groupIncidentsAsync).toEqual(expect.any(Function));
  expect((lookups as unknown as Record<string, unknown>).createErrorAnalysisLookupsAsync).toEqual(expect.any(Function));
});

it("matches canonical ordering, duplicate ambiguity and unlinked error semantics", async () => {
  const { errors, events } = fixture();
  events.push({ ...events[20] });
  const checkpoint = jest.fn(async () => undefined);
  const asyncGroup = grouping.groupIncidentsAsync;
  expect(await asyncGroup(errors, events, "stable", undefined, checkpoint)).toEqual(grouping.groupIncidents(errors, events, "stable"));
  expect(checkpoint.mock.calls.length).toBeGreaterThan(10);
});

it("parks grouping without publishing partial groups or restarting", async () => {
  const { errors, events } = fixture(); let calls = 0, resume!: () => void, entered!: () => void, done = false;
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const asyncGroup = grouping.groupIncidentsAsync;
  const pending = asyncGroup(errors, events, "stable", undefined, async () => { if (++calls === 5) { entered(); await hold; } })
    .then((value: unknown) => { done = true; return value; });
  await ready; expect(done).toBe(false); expect(calls).toBe(5); resume();
  expect(await pending).toEqual(grouping.groupIncidents(errors, events, "stable"));
});

it("propagates original cancellation during a long backward blocker search", async () => {
  const { errors, events } = fixture(800);
  for (const event of events) if (event.type === "HitObjectJudgement" && event.notelockCause) event.notelockCause.blockerHitObjectId = "absent";
  let calls = 0; const cancellation = new Error("cancel inside grouping");
  const asyncGroup = grouping.groupIncidentsAsync;
  await expect(asyncGroup(errors, events, "stable", undefined, async () => { if (++calls === 20) throw cancellation; })).rejects.toBe(cancellation);
  expect(calls).toBe(20);
});
