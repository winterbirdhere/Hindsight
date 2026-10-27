import { Alert, Snackbar } from "@mui/material";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** The three-dots menu, which a capture waits for: it closes first, so it is not in the picture. */
export interface ScreenshotMenu {
  isOpen(): boolean;
  close(): void;
}

interface ScreenshotControl {
  /** A capture has been asked for and is not done yet. */
  capturing: boolean;
  registerMenu(menu: ScreenshotMenu | null): void;
  /** The menu's transition has started / finished. */
  menuEntered(): void;
  menuExited(): void;
}

const nothing = () => undefined;
const NO_SCREENSHOT: ScreenshotControl = { capturing: false, registerMenu: nothing, menuEntered: nothing, menuExited: nothing };
const ScreenshotContext = createContext<ScreenshotControl>(NO_SCREENSHOT);

/** What the screenshot shortcut is doing; outside a provider it does nothing. */
export const useScreenshot = () => useContext(ScreenshotContext);

/** Only the Keyboard shortcuts dialog is marked: it shows what F12 does and never runs it. */
const BLOCKED = "[data-screenshot-blocked]";

/**
 * F12 takes a screenshot of the visible window on every screen of the app, with any dialog open, except the Keyboard
 * shortcuts dialog. There is exactly one listener, here, above every screen; the three-dots menu only registers
 * itself so that a capture can wait for it to close. Nothing is taken while a clip is exporting, or while another
 * capture is under way; a held key and F12 with a modifier do nothing. A failed capture says so on whatever screen
 * it happened.
 */
export function ScreenshotProvider({
  takeScreenshot,
  isBusy,
  children,
}: {
  takeScreenshot: () => Promise<void>;
  /** True while a clip is exporting. */
  isBusy: () => boolean;
  children: ReactNode;
}) {
  const [capturing, setCapturing] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const queued = useRef(false);
  const menu = useRef<ScreenshotMenu | null>(null);
  const menuVisible = useRef(false);
  // The latest of the app's functions, so that the listener is added once.
  const take = useRef(takeScreenshot);
  const busy = useRef(isBusy);
  take.current = takeScreenshot;
  busy.current = isBusy;

  const capture = useCallback(async () => {
    queued.current = false;
    try {
      if (!busy.current()) await take.current();
    } catch {
      setFailed(true);
    } finally {
      running.current = false;
      setCapturing(false);
    }
  }, []);

  const request = useCallback(() => {
    if (running.current || busy.current()) return;
    running.current = true;
    setCapturing(true);
    setFailed(false);
    if (menu.current?.isOpen() || menuVisible.current) {
      // Capture only once the menu has finished its exit transition.
      queued.current = true;
      menu.current?.close();
    } else {
      void capture();
    }
  }, [capture]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // F12, as in osu!.
      if (event.key !== "F12" || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      if (event.repeat || document.querySelector(BLOCKED)) return;
      request();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request]);

  const registerMenu = useCallback((next: ScreenshotMenu | null) => {
    menu.current = next;
  }, []);
  const menuEntered = useCallback(() => {
    menuVisible.current = true;
  }, []);
  const menuExited = useCallback(() => {
    menuVisible.current = false;
    if (queued.current) void capture();
  }, [capture]);
  const control = useMemo<ScreenshotControl>(
    () => ({ capturing, registerMenu, menuEntered, menuExited }),
    [capturing, registerMenu, menuEntered, menuExited],
  );

  return (
    <ScreenshotContext.Provider value={control}>
      {children}
      <Snackbar
        open={failed}
        transitionDuration={capturing ? 0 : undefined}
        autoHideDuration={6500}
        onClose={() => setFailed(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" variant="filled" onClose={() => setFailed(false)}>
          Could not take a screenshot. Please try again.
        </Alert>
      </Snackbar>
    </ScreenshotContext.Provider>
  );
}
