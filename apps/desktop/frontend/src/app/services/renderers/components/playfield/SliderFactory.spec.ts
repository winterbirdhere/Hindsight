import { defaultGameState, HitCircle, PathType, Slider, SliderCheckPoint, SliderPath } from "@osujs/core";
import { Container, Sprite, Texture } from "pixi.js";
import { Skin } from "../../../../model/Skin";
import { SliderFactory } from "./SliderFactory";
import { CLASSIC_NOTELOCK_SHAKE_DISTANCE, CLASSIC_NOTELOCK_SHAKE_LEG_DURATION } from "./HitObjectVisualState";

interface MutableClock {
  timeElapsedInMs: number;
}

function sliderFixture({ distance = 40, repeatCount = 0 }: { distance?: number; repeatCount?: number } = {}) {
  const head = new HitCircle();
  head.id = "slider/HEAD";
  head.sliderId = "slider";
  head.hitTime = 1_000;
  head.approachDuration = 600;
  head.scale = 0.57;
  head.position = { x: 64, y: 96 };

  const slider = new Slider(head);
  slider.id = "slider";
  slider.repeatCount = repeatCount;
  slider.velocity = 1;
  slider.path = new SliderPath(
    [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: distance, y: 0 } }],
    distance,
  );

  if (repeatCount > 0) {
    const repeat = new SliderCheckPoint(slider);
    repeat.id = "slider/REPEAT-0";
    repeat.type = "REPEAT";
    repeat.spanIndex = 0;
    repeat.spanProgress = 1;
    repeat.spanStartTime = slider.startTime;
    repeat.hitTime = slider.startTime + slider.spanDuration;
    repeat.offset = { x: distance, y: 0 };
    slider.checkPoints = [repeat];
  }

  return slider;
}

function factoryFixture({
  sliderDevMode = false,
  graphicsPool,
  rulesetFocus = "stable",
}: { sliderDevMode?: boolean; graphicsPool?: object; rulesetFocus?: "stable" | "lazer" } = {}) {
  const clock: MutableClock = { timeElapsedInMs: 0 };
  const finalState = defaultGameState();
  const textureService = {
    getTexture: jest.fn(() => Texture.EMPTY),
    removeFromCache: jest.fn(),
  };
  // Construct without the production Graphics pool. PIXI's Graphics constructor
  // needs a browser canvas context, while these regressions intentionally inspect
  // only the slider's deterministic display-object geometry and visual state.
  const factory = Object.create(SliderFactory.prototype) as SliderFactory;
  Object.assign(factory as object, {
    gameClock: clock,
    gameSimulator: { getCurrentState: () => finalState, getRulesetFocus: () => rulesetFocus },
    modSettingsService: { modSettings: { hidden: false } },
    beatmapRenderSettingsStore: { settings: { sliderDevMode } },
    stageSkinService: { getSkin: () => Skin.EMPTY },
    sliderTextureService: textureService,
    ...(graphicsPool ? { graphicsPool } : {}),
  });
  const renderAt = (slider: Slider, time: number) => {
    clock.timeElapsedInMs = time;
    return factory.create(slider);
  };

  return { factory, finalState, renderAt, textureService };
}

function bodyAndTail(container: Container) {
  return {
    body: container.children[0] as Container,
    tail: container.children[1] as Container,
  };
}

describe("SliderFactory", () => {
  it("does not layer a generic hit-circle texture over the slider end cap", () => {
    const factory = Object.create(SliderFactory.prototype) as SliderFactory;
    const slider = new Slider(new HitCircle());
    const prepareSliderTail = Reflect.get(factory, "prepareSliderTail") as (
      this: SliderFactory,
      slider: Slider,
    ) => Container;

    const endpointLayer = prepareSliderTail.call(factory, slider);

    expect(endpointLayer.children).toHaveLength(0);
  });

  it("keeps a short normal slider end as a fading body cap, never a new circle layer", () => {
    const slider = sliderFixture({ distance: 40 });
    const { renderAt, textureService } = factoryFixture();

    const beforeEnd = renderAt(slider, slider.endTime - 0.001) as Container;
    const before = bodyAndTail(beforeEnd);
    expect(before.body.alpha).toBeCloseTo(1);
    expect(before.body.scale.x).toBeCloseTo(1);
    expect(before.tail.children).toHaveLength(0);
    expect(beforeEnd.children).toHaveLength(3);
    const movingBall = beforeEnd.children[2] as Container;
    expect(movingBall.children).toHaveLength(2);
    expect(movingBall.position.x).toBeCloseTo(slider.endPosition.x, 2);
    expect(movingBall.position.y).toBeCloseTo(slider.endPosition.y, 2);

    const atEnd = renderAt(slider, slider.endTime) as Container;
    const exact = bodyAndTail(atEnd);
    expect(exact.body.alpha).toBeCloseTo(1);
    expect(exact.body.scale.x).toBeCloseTo(1);
    expect(exact.tail.children).toHaveLength(0);
    expect(atEnd.children).toHaveLength(2);
    expect(atEnd.children.some((child) => child instanceof Sprite)).toBe(false);

    const duringFade = renderAt(slider, slider.endTime + 120) as Container;
    const fading = bodyAndTail(duringFade);
    expect(fading.body.alpha).toBeGreaterThan(0);
    expect(fading.body.alpha).toBeLessThan(1);
    expect(fading.body.scale.x).toBeCloseTo(1);
    expect(fading.tail.children).toHaveLength(0);
    expect(duringFade.children).toHaveLength(2);

    const afterLegacyFade = renderAt(slider, slider.endTime + 240) as Container;
    expect(bodyAndTail(afterLegacyFade).body.alpha).toBe(0);
    expect(renderAt(slider, slider.endTime + 301)).toBeUndefined();
    expect(textureService.removeFromCache).toHaveBeenCalledWith(slider.id);
  });

  it("renders one-repeat arrows with bounded scale and fades them by the final slider end", () => {
    const slider = sliderFixture({ distance: 120, repeatCount: 1 });
    const repeat = slider.checkPoints[0];
    const { finalState, renderAt } = factoryFixture();
    finalState.checkPointVerdict[repeat.id] = { hit: true, judgementTime: repeat.hitTime };

    const repeatSpriteAt = (time: number) => {
      const container = renderAt(slider, time) as Container;
      const sprites = container.children.filter((child): child is Sprite => child instanceof Sprite);
      expect(sprites).toHaveLength(1);
      return { container, sprite: sprites[0] };
    };

    const beforeRepeat = repeatSpriteAt(repeat.hitTime - 0.001).sprite;
    expect(beforeRepeat.alpha).toBeCloseTo(1);
    expect(beforeRepeat.position.x).toBe(slider.startPosition.x + 120);
    expect(beforeRepeat.position.y).toBe(slider.startPosition.y);

    const atRepeat = repeatSpriteAt(repeat.hitTime).sprite;
    expect(atRepeat.alpha).toBeCloseTo(1);
    expect(atRepeat.scale.x).toBeGreaterThanOrEqual(slider.scale);
    expect(atRepeat.scale.x).toBeLessThanOrEqual(slider.scale * 1.3 + Number.EPSILON);
    expect(atRepeat.scale.y).toBeCloseTo(atRepeat.scale.x);

    const duringRepeatFade = repeatSpriteAt(repeat.hitTime + slider.spanDuration / 2).sprite;
    expect(duringRepeatFade.alpha).toBeGreaterThan(0);
    expect(duringRepeatFade.alpha).toBeLessThan(1);

    const atSliderEnd = repeatSpriteAt(slider.endTime);
    expect(atSliderEnd.sprite.alpha).toBe(0);
    expect(
      atSliderEnd.container.children.some((child) => child instanceof Container && child.children.length === 2),
    ).toBe(false);
    expect(bodyAndTail(atSliderEnd.container).tail.children).toHaveLength(0);
  });

  it("keeps the entire slider stationary when its blocked head records a notelock rejection", () => {
    const slider = sliderFixture({ distance: 120, repeatCount: 1 });
    const tick = new SliderCheckPoint(slider);
    tick.id = "slider/TICK-0";
    tick.type = "TICK";
    tick.spanIndex = 0;
    tick.spanProgress = 0.5;
    tick.spanStartTime = slider.startTime;
    tick.hitTime = slider.startTime + slider.spanDuration / 2;
    tick.offset = { x: 60, y: 0 };
    slider.checkPoints.unshift(tick);
    const { finalState, renderAt } = factoryFixture();
    finalState.lastNotelockShakeTime[slider.head.id] = slider.startTime;

    const rejectedInputTime = slider.startTime + 15;
    const withBlockedHead = renderAt(slider, rejectedInputTime) as Container;
    delete finalState.lastNotelockShakeTime[slider.head.id];
    const withoutBlockedHead = renderAt(slider, rejectedInputTime) as Container;

    expect(withBlockedHead.children).toHaveLength(withoutBlockedHead.children.length);
    expect(withBlockedHead.children).toHaveLength(5);
    for (let index = 0; index < withBlockedHead.children.length; index++) {
      expect(withBlockedHead.children[index].position.x).toBe(withoutBlockedHead.children[index].position.x);
      expect(withBlockedHead.children[index].position.y).toBe(withoutBlockedHead.children[index].position.y);
    }
  });

  it("preserves lazer's slider-artwork shake without shifting its slider ball", () => {
    const slider = sliderFixture({ distance: 120, repeatCount: 1 });
    const tick = new SliderCheckPoint(slider);
    tick.id = "slider/TICK-0";
    tick.type = "TICK";
    tick.spanIndex = 0;
    tick.spanProgress = 0.5;
    tick.spanStartTime = slider.startTime;
    tick.hitTime = slider.startTime + slider.spanDuration / 2;
    tick.offset = { x: 60, y: 0 };
    slider.checkPoints.unshift(tick);
    const { finalState, renderAt } = factoryFixture({ rulesetFocus: "lazer" });
    finalState.lastNotelockShakeTime[slider.head.id] = slider.startTime;

    const visibleShakeTime = slider.startTime + CLASSIC_NOTELOCK_SHAKE_LEG_DURATION / 2;
    const shaken = renderAt(slider, visibleShakeTime) as Container;
    delete finalState.lastNotelockShakeTime[slider.head.id];
    const plain = renderAt(slider, visibleShakeTime) as Container;

    expect(shaken.children).toHaveLength(plain.children.length);
    expect(shaken.children).toHaveLength(5);
    for (let index = 0; index < shaken.children.length - 1; index++) {
      expect(shaken.children[index].position.x - plain.children[index].position.x).toBe(
        CLASSIC_NOTELOCK_SHAKE_DISTANCE,
      );
    }
    const ballIndex = shaken.children.length - 1;
    expect(shaken.children[ballIndex].position.x).toBe(plain.children[ballIndex].position.x);
  });

  it("restores the pooled last-legacy-tick marker to its absolute origin across renders and seeks", () => {
    const slider = sliderFixture({ distance: 40 });
    const legacyTick = new SliderCheckPoint(slider);
    legacyTick.id = "slider/LAST_LEGACY_TICK";
    legacyTick.type = "LAST_LEGACY_TICK";
    legacyTick.hitTime = slider.startTime + 100;
    legacyTick.offset = { x: 20, y: 0 };
    slider.checkPoints = [legacyTick];

    const marker = Object.assign(new Container(), {
      clear: jest.fn(),
      beginFill: jest.fn(),
      drawCircle: jest.fn(),
      endFill: jest.fn(),
    });
    const graphicsPool = {
      allocate: jest.fn(() => [marker, true]),
      releaseUntouched: jest.fn(),
    };
    const { renderAt } = factoryFixture({ sliderDevMode: true, graphicsPool });
    // Keep this marker-pool regression before tracking starts so the optional
    // slider-development ball overlays do not share this deliberately minimal mock.
    const renderTime = slider.startTime - 15;

    expect(renderAt(slider, renderTime)?.children).toContain(marker);
    expect(marker.position.x).toBe(0);

    marker.position.x = 27;
    renderAt(slider, renderTime);
    expect(marker.position.x).toBe(0);

    renderAt(slider, legacyTick.hitTime + 499);
    expect(marker.position.x).toBe(0);

    renderAt(slider, renderTime);
    expect(marker.position.x).toBe(0);
  });
});
