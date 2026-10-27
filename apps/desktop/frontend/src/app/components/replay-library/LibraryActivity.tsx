import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LibraryStatus } from "../../../../../shared/replay-library";
import { RewindLogo } from "../logo/RewindLogo";
import { libraryAnalysisStatus, libraryIndexStatus, librarySourceNotFound, librarySourceProblems, librarySourceStage } from "./LibrarySources";
import { LibraryButton, LibraryIcon, useLibraryFocusTrap, useLibraryMediaQuery } from "./library-view-controls";
import { SOURCE_LABELS, type LibraryViewSources } from "./library-view-types";

type Lane = "active" | "calm" | "paused" | "complete" | "ready" | "warning" | "broken" | "idle";
export interface LibraryActivityModel {
  title: string;
  detail: string;
  lane: Lane;
  phase?: string;
  completed?: number;
  total?: number;
  warning?: boolean;
}
export function libraryActivitySources(status: LibraryStatus | null) {
  return status?.sources.filter(source => source.enabled && !librarySourceNotFound(source) &&
    (source.kind !== "imported" || source.hasIndexHistory || source.state !== "idle")) ?? [];
}
/** Source records may have denominators; calculation work never does. */
export function libraryActivityModel(sources: LibraryViewSources, loading = false, completed = false, listedCount?: number): LibraryActivityModel {
  const status = sources.status, records = libraryActivitySources(status), index = libraryIndexStatus(status);
  const result = (title: string, detail: string, lane: Lane, warning = false): LibraryActivityModel => ({ title, detail, lane, warning });
  if (!status && sources.error) return result("Library status unavailable", "Open Sources for details", "broken", true);
  if (!status || loading)
    return result("Loading your library", "Opening saved results", "active");
  const ready = status.indexMaintenance?.ready !== false;
  if (status.rebuild.state === "error") return result("Rebuild didn't finish", "Open Sources for details", "broken", true);
  const problem = records.find(source => librarySourceProblems(source).length);
  if (problem) return result(ready ? "Library ready" : "Source needs attention", problem.state === "error" ? `${SOURCE_LABELS[problem.kind]} can't be read` : librarySourceProblems(problem)[0].title, "broken", true);
  if (status.indexMaintenance?.state === "error") return result("Library needs attention", "Preparing results didn't finish", "broken", true);
  if (index === "Rebuild waiting for viewer") return result("Rebuild waiting for viewer", "Resumes after playback", "paused");
  const scanning = records.find(source => source.state === "scanning");
  if (scanning) {
    const progress = scanning.progress;
    const count = progress?.completed ?? scanning.observations;
    const total = progress?.total;
    const unit = progress?.unit === "map-records" ? "map records" : progress?.unit === "source-records" ? "source records" : "records";
    return {
      title: progress?.phase === "committing" ? `Saving ${SOURCE_LABELS[scanning.kind]}` : `Checking ${SOURCE_LABELS[scanning.kind]}`,
      detail: total !== undefined && total > 0 ? `${count.toLocaleString()} of ${total.toLocaleString()} ${unit}` : `${count.toLocaleString()} ${unit} read`,
      lane: "active", phase: `${scanning.sourceId}:${progress?.phase ?? "read"}:${progress?.unit ?? "records"}`,
      completed: total !== undefined && total > 0 ? count : undefined,
      total: total !== undefined && total > 0 ? total : undefined,
    };
  }
  if (index === "Rebuilding index") return result(index, "Checking connected sources", "active");
  if (index === "Library check queued") return result(index, "Waiting to check connected sources", "paused");
  if (index === "Waiting for viewer") return result("Waiting for the viewer", "Source checks resume after playback", "paused");
  if (index === "Scan stopped") return result(index, "Resume in Sources", "paused");
  if (index === "Preparing library results") return result(index, "Opening indexed replays", "active");
  if (sources.error) return result("A library action needs attention", "Open Sources for details", "broken", true);
  if (completed) return result("Sources checked", listedCount === undefined ? "Connected source checks finished" : `${listedCount.toLocaleString()} ${listedCount === 1 ? "replay" : "replays"} listed`, "complete");
  const activity = status.analysis, analysis = libraryAnalysisStatus(sources);
  if (!activity && sources.analysisLoading) return result("Reading analysis status…", "Current activity is not available yet", "idle");
  if (activity?.error || (!activity && !sources.analysisLoading && sources.analysis.mode !== "off" && !sources.analysis.userPaused))
    return result(analysis.title, analysis.detail, "broken", true);
  if (activity?.mode === "off" || (!activity && sources.analysis.mode === "off"))
    return result("Deep analysis Off", activity?.running ? "Other metrics still calculating"
      : activity?.retiring ? "Current calculations are stopping"
      : activity?.viewerHold ? "Other work is waiting for the viewer"
      : activity?.batteryHold ? "Other work is waiting for external power"
      : activity?.userPaused || activity?.held ? "Other calculation work is held"
      : activity && (activity.queued || activity.awaitingInputs) ? "Other metric calculations are waiting"
      : "Existing results stay available", activity?.running ? "calm" : "idle");
  if (activity?.userPaused ?? sources.analysis.userPaused) return result("Calculations paused", "Resume in Sources", "paused");
  if (activity?.viewerHold) return result("Waiting for the viewer", "Resumes after playback", "paused");
  if (activity?.batteryHold) return result("Waiting for external power", "Calculations paused on battery", "paused");
  if (activity?.resumePending) return result("Calculations resuming", "Waiting for the worker to resume", "paused");
  if (activity?.running) return result(ready ? "Library ready" : "Calculating metrics", "Metrics still calculating", "calm");
  if (activity?.retiring) return result("Stopping calculations", "Waiting for current work to stop", "paused");
  if (activity?.held) return result("Calculations waiting", "Current work is held", "paused");
  if (activity?.queued || activity?.awaitingInputs) return result(ready ? "Library ready" : "Calculations queued", "Metrics waiting to calculate", "calm");
  if (activity?.deferred) return result("Calculations deferred", "Waiting for an enabled source or mode", "paused");
  if (activity?.failed) return result(ready ? "Library ready" : "Some calculations failed", "Some metric values remain unavailable", "warning", true);
  if (activity?.mode === "demand") return result(ready ? "Library ready" : "Analysis on demand", "Calculations run when requested", "idle");
  // This describes the source index, not a promise that every optional metric exists.
  const checked = records.length > 0 && records.every(source => source.state === "complete");
  return result(checked ? "Library up to date" : "Library ready",
    listedCount === undefined ? "Replay count unavailable" : `${listedCount.toLocaleString()} ${listedCount === 1 ? "replay" : "replays"}`, checked ? "complete" : "ready");
}

// ExportSprint's geometry scaled to a 112 × 30 lane. Direct style writes keep
// polling, animation and React renders independent.
const STREAKS = Array.from({ length: 7 }, (_, i) => ({ y: 3 + (i * 7) % 18, len: 7 + (i * 11) % 16, speed: .10 + (i * 3) % 10 / 80, phase: (i * 31) % 112 }));
export function LibraryActivityLane({ model }: { model: LibraryActivityModel }) {
  const reduced = useLibraryMediaQuery("(prefers-reduced-motion: reduce)", false);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const record = useRef<HTMLDivElement>(null), trail = useRef<HTMLDivElement>(null), streaks = useRef<(HTMLSpanElement | null)[]>([]);
  const latest = useRef(model); latest.current = model;
  const moving = model.lane === "active" || model.lane === "calm";
  const fraction = model.total ? Math.min(1, Math.max(0, (model.completed ?? 0) / model.total)) : undefined;
  const x = fraction !== undefined ? fraction * 90 : model.lane === "complete" ? 90 : ["active", "calm", "paused"].includes(model.lane) ? 52 : 0;
  const trailWidth = model.lane === "complete" ? 112 : fraction !== undefined ? x + 11 : 30;
  const trailLeft = fraction !== undefined || model.lane === "complete" ? 0 : x - 19;
  const position = useRef({ x, trail: trailWidth, phase: model.phase ?? model.lane, maximum: x, angle: 0 });
  useLayoutEffect(() => {
    // React owns static/reduced positions; one RAF owns moving positions. Seed
    // before paint so mounting at 52px cannot jump back from an unseeded zero.
    position.current = { x, trail: trailWidth, phase: model.phase ?? model.lane, maximum: x, angle: 0 };
    if (record.current) record.current.style.left = `${x}px`;
    if (trail.current) { trail.current.style.width = `${trailWidth}px`; trail.current.style.left = `${trailLeft}px`; }
    // Polling values must not reset the animation's monotonic phase position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, reduced]);
  useEffect(() => {
    if (reduced || !moving || !visible) return;
    let frame = 0, last = performance.now(), elapsed = 0;
    const tick = (now: number) => {
      const dt = Math.min(64, Math.max(0, now - last)); last = now; elapsed += dt;
      const current = latest.current, state = position.current;
      const phase = current.phase ?? current.lane;
      if (state.phase !== phase) { state.phase = phase; state.maximum = 0; }
      const determinate = current.total !== undefined;
      const requested = determinate ? Math.min(1, Math.max(0, (current.completed ?? 0) / (current.total ?? 1))) * 90
        : current.lane === "complete" ? 90 : 52;
      state.maximum = determinate ? Math.max(state.maximum, requested) : requested;
      const ease = 1 - Math.pow(.86, dt / 16);
      state.x += (state.maximum - state.x) * ease;
      const trailTarget = current.lane === "complete" ? 112 : determinate ? state.x + 11 : 30;
      state.trail += (trailTarget - state.trail) * ease;
      state.angle = (state.angle + dt * (current.lane === "active" ? .7 : current.lane === "calm" ? .25 : 0)) % 360;
      if (record.current) { record.current.style.left = `${state.x}px`; record.current.style.transform = `rotate(${state.angle}deg)`; }
      if (trail.current) { trail.current.style.width = `${state.trail}px`; trail.current.style.left = `${determinate || current.lane === "complete" ? 0 : Math.max(0, state.x + 11 - state.trail)}px`; }
      STREAKS.forEach((s, i) => {
        const element = streaks.current[i]; if (!element) return;
        const left = 112 - ((elapsed * s.speed + s.phase) % (112 + s.len));
        element.style.transform = `translateX(${left}px)`;
        element.style.opacity = String((left + s.len < state.x + 11 ? 1 : .35) * (current.lane === "calm" ? .4 : 1));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [moving, reduced, visible]);
  return <div className={`lib-activity-lane lib-lane-${model.lane}`} role="progressbar" aria-label="Library activity"
    aria-valuemin={model.total ? 0 : undefined} aria-valuemax={model.total}
    aria-valuenow={model.total ? Math.min(model.total, Math.max(0, model.completed ?? 0)) : undefined}
    aria-valuetext={`${model.title}. ${model.detail}`}>
    {!reduced && (model.lane === "active" || model.lane === "calm") && STREAKS.map((s, i) =>
      <span key={i} className="lib-activity-streak" data-pink={i % 4 === 0} ref={el => { streaks.current[i] = el; }} style={{ top: s.y, width: s.len }} />)}
    <div className="lib-activity-track" />
    <div className="lib-activity-trail" ref={trail} style={reduced || !moving ? { width: trailWidth, left: trailLeft } : undefined} />
    <div ref={record} className="lib-activity-record" aria-hidden="true" style={reduced || !moving ? { left: x, transform: "none" } : undefined}>
      <RewindLogo variant={model.lane === "broken" ? "broken" : "static"} size={22} />
    </div>
    <span className="lib-activity-outcome lib-activity-complete" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" /><path d="m5 10 3 3 7-7" /></svg></span>
    <span className="lib-activity-outcome lib-activity-ready" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" /><path d="M10 9v6 M10 5v1" /></svg></span>
    <span className="lib-activity-outcome lib-activity-outcome-warning" aria-hidden="true"><WarningIcon size={20} /></span>
  </div>;
}

/** Same step marks as ExportProgress; this module has no export-manager dependency. */
function StepMark({ state }: { state: "done" | "active" | "pending" | "warning" }) {
  return <span aria-hidden="true" className={`lib-activity-mark lib-mark-${state}`}>{state === "done" ?
    <svg width="12" height="12" viewBox="0 0 12 12"><path d="m2 6.5 3 2.5 5-6" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
    : state === "warning" ? <WarningIcon /> : <i />}</span>;
}
function WarningIcon({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true"><path d="m6 1 5 9H1Z M6 4v3 M6 8v.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>;
}
export function LibraryActivity({ sources, loading, listedCount, announce = true, onOpenSources }: {
  sources: LibraryViewSources; loading?: boolean; listedCount?: number; announce?: boolean; onOpenSources(event?: { currentTarget: HTMLButtonElement }): void;
}) {
  const [open, setOpen] = useState(false), [complete, setComplete] = useState(false);
  const button = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null), previous = useRef(false);
  const id = useId(), status = sources.status, records = libraryActivitySources(status);
  const active = !!status && (["scanning", "queued", "waiting-for-viewer"].includes(status.rebuild.state) || records.some(source => ["scanning", "queued", "waiting-for-viewer"].includes(source.state)));
  const finished = !!status && records.length > 0 && records.every(source => source.state === "complete") &&
    !["error", "scanning", "queued", "waiting-for-viewer", "stopped"].includes(status.rebuild.state) && libraryIndexStatus(status) === "Source check complete";
  useEffect(() => {
    if (previous.current && !active && finished) { setComplete(true); previous.current = false; }
    if (active || !finished) setComplete(false);
    if (active) previous.current = true;
    if (status?.rebuild.state === "error" || status?.rebuild.state === "stopped" || records.some(source => source.state === "error" || source.state === "stopped")) previous.current = false;
    // Active source work may finish before query maintenance becomes ready.
    // Keep the observed transition across that separate preparation stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, finished, status?.rebuild.state, records.map(source => source.state).join(",")]);
  useEffect(() => {
    if (!complete) return;
    const timeout = setTimeout(() => setComplete(false), 2400);
    return () => clearTimeout(timeout);
  }, [complete]);
  const close = () => { setOpen(false); button.current?.focus(); };
  useLibraryFocusTrap(popover, open);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); setOpen(false); button.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  const model = libraryActivityModel(sources, loading, complete, listedCount), activity = status?.analysis;
  const failedSources = records.filter(source => librarySourceProblems(source).length).length;
  const failed = activity?.failed ?? 0;
  const otherProblem = sources.error || status?.rebuild.state === "error" || status?.indexMaintenance?.state === "error" || activity?.error;
  const calculationRows = activity ? [
    ["Running", activity.running, "active"], ["Queued", activity.queued, "pending"],
    ["Awaiting input preparation", activity.awaitingInputs, "pending"], ["Held", activity.held, "pending"],
    ["Stopping", activity.retiring, "pending"], ["Deferred", activity.deferred, "pending"], ["Failed", activity.failed, "warning"],
  ] as const : [];
  return <section className="lib-activity" aria-label="Library activity">
    <LibraryActivityLane model={model} />
    <div className="lib-activity-copy">
      <div className="lib-activity-title" title={model.title}>{model.title}</div>
      <div className={`lib-activity-detail${model.warning ? " lib-warning" : ""}`} title={model.detail}>{model.detail}</div>
    </div>
    {announce && <span className="lib-sr" role="status" aria-label="Library activity">{model.title}</span>}
    {(failedSources > 0 || failed > 0 || otherProblem) && <LibraryButton className="lib-activity-warning" aria-label="Show library problems" onClick={() => setOpen(true)}>
      <WarningIcon />{[failedSources ? `${failedSources} ${failedSources === 1 ? "source" : "sources"}` : "", failed ? `${failed.toLocaleString()} failed` : "", otherProblem ? "Needs attention" : ""].filter(Boolean).join(" · ")}
    </LibraryButton>}
    <button ref={button} type="button" className="lib-button lib-activity-toggle" aria-label="Library activity details" aria-expanded={open} aria-haspopup="dialog" aria-controls={id} onClick={() => open ? close() : setOpen(true)}><LibraryIcon name="down" /></button>
    {open && <>
      <button type="button" className="lib-activity-outside" aria-label="Close library activity details" tabIndex={-1} onClick={close} />
      <div id={id} ref={popover} role="dialog" aria-modal="true" aria-label="Library activity details" className="lib-activity-popover" tabIndex={-1}>
        <h2 className="lib-label">Sources</h2>
        {status?.sources.map(source => {
          const problem = librarySourceProblems(source).length > 0;
          const value = !source.enabled ? "Disabled" : librarySourceNotFound(source) ? "Not found" : problem ? source.state === "error" ? "Can't be read" : "Needs attention" : source.state === "complete" ? "Checked"
            : source.state === "queued" ? "Queued" : source.state === "waiting-for-viewer" ? "Waiting"
            : source.state === "scanning" && source.progress?.total ? `${source.progress.completed.toLocaleString()} / ${source.progress.total.toLocaleString()}` : librarySourceStage(source);
          const mark = problem ? "warning" : source.enabled && source.state === "complete" ? "done" : source.enabled && source.state === "scanning" ? "active" : "pending";
          return <div className="lib-activity-row" key={source.sourceId}><StepMark state={mark} /><span>{SOURCE_LABELS[source.kind]}</span><span title={source.state === "scanning" ? librarySourceStage(source) : undefined}>{value}</span></div>;
        })}
        {!status && <p className="lib-note">Source status is not available yet.</p>}
        {status && libraryIndexStatus(status) !== "Source check complete" && <p className="lib-note">{libraryIndexStatus(status)}</p>}
        <h2 className="lib-label">Background calculations</h2>
        <p className="lib-note">{libraryAnalysisStatus(sources).title}</p>
        {calculationRows.filter(([, count]) => count > 0).map(([label, count, mark]) => <div className={`lib-activity-row${mark === "warning" ? " lib-warning" : ""}`} key={label}><StepMark state={mark} /><span>{label}</span><span>{count.toLocaleString()}</span></div>)}
        {activity && calculationRows.every(([, count]) => count === 0) && <p className="lib-note">Nothing running</p>}
        {activity?.error && <p className="lib-warning">{activity.error}</p>}
        <p className="lib-note">These count calculation jobs, not replays: one replay can need several. Some values may never be calculated; those stay blank.</p>
        <div className="lib-activity-footer"><LibraryButton onClick={() => { setOpen(false); onOpenSources(button.current ? { currentTarget: button.current } : undefined); }}>Open Sources</LibraryButton></div>
      </div>
    </>}
  </section>;
}
