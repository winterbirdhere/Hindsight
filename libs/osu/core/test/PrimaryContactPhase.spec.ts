import { classifyCircleLoss } from "../src/gameplay/error-analysis/CircleMechanisms";
import { deriveCircleEvidence } from "../src/gameplay/miss-explanation/CircleEvidence";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

describe.each(["stable", "lazer"] as const)("%s contact-boundary primary phase", (profile) => {
  const diagnose = (points: [number, number, boolean?][]) => {
    const f = errorFixture(
      "300,192,1000,1,0",
      points.map(([t, x, pressed]) => traceFrame(t, x, pressed ? [0] : [])),
      profile,
    );
    const e = deriveCircleEvidence(f.trace, f.map, "0");
    return classifyCircleLoss(e, f.map, f.trace);
  };
  it("does not label late entry when entry is early and a later internal turn is closest", () => {
    const r = diagnose([
      [800, 150],
      [946, 230],
      [966, 250, true],
      [985, 278],
      [995, 286],
      [1013, 305],
      [1041, 300],
      [1060, 340],
      [1200, 420],
    ]);
    expect(r.headline).toBe("Early tap");
    const p = r.diagnostics?.primary?.approaches?.episodes[0].properPass;
    expect(p?.entryTimeMs).toBeLessThan(1000);
    expect(p?.closestOffsetMs).toBeGreaterThan(0);
    expect(r.diagnostics?.primary?.ranking?.candidates.some((c) => c.code === "aim-late")).toBe(true);
  });
  it("compares late entry phase with tapping rather than a much later deepest point", () => {
    const r = diagnose([
      [800, 150],
      [950, 210],
      [974, 240, true],
      [995, 255],
      [1011, 270],
      [1035, 281],
      [1070, 298],
      [1080, 301],
      [1200, 380],
    ]);
    expect(r.headline).toBe("Late entry");
    const primary = r.diagnostics?.primary;
    const pass = primary?.approaches?.episodes[0].properPass;
    const arrival = primary?.ranking?.candidates.find((c) => c.code === "aim-late");
    expect(pass?.entryTimeMs).toBeGreaterThan(1000);
    expect(pass?.entryTimeMs).toBeLessThan(1011);
    expect(arrival?.attribution?.cursorTolerance).toBeGreaterThan(
      primary?.ranking?.candidates.find((c) => c.code === "early-tap")?.attribution?.tapTolerance ?? 0,
    );
    for (const id of pass?.eventIds ?? []) expect(arrival?.eventIds).toContain(id);
  });
  it("does not label early exit while the cursor remains inside through the beat", () => {
    const r = diagnose([
      [800, 150],
      [940, 270],
      [960, 300],
      [990, 326],
      [1005, 333],
      [1020, 350],
      [1026, 357, true],
      [1040, 373],
      [1200, 540],
    ]);
    expect(r.headline).toBe("Late tap");
    const pass = r.diagnostics?.primary?.approaches?.episodes[0].properPass;
    expect(pass?.closestOffsetMs).toBeLessThan(0);
    expect(pass?.exitTimeMs).toBeGreaterThan(1000);
    expect(r.diagnostics?.primary?.ranking?.candidates.some((c) => c.code === "left-early")).toBe(true);
  });
});
