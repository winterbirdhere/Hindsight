import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import * as canonical from "../src/gameplay/error-analysis/CanonicalReplayVerifier";
import * as evidence from "../src/gameplay/miss-explanation/CircleEvidence";
import { activation, evidenceMap, evidenceTrace, expiry, input } from "./CircleEvidenceFixtures";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

describe("bounded evidence reuse within error analysis", () => {
  it("extracts completed evidence once for repeated ordinary and chain-root requests", () => {
    const f = errorFixture("100,192,1000,1,0\n100,192,1100,1,0", [
      traceFrame(800, 160), traceFrame(940, 160, [0]), traceFrame(945, 160),
      traceFrame(990, 100), traceFrame(1000, 100), traceFrame(1080, 100, [1]),
      traceFrame(1085, 100), traceFrame(1300, 100),
    ]);
    const actual = evidence.deriveCircleEvidence, seen = new Map<string, evidence.CircleEvidence[]>();
    const spy = jest.spyOn(evidence, "deriveCircleEvidence").mockImplementation((trace, map, id) => {
      const value = actual(trace, map, id);
      if (trace === f.trace && map === f.map) seen.set(id, [...(seen.get(id) ?? []), value]);
      return value;
    });
    try {
      const result = buildErrorAnalysis(f.trace, f.map);
      expect(result.incidents.find(i => i.componentId === "1")?.mechanism.chain?.start.timeMs).toBe(940);
      expect(seen.get("0")!.length).toBeGreaterThan(1);
      expect(new Set(seen.get("0")).size).toBe(1);
      expect(actual(f.trace, f.map, "0")).not.toBe(seen.get("0")![0]);
    } finally {
      spy.mockRestore();
    }
  });

  const simple = () => ({
    trace: evidenceTrace([activation(), input(900, 300), input(1100, 300), expiry()]),
    map: evidenceMap(),
  });

  it("isolates suspended and nested workers, exact input identities and public calls", () => {
    const f = simple(), other = simple();
    function* readTwice() {
      yield evidence.deriveCircleEvidence(f.trace, f.map, "0");
      yield evidence.deriveCircleEvidence(f.trace, f.map, "0");
    }
    const a = evidence.reuseCircleEvidence(f.trace, f.map, readTwice());
    const b = evidence.reuseCircleEvidence(f.trace, f.map, readTwice());
    const first = a.next().value, second = b.next().value;
    expect(first).not.toBe(second);
    expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).not.toBe(first);
    expect(a.next().value).toBe(first);
    expect(b.next().value).toBe(second);
    a.return(); b.return();
    let outer: evidence.CircleEvidence | undefined;
    const nested = evidence.reuseCircleEvidence(f.trace, f.map, (function* () {
      outer = evidence.deriveCircleEvidence(f.trace, f.map, "0");
      const inner = evidence.reuseCircleEvidence(f.trace, f.map, readTwice());
      expect(inner.next().value).not.toBe(outer);
      inner.return();
      expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).toBe(outer);
      for (const [trace, map] of [[other.trace, f.map], [f.trace, other.map]] as const)
        expect(evidence.deriveCircleEvidence(trace, map, "0")).not.toBe(evidence.deriveCircleEvidence(trace, map, "0"));
      yield outer;
    })());
    nested.next(); nested.return();
    expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).not.toBe(outer);
  });

  it("evicts the least recently used target without changing extracted facts", () => {
    const f = simple();
    const work = evidence.reuseCircleEvidence(f.trace, f.map, (function* () {
      const first = Array.from({ length: 128 }, (_, i) => evidence.deriveCircleEvidence(f.trace, f.map, String(i)));
      expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).toBe(first[0]);
      evidence.deriveCircleEvidence(f.trace, f.map, "128");
      expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).toBe(first[0]);
      const evicted = evidence.deriveCircleEvidence(f.trace, f.map, "1");
      expect(evicted).not.toBe(first[1]);
      expect(evicted).toEqual(first[1]);
      yield;
    })());
    work.next(); work.return();
  });

  it("forwards injected errors and return cleanup, restoring scope after failure", () => {
    const f = simple(), error = new Error("caller cancellation");
    let first: evidence.CircleEvidence | undefined, cleaned = 0;
    function* worker() {
      first = evidence.deriveCircleEvidence(f.trace, f.map, "0");
      try { yield first; }
      finally {
        expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).toBe(first);
        cleaned++;
      }
    }
    const thrown = evidence.reuseCircleEvidence(f.trace, f.map, worker());
    thrown.next();
    expect(() => thrown.throw(error)).toThrow(error);
    expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).not.toBe(first);
    const returned = evidence.reuseCircleEvidence(f.trace, f.map, worker());
    returned.next(); returned.return();
    expect(cleaned).toBe(2);
    expect(evidence.deriveCircleEvidence(f.trace, f.map, "0")).not.toBe(first);
  });

  it("cancels at a canonical-control yield without changing a subsequent analysis", () => {
    const frames = Array.from({ length: 1201 }, (_, k) => traceFrame(k, 100, k === 1000 ? [0] : []));
    const f = errorFixture("300,192,1000,1,0", frames), pristine = JSON.stringify(f.trace);
    const press = f.trace.records.find(r => r.kind === "input" && r.timeMs === 1000)!;
    const plan = { targetId: "0", relatedComponentIds: ["0"], changes: [{ inputId: press.id, position: { x: 300, y: 192 } }] };
    const work = evidence.reuseCircleEvidence(f.trace, f.map, (function* () {
      evidence.deriveCircleEvidence(f.trace, f.map, "0");
      const pending = canonical.collectCanonicalControls(f.map, f.trace, () => canonical.certifyCanonicalControl(f.map, f.trace, plan));
      expect(pending.queue).toHaveLength(1);
      yield* canonical.completeCanonicalControls(f.map, f.trace, pending.queue);
    })());
    expect(work.next().done).toBe(false);
    work.return();
    expect(canonical.certifyCanonicalControl(f.map, f.trace, plan)?.outcomes[0].after.type).toBe("GREAT");
    expect(buildErrorAnalysis(f.trace, f.map)).toEqual(buildErrorAnalysis(JSON.parse(pristine), f.map));
    expect(JSON.stringify(f.trace)).toBe(pristine);
  });
});
