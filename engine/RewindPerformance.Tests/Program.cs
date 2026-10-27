// SPDX-License-Identifier: MIT
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using osu.Framework.Logging;
using osu.Game.Beatmaps;
using osu.Game.IO;
using osu.Game.Online.API;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Objects;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Difficulty;
using osu.Game.Rulesets.Osu.Mods;
using osu.Game.Rulesets.Osu.Scoring;
using osu.Game.Rulesets.Scoring;
using osu.Game.Scoring;
using RewindPerformance;
using Decoder = osu.Game.Beatmaps.Formats.Decoder;

try
{
    if (args.Length is 1 or 2 && args[0] == "--library-watch")
    {
        await LibraryWatchTests.Run(args.Length == 2 ? args[1] : null);
        return 0;
    }
    if (args.Length == 1 && args[0] == "--library-lzma")
    {
        LibraryLzmaTests.Run();
        return 0;
    }
    if (args.Length == 3 && args[0] == "--library-source-writer")
    {
        LibrarySourceTests.HoldWriter(args[1], args[2]);
        return 0;
    }
    if (args.Length == 2 && args[0] == "--library-source")
    {
        await LibrarySourceTests.Run(args[1]);
        return 0;
    }
    RunTests();
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine($"FAIL: {error}");
    return 1;
}

void RunTests()
{
Logger.Enabled = false;
int assertions = 0;
var engine = new PerformanceEngine();
var ruleset = new OsuRuleset();
var scoreProcessor = new OsuScoreProcessor();
string map = """
osu file format v14
[General]
Mode:0
[Metadata]
Title:Independent engine fixture
Artist:Rewind
Creator:Rewind
Version:Overlapping slider and spinner
[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:7.3
ApproachRate:8.4
SliderMultiplier:1.4
SliderTickRate:1
[TimingPoints]
0,500,4,1,0,100,1,0
[HitObjects]
64,80,1000,1,0,0:0:0:0:
100,100,1250,2,0,L|380:100,2,280
200,240,1500,1,0,0:0:0:0:
400,300,3500,1,0,0:0:0:0:
80,80,3750,1,0,0:0:0:0:
420,310,4000,1,0,0:0:0:0:
120,140,4250,1,0,0:0:0:0:
400,90,4500,2,0,L|120:300,1,200
80,280,5500,1,0,0:0:0:0:
400,90,5750,1,0,0:0:0:0:
256,192,6000,8,0,7000,0:0:0:0:
100,280,7250,1,0,0:0:0:0:
""";

var cases = new (string mode, APIMod[] api, Mod[] reference)[]
{
    ("stable", [], [new OsuModClassic()]),
    ("lazer", [], []),
    ("stable", [Api("HD"), Api("DT")], [new OsuModHidden(), new OsuModDoubleTime(), new OsuModClassic()]),
    ("lazer", [Api("NC", ("speed_change", 1.2))], [new OsuModNightcore { SpeedChange = { Value = 1.2 } }]),
    ("lazer", [Api("HT", ("speed_change", 0.65))], [new OsuModHalfTime { SpeedChange = { Value = 0.65 } }]),
    ("lazer", [Api("DA", ("circle_size", 6.2), ("approach_rate", 9.1), ("overall_difficulty", 8.37))],
        [new OsuModDifficultyAdjust { CircleSize = { Value = 6.2f }, ApproachRate = { Value = 9.1f }, OverallDifficulty = { Value = 8.37f } }]),
    ("lazer-classic", [Api("CL")], [new OsuModClassic()]),
    ("lazer-classic", [Api("CL", ("no_slider_head_accuracy", false)), Api("DT", ("speed_change", 1.3))],
        [new OsuModClassic { NoSliderHeadAccuracy = { Value = false } }, new OsuModDoubleTime { SpeedChange = { Value = 1.3 } }]),
    ("stable", [Api("V2")], [new ModScoreV2(), new OsuModClassic()]),
    ("lazer-classic", [Api("CL"), Api("RX"), Api("DT", ("speed_change", 1.2))],
        [new OsuModClassic(), new OsuModRelax(), new OsuModDoubleTime { SpeedChange = { Value = 1.2 } }]),
    ("lazer", [Api("RX"), Api("HD"), Api("DA", ("overall_difficulty", 8.37)), Api("NC", ("speed_change", 1.2))],
        [new OsuModRelax(), new OsuModHidden(), new OsuModDifficultyAdjust { OverallDifficulty = { Value = 8.37f } }, new OsuModNightcore { SpeedChange = { Value = 1.2 } }]),
    ("lazer-classic", [Api("RX"), Api("CL", ("no_slider_head_accuracy", false)), Api("DT", ("speed_change", 1.3))],
        [new OsuModRelax(), new OsuModClassic { NoSliderHeadAccuracy = { Value = false } }, new OsuModDoubleTime { SpeedChange = { Value = 1.3 } }])
};
foreach (string mode in new[] { "stable", "lazer" })
{
    Mod[] remaining = [new OsuModHardRock(), new OsuModFlashlight(), new OsuModNoFail(), new OsuModEasy(),
        new OsuModSpunOut(), new OsuModHalfTime(), new OsuModDoubleTime(), new OsuModHidden(), new OsuModTouchDevice(),
        new OsuModRelax(), new OsuModAutopilot(), new OsuModAutoplay()];
    cases = [.. cases, .. remaining.Select(mod => (mode, new[] { new APIMod(mod) },
        mode == "stable" ? new Mod[] { mod, new OsuModClassic() } : [mod]))];
}

foreach (Mod[] extra in new Mod[][] { [], [new OsuModHardRock()], [new OsuModDoubleTime()],
    [new OsuModHardRock(), new OsuModDoubleTime()], [new OsuModDoubleTime { SpeedChange = { Value = 1.2 } }] })
{
    Mod[] relax = [new OsuModRelax(), .. extra];
    cases = [.. cases, ("stable", relax.Select(mod => new APIMod(mod)).ToArray(), [.. relax, new OsuModClassic()])];
}

foreach (var test in cases)
{
    using var stream = new MemoryStream(Encoding.UTF8.GetBytes(map));
    using var reader = new LineBufferedReader(stream);
    Beatmap decoded = Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    var working = new FlatWorkingBeatmap(decoded);
    IBeatmap playable = working.GetPlayableBeatmap(ruleset.RulesetInfo, test.reference);
    // Relax is analysed with normal PP, preserving every remaining mod setting.
    Mod[] performanceMods = test.reference.Where(mod => mod is not OsuModRelax).ToArray();
    var timed = new OsuDifficultyCalculator(ruleset.RulesetInfo, working).CalculateTimed(performanceMods);
    var whole = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).Calculate(performanceMods);
    // Preserve native Lazer's official RX SR and Stable's normal displayed SR.
    Mod[] displayMods = test.mode == "stable" ? test.reference.Where(mod => mod is not OsuModRelax).ToArray() : test.reference;
    var displayTimed = new OsuDifficultyCalculator(ruleset.RulesetInfo, working).CalculateTimed(displayMods);
    var displayWhole = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).Calculate(displayMods);
    var counts = new Dictionary<HitResult, int>();
    var maximum = new Dictionary<HitResult, int>();
    var states = new List<ScoreState>();
    var expected = new List<double>();
    int tailMisses = 0;
    int maxCombo = 0;
    double lastTime = 0;
    for (int index = 0; index < playable.HitObjects.Count; index++)
    {
        foreach (HitObject obj in Descendants(playable.HitObjects[index]))
        {
            HitResult highest = obj.CreateJudgement().MaxResult;
            if (!highest.AffectsAccuracy()) continue;
            maximum[highest] = maximum.GetValueOrDefault(highest) + 1;
            // Distinct non-perfect scores exercise accuracy, ticks and dropped tails.
            HitResult actual = highest;
            if (index == 2 && highest == HitResult.Great) actual = HitResult.Ok;
            if (index == 7 && highest == HitResult.LargeTickHit) actual = HitResult.LargeTickMiss;
            if (index == 7 && highest == HitResult.SliderTailHit)
            {
                tailMisses++;
                actual = HitResult.IgnoreMiss;
            }
            if (actual != HitResult.IgnoreMiss) counts[actual] = counts.GetValueOrDefault(actual) + 1;
            if (actual.IncreasesCombo()) maxCombo++;
        }
        lastTime = Math.Max(lastTime, timed[index].Time + 80);
        var state = new ScoreState
        {
            Time = lastTime, PassedObjects = index + 1, MaxCombo = Math.Min(maxCombo, timed[index].Attributes.MaxCombo),
            Statistics = counts.ToDictionary(pair => Name(pair.Key), pair => pair.Value),
            IsFinal = index == playable.HitObjects.Count - 1
        };
        state.Statistics["slider_tail_miss"] = tailMisses;
        states.Add(state);
        var referenceStats = new Dictionary<HitResult, int>(counts);
        double earned = referenceStats.Where(pair => test.mode != "stable" || pair.Key.IsBasic())
            .Sum(pair => (double)scoreProcessor.GetBaseScoreForResult(pair.Key) * pair.Value);
        double possible = maximum.Where(pair => test.mode != "stable" || pair.Key.IsBasic())
            .Sum(pair => (double)scoreProcessor.GetBaseScoreForResult(pair.Key) * pair.Value);
        var referenceScore = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
        {
            Mods = performanceMods, IsLegacyScore = test.mode == "stable", Statistics = referenceStats,
            Accuracy = earned / possible, MaxCombo = state.MaxCombo
        };
        expected.Add(new OsuPerformanceCalculator().Calculate(referenceScore, timed[index].Attributes).Total);
    }
    var request = new EngineRequest { Beatmap = map, Calculations = [new() { Mode = test.mode, Mods = test.api, States = states.ToArray() }] };
    // Serialization round-trip exercises snake-case official APIMod settings and the worker DTO.
    request = JsonConvert.DeserializeObject<EngineRequest>(JsonConvert.SerializeObject(request, Protocol.JsonSettings), Protocol.JsonSettings)!;
    var result = engine.Calculate(request).Timelines.Single();
    Check(result.Error == null, test.mode + " engine: " + result.Error);
    CheckFullDifficulty(result, displayWhole, test.mode + " complete replay");
    Check(result.EndpointVerified && result.ObjectCount == playable.HitObjects.Count, test.mode + " complete endpoint");
    // Library P must use the whole-map calculator without constructing timed prefixes.
    var compactEngine = new PerformanceEngine();
    EngineRequest Compact(ScoreState[] aggregate) => JsonConvert.DeserializeObject<EngineRequest>(JsonConvert.SerializeObject(new
    {
        beatmap = map, calculations = new[] { new { mode = test.mode, mods = test.api, scope = "full-map", states = aggregate } }
    }, Protocol.JsonSettings), Protocol.JsonSettings)!;
    var compact = compactEngine.Calculate(Compact([states[^1]])).Timelines.Single();
    Check(compact.Error == null, test.mode + " compact engine: " + compact.Error);
    Check(compactEngine.TimedCalculationCount == 0, "compact requests never calculate timeline prefixes");
    Check(compact.Points.Length == 1 && compact.DifficultyPoints.Length == 0, "compact returns only requested aggregate");
    Check(compact.EndpointVerified && compact.ObjectCount == playable.HitObjects.Count, "compact aggregate coverage");
    Close(compact.Final!.Pp, expected[^1], test.mode + " compact PP matches official full-map calculation");
    CheckFullDifficulty(compact, displayWhole, test.mode + " compact display difficulty");
    var envelope = JObject.FromObject(compact, JsonSerializer.Create(Protocol.JsonSettings))["fullMap"]!;
    Check(envelope != null, "compact includes qualified map envelope");
    Check((int)envelope!["version"]! == 1 && (int)envelope["maxCombo"]! == whole.MaxCombo, "compact exact combo");
    Check((int)envelope["largeTicks"]! == maximum.GetValueOrDefault(HitResult.LargeTickHit), "compact large tick capacity");
    Check((int)envelope["smallTicks"]! == maximum.GetValueOrDefault(HitResult.SmallTickHit), "compact small tick capacity");
    Check((int)envelope["sliderTails"]! == maximum.GetValueOrDefault(HitResult.SliderTailHit), "compact tail capacity");
    double clockRate = performanceMods.OfType<IApplicableToRate>().Aggregate(1.0, (rate, mod) => mod.ApplyToRate(0, rate));
    Close((double)envelope["clockRate"]!, clockRate, "compact resolved custom rate");
    Close((double)envelope["drainTimeMs"]!, playable.CalculateDrainLength() / clockRate, "compact rate-adjusted drain duration");
    Close((double)envelope["endTimeMs"]!, playable.GetLastObjectTime(), "compact endpoint in map time");
    var mapOnly = compactEngine.Calculate(Compact([])).Timelines.Single();
    Check(mapOnly.Error == null && mapOnly.Points.Length == 0 && mapOnly.Final == null && !mapOnly.EndpointVerified,
        "map-only request does not fabricate achieved PP or completion");
    CheckFullDifficulty(mapOnly, displayWhole, "map-only difficulty remains available", false);
    var invalidCompactPrefix = compactEngine.Calculate(Compact([states[3]])).Timelines.Single();
    Check(invalidCompactPrefix.Error != null && invalidCompactPrefix.Final == null, "full-map path rejects partial aggregate");
    Check(compactEngine.TimedCalculationCount == 0, "map-only/cache/invalid aggregate never calculate prefixes");
    Check(result.DifficultyPoints.Length == timed.Count, test.mode + " full timed SR timeline");
    double difficultyTime = double.NegativeInfinity;
    for (int index = 0; index < states.Count; index++)
    {
        Close(result.Points[index].Pp, expected[index], test.mode + " progressive PP");
        Close(result.Points[index].Sr, displayTimed[index].Attributes.StarRating, test.mode + " progressive display SR");
        difficultyTime = Math.Max(difficultyTime, timed[index].Time);
        Close(result.DifficultyPoints[index].Time, difficultyTime, test.mode + " SR uses monotonic map-time completions");
        Close(result.DifficultyPoints[index].Sr, displayTimed[index].Attributes.StarRating, test.mode + " independent progressive SR");
    }
    Close(result.Final!.Pp, expected[^1], test.mode + " final PP");
    Close(result.Final.Sr, displayWhole.StarRating, test.mode + " independent whole-map display SR");
    if (test.api.Any(mod => mod.Acronym is "RX" or "AP" or "AT"))
        Check(result.Final.Pp > 0 && result.Final.Sr > 0, test.mode + " unranked mods retain meaningful PP and SR");
    Check(result.DifficultyPoints[^1].Sr == displayWhole.StarRating, test.mode + " SR endpoint exactly matches normal full calculation");
    if (test.api.Any(mod => mod.Acronym == "RX"))
    {
        var withoutRelax = engine.Calculate(new EngineRequest { Beatmap = map, Calculations = [new()
        {
            Mode = test.mode, Mods = test.api.Where(mod => mod.Acronym != "RX").ToArray(), States = states.ToArray()
        }] }).Timelines.Single();
        Check(withoutRelax.Error == null, test.mode + " normal PP comparison succeeds");
        for (int index = 0; index < states.Count; index++)
            Close(result.Points[index].Pp, withoutRelax.Points[index].Pp, test.mode + " RX PP equals normal PP at prefix " + index);
        Check(request.Calculations[0].Mods.Any(mod => mod.Acronym == "RX"), "normal PP mapping preserves input replay mods");
    }
    int calls = engine.TimedCalculationCount;
    engine.Calculate(request);
    Check(engine.TimedCalculationCount == calls, "identical effective mods reuse timed attributes");
    CheckScoreStateReuse(test.mode, test.api, performanceMods, decoded, whole, displayWhole, maximum);
    Check(engine.TimedCalculationCount == calls, "score state corrections reuse difficulty");
    var partialState = states[3];
    partialState.IsFinal = true;
    request.Calculations[0].States = [partialState];
    var partial = engine.Calculate(request).Timelines.Single();
    CheckFullDifficulty(partial, displayWhole, test.mode + " failed replay");
    Close(partial.Final!.Pp, expected[3], "partial endpoint uses prefix PP");
    Close(partial.Final.Sr, displayWhole.StarRating, "failed replay SR ends at full-map difficulty");
    Check(partial.Points.Length == 1 && partial.Points[0].Time == partialState.Time, "failed replay adds no fabricated PP states");
    Check(partial.DifficultyPoints[^1].Time > partial.Points[^1].Time, "SR continues past failed replay end");
    Check(ReferenceEquals(partial.DifficultyPoints, result.DifficultyPoints), "score variants reuse the cached map SR timeline");
    Check(!partial.EndpointVerified, "partial score is not labeled whole-map verified");
    request.Calculations[0].States = [];
    var beforeFirstObject = engine.Calculate(request).Timelines.Single();
    CheckFullDifficulty(beforeFirstObject, displayWhole, test.mode + " empty replay");
    Check(beforeFirstObject.Points.Length == 0, "failure before first completed object has no earned PP states");
    Close(beforeFirstObject.Final!.Pp, 0, "failure before first object retains zero PP");
    Close(beforeFirstObject.Final.Sr, displayWhole.StarRating, "failure before first object still has full-map terminal SR");
    Check(beforeFirstObject.DifficultyPoints.Length == timed.Count, "empty replay prefix retains full SR timeline");
    Check(engine.TimedCalculationCount == calls, "failure and empty prefixes do not recalculate difficulty");
    if (test.mode == "stable")
    {
        ScoreState finalState = states[^1];
        finalState.LegacyScoreByDifficultyMultiplier = Enumerable.Repeat(10_000L, 11).ToArray();
        request.Calculations[0].States = [finalState];
        var selectedTable = engine.Calculate(request).Timelines.Single();
        var basic = finalState.Statistics;
        double accuracy = (300.0 * basic.GetValueOrDefault("great") + 100.0 * basic.GetValueOrDefault("ok") + 50.0 * basic.GetValueOrDefault("meh")) / (300 * finalState.PassedObjects);
        var referenceScore = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
        {
            Mods = performanceMods, IsLegacyScore = true, Accuracy = accuracy, MaxCombo = finalState.MaxCombo,
            Statistics = new Dictionary<HitResult, int>(counts), LegacyTotalScore = 10_000
        };
        Close(selectedTable.Final!.Pp, new OsuPerformanceCalculator().Calculate(referenceScore, whole).Total, "official raw difficulty multiplier selects reconstructed score");
        finalState.LegacyTotalScore = 20_000;
        referenceScore.LegacyTotalScore = 20_000;
        var authoritative = engine.Calculate(request).Timelines.Single();
        Close(authoritative.Final!.Pp, new OsuPerformanceCalculator().Calculate(referenceScore, whole).Total, "header score takes precedence over prefix reconstruction");
        finalState.LegacyTotalScore = null;
        finalState.LegacyScoreByDifficultyMultiplier = Enumerable.Repeat((long)int.MaxValue + 1, 11).ToArray();
        var overflow = engine.Calculate(request).Timelines.Single();
        Close(overflow.Final!.Pp, expected[^1], "overflowed ScoreV1 reconstruction uses official fallback");
    }
}

CheckOfficialBreakEstimates();
CheckMissingLegacyScore();
CheckEffectiveMissCount();

CheckCacheSharing("stable", [], "lazer-classic", [Api("CL")], true, "Stable and default Classic");
CheckCacheSharing("stable", [Api("HD"), Api("DT")], "lazer-classic", [Api("DT"), Api("CL"), Api("HD")], true, "resolved mod order");
CheckCacheSharing("stable", [Api("CL", ("no_slider_head_accuracy", false))], "lazer-classic", [Api("CL")], true, "Stable replaces requested Classic with defaults");
CheckCacheSharing("stable", [], "lazer", [], false, "native and Classic judgement capacities");
CheckCacheSharing("lazer-classic", [Api("CL")], "lazer-classic", [Api("CL", ("no_slider_head_accuracy", false))], false, "Classic slider accuracy setting");
CheckCacheSharing("lazer-classic", [Api("CL")], "lazer-classic", [Api("CL", ("classic_note_lock", false))], false, "other Classic settings remain part of the key");
CheckCacheSharing("lazer", [Api("DT", ("speed_change", 1.2))], "lazer", [Api("DT", ("speed_change", 1.3))], false, "custom clock rate");
CheckCacheSharing("lazer", [Api("DA", ("overall_difficulty", 8))], "lazer", [Api("DA", ("overall_difficulty", 8.1))], false, "Difficulty Adjust value");
CheckCacheSharing("lazer", [Api("DT")], "lazer", [Api("DT", ("speed_change", 1.5))], true, "explicit default clock rate");
CheckCacheSharing("stable", [Api("V2")], "lazer-classic", [Api("SV2"), Api("CL")], true, "normalised ScoreV2 alias");

var relaxCacheEngine = new PerformanceEngine();
var relaxCache = relaxCacheEngine.Calculate(new EngineRequest { Beatmap = map, Calculations = [
    new() { Mode = "stable", Mods = [Api("RX"), Api("HR"), Api("DT")] },
    new() { Mode = "stable", Mods = [Api("DT"), Api("HR")] },
    new() { Mode = "lazer-classic", Mods = [Api("CL"), Api("HR"), Api("RX"), Api("DT")] }
] });
Check(relaxCache.Timelines.All(t => t.Error == null), "Relax cache variants succeed");
Check(relaxCacheEngine.TimedCalculationCount == 2, "normal PP attributes and native Relax SR each calculated once");
Check(ReferenceEquals(relaxCache.Timelines[0].DifficultyPoints, relaxCache.Timelines[1].DifficultyPoints), "Stable RX reuses normal-mod displayed SR cache");
Check(!ReferenceEquals(relaxCache.Timelines[0].DifficultyPoints, relaxCache.Timelines[2].DifficultyPoints), "native Classic RX retains its distinct displayed SR");
Check(relaxCache.Timelines[0].Final!.Sr > relaxCache.Timelines[2].Final!.Sr, "Stable display retains tapping difficulty while native RX excludes it");

foreach (var badMods in new[]
{
    new[] { Api("UNKNOWN") }, new[] { Api("RX", ("unknown", 4)) }, new[] { Api("DA", ("unknown", 4)) },
    new[] { Api("DT", ("speed_change", "1.2")) }, new[] { Api("CL", ("classic_note_lock", 1)) },
    new[] { Api("HD", ("only_fade_approach_circles", true)) }, new[] { Api("DT"), Api("HT") },
    new[] { Api("DA"), Api("HR") }
})
{
    Throws(() => ModConfiguration.Create(ruleset, "lazer", badMods), "unsupported settings must fail explicitly");
}
Throws(() => ModConfiguration.Create(ruleset, "lazer", [Api("CL")]), "Classic mechanics cannot be labeled native lazer");
Throws(() => ModConfiguration.Create(ruleset, "lazer-classic", []), "lazer-classic requires explicit Classic configuration");
var rateA = ModConfiguration.Create(ruleset, "lazer", [Api("DT", ("speed_change", 1.2))]);
var rateB = ModConfiguration.Create(ruleset, "lazer", [Api("DT", ("speed_change", 1.3))]);
Check(((OsuModDoubleTime)rateA.Single()).SpeedChange.Value == 1.2, "custom DT rate preserved");
Check(((OsuModDoubleTime)rateB.Single()).SpeedChange.Value == 1.3, "different custom DT rate preserved");
var invalidPrefix = engine.Calculate(new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "lazer", States = [new() { PassedObjects = 1, Statistics = [] }] }] });
Check(invalidPrefix.Timelines.Single().Error != null, "future objects never filled as 300");
var isolated = engine.Calculate(new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "stable", States = [] }, new() { Mode = "lazer", Mods = [Api("UNKNOWN")] }] });
Check(isolated.Ok && isolated.Timelines[0].Error == null && isolated.Timelines[1].Error != null, "one unsupported mode preserves the other result");
Console.WriteLine($"PASS: {assertions} native engine assertions, {cases.Length} official reference variants.");

void CheckFullDifficulty(Timeline timeline, OsuDifficultyAttributes expected, string label, bool hasFinal = true)
{
    // Exercise the public JSON contract: a prefix or PP-only RX calculation must
    // never replace the independently calculated whole-map display attributes.
    var serialized = JObject.Parse(JsonConvert.SerializeObject(timeline, Protocol.JsonSettings));
    Check(serialized["fullDifficulty"] is JObject, label + " publishes fullDifficulty");
    var actual = (JObject)serialized["fullDifficulty"]!;
    var values = new Dictionary<string, double>
    {
        ["total"] = expected.StarRating,
        ["aim"] = expected.AimDifficulty,
        ["speed"] = expected.SpeedDifficulty,
        ["reading"] = expected.ReadingDifficulty,
        ["flashlight"] = expected.FlashlightDifficulty,
        ["sliderFactor"] = expected.SliderFactor
    };
    Check(actual.Properties().Select(property => property.Name).Order().SequenceEqual(values.Keys.Order()),
        label + " serializes all six difficulty fields with camelCase names");
    foreach (var (name, value) in values)
        Close(actual.Value<double>(name), value, label + " official whole-map " + name);
    if (hasFinal) Close(actual.Value<double>("total"), timeline.Final!.Sr, label + " total equals displayed terminal SR");
    var roundTrip = JsonConvert.DeserializeObject<Timeline>(serialized.ToString(), Protocol.JsonSettings)!;
    Check(JToken.DeepEquals(serialized, JObject.Parse(JsonConvert.SerializeObject(roundTrip, Protocol.JsonSettings))),
        label + " response round-trip retains difficulty attributes");
}

void CheckOfficialBreakEstimates()
{
    using var stream = new MemoryStream(Encoding.UTF8.GetBytes(map));
    using var reader = new LineBufferedReader(stream);
    Beatmap decoded = Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    var working = new FlatWorkingBeatmap(decoded);
    var mods = new Mod[] { new OsuModClassic() };
    var whole = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).Calculate(mods);
    var state = new ScoreState
    {
        Time = 8000, PassedObjects = decoded.HitObjects.Count, MaxCombo = whole.MaxCombo - 2,
        Statistics = new() { ["great"] = decoded.HitObjects.Count - 1, ["ok"] = 1 }, IsFinal = true
    };
    var request = new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "stable", States = [state] }] };
    foreach (bool missed in new[] { false, true })
    {
        state.Statistics.Remove("ok");
        state.Statistics.Remove("miss");
        state.Statistics[missed ? "miss" : "ok"] = 1;
        var reference = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
        {
            Mods = mods, IsLegacyScore = true, MaxCombo = state.MaxCombo,
            Accuracy = (300.0 * (state.PassedObjects - 1) + (missed ? 0 : 100)) / (300 * state.PassedObjects),
            Statistics = new() { [HitResult.Great] = state.PassedObjects - 1, [missed ? HitResult.Miss : HitResult.Ok] = 1 }
        };
        var actual = engine.Calculate(request).Timelines.Single();
        Check(actual.Error == null, "official near-FC estimate succeeds");
        Close(actual.Final!.Pp, new OsuPerformanceCalculator().Calculate(reference, whole).Total,
            "near-FC break handling matches official formula without additional penalties");
    }
}

void CheckMissingLegacyScore()
{
    using var stream = new MemoryStream(Encoding.UTF8.GetBytes(map));
    using var reader = new LineBufferedReader(stream);
    Beatmap decoded = Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    var working = new FlatWorkingBeatmap(decoded);
    var whole = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).Calculate([new OsuModClassic()]);
    var state = new ScoreState
    {
        Time = 8000, PassedObjects = decoded.HitObjects.Count,
        Statistics = new() { ["great"] = decoded.HitObjects.Count - 3, ["ok"] = 2, ["miss"] = 1 }, IsFinal = true
    };
    var request = new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "stable", States = [state] }] };
    for (int combo = 1; combo <= whole.MaxCombo; combo++)
    {
        state.MaxCombo = combo;
        state.LegacyTotalScore = null;
        var missing = engine.Calculate(request).Timelines.Single();
        state.LegacyTotalScore = 0;
        var zero = engine.Calculate(request).Timelines.Single();
        Close(zero.Final!.Pp, missing.Final!.Pp, "zero legacy score uses latest official missing-score fallback at combo " + combo);
    }
}

void CheckEffectiveMissCount()
{
    // The page shows the official calculator's own effective miss count, taken from the calculation behind the
    // last point's PP. It is a top-level timeline field: never in fullDifficulty and never on a point.
    using var stream = new MemoryStream(Encoding.UTF8.GetBytes(map));
    using var reader = new LineBufferedReader(stream);
    Beatmap decoded = Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    var working = new FlatWorkingBeatmap(decoded);
    var mods = new Mod[] { new OsuModClassic() };
    var whole = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).Calculate(mods);
    int total = decoded.HitObjects.Count;
    var state = new ScoreState
    {
        Time = 8000, PassedObjects = total, MaxCombo = whole.MaxCombo, Statistics = new() { ["great"] = total }, IsFinal = true
    };
    var request = new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "stable", States = [state] }] };

    var fullCombo = engine.Calculate(request).Timelines.Single();
    Check(fullCombo.Error == null, "full-combo SS effective miss calculation succeeds: " + fullCombo.Error);
    Close(fullCombo.EffectiveMissCount ?? double.NaN, 0, "a full-combo SS has no effective misses");
    var serialized = JObject.Parse(JsonConvert.SerializeObject(fullCombo, Protocol.JsonSettings));
    Close(serialized.Value<double?>("effectiveMissCount") ?? double.NaN, 0, "effective miss count is serialized as effectiveMissCount");
    Check(((JObject)serialized["fullDifficulty"]!).Property("effectiveMissCount") == null, "fullDifficulty does not carry the effective miss count");
    Check(((JArray)serialized["points"]!).All(point => ((JObject)point).Property("effectiveMissCount") == null), "timeline points do not carry the effective miss count");

    foreach (int misses in new[] { 1, 2, 3 })
    {
        state.Statistics = new() { ["great"] = total - misses, ["miss"] = misses };
        state.MaxCombo = whole.MaxCombo / 2;
        var missed = engine.Calculate(request).Timelines.Single();
        Check(missed.Error == null, "effective miss calculation with misses succeeds: " + missed.Error);
        double count = missed.EffectiveMissCount ?? double.NaN;
        Check(double.IsFinite(count) && count >= misses, $"{misses} misses give an effective miss count of at least {misses}: {count}");
        var reference = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
        {
            Mods = mods, IsLegacyScore = true, MaxCombo = state.MaxCombo,
            Accuracy = (double)(total - misses) / total,
            Statistics = new() { [HitResult.Great] = total - misses, [HitResult.Miss] = misses }
        };
        var official = (OsuPerformanceAttributes)new OsuPerformanceCalculator().Calculate(reference, whole);
        Close(count, official.EffectiveMissCount, $"{misses} misses: the engine reports the official calculator's effective miss count");
    }

    // With only greats and misses the official formula returns the plain miss count, so the loop above cannot tell
    // the official count from it. 100s and a combo far below the map's give a count above 0 with no miss at all,
    // and that comes only from the official calculator's combo-based estimate.
    int oks = 2;
    state.Statistics = new() { ["great"] = total - oks, ["ok"] = oks };
    state.MaxCombo = whole.MaxCombo / 2;
    var noMiss = engine.Calculate(request).Timelines.Single();
    Check(noMiss.Error == null, "effective miss calculation without misses succeeds: " + noMiss.Error);
    var noMissReference = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
    {
        Mods = mods, IsLegacyScore = true, MaxCombo = state.MaxCombo,
        Accuracy = (300.0 * (total - oks) + 100.0 * oks) / (300.0 * total),
        Statistics = new() { [HitResult.Great] = total - oks, [HitResult.Ok] = oks }
    };
    var noMissOfficial = (OsuPerformanceAttributes)new OsuPerformanceCalculator().Calculate(noMissReference, whole);
    double noMissCount = JObject.Parse(JsonConvert.SerializeObject(noMiss, Protocol.JsonSettings)).Value<double?>("effectiveMissCount") ?? double.NaN;
    Check(double.IsFinite(noMissCount) && noMissCount > 0, $"100s and a low combo give a serialized effective miss count above 0 with no miss: {noMissCount}");
    Close(noMissCount, noMissOfficial.EffectiveMissCount, "no misses: the serialized effectiveMissCount is the official calculator's effective miss count");

    // With several states the count is the last state's: the one behind the last point's PP. States are cumulative,
    // so the first is clean (the first 6 objects, all 300s, the prefix's own full combo: its official count is 0) and
    // the last carries the misses (an official count of at least 2). A last state read as the first, or the largest
    // of the two, would give 0, or the wrong number.
    int firstObjects = 6;
    var prefixAttributes = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working).CalculateTimed(mods)[firstObjects - 1].Attributes;
    int prefixCombo = prefixAttributes.MaxCombo;
    var prefixReference = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
    {
        Mods = mods, IsLegacyScore = true, MaxCombo = prefixCombo, Accuracy = 1,
        Statistics = new() { [HitResult.Great] = firstObjects }
    };
    var prefixOfficial = (OsuPerformanceAttributes)new OsuPerformanceCalculator().Calculate(prefixReference, prefixAttributes);
    int finalMisses = 2;
    int finalCombo = Math.Max(prefixCombo, whole.MaxCombo / 2);
    var finalReference = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
    {
        Mods = mods, IsLegacyScore = true, MaxCombo = finalCombo,
        Accuracy = (double)(total - finalMisses) / total,
        Statistics = new() { [HitResult.Great] = total - finalMisses, [HitResult.Miss] = finalMisses }
    };
    var finalOfficial = (OsuPerformanceAttributes)new OsuPerformanceCalculator().Calculate(finalReference, whole);
    Close(prefixOfficial.EffectiveMissCount, 0, "a full-combo prefix with only 300s has an official effective miss count of 0");
    Check(finalOfficial.EffectiveMissCount >= finalMisses, $"two misses give an official effective miss count of at least 2: {finalOfficial.EffectiveMissCount}");
    Check(finalOfficial.EffectiveMissCount - prefixOfficial.EffectiveMissCount > 1, "the first and last states have effective miss counts more than 1 apart");
    var early = new ScoreState { Time = 4000, PassedObjects = firstObjects, MaxCombo = prefixCombo, Statistics = new() { ["great"] = firstObjects } };
    var lastState = new ScoreState
    {
        Time = 8000, PassedObjects = total, MaxCombo = finalCombo, Statistics = new() { ["great"] = total - finalMisses, ["miss"] = finalMisses }, IsFinal = true
    };
    var twoStates = new EngineRequest { Beatmap = map, Calculations = [new() { Mode = "stable", States = [early, lastState] }] };
    var both = engine.Calculate(twoStates).Timelines.Single();
    Check(both.Error == null, "effective miss calculation with several states succeeds: " + both.Error);
    double lastCount = JObject.Parse(JsonConvert.SerializeObject(both, Protocol.JsonSettings)).Value<double?>("effectiveMissCount") ?? double.NaN;
    Close(lastCount, finalOfficial.EffectiveMissCount, "several states: the serialized effectiveMissCount is the official calculation for the last state");

    // Nothing was calculated for an empty prefix, so there is no count to report.
    request.Calculations[0].States = [];
    var empty = engine.Calculate(request).Timelines.Single();
    Check(empty.Error == null && empty.EffectiveMissCount == null, "an empty replay has no effective miss count");
    Check(JObject.Parse(JsonConvert.SerializeObject(empty, Protocol.JsonSettings)).Property("effectiveMissCount") == null, "an absent effective miss count is left out of the response");
}

void CheckCacheSharing(string firstMode, APIMod[] firstMods, string secondMode, APIMod[] secondMods, bool shared, string label)
{
    var cacheEngine = new PerformanceEngine();
    var first = new CalculationRequest { Mode = firstMode, Mods = firstMods };
    var second = new CalculationRequest { Mode = secondMode, Mods = secondMods };
    var result = cacheEngine.Calculate(new EngineRequest { Beatmap = map, Calculations = [first, second] });
    Check(result.Timelines.All(timeline => timeline.Error == null), label + " calculations succeed");
    Check(cacheEngine.TimedCalculationCount == (shared ? 1 : 2), label + " calculation count");
    Check(ReferenceEquals(result.Timelines[0].DifficultyPoints, result.Timelines[1].DifficultyPoints) == shared, label + " cached timeline identity");

    // A fresh engine is independent of the shared cache and must produce the same result.
    var independent = new PerformanceEngine().Calculate(new EngineRequest { Beatmap = map, Calculations = [second] }).Timelines.Single();
    Check(JsonConvert.SerializeObject(result.Timelines[1]) == JsonConvert.SerializeObject(independent), label + " independent result equivalence");
}

void CheckScoreStateReuse(string mode, APIMod[] api, Mod[] reference, Beatmap decoded, OsuDifficultyAttributes whole, OsuDifficultyAttributes displayWhole, Dictionary<HitResult, int> maximum)
{
    // Equal object prefixes are valid for score corrections. Alternating miss and
    // perfect corrections exercises removal of old statistics and nullable scores.
    var corrections = new List<ScoreState>();
    var referencePp = new List<double>();
    for (int index = 0; index < 6; index++)
    {
        bool imperfect = index % 2 == 0;
        var statistics = new Dictionary<HitResult, int>(maximum);
        int missedTails = 0;
        if (imperfect)
        {
            statistics[HitResult.Great] -= 3;
            statistics[HitResult.Ok] = 1;
            statistics[HitResult.Meh] = 1;
            statistics[HitResult.Miss] = 1;
            MissNested(HitResult.LargeTickHit, HitResult.LargeTickMiss);
            MissNested(HitResult.SmallTickHit, HitResult.SmallTickMiss);
            if (statistics.GetValueOrDefault(HitResult.SliderTailHit) > 0)
            {
                statistics[HitResult.SliderTailHit]--;
                missedTails = 1;
            }
        }
        var state = new ScoreState
        {
            Time = 8000 + index,
            PassedObjects = decoded.HitObjects.Count,
            MaxCombo = imperfect ? 2 : whole.MaxCombo,
            Statistics = statistics.ToDictionary(pair => Name(pair.Key), pair => pair.Value),
            LegacyTotalScore = index == 0 ? 20_000 : null,
            LegacyScoreByDifficultyMultiplier = index is 0 or 2 ? Enumerable.Repeat(10_000L, 11).ToArray() : null,
            IsFinal = index == 5
        };
        if (missedTails > 0) state.Statistics["slider_tail_miss"] = missedTails;
        corrections.Add(state);
        double earned = statistics.Where(pair => mode != "stable" || pair.Key.IsBasic())
            .Sum(pair => (double)scoreProcessor.GetBaseScoreForResult(pair.Key) * pair.Value);
        double possible = maximum.Where(pair => mode != "stable" || pair.Key.IsBasic())
            .Sum(pair => (double)scoreProcessor.GetBaseScoreForResult(pair.Key) * pair.Value);
        var referenceScore = new ScoreInfo(decoded.BeatmapInfo, ruleset.RulesetInfo)
        {
            Mods = reference,
            IsLegacyScore = mode == "stable",
            Statistics = statistics,
            MaxCombo = state.MaxCombo,
            Accuracy = earned / possible,
            LegacyTotalScore = mode != "stable" ? null : index == 0 ? 20_000 : index == 2 ? 10_000 : null
        };
        referencePp.Add(new OsuPerformanceCalculator().Calculate(referenceScore, whole).Total);

        void MissNested(HitResult hit, HitResult miss)
        {
            if (statistics.GetValueOrDefault(hit) <= 0) return;
            statistics[hit]--;
            statistics[miss] = 1;
        }
    }
    var calculation = new CalculationRequest { Mode = mode, Mods = api, States = corrections.ToArray() };
    var result = engine.Calculate(new EngineRequest { Beatmap = map, Calculations = [calculation] }).Timelines.Single();
    Check(result.Error == null, mode + " score corrections succeed: " + result.Error);
    Check(result.Points.Length == corrections.Count && result.EndpointVerified, mode + " score correction points and endpoint retained");
    for (int index = 0; index < corrections.Count; index++)
    {
        Close(result.Points[index].Pp, referencePp[index], mode + " reused score matches fresh score at correction " + index);
        Close(result.Points[index].Sr, displayWhole.StarRating, mode + " score corrections retain display difficulty");
        Close(result.Points[index].Time, corrections[index].Time, mode + " score corrections retain timing");
    }
    Check(!corrections[1].Statistics.ContainsKey("miss"), "score reuse does not mutate input statistics");
    Close(result.Final!.Pp, referencePp[^1], mode + " score correction final PP");
    if (mode == "stable") return;

    foreach (HitResult nestedResult in new[] { HitResult.LargeTickHit, HitResult.SmallTickHit, HitResult.SliderTailHit })
    {
        if (maximum.GetValueOrDefault(nestedResult) == 0) continue;
        foreach (int adjustment in new[] { -1, 1 })
        {
            var state = corrections[^1];
            state.Statistics[Name(nestedResult)] += adjustment;
            calculation.States = [state];
            var invalid = engine.Calculate(new EngineRequest { Beatmap = map, Calculations = [calculation] }).Timelines.Single();
            string expectedError = nestedResult == HitResult.SliderTailHit
                ? "Slider tail statistics do not match the completed prefix."
                : $"{nestedResult} statistics do not match the completed prefix.";
            Check(invalid.Error == expectedError, mode + " compact capacity rejects " + nestedResult + " adjustment " + adjustment);
            state.Statistics[Name(nestedResult)] -= adjustment;
        }
    }
}

APIMod Api(string acronym, params (string name, object value)[] settings) => new()
{
    Acronym = acronym, Settings = settings.ToDictionary(pair => pair.name, pair => pair.value)
};
IEnumerable<HitObject> Descendants(HitObject obj)
{
    yield return obj;
    foreach (var child in obj.NestedHitObjects)
        foreach (var nested in Descendants(child)) yield return nested;
}
string Name(HitResult result) => result switch
{
    HitResult.Great => "great", HitResult.Ok => "ok", HitResult.Meh => "meh", HitResult.Miss => "miss",
    HitResult.LargeTickHit => "large_tick_hit", HitResult.LargeTickMiss => "large_tick_miss",
    HitResult.SmallTickHit => "small_tick_hit", HitResult.SmallTickMiss => "small_tick_miss",
    HitResult.SliderTailHit => "slider_tail_hit", _ => throw new Exception("Unexpected fixture result")
};
void Check(bool condition, string label)
{
    assertions++;
    if (!condition) throw new Exception(label);
}
void Close(double actual, double expected, string label) => Check(double.IsFinite(actual) && Math.Abs(actual - expected) <= Math.Max(1e-8, Math.Abs(expected) * 1e-10), $"{label}: {actual} != {expected}");
void Throws(Action action, string label)
{
    try { action(); } catch (InvalidDataException) { assertions++; return; }
    throw new Exception(label);
}
}
