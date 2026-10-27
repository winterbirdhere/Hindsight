import { EventEmitter } from "events";
import { trackLibraryWindowLayout } from "./library-window-layout";

const documentUrl = "file:///D:/isolated/app/frontend/index.html";
const area = { x: 0, y: 0, width: 1920, height: 1040 };
class WindowFixture {
  url = `${documentUrl}#/app/analyzer`;
  bounds = { x: 100, y: 80, width: 1200, height: 800 };
  destroyed = false;
  maximized = false;
  minimized = false;
  fullscreen = false;
  webContents = Object.assign(new EventEmitter(), { getURL: () => this.url });
  getBounds = () => ({ ...this.bounds });
  setBounds = jest.fn((bounds) => { this.bounds = bounds; });
  setMinimumSize = jest.fn();
  isDestroyed = () => this.destroyed;
  isMaximized = () => this.maximized;
  isMinimized = () => this.minimized;
  isFullScreen = () => this.fullscreen;
}
function fixture(workArea = area) {
  const window = new WindowFixture();
  const dispose = trackLibraryWindowLayout(window as unknown as Parameters<typeof trackLibraryWindowLayout>[0], () => workArea, documentUrl);
  const route = (fragment: string, mainFrame = true, base = documentUrl) => {
    window.url = `${base}#${fragment}`;
    window.webContents.emit("did-navigate-in-page", {}, window.url, mainFrame);
  };
  return { window, route, dispose };
}
it("relaxes only the trusted main-frame Library route and restores the viewer minimum", () => {
  const f = fixture();
  f.route("/app/library", false);
  expect(f.window.setMinimumSize).not.toHaveBeenCalledWith(640, 600);
  f.route("/app/library", true, "https://unexpected.example/");
  expect(f.window.setMinimumSize).not.toHaveBeenCalledWith(640, 600);
  f.route("/app/library");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(640, 600);
  f.route("/app/analyzer");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(1024, 600);
  expect(f.window.setBounds).not.toHaveBeenCalled();
  f.dispose();
});
it("grows a narrow normal window back to viewer minimum while keeping it inside the current display", () => {
  const f = fixture();
  f.route("/app/library");
  f.window.bounds = { x: 1400, y: 80, width: 800, height: 700 };
  f.route("/app/analyzer");
  expect(f.window.bounds).toEqual({ x: 896, y: 80, width: 1024, height: 700 });
  f.dispose();
});
it("restores viewer constraints for a real reload and rechecks the actual loaded route", () => {
  const f = fixture();
  f.route("/app/library");
  f.window.webContents.emit("did-start-navigation", {}, f.window.url, false, false);
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(640, 600);
  f.window.webContents.emit("did-start-navigation", {}, f.window.url, false, true);
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(1024, 600);
  f.window.webContents.emit("did-finish-load");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(640, 600);
  f.dispose();
});
it.each(["maximized", "minimized", "fullscreen"] as const)("does not change %s window geometry", state => {
  const f = fixture();
  f.route("/app/library");
  f.window.bounds.width = 800;
  f.window[state] = true;
  f.route("/app/analyzer");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(1024, 600);
  expect(f.window.setBounds).not.toHaveBeenCalled();
  f.dispose();
});
it("keeps existing small-display constraints and never acts on a destroyed or disposed window", () => {
  const f = fixture({ x: 1920, y: 0, width: 800, height: 560 });
  f.route("/app/library");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(640, 560);
  f.route("/app/analyzer");
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(800, 560);
  f.window.destroyed = true;
  const count = f.window.setMinimumSize.mock.calls.length;
  f.route("/app/library");
  expect(f.window.setMinimumSize).toHaveBeenCalledTimes(count);
  f.dispose();
  expect(f.window.webContents.listenerCount("did-navigate-in-page")).toBe(0);
  expect(f.window.webContents.listenerCount("did-start-navigation")).toBe(0);
  expect(f.window.webContents.listenerCount("did-finish-load")).toBe(0);
  expect(f.window.webContents.listenerCount("destroyed")).toBe(0);
});
it("does not mistake another document or a similar route for Library", () => {
  const f = fixture();
  f.route("/app/library", true, `${documentUrl}?foreign=document`);
  f.route("/app/library", true, `${documentUrl}.other`);
  f.route("/app/library-other");
  expect(f.window.setMinimumSize).not.toHaveBeenCalled();
  f.route("/app/library");
  f.window.webContents.emit("did-start-navigation", {}, f.window.url, true, true);
  expect(f.window.setMinimumSize).toHaveBeenLastCalledWith(640, 600);
  f.window.webContents.emit("destroyed");
  f.window.destroyed = true;
  expect(f.window.webContents.listenerCount("did-navigate-in-page")).toBe(0);
  f.dispose();
});
it("accepts a directly loaded Library URL and canonical development origin", () => {
  const window = new WindowFixture();
  window.url = "http://localhost:4200/#/app/library";
  const dispose = trackLibraryWindowLayout(window as unknown as Parameters<typeof trackLibraryWindowLayout>[0], () => area, "http://localhost:4200");
  window.webContents.emit("did-finish-load");
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(640, 600);
  dispose();
  window.webContents.emit("did-finish-load");
  expect(window.setMinimumSize).toHaveBeenCalledTimes(1);
});
