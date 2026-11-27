// SPDX-License-Identifier: MIT
using System.Text;
using Newtonsoft.Json;
using osu.Game.Beatmaps;
using osu.Game.Beatmaps.Formats;
using osu.Game.IO;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Difficulty;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Difficulty;
using osu.Game.Rulesets.Osu.Mods;
using osu.Game.Rulesets.Osu.Scoring;
using osu.Game.Rulesets.Scoring;
using osu.Game.Scoring;
using Decoder = osu.Game.Beatmaps.Formats.Decoder;

namespace RewindPerformance;

public sealed class PerformanceEngine
{
  public const string Version = "2026.730.0-official-pp-v9";
  private readonly OsuRuleset ruleset = new();
  private readonly OsuScoreProcessor scoreProcessor = new();
  private string? loadedText;
  private FlatWorkingBeatmap? working;
  private readonly Dictionary<string, CachedDifficulty> difficultyCache = new(StringComparer.Ordinal);
  private readonly Dictionary<string, CachedFullMap> fullMapCache = new(StringComparer.Ordinal);
  public int TimedCalculationCount { get; private set; }

  public PerformanceEngine()
  {
    // Native hosting can use the official loading/conversion implementation directly.
    Decoder.RegisterDependencies(new AssemblyRulesetStore());
  }

  public EngineResponse Calculate(EngineRequest request, CancellationToken cancellationToken = default)
  {
    if (request.Calculations == null || request.Calculations.Length == 0)
      throw new InvalidDataException("At least one calculation is required.");
    Load(request.Beatmap);
    var timelines = new List<Timeline>();
    foreach (CalculationRequest calculation in request.Calculations)
    {
      cancellationToken.ThrowIfCancellationRequested();
      try
      {
        Mod[] mods = ModConfiguration.Create(ruleset, calculation.Mode, calculation.Mods);
        // Analyse Relax with normal PP. Both difficulty attributes and ScoreInfo
        // must omit RX; retain every other resolved mod and its settings.
        Mod[] performanceMods = mods.Where(mod => mod is not OsuModRelax).ToArray();
        if (calculation.Scope == "full-map")
        {
          var full = GetFullMap(performanceMods, cancellationToken);
          var displayFull = calculation.Mode != "stable" && mods.Any(mod => mod is OsuModRelax)
              ? GetFullMap(mods, cancellationToken) : full;
          timelines.Add(CalculateFullMap(calculation, performanceMods, full, displayFull, cancellationToken));
          continue;
        }
        if (calculation.Scope != null) throw new InvalidDataException("Unsupported calculation scope.");
        var difficulty = GetDifficulty(performanceMods, cancellationToken);
        // Preserve native Lazer's official RX SR and Stable's normal displayed SR.
        var displayDifficulty = calculation.Mode != "stable" && mods.Any(mod => mod is OsuModRelax)
            ? GetDifficulty(mods, cancellationToken)
            : difficulty;
        timelines.Add(CalculateTimeline(calculation, performanceMods, difficulty, displayDifficulty, cancellationToken));
      }
      catch (Exception error) when (error is not OperationCanceledException)
      {
        timelines.Add(new Timeline { Mode = calculation.Mode, Error = error.Message });
      }
    }
    return new EngineResponse { Id = request.Id, Ok = true, Timelines = timelines.ToArray() };
  }

  private CachedDifficulty GetDifficulty(Mod[] mods, CancellationToken cancellationToken)
  {
    // Attributes and nested capacities depend on the resolved mods, including
    // Classic mechanics. Display-only variants must never replace PP attributes.
    string key = CanonicalMods(mods);
    if (difficultyCache.TryGetValue(key, out var cached)) return cached;
    var calculator = new TimelineDifficultyCalculator(ruleset.RulesetInfo, working!);
    var timed = calculator.CalculateTimed(mods, cancellationToken);
    TimedCalculationCount++;
    var full = (OsuDifficultyAttributes)new OsuDifficultyCalculator(ruleset.RulesetInfo, working!)
        .Calculate(mods, cancellationToken);
    if (timed.Count != working!.Beatmap.HitObjects.Count)
      throw new InvalidDataException("Official timed object count does not match the beatmap.");
    if (timed.Count > 0) VerifyDifficulty((OsuDifficultyAttributes)timed[^1].Attributes, full);
    cached = new CachedDifficulty(timed, full, PrefixCapacities(calculator.PlayableBeatmap), DifficultyTimeline(timed, full));
    if (difficultyCache.Count >= 8) difficultyCache.Clear();
    difficultyCache.Add(key, cached);
    return cached;
  }

  private void Load(string text)
  {
    if (text == loadedText) return;
    if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException("Beatmap is empty.");
    using var bytes = new MemoryStream(Encoding.UTF8.GetBytes(text));
    using var reader = new LineBufferedReader(bytes);
    Beatmap beatmap = Decoder.GetDecoder<Beatmap>(reader).Decode(reader);
    if (beatmap.BeatmapInfo.Ruleset.OnlineID != 0)
      throw new InvalidDataException("Only osu!standard beatmaps are supported.");
    beatmap.BeatmapInfo.Ruleset = ruleset.RulesetInfo;
    working = new FlatWorkingBeatmap(beatmap);
    loadedText = text;
    difficultyCache.Clear();
    fullMapCache.Clear();
  }

  private CachedFullMap GetFullMap(Mod[] mods, CancellationToken token)
  {
    string key = CanonicalMods(mods);
    if (fullMapCache.TryGetValue(key, out var cached)) return cached;
    var calculator = new TimelineDifficultyCalculator(ruleset.RulesetInfo, working!);
    var full = (OsuDifficultyAttributes)calculator.Calculate(mods, token);
    var playable = calculator.PlayableBeatmap;
    var capacity = new JudgementCapacity();
    foreach (var obj in playable.HitObjects)
    {
      token.ThrowIfCancellationRequested();
      capacity = CountCapacity(obj, capacity);
    }
    // ModConfiguration admits constant-rate mods only; time ramps remain unsupported.
    double rate = mods.OfType<IApplicableToRate>().Aggregate(1.0, (value, mod) => mod.ApplyToRate(0, value));
    double drain = playable.HitObjects.Count == 0 ? 0 : playable.CalculateDrainLength() / rate;
    double end = playable.HitObjects.Count == 0 ? 0 : playable.GetLastObjectTime();
    if (!double.IsFinite(rate) || rate <= 0 || !double.IsFinite(drain) || drain < 0 || !double.IsFinite(end))
      throw new InvalidDataException("Official full-map timing was invalid.");
    cached = new CachedFullMap(full, capacity, playable.HitObjects.Count,
        new FullMapValue(1, full.MaxCombo, capacity.LargeTicks, capacity.SmallTicks, capacity.SliderTails, rate, drain, end));
    if (fullMapCache.Count >= 8) fullMapCache.Clear();
    fullMapCache.Add(key, cached);
    return cached;
  }

  private Timeline CalculateFullMap(CalculationRequest request, Mod[] mods, CachedFullMap map,
      CachedFullMap display, CancellationToken token)
  {
    if (request.States == null || request.States.Length > 1)
      throw new InvalidDataException("Full-map calculation accepts zero or one aggregate state.");
    var result = new Timeline
    {
      Mode = request.Mode, ObjectCount = map.ObjectCount, FullMap = map.Envelope,
      FullDifficulty = new FullDifficultyValue(display.Full.StarRating, display.Full.AimDifficulty,
          display.Full.SpeedDifficulty, display.Full.ReadingDifficulty, display.Full.FlashlightDifficulty, display.Full.SliderFactor)
    };
    if (request.States.Length == 0) return result;
    token.ThrowIfCancellationRequested();
    var state = request.States[0];
    if (!double.IsFinite(state.Time) || map.ObjectCount == 0 || state.PassedObjects != map.ObjectCount)
      throw new InvalidDataException("Full-map aggregate must cover every map object.");
    var score = new ScoreInfo(working!.BeatmapInfo, ruleset.RulesetInfo) { Mods = mods, IsLegacyScore = request.Mode == "stable" };
    UpdateScore(score, state, map.Full, map.Capacity);
    var performance = CalculatePerformance(score, map.Full);
    result.Points = [new TimelinePoint(state.Time, performance.Total, display.Full.StarRating)];
    result.Final = new PerformanceValue(performance.Total, display.Full.StarRating);
    result.EndpointVerified = true; // Coverage of this calculation, not evidence the player passed.
    result.EffectiveMissCount = double.IsFinite(performance.EffectiveMissCount) && performance.EffectiveMissCount >= 0
        ? performance.EffectiveMissCount : null;
    return result;
  }

  private Timeline CalculateTimeline(CalculationRequest request, Mod[] mods, CachedDifficulty difficulty,
      CachedDifficulty displayDifficulty, CancellationToken token)
  {
    if (request.States == null) throw new InvalidDataException("States must be an array.");
    var points = new List<TimelinePoint>(request.States.Length);
    int previousCount = 0;
    double previousTime = double.NegativeInfinity;
    PerformanceValue? final = null;
    ScoreInfo? score = null;
    // The official calculator's own effective miss count, from the calculation behind the latest point's PP.
    double? effectiveMissCount = null;
    foreach (ScoreState state in request.States)
    {
      token.ThrowIfCancellationRequested();
      if (!double.IsFinite(state.Time) || state.Time < previousTime || state.PassedObjects < previousCount ||
          state.PassedObjects < 0 || state.PassedObjects > difficulty.Timed.Count)
        throw new InvalidDataException("Score states must contain ordered times and completed object prefixes.");
      previousTime = state.Time;
      previousCount = state.PassedObjects;
      if (state.PassedObjects == 0)
      {
        if (state.Statistics.Values.Any(value => value != 0) || state.MaxCombo != 0)
          throw new InvalidDataException("An empty prefix cannot contain score statistics.");
        points.Add(new TimelinePoint(state.Time, 0, 0));
        effectiveMissCount = null; // No calculation produced this point's zero.
        continue;
      }
      var attributes = (OsuDifficultyAttributes)difficulty.Timed[state.PassedObjects - 1].Attributes;
      // ScoreInfo.Mods serializes the mod configuration. Initialise it once, then
      // reuse this private score only for synchronous calculations in this timeline.
      score ??= new ScoreInfo(working!.BeatmapInfo, ruleset.RulesetInfo)
      {
        Mods = mods,
        IsLegacyScore = request.Mode == "stable"
      };
      UpdateScore(score, state, attributes, difficulty.Capacities[state.PassedObjects - 1]);
      OsuPerformanceAttributes performance = CalculatePerformance(score, attributes);
      double pp = performance.Total;
      effectiveMissCount = double.IsFinite(performance.EffectiveMissCount) && performance.EffectiveMissCount >= 0
          ? performance.EffectiveMissCount
          : null;
      double sr = displayDifficulty.Timed[state.PassedObjects - 1].Attributes.StarRating;
      points.Add(new TimelinePoint(state.Time, pp, sr));
      if (state.IsFinal || state.PassedObjects == difficulty.Timed.Count)
      {
        if (state.PassedObjects == difficulty.Timed.Count)
        {
          double independentPp = CalculatePp(score, difficulty.Full);
          RequireClose(pp, independentPp, "Timed and whole-map PP endpoints differ.");
          final = new PerformanceValue(independentPp, displayDifficulty.Full.StarRating);
        }
        else final = new PerformanceValue(pp, sr);
      }
    }
    return new Timeline
    {
      Mode = request.Mode,
      Points = points.ToArray(),
      DifficultyPoints = displayDifficulty.Points,
      FullDifficulty = new FullDifficultyValue(displayDifficulty.Full.StarRating, displayDifficulty.Full.AimDifficulty,
          displayDifficulty.Full.SpeedDifficulty, displayDifficulty.Full.ReadingDifficulty,
          displayDifficulty.Full.FlashlightDifficulty, displayDifficulty.Full.SliderFactor),
      Final = new PerformanceValue(final?.Pp ?? (points.Count > 0 ? points[^1].Pp : 0), displayDifficulty.Full.StarRating),
      EffectiveMissCount = effectiveMissCount,
      ObjectCount = difficulty.Timed.Count,
      EndpointVerified = final != null && previousCount == difficulty.Timed.Count
    };
  }

  private static StarRatingPoint[] DifficultyTimeline(List<TimedDifficultyAttributes> timed, OsuDifficultyAttributes full)
  {
    var points = new StarRatingPoint[timed.Count];
    double time = double.NegativeInfinity;
    for (int index = 0; index < timed.Count; index++)
    {
      // CalculateTimed uses map milliseconds and object order. A later circle can
      // end before an earlier overlapping slider; publish only completed prefixes.
      time = Math.Max(time, timed[index].Time);
      double sr = index == timed.Count - 1 ? full.StarRating : timed[index].Attributes.StarRating;
      if (!double.IsFinite(time) || !double.IsFinite(sr) || sr < 0)
        throw new InvalidDataException("Official timed difficulty was non-finite.");
      points[index] = new StarRatingPoint(time, sr);
    }
    return points;
  }

  private void UpdateScore(ScoreInfo score, ScoreState state, OsuDifficultyAttributes attributes, JudgementCapacity capacity)
  {
    if (state.Statistics == null || state.Statistics.Any(pair => pair.Value < 0))
      throw new InvalidDataException("Score statistics must contain non-negative counts.");
    if (state.MaxCombo < 0 || state.MaxCombo > attributes.MaxCombo)
      throw new InvalidDataException("Score combo exceeds the completed prefix.");
    var statistics = score.Statistics;
    statistics.Clear();
    foreach ((string name, int count) in state.Statistics)
    {
      if (name == "slider_tail_miss") continue; // Explicit denominator only; upstream uses IgnoreMiss.
      if (!resultNames.TryGetValue(name, out HitResult result))
        throw new InvalidDataException($"Unsupported statistic: {name}");
      statistics[result] = count;
    }
    int basicCount = statistics.GetValueOrDefault(HitResult.Great) + statistics.GetValueOrDefault(HitResult.Ok)
                     + statistics.GetValueOrDefault(HitResult.Meh) + statistics.GetValueOrDefault(HitResult.Miss);
    if (basicCount != state.PassedObjects)
      throw new InvalidDataException("Basic hit statistics must match the completed object prefix.");
    bool stable = score.IsLegacyScore;
    if (!stable)
    {
      if (statistics.GetValueOrDefault(HitResult.LargeTickHit) + statistics.GetValueOrDefault(HitResult.LargeTickMiss) != capacity.LargeTicks)
        throw new InvalidDataException("LargeTickHit statistics do not match the completed prefix.");
      if (statistics.GetValueOrDefault(HitResult.SmallTickHit) + statistics.GetValueOrDefault(HitResult.SmallTickMiss) != capacity.SmallTicks)
        throw new InvalidDataException("SmallTickHit statistics do not match the completed prefix.");
      if (statistics.GetValueOrDefault(HitResult.SliderTailHit) + state.Statistics.GetValueOrDefault("slider_tail_miss") != capacity.SliderTails)
        throw new InvalidDataException("Slider tail statistics do not match the completed prefix.");
    }
    double earned = 0;
    double possible = 300.0 * basicCount;
    foreach ((HitResult result, int count) in statistics)
    {
      if (!stable || result.IsBasic()) earned += (double)scoreProcessor.GetBaseScoreForResult(result) * count;
    }
    if (!stable)
    {
      possible += 30.0 * (statistics.GetValueOrDefault(HitResult.LargeTickHit) + statistics.GetValueOrDefault(HitResult.LargeTickMiss));
      possible += 10.0 * (statistics.GetValueOrDefault(HitResult.SmallTickHit) + statistics.GetValueOrDefault(HitResult.SmallTickMiss));
      possible += 150.0 * (statistics.GetValueOrDefault(HitResult.SliderTailHit) + state.Statistics.GetValueOrDefault("slider_tail_miss"));
    }
    // Assign nullable fields too: a later prefix may need the combo fallback.
    score.LegacyTotalScore = stable ? LegacyScore(state, attributes) : null;
    score.MaxCombo = state.MaxCombo;
    score.Accuracy = possible == 0 ? 1 : earned / possible;
  }

  private static long? LegacyScore(ScoreState state, OsuDifficultyAttributes attributes)
  {
    if (state.LegacyTotalScore.HasValue)
    {
      if (state.LegacyTotalScore < 0) throw new InvalidDataException("Legacy score cannot be negative.");
      // Current osu! treats zero as unavailable, not an observed zero-score play.
      // Match upstream f599aa8 without changing the pinned performance formula.
      return state.LegacyTotalScore > 0 ? state.LegacyTotalScore : null;
    }
    double factor = attributes.LegacyScoreBaseMultiplier;
    long[]? alternatives = state.LegacyScoreByDifficultyMultiplier;
    if (alternatives == null || !double.IsFinite(factor) || factor < 0 || factor != Math.Truncate(factor) || factor >= alternatives.Length)
      return null;
    long value = alternatives[(int)factor];
    // Stable uses a signed 32-bit score. An out-of-range reconstruction cannot
    // safely stand in for its score and must use the official combo fallback.
    return value is > 0 and <= int.MaxValue ? value : null;
  }

  private static readonly Dictionary<string, HitResult> resultNames = new(StringComparer.Ordinal)
  {
    ["great"] = HitResult.Great,
    ["ok"] = HitResult.Ok,
    ["meh"] = HitResult.Meh,
    ["miss"] = HitResult.Miss,
    ["large_tick_hit"] = HitResult.LargeTickHit,
    ["large_tick_miss"] = HitResult.LargeTickMiss,
    ["small_tick_hit"] = HitResult.SmallTickHit,
    ["small_tick_miss"] = HitResult.SmallTickMiss,
    ["slider_tail_hit"] = HitResult.SliderTailHit
  };

  private static string CanonicalMods(Mod[] mods) => JsonConvert.SerializeObject(mods.Select(mod => new osu.Game.Online.API.APIMod(mod))
      .OrderBy(mod => mod.Acronym, StringComparer.Ordinal)
      .Select(mod => new { mod.Acronym, Settings = mod.Settings.OrderBy(pair => pair.Key, StringComparer.Ordinal) }));

  private static double CalculatePp(ScoreInfo score, OsuDifficultyAttributes attributes) =>
      CalculatePerformance(score, attributes).Total;

  private static OsuPerformanceAttributes CalculatePerformance(ScoreInfo score, OsuDifficultyAttributes attributes)
  {
    // The official calculator has mutable fields; each state needs a fresh instance.
    var result = (OsuPerformanceAttributes)new OsuPerformanceCalculator().Calculate(score, attributes);
    if (!double.IsFinite(result.Total) || result.Total < 0) throw new InvalidDataException("Official PP calculation was non-finite.");
    return result;
  }

  private static void VerifyDifficulty(OsuDifficultyAttributes timed, OsuDifficultyAttributes full)
  {
    foreach (var property in typeof(OsuDifficultyAttributes).GetProperties())
    {
      if (property.PropertyType == typeof(double))
        RequireClose((double)property.GetValue(timed)!, (double)property.GetValue(full)!, $"Timed endpoint differs: {property.Name}");
      else if (property.PropertyType == typeof(int) && !Equals(property.GetValue(timed), property.GetValue(full)))
        throw new InvalidDataException($"Timed endpoint differs: {property.Name}");
    }
  }

  private static void RequireClose(double left, double right, string message)
  {
    if (!double.IsFinite(left) || !double.IsFinite(right) || Math.Abs(left - right) > Math.Max(1e-8, Math.Abs(right) * 1e-10))
      throw new InvalidDataException(message);
  }

  private static JudgementCapacity[] PrefixCapacities(IBeatmap beatmap)
  {
    var output = new JudgementCapacity[beatmap.HitObjects.Count];
    int largeTicks = 0;
    int smallTicks = 0;
    int sliderTails = 0;
    for (int index = 0; index < beatmap.HitObjects.Count; index++)
    {
      Count(beatmap.HitObjects[index]);
      output[index] = new JudgementCapacity(largeTicks, smallTicks, sliderTails);
    }
    return output;

    void Count(osu.Game.Rulesets.Objects.HitObject obj)
    {
      switch (obj.CreateJudgement().MaxResult)
      {
        case HitResult.LargeTickHit: largeTicks++; break;
        case HitResult.SmallTickHit: smallTicks++; break;
        case HitResult.SliderTailHit: sliderTails++; break;
      }
      foreach (var child in obj.NestedHitObjects) Count(child);
    }
  }

  private sealed class TimelineDifficultyCalculator(IRulesetInfo info, IWorkingBeatmap workingBeatmap)
      : OsuDifficultyCalculator(info, workingBeatmap)
  {
    public IBeatmap PlayableBeatmap => Beatmap;
  }

  private readonly record struct JudgementCapacity(int LargeTicks, int SmallTicks, int SliderTails);

  private static JudgementCapacity CountCapacity(osu.Game.Rulesets.Objects.HitObject obj, JudgementCapacity current)
  {
    current = obj.CreateJudgement().MaxResult switch
    {
      HitResult.LargeTickHit => current with { LargeTicks = checked(current.LargeTicks + 1) },
      HitResult.SmallTickHit => current with { SmallTicks = checked(current.SmallTicks + 1) },
      HitResult.SliderTailHit => current with { SliderTails = checked(current.SliderTails + 1) },
      _ => current
    };
    foreach (var child in obj.NestedHitObjects) current = CountCapacity(child, current);
    return current;
  }
  private sealed record CachedFullMap(OsuDifficultyAttributes Full, JudgementCapacity Capacity, int ObjectCount, FullMapValue Envelope);

  private sealed record CachedDifficulty(List<TimedDifficultyAttributes> Timed, OsuDifficultyAttributes Full,
      JudgementCapacity[] Capacities, StarRatingPoint[] Points);
}
