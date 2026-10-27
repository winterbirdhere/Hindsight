import {
  Beatmap,
  BucketedGameStateTimeMachine,
  DEFAULT_BEATMAP_DIFFICULTY,
  HitCircle,
  OsuAction,
  PathType,
  Slider,
  SliderPath,
} from "../src";
import { stableWithinHitRadius, stableWithinTrackingRadius } from "../src/gameplay/StableHitGeometry";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const stableRadius = Math.fround(32 * Math.fround(1.00041));

function head() {
  const circle = new HitCircle();
  circle.id = "circle";
  circle.position = { x: 0, y: 0 };
  circle.unstackedPosition = circle.position;
  circle.scale = 0.5;
  circle.hitTime = 1000;
  circle.approachDuration = 600;
  return circle;
}

describe("Stable hit geometry precision", () => {
  it("retains the extended intermediates used by Stable's x86 hit test", () => {
    // Source-shaped .NET Framework x86 oracle: both comparisons are false.
    // Rounding every arithmetic operation to float incorrectly accepts this.
    const a = { x: 148.35336303710938, y: 44.37794876098633 };
    const b = { x: 159.5200653076172, y: 2.715118646621704 };
    const radius = 43.133358001708984;
    expect(stableWithinHitRadius(a, b, radius)).toBe(false);
    expect(stableWithinTrackingRadius(a, b, radius)).toBe(false);
  });

  it("tests the float32 cursor recorded by Stable at a circle boundary", () => {
    const circle = head();
    const map = new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const state = new BucketedGameStateTimeMachine(
      [
        { time: 0, position: { x: 0, y: 0 }, actions: [] },
        { time: 1000, position: { x: stableRadius + 1e-7, y: 0 }, actions: [OsuAction.leftButton] },
        { time: 1500, position: { x: 0, y: 0 }, actions: [] },
      ],
      map,
      options,
    ).gameStateAt(1e9);
    expect(state.hitCircleVerdict[circle.id].type).toBe("GREAT");
  });

  it("requires strict containment to acquire a slider, even when its head accepts the boundary press", () => {
    const circle = head();
    circle.id = "slider/HEAD";
    circle.sliderId = "slider";
    const slider = new Slider(circle);
    slider.id = "slider";
    slider.velocity = 1;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );
    const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const state = new BucketedGameStateTimeMachine(
      [
        { time: 0, position: { x: 0, y: 0 }, actions: [] },
        { time: 1000, position: { x: stableRadius, y: 0 }, actions: [OsuAction.leftButton] },
      ],
      map,
      options,
    ).gameStateAt(1000);
    expect(state.hitCircleVerdict[circle.id].type).toBe("GREAT");
    expect(state.sliderBodyState.get(slider.id)?.isTracking).toBe(false);
  });
});
