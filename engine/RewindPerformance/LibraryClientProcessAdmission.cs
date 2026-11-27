// SPDX-License-Identifier: MIT
using System.Diagnostics;

namespace RewindPerformance;

/// <summary>Conservative closed-client policy, not a process-start lock or a live-write protocol.
/// Candidate injection is internal and per instance; production always uses the real default.</summary>
internal sealed class LibraryClientProcessAdmission
{
  private readonly Func<IEnumerable<Process>> candidates;
  internal LibraryClientProcessAdmission(Func<IEnumerable<Process>> candidates){this.candidates=candidates??throw new ArgumentNullException(nameof(candidates));}
  internal static readonly LibraryClientProcessAdmission Default=new(KnownClients);

  private static IEnumerable<Process> KnownClients()
  {
    foreach(string name in new[]{"osu!","osu"})
      foreach(var process in Process.GetProcessesByName(name))yield return process;
  }

  // Preserve native deletion's existing process policy, exceptions and bounded diagnostic.
  internal void RefuseRunningClient(string phase)
  {
    foreach(var process in candidates())
      using(process){if(!process.HasExited)throw LibrarySourceDeletion.Busy("supplemental-client-check",phase);}
  }

  internal void RequireClosed()
  {
    try{RefuseRunningClient("held-client-check");}
    catch(LibrarySourceException error)when(error.Status=="source-busy"){throw;}
    catch(Exception){throw LibrarySourceDeletion.Busy("source-busy","native-operation");}
  }
}
