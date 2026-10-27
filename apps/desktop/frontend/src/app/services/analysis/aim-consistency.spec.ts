import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, HitCircle, OsuAction } from "@osujs/core";
import type { OsuReplay } from "../../model/OsuReplay";
import { collectReplayAimEvidence } from "./aim-consistency";

function fixture() {
  const circle = new HitCircle();
  circle.id = "0";
  circle.hitTime = 1_000;
  circle.position = { x: 100, y: 100 };
  const beatmap = new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
  const replay: OsuReplay = {
    md5hash: "replay",
    beatmapMd5: "map",
    gameMode: 0,
    gameVersion: 1,
    mods: [],
    player: "Player",
    frames: [
      { time: 990, position: { x: 80, y: 100 }, actions: [] },
      { time: 1_010, position: { x: 120, y: 100 }, actions: [OsuAction.leftButton] },
    ],
  };
  return { circle, beatmap, replay };
}

describe("collectReplayAimEvidence", () => {
  it("uses the cursor at an explicitly assigned successful judgement time", () => {
    const { circle, beatmap, replay } = fixture();
    const evidence = collectReplayAimEvidence(beatmap, replay, [
      {
        type: "HitObjectJudgement",
        eventId: "stable:hit-object-judgement:0",
        ruleset: "stable",
        hitObjectId: circle.id,
        verdict: "GREAT",
        time: 1_000,
        objectTime: 1_000,
        judgementTime: 1_000,
        position: circle.position,
      },
    ]);

    expect(evidence.eligibleEventCount).toBe(1);
    expect(evidence.samples).toEqual([
      expect.objectContaining({ hitObjectId: "0", time: 1_000, distance: 0, objectRadius: circle.radius }),
    ]);
  });

  it("does not claim manual aim consistency for Autoplay", () => {
    const { beatmap, replay } = fixture();
    replay.mods = ["AUTO_PLAY"];

    expect(collectReplayAimEvidence(beatmap, replay, [])).toMatchObject({
      samples: [],
      unavailableReason: expect.stringContaining("automated"),
    });
  });

  it.each([
    { releaseX: 200, sampleCount: 0 },
    { releaseX: 100, sampleCount: 1 },
  ])(
    "omits ambiguous assigned-press positions but retains matching samples ($releaseX)",
    ({ releaseX, sampleCount }) => {
      const { circle, beatmap, replay } = fixture();
      replay.frames = [
        { time: 999, position: circle.position, actions: [] },
        { time: 1_000, position: circle.position, actions: [OsuAction.leftButton] },
        { time: 1_000, position: { x: releaseX, y: 100 }, actions: [] },
        { time: 1_100, position: { x: releaseX, y: 100 }, actions: [] },
      ];

      const evidence = collectReplayAimEvidence(beatmap, replay, [
        {
          type: "HitObjectJudgement",
          eventId: "stable:hit-object-judgement:0",
          ruleset: "stable",
          hitObjectId: circle.id,
          verdict: "GREAT",
          time: 1_000,
          objectTime: 1_000,
          judgementTime: 1_000,
          position: circle.position,
        },
      ]);

      expect(evidence.eligibleEventCount).toBe(1);
      expect(evidence.samples).toHaveLength(sampleCount);
      for (const sample of evidence.samples) expect(sample.distance).toBe(0);
    },
  );

  it("excludes header-recovered hits whose exact cursor sample is not trustworthy", () => {
    const { circle, beatmap, replay } = fixture();
    const evidence = collectReplayAimEvidence(
      beatmap,
      replay,
      [
        {
          type: "HitObjectJudgement",
          eventId: "stable:hit-object-judgement:0",
          ruleset: "stable",
          hitObjectId: circle.id,
          verdict: "OK",
          time: 1_000,
          objectTime: 1_000,
          judgementTime: 1_000,
          position: circle.position,
        },
      ],
      new Set([circle.id]),
    );

    expect(evidence).toMatchObject({ samples: [], eligibleEventCount: 0 });
  });
});
