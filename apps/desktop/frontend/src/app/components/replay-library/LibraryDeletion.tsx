import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from "react";
import type { LibraryDeletionResult } from "../../../../../shared/library-deletion";
import type { LibraryStatus } from "../../../../../shared/replay-library";
import { LibraryButton, LibraryDialog } from "./library-view-controls";
import { SOURCE_LABELS, type LibraryDeletionOperation, type LibraryDeletionPendingView, type LibraryDeletionUiAction } from "./library-view-types";

type Action = (action: LibraryDeletionUiAction, anchor?: HTMLElement) => void;
const unresolved = (result?: LibraryDeletionResult) => result && ["partial", "committing", "recovery-required", "cleanup-required"].includes(result.state);
// The backend preserves this status marker in the existing diagnostic strings.
const nativeWriteHeld = (operation: LibraryDeletionOperation) => [operation.error, ...(operation.result?.blockers ?? []),
  ...(operation.result?.targets.map(target => target.detail) ?? [])].some(detail => detail?.includes("[source-conversion-unqualified]"));

export function LibraryDeletionNotice({ operation, pending, onAction }: {
  operation?: LibraryDeletionOperation; pending?: LibraryDeletionPendingView; onAction: Action;
}) {
  const focusedAction = useRef<{ button: HTMLButtonElement; library: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    const previous = focusedAction.current;
    if (!previous || previous.button.isConnected && !previous.button.disabled) return;
    focusedAction.current = null;
    const doc = previous.button.ownerDocument, active = doc.activeElement;
    if (!previous.library?.isConnected || !doc.hasFocus() || doc.querySelector('[aria-modal="true"],.lib-popover')) return;
    if (active?.isConnected && active !== previous.button && active !== doc.body && active !== doc.documentElement) return;
    previous.library.querySelector<HTMLElement>('input[aria-label="Search replays"]')?.focus();
  });
  const actionFocus = {
    onFocus: (event: FocusEvent<HTMLButtonElement>) => { focusedAction.current = { button: event.currentTarget, library: event.currentTarget.closest('[data-testid="replay-library"]') }; },
    onBlur: (event: FocusEvent<HTMLButtonElement>) => {
      const doc = event.currentTarget.ownerDocument, next = event.relatedTarget;
      if (!event.currentTarget.disabled || next && next !== doc.body && next !== doc.documentElement) focusedAction.current = null;
    },
  };
  const current = operation && !operation.open && (operation.phase || operation.error || operation.uncertain || unresolved(operation.result));
  const items = pending?.items.filter(item => !current || item.intentId !== operation?.result?.intentId) ?? [];
  const previewPhase = operation?.phase === "preview" || operation?.phase === "continue-preview" || operation?.phase === "cancel";
  const checkingStatus = operation?.phase === "status" || operation?.phase === "recover";
  const phaseLabel = previewPhase ? "Deletion preview" : checkingStatus ? "Deletion status" : "Deletion outcomes";
  if (!current && !items.length && !pending?.error) return null;
  return <section className="lib-deletion-notice" aria-label={!items.length && !pending?.error ? phaseLabel : "Deletion outcomes"}>
    {current && <div className="lib-row lib-wrap">
      <span className="lib-spacer">{previewPhase || checkingStatus ? outcomeText(operation, false) : operation.phase === "cleanup" ? "Temporary cleanup in progress" : operation.phase ? "Deletion operation in progress" :
        operation.result?.state === "cleanup-required" ? "Temporary cleanup remains" : "Deletion needs attention"}</span>
      <LibraryButton {...actionFocus} onClick={event => onAction({ type: "reopen" }, event.currentTarget)}>{previewPhase ? "View preview" : checkingStatus ? "View deletion status" : "View deletion outcome"}</LibraryButton>
    </div>}
    {items.length > 0 && <details><summary>{items.length} deletion {items.length === 1 ? "outcome needs" : "outcomes need"} review</summary>
    <div className="lib-deletion-pending-list">{items.map(item => <div className="lib-row lib-wrap" key={item.intentId}>
      <div className="lib-spacer lib-deletion-name">{item.state === "cleanup-required" ? "Temporary cleanup remains" : item.state === "unknown" ? "Unconfirmed deletion" : "Unfinished deletion"}
        <span className="lib-note"> · {item.committedTargets} of {item.totalTargets} targets confirmed removed</span>
        {item.createdAt !== undefined && <div className="lib-note">{new Date(item.createdAt).toLocaleString()}</div>}
        <details><summary>Details</summary><span className="lib-deletion-path lib-mono">Replay {item.replayId}</span></details>
      </div>
      <LibraryButton {...actionFocus} onClick={event => onAction({ type: "inspect", intentId: item.intentId }, event.currentTarget)}>Review deletion</LibraryButton>
    </div>)}</div>
    {pending?.next && <LibraryButton {...actionFocus} disabled={pending.loading} onClick={() => onAction({ type: "load-more" })}>
      {pending.loading ? "Loading deletion outcomes…" : "More deletion outcomes"}
    </LibraryButton>}</details>}
    {pending?.error && <div className="lib-problem" role="alert">Pending deletion outcomes couldn't be read.
      <details><summary>Details</summary><pre>{pending.error}</pre></details>
      <LibraryButton {...actionFocus} disabled={pending.loading} onClick={() => onAction({ type: "reload-pending" })}>Check again</LibraryButton>
    </div>}
  </section>;
}

function outcomeText(operation: LibraryDeletionOperation, expired: boolean): string {
  const held = nativeWriteHeld(operation);
  if (operation.phase === "preview") return "Checking local copies…";
  if (operation.phase === "continue-preview") return "Checking remaining copies…";
  if (operation.phase === "commit") return "Deleting…";
  if (operation.phase === "cleanup") return "Cleaning up temporary files…";
  if (operation.phase === "cancel") return "Cancelling preview…";
  if (operation.phase === "status" || operation.phase === "recover") return "Checking deletion status…";
  if (operation.uncertain) return operation.result?.state === "cleanup-required" ?
    (operation.result.sourceDeletionComplete ? "Replay deleted. Cleanup is not yet confirmed." : "Deletion and cleanup are not yet confirmed.") :
    "Deletion isn't confirmed. Some items may already be removed.";
  if (expired) return operation.result?.continuation ? "Confirmation expired. Review the remaining items again." : "Confirmation expired. Review again to continue.";
  if (!held && operation.result?.state === "partial" && operation.result.continuation && operation.result.token)
    return "Delete the remaining local items?";
  switch (operation.result?.state) {
    case "preview": return held ? "Deletion isn't available right now." : "Delete this replay?";
    case "blocked": return "Deletion isn't available right now.";
    case "expired": return held ? "Deletion isn't available right now." : "Confirmation expired. Review again to continue.";
    case "cancelled": return "Deletion cancelled.";
    case "committing": return "Deletion started. Check its status before continuing.";
    case "partial": return "Deletion is incomplete.";
    case "recovery-required": return "Check the deletion status before continuing.";
    case "cleanup-required": return operation.result.sourceDeletionComplete ? "Replay deleted. Temporary files need cleanup." : "Deletion is incomplete. Temporary files need cleanup.";
    case "complete": return "Deletion complete.";
    default: return "Couldn't check this replay for deletion.";
  }
}
type DeletionTarget = LibraryDeletionResult["targets"][number];

function plannedChange(action: DeletionTarget["action"], count?: number): string {
  if (action === "quarantine-replay") return `Delete ${count} local replay ${count === 1 ? "file" : "files"}`;
  const scores = count === undefined ? "matching local scores" : `${count} local ${count === 1 ? "score" : "scores"}`;
  return `Remove ${scores} from ${action === "remove-stable-scores" ? "scores.db" : "osu!lazer"}`;
}

function previewChanges(targets: DeletionTarget[]): string {
  const changes: string[] = [];
  for (const action of ["remove-stable-scores", "mark-native-score-deleted", "quarantine-replay"] as const) {
    const group = targets.filter(target => target.action === action);
    if (!group.length) continue;
    const count = action === "quarantine-replay" ? group.length :
      group.every(target => target.count !== undefined) ? group.reduce((sum, target) => sum + (target.count ?? 0), 0) : undefined;
    changes.push(plannedChange(action, count) + ".");
  }
  return changes.join(" ");
}

function targetStatus(target: DeletionTarget, preview: boolean): string {
  if (target.state === "committed") return target.action === "quarantine-replay" ? "Removed from this location" : "Local score records removed";
  if (target.state === "unchanged") return "Unchanged";
  if (target.state === "conflict") return "Conflict — check the details";
  if (target.state === "committing") return "Outcome not confirmed";
  if (!preview) return "Not attempted";
  return target.action === "quarantine-replay" ? "Delete this replay file" : plannedChange(target.action, target.count);
}

export function LibraryDeletionDialog({ operation, sources, onAction }: {
  operation: LibraryDeletionOperation; sources: LibraryStatus | null; onAction: Action;
}) {
  const body = useRef<HTMLDivElement>(null);
  const focusedAction = useRef<HTMLButtonElement | null>(null);
  const [now, setNow] = useState(Date.now);
  const result = operation.result;
  const held = nativeWriteHeld(operation);
  const continuation = result?.state === "partial" && result.continuation === true;
  const confirmation = !held && (result?.state === "preview" || continuation);
  const expiresAt = confirmation && (result?.token || continuation) ? result?.expiresAt : undefined;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const expired = expiresAt !== undefined && Math.max(now, Date.now()) >= expiresAt;
  const hasIdentity = Boolean(operation.title?.trim()) && !operation.identity;
  const ready = hasIdentity && confirmation && Boolean(result?.token) && Boolean(result?.targets.length) && !result?.blockers.length &&
    !operation.phase && !operation.uncertain && !operation.error && !expired;
  useLayoutEffect(() => {
    const previous = focusedAction.current;
    if (!previous || previous.isConnected && !previous.disabled) return;
    focusedAction.current = null;
    const panel = body.current?.closest<HTMLElement>(".lib-dialog"), doc = panel?.ownerDocument;
    if (!panel?.isConnected || !doc?.hasFocus()) return;
    const active = doc.activeElement;
    if (active?.isConnected && active !== previous && active !== doc.body && active !== doc.documentElement) return;
    if (doc.querySelector(".lib-popover") || Array.from(doc.querySelectorAll('[aria-modal="true"]')).at(-1) !== panel) return;
    panel.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  });
  const actionFocus = {
    onFocus: (event: FocusEvent<HTMLButtonElement>) => { focusedAction.current = event.currentTarget; },
    onBlur: (event: FocusEvent<HTMLButtonElement>) => {
      const doc = event.currentTarget.ownerDocument, next = event.relatedTarget;
      if (!event.currentTarget.disabled || next && next !== doc.body && next !== doc.documentElement) focusedAction.current = null;
    },
  };
  const checkable = operation.uncertain || unresolved(result) || !result && Boolean(operation.intentId);
  const renewable = !held && !checkable && (!result || ["preview", "blocked", "expired", "cancelled"].includes(result.state));
  const sourceNames = [...new Set(result?.targets.map(target => SOURCE_LABELS[target.sourceKind]))];
  const remaining = result?.targets.filter(target => !continuation || target.state !== "committed") ?? [];
  const close = () => onAction({ type: "close" });
  return <LibraryDialog title="Delete replay" onClose={close}>
    <div ref={body} className="lib-deletion-content" aria-busy={Boolean(operation.phase) || operation.identity?.state === "loading"}>
      {operation.title && <p className="lib-deletion-name">{operation.title}</p>}
      {operation.description && <p className="lib-note lib-deletion-name">{operation.description}</p>}
      <p role="status" aria-live="polite">{outcomeText(operation, expired)}</p>
      {held && <p className="lib-problem" role="alert">This build cannot safely delete local osu!lazer scores yet.</p>}
      {!hasIdentity && result && <p className="lib-note">{operation.identity?.state === "loading" ? "Loading replay details…" :
        `Replay details are unavailable.${renewable ? " Use Review again to retry." : !held && checkable ? " Check status to retry." : ""}`}</p>}
      {sourceNames.length > 0 && <p className="lib-note">Sources: {sourceNames.join("; ")}</p>}
      <p className="lib-note">{result?.state === "cleanup-required" ? "Cleanup removes temporary files only; it won't retry deletion. " :
        confirmation && remaining.length > 0 ? `${previewChanges(remaining)} ${continuation ? "Completed deletions won't be repeated. " : ""}` : ""}
        Online scores stay unchanged.</p>
      {(operation.phase === "commit" || operation.phase === "cleanup") && <p className="lib-note">Closing this panel won't cancel the operation.</p>}
      {operation.error && <div className="lib-problem" role="alert">
        {operation.uncertain ? "Check status before continuing." : renewable ? "Use Review again to retry." : "Open Details for the error."}
      </div>}
      {Boolean(result?.targets.length || result?.blockers.length || operation.error || operation.identity?.error) && <details className="lib-deletion-name"><summary>Details</summary>
      {operation.error && <div className="lib-problem"><pre>{operation.error}</pre></div>}
      {operation.identity?.error && <div className="lib-problem"><p>Replay details</p><pre>{operation.identity.error}</pre></div>}
      {Boolean(result?.blockers.length) && <ul>{result?.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>}
      {result?.state === "cleanup-required" && <p className="lib-note">Finish cleanup removes only this operation's verified temporary and quarantined files.</p>}
      {result && <ul className="lib-deletion-targets" aria-label="Local deletion targets">
        {result.targets.map(target => {
          const source = sources?.sources.find(entry => entry.sourceId === target.sourceId);
          return <li key={target.id}>
            <strong>{SOURCE_LABELS[target.sourceKind]}</strong>
            <div>{target.label}{target.action === "quarantine-replay" || target.count === undefined ? "" : ` · ${target.count} ${target.count === 1 ? "record" : "records"}`}</div>
            <div className="lib-deletion-path lib-mono">{target.path}</div>
            <div className="lib-note">{continuation && target.state === "unchanged" ? "Remaining for deletion" :
              `${continuation && target.state === "committed" ? "Already completed — " : ""}${targetStatus(target, result.state === "preview")}`}</div>
            {source && !source.enabled && <div className="lib-note">Source is disabled.</div>}
            {source && !source.directory && source.kind !== "imported" && <div className="lib-note">Source is not configured.</div>}
            {source?.failureReason === "source-missing" && <div className="lib-note">Source is unavailable.</div>}
            {source?.failureReason === "source-busy" && <div className="lib-note">Source is busy.</div>}
            {source?.error && <details><summary>Source error</summary><p>{source.error}</p></details>}
            {target.detail && <details><summary>Outcome details</summary><p>{target.detail}</p></details>}
            {!!target.records?.length && <details><summary>Exact score records</summary>
              <ul>{target.records.map(record => <li className="lib-deletion-path lib-mono" key={record.id}>{record.id} · {record.count} {record.count === 1 ? "record" : "records"}</li>)}</ul>
            </details>}
            {target.action === "mark-native-score-deleted" && <p className="lib-note">This removes the local score. Shared replay data may remain on disk under osu!lazer’s storage management.</p>}
            {!!target.retainedFiles?.length && <details><summary>{target.retainedFiles.length} {target.retainedFiles.length === 1 ? "file kept" : "files kept"}</summary>
              <ul>{target.retainedFiles.map(path => <li className="lib-deletion-path lib-mono" key={path}>{path}</li>)}</ul>
            </details>}
          </li>;
        })}
      </ul>}
      </details>}
      {result?.state === "partial" && <p className="lib-note">Other available replay locations remain usable.</p>}
      <div className="lib-row lib-wrap lib-deletion-actions">
        <LibraryButton {...actionFocus} onClick={close}>{confirmation && Boolean(result?.token) && !operation.phase && !operation.uncertain ? "Cancel" : "Close"}</LibraryButton>
        {checkable && !ready && <LibraryButton {...actionFocus} disabled={Boolean(operation.phase)} onClick={() => onAction({ type: "check" })}>Check status</LibraryButton>}
        {!held && result?.state === "partial" && !operation.uncertain && (!continuation || !result.token || expired) &&
          <LibraryButton {...actionFocus} disabled={Boolean(operation.phase)} onClick={() => onAction({ type: "review-remaining" })}>Review remaining</LibraryButton>}
        {result?.state === "cleanup-required" && <LibraryButton {...actionFocus} disabled={Boolean(operation.phase) || operation.uncertain} onClick={() => onAction({ type: "cleanup" })}>Finish cleanup</LibraryButton>}
        {renewable && (!ready || result?.state !== "preview") && <LibraryButton {...actionFocus} disabled={Boolean(operation.phase)} onClick={() => onAction({ type: "refresh" })}>Review again</LibraryButton>}
        {confirmation && Boolean(result?.token) && <LibraryButton {...actionFocus} className="lib-danger" disabled={!ready} onClick={() => onAction({ type: "confirm" })}>{continuation ? "Delete remaining" : "Delete"}</LibraryButton>}
      </div>
    </div>
  </LibraryDialog>;
}
