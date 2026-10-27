using System.Text;
using RewindPerformance;

internal static class LibraryLzmaTests
{
    // Known-size lzma-js and unknown-size Python 3.12 FORMAT_ALONE output.
    private const string known = "XQAAgAApAAAAAAAAAAAYHwJDUQO0DobDyTn5IJJWkGpkOWvy5Kz+6pym7elVp+Mjqv/2twgA";
    private const string unknown = "XQAAgAD//////////wAYHwJDUQO0DobDyTn5IJJWkGpkOWvy5Kz+6pym7elVp+Mjqv/2twgA";

    public static void Run()
    {
        int assertions = 0;
        foreach (string fixture in new[] { known, unknown })
        {
            byte[] data = Convert.FromBase64String(fixture);
            using var output = new MemoryStream();
            LibraryLzmaProtocol.Decode(new MemoryStream(data), output, "frames", data.Length, 256 * 1024 * 1024);
            Check(Encoding.UTF8.GetString(output.ToArray()) == "0|256|192|0,1000|256|192|1,-12345|0|0|42,", "decoded frames");
        }
        byte[] bytes = Convert.FromBase64String(known);
        // Installed lzma-js accepts all-zero size headers as unknown too.
        var zeroSize = (byte[])bytes.Clone(); Array.Fill(zeroSize, (byte)0, 5, 8);
        using (var output = new MemoryStream())
        {
            LibraryLzmaProtocol.Decode(new MemoryStream(zeroSize), output, "frames", zeroSize.Length, 100);
            Check(Encoding.UTF8.GetString(output.ToArray()) == "0|256|192|0,1000|256|192|1,-12345|0|0|42,", "zero-size legacy parity");
        }
        Reject(bytes[..12], bytes.Length, "truncated input");
        Reject(bytes[..^1], bytes.Length, "truncated body");
        Reject([.. bytes, 0], bytes.Length, "extra stdin bytes");
        var props = (byte[])bytes.Clone(); props[0] = 225;
        Reject(props, props.Length, "invalid properties");
        var dictionary = (byte[])bytes.Clone(); Array.Fill(dictionary, (byte)255, 1, 4);
        Reject(dictionary, dictionary.Length, "unbounded dictionary");
        var expanded = (byte[])bytes.Clone(); BitConverter.GetBytes(300_000_000UL).CopyTo(expanded, 5);
        Reject(expanded, expanded.Length, "declared expanded cap");
        var wrongSize = (byte[])bytes.Clone(); BitConverter.GetBytes(42UL).CopyTo(wrongSize, 5);
        Reject(wrongSize, wrongSize.Length, "declared output mismatch");
        foreach (byte[] unknownFixture in new[] { Convert.FromBase64String(unknown), zeroSize })
        {
            using var output = new MemoryStream();
            try { LibraryLzmaProtocol.Decode(new MemoryStream(unknownFixture), output, "score-info", bytes.Length, 20); throw new Exception("Accepted expansion overflow"); }
            catch (InvalidDataException) { Check(output.Length <= 20, "no over-limit output escaped"); }
        }
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            try { LibraryLzmaProtocol.Decode(new MemoryStream(bytes), Stream.Null, "frames", bytes.Length, 1024, cancelled.Token); throw new Exception("Accepted cancelled decode"); }
            catch (OperationCanceledException) { assertions++; }
        }
        Console.WriteLine($"PASS: {assertions} bounded LZMA assertions");

        void Check(bool value, string label) { if (!value) throw new Exception(label); assertions++; }
        void Reject(byte[] data, int length, string label)
        {
            try { LibraryLzmaProtocol.Decode(new MemoryStream(data), Stream.Null, "frames", length, 256 * 1024 * 1024); }
            catch (InvalidDataException) { assertions++; return; }
            catch (EndOfStreamException) { assertions++; return; }
            catch (Exception error) when (error.GetType().FullName == "SharpCompress.Compressors.LZMA.DataErrorException")
            { assertions++; return; }
            throw new Exception("Accepted " + label);
        }
    }
}
