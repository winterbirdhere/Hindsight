using System.Buffers.Binary;
using SharpCompress.Compressors.LZMA;

namespace RewindPerformance;

public static class LibraryLzmaProtocol
{
    public static void Decode(Stream input, Stream output, string role, int compressedLength,
        int maxOutputBytes, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var limits = role switch
        {
            "frames" => (Compressed: 64 * 1024 * 1024, Expanded: 256 * 1024 * 1024),
            "score-info" => (Compressed: 1024 * 1024, Expanded: 8 * 1024 * 1024),
            _ => throw new InvalidDataException("Invalid replay block role"),
        };
        if (compressedLength < 13 || compressedLength > limits.Compressed || maxOutputBytes < 1 || maxOutputBytes > limits.Expanded)
            throw new InvalidDataException("Invalid replay block size limit");
        byte[] header = new byte[13];
        input.ReadExactly(header);
        if (header[0] >= 225 || BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(1, 4)) > 64 * 1024 * 1024)
            throw new InvalidDataException("Invalid LZMA properties or dictionary limit");
        ulong declaredSize = BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(5, 8));
        // Preserve the installed legacy reader's all-zero streaming sentinel.
        bool unknownSize = declaredSize == 0 || declaredSize == ulong.MaxValue;
        if (!unknownSize && declaredSize > (ulong)maxOutputBytes)
            throw new InvalidDataException("Declared LZMA output exceeds expanded size limit");
        using var body = new BoundedInput(input, compressedLength - 13, cancellationToken);
        // RangeCoder uses ReadByte frequently; buffer pipe input to avoid a
        // one-byte allocation/system read for every compressed byte.
        using var bufferedBody = new BufferedStream(body, 64 * 1024);
        using var decoder = LzmaStream.Create(header[..5], bufferedBody, compressedLength - 13,
            unknownSize ? -1 : (long)declaredSize, true);
        byte[] chunk = new byte[64 * 1024];
        int total = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int count = decoder.Read(chunk, 0, Math.Min(chunk.Length, maxOutputBytes - total + 1));
            if (count == 0) break;
            if (count > maxOutputBytes - total) throw new InvalidDataException("LZMA output exceeds expanded size limit");
            output.Write(chunk, 0, count);
            total += count;
        }
        if (!unknownSize && (ulong)total != declaredSize) throw new InvalidDataException("LZMA declared output size mismatch");
        // The end marker can precede range-coder padding. Drain the bounded body
        // before requiring EOF on stdin; never allow another block in this child.
        while (body.Read(chunk, 0, chunk.Length) != 0) { }
        cancellationToken.ThrowIfCancellationRequested();
        if (input.ReadByte() != -1) throw new InvalidDataException("Unexpected bytes after replay block");
        output.Flush();
    }

    private sealed class BoundedInput : Stream
    {
        private readonly Stream inner;
        private readonly int length;
        private readonly CancellationToken token;
        private int remaining;
        public BoundedInput(Stream inner, int length, CancellationToken token)
        {
            this.inner = inner; this.length = length; this.token = token; remaining = length;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => length - remaining; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            token.ThrowIfCancellationRequested();
            if (remaining == 0 || buffer.Length == 0) return 0;
            int count = inner.Read(buffer[..Math.Min(buffer.Length, remaining)]);
            if (count == 0) throw new EndOfStreamException("Truncated LZMA body");
            remaining -= count;
            return count;
        }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
