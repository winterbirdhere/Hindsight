import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveTargetCadence } from "../src/gameplay/error-analysis/StreamCadenceEvidence";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

type Profile = "stable" | "classic" | "native";
function fixture(
  profile: Profile,
  outside: number[] = [1000, 1050, 1550],
  shift = 0,
  spacing = 70,
  taps = [980, 1080, 1180, 1280, 1380, 1480, 1580],
) {
  const times = Array.from({ length: 12 }, (_, k) => 1000 + k * 50);
  const frames = Array.from({ length: 241 }, (_, k) => {
    const t = 700 + k * 5;
    const press = taps.findIndex((p) => t >= p && t < p + 10);
    return traceFrame(t + shift, 100 + ((t - 1000) * spacing) / 50, press < 0 ? [] : [press % 2]);
  });
  for (const frame of frames) if (outside.includes(frame.time - shift)) frame.position.y = 280;
  const f = errorFixture(
    times.map((t, k) => `${100 + k * spacing},192,${t + shift},1,0`).join("\n"),
    frames,
    profile === "stable" ? "stable" : "lazer",
    [],
    profile === "classic" ? [{ acronym: "CL", settings: { classic_note_lock: true } }] : [],
  );
  const e = deriveCircleEvidence(f.trace, f.map, "7");
  return { ...f, e, frames, times, taps, cadence: deriveTargetCadence(e, f.map, f.trace) };
}

describe("target-centered cadence flow", () => {
  it.each(["stable", "classic"] as const)(
    "retains %s slow tapping after an unrelated earlier aim failure",
    (profile) => {
      const f = fixture(profile);
      expect(f.e.terminal?.result).toBe("MISS");
      expect(f.e.terminal?.mechanism).toBe("automatic-expiry");
      expect(f.e.directRejections).toEqual([]);
      expect(f.cadence).toBeDefined();
      expect(f.cadence!.pattern.flow.complete).toBe(false);
      // Source schedule is 50 ms; all seven actual single-action presses are
      // 100 ms apart. The current gap has a slow gap on each side. Its complete
      // flow witness includes both boundary beats, not the earlier/later misses.
      expect(f.cadence).toMatchObject({
        binding: {
          flow: {
            complete: true,
            basis: "target-centered-three-gap-flow",
            startTimeMs: 1180,
            endTimeMs: 1480,
            samples: ["3", "4", "5", "6", "7", "8", "9", "10"].map((componentId) => ({ componentId, inside: true })),
          },
        },
      });
      expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("Slow taps");
    },
  );
  it("preserves native out-of-order reception before cadence ranking", () => {
    const f = fixture("native");
    expect(f.e.terminal?.mechanism).toBe("ordered-force-miss");
    expect(f.cadence).toBeUndefined();
    expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("Out of order");
  });
  it.each([1150, 1250, 1500])("does not discard conflicting flow at required beat %s", (time) => {
    const f = fixture("stable", [1000, time]);
    expect(f.cadence).toBeDefined();
    expect(classifyCircleLoss(f.e, f.map, f.trace).codes).not.toContain("slow-tapping");
  });
  it("does not choose a later favorable triplet when the centered witness fails", () => {
    const f = fixture("stable", [1000, 1150]);
    expect(f.cadence!.pattern.slowRuns.length).toBeGreaterThan(1);
    expect(f.cadence).toMatchObject({ binding: { flow: { complete: false, startTimeMs: 1180, endTimeMs: 1480 } } });
    expect(classifyCircleLoss(f.e, f.map, f.trace).codes).not.toContain("slow-tapping");
  });
  it("is invariant to the absolute map clock and retains full context", () => {
    const f = fixture("stable", [1000, 1050, 1550], 3210);
    expect(f.cadence!.pattern.flow.samples.filter((s) => !s.inside).map((s) => s.timeMs)).toEqual([4210, 4260, 4760]);
    expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("Slow taps");
  });
  it.each(["stable", "classic"] as const)(
    "preserves %s direct Notelock even with complete local cadence flow",
    (profile) => {
      const f = fixture(profile, [1000, 1050, 1550], 0, 25);
      expect(f.cadence!.binding.flow?.complete).toBe(true);
      expect(f.e.directRejections.length).toBeGreaterThan(0);
      expect(classifyCircleLoss(f.e, f.map, f.trace).headline).toBe("Notelock");
    },
  );
  it("does not substitute an asymmetric triplet when the following gap recovers", () => {
    const f = fixture("stable", [1000], 0, 70, [980, 1080, 1180, 1280, 1380, 1430, 1480, 1580]);
    expect(f.cadence).toBeDefined();
    expect(f.cadence!.pattern.slowRuns.some((r) => r.gapIds.includes(f.cadence!.binding.gapId))).toBe(true);
    expect(f.cadence!.binding.flow).toBeUndefined();
    expect(classifyCircleLoss(f.e, f.map, f.trace).codes).not.toContain("slow-tapping");
  });
  it("retains source integrity requirements outside the selected flow span", () => {
    const f = fixture("stable");
    const trace = {
      ...f.trace,
      records: f.trace.records.map((r) =>
        r.kind === "input" && r.timeMs === 1025
          ? { ...r, source: { ...r.source, discontinuityBefore: ["test-gap"] } }
          : r,
      ),
    };
    expect(deriveTargetCadence(deriveCircleEvidence(trace, f.map, "7"), f.map, trace)).toBeUndefined();
  });
  it("does not clip a missing boundary beat to the end of the context", () => {
    const f = fixture("stable", [1000], 0, 70, [980, 1080, 1180, 1280, 1480, 1580]);
    expect(f.cadence).toMatchObject({
      binding: { flow: { complete: false, endTimeMs: 1580, samples: [], reason: "missing-boundary-beat" } },
    });
    expect(classifyCircleLoss(f.e, f.map, f.trace).codes).not.toContain("slow-tapping");
  });
  it("retains every same-time position at a required flow beat", () => {
    const f = fixture("stable", [1000]),
      at = f.frames.findIndex((q) => q.time === 1250);
    const frames = [
      ...f.frames.slice(0, at + 1),
      { ...f.frames[at], position: { ...f.frames[at].position, y: 280 } },
      ...f.frames.slice(at + 1),
    ];
    const other = errorFixture(f.times.map((t, k) => `${100 + k * 70},192,${t},1,0`).join("\n"), frames);
    const e = deriveCircleEvidence(other.trace, other.map, "7"),
      cadence = deriveTargetCadence(e, other.map, other.trace);
    expect(cadence!.binding.flow!.samples.find((s) => s.timeMs === 1250)).toMatchObject({
      inside: false,
      eventIds: expect.any(Array),
    });
    expect(cadence!.binding.flow!.samples.find((s) => s.timeMs === 1250)!.eventIds).toHaveLength(2);
    expect(classifyCircleLoss(e, other.map, other.trace).codes).not.toContain("slow-tapping");
  });
  it("does not mutate a shared pattern or source while binding different targets", () => {
    const f = fixture("stable"),
      original = JSON.stringify(f.trace),
      pattern = JSON.stringify(f.cadence!.pattern);
    deriveTargetCadence(deriveCircleEvidence(f.trace, f.map, "6"), f.map, f.trace);
    expect(JSON.stringify(f.cadence!.pattern)).toBe(pattern);
    expect(JSON.stringify(f.trace)).toBe(original);
    expect(deriveTargetCadence(f.e, f.map, f.trace)).toEqual(f.cadence);
    expect(deriveTargetCadence(f.e, f.map, f.trace, new Set(["3"]))).toBeUndefined();
  });
});
