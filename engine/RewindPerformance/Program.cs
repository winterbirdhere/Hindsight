// SPDX-License-Identifier: MIT
using System.Text;
using Newtonsoft.Json;
using osu.Framework.Logging;
using RewindPerformance;

Logger.Enabled = false;
if (args.Length > 0 && args[0] == "--library-lzma")
{
  // Dedicated per-block child: no performance engine or source database opens.
  Console.SetOut(Console.Error);
  try
  {
    if (args.Length != 4 || !int.TryParse(args[2], out int length) || !int.TryParse(args[3], out int limit))
      throw new InvalidDataException("Invalid bounded replay decoder arguments");
    using var binaryOutput = Console.OpenStandardOutput();
    LibraryLzmaProtocol.Decode(Console.OpenStandardInput(), binaryOutput, args[1], length, limit);
  }
  catch (Exception error)
  {
    Console.Error.WriteLine(error.Message);
    Environment.ExitCode = 1;
  }
  return;
}
// Keep third-party diagnostics off the JSON-lines protocol stream.
using var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
Console.SetOut(Console.Error);
if (args.Length == 1 && args[0] == "--library-watch")
{
  try { await LibraryWatchProtocol.Run(Console.In, output); }
  catch { Console.Error.WriteLine("Library watcher protocol failed"); Environment.ExitCode = 1; }
  return;
}
if (args.Length == 1 && args[0] == "--library-source")
{
  await LibrarySourceProtocol.Run(Console.In, output);
  return;
}
var calculator = new PerformanceEngine();
string? line;
while ((line = Console.ReadLine()) != null)
{
  if (string.IsNullOrWhiteSpace(line)) continue;
  EngineRequest? request = null;
  EngineResponse response;
  try
  {
    request = JsonConvert.DeserializeObject<EngineRequest>(line, Protocol.JsonSettings)
              ?? throw new InvalidDataException("Empty request.");
    using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(2));
    response = calculator.Calculate(request, cancellation.Token);
  }
  catch (Exception error)
  {
    response = new EngineResponse { Id = request?.Id, Ok = false, Error = error.Message };
  }
  await output.WriteLineAsync(JsonConvert.SerializeObject(response, Protocol.JsonSettings));
}
