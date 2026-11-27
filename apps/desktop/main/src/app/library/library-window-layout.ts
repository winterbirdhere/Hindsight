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

type ViewerExpansion = { library: Rectangle; viewer: Rectangle };

/** Undo only the geometry the viewer imposed. Keep later manual moves and resizes. */
function libraryReturnBounds(current: Rectangle, { library, viewer }: ViewerExpansion): Rectangle {
  const sameWidth = current.width === viewer.width;
  const sameHeight = current.height === viewer.height;
  return {
    x: sameWidth && current.x === viewer.x ? library.x : current.x,
    y: sameHeight && current.y === viewer.y ? library.y : current.y,
    width: sameWidth ? library.width : current.width,
    height: sameHeight ? library.height : current.height,
  };
}

function sameBounds(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
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
  let expansion: ViewerExpansion | undefined;

  const apply = (url: string) => {
    if (disposed || window.isDestroyed()) return;
    const destination = documentAndRoute(url);
    const route = trustedDocument && destination?.document === trustedDocument ? destination.route : undefined;
    const nextLibrary = route === "#/app/library";
    const viewer = route === "#/app/analyzer";
    if (!nextLibrary && !viewer) expansion = undefined;
    if (nextLibrary === library) return;
    library = nextLibrary;

    // Capture geometry before changing the native minimum: Electron may resize it immediately.
    const bounds = window.getBounds();
    const area = workArea(bounds);
    const maximized = window.isMaximized();
    const normal = !maximized && !window.isMinimized() && !window.isFullScreen();
    const requested = library && normal && expansion ? libraryReturnBounds(bounds, expansion) : bounds;
    expansion = undefined;
    const restored = restoreWindowState({ bounds: requested, maximized }, [area], area, library ? 640 : undefined);
    window.setMinimumSize(restored.minWidth, restored.minHeight);
    if (!normal) return;
    if (library && !sameBounds(requested, bounds) && !sameBounds(restored.state.bounds, bounds)) {
      window.setBounds(restored.state.bounds);
    } else if (!library && (bounds.width < restored.minWidth || bounds.height < restored.minHeight)) {
      window.setBounds(restored.state.bounds);
      if (viewer) expansion = { library: bounds, viewer: window.getBounds() };
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
