// SPDX-License-Identifier: MIT
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using osu.Game.Online.API;

namespace RewindPerformance;

public static class Protocol
{
  public static readonly JsonSerializerSettings JsonSettings = new()
  {
    ContractResolver = new CamelCasePropertyNamesContractResolver(),
    MissingMemberHandling = MissingMemberHandling.Error,
    FloatParseHandling = FloatParseHandling.Double,
    MaxDepth = 32
  };
}

public sealed class EngineRequest
{
  public JToken? Id { get; set; }
  public string Beatmap { get; set; } = "";
  public CalculationRequest[] Calculations { get; set; } = [];
}

public sealed class CalculationRequest
{
  /// <summary>Absent preserves the viewer timeline; full-map never computes prefixes.</summary>
  public string? Scope { get; set; }
  public string Mode { get; set; } = "";
  public APIMod[] Mods { get; set; } = [];
  public ScoreState[] States { get; set; } = [];
}

public sealed class ScoreState
{
  public double Time { get; set; }
  public int PassedObjects { get; set; }
  public int MaxCombo { get; set; }
  public Dictionary<string, int> Statistics { get; set; } = new(StringComparer.Ordinal);
  public long? LegacyTotalScore { get; set; }
  public long[]? LegacyScoreByDifficultyMultiplier { get; set; }
  public bool IsFinal { get; set; }
}

public sealed class EngineResponse
{
  public JToken? Id { get; set; }
  public bool Ok { get; set; }
  public string EngineVersion { get; set; } = PerformanceEngine.Version;
  public Timeline[] Timelines { get; set; } = [];
  public string? Error { get; set; }
}

public sealed class Timeline
{
  public string Mode { get; set; } = "";
  public TimelinePoint[] Points { get; set; } = [];
  public StarRatingPoint[] DifficultyPoints { get; set; } = [];
  public FullDifficultyValue? FullDifficulty { get; set; }
  [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
  public FullMapValue? FullMap { get; set; }
  public PerformanceValue? Final { get; set; }
  /// <summary>The official calculator's effective miss count for the calculation behind the last point's PP; left out when no object was completed.</summary>
  [JsonProperty(NullValueHandling = NullValueHandling.Ignore)]
  public double? EffectiveMissCount { get; set; }
  public int ObjectCount { get; set; }
  public bool EndpointVerified { get; set; }
  public string? Error { get; set; }
}

public record PerformanceValue(double Pp, double Sr);
public sealed record FullDifficultyValue(double Total, double Aim, double Speed, double Reading, double Flashlight, double SliderFactor);
public sealed record StarRatingPoint(double Time, double Sr);
public sealed record TimelinePoint(double Time, double Pp, double Sr) : PerformanceValue(Pp, Sr);
/// <summary>Calculation inputs/capacities, never observed pass or perfect-combo evidence.</summary>
public sealed record FullMapValue(int Version, int MaxCombo, int LargeTicks, int SmallTicks, int SliderTails,
    double ClockRate, double DrainTimeMs, double EndTimeMs);
