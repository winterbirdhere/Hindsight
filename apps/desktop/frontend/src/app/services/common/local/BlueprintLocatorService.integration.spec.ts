/** @jest-environment node */
import "reflect-metadata";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { BehaviorSubject } from "rxjs";
import { BlueprintLocatorService } from "./BlueprintLocatorService";
import { BlueprintInfo } from "../../../model/BlueprintInfo";

jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));
jest.mock("./OsuDBDao", () => ({ OsuDBDao: class OsuDBDao {} }));

const original =
  "osu file format v14\n[General]\nAudioFilename: audio.mp3\n[Metadata]\nTitle: Original\nArtist: Test\nCreator: Mapper\nVersion: Easy\n";
const checksum = (data: string) => createHash("md5").update(data).digest("hex");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rewind-map-index-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(database = false) {
  const songs = join(directory, "Songs");
  const mapset = join(songs, "existing");
  await mkdir(mapset, { recursive: true });
  await writeFile(join(mapset, "map.osu"), original);
  const maps = database
    ? [{ md5Hash: checksum(original), folderName: "existing", osuFileName: "map.osu" } as BlueprintInfo]
    : [];
  const dao = { cachedTime: Date.now() - 10000, getAllBlueprints: jest.fn(async () => maps) };
  const folders = {
    songsFolder$: new BehaviorSubject(songs),
    getOsuFolder: () => directory,
    whenReady: async () => songs,
  };
  return { songs, mapset, maps, locator: new BlueprintLocatorService(dao as never, folders as never) };
}

it("finds a difficulty added in an existing mapset despite an unchanged Songs timestamp", async () => {
  const { locator, songs, mapset } = await fixture();
  const parentTime = new Date(10000);
  await utimes(songs, parentTime, parentTime);
  await locator.getAllBlueprints();
  const added = original.replace("Version: Easy", "Version: Hard");
  await writeFile(join(mapset, "new.osu"), added);
  await utimes(songs, parentTime, parentTime);
  expect(await locator.getBlueprintByMD5(checksum(added))).toMatchObject({ osuFileName: "new.osu" });
});

it("finds in-place edits even when both directory timestamps predate the database", async () => {
  const { locator, songs, mapset } = await fixture(true);
  const old = new Date(Date.now() - 20000);
  await utimes(mapset, old, old);
  await utimes(songs, old, old);
  await locator.getAllBlueprints();
  const changed = original.replace("Title: Original", "Title: Edited");
  await writeFile(join(mapset, "map.osu"), changed);
  await utimes(mapset, old, old);
  await utimes(songs, old, old);
  expect(await locator.getBlueprintByMD5(checksum(changed))).toMatchObject({ title: "Edited" });
  expect((await locator.getAllBlueprints())[checksum(original)]).toBeUndefined();
});

it("removes stale database identities when their path has been rescanned", async () => {
  const { locator, mapset, maps } = await fixture(true);
  const changed = original.replace("Title: Original", "Title: Changed");
  await writeFile(join(mapset, "map.osu"), changed);
  const index = await locator.getAllBlueprints();
  expect(index[checksum(original)]).toBeUndefined();
  expect(index[checksum(changed)]).toMatchObject({ title: "Changed" });
  expect(maps[0].md5Hash).toBe(checksum(original));
});

it("ignores an unrelated empty osu file during a forced metadata refresh", async () => {
  const { locator, mapset } = await fixture();
  await writeFile(join(mapset, "000-empty.osu"), "");
  expect(await locator.getBlueprintByMD5(checksum(original), true)).toMatchObject({ osuFileName: "map.osu" });
});
