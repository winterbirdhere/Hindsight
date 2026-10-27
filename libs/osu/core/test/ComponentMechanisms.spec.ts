import { classifySliderLoss, classifySpinnerLoss } from "../src/gameplay/error-analysis/ComponentMechanisms";
import { SliderTrackingSnapshot, SpinnerSummary } from "../src/gameplay/error-analysis/ErrorObservations";
import { ReplayTraceRecord } from "../src/gameplay/trace/ReplayTrace";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { PathType } from "../src/hitobjects/slider/PathType";

type Checkpoint = Extract<ReplayTraceRecord, { kind: "slider-checkpoint" }>;
type Tracking = Extract<ReplayTraceRecord, { kind: "slider-tracking" }>;
type SpinnerResolution = Extract<ReplayTraceRecord, { kind: "spinner-resolution" }>;

function slider() {
  const head = new HitCircle();
  Object.assign(head, {
    id: "s/HEAD",
    sliderId: "s",
    hitTime: 1000,
    position: { x: 0, y: 0 },
    unstackedPosition: { x: 0, y: 0 },
  });
  const target = new Slider(head);
  Object.assign(target, { id: "s", velocity: 0.1 });
  target.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 200, y: 0 } }], 200);
  return target;
}
const snap = (patch: Partial<SliderTrackingSnapshot> = {}): SliderTrackingSnapshot => ({
  timeMs: 1500,
  position: { x: 50, y: 0 },
  ball: { x: 50, y: 0 },
  radius: 32,
  geometryAccepted: true,
  holdAccepted: true,
  started: true,
  actions: [0],
  beforeTracking: false,
  tracking: true,
  trackingSince: 1000,
  ...patch,
});
const point = (patch: Partial<Checkpoint> = {}): Checkpoint => ({
  id: "p",
  sequence: 10,
  phase: "resolution",
  timeMs: 1500,
  kind: "slider-checkpoint",
  componentId: "s/TICK",
  parentId: "s",
  component: "slider-tick",
  deadlineMs: 1500,
  objectTimeMs: 1500,
  hit: false,
  lateAcquisition: false,
  tracking: snap(),
  ...patch,
});
const track = (tracking: SliderTrackingSnapshot, sequence = 1): Tracking => ({
  id: `t${sequence}`,
  sequence,
  timeMs: tracking.timeMs,
  phase: "lifecycle",
  kind: "slider-tracking",
  componentId: "s",
  tracking,
});

describe("rule-owned slider component mechanisms", () => {
  for (const geometry of [false, true])
    for (const hold of ["none", "wrong", "accepted"] as const) {
      if (geometry && hold === "accepted") continue; // A legal ordinary failed check needs a failed gate.
      it(`explains all failed gates, geometry ${geometry}, hold ${hold}`, () => {
        const record = point({
          tracking: snap({
            geometryAccepted: geometry,
            holdAccepted: hold === "accepted",
            actions: hold === "none" ? [] : [0],
            tracking: false,
            position: geometry ? { x: 50, y: 0 } : { x: 50, y: 100 },
          }),
        });
        const result = classifySliderLoss(record, [], slider());
        expect(result.status).toBe("supported");
        expect(result.codes).toEqual([
          ...(geometry ? [] : ["off-track"]),
          ...(hold === "accepted" ? [] : [hold === "none" ? "no-hold" : "wrong-hold"]),
        ]);
        expect(result.eventIds).toContain("p");
        expect(result.headline.split(/\s+/).filter((s) => /[a-z]/i.test(s)).length).toBeLessThanOrEqual(4);
      });
    }

  it("requires an accepted-to-released history and still-sufficient geometry for Released early", () => {
    const history = [
      track(snap({ timeMs: 1400, tracking: true })),
      track(snap({ timeMs: 1490, actions: [], holdAccepted: false, tracking: false }), 2),
    ];
    const result = classifySliderLoss(
      point({ tracking: snap({ actions: [], holdAccepted: false, tracking: false }) }),
      history,
      slider(),
    );
    expect(result.codes).toEqual(["released-early"]);
    expect(result.eventIds).toEqual(expect.arrayContaining(["p", "t1", "t2"]));
    expect(classifySliderLoss(point({ hit: true }), history, slider()).status).toBe("unavailable");
  });

  it("does not call an old release causal after release/repress recovery", () => {
    const history = [
      track(snap({ timeMs: 1200 })),
      track(snap({ timeMs: 1250, actions: [], holdAccepted: false, tracking: false }), 2),
      track(snap({ timeMs: 1400 }), 3),
    ];
    const result = classifySliderLoss(
      point({ tracking: snap({ actions: [1], holdAccepted: false, tracking: false }) }),
      history,
      slider(),
    );
    expect(result.codes).toEqual(["wrong-hold"]);
  });

  it("respects sequence order for same-time recovery and rejects post-terminal context", () => {
    const record = point({ tracking: snap({ actions: [], holdAccepted: false, tracking: false }) });
    const history = [
      track(snap({ timeMs: 1400, actions: [], holdAccepted: false, tracking: false })),
      track(snap({ timeMs: 1500 }), 11),
    ];
    expect(classifySliderLoss(record, history, slider()).codes).toEqual(["no-hold"]);
  });

  it("uses the acquisition deadline even when the final tracking state is true", () => {
    const record = point({
      timeMs: 1501,
      lateAcquisition: true,
      tracking: snap({ timeMs: 1501, trackingSince: 1501 }),
    });
    expect(classifySliderLoss(record, [], slider()).codes).toEqual(["late-pickup"]);
  });

  it("does not turn successful delayed-head catch-up into an error", () => {
    const caught = { headTimeMs: 1580, batchInRange: true, componentInRange: true, radius: 32 };
    expect(classifySliderLoss(point({ hit: true, timeMs: 1580, catchUp: caught }), [], slider()).status).toBe(
      "unavailable",
    );
    const failed = classifySliderLoss(
      point({
        timeMs: 1580,
        catchUp: { ...caught, batchInRange: false },
        tracking: snap({ geometryAccepted: false, tracking: false, positionOverride: false }),
      }),
      [],
      slider(),
    );
    expect(failed.codes).toEqual(["started-late"]);
  });

  it("retains hold and component geometry failures during failed late-head catch-up", () => {
    const result = classifySliderLoss(
      point({
        timeMs: 1580,
        catchUp: { headTimeMs: 1580, batchInRange: false, componentInRange: false, radius: 32 },
        tracking: snap({
          geometryAccepted: false,
          actions: [],
          holdAccepted: false,
          tracking: false,
          positionOverride: false,
        }),
      }),
      [],
      slider(),
    );
    expect(result.codes).toEqual(["started-late", "off-track", "no-hold"]);
    expect(result.description).toMatch(/late/);
    expect(result.description).toMatch(/outside/);
    expect(result.description).toMatch(/held/);
  });

  it.each(["slider-legacy-tail", "slider-end"] as const)(
    "keeps %s context without claiming a combo break",
    (component) => {
      const result = classifySliderLoss(
        point({ component, tracking: snap({ actions: [], holdAccepted: false, tracking: false }) }),
        [],
        slider(),
      );
      expect(result.description).toMatch(/end/);
      expect(result.description).not.toMatch(/combo|break|trace|radius|latch|model/i);
    },
  );

  it.each([
    [100, "ran-ahead"],
    [-50, "fell-behind"],
  ] as const)("uses the actual local phase direction for x=%s", (x, expected) => {
    expect(
      classifySliderLoss(
        point({ tracking: snap({ geometryAccepted: false, tracking: false, position: { x, y: 0 } }) }),
        [],
        slider(),
        "lazer",
      ).codes,
    ).toEqual([expected]);
  });

  it("does not promote lateral displacement or a stationary endpoint to ahead/behind", () => {
    expect(
      classifySliderLoss(
        point({ tracking: snap({ geometryAccepted: false, tracking: false, position: { x: 100, y: 100 } }) }),
        [],
        slider(),
        "lazer",
      ).codes,
    ).toEqual(["off-track"]);
    expect(
      classifySliderLoss(
        point({
          timeMs: 3001,
          tracking: snap({
            timeMs: 3001,
            ball: { x: 200, y: 0 },
            position: { x: 300, y: 0 },
            geometryAccepted: false,
            tracking: false,
          }),
        }),
        [],
        slider(),
        "lazer",
      ).codes,
    ).toEqual(["off-track"]);
  });

  it("uses reverse-span direction without nearest-path guesses", () => {
    const target = slider();
    target.repeatCount = 1;
    const result = classifySliderLoss(
      point({
        timeMs: 3500,
        deadlineMs: 3500,
        tracking: snap({
          timeMs: 3500,
          ball: { x: 150, y: 0 },
          position: { x: 100, y: 0 },
          geometryAccepted: false,
          tracking: false,
        }),
      }),
      [],
      target,
      "lazer",
    );
    expect(result.codes).toEqual(["ran-ahead"]);
  });

  it.each([0, 0.7, Math.PI, -Math.PI / 2])(
    "keeps local ahead classification under rotation %s and translation",
    (angle) => {
      const target = slider(),
        c = Math.cos(angle),
        s = Math.sin(angle);
      target.head.position = { x: 200, y: 120 };
      target.head.unstackedPosition = { x: 200, y: 120 };
      target.path = new SliderPath(
        [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 200 * c, y: 200 * s } }],
        200,
      );
      const ball = { x: 200 + 50 * c, y: 120 + 50 * s },
        position = { x: 200 + 100 * c, y: 120 + 100 * s };
      expect(
        classifySliderLoss(
          point({ tracking: snap({ ball, position, geometryAccepted: false, tracking: false }) }),
          [],
          target,
          "lazer",
        ).codes,
      ).toEqual(["ran-ahead"]);
    },
  );

  it("rejects an unexplained impossible failed state instead of inventing a cause", () => {
    const result = classifySliderLoss(point(), [], slider());
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("failed-component-with-no-failed-gate");
  });

  it("requires an observed approach then reversal before the missed repeat for Turned early", () => {
    const target = slider();
    target.repeatCount = 1;
    const motion = [
      snap({ timeMs: 2800, ball: { x: 180, y: 0 }, position: { x: 150, y: 0 } }),
      snap({ timeMs: 2850, ball: { x: 185, y: 0 }, position: { x: 175, y: 0 } }),
      snap({
        timeMs: 2900,
        ball: { x: 190, y: 0 },
        position: { x: 145, y: 0 },
        geometryAccepted: false,
        tracking: false,
      }),
    ];
    const record = point({
      timeMs: 3000,
      deadlineMs: 3000,
      objectTimeMs: 3000,
      component: "slider-repeat",
      motion,
      tracking: snap({
        timeMs: 3000,
        ball: { x: 200, y: 0 },
        position: { x: 130, y: 0 },
        geometryAccepted: false,
        tracking: false,
      }),
    });
    expect(classifySliderLoss(record, [], target, "lazer").codes).toEqual(["turned-early"]);
    expect(classifySliderLoss({ ...record, hit: true }, [], target, "lazer").status).toBe("unavailable");
    expect(classifySliderLoss({ ...record, motion: motion.slice(1) }, [], target, "lazer").codes).toEqual([
      "off-track",
    ]);
    expect(
      classifySliderLoss({ ...record, motion: motion.map((p) => ({ ...p, timeMs: 3000 })) }, [], target, "lazer").codes,
    ).toEqual(["off-track"]);
  });
});

const summary = (patch: Partial<SpinnerSummary> = {}): SpinnerSummary => ({
  samples: 120,
  heldSamples: 120,
  firstHeldMs: 1000,
  lastHeldMs: 3000,
  firstCreditMs: 1200,
  lastCreditMs: 2990,
  creditedProgress: 500,
  requiredProgress: 720,
  greatThreshold: 720,
  greatStrict: false,
  signedTravel: 500,
  absoluteTravel: 500,
  uncreditedTravel: 0,
  reversals: 0,
  clampedSamples: 0,
  automated: false,
  rules: "native",
  ...patch,
});
const spin = (patch: Partial<SpinnerSummary> = {}, result = "MISS"): SpinnerResolution => ({
  id: "spin",
  sequence: 99,
  phase: "resolution",
  timeMs: 3000,
  kind: "spinner-resolution",
  componentId: "spinner",
  result,
  startTimeMs: 1000,
  objectTimeMs: 3000,
  summary: summary(patch),
});
const manual = { spinner: "manual" } as const;

describe("credited spinner mechanisms", () => {
  it("distinguishes no accepted holding from held stationary movement", () => {
    expect(
      classifySpinnerLoss(
        spin({
          heldSamples: 0,
          firstHeldMs: undefined,
          lastHeldMs: undefined,
          creditedProgress: 0,
          absoluteTravel: 0,
          signedTravel: 0,
        }),
        manual,
      ).codes,
    ).toEqual(["no-hold"]);
    expect(
      classifySpinnerLoss(spin({ creditedProgress: 0, absoluteTravel: 0, signedTravel: 0 }), manual).codes,
    ).toEqual(["no-spin"]);
  });
  it("does not require a human hold under Relax", () => {
    expect(
      classifySpinnerLoss(spin({ heldSamples: 0, creditedProgress: 0, absoluteTravel: 0, signedTravel: 0 }), {
        spinner: "manual",
        tapping: "automated",
      }).codes,
    ).toEqual(["no-spin"]);
  });
  it("calls actual sustained but insufficient credited rotation Slow spin", () => {
    expect(classifySpinnerLoss(spin(), manual).codes).toEqual(["slow-spin"]);
  });
  it("does not mistake quantized first/last credited turns for late start or early stop", () => {
    expect(
      classifySpinnerLoss(
        spin({
          rules: "stable-current",
          creditedProgress: 4,
          greatThreshold: 5,
          greatStrict: true,
          requiredProgress: 5,
          firstCreditMs: 1600,
          lastCreditMs: 2600,
          uncreditedTravel: 179,
        }),
        manual,
      ).codes,
    ).toEqual(["slow-spin"]);
  });
  it("never diagnoses a successful or automated spinner", () => {
    expect(classifySpinnerLoss(spin({}, "GREAT"), manual).status).toBe("unavailable");
    expect(classifySpinnerLoss(spin({ automated: true }), manual).status).toBe("unavailable");
    expect(classifySpinnerLoss(spin(), { spinner: "automated" }).status).toBe("unavailable");
  });
  it("does not manufacture an error where the credited threshold is attained", () => {
    expect(classifySpinnerLoss(spin({ creditedProgress: 720 }), manual).status).toBe("unavailable");
    expect(
      classifySpinnerLoss(
        spin({
          creditedProgress: 5,
          greatThreshold: 5,
          greatStrict: true,
          requiredProgress: 5,
          rules: "stable-current",
        }),
        manual,
      ).status,
    ).toBe("supported");
  });
  it("uses witnessed idle spans for late engagement and early stopping", () => {
    expect(
      classifySpinnerLoss(
        spin({ firstMotionMs: 1600, lastMotionMs: 2990, leadingIdleMs: 580, trailingIdleMs: 0 }),
        manual,
      ).codes,
    ).toEqual(["started-late"]);
    expect(
      classifySpinnerLoss(
        spin({ firstMotionMs: 1010, lastMotionMs: 2400, leadingIdleMs: 0, trailingIdleMs: 580 }),
        manual,
      ).codes,
    ).toEqual(["stopped-early"]);
    expect(
      classifySpinnerLoss(
        spin({ firstMotionMs: 1600, lastMotionMs: 2400, leadingIdleMs: 580, trailingIdleMs: 580 }),
        manual,
      ).codes,
    ).toEqual(["started-late", "stopped-early"]);
  });
  it("requires native anti-reversal lost progress, not a direction change alone", () => {
    expect(
      classifySpinnerLoss(spin({ reversals: 3, uncreditedTravel: 220, reversalLostProgress: 220 }), manual).codes,
    ).toEqual(["reversed-spin"]);
    expect(
      classifySpinnerLoss(spin({ reversals: 3, uncreditedTravel: 220, reversalLostProgress: 0 }), manual).codes,
    ).toEqual(["slow-spin"]);
    expect(
      classifySpinnerLoss(
        spin({
          rules: "stable-current",
          creditedProgress: 4,
          requiredProgress: 5,
          greatThreshold: 5,
          greatStrict: true,
          reversals: 3,
          uncreditedTravel: 220,
          reversalLostProgress: 220,
        }),
        manual,
      ).codes,
    ).toEqual(["slow-spin"]);
  });
  it("keeps independent late, stop and reversal witnesses without a Mixed headline", () => {
    const result = classifySpinnerLoss(
      spin({ leadingIdleMs: 580, trailingIdleMs: 580, reversals: 2, reversalLostProgress: 150 }),
      manual,
    );
    expect(result.codes).toEqual(["started-late", "stopped-early", "reversed-spin"]);
    expect(result.headline.split(/\s+/).filter((s) => /[a-z]/i.test(s)).length).toBeLessThanOrEqual(4);
    expect(result.headline).not.toMatch(/Mixed/);
    expect(result.description).toMatch(/late/);
    expect(result.description).toMatch(/stopp/);
    expect(result.description).toMatch(/revers/);
  });
  it("uses observed Stable reversal braking rather than pretending half-turn rounding consumes progress", () => {
    expect(
      classifySpinnerLoss(
        spin({
          rules: "stable-current",
          creditedProgress: 4,
          requiredProgress: 5,
          greatThreshold: 5,
          greatStrict: true,
          reversalBrakingSamples: 2,
        }),
        manual,
      ).codes,
    ).toEqual(["reversed-spin"]);
  });
});
