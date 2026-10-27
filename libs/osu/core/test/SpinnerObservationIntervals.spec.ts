import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame, normalizeTraceState } from "./ReplayTraceFixtures";
import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
const spinFrame = (time: number, held: boolean, angle: number) => ({
  ...traceFrame(time, 256 + 100 * Math.cos(angle), held ? [0] : []),
  position: { x: 256 + 100 * Math.cos(angle), y: 192 + 100 * Math.sin(angle) },
});
describe("recorded spinner engagement intervals", () => {
  it.each(["stable", "lazer"] as const)(
    "%s does not infer no hold from a recording starting inside the spinner",
    (profile) => {
      const f = errorFixture("256,192,1000,8,0,3000", [spinFrame(1700, false, 0), spinFrame(3100, false, 0)], profile);
      const analysis = buildErrorAnalysis(f.trace, f.map);
      expect(analysis.classifications[0].mechanism).toMatchObject({
        status: "unavailable",
        codes: [],
        limitations: ["incomplete-spinner-input"],
      });
    },
  );
  it.each(["stable", "lazer"] as const)(
    "%s clips hold duration to the exact source press and spinner boundaries",
    (profile) => {
      const frames = [
        spinFrame(900, false, 0),
        ...Array.from({ length: 26 }, (_, i) => spinFrame(1700 + i * 50, true, i * 0.3)),
        spinFrame(3100, false, 7.8),
      ];
      const f = errorFixture("256,192,1000,8,0,3000", frames, profile);
      const record = f.trace.records.find((r) => r.kind === "spinner-resolution");
      if (record?.kind !== "spinner-resolution") throw Error("missing spinner");
      expect(record.summary.observedDurationMs).toBe(2000);
      expect(record.summary.heldDurationMs).toBe(1300);
      expect(record.summary.leadingIdleMs).toBeGreaterThanOrEqual(700);
      expect(buildErrorAnalysis(f.trace, f.map).incidents[0].mechanism.codes).toContain("started-late");
      const off =
        profile === "stable"
          ? new BucketedGameStateTimeMachine(frames, f.map, { noteLockStyle: "STABLE", hitWindowStyle: "OSU_STABLE" })
          : new LazerGameStateTimeMachine(frames, f.map);
      expect(normalizeTraceState(f.state)).toEqual(normalizeTraceState(off.gameStateAt(Infinity)));
    },
  );
  it.each(["stable", "lazer"] as const)(
    "%s names a witnessed middle release rather than blaming continuous speed",
    (profile) => {
      const frames = [
        spinFrame(900, false, 0),
        ...Array.from({ length: 41 }, (_, i) => {
          const t = 1000 + i * 50;
          return spinFrame(t, t < 1300 || t >= 2700, i * 0.3);
        }),
        spinFrame(3100, false, 12),
      ];
      const f = errorFixture("256,192,1000,8,0,3000", frames, profile);
      const record = f.trace.records.find((r) => r.kind === "spinner-resolution");
      if (record?.kind !== "spinner-resolution") throw Error("missing spinner");
      expect(record.result).not.toBe("GREAT");
      expect(record.summary.heldDurationMs).toBe(600);
      expect(buildErrorAnalysis(f.trace, f.map).incidents[0].mechanism.codes).toContain("hold-interrupted");
    },
  );
});
