import { stat } from "fs/promises";
import { join } from "path";
import { determineSongsFolder } from "@rewind/osu-local/utils";
import { osuFolderSanityCheck } from "../common/local/OsuFolderService";
import { checkOsuFolder, osuFolderReady } from "./osu-folder-checks";

jest.mock("fs/promises", () => ({ stat: jest.fn() }));
jest.mock("@rewind/osu-local/utils", () => ({ determineSongsFolder: jest.fn() }));
jest.mock("../common/local/OsuFolderService", () => ({ osuFolderSanityCheck: jest.fn() }));

const root = join("D:", "osu!");
const directory = { isDirectory: () => true };
const file = { isDirectory: () => false };

let existing: Record<string, { isDirectory: () => boolean }>;

beforeEach(() => {
  jest.clearAllMocks();
  existing = { [join(root, "Songs")]: directory, [join(root, "Replays")]: directory };
  (stat as jest.Mock).mockImplementation(async (path: string) => {
    const entry = existing[path];
    if (!entry) throw new Error(`ENOENT: ${path}`);
    return entry;
  });
  (determineSongsFolder as jest.Mock).mockImplementation(async (path: string) => join(path, "Songs"));
  (osuFolderSanityCheck as jest.Mock).mockResolvedValue(true);
});

describe("checkOsuFolder", () => {
  it("reports every check true for a complete osu! folder", async () => {
    const checks = await checkOsuFolder(root, "Player");
    expect(checks).toEqual({ songs: true, replays: true, core: true });
    expect(osuFolderReady(checks)).toBe(true);
    expect(determineSongsFolder).toHaveBeenCalledWith(root, "Player");
    expect(osuFolderSanityCheck).toHaveBeenCalledWith(root);
  });

  it("follows a Songs folder that the cfg helper redirects to another existing folder", async () => {
    const elsewhere = join("E:", "Maps");
    existing = { [elsewhere]: directory, [join(root, "Replays")]: directory };
    (determineSongsFolder as jest.Mock).mockResolvedValue(elsewhere);
    expect((await checkOsuFolder(root, "Player")).songs).toBe(true);
  });

  it("is false for a missing Songs folder", async () => {
    delete existing[join(root, "Songs")];
    expect(await checkOsuFolder(root, "Player")).toEqual({ songs: false, replays: true, core: true });
  });

  it("is false when Replays is a file rather than a directory", async () => {
    existing[join(root, "Replays")] = file;
    const checks = await checkOsuFolder(root, "Player");
    expect(checks.replays).toBe(false);
    expect(osuFolderReady(checks)).toBe(true);
  });

  it("is ready without a Replays folder", async () => {
    delete existing[join(root, "Replays")];
    const checks = await checkOsuFolder(root, "Player");
    expect(checks).toEqual({ songs: true, replays: false, core: true });
    expect(osuFolderReady(checks)).toBe(true);
  });

  it("is not ready without Songs", async () => {
    delete existing[join(root, "Songs")];
    expect(osuFolderReady(await checkOsuFolder(root, "Player"))).toBe(false);
    expect(osuFolderReady({ songs: false, replays: true, core: true })).toBe(false);
    expect(osuFolderReady({ songs: false, replays: false, core: true })).toBe(false);
  });

  it("is not ready without the core files", async () => {
    (osuFolderSanityCheck as jest.Mock).mockResolvedValue(false);
    expect(osuFolderReady(await checkOsuFolder(root, "Player"))).toBe(false);
    expect(osuFolderReady({ songs: true, replays: true, core: false })).toBe(false);
    expect(osuFolderReady({ songs: true, replays: false, core: false })).toBe(false);
  });

  it("is not ready when the core files are missing", async () => {
    (osuFolderSanityCheck as jest.Mock).mockResolvedValue(false);
    const checks = await checkOsuFolder(root, "Player");
    expect(checks).toEqual({ songs: true, replays: true, core: false });
    expect(osuFolderReady(checks)).toBe(false);
  });

  it("never throws when a stat or the cfg helper fails", async () => {
    existing = {};
    (determineSongsFolder as jest.Mock).mockRejectedValue(new Error("cfg unreadable"));
    await expect(checkOsuFolder(root, "Player")).resolves.toEqual({ songs: false, replays: false, core: true });
  });

  it("resolves all false for an empty path without touching the disk", async () => {
    expect(await checkOsuFolder("", "Player")).toEqual({ songs: false, replays: false, core: false });
    expect(await checkOsuFolder("   ", "Player")).toEqual({ songs: false, replays: false, core: false });
    expect(stat).not.toHaveBeenCalled();
    expect(osuFolderSanityCheck).not.toHaveBeenCalled();
    expect(determineSongsFolder).not.toHaveBeenCalled();
  });
});
