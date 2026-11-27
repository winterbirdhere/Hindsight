import { Box } from "@mui/material";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useObservable } from "rxjs-hooks";
import { useClipExportTransport } from "../../hooks/clip-export";
import { useShortcuts } from "../../hooks/shortcuts";
import { useReplayLoadState } from "../../hooks/replay-load-state";
import { GameCanvas } from "../../components/analyzer/GameCanvas";
import { ErrorOutlineBridge } from "../../components/analyzer/ErrorOutlineBridge";
import { environment } from "../../../environments/environment";
import { InspectorProvider, useInspector } from "../../providers/InspectorProvider";
import { useAnalysisApp } from "../../providers/TheaterProvider";
import { ErrorNavigationProvider } from "../../hooks/error-navigation";
import { Inspector } from "../../components/analyzer/Inspector";
import { InspectorBoundary } from "../../components/analyzer/InspectorBoundary";
import { InspectorDrawer, InspectorToggle } from "../../components/analyzer/InspectorDrawer";
import { InspectorSeparator } from "../../components/analyzer/InspectorSeparator";
import {
  clampInspectorWidth,
  inspectorWidthBounds,
  sanitizeInspectorLayout,
} from "../../services/analysis/inspector-layout-settings";
import { StatsOverlay } from "../../components/analyzer/StatsOverlay";
import { Dock } from "../../components/analyzer/Dock";
import { REWIND_COLORS, REWIND_LAYOUT } from "../../styles/tokens";
import { calculateAnalyzerLayout, maxColumnInspectorWidth } from "./analyzer-layout";

/** The inspector provider sits outside the shell: it is locked while a clip is exporting, as the dock is. */
export function Analyzer() {
  const analyzer = useAnalysisApp();
  const clipState = useObservable(() => analyzer.clipRecorder.state$, analyzer.clipRecorder.state$.value);
  const clipBusy = ["preparing", "recording", "rendering", "saving"].includes(clipState.status);
  return (
    <InspectorProvider locked={clipBusy}>
      <AnalyzerShell />
    </InspectorProvider>
  );
}

function AnalyzerShell() {
  const analyzer = useAnalysisApp();
  const loadState = useReplayLoadState();
  const { mode, locked, closeMode } = useInspector();
  // Settings and Export take the incidents' place; a hidden or folded inspector is shown while either is open, and
  // none of that is written to the saved layout.
  const modeOpen = mode !== "incidents";
  useShortcuts();
  // Mounted once: the dock's transport follows the export session, whichever way the inspector is shown.
  useClipExportTransport();
  useEffect(() => {
    void analyzer.initialize();
    if (environment.debugAnalyzer) void analyzer.loadReplay(environment.debugAnalyzer.replayPath);
  }, [analyzer]);

  const root = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const { inspectorLayoutSettingsStore: layoutStore } = analyzer;
  const saved = sanitizeInspectorLayout(useObservable(() => layoutStore.settings$, layoutStore.settings));
  // While the separator is dragged the width lives here; it is saved on release. A smaller window only clamps what is
  // shown (below), it never rewrites the saved preference.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const inspectorWanted = saved.visible || modeOpen;
  const layout = calculateAnalyzerLayout(size.width, size.height, dragWidth ?? saved.width, inspectorWanted);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const bounds = inspectorWidthBounds(size.width);
  // Stepping or dragging past this would fold the column into the drawer, so the range ends here.
  const separatorMax = Math.max(bounds.min, Math.min(bounds.max, maxColumnInspectorWidth(size.width, size.height)));
  const saveWidth = useCallback(
    (width: number) => {
      const next = clampInspectorWidth(width, size.width);
      layoutStore.changeSettings((draft) => {
        draft.width = next;
      });
      setDragWidth(null);
    },
    [layoutStore, size.width],
  );
  const toggleColumn = () =>
    layoutStore.changeSettings((draft) => {
      draft.visible = !saved.visible;
    });
  const columnShown = layout.inspector === "column" && inspectorWanted;
  /** The edge handle while Settings or Export are open closes them and hides the inspector; it does nothing while locked. */
  const closeModeAndHide = (hide: () => void) => {
    if (locked) return;
    closeMode();
    hide();
  };

  return (
    <ErrorNavigationProvider>
      <Box
        ref={root}
        sx={{
          display: "grid",
          height: "100%",
          gridTemplateColumns: columnShown ? `minmax(0, 1fr) ${layout.inspectorWidth}px` : "minmax(0, 1fr)",
          gridTemplateRows: `minmax(0, 1fr) ${REWIND_LAYOUT.dockHeight}px`,
          backgroundColor: REWIND_COLORS.bg,
        }}
      >
        <Box
          sx={{
            position: "relative",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            backgroundColor: REWIND_COLORS.stage,
          }}
        >
          <GameCanvas />
          {/* The stage reserves the overlay's strip; it is hidden only when the stage is too narrow for it (spec: 320 px beyond the 140 px reserve). */}
          {layout.statsOverlay && loadState.phase === "ready" && <StatsOverlay />}
          {/* While a clip is exporting the stage only dims: the clock and the canvas are the recorder's. z-index 3: above the stats overlay (1, 2) and the canvas vignette (1, 2), below the drawer (5) and the toggle (6). */}
          {locked && (
            <Box
              aria-hidden
              data-testid="export-dim"
              sx={{ position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none", backgroundColor: "rgba(11,11,13,.45)" }}
            />
          )}
          {layout.inspector === "drawer" ? (
            <InspectorDrawer
              open={drawerOpen || modeOpen}
              width={layout.inspectorWidth}
              onToggle={() => (modeOpen ? closeModeAndHide(() => setDrawerOpen(false)) : setDrawerOpen((open) => !open))}
            />
          ) : (
            <InspectorToggle
              open={inspectorWanted}
              onToggle={() =>
                modeOpen
                  ? closeModeAndHide(() => {
                      if (saved.visible) toggleColumn();
                    })
                  : toggleColumn()
              }
            />
          )}
        </Box>
        {/* Outside the condition, so that it also catches an error thrown while the column is being removed. */}
        <InspectorBoundary active={columnShown} frameSx={{ position: "relative", minWidth: 0, minHeight: 0 }}>
          {columnShown && (
            <Box sx={{ position: "relative", minWidth: 0, minHeight: 0 }}>
              <Inspector />
              <InspectorSeparator
                width={layout.inspectorWidth}
                min={bounds.min}
                max={separatorMax}
                onResize={setDragWidth}
                onCommit={saveWidth}
              />
            </Box>
          )}
        </InspectorBoundary>
        <Box sx={{ gridColumn: "1 / -1", minWidth: 0 }}>
          <Dock />
        </Box>
      </Box>
      {/* Renders nothing: it hands the selection to the playfield and the key overlay. */}
      <ErrorOutlineBridge />
    </ErrorNavigationProvider>
  );
}
