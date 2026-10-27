import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useObservable } from "rxjs-hooks";
import { Box, Button, IconButton } from "@mui/material";
import { ChevronLeft, ChevronRight, VideoLibraryOutlined } from "@mui/icons-material";
import { ReplayLibraryView } from "./replay-library/ReplayLibraryView";
import { LibraryUiCoordinator } from "../services/library/library-ui-coordinator";
import { DockButtonLabel, dockIconButton, dockTextButton } from "./analyzer/DockIconButtons";
import { preventPointerFocus } from "../utils/focus";
import { REWIND_COLORS, REWIND_FONTS } from "../styles/tokens";
import { InspectorKeyboardScope } from "../providers/InspectorProvider";
import type { ReplayLibraryViewProps } from "./replay-library/library-view-types";
import { useOpenReplayAction } from "../hooks/open-replay";

const LibraryHostContext = createContext<LibraryUiCoordinator | null>(null);
export const useLibraryUi = () => useContext(LibraryHostContext);

function viewerNavigationOwnsKey(event: KeyboardEvent): boolean {
  const focus = event.target instanceof Element ? event.target : document.activeElement;
  if (
    focus?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="dialog"], [role="menu"], [role="listbox"], .MuiModal-root',
    )
  )
    return false;
  // Portaled dialogs are outside the retained viewer wrapper. They keep keyboard ownership,
  // including their opening transition before focus has reached a dialog control.
  return !Array.from(document.querySelectorAll('[aria-modal="true"], dialog[open], .MuiModal-root')).some((modal) => {
    if (modal.closest('[hidden], [inert], [aria-hidden="true"], .MuiModal-hidden')) return false;
    const style = window.getComputedStyle(modal);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Lives above both screens; StrictMode cleanup does not destroy the remounted session owner. */
export function LibraryHostProvider({
  coordinator,
  viewerActive,
  children,
}: {
  coordinator: LibraryUiCoordinator;
  viewerActive: boolean;
  children: ReactNode;
}) {
  const lifetime = useRef({ owner: coordinator, sequence: 0 });
  useEffect(() => {
    const sequence = lifetime.current.sequence + 1;
    lifetime.current = { owner: coordinator, sequence };
    coordinator.connect();
    const resize = () => coordinator.view.setWidth(window.innerWidth);
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      queueMicrotask(() => {
        if (lifetime.current.owner !== coordinator || lifetime.current.sequence === sequence) coordinator.dispose();
      });
    };
  }, [coordinator]);
  useEffect(() => {
    if (!viewerActive) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.defaultPrevented &&
        event.key.toLowerCase() === "l" &&
        viewerNavigationOwnsKey(event)
      ) {
        event.preventDefault();
        void coordinator.enterLibrary();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [coordinator, viewerActive]);
  return <LibraryHostContext.Provider value={coordinator}>{children}</LibraryHostContext.Provider>;
}

export function ReplayLibraryHost() {
  const coordinator = useLibraryUi();
  if (!coordinator) throw new Error("Library host is unavailable");
  return <ConnectedReplayLibrary coordinator={coordinator} />;
}
/** Visibility changes retain the viewer component and its WebGL resources. */
export function LibraryScreenSwitch({ libraryActive, children }: { libraryActive: boolean; children: ReactNode }) {
  return (
    <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
      <div
        aria-hidden={libraryActive || undefined}
        inert={libraryActive || undefined}
        style={{
          position: "absolute",
          inset: 0,
          visibility: libraryActive ? "hidden" : "visible",
          pointerEvents: libraryActive ? "none" : undefined,
        }}
      >
        <InspectorKeyboardScope active={!libraryActive}>{children}</InspectorKeyboardScope>
      </div>
      {libraryActive && (
        <Box sx={{ position: "absolute", inset: 0 }}>
          <ReplayLibraryHost />
        </Box>
      )}
    </Box>
  );
}
// LibraryHost unmounts during viewer navigation. This weak receipt belongs to
// the coordinator session, so a pending changed query is never a new library.
const coordinatorsWithLibraryPage = new WeakSet<LibraryUiCoordinator>();
function ConnectedReplayLibrary({ coordinator }: { coordinator: LibraryUiCoordinator }) {
  const openReplayFile = useOpenReplayAction();
  const state = useObservable(() => coordinator.view.state$, coordinator.view.snapshot());
  if (state.page !== null) coordinatorsWithLibraryPage.add(coordinator);
  const subscribe = useCallback(
    (notify: () => void) => {
      const subscription = coordinator.state$.subscribe(notify);
      return () => subscription.unsubscribe();
    },
    [coordinator],
  );
  const getSnapshot = useCallback(() => coordinator.snapshot(), [coordinator]);
  const auxiliary = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // The publication owns pending renders; this lease owns the exact snapshot
  // used by committed DOM until React replaces or removes that view.
  useLayoutEffect(() => coordinator.retainRenderedResources(auxiliary.resources), [coordinator, auxiliary.resources]);
  const nowPlaying = auxiliary.nowPlaying;
  const pageRevision = state.page?.revision;
  const bandsCurrent = auxiliary.bands.revision === pageRevision;
  const collectionsCurrent = auxiliary.collections.revision === pageRevision;
  const countsCurrent = auxiliary.countsRevision === pageRevision;
  const queryKey = JSON.stringify(state.query);
  type ResultView = Pick<
    ReplayLibraryViewProps,
    "page" | "pageStart" | "bands" | "bandsNext" | "collections" | "collectionsNext" | "scopeCounts" | "sourceCounts"
  >;
  const complete = useRef<{ owner: LibraryUiCoordinator; queryKey: string; data: ResultView } | null>(null);
  const previous =
    complete.current?.owner === coordinator && complete.current.queryKey === queryKey
      ? complete.current.data
      : undefined;
  const coherent = !!state.page && !state.loading && bandsCurrent && collectionsCurrent && countsCurrent;
  const terminalPageFailure = state.page === null && !state.loading && state.error !== null;
  const current: ResultView = {
    page: state.page ?? { items: [], total: 0, analysisExcluded: 0 },
    pageStart: state.pageStart,
    bands: bandsCurrent ? auxiliary.bands.items : [],
    bandsNext: bandsCurrent ? auxiliary.bands.next : undefined,
    collections: collectionsCurrent ? auxiliary.collections.items : [],
    collectionsNext: collectionsCurrent ? auxiliary.collections.next : undefined,
    scopeCounts: countsCurrent ? auxiliary.scopeCounts : {},
    sourceCounts: countsCurrent ? auxiliary.sourceCounts : undefined,
  };
  // Independent indexed reads can finish on different revisions. Hold a committed,
  // coherent same-query view until its replacement is complete, without delaying
  // the first page or reusing another query's results. No read is cancelled here.
  const results = coherent ? current : previous ?? current;
  useLayoutEffect(() => {
    if (coherent) complete.current = { owner: coordinator, queryKey, data: current };
    else if (complete.current?.owner !== coordinator || complete.current.queryKey !== queryKey) complete.current = null;
  });
  return (
    <ReplayLibraryView
      {...results}
      query={state.query}
      selected={state.selected}
      memberships={auxiliary.memberships}
      view={state.view}
      sidebarShown={state.sidebarShown}
      scrollTop={state.scrollTop}
      scrollLeft={state.scrollLeft}
      revealRequest={state.revealRequest ?? undefined}
      focusRequest={state.focusRequest ?? undefined}
      loading={state.loading || (state.page === null && !terminalPageFailure)}
      initialLoading={!coordinatorsWithLibraryPage.has(coordinator) && state.page === null && !terminalPageFailure}
      loadingMore={state.loadingMore}
      updating={!terminalPageFailure && (state.updating || auxiliary.updating || (!!previous && !coherent))}
      error={state.error ?? auxiliary.error}
      openError={auxiliary.openError}
      announcement={state.announcement ?? undefined}
      sources={auxiliary.sources}
      myNames={auxiliary.myNames}
      onSaveMyNames={(names) => coordinator.saveMyNames(names)}
      resources={auxiliary.resources}
      sameMap={auxiliary.sameMap}
      nowPlaying={nowPlaying}
      onQueryChange={(query) => void coordinator.commitQuery(query)}
      onSelect={(id) => void coordinator.select(id)}
      onOpen={(id, options) => void coordinator.open(id, options)}
      onOpenReplayFile={openReplayFile.open}
      onRetryAnalysis={(id) => void coordinator.retryAnalysis(id)}
      onReturnToViewer={() => coordinator.returnToViewer()}
      onRevealFile={(id) => void coordinator.revealFile(id)}
      onViewChange={(view) => coordinator.view.setView(view)}
      onSidebarChange={(shown) => coordinator.view.setSidebarShown(shown)}
      onScrollTopChange={(top) => coordinator.view.saveScroll(top)}
      onScrollLeftChange={(left) => coordinator.view.saveScroll(state.scrollTop, left)}
      onLoadMore={() => void coordinator.view.loadMore()}
      onJumpBand={(key) => void coordinator.jumpBand(key)}
      onVisibleReplays={(ids) => coordinator.visibleReplays(ids)}
      onLoadMoreCollections={() => void coordinator.loadMoreCollections()}
      onLoadMoreBands={() => void coordinator.loadMoreBands()}
      onMembershipTarget={(id) => void coordinator.membershipTarget(id)}
      onLoadMoreMemberships={() => void coordinator.loadMoreMemberships()}
      onLoadMorePlays={() => void coordinator.loadMorePlays()}
      onPreview={(query, draft) => coordinator.query.preview(query, draft)}
      onFacets={(field, search, cursor) => coordinator.facets(field, search, cursor)}
      onReview={(replayId, review) => void coordinator.mutate({ method: "replay-review", replayId, review })}
      onFavourite={(replayId, favourite) =>
        void coordinator.mutate({ method: "replay-favourite", replayId, favourite })
      }
      onMembership={(replayId, collectionId, included) =>
        void coordinator.mutate({ method: "collection-membership", replayId, collectionId, included })
      }
      onCollectionCreate={(name, parentId, replayId) =>
        void coordinator.mutate({ method: "collection-create", name, parentId, replayId })
      }
      onCollectionRename={(collectionId, name) =>
        void coordinator.mutate({ method: "collection-rename", collectionId, name })
      }
      onCollectionDelete={(collectionId) => void coordinator.mutate({ method: "collection-delete", collectionId })}
      onSourceAction={(input) => coordinator.sourceAction(input)}
      onLocateStable={() => void coordinator.locateStable()}
      onAnalysisSettings={(settings) => void coordinator.analysisSettings(settings)}
    />
  );
}

/** Inserted immediately after the existing dock Analysis action. */
export function LibraryViewerNavigation() {
  const coordinator = useLibraryUi();
  if (!coordinator) return null;
  return (
    <Button
      size="small"
      aria-label="Library"
      title="Library · Ctrl+L"
      startIcon={<VideoLibraryOutlined />}
      onClick={() => void coordinator.enterLibrary()}
      onMouseDown={preventPointerFocus}
      sx={dockTextButton}
    >
      <DockButtonLabel>Library</DockButtonLabel>
    </Button>
  );
}
export function LibraryViewerStepper() {
  const coordinator = useLibraryUi();
  return coordinator ? <ConnectedStepper coordinator={coordinator} /> : null;
}
function ConnectedStepper({ coordinator }: { coordinator: LibraryUiCoordinator }) {
  const state = useObservable(() => coordinator.view.state$, coordinator.view.snapshot()),
    navigation = state.navigation;
  if (!navigation) return null;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: "2px",
        mt: "8px",
        mr: "-8px",
        fontFamily: REWIND_FONTS.mono,
        fontSize: 11,
        color: REWIND_COLORS.textSecondary,
      }}
    >
      <Box
        component="span"
        title={navigation.scopeLabel}
        sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {navigation.sortLabel}
      </Box>
      <IconButton
        aria-label="Previous replay in library order"
        disabled={navigation.position === 0}
        onClick={() => void coordinator.step(-1)}
        sx={dockIconButton}
      >
        <ChevronLeft fontSize="small" />
      </IconButton>
      <span>
        {navigation.position + 1} / {navigation.total}
      </span>
      <IconButton
        aria-label="Next replay in library order"
        disabled={navigation.position === navigation.total - 1}
        onClick={() => void coordinator.step(1)}
        sx={dockIconButton}
      >
        <ChevronRight fontSize="small" />
      </IconButton>
    </Box>
  );
}
