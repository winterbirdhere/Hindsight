// SPDX-License-Identifier: MIT
using Newtonsoft.Json.Linq;
using osu.Game.Online.API;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Mods;

namespace RewindPerformance;

public static class ModConfiguration
{
  private static readonly HashSet<string> supported = new(StringComparer.Ordinal)
    {
        "NF", "EZ", "HD", "HR", "DT", "NC", "HT", "DC", "FL", "SO", "CL", "DA", "V2", "SV2", "SD", "PF", "TD",
        // Analysis values are useful even when a mod cannot award ranked PP.
        // Validate native mods here; the engine maps Relax to normal PP separately.
        "RX", "AP", "AT"
    };
  private static readonly HashSet<string> configurable = new(StringComparer.Ordinal) { "DT", "NC", "HT", "DC", "DA", "CL" };

  public static Mod[] Create(OsuRuleset ruleset, string mode, APIMod[]? requested)
  {
    if (mode is not ("stable" or "lazer" or "lazer-classic"))
      throw new InvalidDataException($"Unsupported calculation mode: {mode}");
    if (requested == null) throw new InvalidDataException("Mods must be an array.");
    var result = new List<Mod>();
    var selected = new HashSet<string>(StringComparer.Ordinal);
    foreach (APIMod api in requested)
    {
      if (api == null || !supported.Contains(api.Acronym))
        throw new InvalidDataException($"Unsupported mod: {api?.Acronym}");
      if (!selected.Add(api.Acronym)) throw new InvalidDataException($"Duplicate mod: {api.Acronym}");
      if (api.Settings == null) throw new InvalidDataException($"Invalid settings for {api.Acronym}");
      foreach ((string key, object? rawValue) in api.Settings)
      {
        bool? booleanSetting = SettingType(api.Acronym, key);
        if (!configurable.Contains(api.Acronym) || !booleanSetting.HasValue)
          throw new InvalidDataException($"Unsupported setting: {api.Acronym}.{key}");
        object? value = rawValue is JValue json ? json.Value : rawValue;
        bool numeric = value is byte or short or int or long or float or double or decimal;
        if (value == null || (booleanSetting.Value ? value is not bool : !numeric))
          throw new InvalidDataException($"Invalid value for {api.Acronym}.{key}");
        if (numeric && !double.IsFinite(Convert.ToDouble(value)))
          throw new InvalidDataException($"Non-finite setting: {api.Acronym}.{key}");
      }
      // Official API conversion preserves bindable defaults, ranges and DA's
      // adjusted-setting rules. Validate all supported keys/types before calling it,
      // because ToMod intentionally logs and ignores unsupported values.
      var normalized = new APIMod { Acronym = api.Acronym == "V2" ? "SV2" : api.Acronym, Settings = api.Settings };
      Mod created = normalized.ToMod(ruleset);
      if (created is UnknownMod) throw new InvalidDataException($"Unknown official mod: {api.Acronym}");
      result.Add(created);
    }
    if (selected.Count(acronym => acronym is "DT" or "NC" or "HT" or "DC") > 1)
      throw new InvalidDataException("Only one clock-rate mod may be supplied.");
    if (selected.Contains("DA") && (selected.Contains("HR") || selected.Contains("EZ")))
      throw new InvalidDataException("Difficulty Adjust must use the replay's effective difficulty mods.");
    if (selected.Contains("HR") && selected.Contains("EZ"))
      throw new InvalidDataException("Hard Rock and Easy cannot be combined.");
    if (mode == "lazer" && selected.Contains("CL"))
      throw new InvalidDataException("Classic mods require the lazer-classic calculation mode.");
    if (mode == "stable")
    {
      result.RemoveAll(mod => mod is OsuModClassic);
      result.Add(new OsuModClassic());
    }
    else if (mode == "lazer-classic" && !selected.Contains("CL"))
      throw new InvalidDataException("Lazer Classic calculation requires the replay's Classic mod.");
    return result.ToArray();
  }

  private static bool? SettingType(string acronym, string key) => (acronym, key) switch
  {
    ("DT" or "NC" or "HT" or "DC", "speed_change") => false,
    ("DT" or "NC" or "HT" or "DC", "adjust_pitch") => true,
    ("DA", "circle_size" or "approach_rate" or "overall_difficulty" or "drain_rate") => false,
    ("DA", "extended_limits") => true,
    ("CL", "no_slider_head_accuracy" or "classic_note_lock" or "always_play_tail_sample" or "fade_hit_circle_early" or "classic_health") => true,
    _ => null
  };
}
