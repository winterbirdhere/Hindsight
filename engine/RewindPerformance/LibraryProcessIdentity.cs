// SPDX-License-Identifier: MIT
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RewindPerformance;

public sealed record LibraryProcessIdentityResult(int Version,bool Ok,string Status,string State,uint? Pid,string? CreationTime100ns,int? ErrorCode);

/// <summary>Read-only private main-owned probe. No termination, token adjustment or process enumeration.</summary>
public static class LibraryProcessIdentity
{
  private const uint QueryLimitedAndSynchronize=0x00101000;
  private const uint WaitObject=0,WaitTimeout=258;
  [StructLayout(LayoutKind.Sequential)] private struct FileTime {public uint Low,High;public readonly ulong Value=>((ulong)High<<32)|Low;}
  [DllImport("kernel32.dll",SetLastError=true)] private static extern SafeProcessHandle OpenProcess(uint access,[MarshalAs(UnmanagedType.Bool)]bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] private static extern uint GetProcessId(SafeProcessHandle handle);
  [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetProcessTimes(SafeProcessHandle handle,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",SetLastError=true)] private static extern uint WaitForSingleObject(SafeProcessHandle handle,uint milliseconds);

  public static LibraryProcessIdentityResult Inspect(uint pid)
  {
    if(pid==0)throw new ArgumentOutOfRangeException(nameof(pid));
    if(!OperatingSystem.IsWindows())return Classify(pid,false,50,0,50,uint.MaxValue);
    using var handle=OpenProcess(QueryLimitedAndSynchronize,false,pid);
    if(handle.IsInvalid)return Classify(pid,false,Marshal.GetLastWin32Error(),0,0,uint.MaxValue);
    return Query(pid,handle);
  }
  private static LibraryProcessIdentityResult Query(uint pid,SafeProcessHandle handle)
  {
    if(handle.IsClosed||handle.IsInvalid)return Classify(pid,true,0,0,6,uint.MaxValue);
    uint actual=GetProcessId(handle);if(actual!=pid)return Classify(pid,true,0,0,actual==0?Marshal.GetLastWin32Error():87,uint.MaxValue);
    if(!GetProcessTimes(handle,out var created,out _,out _,out _))return Classify(pid,true,0,0,Marshal.GetLastWin32Error(),uint.MaxValue);
    uint wait=WaitForSingleObject(handle,0);int error=wait==uint.MaxValue?Marshal.GetLastWin32Error():0;
    return Classify(pid,true,0,created.Value,error,wait);
  }
  // Pure classification also permits labeled synthetic failure/reuse checks without probing foreign PIDs.
  private static LibraryProcessIdentityResult Classify(uint pid,bool opened,int openError,ulong creation,int queryError,uint wait)
  {
    if(pid==0)throw new ArgumentOutOfRangeException(nameof(pid));
    if(!opened)return new(1,true,"inspected",openError==87?"absent":"unknown",pid,null,openError);
    string? birth=creation>0?creation.ToString(CultureInfo.InvariantCulture):null;
    if(queryError!=0||birth==null||wait is not (WaitObject or WaitTimeout))return new(1,true,"inspected","unknown",pid,birth,queryError==0?null:queryError);
    return new(1,true,"inspected",wait==WaitObject?"exited":"alive",pid,birth,null);
  }
  public static Task RunIsolatedProcess(TextReader input,TextWriter output)
    =>LibrarySourceDeletionProtocol.WithProcessDeadline(()=>Run(input,output),5000);
  public static async Task Run(TextReader input,TextWriter output)
  {
    LibraryProcessIdentityResult result;
    try{
      string text=await Task.Run(()=>{var b=new StringBuilder();int c;while((c=input.Read())>=0&&c!='\n'){if(b.Length>=4096)throw new InvalidDataException("Request cap");b.Append((char)c);}return b.ToString();}).WaitAsync(TimeSpan.FromSeconds(2));
      using var reader=new JsonTextReader(new StringReader(text)){MaxDepth=4,DateParseHandling=DateParseHandling.None};
      var token=JToken.ReadFrom(reader,new JsonLoadSettings{DuplicatePropertyNameHandling=DuplicatePropertyNameHandling.Error});
      if(reader.Read()||token is not JObject obj||obj.Properties().Count()!=3||obj["version"]?.Type!=JTokenType.Integer||obj["version"]!.Value<long>()!=1||obj["operation"]?.Type!=JTokenType.String||obj["operation"]!.Value<string>()!="inspect"||obj["pid"]?.Type!=JTokenType.Integer)throw new InvalidDataException("Request shape");
      ulong pid=obj["pid"]!.Value<ulong>();if(pid is 0 or >uint.MaxValue)throw new InvalidDataException("PID bounds");
      result=Inspect((uint)pid);
    }catch(Exception error)when(error is JsonException or InvalidDataException or OverflowException or ArgumentException or FormatException){result=new(1,false,"invalid-request","unknown",null,null,null);}
    catch(TimeoutException){result=new(1,false,"timeout","unknown",null,null,null);}
    catch(Exception){result=new(1,false,"query-failed","unknown",null,null,null);}
    string response=JsonConvert.SerializeObject(result,Protocol.JsonSettings);if(Encoding.UTF8.GetByteCount(response)>1024)throw new InvalidDataException("Response cap");await output.WriteLineAsync(response);await output.FlushAsync();
  }
}
