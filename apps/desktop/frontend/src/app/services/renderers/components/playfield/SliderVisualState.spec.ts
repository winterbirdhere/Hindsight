import { defaultGameState, HitCircle, PathType, Slider, SliderCheckPoint, SliderPath } from "@osujs/core";
import { sliderBallVisibleAt, sliderCheckpointVisualHit } from "./SliderVisualState";

function sliderFixture() {
  const head = new HitCircle();
  head.id = "0/HEAD";
  head.hitTime = 1_000;
  head.position = { x: 64, y: 96 };

  const slider = new Slider(head);
  slider.id = "0";
  slider.repeatCount = 1;
  slider.velocity = 1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 300, y: 0 } }], 300);

  const checkpoint = new SliderCheckPoint(slider);
  checkpoint.id = "0/0";
  checkpoint.hitTime = 1_200;
  return { slider, checkpoint };
}

describe("Stable slider visual state", () => {
  it.each([1_199, 1_201])(
    "uses the actual checkpoint resolution at %d ms, including after seeking",
    (judgementTime) => {
      const { checkpoint } = sliderFixture();
      const state = defaultGameState();
      state.checkPointVerdict[checkpoint.id] = { hit: true, judgementTime };

      expect(sliderCheckpointVisualHit(checkpoint, judgementTime - 0.01, state)).toBeNull();
      expect(sliderCheckpointVisualHit(checkpoint, judgementTime, state)).toBe(true);
      expect(sliderCheckpointVisualHit(checkpoint, judgementTime - 1, state)).toBeNull();
    },
  );

  it("removes the slider ball at the exact end so only the body cap remains", () => {
    const { slider } = sliderFixture();

    expect(sliderBallVisibleAt(slider, slider.startTime - 0.001)).toBe(false);
    expect(sliderBallVisibleAt(slider, slider.startTime)).toBe(true);
    expect(sliderBallVisibleAt(slider, slider.endTime - 0.001)).toBe(true);
    expect(sliderBallVisibleAt(slider, slider.endTime)).toBe(false);
    expect(sliderBallVisibleAt(slider, slider.endTime + 0.001)).toBe(false);
  });

  it("does not expose a checkpoint result before its judgement time", () => {
    const { checkpoint } = sliderFixture();
    const state = defaultGameState();
    state.checkPointVerdict[checkpoint.id] = { hit: true };

    expect(sliderCheckpointVisualHit(checkpoint, checkpoint.hitTime - 1, state)).toBeNull();
    expect(sliderCheckpointVisualHit(checkpoint, checkpoint.hitTime, state)).toBe(true);

    state.checkPointVerdict[checkpoint.id] = { hit: false };
    expect(sliderCheckpointVisualHit(checkpoint, checkpoint.hitTime + 1, state)).toBe(false);
    delete state.checkPointVerdict[checkpoint.id];
    expect(sliderCheckpointVisualHit(checkpoint, checkpoint.hitTime + 1, state)).toBeNull();
  });
});
