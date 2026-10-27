import "reflect-metadata";
import { Loader } from "@pixi/loaders";
import { generateDefaultSkinConfig, OsuSkinTextures } from "@rewind/osu/skin";
import { OsuSkinTextureResolver, SkinFolderReader } from "@rewind/osu-local/skin-reader";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { SkinLoader } from "./SkinLoader";
import { OsuFolderService } from "./OsuFolderService";
import { OFFICIAL_LAZER_SLIDER_MISS_ASSETS } from "./OfficialLazerSliderMissAssets";
import { BaseTexture, Texture } from "@pixi/core";

interface MockTexture {
  valid: boolean;
  baseTexture: { valid: boolean; setResolution: jest.Mock };
  destroy: jest.Mock;
}

interface MockLoader {
  add: jest.Mock;
  resources: Record<string, { texture: MockTexture }>;
  destroy: jest.Mock;
}

const mockLoaders: MockLoader[] = [];
let mockBrokenKey: string | undefined;
let mockInvalidTexture = false;
let mockSharedBaseTexture: BaseTexture | undefined;

jest.mock("@pixi/loaders", () => ({
  Loader: jest.fn().mockImplementation(() => {
    let onStart: () => void;
    let onComplete: () => void;
    let onError: (error: Error, loader: unknown, resource: { name: string }) => void;
    const resources: MockLoader["resources"] = {};
    const loader = {
      resources,
      add: jest.fn((name: string) => {
        const texture = new Texture(
          name.includes("/CURSOR-") && mockSharedBaseTexture
            ? mockSharedBaseTexture
            : new BaseTexture(null, { width: 2, height: 2 }),
        );
        jest.spyOn(texture.baseTexture, "setResolution");
        jest.spyOn(texture, "destroy");
        resources[name] = { texture: texture as unknown as MockTexture };
      }),
      onStart: { once: (listener: () => void) => (onStart = listener) },
      onComplete: { once: (listener: () => void) => (onComplete = listener) },
      onError: { once: (listener: typeof onError) => (onError = listener) },
      destroy: jest.fn(),
      load: () => {
        onStart();
        for (const [name, resource] of Object.entries(resources)) {
          if (!mockBrokenKey || !name.includes(`/${mockBrokenKey}-`)) continue;
          if (mockInvalidTexture) resource.texture.valid = false;
          else {
            resource.texture.destroy(true);
            resource.texture = undefined as unknown as MockTexture;
            onError?.(new Error("Image decode failed"), loader, { name });
          }
        }
        onComplete();
      },
    };
    mockLoaders.push(loader);
    return loader;
  }),
}));

jest.mock("@rewind/osu-local/skin-reader", () => ({
  SkinFolderReader: { getSkinResolver: jest.fn() },
}));

jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));

function createLoader() {
  const osuFolder = resolve("skin-fixtures", "osu! #100%25 日本語");
  const rewindFolder = resolve("skin-fixtures", "Rewind #100%2F", "skins");
  const folders = { getOsuFolder: () => osuFolder } as OsuFolderService;
  return { loader: new SkinLoader(folders, rewindFolder), osuFolder, rewindFolder };
}

function resolver(paths: string[]): OsuSkinTextureResolver & { resolve: jest.Mock } {
  return { resolve: jest.fn().mockResolvedValue(paths) };
}

function expectFileURL(url: string, expectedPath: string) {
  expect(url).toMatch(/^file:\/\//);
  expect(new URL(url).hash).toBe("");
  expect(new URL(url).search).toBe("");
  expect(fileURLToPath(url)).toBe(expectedPath);
}

describe("SkinLoader local texture URLs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoaders.length = 0;
    mockBrokenKey = undefined;
    mockInvalidTexture = false;
    mockSharedBaseTexture = undefined;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "debug").mockImplementation(() => undefined);
    jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])("rejects failed/invalid skin digits before publication (invalid=%s)", async (invalid) => {
    const { loader } = createLoader();
    const config = generateDefaultSkinConfig(false);
    const skinResolver = {
      config,
      resolve: async (key: OsuSkinTextures) => (key === "HIT_CIRCLE_1" ? ["default-1.png"] : []),
    };
    (SkinFolderReader.getSkinResolver as jest.Mock).mockResolvedValue(skinResolver);
    mockBrokenKey = "HIT_CIRCLE_1";
    mockInvalidTexture = invalid;
    await expect(loader.loadSkin({ source: "osu", name: "Broken" })).rejects.toThrow();
    expect(loader.skins["osu/Broken"]).toBeUndefined();
    expect(mockLoaders[0].destroy).toHaveBeenCalledTimes(1);
    // Successfully decoded siblings belong to the rejected load and must be freed too.
    const siblings = Object.entries(mockLoaders[0].resources).filter(([name]) => !name.includes("/HIT_CIRCLE_1-"));
    expect(siblings.length).toBeGreaterThan(0);
    expect(siblings.every(([, resource]) => resource.texture.destroy.mock.calls.some(([base]) => base === true))).toBe(
      true,
    );
    mockBrokenKey = undefined;
    const recovered = await loader.loadSkin({ source: "osu", name: "Broken" });
    expect(recovered.getHitCircleNumberTextures()[1].valid).toBe(true);
  });

  it("preserves a previously cached valid skin when a forced reload fails", async () => {
    const { loader } = createLoader();
    const config = generateDefaultSkinConfig(false);
    const skinResolver = {
      config,
      resolve: async (key: OsuSkinTextures) => (key === "HIT_CIRCLE_1" ? ["default-1.png"] : []),
    };
    (SkinFolderReader.getSkinResolver as jest.Mock).mockResolvedValue(skinResolver);
    const skinId = { source: "osu", name: "Previously working" } as const;
    const good = await loader.loadSkin(skinId);
    const oldTexture = good.getHitCircleNumberTextures()[1];
    mockBrokenKey = "HIT_CIRCLE_1";
    await expect(loader.loadSkin(skinId, true)).rejects.toThrow();
    expect(await loader.loadSkin(skinId)).toBe(good);
    expect(oldTexture.valid).toBe(true);
  });

  it("does not destroy a cached skin's base texture through an abandoned distinct wrapper", async () => {
    const { loader } = createLoader();
    const config = generateDefaultSkinConfig(false);
    const skinResolver = {
      config,
      resolve: async (key: OsuSkinTextures) =>
        key === "HIT_CIRCLE_1" ? ["default-1.png"] : key === "CURSOR" ? ["cursor.png"] : [],
    };
    (SkinFolderReader.getSkinResolver as jest.Mock).mockResolvedValue(skinResolver);
    const good = await loader.loadSkin({ source: "osu", name: "Good" });
    mockSharedBaseTexture = good.getTexture("CURSOR").baseTexture;
    mockBrokenKey = "HIT_CIRCLE_1";
    await expect(loader.loadSkin({ source: "osu", name: "Broken" })).rejects.toThrow();
    expect(mockSharedBaseTexture.destroyed).toBe(false);
    expect(good.getTexture("CURSOR").baseTexture.valid).toBe(true);
    const wrapper = Object.entries(mockLoaders[1].resources).find(([name]) => name.includes("/CURSOR-"))![1].texture;
    expect(wrapper).not.toBe(good.getTexture("CURSOR"));
    expect(wrapper.destroy).toHaveBeenCalledWith(false);
  });

  it.each(["cursormiddle.png", "cursormiddle@2x.png"])(
    "loads the selected skin's optional %s layer",
    async (filename) => {
      const { loader, osuFolder } = createLoader();
      const config = generateDefaultSkinConfig(false);
      const selectedFiles: Record<string, string[]> = { CURSOR: ["cursor.png"], CURSOR_MIDDLE: [filename] };
      const selectedResolver = { config, resolve: jest.fn(async (key: OsuSkinTextures) => selectedFiles[key] ?? []) };
      const defaultResolver = { config, resolve: jest.fn(async () => []) };
      (SkinFolderReader.getSkinResolver as jest.Mock)
        .mockResolvedValueOnce(defaultResolver)
        .mockResolvedValueOnce(selectedResolver);
      const skinId = { source: "osu", name: "Middle cursor skin" } as const;

      const skin = await loader.loadSkin(skinId);
      const pixiLoader = mockLoaders[0];
      const middleFiles = pixiLoader.add.mock.calls.filter(([name]) => name.includes("/CURSOR_MIDDLE-"));

      expect(middleFiles).toHaveLength(1);
      const [name, url] = middleFiles[0];
      expectFileURL(url, join(osuFolder, "Skins", skinId.name, filename));
      expect(skin.textures["CURSOR_MIDDLE" as OsuSkinTextures]).toEqual([pixiLoader.resources[name].texture]);
      // File URLs retain @2x so Pixi applies its normal resolution handling once.
      expect(pixiLoader.resources[name].texture.baseTexture.setResolution).not.toHaveBeenCalled();
    },
  );

  it("does not add the default middle layer to a skin that has no cursormiddle", async () => {
    const { loader } = createLoader();
    const config = generateDefaultSkinConfig(false);
    const fallbackFiles: Record<string, string[]> = { CURSOR_MIDDLE: ["cursormiddle@2x.png"] };
    const selectedResolver = { config, resolve: jest.fn(async () => []) };
    const defaultResolver = { config, resolve: jest.fn(async (key: OsuSkinTextures) => fallbackFiles[key] ?? []) };
    (SkinFolderReader.getSkinResolver as jest.Mock)
      .mockResolvedValueOnce(defaultResolver)
      .mockResolvedValueOnce(selectedResolver);

    await loader.loadSkin({ source: "osu", name: "Ordinary cursor skin" });

    expect(mockLoaders[0].add.mock.calls.some(([name]) => name.includes("/CURSOR_MIDDLE-"))).toBe(false);
    expect(defaultResolver.resolve).not.toHaveBeenCalledWith("CURSOR_MIDDLE", expect.anything());
  });

  it.each([
    ["Skin #1", "hitcircle#1.png"],
    ["Skin 100%", "hitcircle%.png"],
    ["Skin %23", "font%23/default-0.png"],
    ["Skin %2F", "font%2F/default-0.png"],
    ["Skin %25", "font%25/default-0.png"],
    ["日本語 皮膚", "字體/default 0@2x.png"],
    ["Skin ! & +", "font &+/default-0.png"],
  ])("preserves literal folder and filename characters: %s / %s", async (folderName, filename) => {
    const { loader } = createLoader();
    const folderPath = resolve("skin-fixtures", folderName);
    const urls = await loader.resolve("HIT_CIRCLE", {}, [{ folderPath, resolver: resolver([filename]) }]);

    expect(urls).toHaveLength(1);
    expectFileURL(urls[0], join(folderPath, filename));
  });

  const windowsTest = process.platform === "win32" ? it : it.skip;
  windowsTest.each(["D:\\osu!\\Skins\\Skin #100%23", "\\\\skin-server\\skin-share\\Skin #100%2F"])(
    "preserves Windows drive and UNC paths: %s",
    async (folderPath) => {
      const { loader } = createLoader();
      const filename = "font #1\\default%25-0@2x.png";
      const urls = await loader.resolve("HIT_CIRCLE", {}, [{ folderPath, resolver: resolver([filename]) }]);

      expectFileURL(urls[0], join(folderPath, filename));
    },
  );

  it("keeps every animation frame in order and stops at the selected skin", async () => {
    const { loader } = createLoader();
    const folderPath = resolve("skin-fixtures", "Animated #100%25");
    const frames = ["hit300-0@2x.png", "hit300-1@2x.png", "hit300-2@2x.png"];
    const selected = resolver(frames);
    const fallback = resolver(["hit300.png"]);
    const options = { animatedIfExists: true, hdIfExists: true };

    const urls = await loader.resolve("HIT_300", options, [
      { folderPath, resolver: selected },
      { folderPath: resolve("skin-fixtures", "Default"), resolver: fallback },
    ]);

    expect(urls).toHaveLength(frames.length);
    urls.forEach((url, index) => expectFileURL(url, join(folderPath, frames[index])));
    expect(selected.resolve).toHaveBeenCalledWith("HIT_300", options);
    expect(fallback.resolve).not.toHaveBeenCalled();
  });

  it("encodes the fallback folder only after the selected skin has no texture", async () => {
    const { loader } = createLoader();
    const folderPath = resolve("skin-fixtures", "Default #100%23");
    const selected = resolver([]);
    const fallback = resolver(["hitcircle@2x.png"]);

    const urls = await loader.resolve("HIT_CIRCLE", {}, [
      { folderPath: resolve("skin-fixtures", "Selected"), resolver: selected },
      { folderPath, resolver: fallback },
    ]);

    expect(selected.resolve).toHaveBeenCalledTimes(1);
    expect(fallback.resolve).toHaveBeenCalledTimes(1);
    expectFileURL(urls[0], join(folderPath, "hitcircle@2x.png"));
    expect(await loader.resolve("HIT_CIRCLE", {}, [{ folderPath, resolver: resolver([]) }])).toEqual([]);
  });

  it("passes encoded file URLs to Pixi and leaves embedded data URL fallbacks unchanged", async () => {
    const { loader, osuFolder, rewindFolder } = createLoader();
    const config = generateDefaultSkinConfig(false);
    config.general.name = "Selected #100%25";
    const selectedFrames = ["font #1/hit300-0@2x.png", "font #1/hit300-1@2x.png"];
    const defaultResolver = {
      config,
      resolve: jest.fn(async (key: OsuSkinTextures) => (key === "HIT_CIRCLE" ? ["hitcircle@2x.png"] : [])),
    };
    const selectedResolver = {
      config,
      resolve: jest.fn(async (key: OsuSkinTextures) => (key === "HIT_300" ? selectedFrames : [])),
    };
    (SkinFolderReader.getSkinResolver as jest.Mock)
      .mockResolvedValueOnce(defaultResolver)
      .mockResolvedValueOnce(selectedResolver);
    const skinId = { source: "osu", name: "Selected #100%25" } as const;

    const skin = await loader.loadSkin(skinId);
    const pixiLoader = mockLoaders[0];
    const queued: [string, string][] = pixiLoader.add.mock.calls as [string, string][];
    const byKey = (key: string) => queued.filter(([name]) => name.includes(`/${key}-`));

    expect(SkinFolderReader.getSkinResolver).toHaveBeenNthCalledWith(1, join(rewindFolder, "OsuDefaultSkin"));
    expect(SkinFolderReader.getSkinResolver).toHaveBeenNthCalledWith(2, join(osuFolder, "Skins", skinId.name));
    byKey("HIT_300").forEach(([, url], index) =>
      expectFileURL(url, join(osuFolder, "Skins", skinId.name, selectedFrames[index])),
    );
    expect(byKey("HIT_300")).toHaveLength(2);
    expectFileURL(byKey("HIT_CIRCLE")[0][1], join(rewindFolder, "OsuDefaultSkin", "hitcircle@2x.png"));

    for (const key of ["SLIDER_END_MISS", "SLIDER_TICK_MISS"] as const) {
      const [name, url] = byKey(key)[0];
      expect(url).toBe(OFFICIAL_LAZER_SLIDER_MISS_ASSETS[key]);
      expect(url).toMatch(/^data:image\/png;base64,/);
      expect(pixiLoader.resources[name].texture.baseTexture.setResolution).toHaveBeenCalledWith(2);
    }
    for (const [name] of [...byKey("HIT_300"), ...byKey("HIT_CIRCLE")]) {
      expect(pixiLoader.resources[name].texture.baseTexture.setResolution).not.toHaveBeenCalled();
    }
    expect(await loader.loadSkin(skinId)).toBe(skin);
    expect(Loader).toHaveBeenCalledTimes(1);
  });
});
