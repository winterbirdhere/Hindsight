import "reflect-metadata";
import { join } from "path";
import username from "username";
import { determineSongsFolder } from "@rewind/osu-local/utils";
import { OsuFolderService } from "./OsuFolderService";

jest.mock("username", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@rewind/osu-local/utils", () => ({ determineSongsFolder: jest.fn() }));
jest.mock("electron", () => ({ ipcRenderer: { send: jest.fn() } }));

beforeEach(() => {
  jest.restoreAllMocks();
  jest.resetAllMocks();
  localStorage.clear();
  (username as unknown as jest.Mock).mockResolvedValue("User");
});

afterEach(() => jest.restoreAllMocks());

it("saves the selected installation before directory observers can restart the app", () => {
  const folders = new OsuFolderService();
  const persistedAtPublication: (string | null)[] = [];
  const subscription = folders.settings$.subscribe((settings) => {
    if (settings.osuStablePath === "next-installation") {
      persistedAtPublication.push(localStorage.getItem("osu-settings"));
    }
  });

  folders.setOsuFolder("next-installation");

  expect(persistedAtPublication).toEqual(['{"osuStablePath":"next-installation"}']);
  expect(localStorage.getItem("osu-settings")).toBe('{"osuStablePath":"next-installation"}');
  subscription.unsubscribe();
});

it("changes only the stored osu directory and keeps other saved preferences", () => {
  localStorage.setItem("osu-settings", '{"osuStablePath":"old-installation"}');
  localStorage.setItem("skin-settings", '{"preferredSkinId":"osu:Seoul"}');
  localStorage.setItem("audio-settings", '{"volume":0.4}');
  const folders = new OsuFolderService();

  folders.setOsuFolder("next-installation");

  expect(localStorage.getItem("osu-settings")).toBe('{"osuStablePath":"next-installation"}');
  expect(localStorage.getItem("skin-settings")).toBe('{"preferredSkinId":"osu:Seoul"}');
  expect(localStorage.getItem("audio-settings")).toBe('{"volume":0.4}');
});

it("keeps the active directory and its resolved folders unchanged when saving fails", async () => {
  (determineSongsFolder as jest.Mock).mockResolvedValue("old-songs");
  const folders = new OsuFolderService();
  folders.setOsuFolder("old-installation");
  await folders.whenReady();
  const publications: string[] = [];
  const subscription = folders.settings$.subscribe((settings) => publications.push(settings.osuStablePath));
  const storageError = new Error("Storage is full");
  jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw storageError;
  });

  expect(() => folders.setOsuFolder("next-installation")).toThrow(storageError);

  expect(publications).toEqual(["old-installation"]);
  expect(folders.getOsuFolder()).toBe("old-installation");
  expect(folders.replaysFolder$.value).toBe(join("old-installation", "Replays"));
  expect(folders.songsFolder$.value).toBe("old-songs");
  expect(localStorage.getItem("osu-settings")).toBe('{"osuStablePath":"old-installation"}');
  subscription.unsubscribe();
});

it("does not resolve an empty default installation before stored settings load", async () => {
  const folders = new OsuFolderService();
  expect(await folders.whenReady()).toBe("");
  expect(folders.replaysFolder$.value).toBe("");
  expect(username).not.toHaveBeenCalled();
  expect(determineSongsFolder).not.toHaveBeenCalled();
});

it("ignores obsolete completion and makes existing readiness callers follow the current folder", async () => {
  const pending = new Map<string, (folder: string) => void>();
  const complete = (folder: string, songsFolder: string) => {
    const resolve = pending.get(folder);
    if (!resolve) throw new Error(`No pending lookup for ${folder}`);
    resolve(songsFolder);
  };
  (determineSongsFolder as jest.Mock).mockImplementation(
    (folder: string) => new Promise((resolve) => pending.set(folder, resolve)),
  );
  const folders = new OsuFolderService();
  folders.setOsuFolder("first");
  const waiting = folders.whenReady();
  await Promise.resolve();
  folders.setOsuFolder("second");
  await Promise.resolve();
  complete("second", "second-songs");
  expect(await folders.whenReady()).toBe("second-songs");
  complete("first", "first-songs");
  expect(await waiting).toBe("second-songs");
  expect(folders.songsFolder$.value).toBe("second-songs");
  expect(folders.getOsuFolder()).toBe("second");
});

it("clears obsolete Songs paths while a replacement is resolving", async () => {
  (determineSongsFolder as jest.Mock).mockResolvedValueOnce("first-songs");
  const folders = new OsuFolderService();
  folders.setOsuFolder("first");
  await folders.whenReady();
  folders.setOsuFolder("second");
  expect(folders.songsFolder$.value).toBe("");
  await folders.whenReady();
});

it("uses the default Songs folder if OS username lookup fails", async () => {
  (username as unknown as jest.Mock).mockRejectedValue(new Error("username unavailable"));
  const folders = new OsuFolderService();
  folders.setOsuFolder("osu-current");
  expect(await folders.whenReady()).toBe(join("osu-current", "Songs"));
});
