// SPDX-License-Identifier: MIT
using System.Text;
using System.Threading.Channels;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RewindPerformance;

internal static class LibraryWatchTests
{
  public static async Task Run(string? fixtureRoot = null)
  {
    int assertions = 0;
    void Check(bool value, string message) { if (!value) throw new Exception(message); assertions++; }
    var expected = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Attributes |
      NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime | NotifyFilters.Security;
    Check(LibraryWatchProtocol.Filters == expected && (LibraryWatchProtocol.Filters & NotifyFilters.LastAccess) == 0, "Exclude only LastAccess");
    Check(!LibraryWatchProtocol.Relevant("lazer-root", WatcherChangeTypes.Changed, "client.realm.lock", null), "Ignore Realm lock");
    Check(LibraryWatchProtocol.Relevant("lazer-root", WatcherChangeTypes.Renamed, "old", "client.realm"), "Rename out of Realm remains relevant");
    Check(LibraryWatchProtocol.Relevant("stable-root", WatcherChangeTypes.Changed, "scores.db", null), "Stable scores");
    Check(LibraryWatchProtocol.Relevant("stable-root", WatcherChangeTypes.Changed, "OSU!.DB", null), "Stable maps");
    Check(!LibraryWatchProtocol.Relevant("stable-root", WatcherChangeTypes.Changed, "other", null), "No irrelevant ambiguous dirty");
    Check(LibraryWatchProtocol.Relevant("replay", WatcherChangeTypes.Renamed, "pack.v2", null), "Directory rename");
    Check(!LibraryWatchProtocol.Relevant("all", WatcherChangeTypes.Changed, "a.osg", null), "Retired osg ignored");
    Check(LibraryWatchProtocol.Relevant("replay", WatcherChangeTypes.Renamed, "new.osg", "old.osr"), "Relevant old rename name retained");
    Check(LibraryWatchProtocol.Relevant("replay", WatcherChangeTypes.Changed, null, null), "Unknown filename conservatively dirty");
    using var input = new CommandReader();
    var output = new ReceiptWriter();
    var handles = new List<FakeWatch>();
    var run = LibraryWatchProtocol.Run(input, output, (request, changed, failed) => {
      var handle = new FakeWatch(request, changed, failed); handles.Add(handle); return handle;
    });
    string Configure(int sequence, int generation) => JsonConvert.SerializeObject(new { version = 1, kind = "configure", sequence,
      subscriptions = new[] { new { slot = 0, generation, path = Path.GetFullPath("."), recursive = true, filter = "replay" } } });
    input.Send(Configure(1, 1)); Check((string?)(await output.Next())["kind"] == "configured", "Configuration acknowledged");
    handles[0].Changed(WatcherChangeTypes.Changed, "ignored.txt", null);
    handles[0].Changed(WatcherChangeTypes.Changed, "a.osr", null);
    var dirty = await output.Next(); Check((long?)dirty["revision"] == 1, "First dirty");
    for (int i = 0; i < 10000; i++) handles[0].Changed(WatcherChangeTypes.Changed, "a.osr", null);
    Check(output.Available == 0, "No unbounded writes while event unacknowledged");
    input.Send("{\"version\":1,\"kind\":\"ack\",\"slot\":0,\"generation\":1,\"revision\":1}");
    Check((long?)(await output.Next())["revision"] == 2, "Changes during inflight survive ack");
    input.Send(Configure(2, 2)); Check((string?)(await output.Next())["kind"] == "configured", "Replacement acknowledged");
    Check(handles[0].Disposed, "Old handle disposed");
    handles[0].Changed(WatcherChangeTypes.Changed, "stale.osr", null);
    handles[1].Changed(WatcherChangeTypes.Changed, "new.osr", null);
    dirty = await output.Next(); Check((long?)dirty["generation"] == 2 && (long?)dirty["revision"] == 1, "Old callback fenced");
    handles[1].Failed(new InternalBufferOverflowException());
    var error = await output.Next(); Check((string?)error["error"] == "watch-overflow", "Overflow explicit");
    Check(handles[1].Disposed, "Failed watcher disposed");
    input.Complete(); await run.WaitAsync(TimeSpan.FromSeconds(3));
    Check(handles.All(h => h.Disposed), "EOF disposes every handle");

    foreach (var bad in new[] {
      new string('x', LibraryWatchProtocol.MaximumCommandChars + 1),
      "{\"version\":1,\"kind\":\"unknown\"}",
      "{\"version\":1,\"kind\":\"configure\",\"sequence\":1,\"subscriptions\":[{\"slot\":8,\"generation\":1,\"path\":\"D:\\\\x\",\"recursive\":true,\"filter\":\"all\"}]}"
    }) {
      bool rejected = false;
      try { await LibraryWatchProtocol.Run(new StringReader(bad + "\n"), new StringWriter()); }
      catch (InvalidDataException) { rejected = true; }
      Check(rejected, "Malformed/oversized/capacity command rejected");
    }
    if (fixtureRoot != null) await RealWatch(fixtureRoot, Check);
    Console.WriteLine($"PASS library-watch {assertions} assertions");
  }

  private static async Task RealWatch(string root, Action<bool, string> check)
  {
    if (!OperatingSystem.IsWindows()) throw new Exception("Windows fixture required");
    root = Path.GetFullPath(root);
    if (Directory.Exists(root)) throw new Exception("Fresh disposable fixture only");
    Directory.CreateDirectory(root);
    string file = Path.Combine(root, "access.osr");
    File.WriteAllText(file, "same-size");
    var events = new List<string>(); var frames = new List<JObject>(); bool exceeded = false;
    using var input = new CommandReader(); var output = new ReceiptWriter();
    FileSystemWatcher? watcher = null;
    var run = LibraryWatchProtocol.Run(input, output, (request, changed, failed) => {
      watcher = LibraryWatchProtocol.CreateWatcher(request, (kind, name, oldName) => {
        lock (events) { if (events.Count < 256) events.Add(kind + ":" + name); else exceeded = true; }
        changed(kind, name, oldName);
      }, error => { lock (events) events.Add("ERROR:" + error.GetType().Name); failed(error); });
      return watcher;
    });
    input.Send(JsonConvert.SerializeObject(new { version = 1, kind = "configure", sequence = 1,
      subscriptions = new[] { new { slot = 0, generation = 1, path = root, recursive = true, filter = "replay" } } }));
    check((string?)(await output.Next())["kind"] == "configured", "Real subscriptions ready");
    check(watcher != null && watcher.NotifyFilter == LibraryWatchProtocol.Filters, "Actual installed FileSystemWatcher mask");
    using var pumpStop = new CancellationTokenSource();
    var pump = Task.Run(async () => {
      try {
        for (;;) {
          var frame = await output.Next(pumpStop.Token);
          lock (frames) { if (frames.Count >= 64) throw new Exception("Fixture notification bound"); frames.Add(frame); }
          if ((string?)frame["kind"] == "dirty") input.Send(JsonConvert.SerializeObject(new { version = 1, kind = "ack",
            slot = (int)frame["slot"]!, generation = (long)frame["generation"]!, revision = (long)frame["revision"]! }));
        }
      } catch (OperationCanceledException) when (pumpStop.IsCancellationRequested) { }
    });
    bool eofClosed = false, postCloseWriteSilent = false;
    try {
    await Task.Delay(150);
    File.SetLastAccessTimeUtc(file, new DateTime(2001, 2, 3, 4, 5, 6, DateTimeKind.Utc));
    await Task.Delay(200);
    File.ReadAllText(file);
    await Task.Delay(300);
    lock (events) check(events.Count == 0, "Explicit atime/read-back produces no selected notification");
    File.WriteAllText(file, "Same-size");
    await Task.Delay(300);
    lock (events) check(events.Count > 0 && !events.Any(e => e.StartsWith("ERROR:")), "Same-size write positive control");
    string moved = Path.Combine(root, "moved.osr");
    File.Move(file, moved);
    await Task.Delay(200);
    File.Delete(moved);
    await Task.Delay(200);
    lock (events) {
      check(events.Any(e => e.StartsWith("Renamed:")), "Rename positive control");
      check(events.Any(e => e.StartsWith("Deleted:")), "Delete positive control");
    }
    input.Complete(); await run.WaitAsync(TimeSpan.FromSeconds(3));
    eofClosed = true;
    pumpStop.Cancel(); await pump;
    int before;
    lock (events) before = events.Count;
    File.WriteAllText(Path.Combine(root, "after-eof.osr"), "closed");
    await Task.Delay(150);
    lock (events) check(events.Count == before && !exceeded, "Actual EOF disposes subscriptions; post-close write silent");
    postCloseWriteSilent = true;
    lock (frames) check(frames.Any(f => (string?)f["kind"] == "dirty") && frames.All(f => (string?)f["kind"] == "dirty"), "Real bounded dirty protocol, no error");
    } finally {
      input.Complete(); pumpStop.Cancel();
      try { await run.WaitAsync(TimeSpan.FromSeconds(3)); await pump; }
      finally {
        watcher?.Dispose();
        lock (events) lock (frames) File.WriteAllText(Path.Combine(root, "watch-events.json"), JsonConvert.SerializeObject(new {
          notifyFilter = (int)LibraryWatchProtocol.Filters, events, frames, eofClosed, postCloseWriteSilent, exceeded
        }));
      }
    }
  }
  private sealed class FakeWatch(LibraryWatchSubscription request, Action<WatcherChangeTypes, string?, string?> changed, Action<Exception> failed) : IDisposable
  {
    public LibraryWatchSubscription Request = request;
    public Action<WatcherChangeTypes, string?, string?> Changed = changed;
    public Action<Exception> Failed = failed;
    public bool Disposed;
    public void Dispose() => Disposed = true;
  }
  private sealed class CommandReader : TextReader
  {
    private readonly Channel<char> chars = Channel.CreateUnbounded<char>();
    public void Send(string line) { foreach (char c in line + "\n") chars.Writer.TryWrite(c); }
    public void Complete() => chars.Writer.TryComplete();
    public override async ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
    {
      if (!await chars.Reader.WaitToReadAsync(cancellationToken)) return 0;
      char value = await chars.Reader.ReadAsync(cancellationToken);
      buffer.Span[0] = value; return 1;
    }
  }
  private sealed class ReceiptWriter : TextWriter
  {
    private readonly Channel<string> lines = Channel.CreateUnbounded<string>();
    public override Encoding Encoding => Encoding.UTF8;
    public int Available => lines.Reader.Count;
    public Task<JObject> Next(CancellationToken cancellation = default) => Read(cancellation);
    private async Task<JObject> Read(CancellationToken cancellation) =>
      JObject.Parse(await lines.Reader.ReadAsync(cancellation).AsTask().WaitAsync(TimeSpan.FromSeconds(3), cancellation));
    public override Task WriteLineAsync(ReadOnlyMemory<char> buffer, CancellationToken cancellationToken = default)
    { lines.Writer.TryWrite(buffer.ToString()); return Task.CompletedTask; }
  }
}
