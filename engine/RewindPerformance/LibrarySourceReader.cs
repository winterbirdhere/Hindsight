// SPDX-License-Identifier: MIT
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Realms;
using Realms.Schema;

namespace RewindPerformance;

/// <summary>Immutable, bounded native inspection and resumable metadata pages.</summary>
public sealed class LibrarySourceReader
{
  private const long MaximumDatabaseBytes = 512L * 1024 * 1024;
  private const int MaximumBlobBytes = 64 * 1024 * 1024;
  private const int MaximumMapBytes = 16 * 1024 * 1024;
  private const long MaximumReadBytes = 256L * 1024 * 1024;
  private static readonly Regex shaPattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
  private static readonly Regex md5Pattern = new("^[a-f0-9]{32}$", RegexOptions.CultureInvariant);
  private readonly string root;
  private readonly CancellationToken cancellation;
  private long readBytes;

  private LibrarySourceReader(string root, CancellationToken cancellation)
  {
    this.root = root;
    this.cancellation = cancellation;
  }

  public static LibrarySourceResponse Inspect(LibrarySourceRequest request, CancellationToken cancellation = default)
  {
    try
    {
      cancellation.ThrowIfCancellationRequested();
      if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(request.SourceDirectory) || request.Limit is < 1 or > 8)
        throw new LibrarySourceException("invalid-source");
      var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.SourceDirectory));
      var reader = new LibrarySourceReader(root, cancellation);
      var databasePath = Path.Combine(root, "client.realm");
      RejectReparsePoints(databasePath);
      // IsReadOnly is Core Immutable: it does not coordinate with a mutable Realm writer.
      // Keep a Windows deny-write/delete lease until Realm has been disposed. Never retry inside this call.
      using var lease = OpenLease(databasePath);
      if (lease.Length > MaximumDatabaseBytes) throw new LibrarySourceException("resource-limit");
      using var realm = Realm.GetInstance(new RealmConfiguration(databasePath)
      {
        IsDynamic = true, IsReadOnly = true, ShouldDeleteIfMigrationNeeded = false,
        MigrationCallback = null, ShouldCompactOnLaunch = null,
      });
      cancellation.ThrowIfCancellationRequested();
      string fingerprint = ValidateSchema(realm.Schema);
      var result = new LibrarySourceResponse { Ok = true, Status = "ready", SchemaFingerprint = fingerprint };
      // No decoder, score manager, file store, migration or gameplay work during enumeration.
      foreach (var score in realm.DynamicApi.All("Score"))
      {
        cancellation.ThrowIfCancellationRequested();
        if (result.Scores.Count >= request.Limit) break;
        result.Scores.Add(reader.ReadScore(score));
      }
      return result;
    }
    catch (OperationCanceledException) { return new() { Status = "cancelled" }; }
    catch (LibrarySourceException error)
    {
      Console.Error.WriteLine($"Library source {error.Status}: {error.StackTrace}");
      return new() { Status = error.Status };
    }
    catch (FileNotFoundException) { return new() { Status = "source-missing" }; }
    catch (DirectoryNotFoundException) { return new() { Status = "source-missing" }; }
    catch (Exception error)
    {
      // Type/stack identify compatibility failures without logging source values or credentials.
      Console.Error.WriteLine($"Library source {error.GetType().Name}: {error.StackTrace}");
      return new() { Status = "invalid-source" };
    }
  }

  private static FileStream OpenLease(string path)
  {
    try { return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); }
    catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
    { throw new LibrarySourceException("source-busy"); }
  }

  public static LibrarySourceResponse ReadPage(LibrarySourceRequest request, CancellationToken cancellation = default)
  {
    try
    {
      cancellation.ThrowIfCancellationRequested();
      if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(request.SourceDirectory) || request.Limit is < 1 or > 32 ||
          request.Offset < 0 || (request.Offset > 0 && request.Token == null) || (request.Token != null && !shaPattern.IsMatch(request.Token)))
        throw new LibrarySourceException("invalid-cursor");
      string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.SourceDirectory));
      var reader = new LibrarySourceReader(root, cancellation);
      string database = Path.Combine(root, "client.realm");
      RejectReparsePoints(database);
      using var lease = OpenLease(database);
      if (lease.Length > MaximumDatabaseBytes) throw new LibrarySourceException("resource-limit");
      using var realm = Realm.GetInstance(new RealmConfiguration(database)
      {
        IsDynamic = true, IsReadOnly = true, ShouldDeleteIfMigrationNeeded = false,
        MigrationCallback = null, ShouldCompactOnLaunch = null,
      });
      string schema = ValidateSchema(realm.Schema);
      var scores = realm.DynamicApi.All("Score").AsRealmCollection();
      int total = scores.Count;
      if (total > 1_000_000) throw new LibrarySourceException("resource-limit");
      string token = LibrarySourceStamp.Read(lease, schema, total);
      if (request.Token != null && request.Token != token) throw new LibrarySourceException("source-changed");
      if (request.Offset > total) throw new LibrarySourceException("invalid-cursor");
      var result = new LibrarySourceResponse { Ok = true, Status = "ready", SampleOnly = false, SchemaFingerprint = schema,
        CursorToken = token, Total = total, NextOffset = request.Offset };
      int outputBytes = 2048; // Reserve framing space; bound before retaining/advancing each record.
      int end = request.Offset + Math.Min(request.Limit, total - request.Offset);
      for (int index = request.Offset; index < end; index++)
      {
        cancellation.ThrowIfCancellationRequested();
        LibrarySourceScore? score = null;
        LibrarySourceRowError? error = null;
        var sourceScore = scores[index];
        try { score = reader.ReadScore(sourceScore, verifyBlobs: false); }
        catch (LibrarySourceException failure) { error = new(sourceScore.DynamicApi.Get<Guid>("ID").ToString(), failure.Status); }
        catch (JsonException) { error = new(sourceScore.DynamicApi.Get<Guid>("ID").ToString(), "invalid-source"); }
        int bytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject((object?)score ?? error, Protocol.JsonSettings)) + 1;
        if (outputBytes + bytes > LibrarySourceProtocol.MaximumResponseBytes)
        {
          if (result.Scores.Count + result.Errors.Count == 0) throw new LibrarySourceException("resource-limit");
          break;
        }
        if (score != null) result.Scores.Add(score);
        else if (error != null) result.Errors.Add(error);
        outputBytes += bytes; result.NextOffset = index + 1;
      }
      cancellation.ThrowIfCancellationRequested();
      if (LibrarySourceStamp.Read(lease, schema, total) != token) throw new LibrarySourceException("source-changed");
      result.Complete = result.NextOffset == total;
      return result;
    }
    catch (OperationCanceledException) { return new() { Status = "cancelled" }; }
    catch (LibrarySourceException error) { return new() { Status = error.Status }; }
    catch (FileNotFoundException) { return new() { Status = "source-missing" }; }
    catch (DirectoryNotFoundException) { return new() { Status = "source-missing" }; }
    catch (Exception error)
    {
      Console.Error.WriteLine($"Library page {error.GetType().Name}: {error.StackTrace}");
      return new() { Status = "invalid-source" };
    }
  }

  /// <summary>Fresh primary-key lookup for one selected identity. Manifests are declarations,
  /// not verified bytes; the consumer must hash the exact replay/map/media it actually loads.</summary>
  public static LibrarySourceResponse ResolveScore(LibrarySourceRequest request, CancellationToken cancellation = default)
    => ResolveSelectedScore(request, false, cancellation);

  /// <summary>Establish a declaration for a provisional GUID; consumers must verify bytes and CAS the provisional ticket.</summary>
  public static LibrarySourceResponse ResolveProvisionalScore(LibrarySourceRequest request, CancellationToken cancellation = default)
    => ResolveSelectedScore(request, true, cancellation);

  public static LibrarySourceResponse ResolveArtwork(LibrarySourceRequest request, CancellationToken cancellation = default)
    => ResolveSelectedScore(request, false, cancellation, artwork: true);

  private static LibrarySourceResponse ResolveSelectedScore(LibrarySourceRequest request, bool provisional, CancellationToken cancellation, bool artwork = false)
  {
    try
    {
      cancellation.ThrowIfCancellationRequested();
      if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(request.SourceDirectory) ||
          !Guid.TryParseExact(request.ScoreId, "D", out var id) ||
          (provisional ? request.ExpectedReplaySha256 != null : request.ExpectedReplaySha256 == null || !shaPattern.IsMatch(request.ExpectedReplaySha256)))
        throw new LibrarySourceException("invalid-source");
      if (artwork && (request.ExpectedMapSha256 == null || !shaPattern.IsMatch(request.ExpectedMapSha256) ||
          request.ExpectedMapMd5 == null || !md5Pattern.IsMatch(request.ExpectedMapMd5) || !SafeArtworkName(request.AssetName)))
        throw new LibrarySourceException("invalid-source");
      string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.SourceDirectory));
      string database = Path.Combine(root, "client.realm");
      RejectReparsePoints(database);
      using var lease = OpenLease(database);
      if (lease.Length > MaximumDatabaseBytes) throw new LibrarySourceException("resource-limit");
      using var realm = Realm.GetInstance(new RealmConfiguration(database)
      {
        IsDynamic = true, IsReadOnly = true, ShouldDeleteIfMigrationNeeded = false,
        MigrationCallback = null, ShouldCompactOnLaunch = null,
      });
      string schema = ValidateSchema(realm.Schema);
      int total = realm.DynamicApi.All("Score").AsRealmCollection().Count;
      string token = LibrarySourceStamp.Read(lease, schema, total);
      var score = realm.DynamicApi.Find("Score", (Guid?)id);
      if (score == null) throw new LibrarySourceException("score-missing");
      var reader = new LibrarySourceReader(root, cancellation);
      var projection = reader.ReadScore(score, verifyBlobs: false, includeAssets: !artwork && request.IncludeAssets);
      if (!provisional && projection.Replay.Sha256 != request.ExpectedReplaySha256) throw new LibrarySourceException("source-changed");
      if (artwork)
      {
        if (projection.Beatmap.Status is not ("available" or "unverified") || projection.Beatmap.Sha256 != request.ExpectedMapSha256 ||
            projection.Beatmap.Md5 != request.ExpectedMapMd5) throw new LibrarySourceException("source-changed");
        var map = score.DynamicApi.Get<IRealmObjectBase>("BeatmapInfo");
        var set = map?.DynamicApi.Get<IRealmObjectBase>("BeatmapSet");
        if (set == null) throw new LibrarySourceException("invalid-source");
        var asset = reader.ReadArtwork(set, request.AssetName!);
        if (asset != null) projection.Assets.Add(asset);
        projection.ArtworkLookup = new(request.AssetName!, request.ExpectedMapSha256!, request.ExpectedMapMd5!, true);
      }
      cancellation.ThrowIfCancellationRequested();
      if (LibrarySourceStamp.Read(lease, schema, total) != token) throw new LibrarySourceException("source-changed");
      return new() { Ok = true, Status = "ready", SampleOnly = false, ResolvedScoreId = projection.Id,
        SchemaFingerprint = schema, CursorToken = token, Scores = [projection] };
    }
    catch (OperationCanceledException) { return new() { Status = "cancelled" }; }
    catch (LibrarySourceException error) { return new() { Status = error.Status }; }
    catch (FileNotFoundException) { return new() { Status = "source-missing" }; }
    catch (DirectoryNotFoundException) { return new() { Status = "source-missing" }; }
    catch (Exception error)
    {
      Console.Error.WriteLine($"Library resolve {error.GetType().Name}: {error.StackTrace}");
      return new() { Status = "invalid-source" };
    }
  }

  private static bool SafeArtworkName(string? name) => name is { Length: > 0 and <= 512 } &&
    !name.Any(character => character < 32 || "\\<>:\"|?*".Contains(character)) &&
    name.Split('/').All(part => part is not ("" or "." or "..") && !part.EndsWith('.') && !part.EndsWith(' '));

  private LibrarySourceAsset? ReadArtwork(IRealmObjectBase set, string name)
  {
    // A single-name metadata scope, independent of the unchanged full-manifest limit.
    const int maximumVisits = 8192;
    var files = set.DynamicApi.GetList<IRealmObjectBase>("Files");
    if (files.Count > maximumVisits) throw new LibrarySourceException("resource-limit");
    string? matchedName = null, matchedHash = null; int visited = 0;
    foreach (var usage in files)
    {
      cancellation.ThrowIfCancellationRequested();
      if (++visited > maximumVisits) throw new LibrarySourceException("resource-limit");
      string? candidate = BoundedString(usage.DynamicApi.Get<string>("Filename"));
      if (!SafeArtworkName(candidate)) throw new LibrarySourceException("invalid-source");
      if (!StringComparer.OrdinalIgnoreCase.Equals(candidate, name)) continue;
      if (matchedName != null) throw new LibrarySourceException("invalid-source");
      matchedName = candidate; matchedHash = usage.DynamicApi.Get<IRealmObjectBase>("File")?.DynamicApi.Get<string>("Hash");
    }
    return matchedName == null ? null : new(matchedName, ReadAsset(matchedHash, verify: false));
  }

  private LibrarySourceScore ReadScore(IRealmObjectBase score, bool verifyBlobs = true, bool includeAssets = false)
  {
    var api = score.DynamicApi;
    var user = api.Get<IRealmObjectBase>("User");
    var ruleset = api.Get<IRealmObjectBase>("Ruleset");
    var result = new LibrarySourceScore
    {
      Id = api.Get<Guid>("ID").ToString(),
      PlayedAtTicks = api.Get<DateTimeOffset>("Date").UtcTicks.ToString(CultureInfo.InvariantCulture),
      Player = user == null ? null : BoundedString(user.DynamicApi.Get<string>("Username")),
      Ruleset = ruleset?.DynamicApi.Get<long>("OnlineID"),
      ClientVersion = BoundedString(api.Get<string>("ClientVersion")),
      IsLegacyScore = api.Get<bool>("IsLegacyScore"),
      MaxCombo = api.Get<long>("MaxCombo"), Accuracy = api.Get<double>("Accuracy"), Rank = api.Get<long>("Rank"),
      Pp = api.Get<double?>("PP"),
      // Pinned osu writes an empty string for an empty APIMod list; null remains missing evidence.
      Mods = api.Get<string>("Mods") is "" ? new JArray() : ReadJson<JArray>(api.Get<string>("Mods")),
      Statistics = ReadStatistics(api.Get<string>("Statistics")),
      MaximumStatistics = ReadStatistics(api.Get<string>("MaximumStatistics")),
    };
    if (result.MaxCombo < 0 || !double.IsFinite(result.Accuracy) || result.Accuracy is < 0 or > 1 ||
        (result.Pp.HasValue && (!double.IsFinite(result.Pp.Value) || result.Pp.Value < 0)))
      throw new LibrarySourceException("invalid-source");
    var files = ReadFiles(score, 128);
    var replayFiles = files.Where(file => file.Name.EndsWith(".osr", StringComparison.OrdinalIgnoreCase)).ToArray();
    byte[]? replayBytes = null;
    if (replayFiles.Length == 1) result.Replay = verifyBlobs ? ReadBlob(replayFiles[0].Hash, MaximumBlobBytes, out replayBytes)
      : LocateBlob(replayFiles[0].Hash, MaximumBlobBytes);
    else if (replayFiles.Length > 1) result.Replay.Status = "invalid";

    string? replayMap = null;
    if (replayBytes != null)
    {
      replayMap = ReadReplayMapHash(replayBytes);
      if (replayMap == null) result.Replay = new() { Status = "invalid" };
    }
    var map = api.Get<IRealmObjectBase>("BeatmapInfo");
    if (map == null) return result;
    var mapApi = map.DynamicApi;
    string? mapMd5 = mapApi.Get<string>("MD5Hash");
    string? mapHash = mapApi.Get<string>("Hash");
    string? savedMap = api.Get<string>("BeatmapHash");
    if (mapMd5 == null || !md5Pattern.IsMatch(mapMd5) || mapHash == null || !shaPattern.IsMatch(mapHash) ||
        savedMap != mapHash || (replayMap != null && replayMap != mapMd5))
    {
      result.Beatmap.Status = "invalid";
      return result;
    }
    var metadata = mapApi.Get<IRealmObjectBase>("Metadata");
    result.MapMetadata = new()
    {
      Title = BoundedString(metadata?.DynamicApi.Get<string>("Title")),
      TitleUnicode = BoundedString(metadata?.DynamicApi.Get<string>("TitleUnicode")),
      Artist = BoundedString(metadata?.DynamicApi.Get<string>("Artist")),
      ArtistUnicode = BoundedString(metadata?.DynamicApi.Get<string>("ArtistUnicode")),
      Mapper = BoundedString(metadata?.DynamicApi.Get<IRealmObjectBase>("Author")?.DynamicApi.Get<string>("Username")),
      DifficultyName = BoundedString(mapApi.Get<string>("DifficultyName")),
      OnlineId = mapApi.Get<long>("OnlineID"), Status = mapApi.Get<long>("Status"),
      CachedLengthMs = CachedNonnegative(mapApi.Get<double>("Length")),
      CachedBpm = CachedNonnegative(mapApi.Get<double>("BPM")) is > 0 and var bpm ? bpm : null,
      CachedNoModStars = CachedNonnegative(mapApi.Get<double>("StarRating")),
    };
    if (!verifyBlobs)
    {
      result.Beatmap = LocateBlob(mapHash, MaximumMapBytes);
      result.Beatmap.Md5 = mapMd5; // Declared source binding only; status remains unverified.
      if (!includeAssets) return result; // Media manifests are resolved for selected resources, not repeated in each page.
    }
    else
    {
      result.Beatmap = ReadBlob(mapHash, MaximumMapBytes, out var mapBytes);
      if (mapBytes == null) return result;
      string actualMd5 = Convert.ToHexString(MD5.HashData(mapBytes)).ToLowerInvariant();
      if (actualMd5 != mapMd5) { result.Beatmap = new() { Status = "corrupt" }; return result; }
      result.Beatmap.Md5 = actualMd5;
    }
    var set = mapApi.Get<IRealmObjectBase>("BeatmapSet");
    if (set == null) return result;
    // A connection inspection proves a bounded sample of real media too. Full scans will only index
    // manifests; source-backed loading must always revalidate the selected blob before use.
    int mediaSamples = 0;
    foreach (var file in ReadFiles(set, 2048))
    {
      bool sample = verifyBlobs && mediaSamples < 3 && Path.GetExtension(file.Name).ToLowerInvariant() is
        ".mp3" or ".ogg" or ".wav" or ".jpg" or ".jpeg" or ".png";
      if (sample) mediaSamples++;
      result.Assets.Add(new(file.Name, ReadAsset(file.Hash, sample)));
    }
    result.AssetManifestComplete = true;
    return result;
  }

  private LibrarySourceResource ReadAsset(string? hash, bool verify)
  {
    try { return verify ? ReadBlob(hash, MaximumBlobBytes, out _) : LocateBlob(hash, MaximumBlobBytes); }
    catch (LibrarySourceException error) when (error.Status is "source-busy" or "invalid-source" or "resource-limit")
    { return new() { Sha256 = hash, Status = error.Status == "source-busy" ? "busy" : error.Status == "invalid-source" ? "invalid" : "resource-limit" }; }
    catch (UnauthorizedAccessException) { return new() { Sha256 = hash, Status = "inaccessible" }; }
    catch (IOException) { return new() { Sha256 = hash, Status = "inaccessible" }; }
  }

  private List<(string Name, string? Hash)> ReadFiles(IRealmObjectBase owner, int maximum)
  {
    var files = owner.DynamicApi.GetList<IRealmObjectBase>("Files");
    if (files.Count > maximum) throw new LibrarySourceException("resource-limit");
    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var result = new List<(string, string?)>();
    foreach (var usage in files)
    {
      cancellation.ThrowIfCancellationRequested();
      var name = BoundedString(usage.DynamicApi.Get<string>("Filename"));
      if (name == null || name.Length > 512 || name.Any(character => character < 32) || name.Contains('\\') || name.StartsWith('/') ||
          name.Split('/').Any(part => part is ".." or "." or "" || part.Contains(':') || part.EndsWith('.') || part.EndsWith(' ')) || !names.Add(name))
        throw new LibrarySourceException("invalid-source");
      result.Add((name, usage.DynamicApi.Get<IRealmObjectBase>("File")?.DynamicApi.Get<string>("Hash")));
    }
    return result;
  }

  public static void RejectReparsePoints(string path)
  {
    for (string? current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
        throw new LibrarySourceException("invalid-source");
  }

  private LibrarySourceResource LocateBlob(string? hash, int maximum)
  {
    cancellation.ThrowIfCancellationRequested();
    if (hash == null || !shaPattern.IsMatch(hash)) return new() { Status = "invalid" };
    string path = Path.Combine(root, "files", hash[..1], hash[..2], hash);
    try
    {
      RejectReparsePoints(path);
      using var lease = OpenLease(path);
      if (lease.Length > maximum) return new() { Status = "resource-limit", Sha256 = hash, Bytes = lease.Length };
      return new() { Status = "unverified", Sha256 = hash, Path = path, Bytes = lease.Length };
    }
    catch (FileNotFoundException) { return new() { Status = "missing", Sha256 = hash }; }
    catch (DirectoryNotFoundException) { return new() { Status = "missing", Sha256 = hash }; }
  }

  private LibrarySourceResource ReadBlob(string? hash, int maximum, out byte[]? bytes)
  {
    bytes = null;
    try { return ReadBlobCore(hash, maximum, out bytes); }
    catch (FileNotFoundException) { bytes = null; return new() { Status = "missing", Sha256 = hash }; }
    catch (DirectoryNotFoundException) { bytes = null; return new() { Status = "missing", Sha256 = hash }; }
  }

  private LibrarySourceResource ReadBlobCore(string? hash, int maximum, out byte[]? bytes)
  {
    bytes = null;
    var resource = LocateBlob(hash, maximum);
    if (resource.Status != "unverified") return resource;
    // Recheck immediately on the handle used for bytes/hashes. A prior index observation is not validation.
    RejectReparsePoints(resource.Path!);
    using var stream = OpenLease(resource.Path!);
    if (stream.Length > maximum || readBytes + stream.Length > MaximumReadBytes)
      throw new LibrarySourceException("resource-limit");
    bytes = new byte[checked((int)stream.Length)];
    for (int offset = 0; offset < bytes.Length;)
    {
      cancellation.ThrowIfCancellationRequested();
      int count = stream.Read(bytes, offset, Math.Min(64 * 1024, bytes.Length - offset));
      if (count == 0) throw new EndOfStreamException();
      readBytes += count;
      offset += count;
    }
    cancellation.ThrowIfCancellationRequested();
    if (Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() != hash)
    { bytes = null; return new() { Status = "corrupt", Sha256 = hash }; }
    resource.Status = "available";
    resource.Bytes = stream.Length;
    return resource;
  }

  public static string? ReadReplayMapHash(byte[] bytes)
  {
    // This is a bounded source-binding read, not gameplay decoding or a complete replay validator.
    if (bytes.Length < 39 || bytes[0] > 3 || bytes[5] != 0x0b || bytes[6] != 32) return null;
    string hash = Encoding.ASCII.GetString(bytes, 7, 32);
    return md5Pattern.IsMatch(hash) ? hash : null;
  }

  private static string? BoundedString(string? value)
  {
    if (value?.Length > 4096) throw new LibrarySourceException("resource-limit");
    return value;
  }

  private static double? CachedNonnegative(double value)
  {
    if (!double.IsFinite(value)) throw new LibrarySourceException("invalid-source");
    return value < 0 ? null : value;
  }

  private static T? ReadJson<T>(string? text) where T : JToken
  {
    if (string.IsNullOrEmpty(text)) return null;
    if (text.Length > 64 * 1024) throw new LibrarySourceException("resource-limit");
    using var json = new JsonTextReader(new StringReader(text)) { MaxDepth = 16, DateParseHandling = DateParseHandling.None };
    var value = JToken.ReadFrom(json, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
    if (value is not T typed || json.Read()) throw new LibrarySourceException("invalid-source");
    return typed;
  }

  private static JObject? ReadStatistics(string? text)
  {
    var stats = ReadJson<JObject>(text);
    if (stats != null && stats.Properties().Any(property => property.Value.Type != JTokenType.Integer ||
        !long.TryParse(property.Value.ToString(), System.Globalization.NumberStyles.Integer,
          System.Globalization.CultureInfo.InvariantCulture, out long value) || value is < 0 or > 9007199254740991L))
      throw new LibrarySourceException("invalid-source");
    return stats;
  }

  public static string ValidateSchema(RealmSchema schema)
  {
    // A structural contract permits additive future fields but refuses changed required shapes.
    foreach (var expected in RequiredSchema)
    {
      var actual = schema.FirstOrDefault(type => type.Name == expected.Name);
      if (actual == null || actual.BaseType != expected.BaseType) throw new LibrarySourceException("unsupported-schema");
      foreach (var property in expected)
      {
        var candidate = actual.FirstOrDefault(item => item.Name == property.Name);
        if (candidate.Name == null || candidate.Type != property.Type || candidate.ObjectType != property.ObjectType ||
            candidate.IsPrimaryKey != property.IsPrimaryKey)
          throw new LibrarySourceException("unsupported-schema");
      }
    }
    var signature = string.Join("\n", schema.OrderBy(type => type.Name, StringComparer.Ordinal).SelectMany(type =>
      type.OrderBy(property => property.Name, StringComparer.Ordinal).Select(property =>
        $"{type.Name}:{type.BaseType}:{property.Name}:{(int)property.Type}:{property.ObjectType}:{property.IsPrimaryKey}")));
    return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature))).ToLowerInvariant();
  }

  public static RealmSchema RequiredSchema => new RealmSchema.Builder
  {
    new ObjectSchema.Builder("Score")
    {
      Property.Primitive("ID", RealmValueType.Guid, isPrimaryKey: true),
      Property.Primitive("Date", RealmValueType.Date),
      Property.Primitive("ClientVersion", RealmValueType.String, isNullable: true),
      Property.Primitive("IsLegacyScore", RealmValueType.Bool),
      Property.Primitive("MaxCombo", RealmValueType.Int),
      Property.Primitive("Accuracy", RealmValueType.Double),
      Property.Primitive("Rank", RealmValueType.Int),
      Property.Primitive("PP", RealmValueType.Double, isNullable: true),
      Property.Primitive("Mods", RealmValueType.String, isNullable: true),
      Property.Primitive("Statistics", RealmValueType.String, isNullable: true),
      Property.Primitive("MaximumStatistics", RealmValueType.String, isNullable: true),
      Property.Primitive("BeatmapHash", RealmValueType.String, isNullable: true),
      Property.Object("User", "RealmUser"), Property.Object("Ruleset", "Ruleset"),
      Property.Object("BeatmapInfo", "Beatmap"), Property.ObjectList("Files", "RealmNamedFileUsage"),
    },
    new ObjectSchema.Builder("Beatmap")
    {
      Property.Primitive("Hash", RealmValueType.String, isNullable: true), Property.Primitive("MD5Hash", RealmValueType.String, isNullable: true),
      Property.Object("BeatmapSet", "BeatmapSet"), Property.Object("Metadata", "BeatmapMetadata"),
      Property.Primitive("DifficultyName", RealmValueType.String, isNullable: true),
      Property.Primitive("OnlineID", RealmValueType.Int), Property.Primitive("Status", RealmValueType.Int),
      Property.Primitive("Length", RealmValueType.Double), Property.Primitive("BPM", RealmValueType.Double), Property.Primitive("StarRating", RealmValueType.Double),
    },
    new ObjectSchema.Builder("BeatmapMetadata")
    {
      Property.Primitive("Title", RealmValueType.String, isNullable: true), Property.Primitive("TitleUnicode", RealmValueType.String, isNullable: true),
      Property.Primitive("Artist", RealmValueType.String, isNullable: true), Property.Primitive("ArtistUnicode", RealmValueType.String, isNullable: true),
      Property.Object("Author", "RealmUser"),
    },
    new ObjectSchema.Builder("BeatmapSet") { Property.ObjectList("Files", "RealmNamedFileUsage") },
    new ObjectSchema.Builder("RealmNamedFileUsage", ObjectSchema.ObjectType.EmbeddedObject)
    { Property.Primitive("Filename", RealmValueType.String, isNullable: true), Property.Object("File", "File") },
    new ObjectSchema.Builder("File") { Property.Primitive("Hash", RealmValueType.String, isPrimaryKey: true, isNullable: true) },
    new ObjectSchema.Builder("RealmUser", ObjectSchema.ObjectType.EmbeddedObject) { Property.Primitive("Username", RealmValueType.String, isNullable: true) },
    new ObjectSchema.Builder("Ruleset") { Property.Primitive("OnlineID", RealmValueType.Int) },
  }.Build();
}
