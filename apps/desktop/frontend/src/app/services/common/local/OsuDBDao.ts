import { join } from "path";
import { Beatmap as DBBeatmap, OsuDBReader } from "@rewind/osu-local/db-reader";
import { fileLastModifiedTime, ticksToDate } from "@rewind/osu-local/utils";
import { readFile } from "fs/promises";
import { BlueprintInfo } from "../../../model/BlueprintInfo";
import { OsuFolderService } from "./OsuFolderService";
import { injectable } from "inversify";

const mapToBlueprint = (b: DBBeatmap): BlueprintInfo => {
  return {
    md5Hash: b.md5Hash,
    audioFileName: b.audioFileName,
    folderName: b.folderName,
    lastPlayed: ticksToDate(b.lastPlayed)[0],
    osuFileName: b.fileName,
    artist: b.artist, // unicode?
    title: b.title,
    creator: b.creator,
  };
};

@injectable()
export class OsuDBDao {
  private lastMtime = -1;
  private blueprints: BlueprintInfo[] = [];
  private generation = 0;
  private readInFlight?: Promise<BlueprintInfo[]>;

  constructor(private readonly osuFolderService: OsuFolderService) {
    // We just assume that we need to read it again
    this.osuFolderService.settings$.subscribe(() => {
      this.generation += 1;
      this.lastMtime = -1;
      this.blueprints = [];
      this.readInFlight = undefined;
    });
  }

  private get osuDbPath() {
    return join(this.osuFolderService.getOsuFolder(), "osu!.db");
  }

  async getOsuDbLastModifiedTime() {
    return await fileLastModifiedTime(this.osuDbPath);
  }

  async hasChanged(): Promise<boolean> {
    return this.cachedTime !== (await this.getOsuDbLastModifiedTime());
  }

  get cachedTime() {
    return this.lastMtime;
  }

  getAllBlueprints(): Promise<BlueprintInfo[]> {
    if (this.readInFlight) return this.readInFlight;
    const pending = this.readBlueprints(this.generation, this.osuDbPath);
    this.readInFlight = pending;
    const clear = () => {
      if (this.readInFlight === pending) this.readInFlight = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async readBlueprints(generation: number, file: string): Promise<BlueprintInfo[]> {
    try {
      const lastModified = await fileLastModifiedTime(file);
      if (generation !== this.generation) return this.getAllBlueprints();
      if (lastModified === this.lastMtime) return this.blueprints;
      console.log(`Reading the osu!.db with lastModifiedTime=${lastModified}`);

      const reader = new OsuDBReader(await readFile(file));
      const osuDB = await reader.readOsuDB();
      const blueprints = osuDB.beatmaps.map(mapToBlueprint);
      if (generation !== this.generation) return this.getAllBlueprints();
      // Only a complete successful read may make a timestamp cacheable.
      this.blueprints = blueprints;
      this.lastMtime = lastModified;
      return blueprints;
    } catch (error) {
      if (generation !== this.generation) return this.getAllBlueprints();
      throw error;
    }
  }

  async getBlueprintByMD5(md5: string): Promise<BlueprintInfo | undefined> {
    const maps = await this.getAllBlueprints();
    return maps.find((m) => m.md5Hash === md5);
  }
}
