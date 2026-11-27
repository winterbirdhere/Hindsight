// SPDX-License-Identifier: MIT
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json;

namespace RewindPerformance;
public sealed record LibraryFileSource(string Id,string Directory);
public sealed record LibraryFileAuthority(string AppDirectory,IReadOnlyList<LibraryFileSource> Sources);
public sealed record LibraryFileStage(string RelativePath,long Bytes,string Sha256);
public sealed record LibraryFileSelection(string Id,string SourceId,string RelativePath,LibraryFileStage? Staged=null);
public sealed record LibraryFileRoot(string Directory,string Identity);
public sealed record LibraryFileIdentity(string Identity,long Bytes,string Sha256,string WriteTime,uint Attributes,string SecurityHash);
public sealed record LibraryFileTarget(string Id,string SourceId,string RelativePath,string ParentIdentity,LibraryFileIdentity Before,LibraryFileStage? Staged,LibraryFileIdentity? StageIdentity);
public sealed record LibraryFilePlan(int Version,string Nonce,LibraryFileRoot App,IReadOnlyList<LibraryFileSource> Sources,IReadOnlyList<LibraryFileRoot> Roots,IReadOnlyList<LibraryFileTarget> Targets,string Fingerprint);
public sealed record LibraryFileEvidence(string RootIdentity,string RelativePath,string QuarantineName,LibraryFileIdentity Before,LibraryFileIdentity? Installed,string? RetainedAfterName);
public sealed record LibraryFileReceipt(string State,string Fingerprint,LibraryFileEvidence? Evidence=null,string? Detail=null);
public sealed record LibraryFileCompletionTarget(string Id,string Fingerprint);
public sealed record LibraryFileCompletion(string IntentId,string PlanFingerprint,long Revision,string MarkerSha256,IReadOnlyList<LibraryFileCompletionTarget> Targets);

/// <summary>Ordinary-user, held-handle operations. Called only by the main-owned mutation broker.</summary>
public static class LibraryFileMutation
{
  public const int MaximumFileBytes=64*1024*1024,MaximumBatchBytes=128*1024*1024,MaximumPlanBytes=128*1024,MaximumTargets=32;
  internal static readonly Regex Hex=new("^[a-f0-9]{64}$",RegexOptions.CultureInvariant);
  internal static string Serialize(object value)=>JsonConvert.SerializeObject(value,Protocol.JsonSettings);
  internal static string Hash(object value)=>LibraryFileMutationNative.Hash(Encoding.UTF8.GetBytes(Serialize(value)));
  internal static void Fail(bool good,string message){if(!good)throw new LibrarySourceException(message);}
  internal static string[] Segments(string relative){Fail(!string.IsNullOrWhiteSpace(relative)&&relative.Length<=1024&&!Path.IsPathRooted(relative),"invalid-source");var names=relative.Replace('/','\\').Split('\\');Fail(names.Length is >=1 and <=16,"resource-limit");foreach(var n in names)LibraryFileMutationNative.Leaf(n);return names;}
  internal static void Identifier(string value)=>Fail(value!=null&&Regex.IsMatch(value,"^[a-zA-Z0-9:_-]{1,128}$",RegexOptions.CultureInvariant),"invalid-source");
  internal static string Fingerprint(LibraryFilePlan p)=>Hash(new{p.Version,p.Nonce,p.App,p.Sources,p.Roots,p.Targets});
  internal static void Validate(LibraryFilePlan p){Fail(p.Version==1&&Regex.IsMatch(p.Nonce??"","^[a-f0-9]{32}$")&&p.Targets.Count is >0 and <=MaximumTargets&&p.Sources.Count is >0 and <=MaximumTargets&&p.Roots.Count==p.Sources.Count&&p.Targets.Select(t=>t.Id).Distinct(StringComparer.Ordinal).Count()==p.Targets.Count&&p.Sources.Select(s=>s.Id).Distinct(StringComparer.Ordinal).Count()==p.Sources.Count,"invalid-source");Fail(Fingerprint(p)==p.Fingerprint&&Encoding.UTF8.GetByteCount(Serialize(p))<=MaximumPlanBytes,"source-changed");long bytes=0;foreach(var t in p.Targets){Identifier(t.Id);Identifier(t.SourceId);Segments(t.RelativePath);Fail(p.Sources.Any(s=>s.Id==t.SourceId),"invalid-source");ValidateIdentity(t.Before);bytes=checked(bytes+t.Before.Bytes);if(t.Staged!=null){ValidateStage(t.Staged);Fail(t.StageIdentity!=null,"invalid-source");ValidateIdentity(t.StageIdentity!);Fail(t.StageIdentity!.Sha256==t.Staged.Sha256&&t.StageIdentity.Bytes==t.Staged.Bytes&&t.StageIdentity.Identity!=t.Before.Identity,"source-changed");bytes=checked(bytes+t.Staged.Bytes);}else Fail(t.StageIdentity==null,"invalid-source");}Fail(bytes<=MaximumBatchBytes,"resource-limit");var originals=p.Targets.Select(t=>t.Before.Identity).ToHashSet(StringComparer.Ordinal);Fail(p.Targets.Where(t=>t.StageIdentity!=null).All(t=>!originals.Contains(t.StageIdentity!.Identity)),"ambiguous-target");}
  internal static void ValidateIdentity(LibraryFileIdentity i)=>Fail(i!=null&&Regex.IsMatch(i.Identity??"","^[a-f0-9]{8}:[a-f0-9]{16}$")&&i.Bytes is >=0 and <=MaximumFileBytes&&Hex.IsMatch(i.Sha256??"")&&Hex.IsMatch(i.SecurityHash??"")&&long.TryParse(i.WriteTime,out _),"invalid-source");
  internal static void ValidateStage(LibraryFileStage s){var parts=Segments(s.RelativePath);Fail(parts.Length>=2&&parts[0]=="library-deletion-stage"&&s.Bytes is >=0 and <=MaximumFileBytes&&Hex.IsMatch(s.Sha256??""),"invalid-source");}
  public static LibraryFilePlan Prepare(LibraryFileAuthority authority,IReadOnlyList<LibraryFileSelection> targets,CancellationToken cancellation=default)
  {
    Fail(OperatingSystem.IsWindows(),"unsupported-source");Fail(authority.Sources.Count is >0 and <=MaximumTargets&&targets.Count is >0 and <=MaximumTargets,"resource-limit");
    var budget=new FileMutationBudget(cancellation);using var app=FileMutationDirectory.Open(authority.AppDirectory,null,budget);var roots=new List<LibraryFileRoot>();var selections=new List<LibraryFileTarget>();
    foreach(var source in authority.Sources){Identifier(source.Id);using var root=FileMutationDirectory.Open(source.Directory,null,budget);roots.Add(new(root.Path,root.Identity));}
    foreach(var t in targets){Identifier(t.Id);Identifier(t.SourceId);int index=authority.Sources.ToList().FindIndex(s=>s.Id==t.SourceId);Fail(index>=0,"invalid-source");using var source=FileMutationDirectory.Open(roots[index].Directory,roots[index].Identity,budget);using var parent=source.Parent(t.RelativePath);using var file=parent.Directory.File(parent.Leaf);LibraryFileIdentity? stageId=null;if(t.Staged!=null){ValidateStage(t.Staged);using var sp=app.Parent(t.Staged.RelativePath);using var staged=sp.Directory.File(sp.Leaf);stageId=staged.Snapshot();Fail(stageId.Bytes==t.Staged.Bytes&&stageId.Sha256==t.Staged.Sha256,"source-changed");}selections.Add(new(t.Id,t.SourceId,t.RelativePath,parent.Directory.Identity,file.Snapshot(),t.Staged,stageId));}
    var sources=authority.Sources.Select((s,i)=>s with{Directory=roots[i].Directory}).ToArray();var plan=new LibraryFilePlan(1,Guid.NewGuid().ToString("N"),new(app.Path,app.Identity),sources,roots,selections.OrderBy(t=>t.Id,StringComparer.Ordinal).ToArray(),"");plan=plan with{Fingerprint=Fingerprint(plan)};Validate(plan);budget.Check();return plan;
  }
  public static LibraryFileMutationSession Acquire(LibraryFilePlan plan,string intentId,CancellationToken cancellation=default)=>new(plan,intentId,cancellation);
  public static LibraryFileMutationSession AcquireContinuation(LibraryFilePlan plan,string intentId,IReadOnlyList<LibraryFileCompletionTarget> committed,IReadOnlyList<string> remainingTargetIds,CancellationToken cancellation=default)=>new(plan,intentId,committed,remainingTargetIds,cancellation);
  internal static bool RequiresClosedStableClient(LibraryFilePlan plan)=>plan.Targets.Any(target=>{
    if(target.Staged==null)return false;var parts=Segments(target.RelativePath);
    return parts.Length==1&&string.Equals(parts[0],"scores.db",StringComparison.OrdinalIgnoreCase);
  });
  internal static void RequireClosedStableClient(LibraryFilePlan plan,LibraryClientProcessAdmission admission){if(RequiresClosedStableClient(plan))admission.RequireClosed();}
  public static LibraryFileReceipt Discard(LibraryFilePlan plan,CancellationToken cancellation=default)
  {
    Validate(plan);var budget=new FileMutationBudget(cancellation);using var app=FileMutationDirectory.Open(plan.App.Directory,plan.App.Identity,budget);var owned=new List<IDisposable>();var remove=new List<FileMutationFile>();try{HoldAppStages(plan,app,owned,remove,false);foreach(var file in remove)file.Erase();budget.Check();return new("discarded",Hash(new{plan.Fingerprint,state="discarded"}));}finally{for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();}
  }
  public static LibraryFileReceipt AcquisitionCleanup(LibraryFilePlan plan,string intentId,bool clean=false,CancellationToken cancellation=default)
  {
    Validate(plan);Fail(Guid.TryParseExact(intentId,"D",out _),"invalid-source");var budget=new FileMutationBudget(cancellation);using var roots=new FileMutationRoots(plan,budget);var owned=new List<IDisposable>();var remove=new List<FileMutationFile>();FileMutationPath? journal=null;bool abortBegun=false;
    try{
      try{journal=roots.App.Descend(["library-deletion-journal",plan.Nonce],false);}catch(Win32Exception e)when(e.NativeErrorCode is 2 or 3){}
      if(journal!=null){owned.Add(journal);owned.Add(journal.Directory.File("session.lock"));using(var h=journal.Directory.File("plan.json"))Fail(Encoding.UTF8.GetString(h.Read(MaximumPlanBytes))==Serialize(plan),"journal-conflict");using(var h=journal.Directory.File("acquire.json"))Fail(Encoding.UTF8.GetString(h.Read(4096))==Serialize(new{intentId,planFingerprint=plan.Fingerprint}),"journal-conflict");using(var h=journal.Directory.Maybe("finalize.json"))Fail(h==null,"invalid-state");using(var h=journal.Directory.Maybe("acquire-abort.json")){abortBegun=h!=null;if(h!=null)Fail(Encoding.UTF8.GetString(h.Read(4096))==Serialize(new{intentId,planFingerprint=plan.Fingerprint}),"journal-conflict");}}
      var groups=Groups(plan);for(int slot=0;slot<groups.Count;slot++){
        var t=groups[slot][0];var parent=roots.Parent(t);owned.Add(parent);var source=parent.Directory.File(parent.Leaf);owned.Add(source);source.Expect(t.Before);
        using(var old=parent.Directory.Maybe(Old(plan,slot)))Fail(old==null,"recovery-conflict");using(var reverted=parent.Directory.Maybe(Reverted(plan,slot)))Fail(reverted==null,"recovery-conflict");
        if(journal!=null){using var start=journal.Directory.Maybe($"start-{slot:D3}.json");Fail(start==null,"invalid-state");}
        var local=parent.Directory.Maybe(New(plan,slot));if(local==null)continue;owned.Add(local);Fail(journal!=null&&t.Staged!=null,"recovery-conflict");
        using var createdFile=journal!.Directory.File($"created-{slot:D3}.json");var created=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(createdFile.Read(4096)),Protocol.JsonSettings);ValidateIdentity(created!);Fail(created!.Bytes==0&&created.Sha256==LibraryFileMutationNative.Hash([])&&created.SecurityHash==t.Before.SecurityHash,"journal-conflict");var actual=local.Snapshot();Fail(actual.Identity==created.Identity&&actual.Attributes==created.Attributes&&actual.SecurityHash==created.SecurityHash,"recovery-conflict");
        using var prepared=journal.Directory.Maybe($"prepared-{slot:D3}.json");if(prepared!=null){var after=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(prepared.Read(4096)),Protocol.JsonSettings);ValidateIdentity(after!);Fail(after!.Identity==created.Identity&&after.Bytes==t.Staged!.Bytes&&after.Sha256==t.Staged.Sha256&&actual==after,"recovery-conflict");}
        else if(actual.Bytes==0)Fail(actual==created,"recovery-conflict");
        else {using var inputParent=roots.App.Parent(t.Staged!.RelativePath);using var input=inputParent.Directory.File(inputParent.Leaf);input.Expect(t.StageIdentity!);byte[] expected=input.Read(MaximumFileBytes),partial=local.Read(MaximumFileBytes);Fail(partial.Length<=expected.Length&&partial.AsSpan().SequenceEqual(expected.AsSpan(0,partial.Length)),"recovery-conflict");input.Expect(t.StageIdentity!);}
        remove.Add(local);
      }
      if(journal==null){HoldAppStages(plan,roots.App,owned,remove,true);if(clean)foreach(var file in remove)file.Erase();budget.Check();string state=clean?"aborted":remove.Count==0?"clean":"required";return new(state,Hash(new{plan.Fingerprint,intentId,state}),null,"not-acquired");}
      HoldAppStages(plan,roots.App,owned,remove,abortBegun);
      using(var done=journal.Directory.Maybe("acquire-aborted.json")){if(done!=null)Fail(Encoding.UTF8.GetString(done.Read(4096))==Serialize(new{intentId,planFingerprint=plan.Fingerprint}),"journal-conflict");if(!clean){budget.Check();string state=abortBegun&&done!=null&&remove.Count==0?"clean":"required";return new(state,Hash(new{plan.Fingerprint,intentId,state}));}}
      if(!abortBegun)journal.Directory.WriteNew("acquire-abort.json",new{intentId,planFingerprint=plan.Fingerprint});foreach(var file in remove)file.Erase();using(var done=journal.Directory.Maybe("acquire-aborted.json")){if(done==null)journal.Directory.WriteNew("acquire-aborted.json",new{intentId,planFingerprint=plan.Fingerprint});}budget.Check();return new("aborted",Hash(new{plan.Fingerprint,intentId,state="aborted"}));
    }finally{for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();}
  }
  // The completion is supplied only by the main owner after its durable metadata finalization.
  // It is not renderer authority and the native helper does not open the app SQLite database.
  public static LibraryFileReceipt CleanupStatus(LibraryFilePlan plan,string intentId,LibraryFileCompletion completion,CancellationToken cancellation=default)=>FinalizeCompleted(plan,intentId,completion,cancellation,true);
  public static LibraryFileReceipt FinalizeCompleted(LibraryFilePlan plan,string intentId,LibraryFileCompletion completion,CancellationToken cancellation=default,bool inspectOnly=false)
  {
    Validate(plan);Fail(Guid.TryParseExact(intentId,"D",out _)&&completion.IntentId==intentId&&completion.PlanFingerprint==plan.Fingerprint&&completion.Revision>0&&Hex.IsMatch(completion.MarkerSha256??"")&&completion.Targets.Count==plan.Targets.Count&&completion.Targets.Select(t=>t.Id).Distinct(StringComparer.Ordinal).Count()==plan.Targets.Count,"invalid-completion");
    var budget=new FileMutationBudget(cancellation);using var roots=new FileMutationRoots(plan,budget);using var journal=roots.App.Descend(["library-deletion-journal",plan.Nonce],false);using var gate=journal.Directory.File("session.lock");using(var header=journal.Directory.File("plan.json"))Fail(Encoding.UTF8.GetString(header.Read(MaximumPlanBytes))==Serialize(plan),"journal-conflict");
    bool begun;using(var marker=journal.Directory.Maybe("finalize.json")){begun=marker!=null;if(marker!=null)Fail(Encoding.UTF8.GetString(marker.Read(MaximumPlanBytes))==Serialize(completion),"journal-conflict");}
    var owned=new List<IDisposable>();var remove=new List<FileMutationFile>();
    try {
      var groups=Groups(plan);for(int slot=0;slot<groups.Count;slot++){
        var g=groups[slot];var t=g[0];var parent=roots.Parent(t);owned.Add(parent);var source=parent.Directory.Maybe(parent.Leaf);if(source!=null)owned.Add(source);var old=parent.Directory.Maybe(Old(plan,slot));if(old!=null)owned.Add(old);
        using(var start=journal.Directory.File($"start-{slot:D3}.json"))Fail(Encoding.UTF8.GetString(start.Read(4096))==Serialize(new{intentId,targetIds=g.Select(x=>x.Id).ToArray(),planFingerprint=plan.Fingerprint}),"journal-conflict");
        LibraryFileIdentity? after=null;if(t.Staged!=null){using var prepared=journal.Directory.File($"prepared-{slot:D3}.json");after=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(prepared.Read(4096)),Protocol.JsonSettings);Fail(after!=null&&source!=null&&source.Snapshot()==after&&after.Sha256==t.Staged.Sha256&&after.Bytes==t.Staged.Bytes,"recovery-conflict");}else Fail(source==null,"recovery-conflict");
        foreach(var alias in g)Fail(completion.Targets.SingleOrDefault(x=>x.Id==alias.Id)?.Fingerprint==Receipt("committed",plan,alias,Old(plan,slot),after,null).Fingerprint,"invalid-completion");
        if(old!=null){old.Expect(t.Before);remove.Add(old);}else Fail(begun,"recovery-required");
        using(var pending=parent.Directory.Maybe(New(plan,slot)))Fail(pending==null,"recovery-conflict");using(var reverted=parent.Directory.Maybe(Reverted(plan,slot)))Fail(reverted==null,"recovery-conflict");
      }
      HoldAppStages(plan,roots.App,owned,remove,begun);
      using(var done=journal.Directory.Maybe("finalized.json")){if(done!=null)Fail(Encoding.UTF8.GetString(done.Read(4096))==Serialize(new{intentId,planFingerprint=plan.Fingerprint,completionHash=Hash(completion)}),"journal-conflict");if(inspectOnly){budget.Check();string state=begun&&done!=null&&remove.Count==0?"clean":"required";return new(state,Hash(new{plan.Fingerprint,intentId,completionHash=Hash(completion),state}));}}
      if(!begun)journal.Directory.WriteNew("finalize.json",completion);
      foreach(var file in remove)file.Erase();
      using(var done=journal.Directory.Maybe("finalized.json")){if(done==null)journal.Directory.WriteNew("finalized.json",new{intentId,planFingerprint=plan.Fingerprint,completionHash=Hash(completion)});}
      budget.Check();return new("finalized",Hash(new{plan.Fingerprint,intentId,completionHash=Hash(completion)}));
    }finally{for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();}
  }
  internal static void HoldAppStages(LibraryFilePlan plan,FileMutationDirectory app,List<IDisposable> owned,List<FileMutationFile> remove,bool allowMissing)
  {
    foreach(var t in plan.Targets.Where(t=>t.Staged!=null).GroupBy(t=>t.StageIdentity!.Identity,StringComparer.Ordinal).Select(g=>g.First())){
      FileMutationPath parent;try{parent=app.Parent(t.Staged!.RelativePath);}catch(Win32Exception e)when(allowMissing&&e.NativeErrorCode is 2 or 3){continue;}owned.Add(parent);var file=parent.Directory.Maybe(parent.Leaf);if(file==null){Fail(allowMissing,"stage-missing");continue;}owned.Add(file);file.Expect(t.StageIdentity!);remove.Add(file);
    }
  }
  public static LibraryFileReceipt Reconcile(LibraryFilePlan plan,string targetId,string intentId,bool rollback=false,CancellationToken cancellation=default)
    =>Reconcile(plan,targetId,intentId,rollback,cancellation,LibraryClientProcessAdmission.Default);
  internal static LibraryFileReceipt Reconcile(LibraryFilePlan plan,string targetId,string intentId,bool rollback,CancellationToken cancellation,LibraryClientProcessAdmission admission)
  {
    Validate(plan);Fail(Guid.TryParseExact(intentId,"D",out _),"invalid-source");var target=plan.Targets.SingleOrDefault(t=>t.Id==targetId);Fail(target!=null,"invalid-source");cancellation.ThrowIfCancellationRequested();if(rollback)RequireClosedStableClient(plan,admission);var budget=new FileMutationBudget(cancellation);using var roots=new FileMutationRoots(plan,budget);FileMutationPath journalPath;
    try{journalPath=roots.App.Descend(["library-deletion-journal",plan.Nonce],false);}catch(Win32Exception e)when(e.NativeErrorCode is 2 or 3){using var untouched=roots.Parent(target!);using var current=untouched.Directory.Maybe(untouched.Leaf);return new(current!=null&&current.Snapshot()==target!.Before?"unchanged":"conflict",Hash(new{plan.Fingerprint,targetId,state="no-journal"}),null,"no-journal");}
    using var journal=journalPath;using var gate=journal.Directory.File("session.lock",3,LibraryFileMutationNative.Read|LibraryFileMutationNative.Write|LibraryFileMutationNative.Delete);
    using(var header=journal.Directory.File("plan.json")){Fail(Encoding.UTF8.GetString(header.Read(MaximumPlanBytes))==Serialize(plan),"journal-conflict");}
    int slot=Groups(plan).FindIndex(g=>g.Any(t=>t.Id==targetId));string oldName=Old(plan,slot),newName=New(plan,slot),reverted=Reverted(plan,slot);using var parent=roots.Parent(target!);using var source=parent.Directory.Maybe(parent.Leaf);using var original=parent.Directory.Maybe(oldName);using var start=journal.Directory.Maybe($"start-{slot:D3}.json");
    if(source!=null&&source.Snapshot()==target!.Before&&original==null)return Receipt("unchanged",plan,target!,oldName,null,null);
    Fail(start!=null&&Encoding.UTF8.GetString(start.Read(4096))==Serialize(new{intentId,targetIds=Groups(plan)[slot].Select(t=>t.Id).ToArray(),planFingerprint=plan.Fingerprint}),"recovery-required");
    LibraryFileIdentity? after=null;using(var prepared=journal.Directory.Maybe($"prepared-{slot:D3}.json")){if(target!.Staged!=null){Fail(prepared!=null,"recovery-required");after=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(prepared!.Read(4096)),Protocol.JsonSettings);Fail(after!=null&&after.Sha256==target.Staged.Sha256&&after.Bytes==target.Staged.Bytes,"recovery-required");ValidateIdentity(after!);}}
    if(original==null){using var marker=journal.Directory.Maybe("finalize.json");Fail(marker!=null&&!rollback,"recovery-required");var completion=JsonConvert.DeserializeObject<LibraryFileCompletion>(Encoding.UTF8.GetString(marker!.Read(MaximumPlanBytes)),Protocol.JsonSettings);Fail(completion!=null&&completion.IntentId==intentId&&completion.PlanFingerprint==plan.Fingerprint&&completion.Revision>0&&Hex.IsMatch(completion.MarkerSha256)&&completion.Targets.SingleOrDefault(t=>t.Id==targetId)?.Fingerprint==Receipt("committed",plan,target!,oldName,after,null).Fingerprint,"journal-conflict");Fail(target!.Staged==null&&source==null||source!=null&&after!=null&&source.Snapshot()==after,"recovery-conflict");return Receipt("committed",plan,target!,oldName,after,null,"finalized");}
    Fail(original.Snapshot()==target!.Before,"recovery-required");
    if(!rollback){if(target!.Staged==null&&source==null||source!=null&&after!=null&&source.Snapshot()==after)return Receipt("committed",plan,target!,oldName,after,null);return Receipt("conflict",plan,target!,oldName,after,null,"recovery-required");}
    if(source!=null)Fail(after!=null&&source.Snapshot()==after,"recovery-conflict");RequireClosedStableClient(plan,admission);
    if(source!=null)source.Rename(reverted);original!.Rename(parent.Leaf);Fail(original.Snapshot()==target!.Before,"recovery-required");journal.Directory.WriteNew($"restored-{slot:D3}.json",new{intentId,planFingerprint=plan.Fingerprint});budget.Check();return Receipt("unchanged",plan,target!,oldName,after,source==null?null:reverted);
  }
  internal static List<LibraryFileTarget[]> Groups(LibraryFilePlan plan)=>plan.Targets.GroupBy(t=>t.Before.Identity,StringComparer.Ordinal).OrderBy(g=>g.Key,StringComparer.Ordinal).Select(g=>g.OrderBy(t=>t.Id,StringComparer.Ordinal).ToArray()).ToList();
  internal static string Old(LibraryFilePlan p,int slot)=>$".hindsight-{p.Nonce}-{slot:D3}-old";
  internal static string New(LibraryFilePlan p,int slot)=>$".hindsight-{p.Nonce}-{slot:D3}-new";
  internal static string Reverted(LibraryFilePlan p,int slot)=>$".hindsight-{p.Nonce}-{slot:D3}-reverted";
  internal static LibraryFileReceipt Receipt(string state,LibraryFilePlan plan,LibraryFileTarget t,string oldName,LibraryFileIdentity? after,string? reverted,string? detail=null){var evidence=new LibraryFileEvidence(t.ParentIdentity,t.RelativePath,oldName,t.Before,after,reverted);return new(state,Hash(new{plan.Fingerprint,t.Id,state,evidence}),evidence,detail);}
}

public sealed class LibraryFileMutationSession:IDisposable
{
  private readonly LibraryClientProcessAdmission admission;
  private readonly LibraryFilePlan plan;private readonly string intentId;private readonly FileMutationBudget budget;private readonly FileMutationRoots roots;private FileMutationPath? journal;private FileMutationFile? gate;private readonly List<Group> groups=[];private readonly List<IDisposable> continuationOwned=[];private readonly List<FileMutationFile> continuationStages=[];private readonly bool continuation;private bool disposed;
  public string SessionToken {get;}=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
  private sealed class Group {public required LibraryFileTarget[] Targets;public required FileMutationPath Parent;public required FileMutationFile Source;public FileMutationFile? Prepared;public LibraryFileIdentity? Created,After;public string State="acquired";public string? IntentId;public bool InitiallyCommitted;}
  internal LibraryFileMutationSession(LibraryFilePlan plan,string intentId,CancellationToken cancellation)
    :this(plan,intentId,cancellation,LibraryClientProcessAdmission.Default){}
  internal LibraryFileMutationSession(LibraryFilePlan plan,string intentId,CancellationToken cancellation,LibraryClientProcessAdmission admission)
  {
    LibraryFileMutation.Validate(plan);LibraryFileMutation.Fail(Guid.TryParseExact(intentId,"D",out _),"invalid-source");this.plan=plan;this.intentId=intentId;this.admission=admission;cancellation.ThrowIfCancellationRequested();RequireClosedStableClient();budget=new(cancellation);roots=new(plan,budget);
    try {
      foreach(var targets in LibraryFileMutation.Groups(plan)){
        var parent=roots.Parent(targets[0]);FileMutationFile? source=null;
        try{source=parent.Directory.File(parent.Leaf);source.Expect(targets[0].Before);foreach(var t in targets.Skip(1)){using var alias=roots.Parent(t);LibraryFileMutation.Fail(t.Before==targets[0].Before&&alias.Directory.Identity==parent.Directory.Identity&&string.Equals(alias.Leaf,parent.Leaf,StringComparison.OrdinalIgnoreCase)&&t.Staged==targets[0].Staged&&t.StageIdentity==targets[0].StageIdentity,"ambiguous-target");}groups.Add(new(){Targets=targets,Parent=parent,Source=source});}catch{source?.Dispose();parent.Dispose();throw;}
      }
      RequireClosedStableClient();
      journal=roots.App.Descend(["library-deletion-journal",plan.Nonce],true,true);gate=journal.Directory.File("session.lock",2,LibraryFileMutationNative.Read|LibraryFileMutationNative.Write|LibraryFileMutationNative.Delete);journal.Directory.WriteNew("plan.json",plan);journal.Directory.WriteNew("acquire.json",new{intentId,planFingerprint=plan.Fingerprint});
      for(int slot=0;slot<groups.Count;slot++){
        var g=groups[slot];var staged=g.Targets[0].Staged;if(staged==null)continue;
        using var sp=roots.App.Parent(staged.RelativePath);using var input=sp.Directory.File(sp.Leaf);input.Expect(g.Targets[0].StageIdentity!);byte[] bytes=input.Read(LibraryFileMutation.MaximumFileBytes);LibraryFileMutation.Fail(bytes.LongLength==staged.Bytes&&LibraryFileMutationNative.Hash(bytes)==staged.Sha256,"source-changed");
        g.Prepared=g.Parent.Directory.File(LibraryFileMutation.New(plan,slot),2,LibraryFileMutationNative.Read|LibraryFileMutationNative.Write|LibraryFileMutationNative.Delete|0xc0000);FileMutationSecurity.Copy(g.Source.Handle,g.Prepared.Handle);g.Created=g.Prepared.Snapshot();journal.Directory.WriteNew($"created-{slot:D3}.json",g.Created);LibraryFileMutationNative.WriteAndFlush(g.Prepared.Handle,bytes);g.After=g.Prepared.Snapshot();LibraryFileMutation.Fail(g.After.Sha256==staged.Sha256&&g.After.Bytes==staged.Bytes&&g.After.SecurityHash==g.Targets[0].Before.SecurityHash,"source-changed");input.Expect(g.Targets[0].StageIdentity!);journal.Directory.WriteNew($"prepared-{slot:D3}.json",g.After);
      }
      VerifyAll();RequireClosedStableClient();budget.Check();budget.Session();
    }catch(Exception primary){try{foreach(var g in groups)g.Source.Expect(g.Targets[0].Before);foreach(var g in groups){if(g.Prepared==null)continue;var current=g.Prepared.Snapshot();LibraryFileMutation.Fail(g.Created==null||current.Identity==g.Created.Identity,"recovery-conflict");g.Prepared.Erase();g.Prepared=null;}}catch(Exception cleanup){primary.Data["ownedStageCleanupFailure"]=cleanup.GetType().Name+":"+cleanup.Message;}finally{Dispose();}throw;}
  }
  internal LibraryFileMutationSession(LibraryFilePlan plan,string intentId,IReadOnlyList<LibraryFileCompletionTarget> committed,IReadOnlyList<string> remainingTargetIds,CancellationToken cancellation)
    :this(plan,intentId,committed,remainingTargetIds,cancellation,LibraryClientProcessAdmission.Default){}
  internal LibraryFileMutationSession(LibraryFilePlan plan,string intentId,IReadOnlyList<LibraryFileCompletionTarget> committed,IReadOnlyList<string> remainingTargetIds,CancellationToken cancellation,LibraryClientProcessAdmission admission)
  {
    LibraryFileMutation.Validate(plan);LibraryFileMutation.Fail(Guid.TryParseExact(intentId,"D",out _),"invalid-source");
    var ids=plan.Targets.Select(t=>t.Id).ToHashSet(StringComparer.Ordinal);var done=committed.Select(t=>t.Id).ToHashSet(StringComparer.Ordinal);var remaining=remainingTargetIds.ToHashSet(StringComparer.Ordinal);
    LibraryFileMutation.Fail(done.Count==committed.Count&&remaining.Count==remainingTargetIds.Count&&done.Count+remaining.Count==ids.Count&&!done.Overlaps(remaining)&&ids.SetEquals(done.Concat(remaining))&&committed.All(t=>LibraryFileMutation.Hex.IsMatch(t.Fingerprint??"")),"invalid-continuation");
    this.plan=plan;this.intentId=intentId;this.admission=admission;continuation=true;cancellation.ThrowIfCancellationRequested();RequireClosedStableClient();budget=new(cancellation);roots=new(plan,budget);
    try{
      journal=roots.App.Descend(["library-deletion-journal",plan.Nonce],false);gate=journal.Directory.File("session.lock");
      using(var header=journal.Directory.File("plan.json"))LibraryFileMutation.Fail(Encoding.UTF8.GetString(header.Read(LibraryFileMutation.MaximumPlanBytes))==LibraryFileMutation.Serialize(plan),"journal-conflict");
      RequireRecord("acquire.json",new{intentId,planFingerprint=plan.Fingerprint},true);
      foreach(var name in new[]{"acquire-abort.json","acquire-aborted.json","finalize.json","finalized.json"})using(var marker=journal.Directory.Maybe(name))LibraryFileMutation.Fail(marker==null,"invalid-continuation");
      var originalGroups=LibraryFileMutation.Groups(plan);
      for(int slot=0;slot<originalGroups.Count;slot++){
        var targets=originalGroups[slot];bool complete=done.Contains(targets[0].Id);LibraryFileMutation.Fail(targets.All(t=>done.Contains(t.Id)==complete),"invalid-continuation");
        var parent=roots.Parent(targets[0]);FileMutationFile? source=null,prepared=null;
        try{
          foreach(var alias in targets.Skip(1)){using var a=roots.Parent(alias);LibraryFileMutation.Fail(alias.Before==targets[0].Before&&a.Directory.Identity==parent.Directory.Identity&&a.Leaf.Equals(parent.Leaf,StringComparison.OrdinalIgnoreCase)&&alias.Staged==targets[0].Staged&&alias.StageIdentity==targets[0].StageIdentity,"ambiguous-target");}
          using(var reverted=parent.Directory.Maybe(LibraryFileMutation.Reverted(plan,slot)))LibraryFileMutation.Fail(reverted==null,"recovery-conflict");
          using(var restored=journal.Directory.Maybe($"restored-{slot:D3}.json"))LibraryFileMutation.Fail(restored==null,"recovery-conflict");
          RequireRecord($"start-{slot:D3}.json",new{intentId,targetIds=targets.Select(t=>t.Id).ToArray(),planFingerprint=plan.Fingerprint},complete);
          if(complete)RequireRecord($"committed-{slot:D3}.json",new{intentId,planFingerprint=plan.Fingerprint},false);
          else using(var marker=journal.Directory.Maybe($"committed-{slot:D3}.json"))LibraryFileMutation.Fail(marker==null,"recovery-conflict");
          source=parent.Directory.File(complete?LibraryFileMutation.Old(plan,slot):parent.Leaf);source.Expect(targets[0].Before);
          using(var unexpected=parent.Directory.Maybe(complete?LibraryFileMutation.New(plan,slot):LibraryFileMutation.Old(plan,slot)))LibraryFileMutation.Fail(unexpected==null,"recovery-conflict");
          LibraryFileIdentity? after=null;
          if(targets[0].Staged!=null){
            using var recorded=journal.Directory.File($"prepared-{slot:D3}.json");after=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(recorded.Read(4096)),Protocol.JsonSettings);LibraryFileMutation.ValidateIdentity(after!);LibraryFileMutation.Fail(after!.Bytes==targets[0].Staged!.Bytes&&after.Sha256==targets[0].Staged!.Sha256&&after.SecurityHash==targets[0].Before.SecurityHash,"journal-conflict");
            using var createdFile=journal.Directory.File($"created-{slot:D3}.json");var created=JsonConvert.DeserializeObject<LibraryFileIdentity>(Encoding.UTF8.GetString(createdFile.Read(4096)),Protocol.JsonSettings);LibraryFileMutation.ValidateIdentity(created!);LibraryFileMutation.Fail(created!.Identity==after.Identity&&created.Bytes==0&&created.Sha256==LibraryFileMutationNative.Hash([])&&created.SecurityHash==after.SecurityHash,"journal-conflict");
            prepared=parent.Directory.File(complete?parent.Leaf:LibraryFileMutation.New(plan,slot));prepared.Expect(after);
          }else if(complete){using var current=parent.Directory.Maybe(parent.Leaf);LibraryFileMutation.Fail(current==null,"recovery-conflict");}
          else {using var unexpectedStage=parent.Directory.Maybe(LibraryFileMutation.New(plan,slot));LibraryFileMutation.Fail(unexpectedStage==null,"recovery-conflict");}
          if(complete)foreach(var t in targets)LibraryFileMutation.Fail(committed.Single(c=>c.Id==t.Id).Fingerprint==LibraryFileMutation.Receipt("committed",plan,t,LibraryFileMutation.Old(plan,slot),after,null).Fingerprint,"invalid-continuation");
          groups.Add(new(){Targets=targets,Parent=parent,Source=source,Prepared=prepared,After=after,State=complete?"committed":"acquired",IntentId=complete?intentId:null,InitiallyCommitted=complete});source=null;prepared=null;
        }catch{prepared?.Dispose();source?.Dispose();parent.Dispose();throw;}
      }
      LibraryFileMutation.HoldAppStages(plan,roots.App,continuationOwned,continuationStages,false);VerifyAll();RequireClosedStableClient();budget.Check();budget.Session();
    }catch{Dispose();throw;}
  }
  private void RequireRecord(string name,object expected,bool required){using var record=journal!.Directory.Maybe(name);LibraryFileMutation.Fail(record!=null||!required,"recovery-required");if(record!=null)LibraryFileMutation.Fail(Encoding.UTF8.GetString(record.Read(4096))==LibraryFileMutation.Serialize(expected),"journal-conflict");}
  private Group Target(string id){LibraryFileMutation.Fail(!disposed,"invalid-state");return groups.SingleOrDefault(g=>g.Targets.Any(t=>t.Id==id))??throw new LibrarySourceException("invalid-target");}
  private void VerifyAll(){foreach(var g in groups){g.Source.Expect(g.Targets[0].Before);if(g.Prepared!=null)g.Prepared.Expect(g.After!);}if(continuation){var pins=plan.Targets.Where(t=>t.Staged!=null).GroupBy(t=>t.StageIdentity!.Identity,StringComparer.Ordinal).Select(g=>g.First().StageIdentity!).ToArray();for(int i=0;i<continuationStages.Count;i++)continuationStages[i].Expect(pins[i]);}}
  private void RequireClosedStableClient()=>LibraryFileMutation.RequireClosedStableClient(plan,admission);
  public void Verify(string targetId){budget.Operation();var g=Target(targetId);LibraryFileMutation.Fail(g.State=="acquired"||continuation&&g.State=="committed","invalid-state");RequireClosedStableClient();VerifyAll();}
  public bool HasCommitted=>groups.Any(g=>g.State!="acquired");
  public void Abort()
  {
    budget.Operation();LibraryFileMutation.Fail(!disposed&&!HasCommitted,"invalid-state");VerifyAll();var owned=new List<IDisposable>();var remove=new List<FileMutationFile>();try{if(continuation)remove.AddRange(continuationStages);else LibraryFileMutation.HoldAppStages(plan,roots.App,owned,remove,false);journal!.Directory.WriteNew("acquire-abort.json",new{intentId,planFingerprint=plan.Fingerprint});foreach(var g in groups){if(g.Prepared!=null){g.Prepared.Expect(g.After!);g.Prepared.Erase();g.Prepared=null;}g.State="aborted";}foreach(var f in remove)f.Erase();journal.Directory.WriteNew("acquire-aborted.json",new{intentId,planFingerprint=plan.Fingerprint});budget.Check();}finally{for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();}
  }
  public LibraryFileReceipt Commit(string targetId,string intentId)
  {
    budget.Operation();LibraryFileMutation.Fail(intentId==this.intentId,"invalid-source");var g=Target(targetId);int slot=groups.IndexOf(g);RequireClosedStableClient();VerifyAll();LibraryFileMutation.Fail(!g.InitiallyCommitted,"invalid-continuation");if(g.State=="committed"){LibraryFileMutation.Fail(g.IntentId==intentId,"invalid-state");return LibraryFileMutation.Receipt("committed",plan,g.Targets.Single(t=>t.Id==targetId),LibraryFileMutation.Old(plan,slot),g.After,null);}
    LibraryFileMutation.Fail(g.State=="acquired","recovery-required");VerifyAll();RequireClosedStableClient();var startValue=new{intentId,targetIds=g.Targets.Select(t=>t.Id).ToArray(),planFingerprint=plan.Fingerprint};using(var start=journal!.Directory.Maybe($"start-{slot:D3}.json")){if(start==null)journal.Directory.WriteNew($"start-{slot:D3}.json",startValue);else{LibraryFileMutation.Fail(continuation,"invalid-state");LibraryFileMutation.Fail(Encoding.UTF8.GetString(start.Read(4096))==LibraryFileMutation.Serialize(startValue),"journal-conflict");}}g.State="recovery-required";g.IntentId=intentId;
    g.Source.Rename(LibraryFileMutation.Old(plan,slot));g.Prepared?.Rename(g.Parent.Leaf);g.Source.Expect(g.Targets[0].Before);if(g.Prepared!=null)g.Prepared.Expect(g.After!);journal.Directory.WriteNew($"committed-{slot:D3}.json",new{intentId,planFingerprint=plan.Fingerprint});budget.Check();g.State="committed";return LibraryFileMutation.Receipt("committed",plan,g.Targets.Single(t=>t.Id==targetId),LibraryFileMutation.Old(plan,slot),g.After,null);
  }
  public void Dispose(){if(disposed)return;disposed=true;for(int i=continuationOwned.Count-1;i>=0;i--)continuationOwned[i].Dispose();for(int i=groups.Count-1;i>=0;i--){groups[i].Prepared?.Dispose();groups[i].Source.Dispose();groups[i].Parent.Dispose();}gate?.Dispose();journal?.Dispose();roots.Dispose();}
}

internal sealed class FileMutationBudget(CancellationToken cancellation)
{
  private readonly Stopwatch clock=Stopwatch.StartNew();private long operationEnd=5000;
  internal void Operation(){CheckLifetime();operationEnd=Math.Min(30_000,clock.ElapsedMilliseconds+5000);}
  internal void Session(){Check();operationEnd=30_000;}
  private void CheckLifetime(){cancellation.ThrowIfCancellationRequested();if(clock.ElapsedMilliseconds>=30_000)throw new TimeoutException("Mutation session deadline");}
  internal void Check(){CheckLifetime();if(clock.ElapsedMilliseconds>=operationEnd)throw new TimeoutException("Mutation operation deadline");}
}
internal sealed class FileMutationRoots:IDisposable
{
  private readonly LibraryFilePlan plan;private readonly FileMutationBudget budget;internal FileMutationDirectory App;private readonly List<FileMutationDirectory> sources=[];
  internal FileMutationRoots(LibraryFilePlan p,FileMutationBudget b){plan=p;budget=b;App=FileMutationDirectory.Open(p.App.Directory,p.App.Identity,b);try{for(int i=0;i<p.Sources.Count;i++){LibraryFileMutation.Fail(p.Sources[i].Directory.Equals(p.Roots[i].Directory,StringComparison.OrdinalIgnoreCase),"source-changed");sources.Add(FileMutationDirectory.Open(p.Roots[i].Directory,p.Roots[i].Identity,b));}}catch{Dispose();throw;}}
  internal FileMutationPath Parent(LibraryFileTarget t){int i=plan.Sources.ToList().FindIndex(s=>s.Id==t.SourceId);LibraryFileMutation.Fail(i>=0,"invalid-source");var p=sources[i].Parent(t.RelativePath);if(p.Directory.Identity!=t.ParentIdentity){p.Dispose();throw new LibrarySourceException("source-changed");}return p;}
  public void Dispose(){foreach(var s in sources)s.Dispose();App.Dispose();}
}
internal sealed class FileMutationPath(FileMutationDirectory directory,string leaf,List<FileMutationDirectory> owned):IDisposable
{internal FileMutationDirectory Directory=directory;internal string Leaf=leaf;public void Dispose(){for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();}}
internal sealed class FileMutationDirectory:IDisposable
{
  internal SafeFileHandle Handle;internal string Path,Identity;internal FileMutationBudget Budget;
  private FileMutationDirectory(SafeFileHandle handle,string path,FileMutationBudget budget){Handle=handle;Path=path;Budget=budget;try{var i=LibraryFileMutationNative.Stat(handle);LibraryFileMutation.Fail((i.Attr&0x410)==0x10&&LibraryFileMutationNative.Final(handle).Equals(path,StringComparison.OrdinalIgnoreCase),"invalid-source");Identity=LibraryFileMutationNative.Id(i);budget.Check();}catch{handle.Dispose();throw;}}
  internal static FileMutationDirectory Open(string path,string? identity,FileMutationBudget budget){LibraryFileMutation.Fail(OperatingSystem.IsWindows()&&System.IO.Path.IsPathFullyQualified(path)&&Regex.IsMatch(path,"^[a-zA-Z]:[\\\\/]"),"unsupported-source");string p=System.IO.Path.GetFullPath(path).TrimEnd('\\');LibraryFileMutation.Fail(new DriveInfo(System.IO.Path.GetPathRoot(p)!).DriveFormat=="NTFS","unsupported-source");var h=LibraryFileMutationNative.CreateFileW(p,0x80|0x20,3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);if(h.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());var dir=new FileMutationDirectory(h,p,budget);if(identity!=null&&dir.Identity!=identity){dir.Dispose();throw new LibrarySourceException("source-changed");}return dir;}
  internal void Check(){Budget.Check();LibraryFileMutation.Fail(LibraryFileMutationNative.Id(LibraryFileMutationNative.Stat(Handle))==Identity&&LibraryFileMutationNative.Final(Handle).Equals(Path,StringComparison.OrdinalIgnoreCase),"source-changed");}
  internal FileMutationPath Parent(string relative){var names=LibraryFileMutation.Segments(relative);var p=Descend(names[..^1],false);p.Leaf=names[^1];return p;}
  internal FileMutationPath Descend(string[] parts,bool create,bool freshLast=false){var owned=new List<FileMutationDirectory>();var current=this;try{for(int i=0;i<parts.Length;i++){current.Check();var h=LibraryFileMutationNative.Relative(current.Handle,parts[i],0x80|0x20,create?(freshLast&&i==parts.Length-1?2u:3u):1u,true);current=new(h,System.IO.Path.Combine(current.Path,parts[i]),Budget);owned.Add(current);}return new(current,"",owned);}catch{for(int i=owned.Count-1;i>=0;i--)owned[i].Dispose();throw;}}
  internal FileMutationFile File(string leaf,uint disposition=1,uint access=LibraryFileMutationNative.Read|LibraryFileMutationNative.Delete)=>new(this,leaf,disposition,access);
  internal FileMutationFile? Maybe(string leaf){try{return File(leaf);}catch(Win32Exception e)when(e.NativeErrorCode==2){return null;}}
  internal void WriteNew(string name,object value){byte[] b=Encoding.UTF8.GetBytes(LibraryFileMutation.Serialize(value));LibraryFileMutation.Fail(b.Length<=LibraryFileMutation.MaximumPlanBytes,"resource-limit");using var f=File(name,2,LibraryFileMutationNative.Read|LibraryFileMutationNative.Write|LibraryFileMutationNative.Delete);LibraryFileMutationNative.WriteAndFlush(f.Handle,b);Check();}
  public void Dispose()=>Handle.Dispose();
}
internal sealed class FileMutationFile:IDisposable
{
  internal SafeFileHandle Handle;private readonly FileMutationDirectory parent;
  internal FileMutationFile(FileMutationDirectory parent,string leaf,uint disposition,uint access){this.parent=parent;parent.Check();Handle=LibraryFileMutationNative.Relative(parent.Handle,leaf,access,disposition);try{var i=LibraryFileMutationNative.Stat(Handle);LibraryFileMutation.Fail((i.Attr&~(0x80u|0x20u))==0&&i.Links==1,"unsupported-file");FileMutationSecurity.DefaultStream(Handle);}catch{Handle.Dispose();throw;}}
  internal byte[] Read(int cap){parent.Check();var b=LibraryFileMutationNative.ReadAll(Handle,cap);parent.Check();return b;}
  internal LibraryFileIdentity Snapshot(){parent.Check();var before=LibraryFileMutationNative.Stat(Handle);byte[] b=Read(LibraryFileMutation.MaximumFileBytes);var after=LibraryFileMutationNative.Stat(Handle);FileMutationSecurity.DefaultStream(Handle);LibraryFileMutation.Fail(LibraryFileMutationNative.Id(before)==LibraryFileMutationNative.Id(after)&&before.SizeHi==after.SizeHi&&before.SizeLo==after.SizeLo&&before.WriteHi==after.WriteHi&&before.WriteLo==after.WriteLo&&after.Links==1&&(after.Attr&~(0x80u|0x20u))==0,"source-changed");string security=FileMutationSecurity.Fingerprint(Handle);parent.Check();return new(LibraryFileMutationNative.Id(after),b.LongLength,LibraryFileMutationNative.Hash(b),(((long)after.WriteHi<<32)|after.WriteLo).ToString(System.Globalization.CultureInfo.InvariantCulture),after.Attr,security);}
  internal void Expect(LibraryFileIdentity id)=>LibraryFileMutation.Fail(Snapshot()==id,"source-changed");
  internal void Rename(string leaf){parent.Check();LibraryFileMutationNative.Rename(Handle,parent.Handle,leaf);parent.Check();}
  internal void Erase(){parent.Check();LibraryFileMutationNative.RemoveHeld(Handle);Handle.Dispose();parent.Check();}
  public void Dispose()=>Handle.Dispose();
}
internal static class FileMutationSecurity
{
  [StructLayout(LayoutKind.Sequential)] private struct Io {public IntPtr Status,Information;}
  [DllImport("ntdll.dll")] private static extern int NtQueryInformationFile(SafeFileHandle file,out Io io,IntPtr buffer,uint length,int kind);
  [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(SafeFileHandle file,int kind,uint fields,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] private static extern uint SetSecurityInfo(SafeFileHandle file,int kind,uint fields,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
  [DllImport("advapi32.dll")] private static extern uint GetLengthSid(IntPtr sid);
  [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
  internal static void DefaultStream(SafeFileHandle file){IntPtr b=Marshal.AllocHGlobal(4096);try{int status=NtQueryInformationFile(file,out var io,b,4096,22);LibraryFileMutation.Fail(status>=0&&io.Information.ToInt64()>=24,"unsupported-stream");int next=Marshal.ReadInt32(b),length=Marshal.ReadInt32(b,4);LibraryFileMutation.Fail(next==0&&length==14&&Marshal.PtrToStringUni(IntPtr.Add(b,24),length/2)=="::$DATA","unsupported-stream");}finally{Marshal.FreeHGlobal(b);}}
  private sealed class Security:IDisposable {internal IntPtr Owner,Group,Dacl,Descriptor;internal uint Flags;internal Security(SafeFileHandle file){uint code=GetSecurityInfo(file,1,7,out Owner,out Group,out Dacl,out _,out Descriptor);if(code!=0)throw new Win32Exception((int)code);if(!GetSecurityDescriptorControl(Descriptor,out ushort control,out _)){Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}Flags=7u|((control&0x1000)!=0?0x80000000u:0x20000000u);}public void Dispose(){if(Descriptor!=IntPtr.Zero){LocalFree(Descriptor);Descriptor=IntPtr.Zero;}}}
  private static string Bytes(IntPtr pointer,int count){LibraryFileMutation.Fail(count is >=0 and <=65536,"unsupported-security");if(pointer==IntPtr.Zero)return "null";byte[] b=new byte[count];Marshal.Copy(pointer,b,0,count);return Convert.ToHexString(b);}
  private static string Sid(IntPtr p)=>p==IntPtr.Zero?"null":Bytes(p,checked((int)GetLengthSid(p)));
  internal static string Fingerprint(SafeFileHandle file){using var s=new Security(file);return LibraryFileMutation.Hash(new{owner=Sid(s.Owner),group=Sid(s.Group),dacl=s.Dacl==IntPtr.Zero?"null":Bytes(s.Dacl,(ushort)Marshal.ReadInt16(s.Dacl,2)),flags=s.Flags});}
  internal static void Copy(SafeFileHandle original,SafeFileHandle staged){using var s=new Security(original);uint code=SetSecurityInfo(staged,1,s.Flags,s.Owner,s.Group,s.Dacl,IntPtr.Zero);if(code!=0)throw new Win32Exception((int)code,"Source security cannot be preserved");LibraryFileMutation.Fail(Fingerprint(original)==Fingerprint(staged),"unsupported-security");}
}
 internal static class LibraryFileMutationNative {
  public const uint Read=0x80000000,Write=0x40000000,Delete=0x10000;
  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint Attr,CreateLo,CreateHi,AccessLo,AccessHi,WriteLo,WriteHi,Volume,SizeHi,SizeLo,Links,IndexHi,IndexLo; }
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort Length,MaximumLength;public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length;public IntPtr Root,ObjectName;public uint Flags;public IntPtr Security,Quality; }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus {public IntPtr Status,Information;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sa,uint d,uint f,IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint f);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint a,ref ObjectAttributes o,out IoStatus i,IntPtr size,uint attr,uint share,uint disposition,uint options,IntPtr ea,uint ealen);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int s);
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle h,out IoStatus io,IntPtr b,uint n,int kind);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long distance,out long position,uint method);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint count,out uint read,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint count,out uint written,IntPtr overlapped);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  public static void Require(bool ok,string op){if(!ok){int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,op+" [Win32 "+code+"]");}}
  public static Info Stat(SafeFileHandle h){Info i;Require(GetFileInformationByHandle(h,out i),"Handle identity");return i;}
  public static string Id(Info i){return i.Volume.ToString("x8")+":"+i.IndexHi.ToString("x8")+i.IndexLo.ToString("x8");}
  public static string Final(SafeFileHandle h){var b=new StringBuilder(1024);uint n=GetFinalPathNameByHandleW(h,b,1024,0);Require(n>0&&n<1024,"Canonical handle path");string p=b.ToString();if(p.StartsWith(@"\\?\"))p=p.Substring(4);return p.TrimEnd('\\');}
  public static void Leaf(string n){if(String.IsNullOrEmpty(n)||n.Length>100||n=="."||n==".."||n.IndexOfAny(new[]{'\\','/',':','\0'})>=0||n.EndsWith(".")||n.EndsWith(" "))throw new InvalidDataException("Single bounded child name required");}
  public static SafeFileHandle Relative(SafeFileHandle root,string name,uint access,uint disposition,bool directory=false){
   Leaf(name);IntPtr text=Marshal.StringToHGlobalUni(name),str=IntPtr.Zero;
   try{var u=new Unicode{Length=(ushort)(name.Length*2),MaximumLength=(ushort)(name.Length*2+2),Buffer=text};str=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Unicode)));Marshal.StructureToPtr(u,str,false);var o=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),Root=root.DangerousGetHandle(),ObjectName=str,Flags=0x40|0x1000};IoStatus io;IntPtr raw;int s=NtCreateFile(out raw,access|0x100000,ref o,out io,IntPtr.Zero,directory?0x10u:0x80u,directory?3u:0u,disposition,0x20|0x200000|0x2|(directory?1u:0x40u),IntPtr.Zero,0);if(s<0)throw new Win32Exception((int)RtlNtStatusToDosError(s),"Exclusive root-relative open: "+name);return new SafeFileHandle(raw,true);}
   finally{if(str!=IntPtr.Zero)Marshal.FreeHGlobal(str);Marshal.FreeHGlobal(text);}
  }
  public static void Rename(SafeFileHandle file,SafeFileHandle root,string leaf){
   Leaf(leaf);byte[] name=Encoding.Unicode.GetBytes(leaf);int rootOffset=IntPtr.Size==8?8:4,lenOffset=rootOffset+IntPtr.Size,nameOffset=lenOffset+4;int structureSize=(nameOffset+2+IntPtr.Size-1)&~(IntPtr.Size-1);int size=structureSize+name.Length;IntPtr p=Marshal.AllocHGlobal(size);
   try{Marshal.Copy(new byte[size],0,p,size);Marshal.WriteIntPtr(p,rootOffset,root.DangerousGetHandle());Marshal.WriteInt32(p,lenOffset,name.Length);Marshal.Copy(name,0,IntPtr.Add(p,nameOffset),name.Length);IoStatus io;int status=NtSetInformationFile(file,out io,p,(uint)size,10);if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status),"Handle rename without replacement: "+leaf+" [NTSTATUS "+status.ToString("x8")+"]");}
   finally{Marshal.FreeHGlobal(p);}
  }
  public static void RemoveHeld(SafeFileHandle file){IntPtr p=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(p,1);IoStatus io;int status=NtSetInformationFile(file,out io,p,1,13);if(status<0)throw new Win32Exception((int)RtlNtStatusToDosError(status),"Exact held-file cleanup");}finally{Marshal.FreeHGlobal(p);}}
  public static byte[] ReadAll(SafeFileHandle h,int cap){Info i=Stat(h);long size=((long)i.SizeHi<<32)|i.SizeLo;if(size>cap)throw new InvalidDataException("File byte cap");long pos;Require(SetFilePointerEx(h,0,out pos,0),"Seek");byte[] b=new byte[(int)size];uint got;Require(ReadFile(h,b,(uint)b.Length,out got,IntPtr.Zero),"Read held file");if(got!=b.Length)throw new IOException("Short read");return b;}
  public static void WriteAndFlush(SafeFileHandle h,byte[] b){uint wrote;Require(WriteFile(h,b,(uint)b.Length,out wrote,IntPtr.Zero),"Write intent");if(wrote!=b.Length)throw new IOException("Short write");Require(FlushFileBuffers(h),"Flush intent");}
  public static string Hash(byte[] b){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 }

