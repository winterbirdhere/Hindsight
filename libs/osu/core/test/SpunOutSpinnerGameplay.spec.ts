import { Beatmap } from "../src/beatmap/Beatmap";
import { DEFAULT_BEATMAP_DIFFICULTY } from "../src/beatmap/BeatmapDifficulty";
import { ControlPointInfo } from "../src/beatmap/ControlPoints/ControlPointInfo";
import { retrieveEvents } from "../src/gameplay/GameplayAnalysisEvent";
import { LazerGameStateTimeMachine } from "../src/gameplay/LazerGameStateTimeMachine";
import { spinnerBonusProgress } from "../src/gameplay/SpinnerBonus";
import { Spinner } from "../src/hitobjects/Spinner";
import { LazerMod } from "../src/mods/LazerMods";
import { OsuClassicMod } from "../src/mods/Mods";
import { ReplayFrame } from "../src/replays/Replay";

function makeBeatmap(appliedMods: OsuClassicMod[] = ["SPUN_OUT"], lazerMods: LazerMod[] = []) {
  const spinner = new Spinner();
  spinner.id = "spinner";
  spinner.startTime = 1000;
  spinner.duration = 2000;
  spinner.spinsRequired = 5;
  spinner.maximumBonusSpins = 3;
  return new Beatmap(
    [spinner],
    DEFAULT_BEATMAP_DIFFICULTY,
    appliedMods,
    new ControlPointInfo(),
    false,
    [],
    [],
    lazerMods,
  );
}

function idleFrame(time: number): ReplayFrame {
  return { time, position: { x: 0, y: 0 }, actions: [] };
}

describe("Spun Out in native lazer replay simulation", () => {
  it.each([
    { label: "normal rate", appliedMods: ["SPUN_OUT"] as OsuClassicMod[], lazerMods: [] as LazerMod[] },
    { label: "DT", appliedMods: ["SPUN_OUT", "DOUBLE_TIME"] as OsuClassicMod[], lazerMods: [] },
    { label: "HT", appliedMods: ["SPUN_OUT", "HALF_TIME"] as OsuClassicMod[], lazerMods: [] },
    {
      label: "custom DT and native SO metadata",
      appliedMods: [] as OsuClassicMod[],
      lazerMods: [{ acronym: "SO" }, { acronym: "DT", settings: { speed_change: 1.73 } }],
    },
  ])("clears without cursor or button input at $label", ({ appliedMods, lazerMods }) => {
    const map = makeBeatmap(appliedMods, lazerMods);
    const machine = new LazerGameStateTimeMachine([idleFrame(999), idleFrame(3100)], map);
    const midway = machine.gameStateAt(2000).spinnerState.get("spinner");
    expect(midway?.totalSpunAngle).toBeCloseTo(909);
    expect(midway?.tracking).toBe(true);
    const state = machine.gameStateAt(3100);
    expect(state.spinnerVerdict.spinner).toEqual({ type: "GREAT", judgementTime: 3000 });
    expect(state.spinnerState.get("spinner")?.totalSpunAngle).toBeCloseTo(1818);
    expect(spinnerBonusProgress(map.getSpinner("spinner"), state.spinnerState.get("spinner"), "lazer").score).toBe(0);
    expect(retrieveEvents(state, map.hitObjects, "lazer")).toEqual([
      expect.objectContaining({
        type: "HitObjectJudgement",
        hitObjectId: "spinner",
        verdict: "GREAT",
        ruleset: "lazer",
      }),
    ]);
  });

  it("preserves a failed replay's end instead of completing a later spinner", () => {
    const machine = new LazerGameStateTimeMachine([idleFrame(999), idleFrame(2000)], makeBeatmap());
    const state = machine.gameStateAt(100000);
    expect(state.currentTime).toBe(2000);
    expect(state.spinnerVerdict.spinner).toBeUndefined();
    expect(state.spinnerState.get("spinner")?.totalSpunAngle).toBeCloseTo(909);
  });

  it("restores identical spinner completion, rotations, and timestamps after reverse seek and fork", () => {
    const map = makeBeatmap();
    const machine = new LazerGameStateTimeMachine([999, 1500, 2000, 2500, 2990, 3100].map(idleFrame), map, 2);
    const expected = { ...machine.gameStateAt(2990).spinnerState.get("spinner") };
    const fork = machine.fork();
    machine.gameStateAt(3100);
    expect(machine.gameStateAt(1500).spinnerState.get("spinner")?.completionTime).toBeUndefined();
    expect(machine.gameStateAt(2990).spinnerState.get("spinner")).toEqual(expected);
    expect(fork.gameStateAt(3100).spinnerVerdict.spinner).toEqual({ type: "GREAT", judgementTime: 3000 });
  });

  it("still requires normal spinning when SO is absent", () => {
    const machine = new LazerGameStateTimeMachine([idleFrame(999), idleFrame(3100)], makeBeatmap([]));
    expect(machine.gameStateAt(3100).spinnerVerdict.spinner).toEqual({ type: "MISS", judgementTime: 3000 });
  });
});
