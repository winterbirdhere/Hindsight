import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LibraryStore } from "./library-store";

it("persists mode and launch claims independently of utility restarts and user metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "library-settings-")), path = join(root, "library.sqlite");
  let store = new LibraryStore(path, "app-one");
  try {
    store.registerSource({ id: "one", kind: "replays", directory: "D:\\replays" });
    expect(store.updateMode()).toBe("auto"); store.setUpdateMode("launch");
    expect(store.claimLaunchScan("one")).toBe(true); expect(store.claimLaunchScan("one")).toBe(false);
    expect(() => store.setUpdateMode("other" as "auto")).toThrow(/mode/i);
    store.close(); store = new LibraryStore(path, "app-one");
    expect(store.updateMode()).toBe("launch"); expect(store.claimLaunchScan("one")).toBe(false);
    store.close(); store = new LibraryStore(path, "app-two"); expect(store.claimLaunchScan("one")).toBe(true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
