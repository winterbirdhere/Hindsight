import { Container, Sprite, Texture } from "pixi.js";
import { OsuClassicAccuracy, OsuClassicNumber } from "@rewind/osu-pixi/classic-components";
import { ForegroundHUDPreparer } from "./ForegroundHUDPreparer";
import { hitWindowsForOD } from "@osujs/math";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { analyzeFullMap } from "../../../analysis/full-map-analysis";
import type { ReplayAnalysisRuleset } from "@osujs/core";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../../../analysis/replay-display-settings";
import { mean, standardDeviation } from "simple-statistics";

describe("native UR in the live HUD", () => {
  function fixture(baseRate: number, initialRuleset: ReplayAnalysisRuleset) {
    const clock = new GameplayClock();
    clock.setDuration(5000);
    clock.setBaseRate(baseRate);
    clock.seekTo(3000);
    let ruleset = initialRuleset;
    const hits: [number, number, boolean][] = [
      [1000, -15, true],
      [2000, 15, true],
      [2500, 999, false],
      [3000, 45, true],
      [4000, 60, true],
    ];
    const stats = new Container() as Container & { text: string };
    const displaySettings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS };
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      stats,
      gameplayClock: clock,
      beatmapManager: { getBeatmap: () => ({ gameClockRate: baseRate, difficulty: { overallDifficulty: 5 } }) },
      gameSimulator: { hits, getRulesetFocus: () => ruleset, getCurrentState: () => ({}) },
      hitErrorBar: { prepare: jest.fn(), container: new Container() },
      replayDisplaySettingsStore: { settings: displaySettings },
      allHits: [],
      recentHits: [],
    });
    const render = () => {
      hud.updateHitErrorBar();
      (hud as unknown as { updateStats(): void }).updateStats();
      return stats.text;
    };
    return {
      hud,
      hits,
      clock,
      displaySettings,
      render,
      setRuleset: (value: ReplayAnalysisRuleset) => {
        ruleset = value;
      },
    };
  }

  it.each<[ReplayAnalysisRuleset, number]>([
    ["stable", 1],
    ["stable", 1.5],
    ["stable", 0.75],
    ["lazer", 1],
    ["lazer", 1.5],
    ["lazer", 0.75],
    ["lazer", 1.2],
    ["lazer", 0.65],
    ["lazer", 1.01],
    ["lazer", 2],
    ["lazer", 0.5],
    ["lazer", 0.99],
  ])("matches the full-map %s UR at rate %s using the same successful prefix", (ruleset, rate) => {
    const { hud, hits, render } = fixture(rate, ruleset);
    const expectedUr = (Math.sqrt(600) * 10) / (ruleset === "lazer" ? rate : 1);
    // Miss offsets and future hits cannot influence the live statistic.
    expect(render()).toBe(`UR ${expectedUr.toFixed(1)}  ·  BIAS +${(15 / rate).toFixed(1)} ms`);
    expect(hud.allHits).toEqual([-15 / rate, 15 / rate, 45 / rate]);
    const summary = analyzeFullMap({
      ruleset,
      events: [],
      hits: hits.filter(([time]) => time <= 3000),
      duration: 3000,
      baseRate: rate,
    });
    expect(summary.timing.unstableRate).toBeCloseTo(expectedUr);
    expect(summary.timing.sampleCount).toBe(3);
    expect(summary.timing.averageUr.at(-1)?.unstableRate).toBeCloseTo(expectedUr);
    expect(summary.timing.urOverTime.at(-1)?.unstableRate).toBeCloseTo(expectedUr);
  });

  it.each([1.2, 0.65])("keeps rate %s UR independent of viewer speed, seeks and ruleset switching", (rate) => {
    const { clock, render, setRuleset } = fixture(rate, "lazer");
    const original = render();
    for (const speed of [0.5, 2]) {
      clock.setSpeed(speed);
      expect(clock.playbackRate).toBe(rate * speed);
      expect(render()).toBe(original);
    }
    clock.seekTo(0);
    expect(render()).toBe("UR —  ·  BIAS —");
    clock.seekTo(1500);
    expect(render()).toBe(`UR 0.0  ·  BIAS -${(15 / rate).toFixed(1)} ms`);
    clock.seekTo(3000);
    expect(render()).toBe(original);
    setRuleset("stable");
    expect(render()).toBe(`UR ${(Math.sqrt(600) * 10).toFixed(1)}  ·  BIAS +${(15 / rate).toFixed(1)} ms`);
    setRuleset("lazer");
    expect(render()).toBe(original);
  });

  it("can show UR and bias independently without leaving a separator", () => {
    const { displaySettings, render } = fixture(1, "stable");

    displaySettings.unstableRateEnabled = false;
    expect(render()).toBe("BIAS +15.0 ms");

    displaySettings.unstableRateEnabled = true;
    displaySettings.timingBiasEnabled = false;
    expect(render()).toBe(`UR ${(Math.sqrt(600) * 10).toFixed(1)}`);
  });

  it("draws the hit-error bar at the anchor of the current stage frame", () => {
    const { hud } = fixture(1, "stable");
    hud.setHudAnchors({ accuracy: { x: 1160, y: 25 }, combo: { x: 0, y: 850 }, hitErrorBar: { x: 587.6, y: 880 } });
    hud.updateHitErrorBar();
    expect(hud.hitErrorBar.container.position.x).toBeCloseTo(587.6);
    expect(hud.hitErrorBar.container.position.y).toBe(880);
  });
});

describe("ForegroundHUDPreparer number reuse", () => {
  it.each(["stable", "lazer"] as const)("uses %s hit windows for fractional Difficulty Adjust OD", (ruleset) => {
    const prepare = jest.fn();
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      gameplayClock: { timeElapsedInMs: 1000 },
      beatmapManager: { getBeatmap: () => ({ gameClockRate: 1.2, difficulty: { overallDifficulty: 8.37 } }) },
      gameSimulator: { hits: [[1000, 12, true]], getRulesetFocus: () => ruleset },
      hitErrorBar: { prepare, container: new Container() },
      replayDisplaySettingsStore: { settings: DEFAULT_REPLAY_DISPLAY_SETTINGS },
      allHits: [],
      recentHits: [],
    });
    hud.updateHitErrorBar();
    const [hitWindow300, hitWindow100, hitWindow50] = hitWindowsForOD(8.37, ruleset === "lazer");
    expect(prepare).toHaveBeenCalledWith({
      hitWindow300,
      hitWindow100,
      hitWindow50,
      hits: [{ timeAgo: 0, offset: 12, miss: false }],
    });
  });

  it("reuses display objects across frames while updating score values and skin textures", () => {
    const textures = Array.from({ length: 10 }, () => Texture.EMPTY.clone());
    const info = { currentCombo: 12, accuracy: 0.975 };
    const skin = {
      getComboNumberTextures: () => textures,
      getScoreTextures: () => textures,
      getTexture: () => Texture.EMPTY,
      config: { fonts: { comboOverlap: 0, scoreOverlap: 0 } },
    };
    // The number display objects need no canvas. Exclude the text and error-bar
    // constructors, whose canvas drawing is unrelated to number reuse.
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      comboNumber: new OsuClassicNumber(),
      accuracyNumber: new OsuClassicAccuracy(),
      gameSimulator: { getCurrentInfo: () => info },
      skinManager: { getSkin: () => skin },
      replayDisplaySettingsStore: {
        settings: {
          ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
          hitErrorBarEnabled: false,
          unstableRateEnabled: false,
          timingBiasEnabled: false,
        },
      },
      allHits: [],
      recentHits: [],
    });

    hud.updateHUD();
    const [combo, accuracy] = hud.container.children as Container[];
    const comboDigits = () => combo.children.map((child) => (child as Sprite).texture);
    const accuracyDigits = () => (accuracy.children[0] as Container).children.map((child) => (child as Sprite).texture);
    expect(comboDigits()).toEqual([textures[1], textures[2]]);
    expect(accuracyDigits()).toEqual([textures[9], textures[7]]);

    hud.updateHUD();
    expect(hud.container.children[0]).toBe(combo);
    expect(hud.container.children[1]).toBe(accuracy);

    info.currentCombo = 8;
    info.accuracy = 1;
    hud.updateHUD();
    expect(hud.container.children[0]).toBe(combo);
    expect(hud.container.children[1]).toBe(accuracy);
    expect(comboDigits()).toEqual([textures[8]]);
    expect(accuracyDigits()).toEqual([textures[1], textures[0], textures[0]]);

    const replacementTexture = Texture.EMPTY.clone();
    textures[8] = replacementTexture;
    hud.updateHUD();
    expect(comboDigits()).toEqual([replacementTexture]);
  });

  it("toggles current combo and accuracy independently", () => {
    const textures = Array.from({ length: 10 }, () => Texture.EMPTY.clone());
    const displaySettings = {
      ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
      hitErrorBarEnabled: false,
      unstableRateEnabled: false,
      timingBiasEnabled: false,
    };
    const comboNumber = new OsuClassicNumber();
    const accuracyNumber = new OsuClassicAccuracy();
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      comboNumber,
      accuracyNumber,
      gameSimulator: { getCurrentInfo: () => ({ currentCombo: 12, accuracy: 0.975 }) },
      skinManager: {
        getSkin: () => ({
          getComboNumberTextures: () => textures,
          getScoreTextures: () => textures,
          getTexture: () => Texture.EMPTY,
          config: { fonts: { comboOverlap: 0, scoreOverlap: 0 } },
        }),
      },
      replayDisplaySettingsStore: { settings: displaySettings },
      allHits: [],
      recentHits: [],
    });

    hud.updateHUD();
    expect(hud.container.children).toHaveLength(2);

    displaySettings.currentComboEnabled = false;
    hud.updateHUD();
    expect(hud.container.children).toEqual([accuracyNumber.container]);

    displaySettings.accuracyEnabled = false;
    hud.updateHUD();
    expect(hud.container.children).toHaveLength(0);
  });

  it("honours the persisted UR-bar switch without rescanning an unchanged collection", () => {
    let prefixIterations = 0;
    const hitErrorBarContainer = new Container();
    const prepare = jest.fn();
    const displaySettings = {
      ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
      hitErrorBarEnabled: false,
      currentComboEnabled: false,
      accuracyEnabled: false,
    };
    const hits = {
      [Symbol.iterator]() {
        prefixIterations += 1;
        return [[1000, 12, true] as [number, number, boolean]][Symbol.iterator]();
      },
    };
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      stats: new Container() as Container & { text: string },
      gameplayClock: { timeElapsedInMs: 1000 },
      beatmapManager: { getBeatmap: () => ({ gameClockRate: 1, difficulty: { overallDifficulty: 5 } }) },
      gameSimulator: {
        hits,
        getRulesetFocus: () => "stable",
        getCurrentState: () => ({}),
        getCurrentInfo: jest.fn(),
      },
      hitErrorBar: { prepare, container: hitErrorBarContainer },
      replayDisplaySettingsStore: { settings: displaySettings },
      allHits: [],
      recentHits: [],
      nativeUrMultiplier: 1,
    });

    hud.updateHUD();
    expect(prefixIterations).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(hud.container.children).not.toContain(hitErrorBarContainer);

    displaySettings.hitErrorBarEnabled = true;
    hud.updateHUD();
    expect(prefixIterations).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(hud.container.children).toContain(hitErrorBarContainer);

    displaySettings.unstableRateEnabled = false;
    displaySettings.timingBiasEnabled = false;
    displaySettings.hitErrorBarEnabled = false;
    hud.updateHUD();
    expect(prefixIterations).toBe(1);
    expect(hud.allHits).toEqual([]);
  });
});

describe("UR bar from the display settings", () => {
  function barFixture(viewerSettings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS }) {
    const hitErrorBarContainer = new Container();
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      stats: new Container() as Container & { text: string },
      gameplayClock: { timeElapsedInMs: 1000 },
      beatmapManager: { getBeatmap: () => ({ gameClockRate: 1, difficulty: { overallDifficulty: 5 } }) },
      gameSimulator: {
        hits: [[1000, 12, true]],
        getRulesetFocus: () => "stable",
        getCurrentState: () => ({}),
        getCurrentInfo: jest.fn(),
      },
      hitErrorBar: { prepare: jest.fn(), container: hitErrorBarContainer },
      replayDisplaySettingsStore: { settings: viewerSettings },
      allHits: [],
      recentHits: [],
    });
    return { hud, hitErrorBarContainer, viewerSettings };
  }
  const quiet = {
    ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
    currentComboEnabled: false,
    accuracyEnabled: false,
    unstableRateEnabled: false,
    timingBiasEnabled: false,
  };

  it("draws the UR bar from the display settings", () => {
    const off = barFixture();
    off.hud.updateHUD({ ...quiet, hitErrorBarEnabled: false });
    expect(off.hud.container.children).not.toContain(off.hitErrorBarContainer);
    expect(off.hud.hitErrorBar.prepare).not.toHaveBeenCalled();

    const on = barFixture();
    on.hud.updateHUD({ ...quiet, hitErrorBarEnabled: true, hitErrorBarScale: 3 });
    expect(on.hud.container.children).toContain(on.hitErrorBarContainer);
    expect(on.hitErrorBarContainer.scale.x).toBe(3);
    expect(on.hitErrorBarContainer.scale.y).toBe(3);
  });

  it.each([0, -1, NaN])("falls back to scale 2 for an unusable saved scale %s", (hitErrorBarScale) => {
    const { hud, hitErrorBarContainer } = barFixture();
    hud.updateHUD({ ...quiet, hitErrorBarEnabled: true, hitErrorBarScale });
    expect(hitErrorBarContainer.scale.x).toBe(2);
  });

  it("uses the settings it is given, not the viewer store, for a capture", () => {
    const { hud, hitErrorBarContainer } = barFixture({ ...quiet, hitErrorBarEnabled: false, hitErrorBarScale: 2 });
    const clip = { ...quiet, hitErrorBarEnabled: true, hitErrorBarScale: 2 };
    hud.updateHUD({ ...clip, hitErrorBarScale: 4 }, true);
    expect(hud.container.children).toContain(hitErrorBarContainer);
    expect(hitErrorBarContainer.scale.x).toBe(4);
  });

  it("lets the caller override the bar switch without changing the scale source", () => {
    const { hud, hitErrorBarContainer } = barFixture();
    hud.updateHUD({ ...quiet, hitErrorBarEnabled: false, hitErrorBarScale: 3 }, true);
    expect(hitErrorBarContainer.scale.x).toBe(3);
  });
});

describe("indexed timing HUD", () => {
  type Hit = [number, number, boolean];

  function fixture(hits: Hit[], rate = 1, ruleset: ReplayAnalysisRuleset = "stable") {
    const clock = { timeElapsedInMs: 0 };
    const beatmap = { gameClockRate: rate, difficulty: { overallDifficulty: 5 } };
    const simulator = { hits, ruleset, getRulesetFocus: () => simulator.ruleset, getCurrentState: () => ({}) };
    const settings = {
      ...DEFAULT_REPLAY_DISPLAY_SETTINGS,
      currentComboEnabled: false,
      accuracyEnabled: false,
    };
    let drawnHits: { timeAgo: number; offset: number; miss: boolean }[] = [];
    const stats = new Container() as Container & { text: string };
    const hud = Object.create(ForegroundHUDPreparer.prototype) as ForegroundHUDPreparer;
    Object.assign(hud, {
      container: new Container(),
      stats,
      gameplayClock: clock,
      beatmapManager: { getBeatmap: () => beatmap },
      gameSimulator: simulator,
      hitErrorBar: {
        container: new Container(),
        prepare: ({ hits: recent }: { hits: typeof drawnHits }) => {
          drawnHits = recent.map((hit) => ({ ...hit }));
        },
      },
      replayDisplaySettingsStore: { settings },
      allHits: [],
      recentHits: [],
    });
    return {
      hud,
      clock,
      beatmap,
      simulator,
      settings,
      render(time: number) {
        clock.timeElapsedInMs = time;
        hud.updateHUD();
        return { text: stats.text, recent: drawnHits };
      },
    };
  }

  // This is the pre-cache calculation, kept independent of the indexed path.
  function originalText(hits: Hit[], time: number, rate: number, ruleset: ReplayAnalysisRuleset) {
    const offsets = hits.filter(([judgement, , hit]) => judgement <= time && hit).map(([, offset]) => offset / rate);
    if (offsets.length === 0) return "UR —  ·  BIAS —";
    const ur = (standardDeviation(offsets) * 10 * (ruleset === "stable" ? rate : 1)).toFixed(1);
    const bias = mean(offsets);
    const formattedBias = Math.abs(bias) < 0.05 ? "+0.0" : `${bias < 0 ? "-" : "+"}${Math.abs(bias).toFixed(1)}`;
    return `UR ${ur}  ·  BIAS ${formattedBias} ms`;
  }

  it("includes equal and negative judgements, misses and the exact 10-second boundary across seeks", () => {
    const hits: Hit[] = [
      [-50, -10, true],
      [-Number.EPSILON, -4, true],
      [0, 900, false],
      [0, 10, true],
      [10000, 30, true],
    ];
    const f = fixture(hits);
    for (const time of [-51, -50, 0, 10000, 10001, 10050, 0, 1, 1]) {
      const actual = f.render(time);
      expect(actual.text).toBe(originalText(hits, time, 1, "stable"));
      expect(actual.recent).toEqual(
        hits
          .filter(([judgement]) => judgement <= time && time - judgement <= 10000)
          .map(([judgement, offset, hit]) => ({ timeAgo: time - judgement, offset, miss: !hit })),
      );
    }
  });

  it.each(["stable", "lazer"] as const)(
    "preserves %s population UR and compensated bias rounding across large and tiny ranges",
    (ruleset) => {
      const samples = [
        [1e12 + 0.125, 1e12 + 0.25, 1e12 + 0.375, 1e12 + 0.5],
        [1e-14, -1e-14, 0, 0.005, -0.005, -0.049999],
        [1e12, 0.1, -1e12, 0.1, 0.1, -0.3],
        [0, 0.01, 0.03, 0.05, 0.07, 0.09],
        Array.from({ length: 5000 }, (_, index) => (((index * 2371) % 401) - 200) / 7),
      ];
      for (const offsets of samples) {
        const hits: Hit[] = offsets.map((offset, index) => [index, offset, true]);
        const f = fixture(hits, 1, ruleset);
        for (const rate of [1, 1.5, 0.75, 1.2, 0.65, 1.01, 2, 0.5, 0.99]) {
          f.beatmap.gameClockRate = rate;
          for (const time of [hits.length - 1, 0, 1, 2, 3, hits.length / 2, hits.length - 1]) {
            expect(f.render(time).text).toBe(originalText(hits, time, rate, ruleset));
          }
        }
      }
    },
  );

  it("refreshes for replacement collections, length changes, rates, rulesets and display toggles", () => {
    const f = fixture(
      [
        [0, -10, true],
        [1, 10, true],
      ],
      1,
      "stable",
    );
    expect(f.render(1).text).toBe("UR 100.0  ·  BIAS +0.0 ms");
    f.simulator.hits = [
      [0, 20, true],
      [1, 40, true],
    ];
    expect(f.render(1).text).toBe("UR 100.0  ·  BIAS +30.0 ms");
    // Defensive handling of a legacy caller appending despite the readonly contract.
    f.simulator.hits.push([1, 60, true]);
    expect(f.render(1).text).toBe("UR 163.3  ·  BIAS +40.0 ms");
    f.beatmap.gameClockRate = 2;
    expect(f.render(1).text).toBe("UR 163.3  ·  BIAS +20.0 ms");
    f.simulator.ruleset = "lazer";
    expect(f.render(1).text).toBe("UR 81.6  ·  BIAS +20.0 ms");
    f.settings.unstableRateEnabled = false;
    f.settings.timingBiasEnabled = false;
    f.render(1);
    expect(f.hud.allHits).toEqual([]);
    f.settings.timingBiasEnabled = true;
    expect(f.render(1).text).toBe("BIAS +20.0 ms");
    f.settings.unstableRateEnabled = true;
    f.settings.hitErrorBarEnabled = false;
    expect(f.render(0).text).toBe("UR 0.0  ·  BIAS +10.0 ms");
    f.settings.hitErrorBarEnabled = true;
    expect(f.render(1).recent).toEqual([
      { timeAgo: 1, offset: 20, miss: false },
      { timeAgo: 0, offset: 40, miss: false },
      { timeAgo: 0, offset: 60, miss: false },
    ]);
    f.simulator.hits = [];
    expect(f.render(1)).toEqual({ text: "UR —  ·  BIAS —", recent: [] });
  });

  it("hides legacy timing in Compact while preserving the error bar and restoring Classic", () => {
    const f = fixture([[1000, 12, true]]);
    f.render(1000);
    expect(f.hud.container.children).toContain(f.hud.stats);
    Object.assign(f.settings, { statsStyle: "compact" });
    expect(f.render(1000).recent).toEqual([{ timeAgo: 0, offset: 12, miss: false }]);
    expect(f.hud.container.children).not.toContain(f.hud.stats);
    expect(f.hud.container.children).toContain(f.hud.hitErrorBar.container);
    Object.assign(f.settings, { statsStyle: "classic" });
    expect(f.render(1000).text).toBe("UR 0.0  ·  BIAS +12.0 ms");
    expect(f.hud.container.children).toContain(f.hud.stats);
  });

  it("visits a 5,000-hit history once across 60 frames with three HUD updates each", () => {
    let visited = 0;
    const hits: Hit[] = Array.from({ length: 5000 }, (_, index) => [index, (index % 101) - 50, true]);
    const countedHits = new Proxy(hits, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) visited++;
        return Reflect.get(target, key, receiver);
      },
    });
    const f = fixture(countedHits);
    for (let frame = 0; frame < 60; frame++) {
      for (let update = 0; update < 3; update++) f.render(20000 + (frame * 1000) / 60);
    }
    expect(visited).toBe(5000);
    expect(f.render(20000).text).toBe(originalText(hits, 20000, 1, "stable"));
  });
});
