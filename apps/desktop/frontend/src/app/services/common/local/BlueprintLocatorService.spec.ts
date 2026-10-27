import "reflect-metadata";
import { promises as fs } from "fs";
import { join } from "path";
import { BehaviorSubject } from "rxjs";
import { createHash } from "crypto";
import { parseBlueprint } from "@osujs/core";
import { BlueprintLocatorService } from "./BlueprintLocatorService";
import { OsuDBDao } from "./OsuDBDao";
import { OsuFolderService } from "./OsuFolderService";
import { BlueprintInfo } from "../../../model/BlueprintInfo";

let mockDirectoryEntries: Record<string, string[]> = {};
const mockDirectoryFailures = new Map<string, Error>();

jest.mock("fs", () => ({ promises: { stat: jest.fn(), readFile: jest.fn() } }));
jest.mock("@osujs/core", () => ({ parseBlueprint: jest.fn() }));
jest.mock("./OsuDBDao", () => ({ OsuDBDao: class OsuDBDao {} }));
jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));
jest.mock("@rewind/osu-local/utils", () => ({
  filterFilenamesInDirectory: async (directory: string, predicate: (filename: string) => Promise<boolean>) => {
    const failure = mockDirectoryFailures.get(directory);
    if (failure) throw failure;
    const filenames = mockDirectoryEntries[directory] ?? (directory.endsWith("Songs") ? ["imported"] : ["map.osu"]);
    const matches = await Promise.all(filenames.map(predicate));
    return filenames.filter((_, index) => matches[index]);
  },
}));

function fixture() {
  const databaseMaps = [
    { md5Hash: "database-map", folderName: "indexed", osuFileName: "database.osu" },
  ] as BlueprintInfo[];
  const dao = { cachedTime: 1000, getAllBlueprints: jest.fn().mockResolvedValue(databaseMaps) };
  const songsFolder$ = new BehaviorSubject(join("osu", "Songs"));
  const folders = {
    songsFolder$,
    getOsuFolder: () => "osu",
    whenReady: jest.fn(async () => songsFolder$.value),
  };
  return {
    databaseMaps,
    dao,
    folders,
    locator: new BlueprintLocatorService(dao as unknown as OsuDBDao, folders as unknown as OsuFolderService),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockDirectoryEntries = {};
  mockDirectoryFailures.clear();
  (fs.stat as jest.Mock).mockResolvedValue({ mtimeMs: 2000, mtime: new Date(2000), isDirectory: () => true });
  (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from("new beatmap"));
  (parseBlueprint as jest.Mock).mockReturnValue({ blueprintInfo: { metadata: { creator: "mapper" } } });
});

it("caches a completed filesystem scan without changing the DAO array", async () => {
  const { locator, databaseMaps } = fixture();
  const addedMd5 = createHash("md5").update("new beatmap").digest("hex");
  for (let i = 0; i < 3; i++) {
    const maps = await locator.getAllBlueprints();
    expect(Object.keys(maps)).toEqual(["database-map", addedMd5]);
  }
  expect(databaseMaps).toHaveLength(1);
  expect(fs.readFile).toHaveBeenCalledTimes(1);
  expect(parseBlueprint).toHaveBeenCalledTimes(1);
});

it("rescans after Songs changes without accumulating duplicate database entries", async () => {
  const { locator, databaseMaps } = fixture();
  await locator.getAllBlueprints();
  (fs.stat as jest.Mock).mockResolvedValue({ mtimeMs: 3000, mtime: new Date(3000), isDirectory: () => true });
  await locator.getAllBlueprints();
  await locator.getAllBlueprints();
  expect(fs.readFile).toHaveBeenCalledTimes(2);
  expect(databaseMaps).toHaveLength(1);
});

it("refreshes database changes even when the Songs directory timestamp is unchanged", async () => {
  const { locator, dao } = fixture();
  await locator.getAllBlueprints();
  dao.cachedTime = 3000;
  dao.getAllBlueprints.mockResolvedValue([
    { md5Hash: "replacement-map", folderName: "indexed", osuFileName: "replacement.osu" },
  ]);
  expect(Object.keys(await locator.getAllBlueprints())).toEqual(["replacement-map"]);
});

it("retries a failed filesystem scan after the database was already loaded", async () => {
  const { locator } = fixture();
  (fs.readFile as jest.Mock).mockRejectedValueOnce(new Error("temporary read failure"));
  await expect(locator.getAllBlueprints()).rejects.toThrow("temporary read failure");
  expect(Object.keys(await locator.getAllBlueprints())).toHaveLength(2);
  expect(fs.readFile).toHaveBeenCalledTimes(2);
});

it("shares concurrent scans and waits for the folder to be ready", async () => {
  const { locator, folders } = fixture();
  let resolve!: (folder: string) => void;
  folders.whenReady.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = locator.getAllBlueprints();
  const second = locator.getAllBlueprints();
  expect(first).toBe(second);
  expect(fs.readFile).not.toHaveBeenCalled();
  resolve(folders.songsFolder$.value);
  await Promise.all([first, second]);
  expect(fs.readFile).toHaveBeenCalledTimes(1);
});

it("reuses a successful checksum hit without rereading beatmap files", async () => {
  const { locator } = fixture();
  const md5 = createHash("md5").update("new beatmap").digest("hex");
  await locator.getBlueprintByMD5(md5);
  await locator.getBlueprintByMD5(md5);
  expect(fs.readFile).toHaveBeenCalledTimes(1);
});

it("shares concurrent checksum-miss refreshes", async () => {
  const { locator } = fixture();
  await locator.getAllBlueprints();
  (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from("edited beatmap"));
  const md5 = createHash("md5").update("edited beatmap").digest("hex");
  const results = await Promise.all([locator.getBlueprintByMD5(md5), locator.getBlueprintByMD5(md5)]);
  expect(results.map((result) => result?.md5Hash)).toEqual([md5, md5]);
  expect(fs.readFile).toHaveBeenCalledTimes(2);
});

it("does not repeat an in-flight refresh for a late caller whose checksum remains missing", async () => {
  const { locator } = fixture();
  let finishRead!: (value: Buffer) => void;
  let startedRead!: () => void;
  const reading = new Promise<void>((done) => {
    startedRead = done;
  });
  (fs.readFile as jest.Mock).mockImplementationOnce(() => {
    startedRead();
    return new Promise<Buffer>((done) => {
      finishRead = done;
    });
  });
  const first = locator.getBlueprintByMD5("missing", true);
  await reading;
  const late = locator.getBlueprintByMD5("missing");
  finishRead(Buffer.from("new beatmap"));

  expect(await Promise.all([first, late])).toEqual([undefined, undefined]);
  expect(fs.readFile).toHaveBeenCalledTimes(1);
});

it("continues a forced refresh when an unrelated listed osu file disappears", async () => {
  const { locator } = fixture();
  mockDirectoryEntries[join("osu", "Songs", "imported")] = ["removed.osu", "map.osu"];
  (fs.readFile as jest.Mock).mockImplementation(async (file: string) => {
    if (file.endsWith("removed.osu")) throw Object.assign(new Error("Gone"), { code: "ENOENT" });
    return Buffer.from("new beatmap");
  });
  const md5 = createHash("md5").update("new beatmap").digest("hex");
  expect(await locator.getBlueprintByMD5(md5, true)).toMatchObject({ osuFileName: "map.osu" });
});

it.each(["stat", "listing"])("continues a forced refresh when another mapset disappears during %s", async (stage) => {
  const { locator } = fixture();
  const missing = join("osu", "Songs", "removed");
  mockDirectoryEntries[join("osu", "Songs")] = ["removed", "imported"];
  const failure = Object.assign(new Error("Gone"), { code: "ENOENT" });
  if (stage === "listing") mockDirectoryFailures.set(missing, failure);
  else
    (fs.stat as jest.Mock).mockImplementation(async (file: string) => {
      if (file === missing) throw failure;
      return { mtimeMs: 2000, mtime: new Date(2000), isDirectory: () => true };
    });
  const md5 = createHash("md5").update("new beatmap").digest("hex");
  expect(await locator.getBlueprintByMD5(md5, true)).toMatchObject({ osuFileName: "map.osu" });
});

it.each(["ENOENT", "EACCES"])("keeps top-level Songs access failures visible (%s)", async (code) => {
  const { locator } = fixture();
  mockDirectoryFailures.set(join("osu", "Songs"), Object.assign(new Error("Songs unavailable"), { code }));
  await expect(locator.getBlueprintByMD5("missing", true)).rejects.toThrow("Songs unavailable");
});
