import { useEffect, useId, useRef, useState } from "react";
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
import { LibraryButton, LibraryPopover } from "./library-view-controls";

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
    }`;
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
  "query" | "collections" | "onQueryChange" | "onPreview" | "onFacets" | "myNames" | "onSaveMyNames"
> & {
  anchor: HTMLElement;
  initialField?: LibraryFilterField;
  onClose(): void;
};
export function LibraryFilters({
  query,
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
  const [savedNames, setSavedNames] = useState(myNames?.names ?? []);
  useEffect(() => setSavedNames(myNames?.names ?? []), [myNames?.names]);
  const [draft, setDraft] = useState<LibraryFilter | null>(() =>
    initialField ? query.filters?.find((f) => f.field === initialField) ?? newDraft(initialField) : null,
  );
  const [facets, setFacets] = useState<LibraryFacetPage["items"]>([]);
  const [facetNext, setFacetNext] = useState<string | undefined>();
  const [facetLoading, setFacetLoading] = useState(false);
  const facetKey = useRef("");
  facetKey.current = `${field ?? ""}:${find}`;
  const [preview, setPreview] = useState<LibraryQueryPreview | null>(null);
  const [meCount, setMeCount] = useState<number | null>(null);
  const meId = useId();
  const modsHelpId = useId();
  const [error, setError] = useState("");
  const editor = useRef<HTMLDivElement>(null);
  const facetReader = useRef(onFacets),
    previewReader = useRef(onPreview);
  facetReader.current = onFacets;
  previewReader.current = onPreview;
  let valid = false;
  try {
    if (draft) {
      if (!((draft.field === "result" || draft.field === "playedon") && draft.values.length === 0))
        validateLibraryFilter(draft);
      valid = true;
    }
  } catch {
    /* An incomplete draft is not a committed filter. */
  }
  useEffect(() => {
    if (field && !managingNames) editor.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
  }, [field, managingNames]);
  useEffect(() => {
    let current = true;
    if (!field) return;
    setFacets([]);
    setFacetNext(undefined);
    setFacetLoading(true);
    facetReader
      .current(field, find)
      .then((result) => {
        if (current && result) {
          setFacets(result.items);
          setFacetNext(result.next);
        }
      })
      .catch((reason) => {
        if (current) setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (current) setFacetLoading(false);
      });
    return () => {
      current = false;
    };
  }, [field, find]);
  useEffect(() => {
    let current = true;
    setPreview(null);
    setMeCount(null);
    setError("");
    if (!draft || managingNames) return;
    void (async () => {
      if (valid) {
        const unrestricted = (draft.field === "result" || draft.field === "playedon") && draft.values.length === 0;
        const result = await previewReader.current(
          unrestricted
            ? { ...query, filters: query.filters?.filter((filter) => filter.field !== draft.field), cursor: undefined }
            : query,
          unrestricted ? undefined : draft,
        );
        if (current && result) setPreview(result);
      }
      if (current && draft.field === "player" && savedNames.length) {
        const me = await previewReader.current(query, { field: "player", values: savedNames });
        if (current && me) setMeCount(me.count);
      }
    })().catch((reason) => {
      if (current) setError(String(reason instanceof Error ? reason.message : reason));
    });
    return () => {
      current = false;
    };
  }, [draft, valid, query, managingNames, savedNames]);
  const choose = (next: LibraryFilterField) => {
    setField(next);
    setDraft(query.filters?.find((f) => f.field === next) ?? newDraft(next));
    setFind("");
  };
  const apply = () => {
    if (!draft || !valid) return;
    onQueryChange({
      ...query,
      cursor: undefined,
      filters: [
        ...(query.filters ?? []).filter((f) => f.field !== draft.field),
        ...((draft.field === "result" || draft.field === "playedon") && draft.values.length === 0 ? [] : [draft]),
      ],
    });
    onClose();
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
    if (!field || !facetNext || facetLoading) return;
    const key = facetKey.current;
    setFacetLoading(true);
    onFacets(field, find, facetNext)
      .then((result) => {
        if (facetKey.current !== key || !result) return;
        setFacets((current) => [
          ...current,
          ...result.items.filter((row) => !current.some((prior) => prior.value === row.value)),
        ]);
        setFacetNext(result.next);
      })
      .catch((reason) => {
        if (facetKey.current === key) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (facetKey.current === key) setFacetLoading(false);
      });
  };
  return (
    <LibraryPopover
      title={managingNames ? "My names" : field ? FILTER_LABELS[field] : "Filters"}
      anchor={anchor}
      onClose={onClose}
    >
      {managingNames ? (
        <LibraryMyNames
          names={savedNames}
          query={query}
          onPreview={onPreview}
          onFacets={onFacets}
          onBack={() => setManagingNames(false)}
          onSave={async (names) => {
            if (!onSaveMyNames) throw new Error("My names settings are unavailable.");
            const saved = await onSaveMyNames(names);
            const firstSetup = savedNames.length === 0;
            setSavedNames(saved);
            setManagingNames(false);
            if (firstSetup && saved.length)
              setDraft((previous) => ({
                field: "player",
                values: previous?.field === "player" ? previous.values : [],
                me: true,
              }));
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
                      onClick={() => setManagingNames(true)}
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
                        onChange={(event) => setDraft({ ...draft, me: event.target.checked })}
                      />
                      <span className="lib-option-copy">
                        <strong id={`${meId}-label`}>Me</strong>
                        <span id={`${meId}-names`} className="lib-note lib-me-names">{savedNames.join(", ")}</span>
                      </span>
                      <span id={`${meId}-count`} className="lib-option-count lib-mono lib-muted">
                        {meCount === null ? "—" : `${meCount.toLocaleString()} ${meCount === 1 ? "replay" : "replays"}`}
                      </span>
                    </label>
                    <LibraryButton onClick={() => setManagingNames(true)}>Manage my names</LibraryButton>
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
                <p className="lib-note">Passed, full combo or failed, as the replay records it.</p>
                {rows.map((row) => (
                  <label key={row.value} className="lib-check lib-option-row" style={{ flexDirection: "row" }}>
                    <input
                      type="radio"
                      name="result-filter"
                      checked={row.value === "all" ? draft.values.length === 0 : draft.values[0] === row.value}
                      onChange={() => setDraft({ field: "result", values: row.value === "all" ? [] : [row.value] })}
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
                  Taken from what each replay records. Grade and miss count are never used to guess it. A pass without
                  slider-break data isn't counted as an FC. Choosing a result doesn't start analysis.
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
                          setDraft({
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
                <label>
                  Match
                  <select
                    aria-label="Mod match mode"
                    aria-describedby={draft.mode === "excludes" ? modsHelpId : undefined}
                    value={draft.mode}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        mode: e.target.value as "includes" | "exactly" | "excludes",
                        match: e.target.value === "includes" ? "all" : null,
                      })
                    }
                  >
                    <option value="includes">Includes</option>
                    <option value="exactly">Exactly</option>
                    <option value="excludes">Excludes</option>
                  </select>
                </label>
                {draft.mode === "includes" && (
                  <label>
                    Include
                    <select
                      aria-label="Include selected mods"
                      value={draft.match ?? "all"}
                      onChange={(e) => setDraft({ ...draft, match: e.target.value as "all" | "any" })}
                    >
                      <option value="all">All selected mods</option>
                      <option value="any">Any selected mod</option>
                    </select>
                  </label>
                )}
                {draft.mode === "excludes" && (
                  <p id={modsHelpId} className="lib-note">Exclude replays containing any selected mod.</p>
                )}
                <div className="lib-mod-choices" role="group" aria-label="Mods"
                  aria-describedby={draft.mode === "excludes" ? modsHelpId : undefined}>
                  {FILTER_MODS.map((mod) => (
                    <Tooltip key={mod.acronym} title={`${mod.name} (${mod.acronym})`} describeChild placement="top">
                      <label className="lib-mod-choice">
                        <input
                          className="lib-mod-input"
                          type="checkbox"
                          aria-label={`${mod.name} (${mod.acronym})`}
                          checked={draft.mods.includes(mod.acronym)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              mods: e.target.checked
                                ? [...draft.mods, mod.acronym]
                                : draft.mods.filter((m) => m !== mod.acronym),
                            })
                          }
                        />
                        <span className="lib-mod-face" aria-hidden="true">
                          <img src={FULL_MAP_MOD_ICONS[mod.mod]} alt="" draggable={false} />
                        </span>
                      </label>
                    </Tooltip>
                  ))}
                </div>
                {draft.mode === "exactly" && <p className="lib-note">Select no mods to match No Mod exactly.</p>}
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
                      setDraft(
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
                        onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                      />
                    </label>
                    <label>
                      To
                      <input
                        type="date"
                        value={draft.to}
                        onChange={(e) => setDraft({ ...draft, to: e.target.value })}
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
                      onChange={(e) => setDraft({ ...draft, basis: e.target.value as "map" | "replay" })}
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
                    onChange={(e) => setDraft({ ...draft, min: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </label>
                <label>
                  {field === "len" ? "Maximum length (seconds)" : "Maximum"}
                  <input
                    type="number"
                    value={draft.max ?? ""}
                    onChange={(e) => setDraft({ ...draft, max: e.target.value === "" ? null : Number(e.target.value) })}
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
                      setDraft({
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
                    onChange={(e) => setDraft({ ...draft, a: e.target.value === "" ? NaN : Number(e.target.value) })}
                  />
                </label>
                {draft.op === "between" && (
                  <label>
                    To
                    <input
                      type="number"
                      value={draft.b ?? ""}
                      onChange={(e) => setDraft({ ...draft, b: e.target.value === "" ? null : Number(e.target.value) })}
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
              ? "Checking indexed results…"
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
            <LibraryButton onClick={onClose}>Cancel</LibraryButton>
            <span className="lib-spacer" />
            <LibraryButton className="lib-primary" disabled={!valid} onClick={apply}>
              Apply filter
            </LibraryButton>
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
  return (
    <LibraryPopover title="Edit filters as text" anchor={anchor} onClose={onClose}>
      <p className="lib-note">Edit the same search and filters using text instead of the filter controls.</p>
      <textarea
        data-initial-focus
        aria-label="Query text"
        rows={6}
        value={text}
        style={{ width: "100%" }}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <LibraryButton
        className="lib-primary"
        onClick={() => {
          try {
            onQueryChange({ ...query, ...parseLibraryQueryText(text), cursor: undefined });
            onClose();
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "Invalid query");
          }
        }}
      >
        Apply filters
      </LibraryButton>
    </LibraryPopover>
  );
}
