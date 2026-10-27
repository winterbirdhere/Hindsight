import "reflect-metadata";
import { readFile } from "fs/promises";
import { BehaviorSubject } from "rxjs";
import { fileLastModifiedTime } from "@rewind/osu-local/utils";
import { OsuDBDao } from "./OsuDBDao";
import { OsuFolderService } from "./OsuFolderService";

const mockReadDatabase = jest.fn();
jest.mock("fs/promises", () => ({ readFile: jest.fn() }));
jest.mock("@rewind/osu-local/utils", () => ({ fileLastModifiedTime: jest.fn(), ticksToDate: () => [new Date(0)] }));
jest.mock("@rewind/osu-local/db-reader", () => ({
  OsuDBReader: class {
    readOsuDB = mockReadDatabase;
  },
}));
jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));

function fixture() {
  const settings$ = new BehaviorSubject({ osuStablePath: "first" });
  const folders = { settings$, getOsuFolder: () => settings$.value.osuStablePath } as OsuFolderService;
  return { dao: new OsuDBDao(folders), settings$ };
}

beforeEach(() => {
  jest.resetAllMocks();
  (fileLastModifiedTime as jest.Mock).mockResolvedValue(1000);
  (readFile as jest.Mock).mockResolvedValue(Buffer.from("database"));
  mockReadDatabase.mockResolvedValue({ beatmaps: [{ md5Hash: "available" }] });
});

it.each(["read", "parse"])("retries a failed %s without caching an incomplete database", async (failure) => {
  const { dao } = fixture();
  if (failure === "read") (readFile as jest.Mock).mockRejectedValueOnce(new Error("EPERM"));
  else mockReadDatabase.mockRejectedValueOnce(new Error("truncated database"));
  await expect(dao.getAllBlueprints()).rejects.toThrow();
  expect(await dao.hasChanged()).toBe(true);
  expect(dao.cachedTime).toBe(-1);
  expect((await dao.getAllBlueprints()).map((map) => map.md5Hash)).toEqual(["available"]);
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(await dao.hasChanged()).toBe(false);
});

it("shares an in-flight read instead of returning an empty cache to concurrent callers", async () => {
  const { dao } = fixture();
  let resolve!: (database: unknown) => void;
  mockReadDatabase.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = dao.getAllBlueprints();
  const second = dao.getAllBlueprints();
  expect(second).toBe(first);
  await Promise.resolve();
  await Promise.resolve();
  resolve({ beatmaps: [{ md5Hash: "shared" }] });
  expect((await second)[0].md5Hash).toBe("shared");
  expect(readFile).toHaveBeenCalledTimes(1);
});

it("never publishes an old folder's in-flight database into the new folder cache", async () => {
  const { dao, settings$ } = fixture();
  let resolve!: (database: unknown) => void;
  mockReadDatabase.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = dao.getAllBlueprints();
  await Promise.resolve();
  await Promise.resolve();
  settings$.next({ osuStablePath: "second" });
  mockReadDatabase.mockResolvedValue({ beatmaps: [{ md5Hash: "second-map" }] });
  const current = await dao.getAllBlueprints();
  resolve({ beatmaps: [{ md5Hash: "first-map" }] });
  expect((await old)[0].md5Hash).toBe("second-map");
  expect(current[0].md5Hash).toBe("second-map");
  expect((await dao.getAllBlueprints())[0].md5Hash).toBe("second-map");
});
