// SPDX-License-Identifier: MIT
using System.Security.Cryptography;
using System.Diagnostics;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Realms;
using Realms.Schema;
using RewindPerformance;

internal static class LibrarySourceTests
{
  public static async Task Run(string output)
  {
    if (!Path.IsPathFullyQualified(output) || Directory.Exists(output)) throw new Exception("Use a fresh absolute fixture directory");
    Directory.CreateDirectory(output);
    int assertions = 0;
    void Check(bool value, string label) { assertions++; if (!value) throw new Exception(label); }
    var numerical = CreateFixture(Path.Combine(output, "numerical"), "numerical");
    var numericalBefore = Inventory(numerical.Root);
    var numericalRead = LibrarySourceReader.Inspect(new() { SourceDirectory = numerical.Root, Limit = 8 });
    Check(numericalRead.Ok && numericalRead.Scores.Count == 1, "valid native numerical fixture enumerates");
    var numericalScore = numericalRead.Scores.Single();
    Check(numericalScore.Ruleset == 0 && !numericalScore.IsLegacyScore && numericalScore.Mods?.Count == 0 && numericalScore.MaxCombo == 3 &&
      (long?)numericalScore.Statistics?["Great"] == 3 && (long?)numericalScore.MaximumStatistics?["SliderTailHit"] == 0,
      "native numerical fixture carries explicit database profile and score evidence");
    Check(numericalScore.Replay.Status == "available" && numericalScore.Beatmap.Status == "available" && numericalScore.Beatmap.Md5 == numerical.MapMd5,
      "native numerical replay and nonempty map are exactly bound");
    var numericalPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = numerical.Root, Limit = 1 });
    Check(numericalPage.Ok && numericalPage.Scores.Count == 1 && numericalPage.Scores.Single().Id == numericalScore.Id,
      "native numerical source is available through production paging");
    var numericalResolved = LibrarySourceReader.ResolveScore(new() { SourceDirectory = numerical.Root, ScoreId = numericalScore.Id,
      ExpectedReplaySha256 = numericalScore.Replay.Sha256 });
    Check(numericalResolved.Ok && numericalResolved.Scores.Single().Beatmap.Sha256 == numericalScore.Beatmap.Sha256,
      "native numerical exact selected score resolves without exporting a replay");
    Check(numericalBefore == Inventory(numerical.Root), "native numerical inspection preserves source bytes and sidecars");
    var numericalFc = CreateFixture(Path.Combine(output, "numerical-fc"), "numerical-fc");
    var numericalFcBefore = Inventory(numericalFc.Root);
    var numericalFcRead = LibrarySourceReader.Inspect(new() { SourceDirectory = numericalFc.Root, Limit = 8 });
    Check(numericalFcRead.Ok && numericalFcRead.Scores.Count == 1, "native FC fallback fixture enumerates independently");
    var numericalFcScore = numericalFcRead.Scores.Single();
    Check(numericalFcScore.Ruleset == 0 && !numericalFcScore.IsLegacyScore && numericalFcScore.Mods?.Count == 0 && numericalFcScore.MaxCombo == 3,
      "native FC fallback retains authoritative native profile and saved max combo");
    Check(IncompleteNumericalStatistics(numericalFcScore), "native FC fallback missing statistics remain missing, not zero");
    Check(numericalFcScore.Replay.Status == "available" && numericalFcScore.Beatmap.Status == "available" &&
      numericalFcScore.Replay.Sha256 == numericalScore.Replay.Sha256 && numericalFcScore.Beatmap.Sha256 == numericalScore.Beatmap.Sha256 &&
      numericalFcScore.Beatmap.Md5 == numericalFc.MapMd5,
      "native FC fallback retains the same valid replay and exact nonempty map as numerical");
    var numericalFcPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = numericalFc.Root, Limit = 1 });
    Check(numericalFcPage.Ok && numericalFcPage.Scores.Count == 1 && numericalFcPage.Complete == true &&
      numericalFcPage.Scores.Single().Id == numericalFcScore.Id && IncompleteNumericalStatistics(numericalFcPage.Scores.Single()),
      "native FC fallback paging preserves incomplete evidence");
    var numericalFcResolved = LibrarySourceReader.ResolveScore(new() { SourceDirectory = numericalFc.Root, ScoreId = numericalFcScore.Id,
      ExpectedReplaySha256 = numericalFcScore.Replay.Sha256 });
    Check(numericalFcResolved.Ok && numericalFcResolved.Scores.Count == 1 &&
      numericalFcResolved.Scores.Single().Replay.Sha256 == numericalFcScore.Replay.Sha256 &&
      numericalFcResolved.Scores.Single().Beatmap.Sha256 == numericalFcScore.Beatmap.Sha256 &&
      IncompleteNumericalStatistics(numericalFcResolved.Scores.Single()),
      "native FC fallback selected resolution cannot manufacture missing statistics");
    Check(numericalFcBefore == Inventory(numericalFc.Root), "native FC fallback reads preserve source bytes and sidecars");
    var fixture = CreateFixture(Path.Combine(output, "normal"));
    var before = Inventory(fixture.Root);
    var result = LibrarySourceReader.Inspect(new() { SourceDirectory = fixture.Root, Limit = 8 });
    Check(result.Ok && result.Scores.Count == 1, "one native score enumerated");
    var score = result.Scores.Single();
    Check(score.PlayedAtTicks == "638961337234560000", "persisted UTC ticks stay exact at Realm millisecond precision");
    Check(score.Replay.Status == "available" && score.Beatmap.Status == "available", "native replay/map bytes verified in place");
    Check(score.Beatmap.Md5 == fixture.MapMd5, "replay MD5 and map SHA/MD5 binding");
    Check(score.Assets.Single().Resource.Status == "available", "bounded media sample verified in place");
    Check(score.Statistics == null && score.MaximumStatistics == null && score.Mods == null, "absent evidence stays null");
    Check(score.MapMetadata is { Title: "Fixture title", Artist: "Fixture artist", Mapper: "Fixture mapper", DifficultyName: "Fixture difficulty",
      Status: -1, CachedLengthMs: 123456, CachedBpm: 180, CachedNoModStars: null }, "native map cache keeps milliseconds, raw WIP and unknown star sentinel");
    Check(!JsonConvert.SerializeObject(score).Contains("Passed"), "no invented persisted pass");
    Check(before == Inventory(fixture.Root), "read creates no sidecars and changes no source bytes");
    // A source helper never keeps its lease after returning, including failure paths.
    using (new FileStream(Path.Combine(fixture.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }

    using (var writer = new FileStream(Path.Combine(fixture.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
      Check(LibrarySourceReader.Inspect(new() { SourceDirectory = fixture.Root }).Status == "source-busy", "active writer rejected before immutable Realm open");
    Check(before == Inventory(fixture.Root), "busy source unchanged");
    // Exercise an actual writable Realm in another process, not only a generic FileStream.
    var writerRoot = CreateFixture(Path.Combine(output, "realm-writer")).Root;
    string readyPath = Path.Combine(output, "writer-ready");
    var start = new ProcessStartInfo(Environment.ProcessPath!)
    { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    start.ArgumentList.Add(typeof(LibrarySourceTests).Assembly.Location);
    start.ArgumentList.Add("--library-source-writer"); start.ArgumentList.Add(writerRoot); start.ArgumentList.Add(readyPath);
    using (var writer = Process.Start(start)!)
    {
      try
      {
        var stderr = writer.StandardError.ReadToEndAsync();
        var stdout = writer.StandardOutput.ReadToEndAsync();
        var clock = Stopwatch.StartNew();
        while (!File.Exists(readyPath) && !writer.HasExited && clock.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(10);
        Check(File.Exists(readyPath), "real Realm writer reached transaction");
        var writerBefore = Inventory(writerRoot, metadataOnly: true);
        Check(LibrarySourceReader.Inspect(new() { SourceDirectory = writerRoot }).Status == "source-busy", "actual writable Realm rejected");
        Check(writerBefore == Inventory(writerRoot, metadataOnly: true), "reader did not change active Realm paths/metadata");
        writer.StandardInput.WriteLine("stop"); writer.StandardInput.Flush();
        await writer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Check(writer.ExitCode == 0, "writer transaction closed");
        await stderr; await stdout;
      }
      finally { if (!writer.HasExited) { writer.Kill(); await writer.WaitForExitAsync(); } }
    }
    using (var cancelled = new CancellationTokenSource())
    {
      cancelled.Cancel();
      Check(LibrarySourceReader.Inspect(new() { SourceDirectory = fixture.Root }, cancelled.Token).Status == "cancelled", "pre-cancel does not open source");
    }
    Check(before == Inventory(fixture.Root), "cancelled source unchanged");
    Check(LibrarySourceReader.Inspect(new() { SourceDirectory = Path.Combine(output, "missing") }).Status == "source-missing", "absent native installation");
    Check(LibrarySourceReader.Inspect(new() { SourceDirectory = fixture.Root, Limit = 9 }).Status == "invalid-source", "bounded sample rows");

    var paged = CreateFixture(Path.Combine(output, "paged"), "paged");
    var pageBefore = Inventory(paged.Root);
    var firstPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Limit = 32 });
    Check(firstPage.Ok && !firstPage.SampleOnly && firstPage.Scores.Count == 32 && firstPage.Total == 65 && firstPage.Complete == false,
      "bounded first metadata page is not a sample or EOF");
    var secondPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Limit = 32, Offset = firstPage.NextOffset!.Value, Token = firstPage.CursorToken });
    var lastPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Limit = 32, Offset = secondPage.NextOffset!.Value, Token = secondPage.CursorToken });
    Check(secondPage.Ok && lastPage.Ok && lastPage.Complete == true && lastPage.NextOffset == 65 && lastPage.Scores.Count == 1, "same-token exhaustive pages reach EOF");
    Check(firstPage.Scores.Concat(secondPage.Scores).Concat(lastPage.Scores).Select(item => item.Id).Distinct().Count() == 65, "every source row enumerated exactly once");
    Check(firstPage.Scores.All(item => item.Replay.Status == "unverified" && item.Beatmap.Status == "unverified" && item.Assets.Count == 0),
      "metadata pages never claim byte verification or enumerate media");
    Check(pageBefore == Inventory(paged.Root), "all pages preserve source bytes and sidecars");
    const string selectedId = "a0000000-0000-4000-8000-000000000065";
    var selected = LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId,
      ExpectedReplaySha256 = lastPage.Scores.Single().Replay.Sha256 });
    Check(selected.Ok && !selected.SampleOnly && selected.ResolvedScoreId == selectedId && selected.Scores.Single().Id == selectedId,
      "primary-key resolution reaches score outside first sample and page");
    Check(selected.Scores.Single().AssetManifestComplete && selected.Scores.Single().Assets.Count == 4 &&
      selected.Scores.Single().Assets.All(asset => asset.Resource.Status == "unverified"), "selected complete manifest does not claim media byte verification");
    Check(selected.Scores.Single().Replay.Status == "unverified" && selected.Scores.Single().Beatmap.Status == "unverified" &&
      selected.CursorToken == firstPage.CursorToken, "selected hashes and map MD5 remain unverified hints in one immutable snapshot");
    var provisional = LibrarySourceReader.ResolveProvisionalScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId });
    Check(provisional.Ok && provisional.ResolvedScoreId == selectedId && provisional.Scores.Single().Replay.Sha256 == selected.Scores.Single().Replay.Sha256 &&
      provisional.Scores.Single().Replay.Status == "unverified", "provisional GUID lookup declares exact resource without claiming verification");
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId }).Status == "invalid-source",
      "known identity lookup still requires an established digest");
    Check(LibrarySourceReader.ResolveProvisionalScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId,
      ExpectedReplaySha256 = new string('f', 64) }).Status == "invalid-source", "provisional lookup cannot silently discard a supplied known digest");
    var provisionalWire = new StringWriter();
    await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-provisional-score",
      sourceDirectory = paged.Root, scoreId = selectedId })), provisionalWire);
    Check(JsonConvert.DeserializeObject<LibrarySourceResponse>(provisionalWire.ToString())?.ResolvedScoreId == selectedId,
      "provisional lookup dispatches through the wire protocol");
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId,
      ExpectedReplaySha256 = new string('f', 64) }).Status == "source-changed", "selected identity refuses changed replay association");
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root,
      ScoreId = "a0000000-0000-4000-8000-000000000099", ExpectedReplaySha256 = lastPage.Scores.Single().Replay.Sha256 }).Status == "score-missing",
      "deleted selected score is explicit rather than another result");
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = "bad", ExpectedReplaySha256 = new string('a', 64) }).Status == "invalid-source",
      "malformed selected ID refused");
    using (var busySelected = new FileStream(Path.Combine(paged.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
      Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId,
        ExpectedReplaySha256 = lastPage.Scores.Single().Replay.Sha256 }).Status == "source-busy", "selected resolution honours deny-write lease");
    var selectedWire = new StringWriter();
    await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-score", sourceDirectory = paged.Root,
      scoreId = selectedId, expectedReplaySha256 = lastPage.Scores.Single().Replay.Sha256 })), selectedWire);
    Check(JsonConvert.DeserializeObject<LibrarySourceResponse>(selectedWire.ToString())?.ResolvedScoreId == selectedId, "selected resolution dispatches through real wire protocol");
    var mediaBudget = CreateFixture(Path.Combine(output, "media-over-budget"), "media-over-budget");
    var mediaPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = mediaBudget.Root, Limit = 1 });
    Check(mediaPage.Ok && mediaPage.Scores.Count == 1, "metadata scan does not enumerate an oversized optional media set");
    var mediaBefore = Inventory(mediaBudget.Root);
    var declared = mediaPage.Scores.Single();
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = mediaBudget.Root, ScoreId = declared.Id,
      ExpectedReplaySha256 = declared.Replay.Sha256 }).Status == "resource-limit", "default selected resolution retains the media count bound");
    var metadataWire = new StringWriter();
    await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-score",
      sourceDirectory = mediaBudget.Root, scoreId = declared.Id, expectedReplaySha256 = declared.Replay.Sha256, includeAssets = false })), metadataWire);
    var metadataOnly = JsonConvert.DeserializeObject<LibrarySourceResponse>(metadataWire.ToString());
    Check(metadataOnly is { Ok: true } && metadataOnly.Scores.Count == 1,
      "metadata-only selected resolution succeeds beyond the optional media count bound");
    var metadataScore = metadataOnly!.Scores.Single();
    Check(metadataScore.Replay.Sha256 == declared.Replay.Sha256 && metadataScore.Beatmap.Sha256 == declared.Beatmap.Sha256 &&
      metadataScore.Beatmap.Md5 == declared.Beatmap.Md5 && metadataScore.Assets.Count == 0 && !metadataScore.AssetManifestComplete,
      "metadata-only resolution preserves declared replay/map identity without claiming media completeness");
    var provisionalMetadataWire = new StringWriter();
    await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-provisional-score",
      sourceDirectory = mediaBudget.Root, scoreId = declared.Id, includeAssets = false })), provisionalMetadataWire);
    var provisionalMetadata = JsonConvert.DeserializeObject<LibrarySourceResponse>(provisionalMetadataWire.ToString());
    Check(provisionalMetadata is { Ok: true } && provisionalMetadata.Scores.Single().Replay.Sha256 == declared.Replay.Sha256 &&
      provisionalMetadata.Scores.Single().Assets.Count == 0, "provisional metadata-only selection keeps the same exact replay declaration");
    var changedMetadataWire = new StringWriter();
    await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-score",
      sourceDirectory = mediaBudget.Root, scoreId = declared.Id, expectedReplaySha256 = new string('f', 64), includeAssets = false })), changedMetadataWire);
    Check(JsonConvert.DeserializeObject<LibrarySourceResponse>(changedMetadataWire.ToString())?.Status == "source-changed",
      "metadata-only selection still refuses a changed replay association");
    Check(mediaBefore == Inventory(mediaBudget.Root), "metadata-only and bounded default resolutions preserve every source byte and sidecar");
    var targeted = CreateFixture(Path.Combine(output, "targeted-artwork"), "targeted-artwork");
    var targetScore = LibrarySourceReader.ReadPage(new() { SourceDirectory = targeted.Root, Limit = 1 }).Scores.Single();
    var targetBefore = Inventory(targeted.Root);
    async Task<JObject> Artwork(Fixture source, LibrarySourceScore declaration, string name = "BG.png", string? mapSha = null)
    {
      var wire = new StringWriter();
      await LibrarySourceProtocol.Run(new StringReader(JsonConvert.SerializeObject(new { version = 1, operation = "resolve-artwork",
        sourceDirectory = source.Root, scoreId = declaration.Id, expectedReplaySha256 = declaration.Replay.Sha256,
        expectedMapSha256 = mapSha ?? declaration.Beatmap.Sha256, expectedMapMd5 = declaration.Beatmap.Md5, assetName = name })), wire);
      return JObject.Parse(wire.ToString());
    }
    Check(LibrarySourceReader.ResolveScore(new() { SourceDirectory = targeted.Root, ScoreId = targetScore.Id,
      ExpectedReplaySha256 = targetScore.Replay.Sha256 }).Status == "resource-limit", "full viewer manifest still rejects 6881 declarations");
    var oneArt = await Artwork(targeted, targetScore);
    Check((bool?)oneArt["ok"] == true && oneArt["scores"]?[0]?["assets"] is JArray { Count: 1 }, "targeted wire lookup succeeds beyond the full-manifest cap with one asset");
    var artScore = oneArt["scores"]![0]!;
    Check((bool?)artScore["assetManifestComplete"] == false && (bool?)artScore["artworkLookup"]?["complete"] == true &&
      (string?)artScore["artworkLookup"]?["name"] == "BG.png" && (string?)artScore["artworkLookup"]?["mapSha256"] == targetScore.Beatmap.Sha256,
      "single-name completion never claims a complete manifest and stays map-bound");
    Check((string?)artScore["assets"]?[0]?["resource"]?["status"] == "unverified", "targeted asset declaration still requires consuming byte verification");
    var absentArt = await Artwork(targeted, targetScore, "absent.png");
    Check((bool?)absentArt["ok"] == true && absentArt["scores"]?[0]?["assets"] is JArray { Count: 0 } &&
      (bool?)absentArt["scores"]?[0]?["artworkLookup"]?["complete"] == true, "completed exact-name lookup can establish only its own absence");
    Check((string?)(await Artwork(targeted, targetScore, mapSha: new string('f', 64)))["status"] == "source-changed", "targeted lookup refuses changed map association");
    Check((string?)(await Artwork(targeted, targetScore, "../outside.png"))["status"] == "invalid-source", "targeted name cannot escape the map asset scope");
    using (var cancelledArtwork = new CancellationTokenSource())
    {
      cancelledArtwork.Cancel();
      Check(LibrarySourceReader.ResolveArtwork(new() { SourceDirectory = targeted.Root, ScoreId = targetScore.Id,
        ExpectedReplaySha256 = targetScore.Replay.Sha256, ExpectedMapSha256 = targetScore.Beatmap.Sha256,
        ExpectedMapMd5 = targetScore.Beatmap.Md5, AssetName = "BG.png" }, cancelledArtwork.Token).Status == "cancelled", "targeted cancellation never reports completed absence");
    }
    using (var busyArtwork = new FileStream(Path.Combine(targeted.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
      Check((string?)(await Artwork(targeted, targetScore))["status"] == "source-busy", "targeted lookup retains the source deny-write lease");
    Check(targetBefore == Inventory(targeted.Root), "targeted native lookup preserves source bytes and sidecars");
    foreach (string variant in new[] { "targeted-ambiguous", "targeted-over-budget", "targeted-unsafe", "targeted-missing" })
    {
      var invalidArt = CreateFixture(Path.Combine(output, variant), variant);
      var declaration = LibrarySourceReader.ReadPage(new() { SourceDirectory = invalidArt.Root, Limit = 1 }).Scores.Single();
      var lookup = await Artwork(invalidArt, declaration);
      if (variant == "targeted-missing")
        Check((bool?)lookup["ok"] == true && lookup["scores"]?[0]?["assets"] is JArray { Count: 1 } &&
          (string?)lookup["scores"]?[0]?["assets"]?[0]?["resource"]?["status"] == "missing", "missing physical asset is distinct from an absent declaration");
      else Check((string?)lookup["status"] == (variant == "targeted-over-budget" ? "resource-limit" : "invalid-source"),
        "targeted lookup fails closed for " + variant);
    }
    Check(pageBefore == Inventory(paged.Root), "selected resolution and failures preserve every source byte and sidecar");
    using (var busyAsset = new FileStream(selected.Scores.Single().Assets.Single(asset => asset.Name == "storyboard.osb").Resource.Path!,
      FileMode.Open, FileAccess.ReadWrite, FileShare.None))
    {
      var optionalBusy = LibrarySourceReader.ResolveScore(new() { SourceDirectory = paged.Root, ScoreId = selectedId,
        ExpectedReplaySha256 = lastPage.Scores.Single().Replay.Sha256 });
      Check(optionalBusy.Ok && optionalBusy.Scores.Single().AssetManifestComplete &&
        optionalBusy.Scores.Single().Assets.Single(asset => asset.Name == "storyboard.osb").Resource.Status == "busy" &&
        optionalBusy.Scores.Single().Replay.Status == "unverified", "unreadable optional asset does not hide selected replay or other manifest entries");
    }
    Check(pageBefore == Inventory(paged.Root), "optional busy asset resolution preserves source bytes");
    Check(LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Offset = 1 }).Status == "invalid-cursor", "later offsets require a source token");
    Check(LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Offset = 66, Token = firstPage.CursorToken }).Status == "invalid-cursor", "out-of-range cursor rejected");
    using (var busyPage = new FileStream(Path.Combine(paged.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite))
      Check(LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root }).Status == "source-busy", "metadata page honours deny-write lease");
    File.SetLastWriteTimeUtc(Path.Combine(paged.Root, "client.realm"), DateTime.UtcNow.AddMinutes(1));
    Check(LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Offset = 32, Token = firstPage.CursorToken }).Status == "source-changed", "in-place stamp change invalidates cursor");
    var freshPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root });
    string replacement = Path.Combine(output, "replacement.realm");
    File.Copy(Path.Combine(paged.Root, "client.realm"), replacement);
    File.Move(replacement, Path.Combine(paged.Root, "client.realm"), overwrite: true);
    Check(LibrarySourceReader.ReadPage(new() { SourceDirectory = paged.Root, Offset = 8, Token = freshPage.CursorToken }).Status == "source-changed", "same-byte database replacement invalidates cursor");

    var budget = CreateFixture(Path.Combine(output, "page-budget"), "page-budget");
    var budgetPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = budget.Root, Limit = 32 });
    Check(budgetPage.Ok && budgetPage.Scores.Count is > 0 and < 32 && budgetPage.NextOffset == budgetPage.Scores.Count, "payload budget stops before omitted row");
    Check(Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(budgetPage, Protocol.JsonSettings)) <= LibrarySourceProtocol.MaximumResponseBytes, "metadata page stays within wire budget");

    string emptyRoot = Path.Combine(output, "empty-native"); Directory.CreateDirectory(emptyRoot);
    using (var empty = Realm.GetInstance(new RealmConfiguration(Path.Combine(emptyRoot, "client.realm"))
      { IsDynamic = true, Schema = LibrarySourceReader.RequiredSchema, SchemaVersion = 73 })) { }
    var emptyPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = emptyRoot });
    Check(emptyPage.Ok && emptyPage.Total == 0 && emptyPage.NextOffset == 0 && emptyPage.Complete == true, "empty source explicitly completes");

    var mixed = CreateFixture(Path.Combine(output, "mixed-page"), "mixed-page");
    var mixedPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = mixed.Root, Limit = 32 });
    Check(mixedPage.Ok && mixedPage.Scores.Count == 31 && mixedPage.Errors.Count == 1 && mixedPage.NextOffset == 32,
      "one malformed record does not make later native scores unreachable");
    Check(mixedPage.Errors.Single().Id == "a0000000-0000-4000-8000-000000000002" && mixedPage.Errors.Single().Status == "resource-limit",
      "failed record retains exact native identity and reason");
    var overflow = CreateFixture(Path.Combine(output, "overflow-page"), "overflow-page");
    var overflowPage = LibrarySourceReader.ReadPage(new() { SourceDirectory = overflow.Root, Limit = 32 });
    Check(overflowPage.Ok && overflowPage.Scores.Count == 31 && overflowPage.Errors.Count == 1 && overflowPage.NextOffset == 32,
      "statistics beyond Int64 cannot abort later native rows");
    Check(overflowPage.Errors.Single().Status == "invalid-source", "oversized statistics is a truthful row error");

    foreach (var variant in new[] { "missing-replay", "corrupt-replay", "wrong-map", "wrong-header", "null-map", "duplicate-asset", "oversized-json", "empty-metadata" })
    {
      var altered = CreateFixture(Path.Combine(output, variant), variant);
      var original = Inventory(altered.Root);
      var inspection = LibrarySourceReader.Inspect(new() { SourceDirectory = altered.Root });
      if (variant == "duplicate-asset") Check(!inspection.Ok && inspection.Status == "invalid-source", variant);
      else if (variant == "oversized-json") Check(!inspection.Ok && inspection.Status == "resource-limit", variant);
      else
      {
        Check(inspection.Ok && inspection.Scores.Count == 1, variant + " retains score metadata");
        var observed = inspection.Scores.Single();
        Check(variant switch
        {
          "missing-replay" => observed.Replay.Status == "missing",
          "corrupt-replay" => observed.Replay.Status == "corrupt",
          "wrong-map" or "wrong-header" => observed.Beatmap.Status == "invalid",
          "null-map" => observed.Beatmap.Status == "missing",
          "empty-metadata" => observed.Mods?.Count == 0 && observed.Statistics == null && observed.MaximumStatistics == null,
          _ => false,
        }, variant + " explicit resource state");
      }
      Check(original == Inventory(altered.Root), variant + " non-mutation");
      using (new FileStream(Path.Combine(altered.Root, "client.realm"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
    }

    var unknown = Path.Combine(output, "future-schema");
    Directory.CreateDirectory(unknown);
    using (var realm = Realm.GetInstance(new RealmConfiguration(Path.Combine(unknown, "client.realm"))
    {
      IsDynamic = true, SchemaVersion = 999,
      Schema = new RealmSchema.Builder { new ObjectSchema.Builder("Score") { Property.Primitive("ID", RealmValueType.String, isPrimaryKey: true) } }.Build(),
    })) { }
    var unknownBefore = Inventory(unknown);
    Check(LibrarySourceReader.Inspect(new() { SourceDirectory = unknown }).Status == "unsupported-schema", "incompatible future schema never migrates");
    Check(unknownBefore == Inventory(unknown), "unsupported source unchanged");
    foreach (string change in new[] { "key", "ownership", "link", "metadata" })
    {
      var schema = new RealmSchema.Builder();
      foreach (var type in LibrarySourceReader.RequiredSchema)
      {
        var definition = new ObjectSchema.Builder(type.Name,
          change == "ownership" && type.Name == "RealmUser" ? ObjectSchema.ObjectType.RealmObject : type.BaseType);
        foreach (var property in type)
          definition.Add(change == "key" && type.Name == "Score" && property.Name == "ID" ? Property.Primitive("ID", RealmValueType.Guid) :
            change == "link" && type.Name == "Score" && property.Name == "BeatmapInfo" ? Property.Object("BeatmapInfo", "File") :
            change == "metadata" && type.Name == "BeatmapMetadata" && property.Name == "Title" ? Property.Primitive("Title", RealmValueType.Int) : property);
        schema.Add(definition);
      }
      bool refused = false;
      try { LibrarySourceReader.ValidateSchema(schema.Build()); }
      catch (LibrarySourceException error) { refused = error.Status == "unsupported-schema"; }
      Check(refused, "required schema rejects changed " + change);
    }

    foreach (var input in new[] { "{}", "{\"version\":2}", new string(' ', LibrarySourceProtocol.MaximumRequestChars + 1) })
    {
      var response = new StringWriter();
      await LibrarySourceProtocol.Run(new StringReader(input), response);
      var parsed = JsonConvert.DeserializeObject<LibrarySourceResponse>(response.ToString())!;
      Check(!parsed.Ok && parsed.Version == 1, "invalid/oversized request returns bounded protocol failure");
    }
    Check(LibrarySourceReader.ReadReplayMapHash(new byte[38]) == null, "truncated header unknown");
    await File.WriteAllTextAsync(Path.Combine(output, "result.json"), JsonConvert.SerializeObject(new { ok = true, assertions, scope = "Synthetic native source and failure paths; no real client or playback test" }, Formatting.Indented));
    Console.WriteLine($"PASS: native library source ({assertions} assertions)");
  }

  public static void HoldWriter(string root, string ready)
  {
    using var realm = Realm.GetInstance(new RealmConfiguration(Path.Combine(root, "client.realm"))
      { IsDynamic = true, SchemaVersion = 73 });
    using var transaction = realm.BeginWrite();
    File.WriteAllText(ready, "ready");
    Console.ReadLine();
  }

  private sealed record Fixture(string Root, string MapMd5);

  private static bool IncompleteNumericalStatistics(LibrarySourceScore score) =>
    score.Statistics is { Count: 1 } statistics && (long?)statistics["Great"] == 3 &&
    statistics["Ok"] == null && statistics["Meh"] == null && statistics["Miss"] == null &&
    statistics["LargeTickHit"] == null && statistics["SliderTailHit"] == null && score.MaximumStatistics == null;

  private static Fixture CreateFixture(string fixtureRoot, string variant = "")
  {
    Directory.CreateDirectory(fixtureRoot);
    var root = Path.Combine(fixtureRoot, "source");
    Directory.CreateDirectory(root);
    bool numerical = variant is "numerical" or "numerical-fc";
    byte[] mapBytes = Encoding.UTF8.GetBytes(numerical
      ? "osu file format v14\n[General]\nAudioFilename: audio.mp3\nMode:0\n[Difficulty]\nCircleSize:4\nOverallDifficulty:9\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,64,1000,1,0\n256,192,1500,1,0\n448,320,2000,1,0\n"
      : "osu file format v14\n[General]\nAudioFilename: audio.mp3\nMode:0\n" + (variant.StartsWith("targeted-") ? "[Events]\n0,0,\"BG.png\",0,0\n" : "") + "[HitObjects]\n");
    string mapHash = Hash(mapBytes);
    string md5 = Convert.ToHexString(MD5.HashData(mapBytes)).ToLowerInvariant();
    var replayBytes = new byte[40];
    replayBytes[5] = 0x0b; replayBytes[6] = 32;
    Encoding.ASCII.GetBytes(variant == "wrong-header" ? new string('1', 32) : md5).CopyTo(replayBytes, 7);
    if (numerical) replayBytes = NumericalReplay(md5);
    string replayHash = Hash(replayBytes);
    byte[] audioBytes = [1, 2, 3, 4];
    string audioHash = Hash(audioBytes);
    byte[] artworkBytes = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0RkAAAAASUVORK5CYII=");
    string artworkHash = Hash(artworkBytes);
    string database = Path.Combine(fixtureRoot, "fixture.realm");
    using (var realm = Realm.GetInstance(new RealmConfiguration(database)
    { IsDynamic = true, Schema = LibrarySourceReader.RequiredSchema, SchemaVersion = 73 }))
    using (var transaction = realm.BeginWrite())
    {
      var score = realm.DynamicApi.CreateObject("Score", Guid.Parse("a0000000-0000-4000-8000-000000000001"));
      score.DynamicApi.Set("Date", new DateTimeOffset(638961337234560000, TimeSpan.Zero));
      score.DynamicApi.Set("BeatmapHash", variant == "wrong-map" ? new string('1', 64) : mapHash);
      if (numerical)
      {
        score.DynamicApi.Set("IsLegacyScore", false); score.DynamicApi.Set("ClientVersion", "2026.916.0");
        score.DynamicApi.Set("MaxCombo", 3L); score.DynamicApi.Set("Accuracy", 1d); score.DynamicApi.Set("Rank", 6L);
        score.DynamicApi.Set("Mods", "[]");
        if (variant == "numerical-fc")
        {
          // The native source cannot qualify aggregate PP from these partial saved counts.
          // The unchanged replay still contains all three hits for independent S reconstruction.
          // Leave MaximumStatistics null; a circle-only map's zero component capacity is not
          // a reason to fill in the absent basic judgement counts.
          score.DynamicApi.Set("Statistics", "{\"Great\":3}");
        }
        else
        {
          score.DynamicApi.Set("Statistics", "{\"Great\":3,\"Ok\":0,\"Meh\":0,\"Miss\":0,\"LargeTickHit\":0,\"LargeTickMiss\":0,\"SmallTickHit\":0,\"SmallTickMiss\":0,\"SliderTailHit\":0}");
          score.DynamicApi.Set("MaximumStatistics", "{\"Great\":3,\"LargeTickHit\":0,\"SmallTickHit\":0,\"SliderTailHit\":0}");
        }
        var ruleset = realm.DynamicApi.CreateObject("Ruleset"); ruleset.DynamicApi.Set("OnlineID", 0L);
        score.DynamicApi.Set("Ruleset", RealmValue.Object(ruleset));
        realm.DynamicApi.CreateEmbeddedObjectForProperty(score, "User").DynamicApi.Set("Username", "Native numerical fixture");
      }
      if (variant == "oversized-json") score.DynamicApi.Set("Mods", new string(' ', 65537));
      if (variant == "empty-metadata")
      {
        score.DynamicApi.Set("Mods", ""); score.DynamicApi.Set("Statistics", ""); score.DynamicApi.Set("MaximumStatistics", "");
      }
      var map = realm.DynamicApi.CreateObject("Beatmap");
      map.DynamicApi.Set("Hash", mapHash); map.DynamicApi.Set("MD5Hash", md5);
      var metadata = realm.DynamicApi.CreateObject("BeatmapMetadata");
      metadata.DynamicApi.Set("Title", "Fixture title"); metadata.DynamicApi.Set("Artist", "Fixture artist");
      realm.DynamicApi.CreateEmbeddedObjectForProperty(metadata, "Author").DynamicApi.Set("Username", "Fixture mapper");
      map.DynamicApi.Set("Metadata", RealmValue.Object(metadata)); map.DynamicApi.Set("DifficultyName", "Fixture difficulty");
      map.DynamicApi.Set("Status", -1L); map.DynamicApi.Set("Length", 123456d); map.DynamicApi.Set("BPM", 180d); map.DynamicApi.Set("StarRating", -1d);
      if (variant != "null-map") score.DynamicApi.Set("BeatmapInfo", RealmValue.Object(map));
      var set = realm.DynamicApi.CreateObject("BeatmapSet");
      map.DynamicApi.Set("BeatmapSet", RealmValue.Object(set));
      AddFile(score, "replay.osr", replayHash);
      AddFile(set, "audio.mp3", audioHash);
      if (variant == "media-over-budget")
        for (int number = 0; number < 2048; number++) AddFile(set, $"samples/optional-{number:D4}.wav", audioHash);
      if (variant.StartsWith("targeted-"))
      {
        AddFile(set, "BG.png", artworkHash);
        if (variant == "targeted-ambiguous") AddFile(set, "bg.png", artworkHash);
        if (variant == "targeted-unsafe") AddFile(set, "../other.png", artworkHash);
        int extra = variant == "targeted-artwork" ? 6879 : variant == "targeted-over-budget" ? 8191 : 0;
        for (int number = 0; number < extra; number++) AddFile(set, $"samples/optional-{number:D4}.wav", audioHash);
      }
      if (variant == "paged") { AddFile(set, "bg.png", audioHash); AddFile(set, "samples/hit.wav", audioHash); AddFile(set, "storyboard.osb", Hash([5, 6, 7, 8])); }
      if (variant == "duplicate-asset") AddFile(set, "AUDIO.mp3", audioHash);
      if (variant is "paged" or "page-budget" or "mixed-page" or "overflow-page")
      {
        AddLargeMetadata(score);
        for (int number = 2; number <= 65; number++)
        {
          var extra = realm.DynamicApi.CreateObject("Score", Guid.Parse($"a0000000-0000-4000-8000-{number:D12}"));
          extra.DynamicApi.Set("Date", new DateTimeOffset(638961337234560000, TimeSpan.Zero));
          extra.DynamicApi.Set("BeatmapHash", mapHash); extra.DynamicApi.Set("BeatmapInfo", RealmValue.Object(map));
          AddFile(extra, "replay.osr", replayHash); AddLargeMetadata(extra);
          if (variant == "mixed-page" && number == 2) extra.DynamicApi.Set("Mods", new string(' ', 65537));
          if (variant == "overflow-page" && number == 2) extra.DynamicApi.Set("Statistics", "{\"Miss\":9223372036854775808}");
        }
      }
      void AddLargeMetadata(IRealmObjectBase item)
      {
        if (variant != "page-budget") return;
        item.DynamicApi.Set("Mods", JsonConvert.SerializeObject(new[] { new { acronym = "HD", settings = new { padding = new string('x', 30000) } } }));
        item.DynamicApi.Set("Statistics", JsonConvert.SerializeObject(new Dictionary<string, long> { [new string('x', 60000)] = 1 }));
      }
      void AddFile(IRealmObjectBase owner, string name, string hash)
      {
        var usage = realm.DynamicApi.AddEmbeddedObjectToList(owner.DynamicApi.GetList<IRealmObjectBase>("Files"));
        usage.DynamicApi.Set("Filename", name);
        var file = realm.DynamicApi.All("File").AsEnumerable().FirstOrDefault(item => item.DynamicApi.Get<string>("Hash") == hash)
          ?? realm.DynamicApi.CreateObject("File", hash);
        usage.DynamicApi.Set("File", RealmValue.Object(file));
      }
      transaction.Commit();
    }
    // Only the synthetic fixture is copied, so no existing sidecars can conceal writes by the reader.
    File.Copy(database, Path.Combine(root, "client.realm"));
    Save(mapHash, mapBytes); Save(audioHash, audioBytes);
    if (variant.StartsWith("targeted-") && variant != "targeted-missing") Save(artworkHash, artworkBytes);
    if (variant == "paged") Save(Hash([5, 6, 7, 8]), [5, 6, 7, 8]);
    if (variant != "missing-replay") Save(replayHash, variant == "corrupt-replay" ? [1, 2, 3] : replayBytes);
    void Save(string hash, byte[] bytes)
    {
      string directory = Path.Combine(root, "files", hash[..1], hash[..2]);
      Directory.CreateDirectory(directory);
      File.WriteAllBytes(Path.Combine(directory, hash), bytes);
    }
    return new(root, md5);
  }

  private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
  private static byte[] NumericalReplay(string md5)
  {
    // Installed lzma-js compressed native frame fixture. Validate decoded content before storing it.
    const string frames = "0|256|-500|0,0|256|-500|0,0|64|64|0,1000|64|64|1,100|64|64|0,400|256|192|1,100|256|192|0,400|448|320|1,100|448|320|0,";
    byte[] compressed = Convert.FromBase64String("XQAAAQB1AAAAAAAAAAAYHwJDUQO0AFVX2FOrCO7GjaDaqRpG/8CdPpitGf0/SKLBTssx/M+siDpG83CA1OIhboTzW0D/6th4AA==");
    using var decoded = new MemoryStream();
    LibraryLzmaProtocol.Decode(new MemoryStream(compressed), decoded, "frames", compressed.Length, 4096);
    if (Encoding.UTF8.GetString(decoded.ToArray()) != frames) throw new Exception("Native numerical frame fixture changed");
    using var bytes = new MemoryStream(); using var writer = new BinaryWriter(bytes, Encoding.UTF8, true);
    writer.Write((byte)0); writer.Write(30000000); OsuString(md5); OsuString("Native numerical fixture"); OsuString(new string('a', 32));
    foreach (ushort count in new ushort[] { 3, 0, 0, 0, 0, 0 }) writer.Write(count);
    writer.Write(900); writer.Write((ushort)3); writer.Write(true); writer.Write(0); OsuString(""); writer.Write(638961337234560000L);
    writer.Write(compressed.Length); writer.Write(compressed); writer.Write(0L); writer.Flush(); return bytes.ToArray();
    void OsuString(string value) { if (value.Length == 0) writer.Write((byte)0); else { writer.Write((byte)11); writer.Write(value); } }
  }
  private static string Inventory(string root, bool metadataOnly = false) => string.Join("\n", Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories)
    .OrderBy(path => path, StringComparer.Ordinal).Select(path => Path.GetRelativePath(root, path) + ":" +
      (Directory.Exists(path) ? "directory" : metadataOnly ? $"{new FileInfo(path).Length}:{File.GetLastWriteTimeUtc(path).Ticks}" : Hash(File.ReadAllBytes(path)))));
}
