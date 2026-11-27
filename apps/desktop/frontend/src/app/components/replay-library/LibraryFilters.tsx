import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Tooltip } from "@mui/material";
import { FULL_MAP_MOD_ICONS } from "../../../assets/full-map-mod-icons";
import { buildFullMapReplayMods } from "../../services/analysis/full-map-analysis-view-model";
import {
  LIBRARY_FILTER_FIELDS,
  formatLibraryQueryText,
  parseLibraryQueryText,
  validateLibraryFilter,
  type LibraryFilter,
  type LibraryFilterField,
  type LibraryFacetPage,
  type LibraryQueryPreview,
} from "../../../../../shared/library-query";
import type { ReplayLibraryViewProps } from "./library-view-types";
import { ANALYSIS_LABELS, REVIEW_LABELS, SOURCE_LABELS } from "./library-view-types";
import { LibraryButton, LibraryIcon, LibraryPopover } from "./library-view-controls";
import { libraryQueryErrorCode } from "../../services/library/library-query-client";

// Only user edits enter this queue. Closing flushes; unmounting cancels.
function useFilterPublication<T>(publish: (value: T) => void) {
  const latest = useRef(publish);
  latest.current = publish;
  const mounted = useRef(true);
  const pending = useRef<{ value: T } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = undefined;
  }, []);
  const flush = useCallback(() => {
    const next = pending.current;
    cancel();
    if (next && mounted.current) latest.current(next.value);
  }, [cancel]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  return { cancel, flush, queue(value: T, typed = false) {
    if (!mounted.current) return;
    cancel();
    pending.current = { value };
    if (typed) timer.current = setTimeout(flush, 250);
    else flush();
  } };
}

function filterValue(draft: LibraryFilter): LibraryFilter | null {
  if ("values" in draft && !draft.values.length && draft.field !== "grade" && !(draft.field === "player" && draft.me)) return null;
  if ("min" in draft && draft.min === null && draft.max === null) return null;
  if (draft.field === "mods" && draft.mode !== "exactly" && !draft.mods.length && !draft.excludedMods?.length) return null;
  validateLibraryFilter(draft);
  return draft;
}

function replaceFilter(query: Props["query"], field: LibraryFilterField, filter: LibraryFilter | null) {
  const filters = (query.filters ?? []).flatMap(current => current.field === field ? filter ? [filter] : [] : [current]);
  if (filter && !query.filters?.some(current => current.field === field)) filters.push(filter);
  return filters;
}

// Resolve choices independently: selecting NC or PF must not hide the DT or SD filter options.
const FILTER_MODS = ["HD", "HR", "DT", "NC", "HT", "EZ", "FL", "NF", "SO", "SD", "PF", "CL", "RX"]
  .flatMap(acronym => buildFullMapReplayMods([acronym]));

export const FILTER_LABELS: Record<LibraryFilterField, string> = {
  stars: "Star rating",
  mods: "Mods",
  acc: "Accuracy",
  miss: "Misses",
  pp: "PP",
  played: "Date played",
  bpm: "BPM",
  len: "Length",
  status: "Ranked status",
  mapper: "Mapper",
  grade: "Grade",
  result: "Result",
  player: "Player",
  playedon: "Played on",
  ur: "UR",
  bias: "Timing bias",
  source: "Source",
  collection: "Collection",
  review: "Review state",
  astate: "Analysis state",
};
const staticFacets: Partial<Record<LibraryFilterField, string[]>> = {
  source: ["stable", "replays", "lazer", "imported"],
  grade: ["SS", "S", "A", "B", "C", "D", "F"],
  result: ["all", "passed", "fc", "failed", "unknown"],
  playedon: ["stable", "lazer", "unknown"],
  review: ["not-reviewed", "reviewed", "needs-another-look"],
  astate: ["analysed", "none", "active", "failed"],
  status: ["ranked", "loved", "qualified", "approved", "pending", "wip", "graveyard"],
};
const FILTER_GROUPS: { label: string; fields: LibraryFilterField[] }[] = [
  { label: "Beatmap", fields: ["stars", "bpm", "len", "status", "mapper"] },
  { label: "Replay", fields: ["mods", "acc", "miss", "pp", "grade", "result", "player", "playedon", "played"] },
  { label: "Analysis", fields: ["ur", "bias"] },
  { label: "Library", fields: ["source", "collection", "review", "astate"] },
];
export function libraryFilterSuggestions(text: string): LibraryFilterField[] {
  if (!text.trim()) return ["stars", "mods", "acc", "miss", "pp", "played"];
  return LIBRARY_FILTER_FIELDS.filter((field) => searchWords(text).some((word) => suggestsField(word, field))).slice(
    0,
    4,
  );
}
// Keep quoted phrases intact: choosing a field consumes its matched words only.
function searchWords(text: string): string[] {
  return text.match(/"(?:\\.|[^"\\])*(?:"|$)|[^\s]+/g) ?? [];
}
function suggestsField(word: string, field: LibraryFilterField): boolean {
  const term = word.toLowerCase();
  return term.length >= 2 && !term.includes('"') && matchesFilterTerm(term, field);
}
function matchesFilterTerm(term: string, field: LibraryFilterField): boolean {
  return (
    FILTER_LABELS[field].toLowerCase().includes(term) ||
    field.startsWith(term) ||
    (field === "result" && ["fc", "passed", "failed", "unknown"].includes(term))
  );
}
export function librarySearchWithoutFieldWords(text: string, field: LibraryFilterField): string {
  return searchWords(text)
    .filter((word) => !suggestsField(word, field))
    .join(" ");
}
function facetLabel(field: LibraryFilterField, value: string): string {
  if (field === "result")
    return (
      ({ all: "All", passed: "Passed", fc: "FC", failed: "Failed", unknown: "Unknown" } as Record<string, string>)[
        value
      ] ?? value
    );
  if (field === "playedon")
    return ({ stable: "Stable", lazer: "Lazer", unknown: "Unknown" } as Record<string, string>)[value] ?? value;
  if (field === "source") return SOURCE_LABELS[value as keyof typeof SOURCE_LABELS] ?? value;
  if (field === "review") return REVIEW_LABELS[value as keyof typeof REVIEW_LABELS] ?? value;
  if (field === "astate")
    return value === "active"
      ? "Queued / analysing / paused"
      : ANALYSIS_LABELS[value as keyof typeof ANALYSIS_LABELS] ?? value;
  return value;
}
export function libraryFilterLabel(filter: LibraryFilter, myNames?: string[]): string {
  if (filter.field === "player")
    return `Player: ${
      [
        ...(filter.me ? [myNames?.length === 0 ? "Me · no names" : "Me"] : []),
        ...filter.values.map((name) => (name.toLowerCase() === "me" ? '"me"' : name)),
      ].join(", ") || "None"
    }`;
  if ("values" in filter)
    return `${FILTER_LABELS[filter.field]}: ${
      filter.values.map((value) => facetLabel(filter.field, value)).join(", ") || "None"
    }`;
  if (filter.field === "mods")
    return `Mods: ${filter.mode === "exactly" ? "Exactly" : filter.mode === "excludes" ? "Excludes" : `Includes ${filter.match}`} ${
      filter.mods.join(filter.mode === "excludes" || filter.match === "any" ? " or " : " and ") || "No mods"
    }${filter.excludedMods?.length ? ` · Excludes ${filter.excludedMods.join(" or ")}` : ""}`;
  if (filter.field === "played")
    return `Date played: ${filter.preset === "custom" ? `${filter.from}–${filter.to}` : filter.preset}`;
  if ("op" in filter)
    return `${FILTER_LABELS[filter.field]}: ${
      filter.op === "between" ? `${filter.a}–${filter.b}` : `${filter.op === "atLeast" ? "≥" : "≤"} ${filter.a}`
    }`;
  return `${
    filter.field === "stars" ? `${filter.basis === "map" ? "Map" : "Replay"} stars` : FILTER_LABELS[filter.field]
  }: ${filter.min ?? "…"}–${filter.max ?? "…"}`;
}
function newDraft(field: LibraryFilterField): LibraryFilter {
  if (field === "mods") return { field, mode: "includes", match: "all", mods: [] };
  if (field === "played") return { field, preset: "30d" };
  if (field === "stars") return { field, basis: "replay", min: null, max: null };
  if (["acc", "miss", "ur"].includes(field)) return { field: field as "acc", op: "atLeast", a: 0, b: null };
  if (["bpm", "len", "pp", "bias"].includes(field)) return { field: field as "bpm", min: null, max: null };
  return { field: field as "source", values: [] };
}
type Props = Pick<
  ReplayLibraryViewProps,
  "query" | "page" | "collections" | "onQueryChange" | "onPreview" | "onFacets" | "myNames" | "onSaveMyNames"
> & {
  anchor: HTMLElement;
  initialField?: LibraryFilterField;
  onClose(): void;
};
export function LibraryFilters({
  query,
  page,
  collections,
  onQueryChange,
  onPreview,
  onFacets,
  myNames,
  onSaveMyNames,
  anchor,
  initialField,
  onClose,
}: Props) {
  const [field, setField] = useState<LibraryFilterField | null>(initialField ?? null);
  const [find, setFind] = useState("");
  const [managingNames, setManagingNames] = useState(false);
  const namesOwner = useRef({ mounted: true, editor: 0, request: 0 });
  useEffect(() => {
    const owner = namesOwner.current;
    owner.mounted = true;
    return () => { owner.mounted = false; owner.editor++; };
  }, []);
  const manageNames = (open: boolean) => {
    namesOwner.current.editor++;
    setManagingNames(open);
  };
  const [savedNames, setSavedNames] = useState(myNames?.names ?? []);
  useEffect(() => {
    const next = myNames?.names ?? [];
    setSavedNames(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [myNames?.names]);
  const [draft, setDraft] = useState<LibraryFilter | null>(() =>
    initialField ? query.filters?.find((f) => f.field === initialField) ?? newDraft(initialField) : null,
  );
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const [facets, setFacets] = useState<LibraryFacetPage["items"]>([]);
  const [facetNext, setFacetNext] = useState<string | undefined>();
  const [facetLoading, setFacetLoading] = useState(false);
  const facetScope = JSON.stringify([field, find, { ...query, cursor: undefined,
    filters: query.filters?.filter(filter => filter.field !== field) }]);
  const facetBatch = useRef<{ cancelled: boolean; running: boolean; pages: number; cursorRevision?: string } | null>(null);
  const [facetRead, setFacetRead] = useState<{ scope: string; revision?: string } | null>(null);
  const [previewResult, setPreviewResult] = useState<{
    scope: string; revision?: string; preview: LibraryQueryPreview | null; meCount: number | null;
  } | null>(null);
  const previewBatch = useRef<{ cancelled: boolean; running: boolean } | null>(null);
  const meId = useId();
  const [facetError, setFacetError] = useState(""), [previewError, setPreviewError] = useState("");
  const error = facetError || previewError;
  const editor = useRef<HTMLDivElement>(null);
  const edited = useRef(false);
  const cleared = useRef(false);
  const facetReader = useRef(onFacets),
    previewReader = useRef(onPreview);
  facetReader.current = onFacets;
  previewReader.current = onPreview;
  let valid = false;
  let committedDraft: LibraryFilter | null = null;
  try {
    if (draft) {
      committedDraft = cleared.current ? null : filterValue(draft);
      valid = true;
    }
  } catch {
    /* An incomplete draft is not a committed filter. */
  }
  const previewScope = JSON.stringify([draft, committedDraft, valid, query, managingNames, savedNames, edited.current]);
  const preview = previewResult?.scope === previewScope ? previewResult.preview : null;
  const meCount = previewResult?.scope === previewScope ? previewResult.meCount : null;
  const publication = useFilterPublication((next: LibraryFilter) => {
    try {
      const filters = replaceFilter(query, next.field, filterValue(next));
      if (JSON.stringify(filters) !== JSON.stringify(query.filters ?? []))
        onQueryChange({ ...query, filters, cursor: undefined });
    } catch { /* Keep the last applied query while this value is incomplete. */ }
  });
  const changeDraft = (next: LibraryFilter, typed = false) => {
    namesOwner.current.editor++;
    edited.current = true;
    cleared.current = false;
    setDraft(next);
    publication.queue(next, typed);
  };
  const close = () => { namesOwner.current.editor++; publication.flush(); onClose(); };
  useEffect(() => {
    if (field && !managingNames) editor.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
  }, [field, managingNames]);
  useEffect(() => {
    const batch = { cancelled: false, running: false, pages: 1 };
    facetBatch.current = batch;
    setFacets([]);
    setFacetNext(undefined);
    setFacetError("");
    return () => { batch.cancelled = true; };
  }, [facetScope]);
  const readFacetRange = async (batch: NonNullable<typeof facetBatch.current>, depth: number) => {
    if (!field) return;
    const items: LibraryFacetPage["items"] = [];
    let next: string | undefined, revision: string | undefined, pages = 0;
    // Rebuild only the range explicitly opened by the user. A cursor and all
    // pages preceding it belong to one service revision; never retag a cursor.
    do {
      if (batch.cancelled) return;
      const result = await facetReader.current(field, find, next);
      if (batch.cancelled || !result) return;
      if (pages && revision !== result.revision) throw new Error("Filter options changed while reading. Try again.");
      revision = result.revision;
      items.push(...result.items);
      next = result.next;
      pages++;
    } while (next && pages < depth);
    return { items, next, revision, pages };
  };
  const publishFacets = (batch: NonNullable<typeof facetBatch.current>, result: LibraryFacetPage, pages: number) => {
    if (batch.cancelled) return;
    batch.pages = pages;
    batch.cursorRevision = result.revision ?? page.revision;
    setFacetError("");
    // Keep the open menu's order and loaded choices stable. Refresh the loaded
    // counts and the continuation cursor together after a coherent range read.
    setFacets(previous => [
      ...previous.map(row => result.items.find(next => next.value === row.value) ?? row),
      ...result.items.filter(row => !previous.some(prior => prior.value === row.value)),
    ]);
    setFacetNext(result.next);
  };
  useEffect(() => {
    const batch = facetBatch.current;
    if (!field || managingNames || !batch || batch.cancelled || batch.running) return;
    if (facetRead?.scope === facetScope && facetRead.revision === page.revision) return;
    batch.running = true;
    setFacetLoading(true);
    readFacetRange(batch, batch.pages)
      .then((result) => {
        if (result) publishFacets(batch, result, result.pages);
      })
      .catch((reason) => {
        if (!batch.cancelled) setFacetError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        batch.running = false;
        if (!batch.cancelled) {
          setFacetLoading(false);
          setFacetRead({ scope: facetScope, revision: page.revision });
        }
      });
    // Same-scope revisions coalesce behind the active read; only a new editor
    // scope cancels it. Reader function identities do not restart work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facetScope, page.revision, facetRead, facetLoading, managingNames]);
  useEffect(() => {
    const batch = { cancelled: false, running: false };
    previewBatch.current = batch;
    setPreviewError("");
    return () => { batch.cancelled = true; };
  }, [previewScope]);
  useEffect(() => {
    const batch = previewBatch.current;
    if (!batch || batch.cancelled || batch.running) return;
    if (previewResult?.scope === previewScope && previewResult.revision === page.revision) return;
    if (!draft || managingNames) return;
    batch.running = true;
    void (async () => {
      let nextPreview: LibraryQueryPreview | null = null, nextMeCount: number | null = null;
      if (valid && (committedDraft !== null || edited.current)) {
        const unrestricted = committedDraft === null;
        const result = await previewReader.current(
          unrestricted
            ? { ...query, filters: query.filters?.filter((filter) => filter.field !== draft.field), cursor: undefined }
            : query,
          unrestricted ? undefined : draft,
        );
        if (batch.cancelled) return;
        if (result) nextPreview = result;
      }
      if (!batch.cancelled && draft.field === "player" && savedNames.length) {
        const me = await previewReader.current(query, { field: "player", values: savedNames });
        if (me) nextMeCount = me.count;
      }
      batch.running = false;
      if (!batch.cancelled) {
        setPreviewError("");
        setPreviewResult({ scope: previewScope, revision: page.revision, preview: nextPreview, meCount: nextMeCount });
      }
    })().catch((reason) => {
      if (!batch.cancelled) {
        batch.running = false;
        setPreviewError(String(reason instanceof Error ? reason.message : reason));
        setPreviewResult(previous => ({ scope: previewScope, revision: page.revision,
          preview: previous?.scope === previewScope ? previous.preview : null,
          meCount: previous?.scope === previewScope ? previous.meCount : null }));
      }
    }).finally(() => { batch.running = false; });
    // Finish one same-query serial batch during continuous score refreshes,
    // then read the newest revision once. Never clear useful counts mid-batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewScope, page.revision, previewResult]);
  const choose = (next: LibraryFilterField) => {
    namesOwner.current.editor++;
    publication.flush();
    edited.current = false;
    cleared.current = false;
    setField(next);
    setDraft(query.filters?.find((f) => f.field === next) ?? newDraft(next));
    setFind("");
  };
  const requiredMods = draft?.field === "mods" && draft.mode !== "excludes" ? draft.mods : [];
  const excludedMods = draft?.field === "mods" ? draft.mode === "excludes" ? draft.mods : draft.excludedMods ?? [] : [];
  const noMod = draft?.field === "mods" && draft.mode === "exactly" && draft.mods.length === 0;
  const modMatch = draft?.field === "mods" ? draft.mode === "exactly" ? "exactly" : draft.match ?? "all" : "all";
  const setMod = (side: "require" | "exclude", acronym: string, checked: boolean) => {
    const required = side === "require"
      ? checked ? [...requiredMods, acronym] : requiredMods.filter(value => value !== acronym)
      : checked ? requiredMods.filter(value => value !== acronym) : requiredMods;
    const excluded = side === "exclude"
      ? checked ? [...excludedMods, acronym] : excludedMods.filter(value => value !== acronym)
      : checked ? excludedMods.filter(value => value !== acronym) : excludedMods;
    changeDraft(required.length ? {
      field: "mods", mode: modMatch === "exactly" && !noMod ? "exactly" : "includes",
      match: modMatch === "exactly" && !noMod ? null : modMatch === "any" ? "any" : "all",
      mods: required, ...(excluded.length ? { excludedMods: excluded } : {}),
    } : excluded.length ? { field: "mods", mode: "excludes", match: null, mods: excluded } : newDraft("mods"));
  };
  const rows =
    field === "collection" && !facets.length
      ? collections.map((c) => ({
          value: c.id,
          label: `${c.parentId ? `${collections.find((p) => p.id === c.parentId)?.name ?? "Collection"} › ` : ""}${
            c.name
          }`,
          count: c.count,
        }))
      : staticFacets[field as LibraryFilterField]?.map((value) => ({
          value,
          label: facetLabel(field as LibraryFilterField, value),
          count: facets.find((f) => f.value === value)?.count,
        })) ??
        facets.map((row) => ({
          ...row,
          label: row.parentLabel ? `${row.parentLabel} › ${row.label ?? row.value}` : row.label,
        }));
  const moreFacets = () => {
    const batch = facetBatch.current;
    if (!field || !facetNext || facetLoading || !batch || batch.cancelled || batch.running) return;
    batch.running = true;
    const depth = batch.pages + 1;
    setFacetLoading(true);
    void (async () => {
      if (batch.cursorRevision !== page.revision) return readFacetRange(batch, depth);
      try {
        const result = await facetReader.current(field, find, facetNext);
        return result && { ...result, pages: depth };
      } catch (reason) {
        if (batch.cancelled || libraryQueryErrorCode(reason) !== "library-query-invalidated") throw reason;
        // One bounded restart for a revision racing this explicit click. A
        // second invalidation keeps the usable menu and allows a later retry.
        return readFacetRange(batch, depth);
      }
    })()
      .then((result) => {
        if (result) publishFacets(batch, result, result.pages);
      })
      .catch((reason) => {
        if (!batch.cancelled) setFacetError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        batch.running = false;
        if (!batch.cancelled) setFacetLoading(false);
      });
  };
  return (
    <LibraryPopover
      title={managingNames ? "My names" : field ? FILTER_LABELS[field] : "Filters"}
      anchor={anchor}
      onClose={close}
    >
      {managingNames ? (
        <LibraryMyNames
          names={savedNames}
          query={query}
          onPreview={onPreview}
          onFacets={onFacets}
          onBack={() => manageNames(false)}
          onSave={async (names) => {
            if (!onSaveMyNames) throw new Error("My names settings are unavailable.");
            const owner = namesOwner.current.editor;
            const request = ++namesOwner.current.request;
            const firstSetup = savedNames.length === 0;
            const saved = await onSaveMyNames(names);
            // A persisted response can update names, but only its original editor
            // may navigate or automatically select Me. Older requests own neither.
            if (!namesOwner.current.mounted || request !== namesOwner.current.request) return;
            setSavedNames(saved);
            if (owner !== namesOwner.current.editor) return;
            manageNames(false);
            const player = currentDraft.current;
            if (firstSetup && saved.length && player?.field === "player")
              changeDraft({ ...player, me: true });
          }}
        />
      ) : !field ? (
        <>
          <input
            data-initial-focus
            aria-label="Find a filter"
            placeholder="Find a filter"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            style={{ width: "100%", margin: "12px 0" }}
          />
          <p className="lib-note">20 filters for beatmap, replay, analysis and library</p>
          {FILTER_GROUPS.map((group) => {
            const fields = group.fields.filter((key) => matchesFilterTerm(find.trim().toLowerCase(), key));
            return fields.length ? (
              <section key={group.label}>
                <h3 className="lib-label">{group.label}</h3>
                {fields.map((key) => (
                  <LibraryButton key={key} className="lib-menu-item" onClick={() => choose(key)}>
                    {FILTER_LABELS[key]}
                    <span className="lib-spacer" />
                    {query.filters?.some((f) => f.field === key) ? "Added" : ""}
                  </LibraryButton>
                ))}
              </section>
            ) : null;
          })}
        </>
      ) : (
        <>
          <LibraryButton
            onClick={() => {
              namesOwner.current.editor++;
              publication.flush();
              setField(null);
              setDraft(null);
            }}
          >
            All filters
          </LibraryButton>
          <div className="lib-editor-fields" ref={editor}>
            {draft?.field === "player" && (
              <div className="lib-me-block">
                {myNames?.error ? null : myNames?.loading ? (
                  <p className="lib-note">Reading My names…</p>
                ) : !savedNames.length ? (
                  <>
                    <strong>Me</strong>
                    <p>
                      Match your own replays by the names you list. Hindsight doesn't guess which replays are yours.
                    </p>
                    <LibraryButton
                      className="lib-raised"
                      disabled={!onSaveMyNames}
                      onClick={() => manageNames(true)}
                    >
                      Set up Me
                    </LibraryButton>
                  </>
                ) : (
                  <>
                    <label className="lib-check lib-option-row" style={{ flexDirection: "row" }}>
                      <input
                        type="checkbox"
                        aria-labelledby={`${meId}-label`}
                        aria-describedby={`${meId}-names ${meId}-count`}
                        checked={draft.me === true}
                        onChange={(event) => changeDraft({ ...draft, me: event.target.checked })}
                      />
                      <span className="lib-option-copy">
                        <strong id={`${meId}-label`}>Me</strong>
                        <span id={`${meId}-names`} className="lib-note lib-me-names">{savedNames.join(", ")}</span>
                      </span>
                      <span id={`${meId}-count`} className="lib-option-count lib-mono lib-muted">
                        {meCount === null ? "—" : `${meCount.toLocaleString()} ${meCount === 1 ? "replay" : "replays"}`}
                      </span>
                    </label>
                    <LibraryButton onClick={() => manageNames(true)}>Manage my names</LibraryButton>
                  </>
                )}
                {myNames?.error && (
                  <div className="lib-problem" role="alert">
                    Couldn't read My names.
                    <details>
                      <summary>Details</summary>
                      <pre>{myNames.error}</pre>
                    </details>
                  </div>
                )}
              </div>
            )}
            {draft?.field === "result" && (
              <>
                <p className="lib-note">Includes recorded results and full combos confirmed by replay analysis.</p>
                {rows.map((row) => (
                  <label key={row.value} className="lib-check lib-option-row" style={{ flexDirection: "row" }}>
                    <input
                      type="radio"
                      name="result-filter"
                      checked={row.value === "all" ? draft.values.length === 0 : draft.values[0] === row.value}
                      onChange={() => changeDraft({ field: "result", values: row.value === "all" ? [] : [row.value] })}
                    />
                    <span className="lib-option-copy">{row.label}</span>
                    <span className="lib-option-count lib-mono lib-muted">
                      {row.count === undefined
                        ? "—"
                        : `${row.count.toLocaleString()} ${row.count === 1 ? "replay" : "replays"}`}
                    </span>
                  </label>
                ))}
                <p className="lib-note">
                  A recorded pass counts as FC when the replay confirms zero misses and combo breaks. A full combo
                  confirmed by complete replay analysis also counts as Passed and FC. Unresolved outcomes appear under
                  Unknown. Choosing a result doesn't start analysis.
                </p>
              </>
            )}
            {draft?.field === "playedon" && (
              <p className="lib-note">
                The client that recorded the play, separately from Source and Mods. Missing or conflicting provenance is
                Unknown.
              </p>
            )}
            {draft && "values" in draft && draft.field !== "result" && (
              <>
                <input
                  data-initial-focus
                  aria-label={`Find ${FILTER_LABELS[field].toLowerCase()}`}
                  placeholder={`Find ${FILTER_LABELS[field].toLowerCase()}`}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                />
                {rows
                  .filter((row) => (row.label ?? row.value).toLowerCase().includes(find.toLowerCase()))
                  .map((row) => (
                    <label key={row.value} className="lib-check lib-option-row" style={{ flexDirection: "row" }}>
                      <input
                        type="checkbox"
                        checked={draft.values.includes(row.value)}
                        onChange={(e) =>
                          changeDraft({
                            ...draft,
                            values: e.target.checked
                              ? [...draft.values, row.value]
                              : draft.values.filter((v) => v !== row.value),
                          })
                        }
                      />
                      <span className="lib-option-copy">
                        {row.label ?? row.value}
                        {field === "player" &&
                          savedNames.some((name) => name.toLowerCase() === row.value.toLowerCase()) && (
                            <span className="lib-note"> · In My names</span>
                          )}
                      </span>
                      {row.count !== undefined && (
                        <span className="lib-option-count lib-muted lib-mono">{row.count.toLocaleString()}</span>
                      )}
                    </label>
                  ))}
                {facetNext && (
                  <LibraryButton disabled={facetLoading} onClick={moreFacets}>
                    {facetLoading ? "Reading options…" : "More options"}
                  </LibraryButton>
                )}
              </>
            )}
            {draft?.field === "mods" && (
              <>
                <div className="lib-row">
                  <LibraryButton aria-pressed={noMod} onClick={() => changeDraft({ field: "mods", mode: "exactly", match: null, mods: [] })}>
                    No Mod
                  </LibraryButton>
                  <span className="lib-note">{noMod ? "Only replays without mods" : "Combine required and excluded mods"}</span>
                </div>
                {(["require", "exclude"] as const).map(side => (
                  <fieldset className="lib-mod-group" key={side}>
                    <legend>{side === "require" ? "Require mods" : "Exclude mods"}</legend>
                    <div className="lib-mod-choices">
                      {FILTER_MODS.map(mod => (
                        <Tooltip key={mod.acronym} title={`${mod.name} (${mod.acronym})`} describeChild placement="top">
                          <label className="lib-mod-choice">
                            <input
                              className="lib-mod-input"
                              type="checkbox"
                              aria-label={`${side === "require" ? "Require" : "Exclude"} ${mod.name} (${mod.acronym})`}
                              checked={(side === "require" ? requiredMods : excludedMods).includes(mod.acronym)}
                              onChange={event => setMod(side, mod.acronym, event.target.checked)}
                            />
                            <span className="lib-mod-face" aria-hidden="true">
                              <img src={FULL_MAP_MOD_ICONS[mod.mod]} alt="" draggable={false} />
                              <span className="lib-mod-mark"><LibraryIcon name={side === "require" ? "plus" : "close"} /></span>
                            </span>
                          </label>
                        </Tooltip>
                      ))}
                    </div>
                  </fieldset>
                ))}
                <details className="lib-mod-options" open={modMatch !== "all" && !noMod || undefined}>
                  <summary>Matching options{modMatch === "any" ? " · Any required mod" : modMatch === "exactly" && !noMod ? " · Only selected mods" : ""}</summary>
                  <label>
                    Required mod match
                    <select aria-label="Required mod match" value={noMod ? "all" : modMatch} disabled={!requiredMods.length}
                      onChange={event => changeDraft({
                        field: "mods", mods: requiredMods,
                        mode: event.target.value === "exactly" ? "exactly" : "includes",
                        match: event.target.value === "exactly" ? null : event.target.value as "all" | "any",
                        ...(excludedMods.length ? { excludedMods } : {}),
                      })}>
                      <option value="all">All selected mods</option>
                      <option value="any">Any selected mod</option>
                      <option value="exactly">Only selected mods</option>
                    </select>
                  </label>
                </details>
              </>
            )}
            {draft?.field === "played" && (
              <>
                <label>
                  Played
                  <select
                    aria-label="Played range"
                    value={draft.preset}
                    onChange={(e) =>
                      changeDraft(
                        e.target.value === "custom"
                          ? { field: "played", preset: "custom", from: "", to: "" }
                          : { field: "played", preset: e.target.value as "today" | "7d" | "30d" },
                      )
                    }
                  >
                    <option value="today">Today</option>
                    <option value="7d">Last 7 days</option>
                    <option value="30d">Last 30 days</option>
                    <option value="custom">Custom range</option>
                  </select>
                </label>
                {draft.preset === "custom" && (
                  <>
                    <label>
                      From
                      <input
                        type="date"
                        value={draft.from}
                        onChange={(e) => changeDraft({ ...draft, from: e.target.value }, true)}
                      />
                    </label>
                    <label>
                      To
                      <input
                        type="date"
                        value={draft.to}
                        onChange={(e) => changeDraft({ ...draft, to: e.target.value }, true)}
                      />
                    </label>
                  </>
                )}
              </>
            )}
            {draft && "min" in draft && (
              <>
                {draft.field === "stars" && (
                  <label>
                    Star basis
                    <select
                      aria-label="Star basis"
                      value={draft.basis}
                      onChange={(e) => changeDraft({ ...draft, basis: e.target.value as "map" | "replay" })}
                    >
                      <option value="replay">Replay stars (with mods)</option>
                      <option value="map">Map stars (No Mod)</option>
                    </select>
                  </label>
                )}
                <label>
                  {field === "len" ? "Minimum length (seconds)" : "Minimum"}
                  <input
                    type="number"
                    value={draft.min ?? ""}
                    onChange={(e) => changeDraft({ ...draft, min: e.target.value === "" ? null : Number(e.target.value) }, true)}
                  />
                </label>
                <label>
                  {field === "len" ? "Maximum length (seconds)" : "Maximum"}
                  <input
                    type="number"
                    value={draft.max ?? ""}
                    onChange={(e) => changeDraft({ ...draft, max: e.target.value === "" ? null : Number(e.target.value) }, true)}
                  />
                </label>
              </>
            )}
            {draft && "op" in draft && (
              <>
                <label>
                  Range
                  <select
                    aria-label="Range comparison"
                    value={draft.op}
                    onChange={(e) =>
                      changeDraft({
                        ...draft,
                        op: e.target.value as "atLeast" | "atMost" | "between",
                        b: e.target.value === "between" ? draft.a : null,
                      })
                    }
                  >
                    <option value="atLeast">At least</option>
                    <option value="atMost">At most</option>
                    <option value="between">Between</option>
                  </select>
                </label>
                <label>
                  {draft.op === "between" ? "From" : "Value"}
                  <input
                    type="number"
                    value={Number.isFinite(draft.a) ? draft.a : ""}
                    onChange={(e) => changeDraft({ ...draft, a: e.target.value === "" ? NaN : Number(e.target.value) }, true)}
                  />
                </label>
                {draft.op === "between" && (
                  <label>
                    To
                    <input
                      type="number"
                      value={draft.b ?? ""}
                      onChange={(e) => changeDraft({ ...draft, b: e.target.value === "" ? null : Number(e.target.value) }, true)}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          <p className="lib-note" aria-live="polite">
            {preview
              ? `${preview.count.toLocaleString()} matching ${preview.count === 1 ? "replay" : "replays"}${
                  preview.analysisExcluded
                    ? ` · ${preview.analysisExcluded.toLocaleString()} lack required analysis data`
                    : ""
                }`
              : valid
              ? committedDraft === null && !edited.current ? "Choose a filter. Changes update automatically." : "Checking indexed results…"
              : "Choose a valid filter range or value."}
          </p>
          {error && (
            <div role="alert" className="lib-problem">
              <strong>Filter options couldn't be read.</strong>
              <details>
                <summary>Details</summary>
                <pre>{error}</pre>
              </details>
            </div>
          )}
          <div className="lib-row">
            <LibraryButton disabled={!query.filters?.some(filter => filter.field === field)} onClick={(event) => {
              if (!field) return;
              const button = event.currentTarget;
              if (button.ownerDocument.activeElement === button && button.ownerDocument.hasFocus())
                button.parentElement?.querySelector<HTMLButtonElement>("button[data-filter-done]")?.focus();
              namesOwner.current.editor++;
              publication.cancel();
              edited.current = true;
              cleared.current = true;
              setDraft(newDraft(field));
              onQueryChange({ ...query, filters: replaceFilter(query, field, null), cursor: undefined });
            }}>Clear filter</LibraryButton>
            <span className="lib-spacer" />
            <span className="lib-note">Updates automatically</span>
            <LibraryButton data-filter-done onClick={close}>Done</LibraryButton>
          </div>
        </>
      )}
    </LibraryPopover>
  );
}
function LibraryMyNames({
  names,
  query,
  onPreview,
  onFacets,
  onBack,
  onSave,
}: Pick<Props, "query" | "onPreview" | "onFacets"> & {
  names: string[];
  onBack(): void;
  onSave(names: string[]): Promise<void>;
}) {
  const [draft, setDraft] = useState(names),
    [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<LibraryFacetPage["items"]>([]);
  const [completeSuggestions, setCompleteSuggestions] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  const [counts, setCounts] = useState<Record<string, number>>({}),
    [total, setTotal] = useState<number | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const readers = useRef({ onPreview, onFacets });
  readers.current = { onPreview, onFacets };
  useEffect(() => {
    let current = true;
    setSuggestions([]);
    setCompleteSuggestions(false);
    if (input.trim())
      void readers.current
        .onFacets("player", input.trim())
        .then((result) => {
          if (current && result) {
            setSuggestions(result.items);
            setCompleteSuggestions(!result.next);
          }
        })
        .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [input]);
  useEffect(() => {
    let current = true;
    setCounts({});
    setTotal(draft.length ? null : 0);
    void (async () => {
      if (!draft.length) return;
      const sum = await readers.current.onPreview(query, { field: "player", values: draft });
      if (!current) return;
      if (sum) setTotal(sum.count);
      for (const name of draft) {
        if (!current) return;
        const result = await readers.current.onPreview(query, { field: "player", values: [name] });
        if (current && result) setCounts((old) => ({ ...old, [name]: result.count }));
      }
    })().catch(() => {
      if (current) setError("Replay counts couldn't be read. You can still save your names.");
    });
    return () => {
      current = false;
    };
  }, [draft, query]);
  const add = (name: string) => {
    name = name.trim();
    if (!name) return;
    if (name.length > 256 || draft.length >= 100) {
      setError("Use up to 100 names, each at most 256 characters.");
      return;
    }
    if (!draft.some((value) => value.toLowerCase() === name.toLowerCase())) setDraft([...draft, name]);
    setInput("");
    setError("");
  };
  return (
    <>
      <LibraryButton onClick={onBack}>Back to Player</LibraryButton>
      <p>
        Me matches replays recorded under any of these names. Add current and old names. Hindsight only uses this list;
        it doesn't guess which replays are yours.
      </p>
      {draft.map((name) => (
        <div key={name.toLowerCase()} className="lib-name-row">
          <span className="lib-option-copy">{name}</span>
          <span className="lib-option-count lib-mono lib-muted">
            {counts[name] === undefined
              ? "—"
              : `${counts[name].toLocaleString()} ${counts[name] === 1 ? "replay" : "replays"}`}
          </span>
          <LibraryButton
            aria-label={`Remove name ${name}`}
            disabled={saving}
            onClick={() => setDraft(draft.filter((value) => value !== name))}
          >
            ×
          </LibraryButton>
        </div>
      ))}
      <label>
        Add a name
        <input
          ref={nameInput}
          data-initial-focus
          aria-label="Add a name"
          value={input}
          disabled={saving}
          maxLength={256}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(input);
            }
          }}
        />
      </label>
      {input.trim() && (
        <>
          {suggestions.map((row) => (
            <LibraryButton className="lib-menu-item" key={row.value} disabled={saving} onClick={() => add(row.value)}>
              <span className="lib-option-copy">{row.value}</span>
              <span className="lib-option-count lib-mono lib-muted">
                {row.count.toLocaleString()} {row.count === 1 ? "replay" : "replays"}
              </span>
            </LibraryButton>
          ))}
          <LibraryButton className="lib-menu-item" disabled={saving} onClick={() => add(input)}>
            <span className="lib-option-copy">Add {input.trim()}</span>
          </LibraryButton>
          {completeSuggestions &&
            !suggestions.some((row) => row.value.toLowerCase() === input.trim().toLowerCase()) && (
              <p className="lib-note">No replays under this name in the current view yet</p>
            )}
        </>
      )}
      <p className="lib-note">
        Names match exactly, ignoring capitals. Other players stay separate: pick them by name in the Player filter.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="lib-row lib-filter-footer">
        <span className="lib-spacer lib-mono">
          Me would match {total === null ? "…" : total.toLocaleString()} {total === 1 ? "replay" : "replays"}
        </span>
        <LibraryButton disabled={saving} onClick={onBack}>
          Cancel
        </LibraryButton>
        <LibraryButton
          className="lib-primary"
          disabled={saving || (!names.length && !draft.length)}
          onClick={() => {
            setSaving(true);
            setError("");
            void onSave(draft).catch((reason) => {
              setError(reason instanceof Error ? reason.message : "My names couldn't be saved.");
              setSaving(false);
            });
          }}
        >
          {saving ? "Saving…" : names.length ? "Save" : "Save and use Me"}
        </LibraryButton>
      </div>
    </>
  );
}
export function LibraryQueryEditor({
  query,
  onQueryChange,
  anchor,
  onClose,
}: Pick<Props, "query" | "onQueryChange" | "anchor" | "onClose">) {
  const [text, setText] = useState(() => formatLibraryQueryText(query));
  const [error, setError] = useState("");
  const composing = useRef(false);
  const publication = useFilterPublication((next: string) => {
    try {
      const parsed = parseLibraryQueryText(next, { strict: true });
      setError("");
      if (formatLibraryQueryText(parsed) !== formatLibraryQueryText(query))
        onQueryChange({ ...query, ...parsed, cursor: undefined });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Invalid query");
    }
  });
  const edit = (next: string) => {
    setText(next);
    setError("");
    if (!composing.current) publication.queue(next, true);
  };
  const close = () => { if (!composing.current) publication.flush(); onClose(); };
  return (
    <LibraryPopover title="Edit filters as text" anchor={anchor} onClose={close}>
      <p className="lib-note">Valid edits update results automatically. An incomplete query keeps the last applied results.</p>
      <textarea
        data-initial-focus
        aria-label="Query text"
        rows={6}
        value={text}
        style={{ width: "100%" }}
        onChange={(e) => edit(e.target.value)}
        onCompositionStart={() => { composing.current = true; publication.cancel(); }}
        onCompositionEnd={(event) => { composing.current = false; edit(event.currentTarget.value); }}
      />
      {error && <p role="alert">{error}</p>}
      <LibraryButton onClick={close}>Done</LibraryButton>
    </LibraryPopover>
  );
}
