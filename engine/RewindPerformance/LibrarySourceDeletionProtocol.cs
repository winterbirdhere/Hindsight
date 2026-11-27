// SPDX-License-Identifier: MIT
using System.Collections.Concurrent;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace RewindPerformance;

public sealed class LibrarySourceDeletionRequest
{
  public int Version {get;set;}
  public string Operation {get;set;}="";
  public string? SourceDirectory {get;set;}
  public List<LibrarySourceDeletionSelection>? Records {get;set;}
  public List<string>? ReplaySha256s {get;set;}
  public List<string>? KnownScoreIds {get;set;}
  public LibrarySourceDeletionPlan? Plan {get;set;}
  public string? SessionToken {get;set;}
  public List<LibrarySourceReadGuardRequest>? ReadGuards {get;set;}
}
public sealed class LibrarySourceDeletionResponse
{
  public int Version {get;set;}=1;
  public bool Ok {get;set;}
  public string Status {get;set;}="invalid-source";
  public LibrarySourceDeletionPlan? Plan {get;set;}
  public LibrarySourceAssociations? Associations {get;set;}
  public string? SessionToken {get;set;}
  public string? Fingerprint {get;set;}
  public List<LibrarySourceDeletionOutcome>? Records {get;set;}
  public LibrarySourceDeletionDiagnostic? Diagnostic {get;set;}
}
public sealed record LibrarySourceDeletionOutcome(string ScoreId,string Status);

/// <summary>Dedicated owner thread preserves Realm affinity. Process deadlines also bound native cleanup.</summary>
public static class LibrarySourceDeletionProtocol
{
  public const int MaximumRequestChars=512*1024;
  public const int MaximumResponseBytes=1024*1024;
  public const int SessionMilliseconds=30_000;
  public const int AcquisitionProcessMilliseconds=5_000;

  public static Task Run(TextReader input,TextWriter output,CancellationToken cancellation=default)
    => OnOwnerThread(()=>RunOwner(input,output,cancellation,false));

  // Only use in the dedicated helper process. Realm.Dispose can wait on a competing writer even
  // after BeginWriteAsync has cancelled; terminating this process is the final admission bound.
  public static Task RunIsolatedProcess(TextReader input,TextWriter output)
    => WithProcessDeadline(()=>OnOwnerThread(()=>RunOwner(input,output,default,true)),SessionMilliseconds+2000);

  public static async Task WithProcessDeadline(Func<Task> work,int milliseconds)
  {
    using var deadline=new ProcessDeadline(milliseconds);
    await work();
  }

  public static Task OnOwnerThread(Func<Task> action)
  {
    var completion=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var thread=new Thread(()=>{
      using var context=new OwnerContext();
      SynchronizationContext.SetSynchronizationContext(context);
      async void Start() {
        try {await action();completion.TrySetResult();}
        catch(Exception error){completion.TrySetException(error);}
        finally{context.Complete();}
      }
      Start();
      context.Pump();
    }){IsBackground=true,Name="Library source deletion owner"};
    thread.Start();return completion.Task;
  }

  private static async Task RunOwner(TextReader input,TextWriter output,CancellationToken cancellation,bool isolatedProcess)
  {
    using var lifetime=CancellationTokenSource.CreateLinkedTokenSource(cancellation);
    lifetime.CancelAfter(SessionMilliseconds);
    LibrarySourceDeletionSession? session=null;
    LibrarySourceReadGuard? readGuard=null;
    LibrarySourceDeletionPlan? acquiredPlan=null;
    string? operation=null;
    try {
      for(;;) {
        var request=await Read(input,lifetime.Token);
        if(request==null)return;
        operation=request.Operation;
        // Read the request first so a failed installation cannot close stdin
        // while the caller is still sending it. No source operation precedes this.
        if(isolatedProcess)LibraryNativeNoConversionPolicy.InitializeForDeletionProcess();
        var response=new LibrarySourceDeletionResponse();
        switch(request.Operation) {
          case "guard-acquire":
            if(session!=null||readGuard!=null||request.ReadGuards==null)throw new LibrarySourceException("invalid-state");
            readGuard=LibrarySourceReadGuard.Acquire(request.ReadGuards,lifetime.Token);
            response.Ok=true;response.Status="acquired-guard";response.SessionToken=readGuard.Token;response.Fingerprint=readGuard.Fingerprint;break;
          case "guard-verify":
            if(readGuard==null||request.SessionToken!=readGuard.Token)throw new LibrarySourceException("invalid-state");
            readGuard.Verify();response.Ok=true;response.Status="verified-guard";response.SessionToken=readGuard.Token;response.Fingerprint=readGuard.Fingerprint;break;
          case "associations":
            if(session!=null||request.SourceDirectory==null||request.ReplaySha256s==null||request.KnownScoreIds==null)throw new LibrarySourceException("invalid-state");
            response.Associations=LibrarySourceDeletion.Associations(request.SourceDirectory,request.ReplaySha256s,request.KnownScoreIds,lifetime.Token);
            response.Ok=true;response.Status="associated";await Write(output,response);return;
          case "prepare":
            if(session!=null||request.SourceDirectory==null||request.Records==null)throw new LibrarySourceException("invalid-state");
            response.Plan=LibrarySourceDeletion.Prepare(request.SourceDirectory,request.Records,lifetime.Token);
            response.Ok=true;response.Status="prepared";response.Fingerprint=response.Plan.Token;
            await Write(output,response);return;
          case "reconcile":
            if(session!=null||request.Plan==null)throw new LibrarySourceException("invalid-state");
            response.Status=LibrarySourceDeletion.Reconcile(request.Plan,lifetime.Token);
            response.Ok=true;response.Fingerprint=request.Plan.Token;
            await Write(output,response);return;
          case "acquire":
            if(session!=null||request.Plan==null)throw new LibrarySourceException("invalid-state");
            readGuard?.Verify();
            using(isolatedProcess?new ProcessDeadline(AcquisitionProcessMilliseconds):null)
              session=await LibrarySourceDeletion.Acquire(request.Plan,lifetime.Token);
            acquiredPlan=request.Plan;
            response.Ok=true;response.Status="acquired";response.SessionToken=session.SessionToken;response.Fingerprint=acquiredPlan.Token;
            break;
          case "verify":
            CheckSession();readGuard?.Verify();session!.Verify();response.Ok=true;response.Status="verified";response.Fingerprint=acquiredPlan!.Token;break;
          case "commit":
            CheckSession();readGuard?.Verify();session!.Commit(lifetime.Token);response.Ok=true;response.Status="committed";response.Fingerprint=acquiredPlan!.Token;
            response.Records=acquiredPlan.Records.Select(r=>new LibrarySourceDeletionOutcome(r.ScoreId,r.WasDeletePending?"already-pending":"deleted")).ToList();
            break;
          case "abort":
          case "close":
            CheckSession();session!.Dispose();session=null;response.Ok=true;response.Status="closed";await Write(output,response);return;
          default:throw new LibrarySourceException("invalid-source");
        }
        await Write(output,response);
        void CheckSession() {
          if(session==null||request.SessionToken==null||request.SessionToken!=session.SessionToken)throw new LibrarySourceException("invalid-state");
        }
      }
    }
    catch(Exception error) {
      // After a commit starts, failure/transport loss is never represented as proof of non-commit.
      string status=session?.CommitMayHaveApplied==true?"commit-uncertain":error switch {
        LibrarySourceException e=>e.Status,
        OperationCanceledException=>cancellation.IsCancellationRequested?"cancelled":"timeout",
        FileNotFoundException or DirectoryNotFoundException=>"source-missing",
        UnauthorizedAccessException=>"inaccessible",
        IOException e when (e.HResult&0xffff) is 32 or 33=>"source-busy",
        _=>"invalid-source"
      };
      var diagnostic=status=="source-busy"?LibrarySourceDeletion.DiagnosticFor(error,operation):null;
      session?.Dispose();session=null;
      await Write(output,new(){Status=status,Fingerprint=acquiredPlan?.Token,Diagnostic=diagnostic});
    }
    finally{try{session?.Dispose();}finally{readGuard?.Dispose();}}
  }

  private static async Task<LibrarySourceDeletionRequest?> Read(TextReader input,CancellationToken cancellation)
  {
    // Console's synchronized reader can execute ReadAsync synchronously; isolate only the bounded
    // pipe read, never Realm work. The owner remains responsive to admission/lifetime cancellation.
    string? line=await Task.Run(()=>{
      var line=new StringBuilder();int c;
      while((c=input.Read())>=0&&c!='\n') {if(line.Length>=MaximumRequestChars)throw new LibrarySourceException("resource-limit");line.Append((char)c);}
      return c<0&&line.Length==0?null:line.ToString();
    },CancellationToken.None).WaitAsync(cancellation);
    if(line==null)return null;
    using var reader=new JsonTextReader(new StringReader(line)){MaxDepth=32,DateParseHandling=DateParseHandling.None};
    var value=JToken.ReadFrom(reader,new JsonLoadSettings{DuplicatePropertyNameHandling=DuplicatePropertyNameHandling.Error});
    if(reader.Read()||value is not JObject obj)throw new LibrarySourceException("invalid-source");
    var request=obj.ToObject<LibrarySourceDeletionRequest>(JsonSerializer.Create(Protocol.JsonSettings))??throw new LibrarySourceException("invalid-source");
    if(request.Operation=="guard-acquire"&&(obj["readGuards"] is not JArray guards||guards.Any(item=>item is not JObject guard||
      guard.Properties().Any(p=>!new[]{"sourceDirectory","file","expectedSha256","expectedRootIdentity","expectedDatabaseIdentity"}.Contains(p.Name,StringComparer.Ordinal)))))throw new LibrarySourceException("invalid-source");
    string[] fields=request.Operation switch {
      "associations"=>["version","operation","sourceDirectory","replaySha256s","knownScoreIds"],
      "prepare"=>["version","operation","sourceDirectory","records"],
      "acquire" or "reconcile"=>["version","operation","plan"],
      "guard-acquire"=>["version","operation","readGuards"],
      "guard-verify"=>["version","operation","sessionToken"],
      "verify" or "commit" or "abort" or "close"=>["version","operation","sessionToken"],
      _=>[]
    };
    if(request.Version!=1||fields.Length==0||obj.Properties().Any(p=>!fields.Contains(p.Name,StringComparer.Ordinal)))throw new LibrarySourceException("invalid-source");
    return request;
  }
  private static async Task Write(TextWriter output,LibrarySourceDeletionResponse response)
  {
    string body=JsonConvert.SerializeObject(response,Protocol.JsonSettings);
    if(Encoding.UTF8.GetByteCount(body)>MaximumResponseBytes)throw new LibrarySourceException("resource-limit");
    await output.WriteLineAsync(body);await output.FlushAsync();
  }
  private sealed class OwnerContext:SynchronizationContext,IDisposable
  {
    private readonly BlockingCollection<(SendOrPostCallback Callback,object? State)> queue=new();
    public override void Post(SendOrPostCallback d,object? state) {
      try{queue.Add((d,state));}catch(InvalidOperationException){/* only callbacks after operation completion */}
    }
    public void Pump(){foreach(var work in queue.GetConsumingEnumerable())work.Callback(work.State);}
    public void Complete()=>queue.CompleteAdding();
    public void Dispose()=>queue.Dispose();
  }
  private sealed class ProcessDeadline:IDisposable
  {
    private readonly ManualResetEventSlim finished=new(false);
    private readonly Thread watchdog;
    public ProcessDeadline(int milliseconds) {
      if(milliseconds<1||milliseconds>SessionMilliseconds+2000)throw new ArgumentOutOfRangeException(nameof(milliseconds));
      watchdog=new Thread(()=>{
        if(!finished.Wait(milliseconds))Environment.Exit(124);
      }){IsBackground=true,Name="Library deletion hard deadline"};
      watchdog.Start();
    }
    public void Dispose(){finished.Set();if(watchdog.Join(1000))finished.Dispose();}
  }
}
