import { promises as fsPromises } from "fs";
import { Blueprint, BlueprintSection, parseBlueprint } from "@osujs/core";
import { join } from "path";
import { createHash } from "crypto";
import { filterFilenamesInDirectory } from "@rewind/osu-local/utils";
import { injectable } from "inversify";
import { OsuFolderService } from "./OsuFolderService";
import { BlueprintInfo } from "../../../model/BlueprintInfo";
import { OsuDBDao } from "./OsuDBDao";

const { stat, readFile } = fsPromises;

const METADATA_SECTIONS_TO_READ: BlueprintSection[] = ["General", "Difficulty", "Events", "Metadata"];

function mapToLocalBlueprint(
  blueprint: Blueprint,
  osuFileName: string,
  folderName: string,
  md5Hash: string,
): BlueprintInfo {
  const { metadata } = blueprint.blueprintInfo;
  return {
    creator: "",
    title: metadata.title,
    osuFileName,
    folderName,
    bgFileName: metadata.backgroundFile,
    md5Hash,
    audioFileName: metadata.audioFile,
    artist: metadata.artist,
    lastPlayed: new Date(),
  };
}

// Basically just the identifier of the blueprint
type BlueprintMD5 = string;

/**
 * Service responsible for locating the blueprints.
 *
 * It mainly uses the `osu!.db` to get the majority of the blueprints. However, once the user imports new beatmaps,
 * the `osu!.db` doesn't get immediately updated (no flushing), thus we have to find out which ones were added by
 * manually looking for new files.
 */
@injectable()
export class BlueprintLocatorService {
  private blueprints: Record<BlueprintMD5, BlueprintInfo> = {};
  private lastRead?: { osuFolder: string; songsFolder: string; dbTime: number; songsTime: number };
  private readInFlight?: Promise<Record<BlueprintMD5, BlueprintInfo>>;
  private refreshInFlight?: Promise<Record<BlueprintMD5, BlueprintInfo>>;

  constructor(private readonly osuDbDao: OsuDBDao, private readonly osuFolderService: OsuFolderService) {}

  private get songsFolder() {
    return this.osuFolderService.songsFolder$.getValue();
  }

  private async completeRead(refresh = false): Promise<Record<BlueprintMD5, BlueprintInfo>> {
    for (;;) {
      const songsFolder = await this.osuFolderService.whenReady();
      const osuFolder = this.osuFolderService.getOsuFolder();
      const isCurrentFolder = () =>
        songsFolder === this.songsFolder && osuFolder === this.osuFolderService.getOsuFolder();
      try {
        const databaseBlueprints = await this.osuDbDao.getAllBlueprints();
        const dbTime = this.osuDbDao.cachedTime;
        const songsTime = (await stat(songsFolder)).mtimeMs;
        if (!isCurrentFolder()) continue;
        const previous = this.lastRead;
        if (
          !refresh &&
          previous?.osuFolder === osuFolder &&
          previous.songsFolder === songsFolder &&
          previous.dbTime === dbTime &&
          previous.songsTime === songsTime
        )
          return this.blueprints;

        // Never append filesystem discoveries into the DAO's cached snapshot.
        console.log(`Reading the osu!/Songs folder: ${songsFolder}`);
        // A miss may be an in-place edit: neither ancestor directory timestamp
        // necessarily changes, so this explicit retry inspects all mapsets.
        const candidates = await getNewFolderCandidates(songsFolder, new Date(refresh ? -8640000000000000 : dbTime));
        const folderKey = (folder: string) => (process.platform === "win32" ? folder.toLowerCase() : folder);
        const rescanned = new Set(candidates.map(folderKey));
        const freshBlueprints = refresh
          ? []
          : databaseBlueprints.filter((map) => !rescanned.has(folderKey(map.folderName)));
        for (const songFolder of candidates) {
          let osuFiles: string[];
          try {
            osuFiles = await listOsuFiles(join(songsFolder, songFolder));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          for (const osuFile of osuFiles) {
            const fileName = join(songsFolder, songFolder, osuFile);
            let data: Buffer;
            try {
              data = await readFile(fileName);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
              throw error;
            }
            const md5Hash = createHash("md5").update(data).digest("hex");
            let blueprint: Blueprint;
            try {
              blueprint = parseBlueprint(data.toString("utf-8"), { sectionsToRead: METADATA_SECTIONS_TO_READ });
            } catch (error) {
              // A partial import or corrupt unrelated file must not hide valid maps.
              console.warn(`Could not index beatmap '${fileName}'`, error);
              continue;
            }
            freshBlueprints.push(mapToLocalBlueprint(blueprint, osuFile, songFolder, md5Hash));
          }
        }
        if (!isCurrentFolder()) continue;
        const blueprints: Record<BlueprintMD5, BlueprintInfo> = {};
        for (const blueprint of freshBlueprints) blueprints[blueprint.md5Hash] = blueprint;
        this.blueprints = blueprints;
        this.lastRead = { osuFolder, songsFolder, dbTime, songsTime };
        return blueprints;
      } catch (error) {
        if (!isCurrentFolder()) continue;
        throw error;
      }
    }
  }

  getAllBlueprints(): Promise<Record<string, BlueprintInfo>> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (this.readInFlight) return this.readInFlight;
    const pending = this.completeRead();
    this.readInFlight = pending;
    const clear = () => {
      if (this.readInFlight === pending) this.readInFlight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private refreshBlueprints(): Promise<Record<string, BlueprintInfo>> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = (async () => {
      // Never let an older normal scan overwrite a newer refreshed index.
      await this.readInFlight;
      return this.completeRead(true);
    })();
    this.refreshInFlight = pending;
    const clear = () => {
      if (this.refreshInFlight === pending) this.refreshInFlight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  async getBlueprintByMD5(md5: string, refresh = false): Promise<BlueprintInfo | undefined> {
    if (this.refreshInFlight) return (await this.refreshInFlight)[md5];
    if (refresh) return (await this.refreshBlueprints())[md5];
    const maps = await this.getAllBlueprints();
    return maps[md5] ?? (await this.refreshBlueprints())[md5];
  }

  public async blueprintBg(md5: string): Promise<string | undefined> {
    const blueprintMetaData = await this.getBlueprintByMD5(md5);
    if (!blueprintMetaData) return undefined;
    const { osuFileName, folderName } = blueprintMetaData;
    const data = await readFile(join(this.songsFolder, folderName, osuFileName), { encoding: "utf-8" });
    const parsedBlueprint = parseBlueprint(data, { sectionsToRead: ["Events"] });
    // There is also an offset but let's ignore for now
    return parsedBlueprint.blueprintInfo.metadata.backgroundFile;
  }
}

// This might be a very expensive operation and should be done only once at startup. The new ones should be watched
// ~250ms at my Songs folder
export async function getNewFolderCandidates(songsFolder: string, importedLaterThan: Date): Promise<string[]> {
  return filterFilenamesInDirectory(songsFolder, async (fileName) => {
    try {
      const s = await stat(join(songsFolder, fileName));
      return s.mtime.getTime() > importedLaterThan.getTime() && s.isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

export async function listOsuFiles(songFolder: string): Promise<string[]> {
  return filterFilenamesInDirectory(songFolder, async (fileName) => fileName.endsWith(".osu"));
}
