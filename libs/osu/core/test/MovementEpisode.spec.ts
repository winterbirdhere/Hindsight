import {
  classifyMovementEpisodes,
  MovementEpisodeInput,
  MovementSample,
} from "../src/gameplay/error-analysis/MovementEpisode";

const sample = (time: number, x: number, y = 0, sequence = time): MovementSample => ({
  time,
  sequence,
  position: { x, y },
});
const make = (samples: MovementSample[], pressIndex: number): MovementEpisodeInput => ({
  center: { x: 0, y: 0 },
  radius: 1,
  scope: { start: { time: 0, sequence: 0 }, end: { time: 200, sequence: 200 } },
  samples,
  failedPresses: [{ ...samples[pressIndex], id: "press", association: "target-attempt" }],
  completeness: { start: true, end: true },
});
const over = () =>
  make(
    [
      sample(0, -3),
      sample(10, -1.5),
      sample(20, 0),
      sample(30, 1.5),
      sample(40, 1.8),
      sample(50, 1.45),
      sample(60, 1.3),
    ],
    4,
  );
const under = () =>
  make([sample(0, -3), sample(10, -2), sample(20, -1.3), sample(30, -1.25), sample(40, -1.6), sample(50, -1.9)], 3);
const wide = () =>
  make([sample(0, -3, 1.2), sample(10, -1, 1.2), sample(20, 0, 1.2), sample(30, 1, 1.2), sample(40, 3, 1.2)], 2);
const labels = (input: MovementEpisodeInput) => classifyMovementEpisodes(input).opportunities[0].labels;

describe("movement episodes, independent analytic geometry", () => {
  it("recognizes crossing, a far-side failed press and a confirmed return as Overshoot", () => {
    const result = classifyMovementEpisodes(over());
    expect(result.opportunities[0].labels).toEqual(["Overshoot"]);
    // x(t) is linear: -1 at 13 1/3 ms, +1 at 26 2/3 ms.
    expect(result.opportunities[0].witnesses[0].contacts[0].entry.time).toBeCloseTo(40 / 3);
    expect(result.opportunities[0].witnesses[0].contacts[0].exit.time).toBeCloseTo(80 / 3);
    expect(result.policy.version).toBe("movement-episodes-v1");
  });
  it("recognizes a completed near-side reversal that never touches the area", () => {
    expect(labels(under())).toEqual(["Undershoot"]);
  });
  it("recognizes a complete transverse bypass, including the press at the closest point", () => {
    expect(labels(wide())).toEqual(["Wide aim"]);
  });
  it.each(["over", "under"])("accepts an observed 20 ms settle for %s", (kind) => {
    const input = kind === "over" ? over() : under();
    const x = kind === "over" ? 1.8 : -1.25;
    input.samples = [...input.samples.slice(0, kind === "over" ? 5 : 4), sample(60, x), sample(70, x + 0.01)];
    expect(labels(input)).toEqual([kind === "over" ? "Overshoot" : "Undershoot"]);
  });
  it("does not call normal onward departure an overshoot", () => {
    expect(labels(make([sample(0, -3), sample(10, 0), sample(20, 1.5), sample(30, 2.5), sample(40, 4)], 2))).toEqual(
      [],
    );
  });
  it("does not call a still-approaching press an undershoot", () => {
    expect(labels(make([sample(0, -3), sample(10, -2), sample(20, -1.5), sample(30, -1.1)], 2))).toEqual([]);
  });
  it("does not treat a clipped end as a completed stop", () => {
    const input = under();
    input.samples = input.samples.slice(0, 4);
    input.completeness = { start: true, end: false };
    expect(labels(input)).toEqual([]);
  });
  it("does not bridge a genuine discontinuity", () => {
    const input = over();
    input.samples[2].discontinuityBefore = true;
    expect(labels(input)).toEqual([]);
  });
  it("does not create a zero-time crossing", () => {
    expect(
      labels(make([sample(0, -3), sample(10, -1.5, 0, 1), sample(10, 1.5, 0, 2), sample(20, 1.8), sample(30, 1.4)], 3)),
    ).toEqual([]);
  });
  it("keeps equal-time input ordering and ignores post-terminal presses", () => {
    const input = over();
    input.scope.end = { time: 40, sequence: 39 };
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("outside-live-scope");
  });
  it("does not borrow a post-terminal turn to confirm overshoot", () => {
    const input = over();
    input.scope.end = { time: 40, sequence: 40 };
    expect(labels(input)).toEqual([]);
  });
  it("does not borrow a return beyond a competing assigned input", () => {
    const input = over();
    input.competingInputs = [{ time: 45, sequence: 45 }];
    expect(labels(input)).toEqual([]);
  });
  it("does not promote a correction which succeeds before the target resolves", () => {
    const input = over();
    input.samples = [...input.samples, sample(70, 0)];
    input.successfulInputs = [{ time: 70, sequence: 70 }];
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("successful-correction");
  });
  it("rejects a starting-on-target/zero-axis path as an approach", () => {
    expect(labels(make([sample(0, 0), sample(10, 1.5), sample(20, 1.8), sample(30, 1.4)], 2))).toEqual([]);
  });
  it("requires more than an arbitrary nearest point or insignificant movement", () => {
    expect(labels(make([sample(0, -1.3), sample(10, -1.29), sample(20, -1.3), sample(40, -1.31)], 1))).toEqual([]);
  });
  it("never calls a lateral bypass undershoot", () => {
    const result = classifyMovementEpisodes(wide());
    expect(result.opportunities[0].labels).not.toContain("Undershoot");
  });
  it("does not call an exact tangent or already contacted path Wide aim", () => {
    const input = wide();
    input.samples.forEach((p) => {
      p.position.y = 1;
    });
    input.failedPresses[0].position.y = 1;
    expect(labels(input)).toEqual([]);
  });
  it("keeps exact hit boundaries independent of the morphology noise threshold", () => {
    const input = wide();
    input.samples.forEach((p) => {
      p.position.y = 1.000000001;
    });
    input.failedPresses[0].position.y = 1.000000001;
    expect(labels(input)).toEqual(["Wide aim"]);
    input.policy = { noiseRadius: 0.04 };
    expect(labels(input)).toEqual(["Wide aim"]);
  });
  it("does not select one convenient contact out of multiple passes", () => {
    const input = over();
    input.samples = [...input.samples, sample(70, 0), sample(80, -2), sample(90, -1.5)];
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("multiple-contact-episodes");
  });
  it("preserves every associated failed press and does not invent an association", () => {
    const input = over();
    input.failedPresses = [...input.failedPresses, { ...input.samples[3], id: "other", association: "target-routing" }];
    const result = classifyMovementEpisodes(input);
    expect(result.opportunities.map((p) => p.pressId)).toEqual(["press", "other"]);
    input.failedPresses = [];
    expect(classifyMovementEpisodes(input).opportunities).toEqual([]);
  });
  it("uses actual local departure points through curved flow", () => {
    const input = make(
      [
        sample(0, -4, 4),
        sample(10, -2, 1),
        sample(20, -1.4, 0.1),
        sample(30, -1.19),
        sample(40, -1.6),
        sample(50, -1.8),
      ],
      3,
    );
    const result = classifyMovementEpisodes(input).opportunities[0];
    expect(result.labels).toEqual(["Undershoot"]);
    expect(result.witnesses[0].origin.sequence).toBe(20);
  });
  it("finds the crossing between samples without inventing intermediate key presses", () => {
    const input = make([sample(0, -3), sample(30, 1.8), sample(40, 1.4)], 1);
    expect(labels(input)).toEqual(["Overshoot"]);
    expect(classifyMovementEpisodes(input).opportunities).toHaveLength(1);
  });
  it("does not call a incomplete near-side lateral turn an undershoot", () => {
    expect(labels(make([sample(0, -3, 2), sample(10, -1.5, 2), sample(20, -1, 2), sample(30, -1.5, 2)], 2))).toEqual(
      [],
    );
  });
  it.each([0.19, 0.2, 0.21])("uses the documented confirmed-reverse threshold at %s R", (reverse) => {
    const input = over();
    input.samples = [...input.samples.slice(0, 5), sample(50, 1.8 - reverse)];
    expect(labels(input)).toEqual(reverse >= 0.2 ? ["Overshoot"] : []);
  });
  it.each([19, 20, 21])("uses source-play time and distinct updates for a %s ms settle", (duration) => {
    const input = over();
    input.samples = [...input.samples.slice(0, 5), sample(40 + duration, 1.8)];
    expect(labels(input)).toEqual(duration >= 20 ? ["Overshoot"] : []);
  });
  it("does not count repeated same-time updates as a settle duration", () => {
    const input = over();
    input.samples = [...input.samples.slice(0, 5), sample(40, 1.8, 0, 41), sample(40, 1.8, 0, 42)];
    expect(labels(input)).toEqual([]);
  });
  it.each([0.045, 0.055])("settle spread is bounded at %s R", (spread) => {
    const input = over();
    input.samples = [...input.samples.slice(0, 5), sample(60, 1.8 + spread)];
    expect(labels(input)).toEqual(spread <= 0.05 ? ["Overshoot"] : []);
  });
  it.each([0.024, 0.026])("small path noise %s R does not alter a well-separated reversal", (noise) => {
    const input = over();
    input.samples[3].position.y = noise;
    expect(labels(input)).toEqual(["Overshoot"]);
  });
  it.each([0.1, 1, 100])(
    "preserves all three labels under %s scaling, rotation, reflection and translation",
    (scale) => {
      for (const fixture of [over, under, wide]) {
        const input = fixture();
        const expected = fixture === over ? "Overshoot" : fixture === under ? "Undershoot" : "Wide aim";
        const transform = ({ x, y }: { x: number; y: number }) => ({ x: 300 - scale * y, y: 200 - scale * x });
        input.center = transform(input.center);
        input.radius *= scale;
        input.samples = input.samples.map((p) => ({ ...p, position: transform(p.position) }));
        input.failedPresses = input.failedPresses.map((p) => ({ ...p, position: transform(p.position) }));
        expect(labels(input)).toEqual([expected]);
      }
    },
  );
  it("rejects unordered/corrupt data without sorting away source order", () => {
    const input = over();
    input.samples = [...input.samples].reverse();
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("invalid-source-order");
  });
  it("bounds resource use explicitly rather than silently dropping path samples", () => {
    const input = over();
    input.policy = { maximumSamples: 2 };
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("sample-limit");
  });
  it("exposes omitted presses when the bounded result itself would exceed its limit", () => {
    const input = over();
    input.failedPresses = Array.from({ length: 65 }, (_, i) => ({ ...input.failedPresses[0], id: String(i) }));
    const result = classifyMovementEpisodes(input);
    expect(result.failureReason).toBe("press-limit");
    expect(result.omittedPresses).toBe(1);
    expect(result.opportunities).toHaveLength(64);
  });
  it("does not hide corrupt policy values behind an empty result", () => {
    const input = over();
    input.policy = { maximumPresses: NaN };
    const result = classifyMovementEpisodes(input);
    expect(result.failureReason).toBe("invalid-policy");
    expect(result.opportunities[0].reason).toBe("invalid-policy");
  });
  it("does not infer a path for a scoring position that differs from source reconstruction", () => {
    const input = over();
    input.failedPresses = [{ ...input.failedPresses[0], position: { x: 1.9, y: 0 } }];
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("press-path-mismatch");
  });
  it("supports scoring positions interpolated within the same continuous source segment", () => {
    const input = over();
    input.failedPresses = [
      { id: "between", association: "terminal", time: 35, sequence: 35, position: { x: 1.65, y: 0 } },
    ];
    expect(labels(input)).toEqual(["Overshoot"]);
  });
  it("rejects corrupt competing boundaries rather than bridging them", () => {
    const input = over();
    input.competingInputs = [{ time: NaN, sequence: 5 }];
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("invalid-boundary");
  });
  it("does not invent a direction from an unknown association", () => {
    const input = over();
    input.failedPresses = [{ ...input.failedPresses[0], association: "nearest" as "terminal" }];
    expect(classifyMovementEpisodes(input).opportunities[0].reason).toBe("unproven-target-association");
  });
  it("does not treat same-time unchanged positions as a break in a real approach", () => {
    const input = over();
    input.samples = [...input.samples.slice(0, 2), sample(10, -1.5, 0, 11), ...input.samples.slice(2)];
    expect(labels(input)).toEqual(["Overshoot"]);
  });
  it("retains a locally complete positive episode when the distant recording start is censored", () => {
    const input = over();
    input.completeness = { start: false, end: false };
    expect(labels(input)).toEqual(["Overshoot"]);
  });
  it("does not mutate or sort the caller's evidence", () => {
    const input = over();
    const original = JSON.stringify(input);
    classifyMovementEpisodes(input);
    expect(JSON.stringify(input)).toBe(original);
  });
  it("returns identical ordered witnesses on repeated calls", () => {
    const input = over();
    expect(classifyMovementEpisodes(input)).toEqual(classifyMovementEpisodes(input));
  });
  it("uses Stable's rounded source positions without enlarging hit tolerance", () => {
    const input = wide();
    input.geometryProfile = "stable";
    input.samples.forEach((point) => {
      point.position.y = 1.000000001;
    });
    input.failedPresses[0].position.y = 1.000000001;
    // IEEE single precision rounds this coordinate to exactly the boundary.
    expect(Math.fround(1.000000001)).toBe(1);
    expect(labels(input)).toEqual([]);
  });
  it("keeps native stored coordinates and its rounded radius comparison", () => {
    const input = wide();
    input.geometryProfile = "lazer";
    input.radius = 1.000000001;
    input.samples.forEach((point) => {
      point.position.y = 1.000000001;
    });
    input.failedPresses[0].position.y = 1.000000001;
    expect(Math.fround(input.radius)).toBe(1);
    expect(labels(input)).toEqual(["Wide aim"]);
  });
  it.each([0.3, 1.1, 2.4])("preserves morphology under an arbitrary %s-radian rotation", (angle) => {
    for (const fixture of [over, under, wide]) {
      const input = fixture();
      const transform = ({ x, y }: { x: number; y: number }) => ({
        x: x * Math.cos(angle) - y * Math.sin(angle),
        y: x * Math.sin(angle) + y * Math.cos(angle),
      });
      input.samples = input.samples.map((p) => ({ ...p, position: transform(p.position) }));
      input.failedPresses = input.failedPresses.map((p) => ({ ...p, position: transform(p.position) }));
      expect(labels(input)).toEqual([fixture === over ? "Overshoot" : fixture === under ? "Undershoot" : "Wide aim"]);
    }
  });
});
