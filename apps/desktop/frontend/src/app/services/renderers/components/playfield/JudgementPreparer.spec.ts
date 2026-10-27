import type { HitObjectJudgement } from "@osujs/core";
import { OsuClassicJudgement } from "@rewind/osu-pixi/classic-components";
import { classicJudgementAnimationAge } from "./JudgementPreparer";

function judgement(overrides: Partial<HitObjectJudgement> = {}): HitObjectJudgement {
  return {
    type: "HitObjectJudgement",
    eventId: "stable:hit-object-judgement:circle",
    ruleset: "stable",
    time: 1_120,
    objectTime: 1_000,
    judgementTime: 1_120,
    position: { x: 100, y: 100 },
    hitObjectId: "circle",
    verdict: "MISS",
    missReason: "TIME_EXPIRED",
    ...overrides,
  };
}

describe("classic judgement visibility", () => {
  it("does not reveal a timeout MISS before the evaluator resolves it", () => {
    expect(classicJudgementAnimationAge(1_119, judgement())).toBe(-1);
  });

  it("starts a resolved timeout MISS at full fade-in visibility", () => {
    expect(classicJudgementAnimationAge(1_120, judgement())).toBe(OsuClassicJudgement.MISS_FADE_IN_DURATION);
    expect(classicJudgementAnimationAge(1_144, judgement())).toBe(OsuClassicJudgement.MISS_FADE_IN_DURATION);
  });

  it("keeps an explicit early MISS on its ordinary animation clock", () => {
    expect(
      classicJudgementAnimationAge(720, judgement({ time: 700, judgementTime: 700, missReason: "HIT_TOO_EARLY" })),
    ).toBe(20);
  });

  it("does not boost a receptor-assigned MISS after the nominal object time", () => {
    expect(
      classicJudgementAnimationAge(
        1_040,
        judgement({
          time: 1_020,
          judgementTime: 1_020,
          objectTime: 1_000,
          missReason: "INPUT_WINDOW_MISS",
        }),
      ),
    ).toBe(20);
  });
});
