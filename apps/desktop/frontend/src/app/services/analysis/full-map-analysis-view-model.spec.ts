import type { OsuClassicMod, ReplayAnalysisRuleset } from "@osujs/core";
import { analyzeFullMap } from "./full-map-analysis";
import {
  buildFullMapAnalysisViewModel,
  buildFullMapFooterMetadata,
  buildFullMapHitWindowReferences,
  buildFullMapReplayMods,
  calculateFullMapGrade,
  calculateResultPercentages,
  rankColorForGrade,
  resolveReplayCompletionStatus,
  type FullMapGrade,
} from "./full-map-analysis-view-model";

function summary(
  ruleset: ReplayAnalysisRuleset,
  counts: readonly [number, number, number, number],
  accuracy?: number | null,
) {
  return analyzeFullMap({
    ruleset,
    events: [],
    hits: [],
    duration: 120_000,
    baseRate: 1,
    aggregateJudgementCountsInput: counts,
    aggregateAccuracyInput: accuracy,
    objectCoverage: { totalObjectCount: counts.reduce((total, count) => total + count, 0) },
  });
}

describe("Full-map replay and beatmap identity", () => {
  it("keeps supplied identity accurate while trimming surrounding whitespace", () => {
    const input = {
      summary: summary("stable", [10, 0, 0, 0]),
      context: {
        title: "  #Title %23  ",
        artist: "  Artist Name ",
        difficulty: " Mapper's Extra ",
        player: " Analysis player  ",
      },
    };

    expect(buildFullMapAnalysisViewModel(input)).toMatchObject({
      context: {
        title: "#Title %23",
        artist: "Artist Name",
        difficulty: "Mapper's Extra",
        player: "Analysis player",
      },
    });
    expect(input.context.title).toBe("  #Title %23  ");
  });

  it("omits unavailable identity instead of inventing display values", () => {
    const input = {
      summary: summary("stable", [10, 0, 0, 0]),
      context: { title: "  ", artist: "\t", difficulty: "", player: " Player " },
    };
    const blankIdentity = { ...input, context: { title: " " } };

    expect(buildFullMapAnalysisViewModel(input).context).toEqual({ player: "Player" });
    expect(buildFullMapAnalysisViewModel(blankIdentity)).not.toHaveProperty("context");
    expect(buildFullMapAnalysisViewModel({ summary: input.summary })).not.toHaveProperty("context");
  });
});

describe("Full-map aim scatter and map marks", () => {
  it("passes the supplied aim scatter and marks through unchanged", () => {
    const aim = {
      available: true,
      points: [{ time: 1_000, x: 0.25, y: -0.5, verdict: "GREAT" as const }],
      mean: { x: 0.25, y: -0.5 },
      omittedCount: 2,
      omittedMissCount: 1,
      misses: [{ time: 2_000, x: 1.5, y: 0.25 }],
    };
    const marks = { miss: [2_000], sliderBreak: [3_000], ok: [1_500, 1_600], meh: [] };

    const viewModel = buildFullMapAnalysisViewModel({ summary: summary("stable", [10, 0, 0, 0]), aim, marks });

    expect(viewModel.aim).toBe(aim);
    expect(viewModel.marks).toBe(marks);
  });

  it("returns an unavailable aim scatter and empty marks when none are supplied", () => {
    const viewModel = buildFullMapAnalysisViewModel({ summary: summary("stable", [10, 0, 0, 0]) });

    expect(viewModel.aim).toEqual({
      available: false,
      unavailableReason: "Aim positions are unavailable.",
      points: [],
      mean: null,
      omittedCount: 0,
      omittedMissCount: 0,
      misses: [],
    });
    expect(viewModel.marks).toEqual({ miss: [], sliderBreak: [], ok: [], meh: [] });
  });
});

describe("Full-map result percentages and grades", () => {
  it("uses the four main result counts as the shared percentage denominator", () => {
    expect(calculateResultPercentages(summary("stable", [3, 2, 1, 4]).judgements)).toEqual({
      count300: 0.3,
      count100: 0.2,
      count50: 0.1,
      countMiss: 0.4,
    });
    expect(calculateResultPercentages(summary("stable", [0, 0, 0, 0]).judgements)).toEqual({
      count300: null,
      count100: null,
      count50: null,
      countMiss: null,
    });
  });

  it.each<[readonly [number, number, number, number], FullMapGrade]>([
    [[100, 0, 0, 0], "SS"],
    [[91, 8, 1, 0], "S"],
    [[90, 10, 0, 0], "A"],
    [[81, 19, 0, 0], "A"],
    [[80, 20, 0, 0], "B"],
    [[71, 29, 0, 0], "B"],
    [[70, 30, 0, 0], "C"],
    [[61, 39, 0, 0], "C"],
    [[60, 40, 0, 0], "D"],
    [[91, 8, 0, 1], "A"],
    [[81, 18, 0, 1], "B"],
  ])("applies Stable's strict judgement-ratio boundaries to %p", (counts, expected) => {
    expect(calculateFullMapGrade(summary("stable", counts), "passed")).toBe(expected);
  });

  it.each<[number, number, FullMapGrade]>([
    [1, 0, "SS"],
    [0.95, 0, "S"],
    [0.949, 0, "A"],
    [0.9, 0, "A"],
    [0.8, 0, "B"],
    [0.7, 0, "C"],
    [0.699, 0, "D"],
    [0.95, 1, "A"],
    [1, 1, "A"],
  ])("applies native Lazer's accuracy cutoff %p with %p misses", (accuracy, misses, expected) => {
    expect(calculateFullMapGrade(summary("lazer", [99 - misses, 0, 0, misses], accuracy), "passed")).toBe(expected);
  });

  it("uses F only for affirmative failure and never derives it from low accuracy", () => {
    const perfect = summary("stable", [100, 0, 0, 0]);
    const lowAccuracy = summary("lazer", [1, 0, 0, 9], 0.1);

    expect(calculateFullMapGrade(perfect, "failed")).toBe("F");
    expect(calculateFullMapGrade(lowAccuracy, "unknown")).toBe("D");
  });

  it("uses the requested Full-map rank palette and preserves the failed rank colour", () => {
    expect(
      Object.fromEntries(
        (["SS", "S", "A", "B", "C", "D", "F"] as const).map((grade) => [grade, rankColorForGrade(grade)]),
      ),
    ).toEqual({
      SS: "#ffd62d",
      S: "#ffd62d",
      A: "#88da20",
      B: "#4b7bff",
      C: "#b56cff",
      D: "#ff5a5a",
      F: "#3f3f3f",
    });
  });

  it.each<[ReplayAnalysisRuleset, "S" | "SS", readonly [number, number, number, number], number]>([
    ["stable", "S", [91, 8, 1, 0], 0.95],
    ["stable", "SS", [100, 0, 0, 0], 1],
    ["lazer", "S", [95, 5, 0, 0], 0.95],
    ["lazer", "SS", [100, 0, 0, 0], 1],
  ])(
    "colors %s %s silver for source Hidden or Flashlight without changing results",
    (ruleset, grade, counts, accuracy) => {
      const analyzed = summary(ruleset, counts, accuracy);
      const baseline = buildFullMapAnalysisViewModel({ summary: analyzed, replay: { passed: true } });
      expect(baseline.grade).toBe(grade);
      expect(baseline.rankColor).toBe("#ffd62d");

      for (const mods of [["HIDDEN"], [" hd "], ["FLASH_LIGHT"], ["fl"], ["HD", "FL"], ["HR", "NC", "HD"]]) {
        const modified = buildFullMapAnalysisViewModel({ summary: analyzed, replay: { passed: true, mods } });
        expect(modified).toEqual({ ...baseline, mods: buildFullMapReplayMods(mods), rankColor: "#d9e1e8" });
        expect(modified.summary).toBe(analyzed);
      }
    },
  );

  it.each(["S", "SS"] as const)("keeps %s gold with no mods or mods other than Hidden and Flashlight", (grade) => {
    const unrelatedMods = buildFullMapReplayMods([
      "NO_FAIL",
      "EASY",
      "DOUBLE_TIME",
      "NIGHT_CORE",
      "HALF_TIME",
      "HARD_ROCK",
      "SUDDEN_DEATH",
      "PERFECT",
      "RELAX",
      "AUTO_PILOT",
      "SPUN_OUT",
      "AUTO_PLAY",
      "SCORE_V2",
      "UNKNOWN",
    ]);
    expect(rankColorForGrade(grade)).toBe("#ffd62d");
    expect(rankColorForGrade(grade, [])).toBe("#ffd62d");
    expect(rankColorForGrade(grade, unrelatedMods)).toBe("#ffd62d");
  });

  it.each(["A", "B", "C", "D", "F"] as const)("does not recolor %s with Hidden or Flashlight", (grade) => {
    for (const mods of [["HD"], ["FLASH_LIGHT"], ["HD", "FL"]]) {
      expect(rankColorForGrade(grade, buildFullMapReplayMods(mods))).toBe(rankColorForGrade(grade));
    }
  });

  it.each(["stable", "lazer"] as const)("keeps failed %s Hidden/Flashlight replay ranks F and gray", (ruleset) => {
    const analyzed = summary(ruleset, [100, 0, 0, 0], 1);
    const viewModel = buildFullMapAnalysisViewModel({
      summary: analyzed,
      replay: { passed: false, mods: ["HD", "FL"] },
    });
    expect(viewModel.grade).toBe("F");
    expect(viewModel.rankColor).toBe("#3f3f3f");
    expect(viewModel.summary).toBe(analyzed);
  });

  it.each(["stable", "lazer"] as const)(
    "preserves the native %s source-mod silver color while switching reconstruction rulesets",
    (sourceRuleset) => {
      const replay = { passed: true, sourceRuleset, mods: ["HD", "DT", "HR"] };
      const stable = buildFullMapAnalysisViewModel({ summary: summary("stable", [100, 0, 0, 0]), replay });
      const lazer = buildFullMapAnalysisViewModel({ summary: summary("lazer", [100, 0, 0, 0], 1), replay });
      expect(stable.grade).toBe("SS");
      expect(lazer.grade).toBe("SS");
      expect(stable.rankColor).toBe("#d9e1e8");
      expect(lazer.rankColor).toBe("#d9e1e8");
      expect(lazer.mods).toEqual(stable.mods);
    },
  );
});

describe("Full-map replay mod presentation", () => {
  it("orders the requested Hidden, Double Time, Hard Rock, Flashlight strip without mutating replay mods", () => {
    const mods = Object.freeze(["FLASH_LIGHT", "hard_rock", " DT ", "HIDDEN", "HD", "unknown"]);
    expect(buildFullMapReplayMods(mods)).toEqual([
      { mod: "HIDDEN", acronym: "HD", name: "Hidden" },
      { mod: "DOUBLE_TIME", acronym: "DT", name: "Double Time" },
      { mod: "HARD_ROCK", acronym: "HR", name: "Hard Rock" },
      { mod: "FLASH_LIGHT", acronym: "FL", name: "Flashlight" },
    ]);
    expect(mods).toEqual(["FLASH_LIGHT", "hard_rock", " DT ", "HIDDEN", "HD", "unknown"]);
  });

  it("shows Nightcore and Perfect once without their implied Double Time or Sudden Death badges", () => {
    expect(
      buildFullMapReplayMods(["DT", "SD", "NIGHT_CORE", "nc", "DOUBLE_TIME", "PF", "PERFECT", "SUDDEN_DEATH"]).map(
        ({ mod, acronym }) => ({ mod, acronym }),
      ),
    ).toEqual([
      { mod: "NIGHT_CORE", acronym: "NC" },
      { mod: "PERFECT", acronym: "PF" },
    ]);
  });

  it.each<[OsuClassicMod, string]>([
    ["TOUCH_DEVICE", "TD"],
    ["NO_FAIL", "NF"],
    ["EASY", "EZ"],
    ["HIDDEN", "HD"],
    ["DOUBLE_TIME", "DT"],
    ["NIGHT_CORE", "NC"],
    ["HALF_TIME", "HT"],
    ["HARD_ROCK", "HR"],
    ["SUDDEN_DEATH", "SD"],
    ["PERFECT", "PF"],
    ["FLASH_LIGHT", "FL"],
    ["RELAX", "RX"],
    ["AUTO_PILOT", "AP"],
    ["SPUN_OUT", "SO"],
    ["AUTO_PLAY", "AT"],
    ["SCORE_V2", "V2"],
  ])("normalizes and deduplicates the supported %s / %s names", (mod, acronym) => {
    expect(buildFullMapReplayMods([mod, mod.toLowerCase(), ` ${mod} `, acronym, ` ${acronym.toLowerCase()} `])).toEqual(
      [{ mod, acronym, name: expect.any(String) }],
    );
  });

  it("uses the full deterministic presentation order independently of input order", () => {
    expect(
      buildFullMapReplayMods([
        "V2",
        "AT",
        "SO",
        "AP",
        "RX",
        "FL",
        "PF",
        "SD",
        "HR",
        "HT",
        "NC",
        "DT",
        "HD",
        "EZ",
        "NF",
      ]).map(({ acronym }) => acronym),
    ).toEqual(["NF", "EZ", "HD", "NC", "HT", "HR", "PF", "FL", "RX", "AP", "SO", "AT", "V2"]);
  });

  it("omits No Mod and unsupported entries instead of adding a placeholder strip", () => {
    expect(buildFullMapReplayMods()).toEqual([]);
    expect(buildFullMapReplayMods([])).toEqual([]);
    expect(
      buildFullMapReplayMods(["", " ", "NM", "NO_MOD", "UNKNOWN", "__proto__", "constructor", "toString"]),
    ).toEqual([]);
    expect(buildFullMapReplayMods(["NM", "unknown", "HD"]).map(({ acronym }) => acronym)).toEqual(["HD"]);
  });

  it.each(["stable", "lazer"] as const)(
    "retains the same native %s replay mods across both reconstruction rulesets",
    (sourceRuleset) => {
      const mods = Object.freeze(["FL", "HR", "NC", "HD", "DT"]);
      const replay = { passed: true, sourceRuleset, mods };
      const stable = buildFullMapAnalysisViewModel({ summary: summary("stable", [10, 0, 0, 0]), replay });
      const lazer = buildFullMapAnalysisViewModel({ summary: summary("lazer", [10, 0, 0, 0], 1), replay });
      expect(stable.mods.map(({ acronym }) => acronym)).toEqual(["HD", "NC", "HR", "FL"]);
      expect(lazer.mods).toEqual(stable.mods);
      expect(stable.sourceRuleset).toBe(sourceRuleset);
      expect(lazer.sourceRuleset).toBe(sourceRuleset);
      expect(mods).toEqual(["FL", "HR", "NC", "HD", "DT"]);
    },
  );

  it("keeps absent replay evidence mod-free", () => {
    expect(buildFullMapAnalysisViewModel({ summary: summary("stable", [10, 0, 0, 0]) }).mods).toEqual([]);
  });
});

describe("Full-map replay completion evidence", () => {
  const incomplete = summary("stable", [1, 0, 0, 0]);

  it("prefers an authoritative pass/fail value", () => {
    expect(resolveReplayCompletionStatus(incomplete, { passed: true })).toBe("passed");
    expect(resolveReplayCompletionStatus(incomplete, { passed: false, mods: ["NO_FAIL"] })).toBe("failed");
  });

  it("recognises completed result coverage or a replay reaching the final object", () => {
    expect(resolveReplayCompletionStatus(incomplete, undefined, { objectCount: 1 })).toBe("passed");
    expect(
      resolveReplayCompletionStatus(
        incomplete,
        { lastFrameTimeMs: 10_000 },
        { objectCount: 2, completionTimeMs: 10_000 },
      ),
    ).toBe("passed");
  });

  it("marks a proven early ending as failed unless NoFail makes that inference unsafe", () => {
    const beatmap = { objectCount: 2, completionTimeMs: 10_000 };
    expect(resolveReplayCompletionStatus(incomplete, { lastFrameTimeMs: 9_999, mods: [] }, beatmap)).toBe("failed");
    expect(resolveReplayCompletionStatus(incomplete, { lastFrameTimeMs: 9_999, mods: ["NO_FAIL"] }, beatmap)).toBe(
      "unknown",
    );
  });

  it("keeps absent or insufficient evidence unknown", () => {
    expect(resolveReplayCompletionStatus(incomplete)).toBe("unknown");
    expect(resolveReplayCompletionStatus(incomplete, { lastFrameTimeMs: 100 }, { objectCount: 2 })).toBe("unknown");
  });
});

describe("Full-map hit windows and footer metadata", () => {
  const difficulty = { drainRate: 5, circleSize: 4, overallDifficulty: 5, approachRate: 9.6 };

  it("keeps Stable windows in beatmap time and converts lazer windows to real time", () => {
    const stable = { ...summary("stable", [1, 0, 0, 0]), baseRate: 2 };
    const lazer = { ...summary("lazer", [1, 0, 0, 0], 1), baseRate: 2 };

    expect(buildFullMapHitWindowReferences(stable, difficulty)).toEqual({
      available: true,
      greatMs: 49,
      okMs: 99,
      mehMs: 149,
      missMs: 399,
    });
    expect(buildFullMapHitWindowReferences(lazer, difficulty)).toEqual({
      available: true,
      greatMs: 24.75,
      okMs: 49.75,
      mehMs: 74.75,
      missMs: 200,
    });
  });

  it("reports actual built difficulty and rate-adjusted duration-weighted BPM", () => {
    const analyzed = { ...summary("stable", [1, 0, 0, 0]), baseRate: 1.5 };
    const footer = buildFullMapFooterMetadata(analyzed, {
      durationMs: 120_000,
      objectCount: 1_552,
      hitCircleCount: 846,
      sliderCount: 704,
      difficulty: { drainRate: 5, circleSize: 4, approachRate: 9.6, overallDifficulty: 9.2 },
      timingPoints: [
        { time: 0, beatLength: 500 },
        { time: 30_000, beatLength: 250 },
      ],
    });

    expect(footer).toEqual({
      durationMs: 120_000,
      objectCount: 1_552,
      hitCircleCount: 846,
      sliderCount: 704,
      bpm: 360,
      cs: 4,
      ar: 9.6,
      od: 9.2,
      hp: 5,
    });
  });

  it("keeps constant-tempo output and clips tempo weighting to actual completion", () => {
    const analyzed = { ...summary("stable", [1, 0, 0, 0]), baseRate: 1.5 };
    expect(buildFullMapFooterMetadata(analyzed, { timingPoints: [{ time: 0, beatLength: 500 }] }).bpm).toBe(180);
    expect(buildFullMapFooterMetadata(analyzed, { durationMs: 120000, completionTimeMs: 40000,
      timingPoints: [{ time: 0, beatLength: 500 }, { time: 30000, beatLength: 250 }] }).bpm).toBe(180);
  });
});

describe("Full-map chart end evidence", () => {
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "falls back to the analysis duration for an unavailable chart end %p",
    (chartEndTimeMs) => {
      const analyzed = summary("stable", [10, 0, 0, 0]);
      const viewModel = buildFullMapAnalysisViewModel({ summary: analyzed, beatmap: { chartEndTimeMs } });
      expect(viewModel.chartEndTimeMs).toBe(120_000);
      expect(viewModel.summary).toBe(analyzed);
    },
  );

  it("uses the analysis duration when no beatmap evidence is provided", () => {
    expect(buildFullMapAnalysisViewModel({ summary: summary("stable", [10, 0, 0, 0]) }).chartEndTimeMs).toBe(120_000);
  });

  it.each([0, 8_000])(
    "keeps the display-only chart end %p separate from statistics, completion, and footer duration",
    (chartEndTimeMs) => {
      const analyzed = analyzeFullMap({
        ruleset: "stable",
        events: [],
        hits: [
          [1_000, -10, true],
          [8_020, 20, true],
        ],
        duration: 11_000,
        baseRate: 1,
        aggregateJudgementCountsInput: [2, 0, 0, 0],
        maxComboObtained: 2,
        mapMaxCombo: 3,
        objectCoverage: { totalObjectCount: 3 },
      });
      const replay = { lastFrameTimeMs: 9_000 };
      const beatmap = { durationMs: 14_000, completionTimeMs: 11_000, objectCount: 3 };
      const baseline = buildFullMapAnalysisViewModel({ summary: analyzed, replay, beatmap });
      const viewModel = buildFullMapAnalysisViewModel({
        summary: analyzed,
        replay,
        beatmap: { ...beatmap, chartEndTimeMs },
      });

      expect(viewModel).toEqual({ ...baseline, chartEndTimeMs });
      expect(viewModel.summary).toBe(analyzed);
      expect(viewModel.summary.duration).toBe(11_000);
      expect(viewModel.summary.timing.samples).toEqual([
        { time: 1_000, offsetMs: -10 },
        { time: 8_020, offsetMs: 20 },
      ]);
      expect(viewModel.summary.timing.thirds[2].endTime).toBe(11_000);
      expect(viewModel.footer.durationMs).toBe(14_000);
      expect(viewModel.completionStatus).toBe("failed");
    },
  );
});

describe("Full-map view-model ruleset slots", () => {
  it("shows native Classic, DA settings and the actual custom rate independently of reconstruction", () => {
    const view = buildFullMapAnalysisViewModel({
      summary: summary("stable", [3, 0, 0, 0]),
      replay: {
        sourceRuleset: "lazer",
        lazerMods: [
          { acronym: "CL", settings: { classic_note_lock: false } },
          { acronym: "DA", settings: { circle_size: 0, approach_rate: 10.5, overall_difficulty: 8, drain_rate: 6 } },
          { acronym: "DT", settings: { speed_change: 1.2, adjust_pitch: true } },
        ],
      },
    });
    expect(view.mods.map((mod) => mod.acronym)).toEqual(["DT", "CL", "DA"]);
    expect(view.mods[0]).toMatchObject({ settingsLabel: "1.20×", details: "1.20× speed · Pitch changes with speed" });
    expect(view.mods[1].details).toContain("Slider head accuracy: off");
    expect(view.mods[1].details).toContain("Classic note lock: off");
    expect(view.mods[2].details).toBe("CS 0 · AR 10.5 · OD 8 · HP 6");
    expect(view.sourceRuleset).toBe("lazer");
  });

  it("uses the same resolved HT default and clamped rate as the simulator", () => {
    expect(buildFullMapReplayMods([], [{ acronym: "HT" }])[0].settingsLabel).toBe("0.75×");
    expect(buildFullMapReplayMods([], [{ acronym: "HT", settings: { speed_change: 0.4 } }])[0].settingsLabel).toBe(
      "0.50×",
    );
    expect(buildFullMapReplayMods([], [{ acronym: "DA" }])[0].details).toBe("Original map difficulty");
  });

  it("preserves the replay-native source ruleset independently of the focused reconstruction", () => {
    const reconstructed = buildFullMapAnalysisViewModel({
      summary: summary("lazer", [10, 0, 0, 0], 1),
      replay: { passed: true, sourceRuleset: "stable" },
    });
    const fallback = buildFullMapAnalysisViewModel({
      summary: summary("lazer", [10, 0, 0, 0], 1),
      replay: { passed: true },
    });

    expect(reconstructed.sourceRuleset).toBe("stable");
    expect(fallback.sourceRuleset).toBe("lazer");
  });

  it("uses Stable Slider Break and native Lazer Slider Tick without sharing the value", () => {
    const stableSummary = summary("stable", [10, 0, 0, 0]);
    stableSummary.errors.sliderBreakCount = 6;
    stableSummary.sliderMisses.sliderEndMissCount = 2;
    const lazerSummary = summary("lazer", [10, 0, 0, 0], 1);
    lazerSummary.sliderMisses.sliderTickMissCount = 9;
    lazerSummary.sliderMisses.sliderEndMissCount = 3;

    const stable = buildFullMapAnalysisViewModel({ summary: stableSummary, replay: { passed: true } });
    const lazer = buildFullMapAnalysisViewModel({ summary: lazerSummary, replay: { passed: true } });

    expect(stable.sliderMetric).toEqual({ label: "SLIDER BREAK", value: 6 });
    expect(stable.sliderEndMissCount).toBe(2);
    expect(lazer.sliderMetric).toEqual({ label: "SLIDER TICK", value: 9 });
    expect(lazer.sliderEndMissCount).toBe(3);
  });
});
