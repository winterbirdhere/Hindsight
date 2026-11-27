// SPDX-License-Identifier: MIT
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Realms;
using Realms.Schema;

namespace RewindPerformance;

public sealed class LibrarySourceDeletionPlan
{
  public int Version { get; set; } = 1;
  public string SourceDirectory { get; set; } = "";
  public string RootIdentity { get; set; } = "";
  public string DatabaseIdentity { get; set; } = "";
  public string DatabaseSha256 { get; set; } = "";
  public string SchemaFingerprint { get; set; } = "";
  public ulong SchemaVersion { get; set; }
  public List<LibrarySourceDeletionRecord> Records { get; set; } = [];
  public string Token { get; set; } = "";
}
public sealed class LibrarySourceDeletionRecord
{
  public string ScoreId { get; set; } = "";
  public string BeforeFingerprint { get; set; } = "";
  public string AfterFingerprint { get; set; } = "";
  public bool WasDeletePending { get; set; }
  public string? ReplaySha256 { get; set; }
  public List<LibrarySourceDeletionFile> RetainedFiles { get; set; } = [];
}
public sealed record LibrarySourceDeletionSelection(string ScoreId, string? ExpectedReplaySha256 = null);
public sealed record LibrarySourceDeletionFile(string Name, string Sha256, string Path);
public sealed class LibrarySourceAssociations
{
  public bool Complete {get;set;}
  public string Basis {get;set;}="native-content-addressed-metadata";
  public string SourceDirectory {get;set;}="";
  public string RootIdentity {get;set;}="";
  public string DatabaseIdentity {get;set;}="";
  public string DatabaseSha256 {get;set;}="";
  public string SchemaFingerprint {get;set;}="";
  public ulong SchemaVersion {get;set;}
  public int LiveRecordsScanned {get;set;}
  public List<string> RequestedReplaySha256s {get;set;}=[];
  public List<LibrarySourceAssociationMatch> Records {get;set;}=[];
  public List<LibrarySourceAssociationKnown> KnownRecords {get;set;}=[];
}
public sealed record LibrarySourceAssociationMatch(string ScoreId,string ReplaySha256);
public sealed record LibrarySourceAssociationKnown(string ScoreId,string State,string? ReplaySha256);
public sealed record LibrarySourceDeletionDiagnostic(string Operation,string Reason,string Subphase,[property:JsonProperty(NullValueHandling=NullValueHandling.Ignore)]int? NativeErrorCode=null);

/// <summary>Exact GUID soft deletion only. No file removal, osu! manager, migration, or online operation.</summary>
public static class LibrarySourceDeletion
{
  internal const string DiagnosticDataKey="hindsight-native-deletion-busy";
  private static readonly string[] diagnosticPhases=["client-before-open","client-after-write-lock","held-client-check","root-open","immutable-lease-open","immutable-realm-open","identity-guard-open","mutable-realm-open","realm-write-lock","native-operation"];
  internal static LibrarySourceException Busy(string reason,string phase,int? nativeErrorCode=null) {
    var error=new LibrarySourceException("source-busy");error.Data[DiagnosticDataKey]=new LibrarySourceDeletionDiagnostic("",reason,phase,nativeErrorCode);return error;
  }
  internal static LibrarySourceDeletionDiagnostic? DiagnosticFor(Exception error,string? operation) {
    if(operation==null||!new[]{"associations","prepare","reconcile","acquire","verify","commit","abort","close","guard-acquire","guard-verify"}.Contains(operation,StringComparer.Ordinal))return null;
    if(error.Data[DiagnosticDataKey] is LibrarySourceDeletionDiagnostic d&&diagnosticPhases.Contains(d.Subphase,StringComparer.Ordinal)&&
      (d.Reason=="windows-sharing-or-lock"&&d.NativeErrorCode is 32 or 33||d.Reason=="supplemental-client-check"&&d.NativeErrorCode==null&&
        new[]{"client-before-open","client-after-write-lock","held-client-check"}.Contains(d.Subphase,StringComparer.Ordinal)||
       d.Reason=="realm-write-admission-timeout"&&d.NativeErrorCode==null&&d.Subphase=="realm-write-lock"||d.Reason=="source-busy"&&d.NativeErrorCode==null))return d with{Operation=operation};
    if(error is IOException io&&(io.HResult&0xffff) is 32 or 33)return new(operation,"windows-sharing-or-lock","native-operation",io.HResult&0xffff);
    return error is LibrarySourceException {Status:"source-busy"}?new(operation,"source-busy","native-operation"):null;
  }
  private static T AtBusyPhase<T>(string phase,Func<T> action) {
    try{return action();}catch(IOException error)when((error.HResult&0xffff) is 32 or 33){
      error.Data[DiagnosticDataKey]=new LibrarySourceDeletionDiagnostic("","windows-sharing-or-lock",phase,error.HResult&0xffff);throw;
    }
  }
  public const int AdmissionMilliseconds = 2000;
  public const string NativeWriteHoldStatus = "source-conversion-unqualified";
  public const string NativeWriteHoldReason = "Deletion from this osu! database is paused to protect unrelated data.";
  private const long maximumDatabaseBytes = 512L * 1024 * 1024;
  // 51 is the guarded actual source schema; 73 remains covered by the prior additive fixtures.
  // Preserve the exact stored version on mutable open; never migrate unknown versions.
  private static bool SupportedSchemaVersion(ulong version) => version is 51 or 73;
  internal static bool IsHash(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
  internal static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

  public static LibrarySourceAssociations Associations(string directory,IReadOnlyList<string> replaySha256s,IReadOnlyList<string> knownScoreIds,CancellationToken cancellation=default)
  {
    cancellation.ThrowIfCancellationRequested();
    if(replaySha256s==null||replaySha256s.Count is <1 or >128||replaySha256s.Any(h=>!IsHash(h))||replaySha256s.Distinct(StringComparer.Ordinal).Count()!=replaySha256s.Count||
       knownScoreIds==null||knownScoreIds.Count>128||knownScoreIds.Any(id=>!Guid.TryParseExact(id,"D",out _))||knownScoreIds.Select(Guid.Parse).Distinct().Count()!=knownScoreIds.Count)
      throw new LibrarySourceException("invalid-source");
    var wanted=replaySha256s.ToHashSet(StringComparer.Ordinal);
    var known=knownScoreIds.ToDictionary(Guid.Parse,id=>new LibrarySourceAssociationKnown(Guid.Parse(id).ToString("D"),"missing",null));
    using var roots=SourcePins.Open(directory);
    using var lease=OpenImmutableLease(roots.Database);
    using var realm=AtBusyPhase("immutable-realm-open",()=>OpenRead(roots.Database));
    ValidateWriteSchema(realm);
    var result=new LibrarySourceAssociations {
      SourceDirectory=roots.Directory,RootIdentity=roots.Identity,DatabaseIdentity=SourcePins.IdentityOf(lease.SafeFileHandle),
      DatabaseSha256=Hash(lease,cancellation),SchemaFingerprint=SchemaFingerprint(realm),SchemaVersion=StoredSchemaVersion(realm),
      RequestedReplaySha256s=replaySha256s.Order(StringComparer.Ordinal).ToList()
    };
    int rows=0,links=0;
    foreach(var score in realm.DynamicApi.All("Score")) {
      cancellation.ThrowIfCancellationRequested();
      if(++rows>500_000)throw new LibrarySourceException("resource-limit");
      Guid id=score.DynamicApi.Get<Guid>("ID");
      bool pending=score.DynamicApi.Get<bool>("DeletePending");
      if(pending&&!known.ContainsKey(id))continue;
      if(!pending)result.LiveRecordsScanned++;
      string? replay=null;
      var usages=score.DynamicApi.GetList<IRealmObjectBase>("Files");
      if(usages.Count>128||(links+=usages.Count)>1_000_000)throw new LibrarySourceException("resource-limit");
      foreach(var usage in usages) {
        cancellation.ThrowIfCancellationRequested();
        string name=usage.DynamicApi.Get<string>("Filename");
        string hash=usage.DynamicApi.Get<IRealmObjectBase>("File")?.DynamicApi.Get<string>("Hash")??"";
        if(string.IsNullOrEmpty(name)||name.Length>512||name.Any(c=>c<32)||!IsHash(hash))throw new LibrarySourceException("invalid-source");
        if(!name.EndsWith(".osr",StringComparison.OrdinalIgnoreCase))continue;
        if(replay!=null)throw new LibrarySourceException("ambiguous-replay");
        replay=hash;
      }
      if(known.ContainsKey(id))known[id]=new(id.ToString("D"),pending?"pending":"live",replay);
      if(!pending&&replay!=null&&wanted.Contains(replay)) {
        if(result.Records.Count>=128)throw new LibrarySourceException("resource-limit");
        result.Records.Add(new(id.ToString("D"),replay));
      }
    }
    result.Records=result.Records.OrderBy(r=>r.ScoreId,StringComparer.Ordinal).ToList();
    result.KnownRecords=known.Values.OrderBy(r=>r.ScoreId,StringComparer.Ordinal).ToList();
    result.Complete=true;
    return result;
  }

  public static LibrarySourceDeletionPlan Prepare(string directory, IReadOnlyList<LibrarySourceDeletionSelection> selections, CancellationToken cancellation = default)
  {
    cancellation.ThrowIfCancellationRequested();
    if (selections == null || selections.Count is < 1 or > 128 || selections.Any(s=>s == null || !Guid.TryParseExact(s.ScoreId,"D",out _) || s.ExpectedReplaySha256 != null && !IsHash(s.ExpectedReplaySha256)) ||
        selections.Select(s=>Guid.Parse(s.ScoreId)).Distinct().Count()!=selections.Count)
      throw new LibrarySourceException("invalid-source");
    using var roots = SourcePins.Open(directory);
    using var lease = OpenImmutableLease(roots.Database);
    using var realm = AtBusyPhase("immutable-realm-open",()=>OpenRead(roots.Database));
    return BuildPlan(roots, lease, realm, selections.OrderBy(s=>Guid.Parse(s.ScoreId).ToString("D"),StringComparer.Ordinal).ToArray(), cancellation);
  }

  public static string Reconcile(LibrarySourceDeletionPlan plan, CancellationToken cancellation = default)
  {
    ValidatePlan(plan);
    using var roots = SourcePins.Open(plan.SourceDirectory);
    using var lease = OpenImmutableLease(roots.Database);
    if (roots.Identity != plan.RootIdentity || SourcePins.IdentityOf(lease.SafeFileHandle) != plan.DatabaseIdentity)
      return "conflict";
    using var realm = AtBusyPhase("immutable-realm-open",()=>OpenRead(roots.Database));
    ValidateWriteSchema(realm);
    if (SchemaFingerprint(realm) != plan.SchemaFingerprint || StoredSchemaVersion(realm) != plan.SchemaVersion) return "conflict";
    bool allBefore=true,allAfter=true;
    foreach(var record in plan.Records) {
      var score = realm.DynamicApi.Find("Score", (Guid?)Guid.Parse(record.ScoreId));
      if (score == null) return "missing";
      cancellation.ThrowIfCancellationRequested();
      string current = Fingerprint(realm, score, null);
      allBefore &= current == record.BeforeFingerprint;
      allAfter &= current == record.AfterFingerprint && score.DynamicApi.Get<bool>("DeletePending");
    }
    return allAfter ? "applied" : allBefore ? "unchanged" : "conflict";
  }

  public static async Task<LibrarySourceDeletionSession> Acquire(LibrarySourceDeletionPlan plan, CancellationToken cancellation)
  {
    cancellation.ThrowIfCancellationRequested();
    ValidatePlan(plan);
    if (SynchronizationContext.Current == null) throw new LibrarySourceException("unsupported-context");
    RefuseRunningClient("client-before-open");
    SourcePins? roots = null;
    FileStream? immutable = null, identityGuard = null;
    Realm? realm = null;
    Transaction? transaction = null;
    try
    {
      roots = SourcePins.Open(plan.SourceDirectory);
      immutable = OpenImmutableLease(roots.Database);
      // Realm can alter physical bookkeeping on a rolled-back open. Bind deletion to the exact
      // selected rows, schema and file identities; the preview's whole-file hash is audit evidence.
      if (roots.Identity != plan.RootIdentity || SourcePins.IdentityOf(immutable.SafeFileHandle) != plan.DatabaseIdentity)
        throw new LibrarySourceException("source-changed");
      using (var read = AtBusyPhase("immutable-realm-open",()=>OpenRead(roots.Database)))
      {
        ValidateWriteSchema(read);
        if (SchemaFingerprint(read) != plan.SchemaFingerprint || StoredSchemaVersion(read) != plan.SchemaVersion)
          throw new LibrarySourceException("unsupported-schema");
        VerifyRecords(read,plan);
      }
      LibraryNativeNoConversionPolicy.RequireInstalled();
      // Overlap handles, so there is never a gap in the deny-delete guard.
      identityGuard = AtBusyPhase("identity-guard-open",()=>new FileStream(roots.Database, FileMode.Open, FileAccess.Read, FileShare.ReadWrite));
      if (SourcePins.IdentityOf(identityGuard.SafeFileHandle) != plan.DatabaseIdentity) throw new LibrarySourceException("source-changed");
      immutable.Dispose(); immutable = null;
      cancellation.ThrowIfCancellationRequested();
      realm = AtBusyPhase("mutable-realm-open",()=>OpenMutable(roots.Database, plan.SchemaVersion));
      transaction = await BeginWriteWithDeadline(realm,cancellation);
      SourcePins.ValidateDatabaseHandle(identityGuard.SafeFileHandle);
      RefuseRunningClient("client-after-write-lock");
      ValidateWriteSchema(realm);
      if (SchemaFingerprint(realm) != plan.SchemaFingerprint || StoredSchemaVersion(realm) != plan.SchemaVersion ||
          roots.Identity != plan.RootIdentity || SourcePins.IdentityOf(identityGuard.SafeFileHandle) != plan.DatabaseIdentity)
        throw new LibrarySourceException("source-changed");
      VerifyRecords(realm,plan);
      var result = new LibrarySourceDeletionSession(plan, roots, identityGuard, realm, transaction);
      roots = null; identityGuard = null; realm = null; transaction = null;
      return result;
    }
    finally { transaction?.Dispose(); realm?.Dispose(); immutable?.Dispose(); identityGuard?.Dispose(); roots?.Dispose(); }
  }

  internal static async Task<Transaction> BeginWriteWithDeadline(Realm realm,CancellationToken cancellation) {
    using var admission=CancellationTokenSource.CreateLinkedTokenSource(cancellation);admission.CancelAfter(AdmissionMilliseconds);
    Transaction? transaction=null;
    try {
      try{transaction=await realm.BeginWriteAsync(admission.Token);}
      catch(OperationCanceledException)when(!cancellation.IsCancellationRequested){throw Busy("realm-write-admission-timeout","realm-write-lock");}
      cancellation.ThrowIfCancellationRequested();
      if(admission.IsCancellationRequested)throw Busy("realm-write-admission-timeout","realm-write-lock");
      var result=transaction;transaction=null;return result;
    }finally{transaction?.Dispose();}
  }
  internal static void RefuseRunningClient(string phase="held-client-check")
  {
    // Supplemental admission only. File identities and Realm transactions provide the actual coordination.
    LibraryClientProcessAdmission.Default.RefuseRunningClient(phase);
  }

  internal static void VerifyRecords(Realm realm,LibrarySourceDeletionPlan plan) {
    foreach(var record in plan.Records) {
      var score=realm.DynamicApi.Find("Score",(Guid?)Guid.Parse(record.ScoreId))??throw new LibrarySourceException("score-missing");
      if(Fingerprint(realm,score,null)!=record.BeforeFingerprint)throw new LibrarySourceException("source-changed");
    }
  }
  private static LibrarySourceDeletionPlan BuildPlan(SourcePins roots, FileStream lease, Realm realm, IReadOnlyList<LibrarySourceDeletionSelection> selections, CancellationToken cancellation)
  {
    ValidateWriteSchema(realm);
    var plan=new LibrarySourceDeletionPlan {
      SourceDirectory=roots.Directory,RootIdentity=roots.Identity,DatabaseIdentity=SourcePins.IdentityOf(lease.SafeFileHandle),
      DatabaseSha256=Hash(lease,cancellation),SchemaVersion=StoredSchemaVersion(realm),SchemaFingerprint=SchemaFingerprint(realm)
    };
    foreach(var selection in selections) plan.Records.Add(Describe(Guid.Parse(selection.ScoreId),selection.ExpectedReplaySha256));
    plan.Token=PlanToken(plan);return plan;
    LibrarySourceDeletionRecord Describe(Guid id,string? expected) {
    var score = realm.DynamicApi.Find("Score", (Guid?)id) ?? throw new LibrarySourceException("score-missing");
    var files = new List<LibrarySourceDeletionFile>();
    var usages = score.DynamicApi.GetList<IRealmObjectBase>("Files");
    if (usages.Count > 128) throw new LibrarySourceException("resource-limit");
    foreach (var usage in usages)
    {
      cancellation.ThrowIfCancellationRequested();
      string name = usage.DynamicApi.Get<string>("Filename");
      string hash = usage.DynamicApi.Get<IRealmObjectBase>("File")?.DynamicApi.Get<string>("Hash") ?? "";
      if (!IsHash(hash) || string.IsNullOrEmpty(name) || name.Length > 512 || name.Any(c => c < 32))
        throw new LibrarySourceException("invalid-source");
      files.Add(new(name, hash, Path.Combine(roots.Directory, "files", hash[..1], hash[..2], hash)));
    }
    var replayFiles = files.Where(f => f.Name.EndsWith(".osr", StringComparison.OrdinalIgnoreCase)).ToArray();
    string? replay = replayFiles.Length == 1 ? replayFiles[0].Sha256 : null;
    if (expected != null && replay != expected) throw new LibrarySourceException("source-changed");
    return new LibrarySourceDeletionRecord
    {
      ScoreId = id.ToString("D"),
      BeforeFingerprint = Fingerprint(realm, score, null), AfterFingerprint = Fingerprint(realm, score, true),
      WasDeletePending = score.DynamicApi.Get<bool>("DeletePending"), ReplaySha256 = replay, RetainedFiles = files,
    };
    }
  }

  private static string PlanToken(LibrarySourceDeletionPlan p) => Digest(JsonConvert.SerializeObject(new {
    p.Version,p.SourceDirectory,p.RootIdentity,p.DatabaseIdentity,p.DatabaseSha256,p.SchemaFingerprint,p.SchemaVersion,p.Records
  }, Protocol.JsonSettings));
  private static void ValidatePlan(LibrarySourceDeletionPlan plan)
  {
    if (plan == null || plan.Version != 1 || !SupportedSchemaVersion(plan.SchemaVersion) ||
        !new[] {plan.RootIdentity,plan.DatabaseIdentity,plan.DatabaseSha256,plan.SchemaFingerprint,plan.Token}.All(IsHash) ||
        plan.Records == null || plan.Records.Count is < 1 or > 128 || plan.Records.Any(r=>r == null || !Guid.TryParseExact(r.ScoreId,"D",out _) ||
          !IsHash(r.BeforeFingerprint) || !IsHash(r.AfterFingerprint) || r.RetainedFiles == null || r.RetainedFiles.Count > 128 ||
          r.RetainedFiles.Any(f=>f == null || !IsHash(f.Sha256) || f.Name == null || f.Name.Length > 512 || f.Path == null || f.Path.Length > 32768) ||
          r.ReplaySha256 != null && !IsHash(r.ReplaySha256)) ||
        plan.Records.Select(r=>r.ScoreId).Distinct(StringComparer.OrdinalIgnoreCase).Count()!=plan.Records.Count || PlanToken(plan) != plan.Token)
      throw new LibrarySourceException("invalid-source");
  }
  private static string Hash(FileStream file, CancellationToken token)
  {
    if(file.Length > maximumDatabaseBytes) throw new LibrarySourceException("resource-limit");
    file.Position=0; using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256); byte[] bytes=new byte[128*1024];
    int read; while((read=file.Read(bytes))>0) { token.ThrowIfCancellationRequested(); hash.AppendData(bytes,0,read); }
    return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
  }
  private static FileStream OpenImmutableLease(string path)
  {
    return SourcePins.OpenDatabaseLease(path);
  }
  internal static Realm OpenRead(string path) => OpenProtected(new RealmConfiguration(path) {
    IsDynamic=true,IsReadOnly=true,ShouldDeleteIfMigrationNeeded=false,MigrationCallback=null,ShouldCompactOnLaunch=null
  });
  private static Realm OpenMutable(string path,ulong version) => OpenProtected(new RealmConfiguration(path) {
    IsDynamic=true,SchemaVersion=version,ShouldDeleteIfMigrationNeeded=false,
    MigrationCallback=(_,_)=>throw new LibrarySourceException("unsupported-schema"),ShouldCompactOnLaunch=null
  });
  private static Realm OpenProtected(RealmConfiguration configuration) {
    LibraryNativeNoConversionPolicy.RequireInstalled();
    try{return Realm.GetInstance(configuration);}
    catch(Realms.Exceptions.RealmMigrationNeededException){throw LibraryNativeNoConversionPolicy.Unavailable();}
    catch(Realms.Exceptions.RealmException error)when(error.Message.StartsWith("hindsight-no-conversion:",StringComparison.Ordinal)) {
      throw LibraryNativeNoConversionPolicy.Unavailable();
    }
  }
  internal static ulong StoredSchemaVersion(Realm realm)
  {
    // The pinned public Config.SchemaVersion contains the requested value, not the stored version.
    // Fail closed if this exact installed accessor contract changes; never infer a writable version.
    if(typeof(Realm).Assembly.GetName().Version != new Version(20,1,0,0)) throw new LibrarySourceException("unsupported-schema");
    try {
      var handle=typeof(Realm).GetField("SharedRealmHandle",BindingFlags.Instance|BindingFlags.NonPublic)?.GetValue(realm);
      return handle?.GetType().GetMethod("GetSchemaVersion")?.Invoke(handle,null) is ulong version
        ? version : throw new LibrarySourceException("unsupported-schema");
    } catch(LibrarySourceException) {throw;} catch {throw new LibrarySourceException("unsupported-schema");}
  }
  internal static string SchemaFingerprint(Realm realm) => Digest(JsonConvert.SerializeObject(
    realm.Schema.OrderBy(s=>s.Name,StringComparer.Ordinal).Select(s=>new {
      s.Name,BaseType=(int)s.BaseType,Properties=s.OrderBy(p=>p.Name,StringComparer.Ordinal).Select(p=>new {
        p.Name,Type=(int)p.Type,p.ObjectType,p.IsPrimaryKey,IndexType=(int)p.IndexType,p.LinkOriginPropertyName
      })
    }),Protocol.JsonSettings));
  internal static void ValidateWriteSchema(Realm realm)
  {
    if(!SupportedSchemaVersion(StoredSchemaVersion(realm))) throw new LibrarySourceException("unsupported-schema");
    Require("Score","ID",PropertyType.Guid,null,true);
    Require("Score","DeletePending",PropertyType.Bool);
    Require("Score","Files",PropertyType.Object|PropertyType.Array,"RealmNamedFileUsage");
    Require("RealmNamedFileUsage","Filename",PropertyType.String|PropertyType.Nullable);
    Require("RealmNamedFileUsage","File",PropertyType.Object|PropertyType.Nullable,"File");
    Require("File","Hash",PropertyType.String,null,true,allowNullable:true);
    if(realm.Schema.First(s=>s.Name=="RealmNamedFileUsage").BaseType!=ObjectSchema.ObjectType.EmbeddedObject ||
       realm.Schema.First(s=>s.Name=="Score").BaseType!=ObjectSchema.ObjectType.RealmObject ||
       realm.Schema.First(s=>s.Name=="File").BaseType!=ObjectSchema.ObjectType.RealmObject) throw new LibrarySourceException("unsupported-schema");
    void Require(string owner,string name,PropertyType type,string? target=null,bool key=false,bool allowNullable=false) {
      if(!realm.Schema.TryFindObjectSchema(owner,out var schema)) throw new LibrarySourceException("unsupported-schema");
      var p=schema.FirstOrDefault(p=>p.Name==name);
      if(p.Name==null || (allowNullable ? p.Type & ~PropertyType.Nullable : p.Type)!=type ||
         p.ObjectType!=target || p.IsPrimaryKey!=key) throw new LibrarySourceException("unsupported-schema");
    }
  }
  internal static string Fingerprint(Realm realm,IRealmObjectBase score,bool? pendingOverride)
  {
    int budget=2048;
    var value=Object(score,realm.Schema.First(s=>s.Name=="Score"),0);
    string serialized=value.ToString(Formatting.None);
    if(Encoding.UTF8.GetByteCount(serialized)>512*1024) throw new LibrarySourceException("resource-limit");
    return Digest(serialized);
    JObject Object(IRealmObjectBase item,ObjectSchema schema,int depth) {
      if(depth>8 || --budget<0 || schema.Count>256) throw new LibrarySourceException("resource-limit");
      var obj=new JObject();
      foreach(var property in schema.OrderBy(p=>p.Name,StringComparer.Ordinal)) {
        if(property.Type.HasFlag(PropertyType.Set) || property.Type.HasFlag(PropertyType.Dictionary) ||
           (property.Type & ~PropertyType.Flags) is not (PropertyType.Int or PropertyType.Bool or PropertyType.String or
             PropertyType.Data or PropertyType.Date or PropertyType.Float or PropertyType.Double or PropertyType.Guid or PropertyType.Object))
          throw new LibrarySourceException("unsupported-schema");
        if(depth==0 && property.Name=="DeletePending" && pendingOverride.HasValue) {obj[property.Name]=pendingOverride.Value;continue;}
        if(property.Type.HasFlag(PropertyType.Array)) {
          var list=item.DynamicApi.GetList<RealmValue>(property.Name);
          if(list.Count>1024) throw new LibrarySourceException("resource-limit");
          obj[property.Name]=new JArray(list.Select(v=>Value(v,property,depth+1)));
        } else obj[property.Name]=Value(item.DynamicApi.Get<RealmValue>(property.Name),property,depth+1);
      }
      return obj;
    }
    JToken Value(RealmValue v,Property property,int depth) {
      if(--budget<0) throw new LibrarySourceException("resource-limit");
      switch(v.Type) {
        case RealmValueType.Null: return JValue.CreateNull();
        case RealmValueType.Bool:return new JValue(v.AsBool());
        case RealmValueType.Int:return new JObject{{"int",v.AsInt64().ToString(CultureInfo.InvariantCulture)}};
        case RealmValueType.String:
          string str=v.AsString()!;if(str.Length>65536)throw new LibrarySourceException("resource-limit");return new JValue(str);
        case RealmValueType.Guid:return new JObject{{"guid",v.AsGuid().ToString("D")}};
        case RealmValueType.Date:return new JObject{{"ticks",((DateTimeOffset)v).UtcTicks.ToString(CultureInfo.InvariantCulture)}};
        case RealmValueType.Double:return new JObject{{"doubleBits",BitConverter.DoubleToInt64Bits(v.AsDouble()).ToString("x16",CultureInfo.InvariantCulture)}};
        case RealmValueType.Float:return new JObject{{"floatBits",BitConverter.SingleToInt32Bits(v.AsFloat()).ToString("x8",CultureInfo.InvariantCulture)}};
        case RealmValueType.Data:
          byte[] data=v.AsData()!;if(data.Length>65536)throw new LibrarySourceException("resource-limit");return new JObject{{"data",Convert.ToBase64String(data)}};
        case RealmValueType.Object:
          var obj=v.AsIRealmObject(); var schema=realm.Schema.First(s=>s.Name==property.ObjectType);
          if(schema.BaseType==ObjectSchema.ObjectType.EmbeddedObject)return Object(obj,schema,depth);
          var keys=schema.Where(p=>p.IsPrimaryKey).ToArray();
          if(keys.Length!=1)throw new LibrarySourceException("unsupported-schema");
          return new JObject{{"type",schema.Name},{"key",Value(obj.DynamicApi.Get<RealmValue>(keys[0].Name),keys[0],depth+1)}};
        default:throw new LibrarySourceException("unsupported-schema");
      }
    }
  }

  internal sealed class SourcePins : IDisposable
  {
    private readonly List<SafeFileHandle> pins=[];
    public string Directory {get; private set;}="";
    public string Database=>Path.Combine(Directory,"client.realm");
    public string Identity {get; private set;}="";
    [StructLayout(LayoutKind.Sequential)] private struct IdInfo {public ulong Volume,Low,High;}
    [StructLayout(LayoutKind.Sequential)] private struct TagInfo {public uint Attributes,Tag;}
    [StructLayout(LayoutKind.Sequential)] private struct StandardInfo {public long AllocationSize,EndOfFile;public uint NumberOfLinks;public byte DeletePending,Directory;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,int kind,out IdInfo id,uint size);
    [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetTag(SafeFileHandle file,int kind,out TagInfo tag,uint size);
    [DllImport("kernel32.dll",EntryPoint="GetFileInformationByHandleEx",SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetStandard(SafeFileHandle file,int kind,out StandardInfo standard,uint size);
    public static SourcePins Open(string directory) {
      if(!OperatingSystem.IsWindows() || string.IsNullOrEmpty(directory) || directory.Length>32768 || !Path.IsPathFullyQualified(directory) ||
         directory.StartsWith(@"\\",StringComparison.Ordinal))throw new LibrarySourceException("invalid-source");
      var result=new SourcePins{Directory=Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory))};
      try {
        var paths=new List<string>();
        for(var current=new DirectoryInfo(result.Directory);current!=null;current=current.Parent)paths.Add(current.FullName);
        foreach(string path in paths.AsEnumerable().Reverse()) {
          var handle=CreateFile(path,0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
          if(handle.IsInvalid) {
            int error=Marshal.GetLastWin32Error();handle.Dispose();
            if(error is 32 or 33)throw Busy("windows-sharing-or-lock","root-open",error);
            throw new LibrarySourceException(error is 2 or 3?"source-missing":"inaccessible");
          }
          result.pins.Add(handle);
          if(!GetTag(handle,9,out var attributes,8) || (attributes.Attributes & 0x400)!=0 || (attributes.Attributes & 0x10)==0)
            throw new LibrarySourceException("invalid-source");
        }
        result.Identity=IdentityOf(result.pins[^1]);
        return result;
      }catch{result.Dispose();throw;}
    }
    public static string IdentityOf(SafeFileHandle handle) {
      if(!GetFileInformationByHandleEx(handle,18,out var id,(uint)Marshal.SizeOf<IdInfo>()))throw new LibrarySourceException("unsupported-filesystem");
      return Digest(FormattableString.Invariant($"{id.Volume}:{id.Low}:{id.High}"));
    }
    public static FileStream OpenDatabaseLease(string path) {
      // Open the leaf itself, not a reparse target. The handle denies write/delete before validating
      // attributes; checking the pathname before a normal FileStream open would leave a race.
      var handle=CreateFile(path,0x80000000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
      if(handle.IsInvalid) {
        int error=Marshal.GetLastWin32Error();handle.Dispose();
        if(error is 32 or 33)throw Busy("windows-sharing-or-lock","immutable-lease-open",error);
        throw new LibrarySourceException(error is 2 or 3?"source-missing":"inaccessible");
      }
      try {
        ValidateDatabaseHandle(handle);
        var lease=new FileStream(handle,FileAccess.Read);
        if(lease.Length>maximumDatabaseBytes){lease.Dispose();throw new LibrarySourceException("resource-limit");}
        return lease;
      }catch{handle.Dispose();throw;}
    }
    public static void ValidateDatabaseHandle(SafeFileHandle handle) {
      if(!GetTag(handle,9,out var attributes,8)||(attributes.Attributes&0x410)!=0 ||
         !GetStandard(handle,1,out var standard,(uint)Marshal.SizeOf<StandardInfo>()) || standard.DeletePending!=0 || standard.Directory!=0)
        throw new LibrarySourceException("invalid-source");
      if(standard.NumberOfLinks!=1)throw new LibrarySourceException("unsupported-hardlink");
    }
    public void Dispose(){for(int i=pins.Count-1;i>=0;i--)pins[i].Dispose();pins.Clear();}
  }
}

public sealed class LibrarySourceDeletionSession : IDisposable
{
  // Deterministic fixture injection only. The JSON protocol cannot set this hook; production leaves
  // it null. It exposes the exact boundary after final verification, before any selected-row writes.
  internal static Action? AfterFinalVerificationForFixture {get;set;}
  private readonly LibrarySourceDeletionPlan plan;
  private readonly LibrarySourceDeletion.SourcePins roots;
  private readonly FileStream guard;
  private readonly Realm realm;
  private Transaction? transaction;
  private bool committed;
  internal bool CommitMayHaveApplied {get;private set;}
  public string SessionToken {get;}=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
  internal LibrarySourceDeletionSession(LibrarySourceDeletionPlan p,LibrarySourceDeletion.SourcePins r,FileStream g,Realm db,Transaction tx)
  {plan=p;roots=r;guard=g;realm=db;transaction=tx;}
  public void Verify() {
    if(transaction==null || committed)throw new LibrarySourceException("invalid-state");
    LibrarySourceDeletion.RefuseRunningClient();
    LibrarySourceDeletion.SourcePins.ValidateDatabaseHandle(guard.SafeFileHandle);
    if(roots.Identity!=plan.RootIdentity || LibrarySourceDeletion.SourcePins.IdentityOf(guard.SafeFileHandle)!=plan.DatabaseIdentity ||
       LibrarySourceDeletion.SchemaFingerprint(realm)!=plan.SchemaFingerprint || LibrarySourceDeletion.StoredSchemaVersion(realm)!=plan.SchemaVersion)
      throw new LibrarySourceException("source-changed");
    LibrarySourceDeletion.VerifyRecords(realm,plan);
  }
  public void Commit(CancellationToken cancellation) {
    cancellation.ThrowIfCancellationRequested();Verify();
    AfterFinalVerificationForFixture?.Invoke();
    foreach(var record in plan.Records) realm.DynamicApi.Find("Score",(Guid?)Guid.Parse(record.ScoreId))!.DynamicApi.Set("DeletePending",true);
    cancellation.ThrowIfCancellationRequested();
    // Do not cancel receipt waiting once synchronous commit begins. Lost transport requires reconcile.
    CommitMayHaveApplied=true;
    transaction!.Commit();transaction.Dispose();transaction=null;committed=true;
    realm.Refresh();
    LibrarySourceDeletion.SourcePins.ValidateDatabaseHandle(guard.SafeFileHandle);
    foreach(var record in plan.Records) {
      var score=realm.DynamicApi.Find("Score",(Guid?)Guid.Parse(record.ScoreId));
      if(score==null || !score.DynamicApi.Get<bool>("DeletePending") || LibrarySourceDeletion.Fingerprint(realm,score,null)!=record.AfterFingerprint)
        throw new LibrarySourceException("commit-uncertain");
    }
  }
  public void Dispose(){transaction?.Dispose();transaction=null;realm.Dispose();guard.Dispose();roots.Dispose();}
}
