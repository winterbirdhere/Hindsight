import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { isNotelockMiss, retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { BucketedGameStateTimeMachine } from "../src/gameplay/GameStateTimeMachine";
import { HitCircle } from "../src/hitobjects/HitCircle";
import { OsuAction, ReplayFrame } from "../src/replays/Replay";

const options = { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" } as const;
const outside = { x: 500, y: 300 };

function fixture() {
  const blocker = new HitCircle();
  blocker.id = "blocker";
  blocker.hitTime = 1000;
  blocker.approachDuration = 600;
  blocker.position = { x: 100, y: 100 };
  const target = new HitCircle();
  target.id = "target";
  target.hitTime = 1005;
  target.approachDuration = 600;
  target.position = { x: 300, y: 100 };
  const beatmap = new Beatmap([blocker, target], DEFAULT_BEATMAP_DIFFICULTY, ["RELAX"], new ControlPointInfo());
  return { beatmap, blocker, target };
}

function frame(time: number, position = outside, actions: OsuAction[] = []): ReplayFrame {
  return { time, position, actions };
}

describe("Stable Relax notelock reporting", () => {
  it("reports a callback triggered by an earlier eligible parent without physical clicks", () => {
    const { beatmap, target, blocker } = fixture();
    const machine = new BucketedGameStateTimeMachine(
      [frame(900), frame(993, target.position), frame(994), frame(1300)],
      beatmap,
      options,
      1,
    );
    const final = machine.gameStateAt(1300);
    expect(final.hitCircleVerdict[target.id].type).toBe("MISS");
    expect(retrieveEvents(final, beatmap.hitObjects).filter(isNotelockMiss)).toEqual([
      expect.objectContaining({
        hitObjectId: target.id,
        notelockCause: expect.objectContaining({
          kind: "STABLE_BLOCKED_VALID_PRESS",
          blockerHitObjectId: blocker.id,
          pressTime: 993,
          wouldHaveHit: "GREAT",
        }),
      }),
    ]);
    machine.gameStateAt(900);
    expect(retrieveEvents(machine.gameStateAt(1300), beatmap.hitObjects).filter(isNotelockMiss)).toHaveLength(1);
  });

  it.each([{ actions: [] }, { actions: [OsuAction.leftButton] }])(
    "does not count hovering or manual input before Relax can auto-hit (%j)",
    ({ actions }) => {
      const { beatmap, target } = fixture();
      const state = new BucketedGameStateTimeMachine(
        [frame(900), frame(988, target.position, actions), frame(993), frame(1300)],
        beatmap,
        options,
      ).gameStateAt(1300);
      expect(state.hitCircleVerdict[target.id].type).toBe("MISS");
      expect(retrieveEvents(state, beatmap.hitObjects).filter(isNotelockMiss)).toEqual([]);
    },
  );

  it("records a blocked selected target even when only its earlier parent is inside Relax's boundary", () => {
    const { beatmap, target, blocker } = fixture();
    const state = new BucketedGameStateTimeMachine(
      [frame(900), frame(989, target.position), frame(990), frame(1300)],
      beatmap,
      options,
    ).gameStateAt(1300);
    expect(state.stableNotelockEvidence[target.id]).toMatchObject({
      blockerHitObjectId: blocker.id,
      pressTime: 989,
      wouldHaveHit: "GREAT",
    });
  });

  it("clears the notelock count when a later automatic attempt recovers the note", () => {
    const { beatmap, target, blocker } = fixture();
    const machine = new BucketedGameStateTimeMachine(
      [
        frame(900),
        frame(993, target.position),
        frame(1000, blocker.position),
        frame(1005, target.position),
        frame(1300),
      ],
      beatmap,
      options,
      1,
    );
    expect(machine.gameStateAt(993).stableNotelockEvidence[target.id]).toBeDefined();
    const final = machine.gameStateAt(1300);
    expect(final.hitCircleVerdict[target.id].type).toBe("GREAT");
    expect(retrieveEvents(final, beatmap.hitObjects).filter(isNotelockMiss)).toEqual([]);
  });

  it("does not classify an off-target Relax miss as notelock", () => {
    const { beatmap, target } = fixture();
    const state = new BucketedGameStateTimeMachine(
      [frame(900), frame(1005), frame(1300)],
      beatmap,
      options,
    ).gameStateAt(1300);
    expect(state.hitCircleVerdict[target.id].type).toBe("MISS");
    expect(retrieveEvents(state, beatmap.hitObjects).filter(isNotelockMiss)).toEqual([]);
  });
});
