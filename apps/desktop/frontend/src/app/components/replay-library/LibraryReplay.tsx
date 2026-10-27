import { useId, useRef, useState } from "react";
import type { LibraryQueryDetail, LibraryQueryItem, LibrarySort } from "../../../../../shared/library-query";
import type { LibraryErrorStrip } from "../../../../../shared/library-error-strip";
import type { ReplayReview } from "../../../../../shared/replay-library";
import { REWIND_COLORS as c } from "../../styles/tokens";
import { buildFullMapReplayMods } from "../../services/analysis/full-map-analysis-view-model";
import { ReplayModIcons } from "../analyzer/ReplayModIcons";
import type { LibraryViewResources, ReplayLibraryViewProps } from "./library-view-types";
import { ANALYSIS_LABELS, REVIEW_LABELS, SOURCE_LABELS } from "./library-view-types";
import { LibraryButton, LibraryIcon, LibraryPopover, useLibraryFocusTrap } from "./library-view-controls";

export const libraryGradeColor = (item: Pick<LibraryQueryItem, "grade" | "mods">) => {
  const grade = item.grade?.replace(/H$/, "");
  if (
    (grade === "S" || grade === "SS") &&
    (item.grade?.endsWith("H") || item.mods?.some((m) => m === "HD" || m === "FL"))
  )
    return "#d9e1e8";
  return (
    (
      { SS: "#ffd62d", S: "#ffd62d", A: "#88da20", B: "#4b7bff", C: "#b56cff", D: "#ff5a5a", F: "#c5cad3" } as Record<
        string,
        string
      >
    )[grade ?? ""] ?? c.textTertiary
  );
};
export function libraryNumber(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function libraryLength(value: number | null) {
  return value === null ? "—" : `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}
/** FC is explicit evidence, never inferred from zero misses or perfect combo. */
export const libraryConfirmedFC = (item: LibraryQueryItem) => item.completion === "passed" && item.fullCombo === true;
export function libraryRelativeDate(value: number | null, now = Date.now()) {
  if (value === null || !Number.isFinite(value)) return "—";
  const days = (now - value) / 86400000;
  if (days < 0) return new Date(value).toLocaleDateString();
  if (days < 1 / 24) return "Just now";
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 31) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}
export function LibraryCombo({ item, showFc = true }: { item: LibraryQueryItem; showFc?: boolean }) {
  return (
    <span
      className="lib-mono"
      title={
        item.completion !== "passed" && item.completion !== "failed"
          ? "Recorded outcome is unknown, so this replay cannot be labelled FC."
          : undefined
      }
    >
      <span
        style={{ color: item.perfectCombo === true ? "#8fe8af" : undefined }}
        title={item.perfectCombo === true ? "Perfect combo" : undefined}
      >
        {libraryNumber(item.values.combo)}
        {item.values.combo !== null ? "×" : ""}
      </span>
      {showFc && item.completion === "passed" && item.fullCombo === true && (
        <span style={{ color: "#f0a92e", marginLeft: 6 }}>FC</span>
      )}
    </span>
  );
}
export function LibraryErrorStripView({ strip }: { strip: LibraryErrorStrip }) {
  const groups: [number[], string, number][] = [
    [strip.ok, c.judgement100, 6],
    [strip.meh, c.judgement50, 8],
    [strip.miss, c.judgementMiss, 12],
    [strip.sliderEndMiss, c.sliderEnd, 5],
    [strip.ruleset === "stable" ? strip.sliderBreak : strip.componentMiss, c.sliderBreak, 9],
  ];
  const min = Math.min(strip.mapStartMs, ...groups.flatMap(([values]) => values));
  const max = Math.max(strip.mapEndMs, strip.evaluatedThrough, ...groups.flatMap(([values]) => values));
  const x = (time: number) => (((time - min) / Math.max(1, max - min)) * 1000).toFixed(2);
  return (
    <svg
      role="img"
      aria-label="Replay judgement error strip"
      viewBox="0 0 1000 16"
      preserveAspectRatio="none"
      style={{ width: "100%", height: 16 }}
    >
      <path d="M0 8H1000" stroke="rgba(255,255,255,.2)" strokeWidth={1} />
      {groups.map(([values, color, height]) => (
        <path
          key={color}
          d={values.map((time) => `M${x(time)} ${8 - height / 2}v${height}`).join("")}
          stroke={color}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
/** The URI owns its display attempt. A query/resource refresh with the same URI
 * must not retry a failed image; a replacement URI gets a fresh keyed instance. */
function LibraryArtwork({ resource, compact = false }: { resource?: LibraryViewResources; compact?: boolean }) {
  return <LibraryArtworkAttempt key={resource?.artUrl ?? "missing"} resource={resource} compact={compact} />;
}
function LibraryArtworkAttempt({ resource, compact }: { resource?: LibraryViewResources; compact: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState(resource?.artworkError);
  if (resource?.artworkError && resource.artworkError !== failure) setFailure(resource.artworkError);
  const error = resource?.artworkError ?? failure;
  return (
    <>
      {resource?.artUrl && !error && (
        <img
          src={resource.artUrl}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            visibility: loaded ? "visible" : "hidden",
          }}
          onLoad={() => setLoaded(true)}
          onError={() => setFailure("Artwork could not be displayed.")}
        />
      )}
      {(error || (!compact && resource && !resource.artUrl && !resource.artworkPending)) && (
        <span
          role="img"
          aria-label="Artwork unavailable"
          className="lib-note"
          title={error}
          style={
            compact
              ? { position: "absolute", inset: 0 }
              : { position: "absolute", inset: "45% 14px auto", textAlign: "center" }
          }
        >
          {compact ? null : "Artwork unavailable"}
        </span>
      )}
    </>
  );
}
function ReplayArt({
  item,
  resource,
  panel = false,
}: {
  item: LibraryQueryItem;
  resource?: LibraryViewResources;
  panel?: boolean;
}) {
  return (
    <div className="lib-art" style={panel ? { height: 200 } : undefined}>
      <LibraryArtwork resource={resource} compact={!panel} />
      <div
        className="lib-card-top lib-row"
        style={panel ? { top: "auto", bottom: 42, flexWrap: "wrap" } : { right: 46, flexWrap: "wrap" }}
      >
        <span className="lib-grade" style={{ color: libraryGradeColor(item), fontSize: panel ? 50 : undefined }}>
          {item.grade?.replace(/H$/, "") ?? "—"}
        </span>
        {item.isNew && <span className="lib-new">NEW</span>}
        {!item.available && <span className="lib-file-unavailable">FILE UNAVAILABLE</span>}
        <span className="lib-spacer" />
        <ReplayModIcons mods={buildFullMapReplayMods(item.mods ?? [])} height={panel ? 26 : 22} />
      </div>
      {item.analysis !== "analysed" && (
        <span className="lib-state" title={item.analysisError ?? undefined}>
          {ANALYSIS_LABELS[item.analysis]}
        </span>
      )}
      <div className="lib-strip">
        {resource?.strip ? (
          <LibraryErrorStripView strip={resource.strip} />
        ) : (
          <div
            role={resource?.stripError ? "img" : undefined}
            aria-label={resource?.stripError ? "Error strip unavailable" : undefined}
            title={resource?.stripError}
            style={{ height: 8, borderBottom: "1px dotted rgba(255,255,255,.2)" }}
          />
        )}
      </div>
    </div>
  );
}
interface ReplayItemProps {
  item: LibraryQueryItem;
  resource?: LibraryViewResources;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
  onSave(anchor: HTMLElement): void;
  index?: number;
  sort?: LibrarySort;
}
export function LibraryReplayCard({ item, resource, selected, onSelect, onOpen, onSave, index, sort }: ReplayItemProps) {
  const secondary = sort === "fc" ? { label: "IF FC", value: item.values.fc }
    : sort === "ur" ? { label: "UR", value: item.values.ur }
    : !libraryConfirmedFC(item) && item.completion !== "failed" && item.values.peak !== null &&
      (sort === "peak" || (item.values.pp !== null && item.values.peak > item.values.pp))
      ? { label: "PEAK", value: item.values.peak } : null;
  return (
    <article
      role="option"
      aria-selected={selected}
      aria-label={`${item.title ?? "Unknown beatmap"}, ${item.player ?? "Unknown player"}${
        item.available ? "" : ", file unavailable"
      }`}
      aria-posinset={index === undefined ? undefined : index + 1}
      className="lib-card"
      tabIndex={0}
      data-replay-id={item.id}
      onClick={onSelect}
      onDoubleClick={item.available ? onOpen : onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.currentTarget === e.target) {
          e.preventDefault();
          if (selected && item.available) onOpen();
          else onSelect();
        }
      }}
    >
      <ReplayArt item={item} resource={resource} />
      <LibraryButton
        className="lib-bookmark"
        aria-label={`Add ${item.title ?? "replay"} to collection`}
        style={{ position: "absolute", top: 10, right: 10 }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
          onSave(e.currentTarget);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <LibraryIcon name="bookmark" filled={item.collectionCount > 0 || item.favourite} />
      </LibraryButton>
      <div className="lib-card-body">
        <div className="lib-card-title-block">
        <div className="lib-card-artist" title={item.artist ?? undefined}>
          {item.artist ?? "Unknown artist"}
        </div>
        <div className="lib-replay-title" title={item.title ?? undefined}>{item.title ?? "Unknown beatmap"}</div>
        <div className="lib-card-difficulty" title={item.difficulty ?? undefined}>{item.difficulty ? `[${item.difficulty}]` : "Beatmap details unavailable"}</div>
        </div>
        <div className={`lib-card-stats${secondary ? "" : " lib-card-stats-no-secondary"}`}>
          <div className="lib-card-pp">
            <span className="lib-pp">
              {libraryNumber(item.completion === "failed" ? item.values.peak : item.values.pp)}
            </span>
            {(item.completion === "failed" ? item.values.peak : item.values.pp) !== null && (
              <span className="lib-pp-unit">
                {item.completion === "failed" ? "pp peak" : "pp"}
              </span>
            )}
          </div>
            <div className="lib-card-accuracy">
              {libraryNumber(item.values.acc, 2)}
              {item.values.acc !== null ? "%" : ""}
            </div>
          <div className={`lib-card-secondary${sort === "peak" || sort === "fc" || sort === "ur" ? " lib-sort-stat" : ""}`}>
            {secondary && <><span>{secondary.label}</span> <strong>{libraryNumber(secondary.value, secondary.label === "UR" ? 1 : 0)}</strong></>}
          </div>
          <div className="lib-card-combo">
            <LibraryCombo item={item} />
            {!(item.completion === "passed" && item.fullCombo === true) && (
              <span
                className="lib-mono"
                style={{ color: item.values.miss && item.values.miss > 0 ? c.judgementMiss : c.textTertiary }}
              >
                {" "}
                · {libraryNumber(item.values.miss)} misses
              </span>
            )}
          </div>
        </div>
        <div className="lib-card-footer">
          <span style={{ color: c.star }}>★ {libraryNumber(item.values.sr, 2)}</span>
          <span>{libraryNumber(item.values.bpm)} <span className="lib-footer-unit">bpm</span></span>
          <span>{libraryLength(item.values.len)}</span>
          <span className="lib-card-date" title={item.values.date === null ? undefined : new Date(item.values.date).toLocaleString()}>
            {libraryRelativeDate(item.values.date)}
          </span>
        </div>
        {item.completion === "failed" && (
          <div className="lib-card-failed lib-note">
            Failed · no pp awarded
          </div>
        )}
      </div>
    </article>
  );
}
export function LibraryReplayRow({ item, resource, selected, onSelect, onOpen, onSave, index }: ReplayItemProps) {
  const positionId = useId();
  const subtitle = `${item.artist ?? "Unknown artist"} · [${item.difficulty ?? "Unknown difficulty"}]${
    item.completion === "failed" ? " · Failed · no pp awarded" : ""
  }`;
  const metric = (key: keyof typeof item.values, digits = 0) => (
    <span role="cell" title={item.values[key] === null ? ANALYSIS_LABELS[item.analysis] : undefined}>
      {libraryNumber(item.values[key], digits)}
    </span>
  );
  return (
    <div
      role="row"
      aria-current={selected ? "true" : undefined}
      data-selected={selected}
      aria-label={`${item.title ?? "Unknown beatmap"}, ${item.player ?? "Unknown player"}${
        item.available ? "" : ", file unavailable"
      }`}
      aria-describedby={index === undefined ? undefined : positionId}
      className="lib-list-row"
      tabIndex={0}
      data-replay-id={item.id}
      onClick={onSelect}
      onDoubleClick={item.available ? onOpen : onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.currentTarget === e.target) {
          e.preventDefault();
          if (selected && item.available) onOpen();
          else onSelect();
        }
      }}
    >
      <span role="cell" className="lib-grade" style={{ color: libraryGradeColor(item) }}>
        {item.grade?.replace(/H$/, "") ?? "—"}
      </span>
      <div role="cell">
        <div className="lib-list-art">
          <LibraryArtwork resource={resource} compact />
        </div>
      </div>
      <div role="cell" className="lib-list-title">
        {index !== undefined && <span id={positionId} className="lib-sr">Replay {index + 1}</span>}
        <div className="lib-replay-title">
          {item.title ?? "Unknown beatmap"} {item.isNew && <span className="lib-new">NEW</span>}
          {!item.available && <span className="lib-file-unavailable">FILE UNAVAILABLE</span>}
        </div>
        <div className="lib-note lib-replay-subtitle" title={subtitle}>
          {subtitle}
        </div>
      </div>
      <div role="cell">
        <div className="lib-row lib-list-mods" role="group" aria-label={`Mods: ${item.mods?.length ? item.mods.join(", ") : "None"}`} title={(item.mods ?? []).join(", ")}>
          <ReplayModIcons
            mods={buildFullMapReplayMods((item.mods ?? []).slice(0, (item.mods?.length ?? 0) > 3 ? 2 : 3))}
            height={23}
          />
          {(item.mods?.length ?? 0) > 3 && <span className="lib-mono">+{(item.mods?.length ?? 0) - 2}</span>}
        </div>
      </div>
      {metric("sr", 2)}
      {metric("bpm")}
      <span role="cell">{libraryLength(item.values.len)}</span>
      {metric("acc", 2)}
      <span role="cell"><LibraryCombo item={item} showFc={false} /></span>
      {item.completion === "passed" && item.fullCombo === true ? (
        <span role="cell" style={{ color: "#f0a92e" }}>FC</span>
      ) : (
        metric("miss")
      )}
      {metric("ur", 1)}
      {metric("pp")}
      {libraryConfirmedFC(item) ? <span role="cell" aria-label="Peak hidden for full combo">—</span> : metric("peak")}
      <span role="cell" title={item.values.date === null ? undefined : new Date(item.values.date).toLocaleString()}>{libraryRelativeDate(item.values.date)}</span>
      <div role="cell" data-column="save">
        <LibraryButton
          aria-label={`Add ${item.title ?? "replay"} to collection`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
            onSave(e.currentTarget);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <LibraryIcon name="bookmark" filled={item.collectionCount > 0 || item.favourite} />
        </LibraryButton>
      </div>
    </div>
  );
}
function knownDetail(detail: LibraryQueryDetail, key: string) {
  for (const result of detail.metrics) {
    if (key === "exactMapMaxCombo" && result.slot !== "calculated-map") continue;
    const field = result.fields[key];
    if (field?.state === "known" && typeof field.value === "number") return field.value;
  }
  return null;
}
export function LibraryReplayDetails({
  selected,
  collections,
  resources,
  sameMap,
  memberships,
  onLoadMoreMemberships,
  onOpen,
  onRevealFile,
  onReview,
  onRetryAnalysis,
  onSelect,
  onShowAllPlays,
  onLoadMorePlays,
  onSave,
  onClose,
  onOpenSources,
  openError,
  modal,
}: Pick<
  ReplayLibraryViewProps,
  | "collections"
  | "resources"
  | "sameMap"
  | "memberships"
  | "onLoadMoreMemberships"
  | "onOpen"
  | "openError"
  | "onRevealFile"
  | "onReview"
  | "onRetryAnalysis"
  | "onSelect"
  | "onShowAllPlays"
  | "onLoadMorePlays"
> & {
  selected: LibraryQueryDetail;
  onSave(anchor: HTMLElement): void;
  onClose(): void;
  onOpenSources(): void;
  modal: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const labelId = useId();
  const unavailableId = useId();
  const openErrorId = useId();
  const [reviewAnchor, setReviewAnchor] = useState<HTMLElement | null>(null);
  const [showAll, setShowAll] = useState(false);
  useLibraryFocusTrap(ref, modal);
  const item = selected.item;
  const actionError = openError?.replayId === item.id ? openError : undefined;
  const mapUnavailable = actionError?.reason === "exact-map-unavailable";
  const openingUnavailable = !item.available || mapUnavailable;
  const openingDescription = !item.available ? unavailableId : mapUnavailable ? openErrorId : undefined;
  const directMemberships = new Set([
    ...item.collectionIds,
    ...(memberships?.replayId === item.id ? memberships.ids : []),
  ]);
  const displayedMemberships = collections.filter((col) => directMemberships.has(col.id));
  const namedMemberships =
    memberships?.replayId === item.id && memberships.items
      ? memberships.items
      : displayedMemberships.map((col) => ({
          id: col.id,
          name: col.name,
          parentId: col.parentId,
          parentName: collections.find((parent) => parent.id === col.parentId)?.name ?? null,
        }));
  return (
    <>
      {modal && (
        <button type="button" className="lib-scrim" aria-label="Close replay details" tabIndex={-1} onClick={onClose} />
      )}
      <aside
        ref={ref}
        className="lib-panel"
        role={modal ? "dialog" : "complementary"}
        aria-modal={modal ? true : undefined}
        aria-labelledby={`${labelId} ${headingId}`}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !reviewAnchor && !document.querySelector(".lib-popover")) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div style={{ position: "relative" }}>
          <ReplayArt item={item} resource={resources?.[item.id]} panel />
          <span id={labelId} className="lib-label" style={{ position: "absolute", top: 16, left: 20 }}>
            Replay details
          </span>
          <LibraryButton
            data-initial-focus
            aria-label="Close replay details"
            style={{ position: "absolute", right: 10, top: 10, background: "rgba(11,11,13,.7)" }}
            onClick={onClose}
          >
            <LibraryIcon name="close" />
          </LibraryButton>
        </div>
        <div className="lib-panel-body">
          <div className="lib-muted">{item.artist ?? "Unknown artist"}</div>
          <h2 id={headingId} className="lib-replay-title" style={{ margin: "2px 0" }}>
            {item.title ?? "Unknown beatmap"}
          </h2>
          <div>
            {item.difficulty ? `[${item.difficulty}]` : "Beatmap details unavailable"} ·{" "}
            {item.mapper ?? "Unknown mapper"}
          </div>
          <div className="lib-row lib-note" style={{ marginTop: 12 }}>
            <span className="lib-spacer">{item.player ?? "Unknown player"}</span>
            <span className="lib-client-tag">
              {item.recordingClient === "stable"
                ? "STABLE"
                : item.recordingClient === "lazer"
                ? "LAZER"
                : "CLIENT UNKNOWN"}
            </span>
            <span className="lib-mono" style={{ fontSize: 10 }}>
              {item.values.date === null ? "Date unavailable" : new Date(item.values.date).toLocaleString()}
            </span>
          </div>
          <section className="lib-section">
            <div className="lib-row" style={{ margin: "18px 0" }}>
              <div className="lib-spacer">
                <span className="lib-pp" style={{ fontSize: 44 }}>
                  {libraryNumber(item.values.pp)}
                </span>
                {item.values.pp !== null && <span className="lib-muted"> pp</span>}
              </div>
              {!libraryConfirmedFC(item) && <span className="lib-mono">
                <span className="lib-label" style={{ fontSize: 9 }}>
                  Peak{" "}
                </span>
                {libraryNumber(item.values.peak)}
              </span>}
              <span className="lib-mono">
                <span className="lib-label" style={{ fontSize: 9 }}>
                  If FC{" "}
                </span>
                {libraryNumber(item.values.fc)}
              </span>
            </div>
            {item.completion === "failed" && <p>Failed · no pp awarded</p>}
            <div className="lib-stat-grid">
              <div>
                <span className="lib-note">Accuracy</span>
                <div className="lib-mono lib-stat-value">
                  {libraryNumber(item.values.acc, 2)}
                  {item.values.acc !== null ? "%" : ""}
                </div>
              </div>
              <div>
                <span className="lib-note">Combo</span>
                <div className="lib-stat-value lib-combo-value">
                  <LibraryCombo item={item} />
                  <span className="lib-note">
                    {" "}
                    / {libraryNumber(selected.exactMapMaxCombo ?? knownDetail(selected, "exactMapMaxCombo"))}
                  </span>
                </div>
              </div>
              <div>
                <span className="lib-note">UR</span>
                <div
                  className="lib-mono lib-stat-value"
                  title={item.values.ur === null ? ANALYSIS_LABELS[item.analysis] : undefined}
                >
                  {libraryNumber(item.values.ur, 1)}
                </div>
              </div>
            </div>
            <div className="lib-judgement-counts">
              {[
                ["300", "great", c.judgement300],
                ["100", "ok", c.judgement100],
                ["50", "meh", c.judgement50],
              ].map(([label, key, color]) => (
                <span key={key}>
                  <span className="lib-judgement-label" style={{ color }}>
                    {label}
                  </span>{" "}
                  <span className="lib-mono lib-judgement-value">
                    {libraryNumber(selected.savedJudgements?.[key as "great" | "ok" | "meh"])}
                  </span>
                </span>
              ))}
              <span>
                <span className="lib-judgement-label" style={{ color: c.judgementMiss }}>
                  Miss
                </span>{" "}
                <span className="lib-mono lib-judgement-value">{libraryNumber(item.values.miss)}</span>
              </span>
            </div>
            <div className="lib-row lib-mono" style={{ marginTop: 12 }}>
              <span style={{ color: c.star }}>★ {libraryNumber(item.values.sr, 2)}</span>
              <span className="lib-muted">{libraryNumber(item.values.bpm)} bpm</span>
              <span className="lib-muted">{libraryLength(item.values.len)}</span>
            </div>
          </section>
          <section className="lib-section">
            <LibraryButton
              className="lib-glow"
              disabled={openingUnavailable}
              aria-describedby={openingDescription}
              onClick={() => onOpen(item.id)}
            >
              <LibraryIcon name="play" />
              Open in viewer
              <span className="lib-spacer" />
              <span className="lib-mono lib-muted">Enter</span>
            </LibraryButton>
            {!item.available && (
              <p id={unavailableId} role="status" className="lib-note">
                Replay file unavailable. Hindsight has no available location for this replay.{" "}
                <LibraryButton onClick={onOpenSources}>Open Sources</LibraryButton>
              </p>
            )}
            {actionError && (
              <div id={openErrorId} role="alert" className="lib-problem">
                {mapUnavailable ? <>
                  <strong>The exact beatmap for this replay isn't available.</strong>
                  <p>Install the matching beatmap, then scan its source in Sources. Opening and full-map analysis need that exact map.</p>
                  <LibraryButton onClick={onOpenSources}>Open Sources</LibraryButton>
                </> : <>
                  <strong>The replay couldn't be opened.</strong>
                  <p>Try opening it again, or check its sources.</p>
                  <details><summary>Details</summary><pre>{actionError.message}</pre></details>
                </>}
              </div>
            )}
            <div className="lib-row" style={{ marginTop: 10 }}>
              <LibraryButton
                className="lib-raised lib-spacer"
                disabled={openingUnavailable}
                aria-describedby={openingDescription}
                onClick={() => onOpen(item.id, { fullMap: true })}
              >
                Full-map analysis
              </LibraryButton>
              <LibraryButton className="lib-raised" onClick={(e) => onSave(e.currentTarget)}>
                <LibraryIcon name="bookmark" />
                Add to collection
              </LibraryButton>
            </div>
            <LibraryButton
              disabled={!item.available}
              aria-describedby={!item.available ? unavailableId : undefined}
              onClick={() => onRevealFile(item.id)}
            >
              <LibraryIcon name="folder" />
              Show in folder
            </LibraryButton>
          </section>
          <section className="lib-section">
            <h3 className="lib-label">Saved to</h3>
            {item.favourite && <div>Favourites</div>}
            {namedMemberships.map((col) => (
              <div key={col.id} title={col.parentId ? `${col.parentName ?? "Collection"} › ${col.name}` : col.name}>
                {col.name}
                {col.parentId && <span className="lib-muted"> · in {col.parentName ?? "Collection"}</span>}
              </div>
            ))}
            {!item.favourite && item.collectionCount === 0 && <div className="lib-note">No collections yet</div>}
            {item.collectionCount > namedMemberships.length && (
              <LibraryButton
                disabled={memberships?.replayId === item.id && memberships.loading}
                onClick={onLoadMoreMemberships}
              >
                Load {item.collectionCount - namedMemberships.length} more memberships
              </LibraryButton>
            )}
          </section>
          <section className="lib-section">
            <div className="lib-row">
              <span className="lib-label lib-spacer">Review</span>
              <LibraryButton onClick={(e) => setReviewAnchor(e.currentTarget)}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background:
                      item.review === "reviewed"
                        ? "#8fe8af"
                        : item.review === "needs-another-look"
                        ? "#f5d27a"
                        : c.textDim,
                  }}
                />
                {REVIEW_LABELS[item.review as ReplayReview] ?? REVIEW_LABELS["not-reviewed"]}
                <LibraryIcon name="down" />
              </LibraryButton>
            </div>
          </section>
          <section className="lib-section">
            <h3 className="lib-label">Plays on this map</h3>
            {sameMap ? (
              <>
                {sameMap.items.slice(0, showAll ? undefined : 3).map((play) => (
                  <LibraryButton className="lib-menu-item" key={play.id} onClick={() => onSelect(play.id)}>
                    <span className="lib-spacer lib-same-map-player">{play.player ?? "Unknown player"}</span>
                    <span className="lib-mono lib-same-map-pp">
                      {libraryNumber(play.values.pp)}
                      {play.values.pp !== null && " pp"}
                    </span>
                  </LibraryButton>
                ))}
                {sameMap.total > 3 && (
                  <LibraryButton
                    onClick={() => {
                      setShowAll(!showAll);
                      if (!showAll) onShowAllPlays?.(item.id);
                    }}
                  >
                    {showAll ? "Show fewer" : `Show all ${sameMap.total.toLocaleString()} plays`}
                  </LibraryButton>
                )}
                {showAll && sameMap.next && (
                  <LibraryButton onClick={() => onLoadMorePlays?.(item.id)}>More plays</LibraryButton>
                )}
              </>
            ) : (
              <p className="lib-note">Loading other plays…</p>
            )}
          </section>
          <section className="lib-section">
            <h3 className="lib-label">Analysis</h3>
            <div>{ANALYSIS_LABELS[item.analysis]}</div>
            {item.analysisError && (
              <div role="alert" className="lib-problem">
                <strong>Deep analysis didn't finish.</strong>
                <p>Try analysing this replay again.</p>
                <details>
                  <summary>Details</summary>
                  <pre>{item.analysisError}</pre>
                </details>
              </div>
            )}
            {item.analysis === "failed" && (
              <LibraryButton
                className="lib-raised"
                disabled={!onRetryAnalysis}
                onClick={() => onRetryAnalysis?.(item.id)}
              >
                Retry analysis
              </LibraryButton>
            )}
            <h3 className="lib-label">Source</h3>
            {item.sourceKinds.map((kind) => (
              <div key={kind}>{SOURCE_LABELS[kind as keyof typeof SOURCE_LABELS] ?? kind}</div>
            ))}
          </section>
        </div>
        {reviewAnchor && (
          <LibraryPopover title="Review state" anchor={reviewAnchor} onClose={() => setReviewAnchor(null)}>
            {(Object.entries(REVIEW_LABELS) as [ReplayReview, string][]).map(([state, label]) => (
              <LibraryButton
                key={state}
                className="lib-menu-item lib-choice"
                aria-pressed={item.review === state}
                onClick={() => {
                  onReview(item.id, state);
                  setReviewAnchor(null);
                }}
              >
                {label}
              </LibraryButton>
            ))}
          </LibraryPopover>
        )}
      </aside>
    </>
  );
}
