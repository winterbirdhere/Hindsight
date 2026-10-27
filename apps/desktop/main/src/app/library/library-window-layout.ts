import type { BrowserWindow, Rectangle } from "electron";
import { restoreWindowState } from "../window-state";

type LayoutWindow = Pick<
  BrowserWindow,
  "webContents" | "getBounds" | "setBounds" | "setMinimumSize" | "isDestroyed" | "isMaximized" | "isMinimized" | "isFullScreen"
>;

function documentAndRoute(url: string): { document: string; route: string } | undefined {
  try {
    const parsed = new URL(url);
    const route = parsed.hash;
    parsed.hash = "";
    return { document: parsed.href, route };
  } catch {
    return undefined;
  }
}

/** The Library alone supports narrow windows; viewer startup and bounds remain unchanged. */
export function trackLibraryWindowLayout(
  window: LayoutWindow,
  workArea: (bounds: Rectangle) => Rectangle,
  expectedDocument: string,
): () => void {
  const trustedDocument = documentAndRoute(expectedDocument)?.document;
  let library = false;
  let disposed = false;

  const apply = (url: string) => {
    if (disposed || window.isDestroyed()) return;
    const destination = documentAndRoute(url);
    const nextLibrary = !!trustedDocument && destination?.document === trustedDocument && destination.route === "#/app/library";
    if (nextLibrary === library) return;
    library = nextLibrary;

    // Capture geometry before changing the native minimum: Electron may resize it immediately.
    const bounds = window.getBounds();
    const area = workArea(bounds);
    const restored = restoreWindowState({ bounds, maximized: window.isMaximized() }, [area], area);
    window.setMinimumSize(library ? Math.min(640, restored.minWidth) : restored.minWidth, restored.minHeight);
    if (
      !library && !window.isMaximized() && !window.isMinimized() && !window.isFullScreen() &&
      (bounds.width < restored.minWidth || bounds.height < restored.minHeight)
    ) {
      window.setBounds(restored.state.bounds);
    }
  };
  const inPage = (_event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame) apply(url);
  };
  const navigating = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) apply("");
  };
  const loaded = () => {
    if (!disposed && !window.isDestroyed()) apply(window.webContents.getURL());
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.webContents.removeListener("did-navigate-in-page", inPage);
    window.webContents.removeListener("did-start-navigation", navigating);
    window.webContents.removeListener("did-finish-load", loaded);
    window.webContents.removeListener("destroyed", dispose);
  };
  window.webContents.on("did-navigate-in-page", inPage);
  window.webContents.on("did-start-navigation", navigating);
  window.webContents.on("did-finish-load", loaded);
  window.webContents.on("destroyed", dispose);
  return dispose;
}
