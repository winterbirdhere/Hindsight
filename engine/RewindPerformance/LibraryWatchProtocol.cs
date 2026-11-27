// SPDX-License-Identifier: MIT
using System.Text;
using System.Threading.Channels;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RewindPerformance;

public sealed record LibraryWatchSubscription(int Slot, long Generation, string Path, bool Recursive, string Filter);

/// <summary>Passive directory notifications only: no Realm, replay reads or performance engine.</summary>
public static class LibraryWatchProtocol
{
  public const int MaximumCommandChars = 16 * 1024;
  public const int MaximumFrameBytes = 4096;
  public const int MaximumSubscriptions = 8;
  public const NotifyFilters Filters = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.Attributes |
    NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime | NotifyFilters.Security;
  private const long MaximumInteger = 9007199254740991;
  public delegate IDisposable WatchFactory(LibraryWatchSubscription request,
    Action<WatcherChangeTypes, string?, string?> changed, Action<Exception> failed);

  public static FileSystemWatcher CreateWatcher(LibraryWatchSubscription request,
    Action<WatcherChangeTypes, string?, string?> changed, Action<Exception> failed)
  {
    var watcher = new FileSystemWatcher(request.Path) {
      IncludeSubdirectories = request.Recursive, NotifyFilter = Filters, InternalBufferSize = 8192
    };
    try {
      watcher.Changed += (_, e) => changed(e.ChangeType, e.Name, null);
      watcher.Created += (_, e) => changed(e.ChangeType, e.Name, null);
      watcher.Deleted += (_, e) => changed(e.ChangeType, e.Name, null);
      watcher.Renamed += (_, e) => changed(e.ChangeType, e.Name, e.OldName);
      watcher.Error += (_, e) => failed(e.GetException());
      watcher.EnableRaisingEvents = true;
      return watcher;
    } catch { watcher.Dispose(); throw; }
  }

  // Filter BEFORE coalescing, so an irrelevant event never becomes an ambiguous dirty.
  public static bool Relevant(string filter, WatcherChangeTypes kind, string? name, string? oldName)
  {
    bool One(string? value) {
      if (string.IsNullOrEmpty(value)) return true;
      if (System.IO.Path.GetExtension(value).Equals(".osg", StringComparison.OrdinalIgnoreCase)) return false;
      return filter switch {
        "stable-root" => value.Equals("scores.db", StringComparison.OrdinalIgnoreCase) || value.Equals("osu!.db", StringComparison.OrdinalIgnoreCase),
        "lazer-root" => value.Equals("client.realm", StringComparison.OrdinalIgnoreCase),
        "all" => true,
        // Node reports create/delete/rename as rename, including directory entries.
        "replay" => kind != WatcherChangeTypes.Changed || System.IO.Path.GetExtension(value).Equals(".osr", StringComparison.OrdinalIgnoreCase),
        _ => false
      };
    }
    return One(name) || (oldName != null && One(oldName));
  }

  private sealed class Slot(LibraryWatchSubscription request)
  {
    public readonly LibraryWatchSubscription Request = request;
    public IDisposable? Handle;
    public bool Dirty;
    public long Revision;
    public long InFlight;
    public string? Error;
    public bool ErrorSent;
  }

  public static async Task Run(TextReader input, TextWriter output, WatchFactory? factory = null)
  {
    factory ??= (request, changed, failed) => CreateWatcher(request, changed, failed);
    using var stop = new CancellationTokenSource();
    var signal = Channel.CreateBounded<bool>(new BoundedChannelOptions(1) { FullMode = BoundedChannelFullMode.DropWrite });
    var gate = new object();
    var slots = new Slot?[MaximumSubscriptions];
    var generations = new long[MaximumSubscriptions];
    long lastConfiguration = 0, configurationAck = 0;
    bool configuring = false, closed = false;
    void Wake() => signal.Writer.TryWrite(true);
    void Changed(Slot slot, WatcherChangeTypes kind, string? name, string? oldName) {
      if (!Relevant(slot.Request.Filter, kind, name, oldName)) return;
      lock (gate) {
        if (closed || slots[slot.Request.Slot] != slot || slot.Error != null) return;
        slot.Dirty = true;
      }
      Wake();
    }
    void Failed(Slot slot, Exception error) {
      lock (gate) {
        if (closed || slots[slot.Request.Slot] != slot || slot.Error != null) return;
        slot.Error = error is InternalBufferOverflowException ? "watch-overflow" : "watch-unavailable";
        slot.Dirty = false;
      }
      Wake();
    }
    void Configure(JObject command) {
      Exact(command, "version", "kind", "sequence", "subscriptions");
      long sequence = Integer(command["sequence"]);
      if (sequence != lastConfiguration + 1 || command["subscriptions"] is not JArray list || list.Count > MaximumSubscriptions)
        throw new InvalidDataException("Invalid watch configuration");
      var requests = new LibraryWatchSubscription?[MaximumSubscriptions];
      foreach (var item in list) {
        if (item is not JObject value) throw new InvalidDataException("Invalid watch subscription");
        Exact(value, "slot", "generation", "path", "recursive", "filter");
        int index = Index(value["slot"]); long generation = Integer(value["generation"]);
        if (value["path"]?.Type != JTokenType.String || value["recursive"]?.Type != JTokenType.Boolean ||
            value["filter"]?.Type != JTokenType.String) throw new InvalidDataException("Invalid watch subscription");
        string path = (string)value["path"]!, filter = (string)value["filter"]!;
        if (requests[index] != null || path.Length is < 1 or > 8192 || !System.IO.Path.IsPathFullyQualified(path) ||
            path.Any(char.IsControl) || filter is not ("stable-root" or "lazer-root" or "replay" or "all"))
          throw new InvalidDataException("Invalid watch subscription");
        requests[index] = new(index, generation, path, (bool)value["recursive"]!, filter);
      }
      var old = new List<IDisposable>();
      var added = new List<Slot>();
      lock (gate) {
        if (configurationAck != 0) throw new InvalidDataException("Watch control capacity");
        // Validate the entire replacement before releasing any old ownership.
        for (int i = 0; i < slots.Length; i++) {
          var previous = slots[i]; var next = requests[i];
          if (next != null && previous?.Request != next && next.Generation <= generations[i])
            throw new InvalidDataException("Watch generation must advance");
        }
        configuring = true;
        for (int i = 0; i < slots.Length; i++) {
          var previous = slots[i]; var next = requests[i];
          if (previous?.Request == next) continue;
          if (previous?.Handle != null) { old.Add(previous.Handle); previous.Handle = null; }
          slots[i] = next == null ? null : new Slot(next);
          if (slots[i] != null) { generations[i] = slots[i]!.Request.Generation; added.Add(slots[i]!); }
        }
        lastConfiguration = sequence;
      }
      foreach (var handle in old) handle.Dispose();
      foreach (var slot in added) {
        try {
          var handle = factory(slot.Request, (kind, name, oldName) => Changed(slot, kind, name, oldName), error => Failed(slot, error));
          bool retain;
          lock (gate) {
            retain = !closed && slots[slot.Request.Slot] == slot;
            if (retain) slot.Handle = handle;
          }
          if (!retain) handle.Dispose();
        } catch (Exception error) { Failed(slot, error); }
      }
      lock (gate) { configuring = false; configurationAck = sequence; }
      Wake();
    }
    void Command(string line) {
      JObject command;
      try { command = JObject.Parse(line, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error }); }
      catch (JsonException error) { throw new InvalidDataException("Invalid watch command", error); }
      if (command["version"]?.Type != JTokenType.Integer || (long?)command["version"] != 1 || command["kind"]?.Type != JTokenType.String)
        throw new InvalidDataException("Invalid watch command");
      if ((string?)command["kind"] == "configure") { Configure(command); return; }
      if ((string?)command["kind"] != "ack") throw new InvalidDataException("Invalid watch command");
      Exact(command, "version", "kind", "slot", "generation", "revision");
      int index = Index(command["slot"]); long generation = Integer(command["generation"]), revision = Integer(command["revision"]);
      lock (gate) {
        var slot = slots[index];
        if (slot == null || slot.Request.Generation != generation) return; // Detached acknowledgement.
        if (slot.InFlight != revision) throw new InvalidDataException("Invalid watch acknowledgement");
        slot.InFlight = 0;
      }
      Wake();
    }
    async Task Read() {
      var line = new StringBuilder(); var unit = new char[1];
      while (await input.ReadAsync(unit.AsMemory(), stop.Token) != 0) {
        if (unit[0] == '\n') { Command(line.ToString()); line.Clear(); }
        else {
          if (line.Length >= MaximumCommandChars) throw new InvalidDataException("Watch command bound");
          line.Append(unit[0]);
        }
      }
      // A truncated control must fail, not quietly install a partial configuration.
      if (line.Length != 0) throw new InvalidDataException("Truncated watch command");
    }
    async Task Write() {
      while (await signal.Reader.WaitToReadAsync(stop.Token)) {
        signal.Reader.TryRead(out _);
        for (;;) {
          object? message = null; IDisposable? dispose = null;
          lock (gate) {
            if (closed || configuring) break;
            if (configurationAck != 0) {
              message = new { version = 1, kind = "configured", sequence = configurationAck }; configurationAck = 0;
            } else foreach (var slot in slots) {
              if (slot == null) continue;
              if (slot.Error != null && !slot.ErrorSent) {
                slot.ErrorSent = true; dispose = slot.Handle; slot.Handle = null;
                message = new { version = 1, kind = "error", slot = slot.Request.Slot, generation = slot.Request.Generation, error = slot.Error }; break;
              }
              if (slot.Error == null && slot.Dirty && slot.InFlight == 0) {
                if (slot.Revision == MaximumInteger) throw new InvalidDataException("Watch revision exhausted");
                slot.Dirty = false; slot.InFlight = ++slot.Revision;
                message = new { version = 1, kind = "dirty", slot = slot.Request.Slot, generation = slot.Request.Generation, revision = slot.Revision }; break;
              }
            }
          }
          dispose?.Dispose();
          if (message == null) break;
          string body = JsonConvert.SerializeObject(message);
          if (Encoding.UTF8.GetByteCount(body) > MaximumFrameBytes) throw new InvalidDataException("Watch output bound");
          await output.WriteLineAsync(body.AsMemory(), stop.Token);
          await output.FlushAsync(stop.Token);
        }
      }
    }
    // Console.In's synchronized reader may execute reads synchronously. One reader
    // worker keeps output/ACK progress independent without spawning per-event work.
    var reader = Task.Run(Read); var writer = Write();
    try { await await Task.WhenAny(reader, writer); }
    finally {
      List<IDisposable> retained;
      lock (gate) {
        closed = true;
        retained = slots.Where(slot => slot?.Handle != null).Select(slot => slot!.Handle!).ToList();
        foreach (var slot in slots) if (slot != null) slot.Handle = null;
      }
      stop.Cancel();
      foreach (var handle in retained) handle.Dispose();
      try { await Task.WhenAll(reader, writer); } catch (OperationCanceledException) { }
    }
  }
  private static void Exact(JObject value, params string[] keys)
  {
    if (value.Count != keys.Length || value.Properties().Any(p => !keys.Contains(p.Name)))
      throw new InvalidDataException("Unexpected watch fields");
  }
  private static long Integer(JToken? value)
  {
    if (value?.Type != JTokenType.Integer || !long.TryParse(value.ToString(), out long number) || number < 1 || number > MaximumInteger)
      throw new InvalidDataException("Invalid watch integer");
    return number;
  }
  private static int Index(JToken? value)
  {
    if (value?.Type != JTokenType.Integer || !int.TryParse(value.ToString(), out int number) || number < 0 || number >= MaximumSubscriptions)
      throw new InvalidDataException("Invalid watch slot");
    return number;
  }
}
