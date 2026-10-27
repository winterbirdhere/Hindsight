import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LibraryImportSummary, LibrarySourceKind, LibraryStatus } from "../../../../../shared/replay-library";
import type { LibraryViewSources, ReplayLibraryViewProps } from "./library-view-types";
import { SOURCE_LABELS } from "./library-view-types";
import { LibraryButton, LibraryDialog } from "./library-view-controls";
import { Segmented, SwitchRow } from "../settings/controls";

export function librarySourceNotFound(source: LibraryStatus["sources"][number]) {
  return (
    source.state === "error" &&
    source.kind === "lazer" &&
    source.configuration === "automatic" &&
    source.hasIndexHistory === false &&
    source.failureReason === "source-missing"
  );
}
export function librarySourceProblems(source: LibraryStatus["sources"][number]) {
  if (
    !source.enabled ||
    librarySourceNotFound(source) ||
    ["scanning", "queued", "waiting-for-viewer"].includes(source.state)
  )
    return [];
  const problems: { title: string; detail: string; raw?: string }[] = [];
  if (source.state === "error")
    problems.push(
      source.failureReason === "source-busy"
        ? {
            title: "Source database is busy",
            detail:
              "Hindsight couldn't read the source database while it was locked. Try scanning again. Already indexed replays stay listed.",
            raw: source.error,
          }
        : source.failureReason === "source-missing"
        ? {
            title: "Source data not found",
            detail: `Hindsight couldn't find the source data for ${
              SOURCE_LABELS[source.kind]
            }. Check its location. Already indexed replays stay listed.`,
            raw: source.error,
          }
        : {
            title: "Couldn't read this source",
            detail: `Hindsight couldn't finish reading ${
              SOURCE_LABELS[source.kind]
            }. Replays already indexed from it stay listed.`,
            raw: source.error,
          },
    );
  if (source.mapError)
    problems.push({
      title: "Beatmaps couldn't be matched",
      detail: "Some replay beatmaps couldn't be matched. Scan this source again to retry.",
      raw: source.mapError,
    });
  if (source.update.watchError)
    problems.push({
      title: "New replays won't appear automatically",
      detail: "Hindsight can't watch this source for changes. Use Scan now to pick up new replays.",
      raw: source.update.watchError,
    });
  return problems;
}
export function librarySourceStage(source: LibraryStatus["sources"][number]): string {
  if (source.state === "idle") return "Ready to check";
  if (source.state === "queued") return "Check queued";
  if (source.state === "waiting-for-viewer") return "Waiting for viewer";
  if (source.state === "stopped") return "Scan stopped";
  if (source.state === "error") return librarySourceNotFound(source) ? "Not found" : "Source unavailable";
  if (source.state === "complete") return "Check complete";
  if (source.progress?.phase === "reading-map-metadata") return "Reading beatmap data";
  if (source.progress?.phase === "committing") return "Saving source index";
  if (source.progress?.phase === "checking-replays")
    return source.progress.unit === "source-records" ? "Checking source records" : "Checking replay records";
  return "Checking sources";
}
export function librarySourceProgressText(source: LibraryStatus["sources"][number]): string {
  const stage = librarySourceStage(source),
    progress = source.progress;
  if (source.state !== "scanning") return stage;
  if (!progress)
    return `${stage} · ${source.observations.toLocaleString()} record${source.observations === 1 ? "" : "s"} read`;
  const count = progress.completed.toLocaleString(),
    amount = progress.total === undefined ? count : `${count} of ${progress.total.toLocaleString()}`,
    plural = (progress.total ?? progress.completed) !== 1;
  const units =
    progress.unit === "map-records"
      ? `map record${plural ? "s" : ""}`
      : progress.unit === "source-records"
      ? `source record${plural ? "s" : ""}`
      : `record${plural ? "s" : ""}`;
  return `${stage} · ${amount} ${units} ${progress.unit === "map-records" ? "read" : "checked"}`;
}
/** Source discovery and query readiness are distinct from optional numerical analysis. */
export function libraryIndexStatus(status: LibraryStatus | null): string {
  if (!status) return "Checking sources…";
  if (status.rebuild.state === "error") return "Rebuild didn't finish";
  const sources = status.sources.filter(
    (source) =>
      source.enabled &&
      !librarySourceNotFound(source) &&
      (source.kind !== "imported" || source.hasIndexHistory || source.state !== "idle"),
  );
  if (sources.some(source => librarySourceProblems(source).length > 0)) return "Source needs attention";
  if (status.indexMaintenance?.state === "error") return "Library needs attention";
  if (["scanning", "queued", "waiting-for-viewer"].includes(status.rebuild.state))
    return status.rebuild.state === "waiting-for-viewer" ? "Rebuild waiting for viewer" : "Rebuilding index";
  const scanning = sources.find(source => source.state === "scanning");
  if (scanning) return librarySourceStage(scanning);
  if (sources.some(source => source.state === "queued")) return "Library check queued";
  if (
    sources.some(source => source.state === "waiting-for-viewer") ||
    status.indexMaintenance?.state === "waiting-for-viewer"
  )
    return "Waiting for viewer";
  if (sources.some(source => source.state === "stopped") || status.rebuild.state === "stopped") return "Scan stopped";
  if (status.indexMaintenance && (!status.indexMaintenance.ready || status.indexMaintenance.pending > 0))
    return "Preparing library results";
  if (sources.length && sources.every(source => source.state === "complete")) return "Source check complete";
  return "Library ready";
}

/** Work counts have no fixed denominator and never imply that missing values are queued. */
export function libraryAnalysisStatus(sources: LibraryViewSources) {
  const activity = sources.status?.analysis;
  const counts = activity
    ? [
        { value: activity.running, label: "running" },
        { value: activity.held, label: "held" },
        { value: activity.retiring, label: "stopping" },
        { value: activity.queued, label: "queued" },
        { value: activity.awaitingInputs, label: "awaiting input preparation" },
        { value: activity.deferred, label: "deferred" },
        { value: activity.failed, label: "failed" },
      ].filter(count => count.value > 0)
    : [];
  const result = (title: string, detail = "", warning = false) => ({ title, detail, counts, warning });
  if (!activity && sources.analysisLoading) return result("Reading analysis status…");
  if (activity?.error) return result("Analysis needs attention", "Open Sources for the reported error.", true);
  const mode = activity?.mode ?? sources.analysis.mode;
  if (mode === "off")
    return result("Deep analysis Off", activity && (activity.running > 0 || activity.queued > 0 || activity.awaitingInputs > 0)
      ? "Other metric calculations can still run. Existing calculated values stay available."
      : "Existing calculated values stay available.");
  if (activity?.userPaused ?? sources.analysis.userPaused)
    return result("Deep analysis paused", "Resume analysis in Sources.");
  if (!activity)
    return result("Analysis status unavailable", "Current calculation activity could not be read.", true);
  if (activity.viewerHold) return result("Analysis waiting for viewer");
  if (activity.batteryHold) return result("Analysis waiting for external power");
  if (activity.resumePending) return result("Analysis resuming");
  if (activity.running > 0) return result("Calculating metrics");
  if (activity.retiring > 0) return result("Stopping calculations");
  if (activity.held > 0) return result("Calculations waiting");
  if (activity.queued > 0) return result("Calculations queued");
  if (activity.awaitingInputs > 0) return result("Calculations awaiting preparation");
  if (activity.failed > 0) return result("Some calculations failed", "Unavailable values stay blank.", true);
  if (activity.deferred > 0) return result("Calculations deferred", "Waiting for an enabled source or analysis mode.");
  if (mode === "demand") return result("Analysis on demand", "Select or open a replay to request its analysis.");
  return result("No calculations queued", "Missing metrics may be unavailable or not scheduled.");
}

export function LibraryAnalysisStatus({ sources, announce = true }: { sources: LibraryViewSources; announce?: boolean }) {
  const summary = libraryAnalysisStatus(sources);
  return (
    <>
      <section className="lib-analysis-status" aria-label="Analysis activity">
        <strong className={summary.warning ? "lib-warning" : undefined}>{summary.title}</strong>
        <div className="lib-analysis-detail">
          {summary.counts.length > 0 && (
            <div className="lib-analysis-counts">
              <span>Calculations</span>
              {summary.counts.map(count => (
                <span key={count.label} className={count.label === "failed" ? "lib-warning" : undefined}>
                  {count.value.toLocaleString()} {count.label}
                </span>
              ))}
            </div>
          )}
          {summary.detail && <p className="lib-note">{summary.detail}</p>}
        </div>
      </section>
      {announce && <span role="status" aria-label="Analysis activity" className="lib-sr">{summary.title}</span>}
    </>
  );
}
export function LibraryProblem({
  title,
  children,
  raw,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  raw?: string;
  danger?: boolean;
}) {
  return (
    <div className={`lib-problem${danger ? " lib-problem-danger" : ""}`} role="alert">
      <strong>{title}</strong>
      {children}
      {raw && (
        <details>
          <summary>Details</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </div>
  );
}

export function LibrarySources({
  sources,
  onSourceAction,
  onAnalysisSettings,
  onLocateStable,
  onClose,
}: Pick<ReplayLibraryViewProps, "sources" | "onSourceAction" | "onAnalysisSettings" | "onLocateStable"> & {
  onClose(): void;
}) {
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [importResult, setImportResult] = useState<LibraryImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const importReplays = async () => {
    setImportResult(null);
    setImportError("");
    setImporting(true);
    try {
      const result = await onSourceAction({ method: "import-replays" });
      if (mounted.current && result) setImportResult(result);
    } catch (error) {
      if (mounted.current) setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setImporting(false);
    }
  };
  const indexSection = useRef<HTMLElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmRebuild) indexSection.current?.querySelector<HTMLElement>("[data-rebuild-cancel]")?.focus();
    else if (wasConfirming.current) indexSection.current?.querySelector<HTMLElement>("[data-rebuild-trigger]")?.focus();
    wasConfirming.current = confirmRebuild;
  }, [confirmRebuild]);
  const status = sources.status;
  const rebuilding = !!status && ["scanning", "queued", "waiting-for-viewer"].includes(status.rebuild.state);
  const scanning = status?.sources.some(
    (s) => s.state === "scanning" || s.state === "queued" || s.state === "waiting-for-viewer",
  );
  const statusText = libraryIndexStatus(status);
  return (
    <LibraryDialog title="Sources" onClose={onClose}>
      <section className="lib-section">
        <strong>{statusText}</strong>
        <div>
          {status
            ? `${status.replayCount.toLocaleString()} replays from ${status.sources.length} sources`
            : "Source information is not available yet."}
        </div>
        <LibraryAnalysisStatus sources={sources} />
        {status?.analysis?.error && (
          <LibraryProblem title="Analysis couldn't continue" raw={status.analysis.error}>
            <p>The last reported calculation activity is shown above. Existing results stay available.</p>
          </LibraryProblem>
        )}
        {status?.indexMaintenance?.state === "error" && (
          <LibraryProblem title="Library preparation didn't finish" raw={status.indexMaintenance.error}>
            <p>Source checks and library preparation have separate outcomes. Details show the preparation error.</p>
          </LibraryProblem>
        )}
        <div className="lib-row">
          <LibraryButton
            className="lib-raised"
            disabled={!status || (!rebuilding && !status.sources.some((s) => s.enabled && s.kind !== "imported"))}
            onClick={() => {
              if (rebuilding) {
                onSourceAction({ method: "rebuild-stop" });
                return;
              }
              status?.sources
                .filter((s) => s.enabled && s.kind !== "imported")
                .forEach((s) => onSourceAction({ method: scanning ? "stop" : "scan", sourceId: s.sourceId }));
            }}
          >
            {rebuilding ? "Stop rebuild" : scanning ? "Stop scan" : "Scan now"}
          </LibraryButton>
          <LibraryButton
            disabled={sources.analysisLoading}
            onClick={() => onAnalysisSettings({ ...sources.analysis, userPaused: !sources.analysis.userPaused })}
          >
            {sources.analysisLoading
              ? "Reading analysis settings…"
              : sources.analysis.userPaused
              ? "Resume analysis"
              : "Pause analysis"}
          </LibraryButton>
        </div>
        {sources.error && (
          <LibraryProblem title="The library action didn't finish." raw={sources.error}>
            <p>Check Details for the reported error. You can retry the source connection to read its current status.</p>
            <LibraryButton className="lib-raised" onClick={() => onSourceAction({ method: "retry" })}>
              Retry source connection
            </LibraryButton>
          </LibraryProblem>
        )}
      </section>
      <section className="lib-section">
        <h2 className="lib-label">Where replays come from</h2>
        {(Object.keys(SOURCE_LABELS) as LibrarySourceKind[]).map((kind) => {
          const matching = status?.sources.filter((s) => s.kind === kind) ?? [];
          return (
            <div key={kind} style={{ padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
              {matching.length > 0 && kind !== "imported" ? (
                <SwitchRow
                  focusOnPointer
                  label={SOURCE_LABELS[kind]}
                  checked={matching.some((s) => s.enabled)}
                  onChange={(enabled) =>
                    matching.forEach((s) => onSourceAction({ method: "source-enabled", sourceId: s.sourceId, enabled }))
                  }
                />
              ) : (
                <strong style={{ fontWeight: 500 }}>{SOURCE_LABELS[kind]}</strong>
              )}
              {matching.map((source) => (
                <div key={source.sourceId}>
                  <div className="lib-mono lib-muted" style={{ overflowWrap: "anywhere", marginTop: 4 }}>
                    {source.directory}
                  </div>
                  <p className="lib-note" style={{ margin: "4px 0" }}>
                    {librarySourceProgressText(source)}
                  </p>
                  {librarySourceProblems(source).map((problem) => (
                    <LibraryProblem key={problem.title} title={problem.title} raw={problem.raw}>
                      <p>{problem.detail}</p>
                      <LibraryButton
                        className="lib-raised"
                        onClick={() => onSourceAction({ method: "scan", sourceId: source.sourceId })}
                      >
                        Scan now
                      </LibraryButton>
                    </LibraryProblem>
                  ))}
                </div>
              ))}
              {!matching.length && kind !== "imported" && (
                <p className="lib-note">{status ? "Not configured" : "Checking source…"}</p>
              )}
              {kind === "lazer" && (
                <LibraryButton className="lib-raised" onClick={() => onSourceAction({ method: "locate-lazer" })}>
                  Locate osu!lazer…
                </LibraryButton>
              )}
              {(kind === "stable" || kind === "replays") && (
                <LibraryButton className="lib-raised" onClick={onLocateStable}>
                  Locate osu! stable…
                </LibraryButton>
              )}
              {kind === "imported" && (
                <>
                  <p className="lib-note">
                    Opens a file picker for .osr files. Hindsight keeps its own copy; your originals stay unchanged.
                  </p>
                  <LibraryButton className="lib-raised" disabled={importing} onClick={() => void importReplays()}>
                    {importing ? "Importing replays…" : "Import replays…"}
                  </LibraryButton>
                  <div className={importResult ? "lib-problem" : undefined}>
                    <p role="status" aria-label="Replay import" className={importResult ? undefined : "lib-sr"}>
                      {importResult && (
                        <>
                          Imported {importResult.added.toLocaleString()} {importResult.added === 1 ? "replay" : "replays"}.{" "}
                          {importResult.alreadyImported.toLocaleString()} {importResult.alreadyImported === 1 ? "was" : "were"} already in your library.{" "}
                          {importResult.failed.toLocaleString()} couldn't be imported.
                        </>
                      )}
                    </p>
                    {importResult && (
                      <>
                        {importResult.failures.map((failure, index) => (
                          <div key={index}>
                            <span>{failure.path.split(/[\\/]/).pop()} · Couldn't import this file.</span>
                            <details>
                              <summary>Details</summary>
                              <pre>{failure.error}</pre>
                            </details>
                          </div>
                        ))}
                        {importResult.truncatedFailures && <p>Further file failures aren't listed.</p>}
                        {importResult.alreadyImported > 0 && (
                          <p>
                            {importResult.alreadyImported.toLocaleString()} duplicate {importResult.alreadyImported === 1 ? "replay was" : "replays were"} already in your
                            library.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {importError && (
                    <LibraryProblem title="The import didn't finish." raw={importError}>
                      <p>Try importing the replays again.</p>
                    </LibraryProblem>
                  )}
                </>
              )}
            </div>
          );
        })}
      </section>
      <section className="lib-section">
        <h2 className="lib-label">Find new replays</h2>
        <Segmented
          focusOnPointer
          selectionAppearance="accent"
          label="Find new replays"
          value={status?.updateMode ?? "unavailable"}
          width={360}
          disabled={!status}
          options={[
            { value: "auto", label: "Automatic" },
            { value: "launch", label: "On launch" },
            { value: "manual", label: "Manual" },
          ]}
          onChange={(value) => {
            if (value === "auto" || value === "launch" || value === "manual")
              onSourceAction({ method: "update-mode", mode: value });
          }}
        />
        <p className="lib-note">
          {status?.updateMode === "auto"
            ? "New replays show up after osu! saves them. Hindsight reads what changed."
            : status?.updateMode === "launch"
            ? "Check connected sources when Hindsight starts."
            : "Use Scan now to check connected sources."}
        </p>
      </section>
      <section className="lib-section">
        <h2 className="lib-label">Background work</h2>
        {sources.analysisLoading && (
          <p className="lib-note" role="status">
            Reading analysis settings…
          </p>
        )}
        <div hidden={sources.analysisLoading}>
          <div>Deep analysis</div>
          <p className="lib-note">Peak PP, UR and error strips need each replay simulated in full.</p>
          <Segmented
            focusOnPointer
            selectionAppearance="accent"
            label="Deep analysis mode"
            value={sources.analysis.mode}
            width={360}
            options={[
              { value: "bg", label: "Background" },
              { value: "demand", label: "On demand" },
              { value: "off", label: "Off" },
            ]}
            onChange={(mode) => onAnalysisSettings({ ...sources.analysis, mode })}
          />
          <p className="lib-note">
            {sources.analysis.mode === "off"
              ? "Existing analysis stays available. Missing results stay unknown."
              : sources.analysis.mode === "demand"
              ? "Analyse replays when requested."
              : "Works through the library while Hindsight is idle, newest replays first, at the lowest priority."}
          </p>
          <p className="lib-note" style={{ background: "rgba(255,255,255,.03)", borderRadius: 7, padding: 12 }}>
            <strong style={{ color: "#f5f4f1" }}>The viewer comes first.</strong> While you use the viewer, library work
            steps aside on its own. Analysis of the replay you’re watching is separate and isn’t held up.
          </p>
          <SwitchRow
            focusOnPointer
            label="Pause on battery power"
            checked={sources.analysis.pauseOnBattery}
            onChange={(pauseOnBattery) => onAnalysisSettings({ ...sources.analysis, pauseOnBattery })}
          />
          <SwitchRow
            focusOnPointer
            label="Maximum speed"
            hint="Uses up to the selected analysis threads for replay processing, with more CPU and memory use. Off by default; the viewer still takes priority."
            checked={sources.analysis.fasterProcessing === true}
            onChange={(fasterProcessing) => onAnalysisSettings({ ...sources.analysis, fasterProcessing })}
          />
          <div className="lib-row lib-analysis-workers">
            <span className="lib-spacer">Analysis threads</span>
            <Segmented
              focusOnPointer
              selectionAppearance="accent"
              label="Analysis threads"
              value={String(sources.analysis.workers)}
              width={130}
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
                { value: "4", label: "4" },
              ]}
              onChange={(workers) => onAnalysisSettings({ ...sources.analysis, workers: Number(workers) as 1 | 2 | 4 })}
            />
          </div>
          <p className="lib-note">Maximum concurrent analysis jobs. More threads can use more CPU while the library is open.</p>
        </div>
      </section>
      <section className="lib-section" ref={indexSection}>
        <h2 className="lib-label">Index</h2>
        <div className="lib-row">
          <span className="lib-spacer">Stored index</span>
          <span className="lib-mono">
            {sources.storedBytes === undefined ? "—" : `${(sources.storedBytes / 1024 / 1024).toFixed(1)} MB`}
          </span>
        </div>
        <div className="lib-row">
          <span className="lib-spacer">Last full check</span>
          <span className="lib-mono">
            {sources.lastFullCheck === undefined ? "—" : new Date(sources.lastFullCheck).toLocaleString()}
          </span>
        </div>
        {confirmRebuild ? (
          <div
            role="group"
            aria-label="Confirm rebuild"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setConfirmRebuild(false);
              }
            }}
          >
            <p>Rebuild the replay index from the connected sources?</p>
            <div className="lib-row">
              <LibraryButton data-rebuild-cancel onClick={() => setConfirmRebuild(false)}>
                Cancel
              </LibraryButton>
              <LibraryButton
                className="lib-danger"
                disabled={rebuilding}
                onClick={() => {
                  onSourceAction({ method: "rebuild" });
                  setConfirmRebuild(false);
                }}
              >
                Rebuild index
              </LibraryButton>
            </div>
          </div>
        ) : (
          <LibraryButton
            className="lib-danger"
            data-rebuild-trigger
            disabled={rebuilding}
            style={{ marginTop: 20 }}
            onClick={() => setConfirmRebuild(true)}
          >
            Rebuild index…
          </LibraryButton>
        )}
        {status?.rebuild.state === "error" && (
          <LibraryProblem title="The last rebuild didn't finish." raw={status.rebuild.error} danger>
            <p>Hindsight couldn't finish rebuilding the index. Check Sources before trying again.</p>
          </LibraryProblem>
        )}
      </section>
    </LibraryDialog>
  );
}
