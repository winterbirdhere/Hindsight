import { defaultGameState, HitCircle } from "@osujs/core";
import { Skin } from "../../../../model/Skin";
import { HitCircleFactory } from "./HitCircleFactory";
import {
  CLASSIC_NOTELOCK_SHAKE_DISTANCE,
  CLASSIC_NOTELOCK_SHAKE_LEG_DURATION,
  CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION,
} from "./HitObjectVisualState";

interface MutableClock {
  timeElapsedInMs: number;
}

function hitCircleFixture() {
  const hitCircle = new HitCircle();
  hitCircle.id = "circle";
  hitCircle.hitTime = 1_000;
  hitCircle.approachDuration = 600;
  hitCircle.scale = 0.57;
  hitCircle.position = { x: 100, y: 120 };
  return hitCircle;
}

function factoryFixture(rulesetFocus: "stable" | "lazer" = "stable") {
  const clock: MutableClock = { timeElapsedInMs: 0 };
  const state = defaultGameState();
  const factory = new HitCircleFactory(
    clock as ConstructorParameters<typeof HitCircleFactory>[0],
    {
      getCurrentState: () => state,
      getRulesetFocus: () => rulesetFocus,
      getPrimaryBeatmap: () => undefined,
    } as unknown as ConstructorParameters<typeof HitCircleFactory>[1],
    { modSettings: { hidden: false } } as ConstructorParameters<typeof HitCircleFactory>[2],
    { getSkin: () => Skin.EMPTY } as ConstructorParameters<typeof HitCircleFactory>[3],
  );
  const renderAt = (hitCircle: HitCircle, time: number) => {
    clock.timeElapsedInMs = time;
    return factory.createHitCircle(hitCircle);
  };

  return { renderAt, state, factory };
}

describe("HitCircleFactory visual state", () => {
  it("reuses visible objects across unchanged frames without accumulating transforms", () => {
    const circle = hitCircleFixture();
    const { renderAt, state, factory } = factoryFixture();
    state.lastNotelockShakeTime[circle.id] = 900;
    const first = renderAt(circle, 915)!;
    const firstX = first.hitCircleArea.x;
    factory.freeResources();
    const second = renderAt(circle, 915)!;
    expect(second.hitCircleArea === first.hitCircleArea).toBe(true);
    expect(second.approachCircle === first.approachCircle).toBe(true);
    expect(second.hitCircleArea.x).toBe(firstX);
    expect(second.approachCircle.x).toBe(firstX);
  });

  it("resets pooled appearance when objects disappear then a different circle is sought", () => {
    const firstCircle = hitCircleFixture();
    const { renderAt, state, factory } = factoryFixture();
    state.lastNotelockShakeTime[firstCircle.id] = 900;
    const first = renderAt(firstCircle, 915)!;
    factory.freeResources();
    expect(renderAt(firstCircle, 2_000)).toBeUndefined();
    factory.freeResources();
    const nextCircle = hitCircleFixture();
    Object.assign(nextCircle, { id: "different", position: { x: 240, y: 320 }, scale: 0.75 });
    const next = renderAt(nextCircle, 1_000)!;
    expect(next.hitCircleArea === first.hitCircleArea).toBe(true);
    expect(next.approachCircle === first.approachCircle).toBe(true);
    expect(next.hitCircleArea.position).toMatchObject({ x: 240, y: 320 });
    expect(next.hitCircleArea.scale.x).toBe(0.75);
    expect(next.approachCircle.position).toMatchObject({ x: 240, y: 320 });
  });

  it("moves the circle and approach circle together during notelock shake", () => {
    const circle = hitCircleFixture();
    const { renderAt, state } = factoryFixture();
    state.lastNotelockShakeTime[circle.id] = 900;

    const shaken = renderAt(circle, 900 + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2);
    expect(shaken?.hitCircleArea.position.x).toBe(circle.position.x + CLASSIC_NOTELOCK_SHAKE_DISTANCE);
    expect(shaken?.approachCircle.position.x).toBe(circle.position.x + CLASSIC_NOTELOCK_SHAKE_DISTANCE);

    const settled = renderAt(circle, 900 + CLASSIC_NOTELOCK_SHAKE_TOTAL_DURATION);
    expect(settled?.hitCircleArea.position.x).toBe(circle.position.x);
    expect(settled?.approachCircle.position.x).toBe(circle.position.x);
  });

  it("keeps a Stable slider head and its approach circle stationary during notelock", () => {
    const sliderHead = hitCircleFixture();
    sliderHead.id = "slider/HEAD";
    sliderHead.sliderId = "slider";
    const { renderAt, state } = factoryFixture();
    state.lastNotelockShakeTime[sliderHead.id] = 900;

    const rendered = renderAt(sliderHead, 900 + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2);

    expect(rendered?.hitCircleArea.position.x).toBe(sliderHead.position.x);
    expect(rendered?.approachCircle.position.x).toBe(sliderHead.position.x);
  });

  it("preserves lazer's slider-head and approach-circle notelock shake", () => {
    const sliderHead = hitCircleFixture();
    sliderHead.id = "slider/HEAD";
    sliderHead.sliderId = "slider";
    const { renderAt, state } = factoryFixture("lazer");
    state.lastNotelockShakeTime[sliderHead.id] = 900;

    const rendered = renderAt(sliderHead, 900 + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2);

    expect(rendered?.hitCircleArea.position.x).toBe(sliderHead.position.x + CLASSIC_NOTELOCK_SHAKE_DISTANCE);
    expect(rendered?.approachCircle.position.x).toBe(sliderHead.position.x + CLASSIC_NOTELOCK_SHAKE_DISTANCE);
  });

  it("culls a direct early MISS at resolution but not before it", () => {
    const circle = hitCircleFixture();
    const { renderAt, state } = factoryFixture();
    state.hitCircleVerdict[circle.id] = {
      type: "MISS",
      missReason: "HIT_TOO_EARLY",
      judgementTime: 900,
    };

    expect(renderAt(circle, 899)).toBeDefined();
    expect(renderAt(circle, 900)).toBeUndefined();
  });

  it("keeps timeout and later misses on the existing nominal fade path", () => {
    const circle = hitCircleFixture();
    const { renderAt, state } = factoryFixture();
    state.hitCircleVerdict[circle.id] = {
      type: "MISS",
      missReason: "TIME_EXPIRED",
      judgementTime: 1_120,
    };
    expect(renderAt(circle, 1_120)).toBeDefined();

    state.hitCircleVerdict[circle.id] = {
      type: "MISS",
      missReason: "HIT_TOO_EARLY",
      judgementTime: 1_050,
    };
    expect(renderAt(circle, 1_050)).toBeDefined();
  });
});
