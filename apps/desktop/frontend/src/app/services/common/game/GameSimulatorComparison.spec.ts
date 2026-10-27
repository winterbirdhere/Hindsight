import {
  Beatmap,
  DEFAULT_BEATMAP_DIFFICULTY,
  GameplayInfoEvaluator,
  HitCircle,
  OsuAction,
  PathType,
  Slider,
  SliderPath,
  Spinner,
} from "@osujs/core";
import type { OsuReplay } from "../../../model/OsuReplay";
import { GameSimulator } from "./GameSimulator";

function fixtureBeatmap() {
  const circle = new HitCircle();
  circle.id = "0";
  circle.hitTime = 1_000;
  circle.approachDuration = 600;
  circle.position = { x: 256, y: 192 };
  return {
    circle,
    beatmap: new Beatmap([circle], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo),
  };
}

function lazerComparisonFixtureBeatmap() {
  const head = new HitCircle();
  head.id = "slider/HEAD";
  head.sliderId = "slider";
  head.hitTime = 1_000;
  head.approachDuration = 600;
  head.position = { x: 200, y: 192 };
  head.unstackedPosition = head.position;
  const slider = new Slider(head);
  slider.id = "slider";
  slider.velocity = 1;
  slider.path = new SliderPath([{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }], 100);

  const spinner = new Spinner();
  spinner.id = "spinner";
  spinner.startTime = 1_300;
  spinner.duration = 100;
  spinner.spinsRequired = 0;

  return {
    slider,
    spinner,
    beatmap: new Beatmap([slider, spinner], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo),
  };
}

function replay(id: string, player: string, pressTime: number, beatmapMd5 = "same-map"): OsuReplay {
  return {
    md5hash: id,
    beatmapMd5,
    gameMode: 0,
    gameVersion: 20200101,
    mods: [],
    player,
    frames: [
      { time: 0, position: { x: 256, y: 192 }, actions: [] },
      { time: pressTime, position: { x: 256, y: 192 }, actions: [OsuAction.leftButton] },
      { time: pressTime + 1, position: { x: 256, y: 192 }, actions: [] },
      { time: 1_500, position: { x: 256, y: 192 }, actions: [] },
    ],
  };
}

function noInputReplay(id: string, player: string): OsuReplay {
  return {
    md5hash: id,
    beatmapMd5: "same-map",
    gameMode: 0,
    gameVersion: 20200101,
    mods: [],
    player,
    frames: [
      { time: 0, position: { x: 256, y: 192 }, actions: [] },
      { time: 1_500, position: { x: 256, y: 192 }, actions: [] },
    ],
  };
}

function lazerSliderSpinnerReplay(id: string, player: string, hitSliderHead: boolean): OsuReplay {
  const sliderPosition = { x: 200, y: 192 };
  const frames = [{ time: 0, position: sliderPosition, actions: [] as OsuAction[] }];
  if (hitSliderHead) {
    frames.push(
      { time: 1_000, position: sliderPosition, actions: [OsuAction.leftButton] },
      { time: 1_001, position: sliderPosition, actions: [] },
    );
  }
  frames.push({ time: 1_500, position: { x: 256, y: 192 }, actions: [] });
  return {
    md5hash: id,
    beatmapMd5: "same-map",
    gameMode: 0,
    gameVersion: 30_000_016,
    mods: [],
    player,
    frames,
  };
}

function withHeader(value: OsuReplay, counts: [number, number, number, number], maxCombo = 1): OsuReplay {
  const [count300, count100, count50, countMiss] = counts;
  return {
    ...value,
    statistics: {
      count300,
      count100,
      count50,
      countMiss,
      maxCombo,
      score: 123_456,
      perfectCombo: countMiss === 0,
    },
  };
}

describe("GameSimulator replay comparisons", () => {
  it("freezes Stable scoring at terminal failure while trailing replay frames continue", () => {
    const circles = [1_000, 1_300, 1_600].map((hitTime, index) => {
      const object = new HitCircle();
      object.id = `failed-${index}`;
      object.hitTime = hitTime;
      object.approachDuration = 600;
      object.position = { x: 256, y: 192 };
      return object;
    });
    const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const source = withHeader(
      {
        ...replay("failed-stable", "Failed Stable", 1_000),
        frames: [
          { time: 0, position: circles[0].position, actions: [] },
          { time: 1_000, position: circles[0].position, actions: [OsuAction.leftButton] },
          { time: 1_001, position: circles[0].position, actions: [] },
          { time: 1_460, position: circles[1].position, actions: [] },
          { time: 2_000, position: circles[2].position, actions: [] },
        ],
        lifeBar: [
          { time: 1_001, health: 0.5 },
          { time: 1_460, health: 0 },
        ],
      },
      [1, 0, 0, 1],
      1,
    );
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, source);

    simulator.simulate(1_200);
    expect(simulator.getCurrentInfo()).toMatchObject({ verdictCounts: [1, 0, 0, 0], currentCombo: 1 });

    simulator.simulate(1_460);
    const failedInfo = simulator.getCurrentInfo();
    const failedStats = simulator.getCurrentScoreStats();
    expect(failedInfo).toMatchObject({ verdictCounts: [1, 0, 0, 1], maxComboSoFar: 1 });
    expect(failedStats).toMatchObject({ countMiss: 1, maxComboSoFar: 1 });

    simulator.simulate(2_000);
    expect(simulator.getCurrentState()?.currentTime).toBe(1_460);
    expect(simulator.getCurrentInfo()).toEqual(failedInfo);
    expect(simulator.getCurrentScoreStats()).toEqual(failedStats);
    expect(simulator.hits).toHaveLength(2);
    expect(simulator.getEventsForRuleset("stable")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ hitObjectId: circles[2].id })]),
    );

    simulator.simulate(1_200);
    expect(simulator.getCurrentScoreStats().countMiss).toBe(0);
    simulator.simulate(2_000);
    expect(simulator.getCurrentScoreStats()).toEqual(failedStats);
  });

  it("uses native source totals when a failed lazer replay has no life-bar timestamp", () => {
    const circles = [1_000, 1_300, 1_600].map((hitTime, index) => {
      const object = new HitCircle();
      object.id = `failed-lazer-${index}`;
      object.hitTime = hitTime;
      object.approachDuration = 600;
      object.position = { x: 256, y: 192 };
      return object;
    });
    const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const source = withHeader(
      {
        ...noInputReplay("failed-lazer", "Failed Lazer"),
        gameVersion: 30_000_016,
        frames: [
          { time: 0, position: circles[0].position, actions: [] },
          { time: 2_000, position: circles[2].position, actions: [] },
        ],
        lazerScoreMetadata: { statistics: { miss: 1 }, rank: "F" },
      },
      [0, 0, 0, 1],
      0,
    );
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, source);

    simulator.simulate(2_000);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([0, 0, 0, 1]);
    expect(simulator.getCurrentScoreStats().countMiss).toBe(1);
    expect(simulator.getEventsForRuleset("lazer")).toHaveLength(1);

    expect(simulator.setRulesetFocus("stable")).toBe(true);
    simulator.simulate(2_000);
    expect(simulator.getCurrentScoreStats().countMiss).toBe(0);
    expect(simulator.getEventsForRuleset("stable")).toHaveLength(0);
  });

  it("ignores No Fail health zeroes and uses the last unrecovered Easy zero", () => {
    const circles = [1_000, 1_400, 1_800].map((hitTime, index) => {
      const object = new HitCircle();
      object.id = `health-${index}`;
      object.hitTime = hitTime;
      object.approachDuration = 600;
      object.position = { x: 256, y: 192 };
      return object;
    });
    const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const base = {
      ...noInputReplay("health", "Health"),
      frames: [
        { time: 0, position: circles[0].position, actions: [] },
        { time: 2_100, position: circles[2].position, actions: [] },
      ],
    };

    const noFail = new GameSimulator();
    noFail.simulateReplay(
      beatmap,
      withHeader(
        {
          ...base,
          mods: ["NO_FAIL"],
          lifeBar: [{ time: 1_200, health: 0 }],
        },
        [0, 0, 0, 3],
        0,
      ),
    );
    noFail.simulate(2_100);
    expect(noFail.getCurrentScoreStats().countMiss).toBe(3);

    const easy = new GameSimulator();
    easy.simulateReplay(
      beatmap,
      withHeader(
        {
          ...base,
          mods: ["EASY"],
          lifeBar: [
            { time: 1_200, health: 0 },
            { time: 1_250, health: 0.5 },
            { time: 1_600, health: 0 },
          ],
        },
        [0, 0, 0, 2],
        0,
      ),
    );
    easy.simulate(2_100);
    expect(easy.getCurrentState()?.currentTime).toBe(1_600);
    expect(easy.getCurrentScoreStats().countMiss).toBe(2);
  });

  it("does not create Stable or lazer slider misses after the failure boundary", () => {
    const fatalCircle = new HitCircle();
    fatalCircle.id = "fatal-circle";
    fatalCircle.hitTime = 1_000;
    fatalCircle.approachDuration = 600;
    fatalCircle.position = { x: 256, y: 192 };
    const sliderHead = new HitCircle();
    sliderHead.id = "post-fail-slider/head";
    sliderHead.sliderId = "post-fail-slider";
    sliderHead.hitTime = 1_300;
    sliderHead.approachDuration = 600;
    sliderHead.position = { x: 200, y: 192 };
    sliderHead.unstackedPosition = sliderHead.position;
    const slider = new Slider(sliderHead);
    slider.id = "post-fail-slider";
    slider.velocity = 1;
    slider.path = new SliderPath(
      [{ type: PathType.Linear, offset: { x: 0, y: 0 } }, { offset: { x: 100, y: 0 } }],
      100,
    );
    const beatmap = new Beatmap(
      [fatalCircle, slider],
      DEFAULT_BEATMAP_DIFFICULTY,
      [],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
    );
    const source = withHeader(
      {
        ...noInputReplay("failed-before-slider", "Failed Before Slider"),
        frames: [
          { time: 0, position: fatalCircle.position, actions: [] },
          { time: 1_160, position: fatalCircle.position, actions: [] },
          { time: 2_000, position: sliderHead.position, actions: [] },
        ],
        lifeBar: [{ time: 1_160, health: 0 }],
      },
      [0, 0, 0, 1],
      0,
    );
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, source);

    simulator.simulate(2_000);
    expect(simulator.getCurrentScoreStats()).toMatchObject({
      countMiss: 1,
      sliderBreakCount: 0,
      sliderEndMissCount: 0,
    });
    expect(simulator.getEventsForRuleset("stable")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sliderId: slider.id })]),
    );

    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    simulator.simulate(2_000);
    expect(simulator.getCurrentScoreStats()).toMatchObject({ sliderTickMissCount: 0, sliderEndMissCount: 0 });
    expect(simulator.getEventsForRuleset("lazer")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sliderId: slider.id })]),
    );
  });

  it("keeps live and final Stable maximum combo reconstructed when the source maximum differs", () => {
    const circles = [1_000, 1_100, 1_200].map((hitTime, index) => {
      const circle = new HitCircle();
      circle.id = `combo-${index}`;
      circle.hitTime = hitTime;
      circle.approachDuration = 600;
      circle.position = { x: 256, y: 192 };
      return circle;
    });
    const beatmap = new Beatmap(circles, DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const sourceReplay = withHeader(
      {
        ...replay("combo-source", "Combo Source", 1_000),
        frames: [
          { time: 0, position: circles[0].position, actions: [] },
          { time: 1_000, position: circles[0].position, actions: [OsuAction.leftButton] },
          { time: 1_001, position: circles[0].position, actions: [] },
          { time: 1_100, position: circles[1].position, actions: [OsuAction.leftButton] },
          { time: 1_101, position: circles[1].position, actions: [] },
          { time: 1_500, position: circles[2].position, actions: [] },
        ],
      },
      [2, 0, 0, 1],
      1,
    );
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, sourceReplay);

    expect(simulator.validation$.getValue()).toMatchObject({
      verified: false,
      judgementTotalsMatch: true,
      missCountMatch: true,
      maxComboMatch: false,
      expectedMaxCombo: 1,
      simulatedMaxCombo: 2,
    });

    simulator.simulate(1_100);
    const currentState = simulator.getCurrentState();
    if (!currentState) throw new Error("Expected a live Stable state");
    const rawLiveInfo = new GameplayInfoEvaluator(beatmap).evaluateReplayState(currentState);
    expect(rawLiveInfo).toMatchObject({ currentCombo: 2, maxComboSoFar: 2 });
    expect(simulator.getCurrentInfo()).toMatchObject({ currentCombo: 2, maxComboSoFar: 2 });
    expect(simulator.getCurrentScoreStats().maxComboSoFar).toBe(2);

    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    simulator.simulate(1_100);
    expect(simulator.getCurrentInfo()).toMatchObject({ currentCombo: 2, maxComboSoFar: 2 });
    expect(simulator.getCurrentScoreStats().maxComboSoFar).toBe(2);

    expect(simulator.setRulesetFocus("stable")).toBe(true);

    simulator.simulate(1_500);
    expect(simulator.getCurrentInfo()).toMatchObject({ verdictCounts: [2, 0, 0, 1], maxComboSoFar: 2 });
    expect(simulator.getFinalInfoForRuleset("stable")).toMatchObject({
      verdictCounts: [2, 0, 0, 1],
      maxComboSoFar: 2,
    });
    expect(simulator.getFinalScoreStatsForRuleset("stable")?.maxComboSoFar).toBe(2);
  });

  it("exposes replay spinner rotation without clock-rate visual overrotation", () => {
    const spinner = new Spinner();
    spinner.id = "visual-spinner";
    spinner.startTime = 1_000;
    spinner.duration = 1_000;
    spinner.spinsRequired = 1;
    const beatmap = new Beatmap(
      [spinner],
      DEFAULT_BEATMAP_DIFFICULTY,
      ["DOUBLE_TIME"],
      Beatmap.EMPTY_BEATMAP.controlPointInfo,
    );
    const simulator = new GameSimulator();
    const spinningReplay: OsuReplay = {
      md5hash: "spinner-visual",
      beatmapMd5: "same-map",
      gameMode: 0,
      gameVersion: 20200101,
      mods: ["DOUBLE_TIME"],
      player: "Spinner Player",
      frames: [
        { time: 1_000, position: { x: 256, y: 292 }, actions: [OsuAction.leftButton] },
        { time: 1_100, position: { x: 156, y: 192 }, actions: [OsuAction.leftButton] },
        { time: 1_200, position: { x: 256, y: 92 }, actions: [OsuAction.leftButton] },
        { time: 1_300, position: { x: 356, y: 192 }, actions: [OsuAction.leftButton] },
        { time: 2_000, position: { x: 356, y: 192 }, actions: [] },
      ],
    };

    simulator.simulateReplay(beatmap, spinningReplay);
    simulator.simulate(1_150);

    // The first sparse input starts acceleration. The preview advances body
    // physics to 1150 without consuming input or changing the scored snapshot.
    // Rotation is independently checked by the x86 synthetic scheduling oracle.
    expect(simulator.getCurrentState()?.currentTime).toBe(1_100);
    expect(simulator.getCurrentSpinnerVisualState(spinner).rotationDegrees).toBeCloseTo(63.92374);

    simulator.simulate(1_300);

    const stableVisual = simulator.getCurrentSpinnerVisualState(spinner);
    expect(stableVisual.rotationDegrees).toBeCloseTo(257.53083);
    expect(stableVisual.progress).toBeCloseTo(0.429218);

    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    simulator.simulate(1_150);
    expect(simulator.getCurrentState()?.currentTime).toBe(1_150);
    expect(simulator.getCurrentSpinnerVisualState(spinner).rotationDegrees).toBeCloseTo(135);

    simulator.simulate(1_300);
    expect(simulator.getCurrentState()?.spinnerState.get(spinner.id)?.totalAccumulatedRotation).toBe(405);
    expect(simulator.getCurrentSpinnerVisualState(spinner)).toEqual({ rotationDegrees: 270, progress: 1 });
  });

  it("switches playback state, events, HUD info, hit offsets, and ruleset-owned validation", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    const primary = withHeader(replay("primary", "Primary", 1_049.25), [0, 1, 0, 0]);
    simulator.simulateReplay(beatmap, primary);
    simulator.simulate(1_049.25);

    const stableValidation = simulator.validation$.getValue();
    const stableEvents = simulator.getStableEvents();
    const exactPlaybackTime = simulator.getCurrentState()?.currentTime;
    expect(stableValidation.verified).toBe(true);
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([0, 1, 0, 0]);

    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.replayEvents$.getValue()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleset: "lazer", hitObjectId: "0", verdict: "GREAT" })]),
    );
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([1, 0, 0, 0]);
    expect(simulator.hits[0][1]).toBe(49.25);
    expect(simulator.getCurrentState()?.currentTime).toBe(exactPlaybackTime);
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: false,
      simulatedCounts: [1, 0, 0, 0],
    });
    expect(simulator.getStableEvents()).toBe(stableEvents);

    expect(simulator.setRulesetFocus("stable")).toBe(true);
    expect(simulator.replayEvents$.getValue()).toBe(stableEvents);
    expect(simulator.validation$.getValue()).toBe(stableValidation);
    expect(simulator.getCurrentInfo().verdictCounts).toEqual([0, 1, 0, 0]);
    expect(simulator.getCurrentState()?.currentTime).toBe(exactPlaybackTime);
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
  });

  it("defaults a lazer-format replay to lazer playback and preserves manual switch time", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    const primary = withHeader(
      { ...replay("lazer-primary", "Lazer Player", 1_049.25), gameVersion: 30_000_016 },
      [1, 0, 0, 0],
    );

    simulator.simulateReplay(beatmap, primary);
    expect(simulator.getRulesetFocus()).toBe("lazer");
    expect(simulator.replayEvents$.getValue()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleset: "lazer", hitObjectId: "0" })]),
    );
    expect(simulator.validation$.getValue()).toMatchObject({
      verified: true,
      simulatedCounts: [1, 0, 0, 0],
    });

    simulator.simulate(1_049.25);
    const exactPlaybackTime = simulator.getCurrentState()?.currentTime;
    expect(simulator.setRulesetFocus("stable")).toBe(true);
    expect(simulator.getCurrentState()?.currentTime).toBe(exactPlaybackTime);
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(simulator.getCurrentState()?.currentTime).toBe(exactPlaybackTime);
  });

  it("keeps a Stable date-version replay in Stable mode", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();

    simulator.simulateReplay(beatmap, replay("stable-primary", "Stable Player", 1_000));

    expect(simulator.getRulesetFocus()).toBe("stable");
  });

  it.each<Partial<OsuReplay>>([{ gameMode: 3 }])(
    "disables Lazer analysis after replacing a supported replay with unsupported settings %o",
    (unsupportedSettings) => {
      const { beatmap } = fixtureBeatmap();
      const simulator = new GameSimulator();
      const primary = replay("primary", "Primary", 1_000);
      expect(simulator.lazerAvailable$.getValue()).toBe(false);

      simulator.simulateReplay(beatmap, primary);
      expect(simulator.lazerAvailable$.getValue()).toBe(true);
      expect(simulator.setRulesetFocus("lazer")).toBe(true);

      const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        simulator.simulateReplay(beatmap, { ...primary, ...unsupportedSettings });
      } finally {
        warning.mockRestore();
      }
      expect(simulator.lazerAvailable$.getValue()).toBe(false);
      expect(simulator.getRulesetFocus()).toBe("stable");
      expect(simulator.getEventsForRuleset("lazer")).toEqual([]);
      expect(simulator.getFinalInfoForRuleset("lazer")).toBeUndefined();
      expect(simulator.setRulesetFocus("lazer")).toBe(false);

      simulator.simulateReplay(beatmap, primary);
      expect(simulator.lazerAvailable$.getValue()).toBe(true);
      expect(simulator.setRulesetFocus("lazer")).toBe(true);
      simulator.clear();
      expect(simulator.lazerAvailable$.getValue()).toBe(false);
      expect(simulator.setRulesetFocus("lazer")).toBe(false);
    },
  );

  it("keeps the primary simulation and builds an independent replay comparison", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay("primary", "Primary", 1_050));

    const state = simulator.compareReplay(beatmap, replay("secondary", "Secondary", 1_000));

    expect(state.status).toBe("READY");
    if (state.status !== "READY") return;
    expect(state.ruleset).toBe("stable");
    expect(state.primary.label).toBe("Primary");
    expect(state.secondary.label).toBe("Secondary");
    expect(state.result.differences).toEqual([
      expect.objectContaining({
        hitObjectId: "0",
        primaryVerdict: "OK",
        secondaryVerdict: "GREAT",
      }),
    ]);
    expect(simulator.replayEvents$.getValue()).toEqual(
      expect.arrayContaining([expect.objectContaining({ hitObjectId: "0", verdict: "OK" })]),
    );
  });

  it("builds a ruleset-bound native Lazer comparison with slider-head and spinner anchors", () => {
    const { beatmap, slider, spinner } = lazerComparisonFixtureBeatmap();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, lazerSliderSpinnerReplay("primary", "Primary", true));
    const primaryEvents = simulator.getEventsForRuleset("lazer");
    expect(simulator.getRulesetFocus()).toBe("lazer");
    const capturedRuleset = simulator.getRulesetFocus();
    expect(simulator.setRulesetFocus("stable")).toBe(true);

    const state = simulator.compareReplay(
      beatmap,
      lazerSliderSpinnerReplay("secondary", "Secondary", false),
      capturedRuleset,
    );

    expect(state.status).toBe("READY");
    if (state.status !== "READY") return;
    expect(state.ruleset).toBe("lazer");
    expect(state.result.ruleset).toBe("lazer");
    expect(state.result.joinedJudgements.map((judgement) => judgement.hitObjectId)).toEqual([
      slider.head.id,
      spinner.id,
    ]);
    expect(state.result.differences).toEqual([
      expect.objectContaining({
        hitObjectId: slider.head.id,
        primaryVerdict: "GREAT",
        secondaryVerdict: "MISS",
      }),
    ]);
    expect(state.result.primarySummary).toMatchObject({
      counts: { count300: 2, count100: 0, count50: 0, countMiss: 0 },
      sliderBreakCount: 0,
      maxComboInput: 2,
    });
    expect(state.result.secondarySummary).toMatchObject({
      counts: { count300: 1, count100: 0, count50: 0, countMiss: 1 },
      sliderBreakCount: 0,
      maxComboInput: 1,
    });
    expect(state.result.joinedSliderBreaks).toEqual([]);
    expect(state.result.participantLimitations.primary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LAZER_NESTED_COMPONENT_DIFFERENCES_OMITTED",
          message: expect.stringContaining("native lazer SliderEnd judgement"),
        }),
      ]),
    );
    expect(simulator.getEventsForRuleset("lazer")).toBe(primaryEvents);

    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(simulator.replayComparison$.getValue()).toBe(state);
    expect((simulator.replayComparison$.getValue() as typeof state).ruleset).toBe("lazer");
  });

  it("rejects a comparison replay from a different beatmap", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay("primary", "Primary", 1_000));

    const state = simulator.compareReplay(beatmap, replay("secondary", "Secondary", 1_000, "other-map"));

    expect(state).toMatchObject({ status: "ERROR", sourceKind: "replay" });
  });

  it("creates an analytic Autoplay participant without inventing physical input", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, replay("primary", "Primary", 1_050));

    const state = simulator.compareAutoplayReference();

    expect(state.status).toBe("READY");
    if (state.status !== "READY") return;
    expect(state.secondary.kind).toBe("autoplay-reference");
    expect(state.result.physicalInputs.secondary.available).toBe(false);
    expect(state.result.participantLimitations.secondary).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ANALYTIC_REFERENCE_ONLY" })]),
    );
  });

  it("carries primary and secondary replay-header validation into a ready comparison", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    simulator.simulateReplay(beatmap, withHeader(replay("primary", "Primary", 1_050), [0, 1, 0, 0]));

    const state = simulator.compareReplay(
      beatmap,
      // Deliberately claim a 300 while the replay input reconstructs an OK.
      withHeader(replay("secondary", "Secondary", 1_050), [1, 0, 0, 0]),
    );

    expect(state.status).toBe("READY");
    if (state.status !== "READY") return;
    expect(state.validations.primary.verified).toBe(true);
    expect(state.validations.secondary?.verified).toBe(false);
    expect(state.result.participantLimitations.secondary).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SIMULATION_NOT_VERIFIED" })]),
    );
  });

  it("validates reconstructed Stable spinner results without a stale omission warning", () => {
    const spinner = new Spinner();
    spinner.id = "stable-spinner";
    spinner.startTime = 1_000;
    spinner.duration = 100;
    spinner.spinsRequired = 0;
    const beatmap = new Beatmap([spinner], DEFAULT_BEATMAP_DIFFICULTY, [], Beatmap.EMPTY_BEATMAP.controlPointInfo);
    const simulator = new GameSimulator();

    simulator.simulateReplay(beatmap, withHeader(noInputReplay("spinner-primary", "Spinner Player"), [1, 0, 0, 0], 1));

    expect(simulator.validation$.getValue()).toMatchObject({ verified: true, warnings: [] });
    expect(simulator.getEventsForRuleset("stable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hitObjectId: spinner.id, verdict: "GREAT", ruleset: "stable" }),
      ]),
    );
  });

  it("rejects an Autoplay comparison when the primary ruleset is unknown", () => {
    const { beatmap } = fixtureBeatmap();
    const simulator = new GameSimulator();
    const primary = replay("primary", "Primary", 1_000);
    primary.gameMode = undefined;
    simulator.simulateReplay(beatmap, primary);

    expect(simulator.compareAutoplayReference()).toMatchObject({
      status: "ERROR",
      sourceKind: "autoplay-reference",
    });
  });
});
