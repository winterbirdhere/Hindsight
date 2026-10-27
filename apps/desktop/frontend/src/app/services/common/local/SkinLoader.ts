import { Loader } from "@pixi/loaders";
import { Texture } from "pixi.js";
import { DEFAULT_SKIN_TEXTURE_CONFIG, OsuSkinTextures } from "@rewind/osu/skin";
import { inject, injectable } from "inversify";
import { Skin, SkinTexturesByKey } from "../../../model/Skin";
import { SkinId } from "../../../model/SkinId";
import { OsuFolderService } from "./OsuFolderService";
import { GetTextureFileOption, OsuSkinTextureResolver, SkinFolderReader } from "@rewind/osu-local/skin-reader";
import { join } from "path";
import { pathToFileURL } from "url";
import { STAGE_TYPES } from "../../types";
import { OFFICIAL_LAZER_SLIDER_MISS_ASSETS } from "./OfficialLazerSliderMissAssets";

export type SkinTextureLocation = { key: OsuSkinTextures; paths: string[] };

async function startLoading(loader: Loader, skinName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    loader.onStart.once(() => {
      console.log(`Skin loading started for ${skinName}`);
    });

    loader.onComplete.once(() => {
      console.debug(`Skin loading completed for ${skinName}`);
      if (failure) reject(failure);
      else resolve();
    });

    loader.onError.once((error, _loader, resource) => {
      // Wait for completion before rejecting so cleanup also owns resources
      // that were still decoding when the first image failed.
      failure = new Error(`Could not load skin image ${resource.name}: ${error.message}`);
    });
    loader.load();
  });
}

const OSU_DEFAULT_SKIN_ID: SkinId = { source: "rewind", name: "OsuDefaultSkin" };

@injectable()
export class SkinLoader {
  skins: { [key: string]: Skin };
  skinElementCounter = 0;

  // Maybe generalize it to skinSource or something
  // TODO: Maybe just load into TextureManager
  constructor(
    private osuFolderService: OsuFolderService,
    @inject(STAGE_TYPES.REWIND_SKINS_FOLDER) private rewindSkinsFolder: string,
  ) {
    this.skins = {};
  }

  // TODO: AppResourcesPath and get the included Rewind Skins

  async loadSkinList() {
    return SkinFolderReader.listSkinsInFolder(join(this.osuFolderService.getOsuFolder(), "Skins"), {
      skinIniRequired: false,
    });
  }

  sourcePath(source: string) {
    switch (source) {
      case "rewind":
        return this.rewindSkinsFolder;
      case "osu":
        return join(this.osuFolderService.getOsuFolder(), "Skins");
    }
    return "";
  }

  resolveToPath({ source, name }: SkinId) {
    return join(this.sourcePath(source), name);
  }

  /**
   * In the future we also want to get the skin info with the beatmap as the parameters in order to retrieve
   * beatmap related skin files as well.
   */
  async resolve(
    osuSkinTexture: OsuSkinTextures,
    options: GetTextureFileOption,
    list: { folderPath: string; resolver: OsuSkinTextureResolver }[],
  ) {
    for (const { folderPath, resolver } of list) {
      const filePaths = await resolver.resolve(osuSkinTexture, options);
      if (filePaths.length === 0) {
        continue;
      }
      // Join filesystem paths first: URL separators such as # and literal
      // percent escapes belong to the filename, not a fragment or URL escape.
      return filePaths.map((path) => pathToFileURL(join(folderPath, path)).href);
    }
    console.debug(`No skin has the skin texture ${osuSkinTexture}`);
    return [];
  }

  // force such like reloading
  async loadSkin(skinId: SkinId, forceReload?: boolean): Promise<Skin> {
    const id = `${skinId.source}/${skinId.name}`;
    if (this.skins[id] && !forceReload) {
      console.info(`Skin ${id} is already loaded, using the one in cache`);
      return this.skins[id];
    }
    console.log(`Loading skin with name: ${skinId.name} with source ${skinId.source}`);
    const loader = new Loader();
    try {
      const osuDefaultSkinResolver = await SkinFolderReader.getSkinResolver(this.resolveToPath(OSU_DEFAULT_SKIN_ID));
      const skinResolver = await SkinFolderReader.getSkinResolver(this.resolveToPath(skinId));

      const { config } = skinResolver;

      const skinTextureKeys = Object.keys(DEFAULT_SKIN_TEXTURE_CONFIG);
      const files = await Promise.all(
        skinTextureKeys.map(async (key) => {
          const textureKey = key as OsuSkinTextures;
          const resolvers = [{ folderPath: this.resolveToPath(skinId), resolver: skinResolver }];
          // This optional overlay belongs to the selected skin. Borrowing the
          // default middle would change custom cursors that intentionally omit it.
          if (textureKey !== "CURSOR_MIDDLE") {
            resolvers.push({
              folderPath: this.resolveToPath(OSU_DEFAULT_SKIN_ID),
              resolver: osuDefaultSkinResolver,
            });
          }
          const resolvedPaths = await this.resolve(textureKey, { animatedIfExists: true, hdIfExists: true }, resolvers);
          const embeddedFallback =
            resolvedPaths.length === 0 ? OFFICIAL_LAZER_SLIDER_MISS_ASSETS[textureKey] : undefined;

          return {
            key,
            paths: embeddedFallback ? [embeddedFallback] : resolvedPaths,
            embeddedFallback: embeddedFallback !== undefined,
          };
        }),
      );

      const textures: SkinTexturesByKey = {};
      const skinName = config.general.name;

      // Every file, even non-animatable files have the index in their name
      // For example "WhiteCat/hitcircle-0" would be one key name

      const queueFiles: { key: OsuSkinTextures; name: string; embeddedFallback: boolean }[] = [];
      files.forEach((stl) => {
        stl.paths.forEach((path, index) => {
          // `Loader` will die if the same `name` gets used twice therefore the unique skinElementCounter
          // Maybe even use a timestamp
          const name = `${this.skinElementCounter++}/${skinName}/${stl.key}-${index}`;
          loader.add(name, path);
          queueFiles.push({ key: stl.key as OsuSkinTextures, name, embeddedFallback: stl.embeddedFallback });
        });
      });

      await startLoading(loader, skinName);

      queueFiles.forEach((file) => {
        if (!(file.key in textures)) textures[file.key] = [];
        const texture = loader.resources[file.name].texture as Texture;
        if (!texture?.valid || !texture.baseTexture?.valid) throw new Error(`Could not load skin image ${file.name}`);
        // The embedded official files are @2x PNGs but data URLs contain no
        // filename suffix from which Pixi could infer their resolution.
        if (file.embeddedFallback) texture.baseTexture.setResolution(2);
        textures[file.key]?.push(texture);
      });

      return (this.skins[id] = new Skin(config, textures));
    } catch (error) {
      // Each Pixi loader image owns a new texture/base texture. Retain any
      // shared textures from previously published skins if middleware reused one.
      const retained = new Set(Object.values(this.skins).flatMap((skin) => Object.values(skin.textures).flat()));
      const retainedBases = new Set([...retained].map((texture) => texture?.baseTexture));
      const abandoned = new Set(Object.values(loader.resources).map((resource) => resource.texture));
      for (const texture of abandoned) {
        if (texture && !retained.has(texture)) {
          texture.destroy(!retainedBases.has(texture.baseTexture) && !texture.baseTexture?.destroyed);
        }
      }
      throw error;
    } finally {
      loader.destroy();
    }
  }
}
