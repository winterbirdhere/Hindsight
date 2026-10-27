import { Box } from "@mui/material";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LIBRARY_SORTS,
  parseLibraryQueryText,
  type LibraryQuery,
  type LibraryFilterField,
  type LibraryQueryItem,
  type LibraryScope,
  type LibrarySort,
} from "../../../../../shared/library-query";
import { RewindLogo } from "../logo/RewindLogo";
import { GlowButton } from "../analyzer/GlowButton";
import { LibraryActivity } from "./LibraryActivity";
import { libraryOpenButtonSx, libraryRefinementSx } from "./library-refinement-style";
import { LibraryCollections, LibraryMemberships } from "./LibraryCollections";
import {
  FILTER_LABELS,
  LibraryFilters,
  LibraryQueryEditor,
  libraryFilterLabel,
  libraryFilterSuggestions,
  librarySearchWithoutFieldWords,
} from "./LibraryFilters";
import {
  LibraryReplayCard,
  LibraryReplayDetails,
  LibraryReplayRow,
  libraryGradeColor,
} from "./LibraryReplay";
import { LIBRARY_LIST_COLUMNS, LIBRARY_LIST_HEADER_HEIGHT, LIBRARY_LIST_ROW_HEIGHT } from "./library-list-layout";
import { LibrarySources, librarySourceNotFound, librarySourceProblems, librarySourceProgressText } from "./LibrarySources";
import {
  LibraryButton,
  LibraryIcon,
  useLibraryFocusTrap,
  useLibraryMediaQuery,
  useLibraryWidth,
} from "./library-view-controls";
import { LIBRARY_MEDIA, libraryViewSx } from "./library-view-style";
import { SOURCE_LABELS, type ReplayLibraryViewProps } from "./library-view-types";
import { REWIND_COLORS as c } from "../../styles/tokens";

const LIBRARY_QUICK_GRADES = ["SS", "S", "A", "B", "C", "D", "F"];
// Includes the 18px row gap and space for the failed-play explanation.
export const LIBRARY_CARD_ROW_HEIGHT = 384;
export function libraryCurrentBand(rows: LibraryLayoutRow[], scroll: number, resultOffset: number) {
  const headings = rows.filter(row => row.bandKey);
  return [...headings].reverse().find(row => row.top <= scroll - resultOffset + 140)?.bandKey ?? headings[0]?.bandKey;
}
export function libraryBandRailLabel(label: string) {
  return label.replace(/\s+(?:pp|bpm|ms|UR|stars)$/i, "").replace(/★$/, "");
}

/** A layout row has a deterministic height; only a bounded viewport plus overscan is mounted. */
export interface LibraryLayoutRow {
  top: number;
  height: number;
  label?: string;
  bandKey?: string;
  items: { item: LibraryQueryItem; index: number }[];
}
export function libraryLayoutRows(
  items: LibraryQueryItem[],
  columns: number,
  view: "grid" | "list",
  hintBandKey?: string,
): LibraryLayoutRow[] {
  const rows: LibraryLayoutRow[] = [];
  let top = 0,
    index = 0;
  while (index < items.length) {
    const band = items[index].band;
    const height = band.key === hintBandKey ? 112 : 48;
    rows.push({ top, height, label: band.label, bandKey: band.key, items: [] });
    top += height;
    while (index < items.length && items[index].band.key === band.key) {
      const row: LibraryLayoutRow = { top, height: view === "grid" ? LIBRARY_CARD_ROW_HEIGHT : LIBRARY_LIST_ROW_HEIGHT, items: [] };
      for (
        let column = 0;
        column < (view === "grid" ? Math.max(1, columns) : 1) &&
        index < items.length &&
        items[index].band.key === band.key;
        column++, index++
      )
        row.items.push({ item: items[index], index });
      rows.push(row);
      top += row.height;
    }
  }
  return rows;
}

/** Preserve the visible replay when a bounded service window drops preceding rows. */
export function libraryReanchorScroll(previous: LibraryLayoutRow[], next: LibraryLayoutRow[], scroll: number): number {
  // Before the results, the user is looking at the toolbar. Reindexing must not
  // clamp that negative result-relative position and jump down to the first row.
  if (scroll <= 0) return scroll;
  const anchor = previous.find((row) => row.items.length && row.top + row.height > scroll);
  const id = anchor?.items[0]?.item.id;
  const replacement = id ? next.find((row) => row.items.some((entry) => entry.item.id === id)) : undefined;
  return anchor && replacement ? Math.max(0, replacement.top + scroll - anchor.top) : 0;
}

export function ReplayLibraryView(props: ReplayLibraryViewProps) {
  const { query, page, selected, collections, view, sidebarShown, onQueryChange, onSelect } = props;
  const width = useLibraryWidth();
  const [overlay, setOverlay] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [filter, setFilter] = useState<{ anchor: HTMLElement; field?: LibraryFilterField } | null>(null);
  const [queryAnchor, setQueryAnchor] = useState<HTMLElement | null>(null);
  const [searchSuggestions, setSearchSuggestions] = useState(false);
  const searchConversion = useMemo(() => {
    try {
      const parsed = parseLibraryQueryText(query.search ?? "");
      return parsed.filters?.length ? parsed : null;
    } catch {
      // An incomplete or invalid clause remains literal until explicitly edited.
      return null;
    }
  }, [query.search]);
  const skipSearchFocus = useRef(false);
  const [save, setSave] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const removalScope = JSON.stringify([query, page.total, !!filter]);
  const [removalResult, setRemovalResult] = useState<{
    scope: string;
    revision?: string;
    counts: Record<string, number | null>;
  } | null>(null);
  const removalCounts = removalResult?.scope === removalScope ? removalResult.counts : {};
  const previewReader = useRef(props.onPreview);
  previewReader.current = props.onPreview;
  const removalBatch = useRef<{ cancelled: boolean; started: boolean } | null>(null);
  useEffect(() => {
    const batch = { cancelled: false, started: false };
    removalBatch.current = batch;
    return () => {
      batch.cancelled = true;
    };
  }, [removalScope]);
  useEffect(() => {
    const batch = removalBatch.current;
    if (!batch || batch.cancelled || batch.started) return;
    if (page.total !== 0 || props.loading || props.updating || filter) return;
    if (removalResult?.scope === removalScope && removalResult.revision === page.revision) return;
    batch.started = true;
    // Bounded by the twenty applied fields; each count is a passive indexed read.
    // Revisions may advance faster than two passive previews finish. Complete one
    // same-query batch, then coalesce newer revisions into one follow-up batch.
    void (async () => {
      const counts: Record<string, number | null> = {};
      for (const active of query.filters ?? []) {
        if (batch.cancelled) return;
        const without: LibraryQuery = {
          ...query,
          cursor: undefined,
          filters: query.filters?.filter((filter) => filter.field !== active.field),
        };
        try {
          const result = await previewReader.current(without);
          counts[active.field] = result?.count ?? null;
        } catch {
          counts[active.field] = null;
        }
      }
      // These are the last completed same-query counts, not a claim about the
      // latest revision. Replace the batch together; query/editor changes cancel it.
      batch.started = false;
      if (!batch.cancelled) setRemovalResult({ scope: removalScope, revision: page.revision, counts });
    })();
    // Only query/editor identity changes cancel; publications do not restart work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removalScope, page.revision, props.loading, props.updating, removalResult]);
  const [scroll, setScroll] = useState(props.scrollTop ?? 0);
  const [columns, setColumns] = useState(3);
  const [viewportHeight, setViewportHeight] = useState(900);
  const reducedMotion = useLibraryMediaQuery("(prefers-reduced-motion: reduce)", false);
  const pendingBand = useRef<{ key: string; anchorId?: string } | null>(null);
  const [jumpedBand, setJumpedBand] = useState<string | null>(null);
  const [flashBand, setFlashBand] = useState<string | null>(null);
  useEffect(() => {
    if (!flashBand) return;
    const timer = setTimeout(() => setFlashBand(null), 900);
    return () => clearTimeout(timer);
  }, [flashBand]);
  const main = useRef<HTMLElement>(null),
    results = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    sidebar = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    sourcesButton = useRef<HTMLButtonElement>(null);
  const sourcesOpener = useRef<HTMLButtonElement | null>(null);
  const sourcesReturnFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (sourcesReturnFrame.current !== null) cancelAnimationFrame(sourcesReturnFrame.current);
      sourcesReturnFrame.current = null;
    },
    [],
  );
  const openSources = (event?: { currentTarget: HTMLButtonElement }) => {
    if (sourcesReturnFrame.current !== null) cancelAnimationFrame(sourcesReturnFrame.current);
    sourcesReturnFrame.current = null;
    sourcesOpener.current = event?.currentTarget ?? null;
    setSourcesOpen(true);
  };
  const closeSources = () => {
    setSourcesOpen(false);
    if (sourcesReturnFrame.current !== null) cancelAnimationFrame(sourcesReturnFrame.current);
    const origin = sourcesOpener.current;
    const frame = requestAnimationFrame(() => {
      if (sourcesReturnFrame.current !== frame) return;
      sourcesReturnFrame.current = null;
      const target = origin?.isConnected ? origin : sourcesButton.current;
      if (target?.isConnected) target.focus();
    });
    sourcesReturnFrame.current = frame;
  };
  const [resultOffset, setResultOffset] = useState(220);
  const listScroll = useRef<HTMLDivElement>(null);
  const precedingLayout = useRef<{ rows: LibraryLayoutRow[]; pageStart: number; revealSequence?: number } | null>(null);
  const handledFocus = useRef<number | null>(null);
  const handledReveal = useRef<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const modal = useLibraryMediaQuery(LIBRARY_MEDIA.drawer, width < 1280);
  const dockedSidebar = !useLibraryMediaQuery(LIBRARY_MEDIA.sidebar, width < 900);
  const hasSelection = selected !== null;
  const revealRequest = props.revealRequest;
  const pageStart = props.pageStart ?? 0;
  const pendingList = view === "list" && props.loading && !props.initialLoading;
  const onScrollTopChange = props.onScrollTopChange;
  const focusRequest = props.focusRequest;
  const membershipTarget = useRef(props.onMembershipTarget);
  membershipTarget.current = props.onMembershipTarget;
  const saveId = save?.id ?? selected?.item.id ?? null;
  const sideVisible = dockedSidebar ? sidebarShown : overlay;
  const unknownPPBand = props.bands?.find((band) => band.label === "No PP data");
  const ppHint =
    (query.sort ?? "pp") === "pp" &&
    !props.bandsNext &&
    props.bands?.reduce((sum, band) => sum + band.count, 0) === page.total &&
    unknownPPBand &&
    unknownPPBand.count > page.total / 2
      ? { key: unknownPPBand.key, known: page.total - unknownPPBand.count }
      : undefined;
  const hintBandKey = ppHint?.key;
  const rows = useMemo(
    () => libraryLayoutRows(page.items, columns, view, hintBandKey),
    [page.items, columns, view, hintBandKey],
  );
  const totalHeight = rows.length ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0;
  const currentBand = jumpedBand ?? libraryCurrentBand(rows, scroll, resultOffset + (view === "list" ? LIBRARY_LIST_HEADER_HEIGHT : 0));
  const bandQueryKey = JSON.stringify([query.scope, query.search, query.filters, query.sort, query.direction]);
  useEffect(() => { pendingBand.current = null; setJumpedBand(null); setFlashBand(null); }, [bandQueryKey]);
  useEffect(() => { if (props.error) pendingBand.current = null; }, [props.error]);
  const jumpBand = (key: string) => {
    const row = rows.find(entry => entry.bandKey === key);
    const anchor = props.bands?.find(band => band.key === key)?.anchorId;
    if (row && main.current && (!anchor || page.items.some(item => item.id === anchor))) {
      setJumpedBand(key);
      pendingBand.current = null;
      if (!reducedMotion) setFlashBand(key);
      const top = row.top + resultOffset + (view === "list" ? LIBRARY_LIST_HEADER_HEIGHT : 0);
      if (typeof main.current.scrollTo === "function") main.current.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
      else main.current.scrollTop = top;
      // onScroll publishes actual positions. Publishing the target here would
      // make the controlled restoration effect cancel a smooth scroll.
    } else {
      pendingBand.current = { key, anchorId: anchor };
      props.onJumpBand?.(key);
    }
  };
  const visibleRows = rows.filter(
    (row) =>
      row.top + row.height >= scroll - resultOffset - 400 && row.top <= scroll - resultOffset + viewportHeight + 400,
  );
  // Mount the existing overscan, but admit the actual viewport first. The
  // coordinator prepends the selected replay and retains the 32-item ceiling.
  const inViewport = (row: LibraryLayoutRow) => row.top + row.height > scroll - resultOffset &&
    row.top < scroll - resultOffset + viewportHeight;
  const visibleReplayKey = JSON.stringify([
    ...visibleRows.filter(inViewport),
    ...visibleRows.filter(row => !inViewport(row)),
  ].flatMap(row => row.items.map(entry => entry.item.id)));
  const visibleReplayCallback = useRef(props.onVisibleReplays);
  visibleReplayCallback.current = props.onVisibleReplays;
  useEffect(() => {
    visibleReplayCallback.current?.(JSON.parse(visibleReplayKey) as string[]);
  }, [visibleReplayKey]);
  const firstTop = visibleRows[0]?.top ?? 0;
  const last = visibleRows[visibleRows.length - 1];
  const lastBottom = last ? last.top + last.height : 0;
  const closePanel = () => {
    props.onSelect(null);
    setSave(null);
    if (!opener.current?.isConnected && main.current) {
      main.current.scrollTop = 0;
      setScroll(0);
      props.onScrollTopChange?.(0);
    }
    requestAnimationFrame(() => {
      const target = opener.current?.isConnected
        ? opener.current
        : main.current?.querySelector<HTMLElement>("[data-replay-id]") ?? search.current;
      target?.focus();
    });
  };
  const closeSidebar = () => {
    setOverlay(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  const changeScope = (scope: LibraryScope) => {
    onQueryChange({ ...query, scope, cursor: undefined });
    if (!dockedSidebar) closeSidebar();
  };
  const sort = (value: LibrarySort) =>
    onQueryChange({ ...query, sort: value, direction: LIBRARY_SORTS[value].direction, cursor: undefined });
  const activeSort = query.sort ?? "pp";
  const activeDirection = query.direction ?? LIBRARY_SORTS[activeSort].direction;
  const sortHeader = (value: LibrarySort) => onQueryChange({
    ...query, sort: value,
    direction: value === activeSort ? (activeDirection === "asc" ? "desc" : "asc") : LIBRARY_SORTS[value].direction,
    cursor: undefined,
  });
  const quickFacet = (field: "source" | "grade", value: string | null) => {
    const previous = query.filters?.find((f) => f.field === field);
    const current = previous && "values" in previous ? previous.values : field === "grade" ? LIBRARY_QUICK_GRADES : [];
    const values =
      value === null
        ? []
        : field === "source"
        ? [value]
        : current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
    const other = (query.filters ?? []).filter((f) => f.field !== field);
    const normalizedValues =
      field === "grade"
        ? [
            ...LIBRARY_QUICK_GRADES.filter((grade) => values.includes(grade)),
            ...values.filter((grade) => !LIBRARY_QUICK_GRADES.includes(grade)),
          ]
        : values;
    const remove =
      field === "grade"
        ? normalizedValues.length === LIBRARY_QUICK_GRADES.length &&
          LIBRARY_QUICK_GRADES.every((grade) => normalizedValues.includes(grade))
        : normalizedValues.length === 0;
    onQueryChange({
      ...query,
      cursor: undefined,
      filters: remove ? other : [...other, { field, values: normalizedValues }],
    });
  };
  useLibraryFocusTrap(sidebar, overlay && !dockedSidebar);
  useEffect(() => {
    membershipTarget.current?.(saveId);
    return () => membershipTarget.current?.(null);
  }, [saveId]);
  useEffect(() => {
    setOverlay(false);
  }, [dockedSidebar]);
  useLayoutEffect(() => {
    const measure = () => {
      if (results.current && main.current) {
        setColumns(Math.max(1, Math.floor((results.current.clientWidth + 18) / 302)));
        setViewportHeight(main.current.clientHeight || window.innerHeight - 52);
        setResultOffset(
          results.current.getBoundingClientRect().top -
            main.current.getBoundingClientRect().top +
            main.current.scrollTop,
        );
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (results.current) observer.observe(results.current);
    if (main.current) observer.observe(main.current);
    return () => observer.disconnect();
  }, [sidebarShown, hasSelection, width, view, query.filters?.length]);
  useLayoutEffect(() => {
    if (main.current && props.scrollTop !== undefined && Math.abs(main.current.scrollTop - props.scrollTop) > 1) {
      main.current.scrollTop = props.scrollTop;
      setScroll(props.scrollTop);
    }
  }, [props.scrollTop]);
  useLayoutEffect(() => {
    const previous = precedingLayout.current;
    precedingLayout.current = { rows, pageStart, revealSequence: revealRequest?.sequence };
    if (
      !previous ||
      previous.pageStart === pageStart ||
      previous.revealSequence !== revealRequest?.sequence ||
      !main.current
    )
      return;
    const anchored = libraryReanchorScroll(previous.rows, rows, main.current.scrollTop - resultOffset) + resultOffset;
    main.current.scrollTop = anchored;
    setScroll(anchored);
    onScrollTopChange?.(anchored);
  }, [rows, pageStart, onScrollTopChange, revealRequest?.sequence, resultOffset]);
  useLayoutEffect(() => {
    if (listScroll.current && props.scrollLeft !== undefined) listScroll.current.scrollLeft = props.scrollLeft;
  }, [props.scrollLeft, view]);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest.sequence) return;
    if (focusRequest.kind === "search") {
      search.current?.focus();
      handledFocus.current = focusRequest.sequence;
      return;
    }
    const requestedId = focusRequest.kind === "item" ? focusRequest.id : page.items[0]?.id;
    const row = rows.find((entry) => entry.items.some(({ item }) => item.id === requestedId));
    if (
      row &&
      main.current &&
      !Array.from(main.current.querySelectorAll<HTMLElement>("[data-replay-id]")).some(
        (node) => node.dataset.replayId === requestedId,
      )
    ) {
      main.current.scrollTop = row.top + resultOffset;
      setScroll(main.current.scrollTop);
    }
    const frame = requestAnimationFrame(() => {
      const targets = Array.from(main.current?.querySelectorAll<HTMLElement>("[data-replay-id]") ?? []);
      (targets.find((node) => node.dataset.replayId === requestedId) ?? targets[0] ?? search.current)?.focus();
      handledFocus.current = focusRequest.sequence;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, page.items, rows, resultOffset]);
  useEffect(() => {
    if (!revealRequest || handledReveal.current === revealRequest.sequence || !main.current) return;
    // Read the committed geometry rather than the initial measurement state:
    // this command is consumed once, including on the mount after viewer return.
    const measuredColumns = results.current?.clientWidth
      ? Math.max(1, Math.floor((results.current.clientWidth + 18) / 302))
      : columns;
    const layout = libraryLayoutRows(page.items, measuredColumns, view, hintBandKey);
    if (pendingBand.current?.anchorId !== revealRequest.id) pendingBand.current = null;
    const bandRow = pendingBand.current ? layout.find(row => row.bandKey === pendingBand.current?.key) : undefined;
    const row = bandRow ?? layout.find((r) => r.items.some(({ item }) => item.id === revealRequest.id));
    if (!row) return;
    const offset = results.current
      ? results.current.getBoundingClientRect().top - main.current.getBoundingClientRect().top + main.current.scrollTop
      : resultOffset;
    main.current.scrollTop = row.top + offset + (bandRow && view === "list" ? LIBRARY_LIST_HEADER_HEIGHT : 0);
    setScroll(main.current.scrollTop);
    if (bandRow) {
      setJumpedBand(bandRow.bandKey ?? null);
      if (!reducedMotion) setFlashBand(bandRow.bandKey ?? null);
      pendingBand.current = null;
    }
    handledReveal.current = revealRequest.sequence;
  }, [revealRequest, page.items, columns, view, resultOffset, hintBandKey, reducedMotion]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !sourcesOpen &&
        !overlay &&
        !filter &&
        !queryAnchor &&
        !(selected && modal)
      ) {
        event.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sourcesOpen, overlay, filter, queryAnchor, selected, modal]);
  const collectionId = query.scope?.kind === "collection" ? query.scope.id : null;
  const scopeName = collectionId
    ? collections.find((c) => c.id === collectionId)?.name ?? "Collection"
    : query.scope?.kind === "recent"
    ? "Recent"
    : query.scope?.kind === "favourites"
    ? "Favourites"
    : "Library";
  const scoped = (query.scope?.kind ?? "all") !== "all";
  const connectedSources =
    props.sources.status?.sources.filter((source) => source.enabled && !librarySourceNotFound(source)) ?? [];
  const relevantSources = connectedSources.filter(
    (source) => source.kind !== "imported" || source.hasIndexHistory === true || source.observations > 0,
  );
  const troubledSources = connectedSources.filter((source) => librarySourceProblems(source).length > 0);
  const sourceNoticeDetail = troubledSources
    .map(
      (source) =>
        `${SOURCE_LABELS[source.kind]}: ${librarySourceProblems(source)
          .map((problem) => problem.title)
          .join("; ")}.`,
    )
    .join(" ");
  const sourceWork = [props.sources.status?.rebuild.state, ...connectedSources.map((source) => source.state)];
  // Service status already normalizes active work; pending alone can be retained dirty intent after failure.
  const emptyLibraryMessage =
    sourceWork.includes("scanning")
      ? {
          title: "Indexing your replay library",
          detail: "Your connected sources are being indexed. Replays appear as their records become available.",
        }
      : sourceWork.includes("queued")
      ? {
          title: "Preparing your replay library",
          detail: "Source indexing is queued. You can check its progress in Sources.",
        }
      : sourceWork.includes("waiting-for-viewer")
      ? {
          title: "Library indexing is waiting",
          detail: "Source indexing is waiting for the viewer. Its current status is available in Sources.",
        }
      : props.loading || props.updating || !props.sources.status
      ? {
          title: "Reading your replay library",
          detail: "Checking the current index and source status.",
        }
      : relevantSources.length > 0 && relevantSources.every((source) => source.state === "error")
      ? { title: "Hindsight can't read your sources", detail: sourceNoticeDetail }
      : relevantSources.length
      ? {
          title: "No replays found",
          detail: "No replays are currently indexed from your connected sources. Check Sources or import replay files.",
        }
      : null;
  const saveItem = save
    ? selected?.item.id === save.id
      ? selected.item
      : page.items.find((item) => item.id === save.id)
    : undefined;
  const renderItem = ({ item, index }: LibraryLayoutRow["items"][number]) => {
    const Component = view === "grid" ? LibraryReplayCard : LibraryReplayRow;
    return (
      <Component
        key={item.id}
        item={item}
        sort={query.sort}
        resource={props.resources?.[item.id]}
        index={index + (props.pageStart ?? 0)}
        selected={selected?.item.id === item.id}
        onSelect={() => {
          opener.current =
            Array.from(main.current?.querySelectorAll<HTMLElement>("[data-replay-id]") ?? []).find(
              (el) => el.dataset.replayId === item.id,
            ) ?? null;
          onSelect(item.id);
        }}
        onOpen={() => props.openError?.replayId === item.id && props.openError.reason === "exact-map-unavailable" ? onSelect(item.id) : props.onOpen(item.id)}
        onSave={(anchor) => setSave({ id: item.id, anchor })}
      />
    );
  };
  return (
    <Box
      sx={[libraryViewSx, libraryRefinementSx]}
      data-testid="replay-library"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !filter && !queryAnchor && !save && !sourcesOpen) {
          if (searchSuggestions) {
            event.stopPropagation();
            setSearchSuggestions(false);
            skipSearchFocus.current = true;
            search.current?.focus();
          } else if (overlay) closeSidebar();
          else if (selected) closePanel();
        }
      }}
    >
      <header className="lib-header">
        <button
          type="button"
          ref={toggle}
          className="lib-button"
          aria-label={sideVisible ? "Hide library sidebar" : "Show library sidebar"}
          aria-expanded={sideVisible}
          aria-controls="library-sidebar"
          onClick={() => (!dockedSidebar ? setOverlay(!overlay) : props.onSidebarChange(!sidebarShown))}
        >
          <LibraryIcon name="sidebar" />
        </button>
        <div className="lib-row">
          <RewindLogo size={24} />
          <strong style={{ fontSize: 15, letterSpacing: "-.02em" }}>Hindsight</strong>
        </div>
        <span className="lib-spacer" />
        <button type="button" ref={sourcesButton} className="lib-button" onClick={openSources}>
          <LibraryIcon name="folder" />
          Sources
        </button>
        {!props.nowPlaying && props.onOpenReplayFile && (
          <GlowButton
            sx={{ "&&": libraryOpenButtonSx }}
            aria-label="Open replay"
            aria-keyshortcuts="F2"
            title="Open replay · F2"
            onClick={() => void props.onOpenReplayFile?.()}
          >
            <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><rect x="1" y="1" width="5" height="3" rx=".8" fill={c.accentSoft} /><rect x="1" y="3" width="12" height="8" rx="1.2" fill="none" stroke={c.accentSoft} strokeWidth="1.4" /></svg>
            Open replay
            <span className="lib-open-shortcut" aria-hidden="true">F2</span>
          </GlowButton>
        )}
        {props.nowPlaying && (
          <LibraryButton
            className="lib-now"
            aria-label={`Back to ${props.nowPlaying.title} in the viewer${
              props.nowPlaying.position ? `, at ${props.nowPlaying.position}` : ""
            }`}
            onClick={props.onReturnToViewer}
          >
            <span aria-hidden="true" className="lib-now-art">
              {props.nowPlaying.artUrl && (
                <img
                  src={props.nowPlaying.artUrl}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
            </span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}>
                {props.nowPlaying.title}
              </span>
              <span className="lib-mono lib-muted" style={{ fontSize: 10 }}>
                open in viewer{props.nowPlaying.position ? ` · ${props.nowPlaying.position}` : ""}
              </span>
            </span>
            <LibraryIcon name="chevron" />
          </LibraryButton>
        )}
      </header>
      <div role="status" aria-live="polite" className="lib-sr">
        {props.announcement ?? ""}
      </div>
      <div className="lib-body">
        {sideVisible && (
          <>
            {!dockedSidebar && (
              <button
                type="button"
                className="lib-scrim"
                aria-label="Close library sidebar"
                tabIndex={-1}
                onClick={closeSidebar}
              />
            )}
            <nav
              ref={sidebar}
              id="library-sidebar"
              className="lib-sidebar"
              aria-label="Library views"
              role={!dockedSidebar ? "dialog" : undefined}
              aria-modal={!dockedSidebar ? true : undefined}
              onKeyDown={(e) => {
                if (e.key === "Escape" && !dockedSidebar && !document.querySelector(".lib-popover")) {
                  e.stopPropagation();
                  closeSidebar();
                }
              }}
            >
              {(
                [
                  ["all", "All replays", "grid"],
                  ["recent", "Recent", "clock"],
                  ["favourites", "Favourites", "heart"],
                ] as const
              ).map(([kind, label, icon]) => (
                <LibraryButton
                  key={kind}
                  className="lib-scope"
                  aria-current={(query.scope?.kind ?? "all") === kind ? "page" : undefined}
                  onClick={() => changeScope({ kind })}
                >
                  <LibraryIcon name={icon} />
                  <span className="lib-spacer">{label}</span>
                  <span className="lib-mono lib-muted">{props.scopeCounts?.[kind]?.toLocaleString() ?? "—"}</span>
                </LibraryButton>
              ))}
              <LibraryCollections
                collections={collections}
                query={query}
                onScope={(id) => changeScope({ kind: "collection", id })}
                onCollectionCreate={props.onCollectionCreate}
                onCollectionRename={props.onCollectionRename}
                onCollectionDelete={props.onCollectionDelete}
              />
              {props.collectionsNext && (
                <LibraryButton onClick={props.onLoadMoreCollections}>More collections</LibraryButton>
              )}
              <p className="lib-note" style={{ margin: "26px 10px" }}>
                Save a replay with the bookmark on its card, or Add to collection in the replay panel.
              </p>
            </nav>
          </>
        )}
        <main
          ref={main}
          className="lib-main"
          aria-label="Replay library"
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setScroll(top);
            setJumpedBand(null);
            props.onScrollTopChange?.(top);
          }}
        >
          <div className="lib-main-inner">
            <div className="lib-title-row">
              <div className="lib-title-group">
              <h1 className="lib-title">{scopeName}</h1>
              <span className="lib-mono lib-muted lib-title-count">
                {page.total.toLocaleString()} {page.total === 1 ? "replay" : "replays"}
              </span>
              </div>
              <LibraryActivity sources={props.sources} loading={props.initialLoading} listedCount={props.scopeCounts?.all} announce={!sourcesOpen} onOpenSources={openSources} />
            </div>
            <div className="lib-toolbar">
              <div
                className="lib-search"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchSuggestions(false);
                }}
              >
                <LibraryIcon name="search" />
                <input
                  ref={search}
                  aria-label="Search replays"
                  placeholder="Search title, artist, mapper or player"
                  value={query.search ?? ""}
                  onFocus={() => {
                    if (skipSearchFocus.current) skipSearchFocus.current = false;
                    else setSearchSuggestions(true);
                  }}
                  onKeyDown={(event) => {
                    if (searchSuggestions && event.key === "Escape") {
                      event.stopPropagation();
                      setSearchSuggestions(false);
                    } else if (searchSuggestions && event.key === "ArrowDown") {
                      event.preventDefault();
                      event.currentTarget.parentElement
                        ?.querySelector<HTMLButtonElement>(".lib-search-suggestions button")
                        ?.focus();
                    }
                  }}
                  onChange={(e) => onQueryChange({ ...query, search: e.target.value, cursor: undefined })}
                />
                <span className="lib-mono lib-muted lib-hide-small" style={{ paddingRight: 12, fontSize: 10 }}>
                  Ctrl+F
                </span>
                {searchSuggestions && !filter && (
                  <div className="lib-search-suggestions" aria-label="Filter suggestions">
                    {searchConversion && (
                      <LibraryButton
                        className="lib-menu-item"
                        onClick={() => {
                          const filters = [...(query.filters ?? [])];
                          for (const converted of searchConversion.filters ?? []) {
                            const index = filters.findIndex((active) => active.field === converted.field);
                            if (index < 0) filters.push(converted);
                            else filters[index] = converted;
                          }
                          skipSearchFocus.current = true;
                          setSearchSuggestions(false);
                          onQueryChange({ ...query, search: searchConversion.search, filters, cursor: undefined });
                          search.current?.focus();
                        }}
                      >
                        <span>
                          {searchConversion.filters?.length === 1
                            ? "Turn this into a filter"
                            : `Turn these into ${searchConversion.filters?.length} filters`}
                          <span className="lib-note" style={{ display: "block" }}>
                            {searchConversion.filters?.map((active) => libraryFilterLabel(active)).join(" · ")}
                          </span>
                        </span>
                      </LibraryButton>
                    )}
                    <div className="lib-label">{query.search ? "Filters" : "Common filters"}</div>
                    {libraryFilterSuggestions(query.search ?? "").map((field) => (
                      <LibraryButton
                        key={field}
                        className="lib-menu-item"
                        onClick={() => {
                          skipSearchFocus.current = true;
                          setSearchSuggestions(false);
                          onQueryChange({
                            ...query,
                            search: librarySearchWithoutFieldWords(query.search ?? "", field),
                            cursor: undefined,
                          });
                          if (search.current) setFilter({ anchor: search.current, field });
                        }}
                      >
                        {FILTER_LABELS[field]}
                      </LibraryButton>
                    ))}
                    <div className="lib-all-filters" role="group" aria-label="All filters">
                      <LibraryButton
                        className="lib-all-filters-button"
                        aria-describedby="library-all-filters-description"
                        onClick={() => {
                          skipSearchFocus.current = true;
                          setSearchSuggestions(false);
                          if (search.current) setFilter({ anchor: search.current });
                        }}
                      >
                        <LibraryIcon name="filter" />
                        <span className="lib-spacer">Browse all filters</span>
                        <LibraryIcon name="chevron" />
                      </LibraryButton>
                      <p id="library-all-filters-description" className="lib-note">20 filters for beatmap, replay, analysis and library</p>
                    </div>
                  </div>
                )}
              </div>
              <LibraryButton className="lib-raised" onClick={(e) => setFilter({ anchor: e.currentTarget })}>
                <LibraryIcon name="filter" />
                Filters
              </LibraryButton>
              <select
                aria-label="Sort replays"
                value={query.sort ?? "pp"}
                onChange={(e) => sort(e.target.value as LibrarySort)}
              >
                {Object.entries(LIBRARY_SORTS).map(([value, entry]) => (
                  <option key={value} value={value}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <LibraryButton
                className="lib-raised"
                aria-label="Reverse sort direction"
                onClick={() =>
                  onQueryChange({
                    ...query,
                    direction:
                      (query.direction ?? LIBRARY_SORTS[query.sort ?? "pp"].direction) === "asc" ? "desc" : "asc",
                    cursor: undefined,
                  })
                }
              >
                <LibraryIcon name="sort" />
                <span className="lib-hide-small">
                  {(query.direction ?? LIBRARY_SORTS[query.sort ?? "pp"].direction) === "asc"
                    ? "Low to high"
                    : "High to low"}
                </span>
              </LibraryButton>
              <div className="lib-row" role="group" aria-label="Replay layout" style={{ gap: 0 }}>
                {(
                  [
                    ["grid", "Grid"],
                    ["list", "List"],
                  ] as const
                ).map(([layout, label]) => (
                  <LibraryButton
                    key={layout}
                    aria-label={`${label} view`}
                    aria-pressed={view === layout}
                    className="lib-choice"
                    onClick={() => props.onViewChange(layout)}
                  >
                    <LibraryIcon name={layout} />
                  </LibraryButton>
                ))}
              </div>
            </div>
            <div className="lib-quick">
              <span className="lib-label" style={{ fontSize: 10 }}>
                Source
              </span>
              <div
                className="lib-row"
                role="group"
                aria-label="Quick source filter"
                style={{ gap: 0, flexWrap: "wrap" }}
              >
                {(
                  [
                    ["all", "All"],
                    ["stable", "osu! local"],
                    ["replays", "Replays folder"],
                    ["lazer", "osu!lazer"],
                    ["imported", "Imported"],
                  ] as const
                ).map(([kind, label]) => {
                  const active = query.filters?.find((f) => f.field === "source");
                  const isActive =
                    kind === "all" ? !active : !!active && "values" in active && active.values.includes(kind);
                  return (
                    <LibraryButton
                      key={kind}
                      title={kind === "all" ? "Unique replays across sources" : "The same replay may appear in several sources."}
                      aria-pressed={isActive}
                      className="lib-choice"
                      style={{ fontSize: 11.5, minHeight: 26, padding: "3px 7px" }}
                      onClick={() => quickFacet("source", kind === "all" ? null : kind)}
                    >
                      {label}
                      <span className="lib-mono lib-muted" style={{ fontSize: 10 }}>
                        {kind === "all"
                          ? props.scopeCounts?.all?.toLocaleString()
                          : props.sourceCounts?.[kind]?.toLocaleString()}
                      </span>
                    </LibraryButton>
                  );
                })}
              </div>
              <span className="lib-label" style={{ fontSize: 10 }}>
                Grade
              </span>
              <div className="lib-row" role="group" aria-label="Quick grade filter" style={{ gap: 2 }}>
                {LIBRARY_QUICK_GRADES.map((grade) => {
                  const active = query.filters?.find((f) => f.field === "grade");
                  const chosen = !active || ("values" in active && active.values.includes(grade));
                  return (
                    <LibraryButton
                      key={grade}
                      aria-label={`Grade ${grade}`}
                      aria-pressed={chosen}
                      style={{
                        minWidth: 30,
                        height: 28,
                        minHeight: 28,
                        padding: "0 5px",
                        fontSize: 13.5,
                        letterSpacing: "-.01em",
                        color: chosen ? libraryGradeColor({ grade, mods: [] }) : c.textDim,
                        fontWeight: 600,
                        boxShadow: `inset 0 -2px 0 ${chosen ? "currentColor" : "transparent"}`,
                        borderRadius: 0,
                      }}
                      onClick={() => quickFacet("grade", grade)}
                    >
                      {grade}
                    </LibraryButton>
                  );
                })}
              </div>
              {(
                [
                  ["mods", "Mods"],
                  ["player", "Player"],
                ] as const
              ).map(([field, label]) => {
                const active = query.filters?.find((filter) => filter.field === field),
                  text = active
                    ? libraryFilterLabel(active, props.myNames?.names)
                    : `${label} ${field === "player" ? "Everyone" : "Any"}`;
                return (
                  <LibraryButton
                    key={field}
                    title={text}
                    onClick={(e) => setFilter({ anchor: e.currentTarget, field })}
                  >
                    <span className="lib-quick-value">{text}</span>
                    <LibraryIcon name="down" />
                  </LibraryButton>
                );
              })}
              <span className="lib-spacer" />
              <LibraryButton onClick={(e) => setQueryAnchor(e.currentTarget)}>Edit filters as text…</LibraryButton>
            </div>
            {!!query.filters?.length && (
              <div className="lib-row" style={{ flexWrap: "wrap" }}>
                {query.filters.map((active) => (
                  <span className="lib-chip lib-filter-chip" key={active.field}>
                    <LibraryButton
                      className="lib-filter-chip-edit"
                      title={libraryFilterLabel(active, props.myNames?.names)}
                      onClick={(e) => setFilter({ anchor: e.currentTarget, field: active.field })}
                    >
                      <span>{libraryFilterLabel(active, props.myNames?.names)}</span>
                    </LibraryButton>
                    <LibraryButton
                      className="lib-filter-chip-remove"
                      aria-label={`Remove ${FILTER_LABELS[active.field]} filter`}
                      onClick={() =>
                        onQueryChange({
                          ...query,
                          cursor: undefined,
                          filters: query.filters?.filter((f) => f.field !== active.field),
                        })
                      }
                    >
                      <LibraryIcon name="close" />
                    </LibraryButton>
                  </span>
                ))}
                <LibraryButton onClick={() => onQueryChange({ ...query, filters: [], cursor: undefined })}>
                  Clear filters
                </LibraryButton>
              </div>
            )}
            {page.analysisExcluded > 0 && (
              <p className="lib-note">
                {page.analysisExcluded.toLocaleString()} replays lack data needed by these filters. Filtering doesn't
                start analysis.
              </p>
            )}
            {page.resultExcluded && (
              <div className="lib-note">
                {page.resultExcluded.unknownOutcome > 0 && (
                  <p>
                    {page.resultExcluded.unknownOutcome.toLocaleString()} replays have no recorded outcome and aren't
                    included.{" "}
                    <LibraryButton
                      onClick={() =>
                        onQueryChange({
                          ...query,
                          cursor: undefined,
                          filters: [
                            ...(query.filters ?? []).filter((filter) => filter.field !== "result"),
                            { field: "result", values: ["unknown"] },
                          ],
                        })
                      }
                    >
                      Result: Unknown
                    </LibraryButton>
                  </p>
                )}
                {page.resultExcluded.missingBreakEvidence > 0 && (
                  <p>
                    {page.resultExcluded.missingBreakEvidence.toLocaleString()} passed replays lack complete
                    slider-break evidence and aren't counted as FC. Filtering doesn't start analysis.{" "}
                    <LibraryButton onClick={openSources}>Analysis settings</LibraryButton>
                  </p>
                )}
              </div>
            )}
            {props.error && (
              <div role="alert" className="lib-problem">
                <strong>Library results couldn't be read.</strong>
                <details>
                  <summary>Details</summary>
                  <pre>{props.error}</pre>
                </details>
                <LibraryButton onClick={() => onQueryChange({ ...query })}>Refresh results</LibraryButton>
              </div>
            )}
            {props.openError && props.openError.replayId !== selected?.item.id && (
              <div role="alert" className="lib-problem">
                <strong>The replay couldn't be opened.</strong>
                <details><summary>Details</summary><pre>{props.openError.message}</pre></details>
              </div>
            )}
            {props.loading && (
              <p role="status" className="lib-sr">
                Reading indexed replays…
              </p>
            )}
            {!props.loading && props.updating && (
              <p role="status" className="lib-sr">
                Updating indexed results…
              </p>
            )}
            {!page.items.length && !pendingList && (
              <div className="lib-empty">
                <h2>
                  {page.total
                    ? "This page is unavailable"
                    : query.search || query.filters?.length
                    ? "No replays match"
                    : query.scope?.kind === "recent"
                    ? "No recent replays"
                    : query.scope?.kind === "favourites"
                    ? "No favourite replays yet"
                    : scoped
                    ? "This collection is empty"
                    : emptyLibraryMessage?.title ?? "Your replay library starts here"}
                </h2>
                <p className="lib-note">
                  {page.total
                    ? "Refresh these results to continue browsing."
                    : query.search || query.filters?.length
                    ? "Try a shorter search or remove a filter."
                    : query.scope?.kind === "recent"
                    ? "Replays played in the last 7 days appear here. Browse All replays to find your other plays."
                    : query.scope?.kind === "favourites"
                    ? "Add a replay to Favourites from its bookmark or replay panel."
                    : scoped
                    ? "Save a replay to this collection with its bookmark or Add to collection in the replay panel."
                    : emptyLibraryMessage?.detail ??
                      "Connect osu! stable, its Replays folder, or osu!lazer in Sources, or import replay files."}
                </p>
                {!scoped &&
                  !query.search &&
                  !query.filters?.length &&
                  sourceWork.some((state) => state && ["scanning", "queued", "waiting-for-viewer"].includes(state)) && (
                    <ul className="lib-index-progress">
                      {connectedSources
                        .filter((source) => source.kind !== "imported")
                        .map((source) => (
                          <li key={source.sourceId}>
                            {SOURCE_LABELS[source.kind]} ·{" "}
                            {librarySourceProgressText(source)}
                          </li>
                        ))}
                    </ul>
                  )}
                {page.total === 0 && !!query.filters?.length && (
                  <div className="lib-removal-suggestions">
                    {query.filters.map((active) => (
                      <LibraryButton
                        key={active.field}
                        onClick={() =>
                          onQueryChange({
                            ...query,
                            cursor: undefined,
                            filters: query.filters?.filter((filter) => filter.field !== active.field),
                          })
                        }
                      >
                        Remove {libraryFilterLabel(active)} ·{" "}
                        {removalCounts[active.field] === undefined
                          ? "Checking…"
                          : removalCounts[active.field] === null
                          ? "Count unavailable"
                          : `${removalCounts[active.field]?.toLocaleString()} ${removalCounts[active.field] === 1 ? "replay" : "replays"}`}
                      </LibraryButton>
                    ))}
                  </div>
                )}
                {page.total ? (
                  <LibraryButton className="lib-raised" onClick={() => onQueryChange({ ...query })}>
                    Refresh results
                  </LibraryButton>
                ) : query.search || query.filters?.length ? (
                  <LibraryButton
                    className="lib-raised"
                    onClick={() => onQueryChange({ ...query, search: "", filters: [], cursor: undefined })}
                  >
                    Clear search and filters
                  </LibraryButton>
                ) : scoped ? (
                  <LibraryButton className="lib-primary" onClick={() => changeScope({ kind: "all" })}>
                    Browse all replays
                  </LibraryButton>
                ) : (
                  <LibraryButton className="lib-primary" onClick={openSources}>
                    Open Sources
                  </LibraryButton>
                )}
              </div>
            )}
            <div className="lib-result-layout">
              <div
                ref={results}
                className="lib-results"
                role={view === "grid" ? "listbox" : undefined}
                aria-label={view === "grid" ? "Replays" : undefined}
                aria-busy={props.loading}
                style={{ position: "relative" }}
              >
                <div
                  ref={listScroll}
                  className={view === "list" ? "lib-list-scroll" : undefined}
                  onScroll={(event) => props.onScrollLeftChange?.(event.currentTarget.scrollLeft)}
                >
                  <div className={view === "list" ? "lib-list-content" : undefined}
                    role={view === "list" ? "table" : undefined}
                    aria-rowcount={view === "list" ? -1 : undefined}
                    aria-label={view === "list" ? "Replays" : undefined}>
                  {view === "list" && (page.items.length > 0 || pendingList) && (
                    <div className="lib-list-row lib-list-heading" role="row">
                      {LIBRARY_LIST_COLUMNS.map((column) => (
                        <div key={column.key} role="columnheader" data-align={column.align}
                          aria-label={column.label}
                          aria-sort={column.sort === activeSort ? (activeDirection === "asc" ? "ascending" : "descending") : undefined}>
                        {column.sort ? (
                          <LibraryButton
                            onClick={() => sortHeader(column.sort as LibrarySort)}
                            aria-label={column.label}
                          >
                            {column.sort === activeSort && <span className="lib-sort-arrow" aria-hidden="true" style={{ transform: activeDirection === "asc" ? "rotate(180deg)" : undefined }}><LibraryIcon name="down" /></span>}
                            {column.label}
                          </LibraryButton>
                        ) : column.key === "artwork" ? null : column.label}
                        </div>
                      ))}
                    </div>
                  )}
                  {pendingList && !page.items.length && (
                    <div role="row">
                      <div role="cell" aria-colspan={LIBRARY_LIST_COLUMNS.length} className="lib-note" style={{ padding: "16px 8px" }}>
                        Loading replays…
                      </div>
                    </div>
                  )}
                  <div style={{ height: firstTop }} aria-hidden="true" />
                  <div>
                    {visibleRows.map((row) =>
                      row.label ? (
                        <div role={view === "list" ? "row" : undefined} key={`band:${row.top}`}>
                        <div
                          role={view === "list" ? "cell" : undefined}
                          aria-colspan={view === "list" ? LIBRARY_LIST_COLUMNS.length : undefined}
                          className={`lib-band${ppHint?.key === row.bandKey ? " lib-band-with-hint" : ""}${flashBand === row.bandKey ? " lib-band-flash" : ""}`}
                          data-band-key={row.bandKey}
                          style={{ height: row.height, margin: 0 }}
                        >
                          <div className="lib-row">
                            <span className="lib-band-heading">{row.label}</span>
                            {props.bands?.find((band) => band.key === row.bandKey)?.count !== undefined && (
                              <span className="lib-mono lib-muted" style={{ fontWeight: 400, fontSize: 11 }}>
                                {props.bands.find((band) => band.key === row.bandKey)?.count.toLocaleString()}{" "}
                                {props.bands.find((band) => band.key === row.bandKey)?.count === 1 ? "play" : "plays"}
                              </span>
                            )}
                          </div>
                          {ppHint && ppHint.key === row.bandKey && (
                            <div className="lib-note">
                              <span>
                                PP is known for {ppHint.known.toLocaleString()} of {page.total.toLocaleString()}{" "}
                                {page.total === 1 ? "replay" : "replays"}{" "}
                                here; the rest are listed last.
                              </span>
                              <LibraryButton onClick={() => sort("date")}>Sort by date played</LibraryButton>
                            </div>
                          )}
                        </div>
                        </div>
                      ) : (
                        <div
                          key={`row:${row.top}`}
                          className={view === "grid" ? "lib-grid" : undefined}
                          style={{
                            height: row.height,
                            ...(view === "grid"
                              ? { gridTemplateColumns: `repeat(${columns},minmax(0,1fr))`, paddingBottom: 18 }
                              : {}),
                          }}
                        >
                          {row.items.map(renderItem)}
                        </div>
                      ),
                    )}
                  </div>
                  <div style={{ height: Math.max(0, totalHeight - lastBottom) }} aria-hidden="true" />
                  </div>
                </div>
                {page.next && (
                  <LibraryButton className="lib-raised" disabled={props.loadingMore} onClick={props.onLoadMore}>
                    {props.loadingMore ? "Loading more replays…" : "Load more replays"}
                  </LibraryButton>
                )}
              </div>
              {!!props.bands?.length && (
                <nav className="lib-rail" aria-label="Jump to replay band">
                  <span className="lib-rail-caption">{LIBRARY_SORTS[query.sort ?? "pp"].label}</span>
                  {props.bands.map((band) => (
                    <LibraryButton
                      key={band.key}
                      className="lib-rail-band"
                      aria-label={`Jump to ${band.label}, ${band.count} ${band.count === 1 ? "replay" : "replays"}`}
                      aria-current={currentBand === band.key ? "true" : undefined}
                      title={`Jump to ${band.label}, ${band.count} ${band.count === 1 ? "replay" : "replays"}`}
                      onClick={() => jumpBand(band.key)}
                    >
                      <span>{libraryBandRailLabel(band.label)}</span>
                    </LibraryButton>
                  ))}
                  {props.bandsNext && <LibraryButton onClick={props.onLoadMoreBands}>More bands</LibraryButton>}
                </nav>
              )}
              {/* Page and band reads settle independently. Keep the list's scrollport
                  width stable after the page arrives, until its rail can be shown. */}
              {view === "list" && (page.items.length > 0 || pendingList) && !props.bands?.length && (
                <div className="lib-rail" aria-hidden="true" style={{ visibility: "hidden" }} />
              )}
            </div>
          </div>
        </main>
        {selected && (
          <LibraryReplayDetails
            key={selected.item.id}
            selected={selected}
            collections={collections}
            resources={props.resources}
            sameMap={props.sameMap}
            memberships={props.memberships}
            onLoadMoreMemberships={props.onLoadMoreMemberships}
            onOpen={props.onOpen}
            openError={props.openError}
            onRevealFile={props.onRevealFile}
            onReview={props.onReview}
            onRetryAnalysis={props.onRetryAnalysis}
            onSelect={onSelect}
            onShowAllPlays={props.onShowAllPlays}
            onLoadMorePlays={props.onLoadMorePlays}
            onSave={(anchor) => setSave({ id: selected.item.id, anchor })}
            onClose={closePanel}
            onOpenSources={openSources}
            modal={modal}
          />
        )}
      </div>
      {filter && (
        <LibraryFilters {...props} anchor={filter.anchor} initialField={filter.field} onClose={() => setFilter(null)} />
      )}
      {queryAnchor && (
        <LibraryQueryEditor
          query={query}
          onQueryChange={onQueryChange}
          anchor={queryAnchor}
          onClose={() => setQueryAnchor(null)}
        />
      )}
      {save && saveItem && (
        <LibraryMemberships
          item={saveItem}
          collections={collections}
          memberships={props.memberships}
          collectionsNext={props.collectionsNext}
          onLoadMoreCollections={props.onLoadMoreCollections}
          onLoadMoreMemberships={props.onLoadMoreMemberships}
          anchor={save.anchor}
          onClose={() => setSave(null)}
          onFavourite={props.onFavourite}
          onMembership={props.onMembership}
          onCollectionCreate={props.onCollectionCreate}
        />
      )}
      {sourcesOpen && (
        <LibrarySources
          sources={props.sources}
          onSourceAction={props.onSourceAction}
          onAnalysisSettings={props.onAnalysisSettings}
          onLocateStable={props.onLocateStable}
          onClose={closeSources}
        />
      )}
    </Box>
  );
}
