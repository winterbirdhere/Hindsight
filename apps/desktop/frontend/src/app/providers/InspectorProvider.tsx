import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ClipRange } from "../services/manager/clip-range";

export type InspectorMode = "incidents" | "settings" | "export";
export type SettingsTab = "playback" | "display" | "skin" | "general";
/** Which settings the Display tab edits: the live viewer, or the exported clip. */
export type DisplayTarget = "viewer" | "clip";

export interface InspectorState {
  mode: InspectorMode;
  settingsTab: SettingsTab;
  displayTarget: DisplayTarget;
  locked: boolean;
  /** True in Export and in Settings opened from Export. The dock and the transport follow this, not `mode`. */
  exportSession: boolean;
  /** null means the whole replay. */
  exportRange: ClipRange | null;
  openSettings(options?: { tab?: SettingsTab; target?: DisplayTarget }): void;
  closeSettings(): void;
  toggleSettings(): void;
  setSettingsTab(tab: SettingsTab): void;
  setDisplayTarget(target: DisplayTarget): void;
  openExport(): void;
  /** Ends the export session from Export or from Settings opened from it. */
  closeExport(): void;
  /** Starts a session, or ends the one that is open. */
  toggleExport(): void;
  setExportRange(range: ClipRange | null): void;
  /** Back to incidents from any mode, forgetting the way back. */
  closeMode(): void;
}

/** Where Settings returns to when it was opened from Export, and the Display target to put back. */
interface WayBack {
  target: DisplayTarget;
}

const InspectorContext = createContext<InspectorState | null>(null);
const InspectorKeyboardContext = createContext(true);

/** The mounted viewer keeps its panel state while its keyboard ownership is suspended. */
export function InspectorKeyboardScope({ active, children }: { active: boolean; children: ReactNode }) {
  return <InspectorKeyboardContext.Provider value={active}>{children}</InspectorKeyboardContext.Provider>;
}

/**
 * Owns what the right-hand inspector shows: the incidents list, the settings panel or the export panel. The tab and
 * the Display target are remembered while settings are closed, and the export range survives closing Export and
 * opening Settings. Settings opened from Export remembers the way back (Export, and the Display target it found);
 * closing Settings returns there. While `locked` (the recorder is busy exporting a clip) every mode change and
 * range change is ignored.
 *
 * Esc steps back one level: Settings opened from Export returns to Export, everything else returns to incidents. A
 * control that uses Esc itself must stop its propagation (or prevent the default), so the listener on `window` leaves
 * the event alone.
 */
export function InspectorProvider({
  children,
  locked = false,
  initialMode = "incidents",
}: {
  children: ReactNode;
  locked?: boolean;
  initialMode?: InspectorMode;
}) {
  const keyboardActive = useContext(InspectorKeyboardContext);
  const [mode, setMode] = useState<InspectorMode>(initialMode);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("playback");
  const [displayTarget, setDisplayTarget] = useState<DisplayTarget>("viewer");
  const [wayBack, setWayBack] = useState<WayBack | null>(null);
  const [exportRange, setExportRangeState] = useState<ClipRange | null>(null);

  const exportSession = mode === "export" || (mode === "settings" && wayBack !== null);

  const openSettings = useCallback(
    (options?: { tab?: SettingsTab; target?: DisplayTarget }) => {
      if (locked) return;
      // Only Export remembers a way back; a Settings that is already open keeps the one it has.
      if (mode === "export") setWayBack({ target: displayTarget });
      if (options?.tab) setSettingsTab(options.tab);
      if (options?.target) setDisplayTarget(options.target);
      setMode("settings");
    },
    [locked, mode, displayTarget],
  );
  const closeSettings = useCallback(() => {
    if (locked || mode !== "settings") return;
    if (wayBack) {
      setDisplayTarget(wayBack.target);
      setWayBack(null);
      setMode("export");
    } else {
      setMode("incidents");
    }
  }, [locked, mode, wayBack]);
  const toggleSettings = useCallback(() => {
    if (locked) return;
    if (mode === "settings") closeSettings();
    else openSettings();
  }, [locked, mode, closeSettings, openSettings]);

  const openExport = useCallback(() => {
    if (locked) return;
    setWayBack(null);
    setMode("export");
  }, [locked]);
  const closeMode = useCallback(() => {
    if (locked) return;
    // Ending a session from Settings opened from Export puts the Display target back, as closeSettings does.
    if (wayBack) setDisplayTarget(wayBack.target);
    setWayBack(null);
    setMode("incidents");
  }, [locked, wayBack]);
  const closeExport = useCallback(() => {
    if (locked || !exportSession) return;
    if (wayBack) setDisplayTarget(wayBack.target);
    setWayBack(null);
    setMode("incidents");
  }, [locked, exportSession, wayBack]);
  const toggleExport = useCallback(() => {
    if (exportSession) closeExport();
    else openExport();
  }, [exportSession, closeExport, openExport]);
  const setExportRange = useCallback(
    (range: ClipRange | null) => {
      if (!locked) setExportRangeState(range);
    },
    [locked],
  );

  useEffect(() => {
    if (mode === "incidents" || locked || !keyboardActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (mode === "settings") closeSettings();
      else closeMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, locked, keyboardActive, closeSettings, closeMode]);

  const value = useMemo<InspectorState>(
    () => ({
      mode,
      settingsTab,
      displayTarget,
      locked,
      exportSession,
      exportRange,
      openSettings,
      closeSettings,
      toggleSettings,
      setSettingsTab,
      setDisplayTarget,
      openExport,
      closeExport,
      toggleExport,
      setExportRange,
      closeMode,
    }),
    [
      mode,
      settingsTab,
      displayTarget,
      locked,
      exportSession,
      exportRange,
      openSettings,
      closeSettings,
      toggleSettings,
      openExport,
      closeExport,
      toggleExport,
      setExportRange,
      closeMode,
    ],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorState {
  const value = useContext(InspectorContext);
  if (!value) throw new Error("useInspector must be used inside an InspectorProvider");
  return value;
}
