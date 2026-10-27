import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { Slider } from "../src/hitobjects/Slider";
import { SliderCheckPoint } from "../src/hitobjects/SliderCheckPoint";
import { PathType } from "../src/hitobjects/slider/PathType";
import { SliderPath } from "../src/hitobjects/slider/SliderPath";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const stableOptions = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;

function fractionalCheckpointVerdict(pressedAtStart: boolean, pressedAtNextFrame: boolean): boolean {
  const head = new HitCircle();
  head.id = "slider/HEAD";
  head.hitTime = 1_000;
  head.approachDuration = 600;
  head.position = { x: 100, y: 192 };
  head.unstackedPosition = head.position;
  head.sliderId = "slider";

  const slider = new Slider(head);
  slider.id = "slider";
  slider.velocity = 1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);

  const checkpoint = new SliderCheckPoint(slider);
  checkpoint.id = "slider/TICK";
  checkpoint.type = "TICK";
  checkpoint.hitTime = 1_049.5;
  checkpoint.spanProgress = 0.495;
  checkpoint.offset = { x: 49.5, y: 0 };
  slider.checkPoints = [checkpoint];

  const actions = (pressed: boolean) => (pressed ? [OsuAction.leftButton] : []);
  const frames: ReplayFrame[] = [
    { time: 1_000, position: slider.startPosition, actions: actions(pressedAtStart) },
    { time: 1_050, position: slider.ballPositionAt(0.5), actions: actions(pressedAtNextFrame) },
  ];
  const map = new Beatmap([slider], DEFAULT_BEATMAP_DIFFICULTY, [], new ControlPointInfo());

  return new BucketedGameStateTimeMachine(frames, map, stableOptions).gameStateAt(1_050).checkPointVerdict[
    checkpoint.id
  ].hit;
}

describe("Stable fractional checkpoint ordering", () => {
  it("observes the release in the first recorded update after a fractional checkpoint", () => {
    expect(fractionalCheckpointVerdict(true, false)).toBe(false);
  });

  it("does not apply a later press to a checkpoint immediately before the press frame", () => {
    expect(fractionalCheckpointVerdict(false, true)).toBe(false);
  });
});
