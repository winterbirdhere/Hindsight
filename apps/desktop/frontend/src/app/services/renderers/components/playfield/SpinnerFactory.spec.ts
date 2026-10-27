import { Beatmap, DEFAULT_BEATMAP_DIFFICULTY, OsuAction, Spinner } from "@osujs/core";
import { Sprite } from "pixi.js";
import { Skin } from "../../../../model/Skin";
import { GameSimulator } from "../../../common/game/GameSimulator";
import { SpinnerFactory } from "./SpinnerFactory";

function fixture() {
  const target = new Spinner();
  target.id = "bonus-spinner";
  target.startTime = 1000;
  target.duration = 3000;
  target.applyLazerDefaults(0);
  target.maximumBonusSpins = 2;
  const simulator = new GameSimulator();
  const map = new Beatmap(
    [target],
    { ...DEFAULT_BEATMAP_DIFFICULTY, overallDifficulty: 0 },
    [],
    Beatmap.EMPTY_BEATMAP.controlPointInfo,
  );
  const positions = [
    { x: 256, y: 292 },
    { x: 156, y: 192 },
    { x: 256, y: 92 },
    { x: 356, y: 192 },
  ];
  simulator.simulateReplay(map, {
    md5hash: "spinner-bonus",
    beatmapMd5: "spinner-map",
    gameMode: 0,
    gameVersion: 20200101,
    mods: [],
    player: "Spinner Player",
    // Seven turns clear both rulesets' real OD0 requirement plus the bonus
    // buffer. Stable observes the earned half-turn on the next input sample.
    frames: Array.from({ length: 49 }, (_, i) => ({
      time: 1000 + i * 50,
      position: positions[i % 4],
      actions: [OsuAction.leftButton],
    })),
  });
  const clock = { timeElapsedInMs: 0 };
  const factory = Object.create(SpinnerFactory.prototype) as SpinnerFactory;
  Object.assign(factory, {
    gameClock: clock,
    gameSimulator: simulator,
    modSettingsService: { modSettings: { hidden: false } },
    stageSkinService: { getSkin: () => Skin.EMPTY },
  });
  const renderAt = (time: number, spinner = target) => {
    simulator.simulate(time);
    clock.timeElapsedInMs = time;
    return factory.create(spinner);
  };
  return { renderAt, simulator, target };
}

describe("SpinnerFactory bonus integration", () => {
  it("reads bonus progress before the spinner judgement and restores it on seek", () => {
    const { renderAt, simulator } = fixture();
    const before = renderAt(2200);
    expect(before?.bonusNumber.parent).toBeNull();
    const awarded = renderAt(2500);
    expect(simulator.getCurrentState()?.spinnerVerdict["bonus-spinner"]).toBeUndefined();
    expect(awarded?.bonusNumber.children).toHaveLength(4);
    expect(awarded?.bonusNumber.alpha).toBe(1);
    const halfway = renderAt(2550)?.bonusNumber.alpha;
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(1);
    renderAt(3000);
    expect(renderAt(2550)?.bonusNumber.alpha).toBe(halfway);
    expect(renderAt(2200)?.bonusNumber.parent).toBeNull();
  });

  it("switches to the lazer bonus amount and cap with the selected ruleset", () => {
    const { renderAt, simulator } = fixture();
    expect(renderAt(2500)?.bonusNumber.children).toHaveLength(4);
    expect(simulator.setRulesetFocus("lazer")).toBe(true);
    expect(renderAt(2450)?.bonusNumber.children).toHaveLength(2);
    expect(renderAt(3000)?.bonusNumber.children).toHaveLength(3);
    expect(renderAt(3000)?.bonusNumber.children.every((child) => child instanceof Sprite)).toBe(true);
  });

  it("does not reuse another spinner's bonus state and culls after the end fade", () => {
    const { renderAt } = fixture();
    expect(renderAt(2500)?.bonusNumber.children).toHaveLength(4);
    const next = new Spinner();
    next.id = "next-spinner";
    next.startTime = 2700;
    next.duration = 1000;
    expect(renderAt(2700, next)?.bonusNumber.parent).toBeNull();
    expect(renderAt(4241)).toBeUndefined();
  });
});
