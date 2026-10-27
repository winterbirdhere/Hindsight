// SPDX-License-Identifier: MIT
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RewindPerformance;

public sealed class LibrarySourceRequest
{
  public int Version { get; set; }
  public string Operation { get; set; } = "";
  public string SourceDirectory { get; set; } = "";
  public int Limit { get; set; } = 8;
  public int Offset { get; set; }
  public string? Token { get; set; }
  public string? ScoreId { get; set; }
  public string? ExpectedReplaySha256 { get; set; }
  public string? ExpectedMapSha256 { get; set; }
  public string? ExpectedMapMd5 { get; set; }
  public string? AssetName { get; set; }
  // Existing selected-resource callers need media; background calculations explicitly opt out.
  public bool IncludeAssets { get; set; } = true;
}

public sealed class LibrarySourceResponse
{
  public int Version { get; set; } = 1;
  public bool Ok { get; set; }
  public string Status { get; set; } = "invalid-source";
  public bool SampleOnly { get; set; } = true;
  public string? SchemaFingerprint { get; set; }
  public List<LibrarySourceScore> Scores { get; set; } = [];
  public string? CursorToken { get; set; }
  public int? NextOffset { get; set; }
  public int? Total { get; set; }
  public bool? Complete { get; set; }
  public List<LibrarySourceRowError> Errors { get; set; } = [];
  public string? ResolvedScoreId { get; set; }
}

public sealed record LibrarySourceRowError(string Id, string Status);

public sealed class LibrarySourceScore
{
  public string Id { get; set; } = "";
  public string PlayedAtTicks { get; set; } = "";
  public string? Player { get; set; }
  public long? Ruleset { get; set; }
  public string? ClientVersion { get; set; }
  public bool IsLegacyScore { get; set; }
  public long MaxCombo { get; set; }
  public double Accuracy { get; set; }
  public long Rank { get; set; }
  public double? Pp { get; set; }
  public JArray? Mods { get; set; }
  public JObject? Statistics { get; set; }
  public JObject? MaximumStatistics { get; set; }
  public LibrarySourceResource Replay { get; set; } = new();
  public LibrarySourceResource Beatmap { get; set; } = new();
  public List<LibrarySourceAsset> Assets { get; set; } = [];
  public bool AssetManifestComplete { get; set; }
  public LibraryArtworkLookup? ArtworkLookup { get; set; }
  public LibrarySourceMapMetadata? MapMetadata { get; set; }
}

/// <summary>Source-observed cache values, never current-engine calculations or verified map bytes.</summary>
public sealed class LibrarySourceMapMetadata
{
  public string? Title { get; set; }
  public string? TitleUnicode { get; set; }
  public string? Artist { get; set; }
  public string? ArtistUnicode { get; set; }
  public string? Mapper { get; set; }
  public string? DifficultyName { get; set; }
  public long OnlineId { get; set; }
  public long Status { get; set; }
  public double? CachedLengthMs { get; set; }
  public double? CachedBpm { get; set; }
  public double? CachedNoModStars { get; set; }
}

public sealed record LibrarySourceAsset(string Name, LibrarySourceResource Resource);
public sealed record LibraryArtworkLookup(string Name, string MapSha256, string MapMd5, bool Complete);

public sealed class LibrarySourceResource
{
  public string Status { get; set; } = "missing";
  public string? Sha256 { get; set; }
  public string? Path { get; set; }
  public long? Bytes { get; set; }
  public string? Md5 { get; set; }
}

/// <summary>Isolated one-shot source command. Never constructs PerformanceEngine or source managers.</summary>
public static class LibrarySourceProtocol
{
  public const int MaximumRequestChars = 16 * 1024;
  public const int MaximumResponseBytes = 2 * 1024 * 1024;

  public static async Task Run(TextReader input, TextWriter output)
  {
    LibrarySourceResponse response;
    try
    {
      // Console.ReadLine has no bound; reject before allocating an arbitrary input line.
      var line = new StringBuilder();
      int next;
      while ((next = input.Read()) >= 0 && next != '\n')
      {
        if (line.Length >= MaximumRequestChars) throw new LibrarySourceException("resource-limit");
        line.Append((char)next);
      }
      var request = JsonConvert.DeserializeObject<LibrarySourceRequest>(line.ToString(), Protocol.JsonSettings);
      if (request == null || request.Version != 1 || request.Operation is not ("inspect" or "scan-page" or "resolve-score" or "resolve-provisional-score" or "resolve-artwork") ||
          request.Limit < 1 || request.Limit > (request.Operation == "inspect" ? 8 : 32))
        throw new LibrarySourceException("invalid-source");
      using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
      response = request.Operation switch
      {
        "inspect" => LibrarySourceReader.Inspect(request, cancellation.Token),
        "resolve-score" => LibrarySourceReader.ResolveScore(request, cancellation.Token),
        "resolve-provisional-score" => LibrarySourceReader.ResolveProvisionalScore(request, cancellation.Token),
        "resolve-artwork" => LibrarySourceReader.ResolveArtwork(request, cancellation.Token),
        _ => LibrarySourceReader.ReadPage(request, cancellation.Token),
      };
      if (cancellation.IsCancellationRequested && response.Status == "cancelled") response.Status = "timeout";
    }
    catch (LibrarySourceException error) { response = new() { Status = error.Status }; }
    catch (Exception) { response = new() { Status = "invalid-source" }; }
    var body = JsonConvert.SerializeObject(response, Protocol.JsonSettings);
    if (Encoding.UTF8.GetByteCount(body) > MaximumResponseBytes)
      body = JsonConvert.SerializeObject(new LibrarySourceResponse { Status = "resource-limit" }, Protocol.JsonSettings);
    await output.WriteLineAsync(body);
  }
}

public sealed class LibrarySourceException(string status) : Exception(status)
{
  public string Status { get; } = status;
}
