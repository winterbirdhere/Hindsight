// SPDX-License-Identifier: MIT
using System.Reflection;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RewindPerformance;

public sealed class LibraryFileMutationRequest
{
  public int Version {get;set;}
  public string Operation {get;set;}="";
  public LibraryFileAuthority? Authority {get;set;}
  public List<LibraryFileSelection>? Targets {get;set;}
  public LibraryFilePlan? Plan {get;set;}
  public string? TargetId {get;set;}
  public string? IntentId {get;set;}
  public string? SessionToken {get;set;}
  public LibraryFileCompletion? Completion {get;set;}
  public List<LibraryFileCompletionTarget>? Committed {get;set;}
  public List<string>? RemainingTargetIds {get;set;}
  public List<LibrarySourceReadGuardRequest>? ReadGuards {get;set;}
}
public sealed class LibraryFileMutationResponse
{
  public int Version {get;set;}=1;
  public bool Ok {get;set;}
  public string Status {get;set;}="invalid-source";
  public string? Fingerprint {get;set;}
  public string? SessionToken {get;set;}
  public LibraryFilePlan? Plan {get;set;}
  public LibraryFileReceipt? Receipt {get;set;}
}

/// <summary>Private main-owned pipe only. Caller holds the all-source logical mutation lease.</summary>
public static class LibraryFileMutationProtocol
{
  public const int MaximumRequestChars=256*1024,MaximumResponseBytes=512*1024;
  public static Task RunIsolatedProcess(TextReader input,TextWriter output)
    =>LibrarySourceDeletionProtocol.WithProcessDeadline(()=>RunCore(input,output,default,true),32_000);
  public static Task Run(TextReader input,TextWriter output,CancellationToken cancellation=default)
    =>RunCore(input,output,cancellation,false);
  private static async Task RunCore(TextReader input,TextWriter output,CancellationToken cancellation,bool isolated)
  {
    using var lifetime=CancellationTokenSource.CreateLinkedTokenSource(cancellation);lifetime.CancelAfter(30_000);
    LibraryFileMutationSession? session=null;LibraryFilePlan? acquired=null;LibrarySourceReadGuard? readGuard=null;bool mutationSent=false,statusOnly=false;
    try {
      while(true){var request=await Read(input,lifetime.Token);if(request==null)return;statusOnly=request.Operation is "acquire-cleanup-status" or "cleanup-status";var response=new LibraryFileMutationResponse();
        async Task Work(){await Task.Run(()=>{
          switch(request.Operation){
            case "guard-acquire":
              Require(session==null&&readGuard==null&&request.ReadGuards!=null);readGuard=LibrarySourceReadGuard.Acquire(request.ReadGuards!,lifetime.Token);response.SessionToken=readGuard.Token;response.Fingerprint=readGuard.Fingerprint;response.Status="acquired-guard";break;
            case "guard-verify":
              Require(readGuard!=null&&request.SessionToken==readGuard.Token);readGuard!.Verify();response.SessionToken=readGuard.Token;response.Fingerprint=readGuard.Fingerprint;response.Status="verified-guard";break;
            case "prepare":
              Require(session==null&&request.Authority!=null&&request.Targets!=null);response.Plan=LibraryFileMutation.Prepare(request.Authority!,request.Targets!,lifetime.Token);response.Fingerprint=response.Plan.Fingerprint;response.Status="prepared";break;
            case "acquire":
              Require(session==null&&request.Plan!=null&&request.IntentId!=null);readGuard?.Verify();acquired=request.Plan;mutationSent=true;session=LibraryFileMutation.Acquire(request.Plan!,request.IntentId!,lifetime.Token);response.SessionToken=session.SessionToken;response.Fingerprint=acquired!.Fingerprint;response.Status="acquired";break;
            case "acquire-continuation":
              Require(session==null&&request.Plan!=null&&request.IntentId!=null&&request.Committed!=null&&request.RemainingTargetIds!=null);readGuard?.Verify();acquired=request.Plan;session=LibraryFileMutation.AcquireContinuation(request.Plan!,request.IntentId!,request.Committed!,request.RemainingTargetIds!,lifetime.Token);response.SessionToken=session.SessionToken;response.Fingerprint=acquired!.Fingerprint;response.Status="acquired";break;
            case "verify":
              CheckSession();Require(request.TargetId!=null);readGuard?.Verify();session!.Verify(request.TargetId!);response.Fingerprint=acquired!.Fingerprint;response.Status="verified";break;
            case "commit":
              CheckSession();Require(request.TargetId!=null&&request.IntentId!=null);readGuard?.Verify();mutationSent=true;response.Receipt=session!.Commit(request.TargetId!,request.IntentId!);response.Fingerprint=response.Receipt.Fingerprint;response.Status=response.Receipt.State;break;
            case "reconcile":
            case "rollback":
              Require(session==null&&request.Plan!=null&&request.TargetId!=null&&request.IntentId!=null);mutationSent=request.Operation=="rollback";response.Receipt=LibraryFileMutation.Reconcile(request.Plan!,request.TargetId!,request.IntentId!,mutationSent,lifetime.Token);response.Fingerprint=response.Receipt.Fingerprint;response.Status=response.Receipt.State;break;
            case "discard":
              Require(session==null&&request.Plan!=null);mutationSent=true;response.Receipt=LibraryFileMutation.Discard(request.Plan!,lifetime.Token);response.Fingerprint=response.Receipt.Fingerprint;response.Status=response.Receipt.State;break;
            case "finalize":
            case "cleanup-status":
              Require(session==null&&request.Plan!=null&&request.IntentId!=null&&request.Completion!=null);mutationSent=!statusOnly;response.Receipt=LibraryFileMutation.FinalizeCompleted(request.Plan!,request.IntentId!,request.Completion!,lifetime.Token,statusOnly);response.Fingerprint=response.Receipt.Fingerprint;response.Status=response.Receipt.State;break;
            case "acquire-cleanup-status":
            case "abort-acquire":
              Require(session==null&&request.Plan!=null&&request.IntentId!=null);mutationSent=!statusOnly;response.Receipt=LibraryFileMutation.AcquisitionCleanup(request.Plan!,request.IntentId!,!statusOnly,lifetime.Token);response.Fingerprint=response.Receipt.Fingerprint;response.Status=response.Receipt.State;break;
            case "abort":
            case "close":
              CheckSession();if(request.Operation=="abort"||!session!.HasCommitted)session!.Abort();session!.Dispose();session=null;response.Status="closed";break;
            default:throw new LibrarySourceException("invalid-source");
          }
          response.Ok=true;
        },CancellationToken.None);}
        if(isolated)await LibrarySourceDeletionProtocol.WithProcessDeadline(Work,5000);else await Work();
        await Write(output,response);
        if(request.Operation is "prepare" or "reconcile" or "rollback" or "abort" or "close" or "discard" or "finalize" or "cleanup-status" or "acquire-cleanup-status" or "abort-acquire")return;
        void CheckSession()=>Require(session!=null&&request.SessionToken!=null&&request.SessionToken==session.SessionToken);
      }
    }
    catch(Exception error){string reason=error switch{LibrarySourceException e=>e.Status,OperationCanceledException or TimeoutException=>"timeout",System.ComponentModel.Win32Exception e when e.NativeErrorCode is 32 or 33=>"source-busy",UnauthorizedAccessException=>"inaccessible",_=>"invalid-source"};string status=statusOnly?"conflict":mutationSent?"recovery-required":reason;session?.Dispose();session=null;await Write(output,new(){Ok=statusOnly,Status=status,Fingerprint=acquired?.Fingerprint,Receipt=statusOnly?new("conflict",LibraryFileMutation.Hash(new{status,reason}),null,reason):null});}
    finally{try{session?.Dispose();}finally{readGuard?.Dispose();}}
  }
  private static void Require(bool value){if(!value)throw new LibrarySourceException("invalid-state");}
  private static async Task<LibraryFileMutationRequest?> Read(TextReader input,CancellationToken cancellation)
  {
    string? line=await Task.Run(()=>{var b=new StringBuilder();int c;while((c=input.Read())>=0&&c!='\n'){if(b.Length>=MaximumRequestChars)throw new LibrarySourceException("resource-limit");b.Append((char)c);}return c<0&&b.Length==0?null:b.ToString();},CancellationToken.None).WaitAsync(cancellation);
    if(line==null)return null;
    using var reader=new JsonTextReader(new StringReader(line)){MaxDepth=24,DateParseHandling=DateParseHandling.None};var token=JToken.ReadFrom(reader,new JsonLoadSettings{DuplicatePropertyNameHandling=DuplicatePropertyNameHandling.Error});if(reader.Read()||token is not JObject obj)throw new LibrarySourceException("invalid-source");
    Shape(obj,typeof(LibraryFileMutationRequest));var request=obj.ToObject<LibraryFileMutationRequest>(JsonSerializer.Create(Protocol.JsonSettings))??throw new LibrarySourceException("invalid-source");
    string[] fields=request.Operation switch{"guard-acquire"=>["version","operation","readGuards"],"guard-verify"=>["version","operation","sessionToken"],"prepare"=>["version","operation","authority","targets"],"discard"=>["version","operation","plan"],"acquire" or "acquire-cleanup-status" or "abort-acquire"=>["version","operation","plan","intentId"],"acquire-continuation"=>["version","operation","plan","intentId","committed","remainingTargetIds"],"verify"=>["version","operation","sessionToken","targetId"],"commit"=>["version","operation","sessionToken","targetId","intentId"],"reconcile" or "rollback"=>["version","operation","plan","targetId","intentId"],"finalize" or "cleanup-status"=>["version","operation","plan","intentId","completion"],"abort" or "close"=>["version","operation","sessionToken"],_=>[]};
    if(request.Version!=1||fields.Length==0||obj.Properties().Any(p=>!fields.Contains(p.Name,StringComparer.Ordinal))||fields.Any(f=>obj[f]==null||obj[f]!.Type==JTokenType.Null))throw new LibrarySourceException("invalid-source");return request;
  }
  private static void Shape(JToken token,Type type)
  {
    if(token.Type==JTokenType.Null)return;
    if(type==typeof(string)){if(token.Type!=JTokenType.String)throw new LibrarySourceException("invalid-source");return;}
    if(type==typeof(int)||type==typeof(long)||type==typeof(uint)){if(token.Type!=JTokenType.Integer)throw new LibrarySourceException("invalid-source");return;}
    if(type.IsGenericType&&(type.GetGenericTypeDefinition()==typeof(IReadOnlyList<>)||type.GetGenericTypeDefinition()==typeof(List<>))){int maximum=type.GenericTypeArguments[0]==typeof(LibrarySourceReadGuardRequest)?128:LibraryFileMutation.MaximumTargets;if(token is not JArray list||list.Count>maximum)throw new LibrarySourceException("resource-limit");foreach(var item in list)Shape(item,type.GenericTypeArguments[0]);return;}
    if(token is not JObject obj)throw new LibrarySourceException("invalid-source");var properties=type.GetProperties(BindingFlags.Instance|BindingFlags.Public).ToDictionary(p=>char.ToLowerInvariant(p.Name[0])+p.Name[1..],StringComparer.Ordinal);foreach(var p in obj.Properties()){if(!properties.TryGetValue(p.Name,out var property))throw new LibrarySourceException("invalid-source");Shape(p.Value,property.PropertyType);}
  }
  private static async Task Write(TextWriter output,LibraryFileMutationResponse response){string text=JsonConvert.SerializeObject(response,Protocol.JsonSettings);if(Encoding.UTF8.GetByteCount(text)>MaximumResponseBytes)throw new LibrarySourceException("resource-limit");await output.WriteLineAsync(text);await output.FlushAsync();}
}
