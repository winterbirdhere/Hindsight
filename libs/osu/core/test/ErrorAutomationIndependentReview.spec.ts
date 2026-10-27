import { buildErrorAnalysis } from "../src/gameplay/error-analysis/ErrorAnalysis";
import { errorFixture } from "./ErrorAnalysisFixtures";
import { traceFrame } from "./ReplayTraceFixtures";

describe("independent slider automation facet review", () => {
  it.each(["stable", "lazer"] as const)(
    "%s does not blame Autopilot cursor control for body geometry loss",
    (profile) => {
      const f = errorFixture(
        "100,192,1000,2,0,L|300:192,1,200",
        [
          traceFrame(900, 100),
          traceFrame(1000, 100, [0]),
          traceFrame(1500, 500, [0]),
          traceFrame(1970, 500, [0]),
          traceFrame(2100, 500, [0]),
        ],
        profile,
        ["AUTO_PILOT"],
        profile === "lazer" ? [{ acronym: "AP" }] : [],
      );
      const analysis = buildErrorAnalysis(f.trace, f.map);
      expect(analysis.capabilities.aim).toBe("automated");
      const body = analysis.classifications.filter(
        (c) => analysis.inventory.atoms.find((a) => a.id === c.atomId)?.component === "slider-tick",
      );
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((c) => c.mechanism.status === "unavailable")).toBe(true);
      expect(body.flatMap((c) => c.mechanism.codes)).not.toEqual(expect.arrayContaining(["off-track"]));
    },
  );

  it.each(["stable", "lazer"] as const)(
    "%s does not blame Autoplay cursor or buttons for a reconstructed body loss",
    (profile) => {
      const f = errorFixture(
        "100,192,1000,2,0,L|300:192,1,200",
        [
          traceFrame(900, 100),
          traceFrame(1000, 100, [0]),
          traceFrame(1500, 500),
          traceFrame(1970, 500),
          traceFrame(2100, 500),
        ],
        profile,
        ["AUTO_PLAY"],
        profile === "lazer" ? [{ acronym: "AT" }] : [],
      );
      const analysis = buildErrorAnalysis(f.trace, f.map);
      expect(analysis.capabilities).toMatchObject({ aim: "automated", tapping: "automated" });
      const body = analysis.classifications.filter(
        (c) => analysis.inventory.atoms.find((a) => a.id === c.atomId)?.component === "slider-tick",
      );
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((c) => c.mechanism.status === "unavailable")).toBe(true);
    },
  );

  it.each(["stable", "lazer"] as const)(
    "%s preserves an Autopilot manual-hold loss with sufficient geometry",
    (profile) => {
      const f = errorFixture(
        "100,192,1000,2,0,L|300:192,1,200",
        [
          traceFrame(900, 100),
          traceFrame(1000, 100, [0]),
          traceFrame(1500, 200),
          traceFrame(1970, 294),
          traceFrame(2100, 300),
        ],
        profile,
        ["AUTO_PILOT"],
        profile === "lazer" ? [{ acronym: "AP" }] : [],
      );
      const analysis = buildErrorAnalysis(f.trace, f.map);
      const body = analysis.classifications.filter(
        (c) => analysis.inventory.atoms.find((a) => a.id === c.atomId)?.component === "slider-tick",
      );
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((c) => c.mechanism.status === "supported")).toBe(true);
      expect(
        body.flatMap((c) => c.mechanism.codes).every((code) => code === "no-hold" || code === "released-early"),
      ).toBe(true);
    },
  );
});
