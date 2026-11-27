// SPDX-License-Identifier: MIT
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json;

namespace RewindPerformance;

public sealed class LibrarySourceReadGuardRequest
{
  public string SourceDirectory {get;set;}="";
  public string? File {get;set;}
  public string? ExpectedSha256 {get;set;}
  public string? ExpectedRootIdentity {get;set;}
  public string? ExpectedDatabaseIdentity {get;set;}
}

/// <summary>Read-only witnesses, never deletion targets. The mutation helper owns these
/// handles until its writer is disposed. Root-only witnesses pin ancestry/path identity;
/// they do not prevent creation or modification of arbitrary directory children.</summary>
public sealed class LibrarySourceReadGuard : IDisposable
{
  private sealed class Held(LibrarySourceDeletion.SourcePins roots)
  {
    internal readonly LibrarySourceDeletion.SourcePins Roots=roots;
    internal FileStream? Leaf;
    internal string? LeafIdentity;
    internal readonly List<(SafeFileHandle Handle,string Identity)> Directories=[];
  }
  private readonly List<Held> held=[];
  private readonly CancellationToken cancellation;
  private bool disposed;
  public string Token {get;}=LibrarySourceDeletion.Digest(Guid.NewGuid().ToString("N"));
  public string Fingerprint {get;private set;}="";
  private LibrarySourceReadGuard(CancellationToken cancellation){this.cancellation=cancellation;}

  public static LibrarySourceReadGuard Acquire(IReadOnlyList<LibrarySourceReadGuardRequest> requests,CancellationToken cancellation=default)
  {
    if(requests==null||requests.Count is <1 or >128)throw new LibrarySourceException("invalid-source");
    var guard=new LibrarySourceReadGuard(cancellation);
    try {
      var rootsSeen=new HashSet<string>(StringComparer.Ordinal);
      var evidence=new List<object>();long bytes=0;
      foreach(var request in requests) {
        cancellation.ThrowIfCancellationRequested();
        if(request==null||request.File is not (null or "client.realm" or "scores.db")||
           request.File==null&&(request.ExpectedSha256!=null||request.ExpectedDatabaseIdentity!=null)||
           request.File!=null&&!LibrarySourceDeletion.IsHash(request.ExpectedSha256)||
           request.ExpectedRootIdentity!=null&&!LibrarySourceDeletion.IsHash(request.ExpectedRootIdentity)||
           request.ExpectedDatabaseIdentity!=null&&!LibrarySourceDeletion.IsHash(request.ExpectedDatabaseIdentity))
          throw new LibrarySourceException("invalid-source");
        var entry=new Held(LibrarySourceDeletion.SourcePins.Open(request.SourceDirectory));guard.held.Add(entry);
        HoldDirectoryDataAccess(entry);
        if(!rootsSeen.Add(entry.Roots.Identity))throw new LibrarySourceException("invalid-source");
        if(request.ExpectedRootIdentity!=null&&request.ExpectedRootIdentity!=entry.Roots.Identity)throw new LibrarySourceException("source-changed");
        if(request.File!=null) {
          entry.Leaf=LibrarySourceDeletion.SourcePins.OpenDatabaseLease(Path.Combine(entry.Roots.Directory,request.File));
          entry.LeafIdentity=LibrarySourceDeletion.SourcePins.IdentityOf(entry.Leaf.SafeFileHandle);
          if(request.ExpectedDatabaseIdentity!=null&&request.ExpectedDatabaseIdentity!=entry.LeafIdentity)throw new LibrarySourceException("source-changed");
          bytes=checked(bytes+entry.Leaf.Length);
          if(bytes>512L*1024*1024||request.File=="scores.db"&&entry.Leaf.Length>64L*1024*1024)throw new LibrarySourceException("resource-limit");
          if(Hash(entry.Leaf,cancellation)!=request.ExpectedSha256)throw new LibrarySourceException("source-changed");
        }
        evidence.Add(new{entry.Roots.Directory,RootIdentity=entry.Roots.Identity,request.File,DatabaseIdentity=entry.LeafIdentity,request.ExpectedSha256});
      }
      guard.Fingerprint=LibrarySourceDeletion.Digest(JsonConvert.SerializeObject(evidence,Protocol.JsonSettings));
      guard.Verify();return guard;
    }catch{guard.Dispose();throw;}
  }

  public void Verify()
  {
    if(disposed)throw new LibrarySourceException("invalid-state");
    cancellation.ThrowIfCancellationRequested();
    foreach(var entry in held) {
      foreach(var directory in entry.Directories){
        if((LibraryFileMutationNative.Stat(directory.Handle).Attr&0x410)!=0x10||LibrarySourceDeletion.SourcePins.IdentityOf(directory.Handle)!=directory.Identity)
          throw new LibrarySourceException("source-changed");
      }
      // Re-check the pinned pathname/ancestry as well as the retained leaf handle.
      using var current=LibrarySourceDeletion.SourcePins.Open(entry.Roots.Directory);
      if(current.Identity!=entry.Roots.Identity)throw new LibrarySourceException("source-changed");
      if(entry.Leaf!=null) {
        LibrarySourceDeletion.SourcePins.ValidateDatabaseHandle(entry.Leaf.SafeFileHandle);
        if(LibrarySourceDeletion.SourcePins.IdentityOf(entry.Leaf.SafeFileHandle)!=entry.LeafIdentity)throw new LibrarySourceException("source-changed");
      }
    }
  }
  private static void HoldDirectoryDataAccess(Held entry)
  {
    var paths=new List<string>();
    for(var current=new DirectoryInfo(entry.Roots.Directory);current!=null;current=current.Parent)paths.Add(current.FullName);
    foreach(string path in paths.AsEnumerable().Reverse()) {
      // Attribute-only handles do not participate in Windows sharing checks. LIST_DIRECTORY
      // supplies actual read access so omission of FILE_SHARE_DELETE prevents rename/replacement.
      var handle=LibraryFileMutationNative.CreateFileW(path,0x81,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
      if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();throw new LibrarySourceException(error is 32 or 33?"source-busy":error is 2 or 3?"source-missing":"inaccessible");}
      string identity;
      try {
        if((LibraryFileMutationNative.Stat(handle).Attr&0x410)!=0x10)throw new LibrarySourceException("invalid-source");
        identity=LibrarySourceDeletion.SourcePins.IdentityOf(handle);
      }catch{handle.Dispose();throw;}
      entry.Directories.Add((handle,identity));
    }
    if(entry.Directories[^1].Identity!=entry.Roots.Identity)throw new LibrarySourceException("source-changed");
  }
  private static string Hash(FileStream stream,CancellationToken cancellation)
  {
    using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[64*1024];int read;
    while((read=stream.Read(buffer,0,buffer.Length))!=0){cancellation.ThrowIfCancellationRequested();hash.AppendData(buffer,0,read);}
    cancellation.ThrowIfCancellationRequested();return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
  }
  public void Dispose()
  {
    if(disposed)return;disposed=true;
    for(int index=held.Count-1;index>=0;index--){var entry=held[index];entry.Leaf?.Dispose();for(int directory=entry.Directories.Count-1;directory>=0;directory--)entry.Directories[directory].Handle.Dispose();entry.Roots.Dispose();}held.Clear();
  }
}
