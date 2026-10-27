import { render, screen, within } from "@testing-library/react";
import {
  buildBeatmap,
  isNotelockMiss,
  OsuAction,
  parseBlueprint,
  type LazerMod,
  type ReplayAnalysisRuleset,
  type ReplayFrame,
} from "@osujs/core";
import { legacyModsFromLazerMods, type OsuReplay } from "../../model/OsuReplay";
import { analyzeFullMap } from "../../services/analysis/full-map-analysis";
import { buildFullMapAnalysisViewModel } from "../../services/analysis/full-map-analysis-view-model";
import { GameSimulator } from "../../services/common/game/GameSimulator";
import { FullMapAnalysisDialog } from "./FullMapAnalysisDialog";

type AutomatedMod = "RX" | "AP" | "AT" | "SO";

const rawMap = `osu file format v14
[General]
Mode:0
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:5
ApproachRate:8
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
100,100,1095,1,0,0:0:0:0:
300,100,1100,1,0,0:0:0:0:
`;

function fixture(acronym: AutomatedMod, native: boolean, offTarget = false, omitRecordedPress = false) {
  const lazerMods: LazerMod[] = [{ acronym }];
  const mods = legacyModsFromLazerMods(lazerMods);
  const beatmap = buildBeatmap(parseBlueprint(rawMap), { mods, ...(native ? { lazerMods } : {}) });
  const outside = { x: 512, y: 384 };
  // At 1088 the second circle is within Relax's -12 ms leniency, while the
  // earlier circle has not started. Both ordered hit policies block the attempt.
  // Leave immediately so the target cannot be retried after the blocker expires.
  const frames: ReplayFrame[] = [
    { time: 0, position: outside, actions: [] },
    { time: 1087, position: outside, actions: [] },
    {
      time: 1088,
      position: offTarget ? outside : { x: 300, y: 100 },
      actions: (acronym === "RX" && !native) || omitRecordedPress ? [] : [OsuAction.leftButton],
    },
    { time: 1089, position: outside, actions: [] },
    { time: 2000, position: outside, actions: [] },
  ];
  const replay: OsuReplay = {
    gameMode: 0,
    gameVersion: native ? 30_000_019 : 20_260_912,
    player: "Notelock fixture",
    md5hash: `notelock-${acronym}-${native}`,
    beatmapMd5: "notelock-map",
    mods,
    ...(native ? { lazerMods } : {}),
    frames,
  };
  const simulator = new GameSimulator();
  simulator.simulateReplay(beatmap, replay);
  return { simulator, replay };
}

function analysis(simulator: GameSimulator, replay: OsuReplay, ruleset: ReplayAnalysisRuleset) {
  expect(simulator.setRulesetFocus(ruleset)).toBe(true);
  const info = simulator.getFinalInfoForRuleset(ruleset);
  const summary = analyzeFullMap({
    ruleset,
    events: simulator.getEventsForRuleset(ruleset),
    hits: simulator.getHitsForRuleset(ruleset),
    duration: 2000,
    baseRate: 1,
    aggregateAccuracyInput: info?.accuracy,
    aggregateJudgementCountsInput: info?.verdictCounts,
  });
  return buildFullMapAnalysisViewModel({
    summary,
    replay: {
      mods: replay.mods,
      lazerMods: replay.lazerMods,
      sourceRuleset: replay.gameVersion >= 30_000_000 ? "lazer" : "stable",
    },
    beatmap: { objectCount: 2, durationMs: 2000 },
  });
}

function renderAnalysis(viewModel: ReturnType<typeof analysis>) {
  return render(
    <FullMapAnalysisDialog
      open
      viewModel={viewModel}
      canSwitchRuleset
      onSwitchRuleset={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe.each([false, true])("full-map automated-mod notelock from native=%s replays", (native) => {
  it.each<AutomatedMod>(["RX", "AP", "AT", "SO"])(
    "counts the proven %s notelock miss in both rulesets without printing the count on the page",
    (acronym) => {
      const { simulator, replay } = fixture(acronym, native);
      for (const ruleset of ["stable", "lazer"] as const) {
        const viewModel = analysis(simulator, replay, ruleset);
        expect(viewModel.summary.errors).toMatchObject({ missCount: 2, notelockMissCount: 1, total: 2 });
        expect(viewModel.summary.errors.notelockMissCount).toBe(1);
        const evidence = simulator.getEventsForRuleset(ruleset).filter(isNotelockMiss);
        expect(evidence).toHaveLength(1);
        expect(evidence[0].notelockCause).toMatchObject({ pressTime: 1088, wouldHaveHit: "GREAT" });
        const rendered = renderAnalysis(viewModel);
        // The Miss row counts the miss and nothing else; the notelock count is not printed on the page.
        const miss = screen.getByRole("region", { name: "MISS: 2" });
        expect(within(miss).getByTestId("result-row-count").textContent).toBe("2");
        expect(screen.queryByText(/Notelock:/)).toBeNull();
        rendered.unmount();
      }
    },
  );

  it.each<AutomatedMod>(["RX", "AP", "AT", "SO"])("keeps ordinary %s misses out of the notelock count", (acronym) => {
    const { simulator, replay } = fixture(acronym, native, true);
    for (const ruleset of ["stable", "lazer"] as const) {
      const viewModel = analysis(simulator, replay, ruleset);
      expect(viewModel.summary.errors).toMatchObject({ missCount: 2, notelockMissCount: 0, total: 2 });
      const rendered = renderAnalysis(viewModel);
      expect(viewModel.summary.errors.notelockMissCount).toBe(0);
      expect(screen.queryByText(/Notelock:/)).toBeNull();
      rendered.unmount();
    }
  });
});

it("does not invent native Lazer Relax notelock evidence without a recorded automatic press", () => {
  const { simulator, replay } = fixture("RX", true, false, true);
  const viewModel = analysis(simulator, replay, "lazer");
  expect(viewModel.summary.errors).toMatchObject({ missCount: 2, notelockMissCount: 0, total: 2 });
  renderAnalysis(viewModel);
  expect(viewModel.summary.errors.notelockMissCount).toBe(0);
  expect(screen.queryByText(/Notelock:/)).toBeNull();
});
