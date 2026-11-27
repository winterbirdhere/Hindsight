import { injectable } from "inversify";
import { access } from "fs/promises";
import { join } from "path";
import { constants } from "fs";
import { BehaviorSubject } from "rxjs";
import { determineSongsFolder } from "@rewind/osu-local/utils";
import username from "username";
import { ipcRenderer } from "electron";
import { PersistentService } from "../../core/service";
import { JSONSchemaType } from "ajv";

const filesToCheck = ["osu!.db", "scores.db", "Skins"];

/**
 * Checks certain files to see if Rewind can be booted without any problems with the given `osuFolderPath`.
 * @param osuFolderPath the folder path to check the files in
 */
export async function osuFolderSanityCheck(osuFolderPath: string) {
  try {
    await Promise.all(filesToCheck.map((f) => access(join(osuFolderPath, f), constants.R_OK)));
  } catch (err) {
    console.log(err);
    return false;
  }
  return true;
}

interface OsuSettings {
  osuStablePath: string;
}

export const DEFAULT_OSU_SETTINGS: OsuSettings = Object.freeze({
  osuStablePath: "",
});
export const OsuSettingsSchema: JSONSchemaType<OsuSettings> = {
  type: "object",
  properties: {
    osuStablePath: { type: "string", default: DEFAULT_OSU_SETTINGS.osuStablePath },
  },
  required: [],
};

@injectable()
export class OsuFolderService extends PersistentService<OsuSettings> {
  public replaysFolder$ = new BehaviorSubject<string>("");
  public songsFolder$ = new BehaviorSubject<string>("");
  private folderGeneration = 0;
  private folderResolution: Promise<string> = Promise.resolve("");

  key = "osu-settings";
  schema = OsuSettingsSchema;

  constructor() {
    super();
    this.settings$.subscribe(this.onFolderChange.bind(this));
  }

  getDefaultValue(): OsuSettings {
    return DEFAULT_OSU_SETTINGS;
  }

  onFolderChange(osuSettings: OsuSettings) {
    const { osuStablePath } = osuSettings;
    const generation = ++this.folderGeneration;
    ipcRenderer.send("osuFolderChanged", osuStablePath);
    this.replaysFolder$.next(osuStablePath ? join(osuStablePath, "Replays") : "");
    this.songsFolder$.next("");
    this.folderResolution = (async () => {
      if (!osuStablePath) return "";
      let songsFolder: string;
      try {
        const userId = await username();
        songsFolder = await determineSongsFolder(osuStablePath, userId as string);
      } catch (error) {
        console.warn("Could not resolve the osu! user configuration; using Songs", error);
        songsFolder = join(osuStablePath, "Songs");
      }
      if (generation === this.folderGeneration) this.songsFolder$.next(songsFolder);
      return songsFolder;
    })();
  }

  /** Await the current installation, including a folder change during an earlier lookup. */
  async whenReady(): Promise<string> {
    for (;;) {
      const resolution = this.folderResolution;
      const folder = await resolution;
      if (resolution === this.folderResolution) return folder;
    }
  }

  getOsuFolder(): string {
    return this.settings.osuStablePath;
  }

  setOsuFolder(path: string) {
    const nextSettings = { ...this.settings, osuStablePath: path };
    // The directory picker may restart immediately. Persist before notifying
    // consumers so a failed save cannot switch their paths or lose the choice.
    window.localStorage.setItem(this.key, JSON.stringify(nextSettings));
    this.settings = nextSettings;
    console.log(`osu! folder was set to '${path}'`);
  }

  async isValidOsuFolder(directoryPath: string) {
    return osuFolderSanityCheck(directoryPath);
  }

  async hasValidOsuFolderSet(): Promise<boolean> {
    return this.isValidOsuFolder(this.getOsuFolder());
  }
}
