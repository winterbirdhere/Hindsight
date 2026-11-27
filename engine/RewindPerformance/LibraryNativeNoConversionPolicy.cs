// SPDX-License-Identifier: MIT
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Realms;

namespace RewindPerformance;

/// <summary>Only the dedicated deletion process binds Realm to the qualified native fork.</summary>
internal static class LibraryNativeNoConversionPolicy
{
  private const string libraryFile="hindsight-realm-wrappers.dll";
  private const string manifestFile="hindsight-realm-policy.json";
  private static readonly object gate=new();
  private static int state; // 0: not attempted; 1: installed; 2: permanently unavailable.
  private static IntPtr module; // Retained through process teardown, including native finalizers.
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
  private delegate uint InstallPolicy(uint version,uint guarantees);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  private static extern uint GetModuleFileNameW(IntPtr handle,StringBuilder path,int length);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]
  private static extern IntPtr GetModuleHandleW(string name);

  internal static void InitializeForDeletionProcess()
  {
    lock(gate) {
      if(state==1)return;
      if(state==2)throw Unavailable();
      state=2; // An unsuccessful attempt cannot be retried after binding or first-open races.
      string phase="platform";
      try {
        if(!OperatingSystem.IsWindows()||RuntimeInformation.ProcessArchitecture!=Architecture.X64||
          typeof(Realm).Assembly.GetName().Version!=new Version(20,1,0,0))throw Unavailable();
        string directory=Path.GetFullPath(AppContext.BaseDirectory);
        phase="package-files";
        AssertOrdinary(directory);
        string library=Path.Combine(directory,libraryFile),manifest=Path.Combine(directory,manifestFile);
        AssertOrdinary(library);AssertOrdinary(manifest);
        // Retain deny-write/delete leases through hashing and module binding.
        using var metadata=new FileStream(manifest,FileMode.Open,FileAccess.Read,FileShare.Read);
        if(metadata.Length is <1 or >4096)throw Unavailable();
        using var document=JsonDocument.Parse(metadata);
        phase="manifest-contract";
        var value=document.RootElement;
        string[] names=["version","file","sha256","policyVersion","guarantees","realmDotnetVersion","realmCoreVersion","sourceSha256"];
        if(value.ValueKind!=JsonValueKind.Object)throw Unavailable();
        var properties=value.EnumerateObject().Select(p=>p.Name).ToArray();
        if(properties.Length!=names.Length||properties.Distinct(StringComparer.Ordinal).Count()!=names.Length||
          properties.Any(p=>!names.Contains(p,StringComparer.Ordinal))||
          value.GetProperty("version").GetInt32()!=1||value.GetProperty("file").GetString()!=libraryFile||
          value.GetProperty("policyVersion").GetInt32()!=1||value.GetProperty("guarantees").GetInt32()!=3||
          value.GetProperty("realmDotnetVersion").GetString()!="20.1.0"||value.GetProperty("realmCoreVersion").GetString()!="20.1.2"||
          !LibrarySourceDeletion.IsHash(value.GetProperty("sourceSha256").GetString()))throw Unavailable();
        string? expected=value.GetProperty("sha256").GetString();
        if(!LibrarySourceDeletion.IsHash(expected))throw Unavailable();
        phase="artifact-hash";
        using var binary=new FileStream(library,FileMode.Open,FileAccess.Read,FileShare.Read);
        if(binary.Length is <1 or >64*1024*1024||Convert.ToHexString(SHA256.HashData(binary)).ToLowerInvariant()!=expected)throw Unavailable();
        // A previously resolved SDK import cannot safely be rebound by registering a resolver.
        phase="prior-sdk-binding";
        if(GetModuleHandleW("realm-wrappers.dll")!=IntPtr.Zero)throw Unavailable();
        phase="module-load";
        module=NativeLibrary.Load(library);
        var loadedPath=new StringBuilder(32768);
        uint length=GetModuleFileNameW(module,loadedPath,loadedPath.Capacity);
        if(length==0||length>=loadedPath.Capacity||!string.Equals(Path.GetFullPath(loadedPath.ToString()),library,StringComparison.OrdinalIgnoreCase))throw Unavailable();
        phase="policy-install";
        var install=Marshal.GetDelegateForFunctionPointer<InstallPolicy>(NativeLibrary.GetExport(module,"shared_realm_enable_no_conversion_policy_v1"));
        if(install(1,3)!=0)throw Unavailable();
        phase="import-resolver";
        NativeLibrary.SetDllImportResolver(typeof(Realm).Assembly,(name,assembly,searchPath)=>
          name=="realm-wrappers"?module:IntPtr.Zero);
        state=1;
      }
      catch(Exception) {
        // Never fall back to the original wrapper or expose installation paths in protocol errors.
        Console.Error.WriteLine(LibrarySourceDeletion.NativeWriteHoldStatus+": Native policy initialization failed ("+phase+").");
        throw Unavailable();
      }
    }
  }

  internal static void RequireInstalled()
  {
    lock(gate)if(state!=1)throw Unavailable();
  }

  internal static LibrarySourceException Unavailable()
  {
    var error=new LibrarySourceException(LibrarySourceDeletion.NativeWriteHoldStatus);
    error.Data["reason"]=LibrarySourceDeletion.NativeWriteHoldReason;
    return error;
  }

  private static void AssertOrdinary(string path)
  {
    for(string? current=path;current!=null;current=Path.GetDirectoryName(current))
      if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0)throw Unavailable();
  }
}
