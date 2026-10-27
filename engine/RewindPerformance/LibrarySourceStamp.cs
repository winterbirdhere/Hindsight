// SPDX-License-Identifier: MIT
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace RewindPerformance;

/// <summary>Windows handle-bound invalidation stamp, not a cryptographic database content identity.</summary>
internal static class LibrarySourceStamp
{
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicInfo
  {
    public long CreationTime;
    public long LastAccessTime;
    public long LastWriteTime;
    public long ChangeTime;
    public uint FileAttributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IdInfo
  {
    public ulong VolumeSerialNumber;
    public ulong FileIdLow;
    public ulong FileIdHigh;
  }
  [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadBasic(SafeFileHandle file, int infoClass, out BasicInfo info, uint size);
  [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool ReadId(SafeFileHandle file, int infoClass, out IdInfo info, uint size);

  public static string Read(FileStream lease, string schema, int total)
  {
    if (!ReadBasic(lease.SafeFileHandle, 0, out var basic, (uint)Marshal.SizeOf<BasicInfo>()) ||
        !ReadId(lease.SafeFileHandle, 18, out var identity, (uint)Marshal.SizeOf<IdInfo>()))
      throw new LibrarySourceException("unsupported-filesystem");
    string value = FormattableString.Invariant($"{identity.VolumeSerialNumber}:{identity.FileIdLow}:{identity.FileIdHigh}:{lease.Length}:{basic.CreationTime}:{basic.LastWriteTime}:{basic.ChangeTime}:{schema}:{total}");
    return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
  }
}
