import "reflect-metadata";
import { DEFAULT_SKIN_SETTINGS, SkinHolder, SkinManager, SkinSettingsStore } from "./skin";
import type { Skin } from "../../model/Skin";

jest.mock("./local/SkinLoader", () => ({ SkinLoader: class SkinLoader {} }));

function deferredSkin() {
  let resolve!: (skin: Skin) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Skin>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const loadSkin = jest.fn();
  const settings = new SkinSettingsStore();
  const holder = new SkinHolder();
  const manager = new SkinManager({ loadSkin } as never, settings, holder);
  return { loadSkin, settings, holder, manager };
}

const firstId = { source: "osu" as const, name: "First" };
const secondId = { source: "osu" as const, name: "Second" };

describe("skin selection request order", () => {
  afterEach(() => jest.restoreAllMocks());

  it("keeps the latest selection when an older skin finishes loading later", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    const first = deferredSkin();
    const second = deferredSkin();
    const firstSkin = { name: "First" } as unknown as Skin;
    const secondSkin = { name: "Second" } as unknown as Skin;
    loadSkin.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstRequest = manager.loadSkin(firstId);
    const secondRequest = manager.loadSkin(secondId);
    second.resolve(secondSkin);
    await secondRequest;
    first.resolve(firstSkin);
    await firstRequest;

    expect(holder.getSkin()).toBe(secondSkin);
    expect(settings.settings.preferredSkinId).toBe("osu:Second");
  });

  it("does not replace a user selection with the fallback when an obsolete startup load fails", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    const first = deferredSkin();
    const secondSkin = { name: "Second" } as unknown as Skin;
    loadSkin.mockReturnValueOnce(first.promise).mockResolvedValueOnce(secondSkin);

    const startup = manager.loadPreferredSkin();
    await manager.loadSkin(secondId);
    first.reject(new Error("Old skin is unreadable"));
    await expect(startup).resolves.toBeUndefined();

    expect(loadSkin).toHaveBeenCalledTimes(2);
    expect(holder.getSkin()).toBe(secondSkin);
    expect(settings.settings.preferredSkinId).toBe("osu:Second");
  });

  it("reports the latest selection failure and retains the successfully applied skin", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    const firstSkin = { name: "First" } as unknown as Skin;
    const failure = new Error("Selected skin is unreadable");
    loadSkin.mockResolvedValueOnce(firstSkin).mockRejectedValueOnce(failure);
    await manager.loadSkin(firstId);

    await expect(manager.loadSkin(secondId)).rejects.toBe(failure);
    expect(holder.getSkin()).toBe(firstSkin);
    expect(settings.settings.preferredSkinId).toBe("osu:First");
  });

  it("still loads the default skin when the current startup preference fails", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    settings.setPreferredSkinId("osu:Missing");
    const fallback = { name: "Default" } as unknown as Skin;
    loadSkin.mockRejectedValueOnce(new Error("Missing")).mockResolvedValueOnce(fallback);

    await manager.loadPreferredSkin();

    expect(loadSkin).toHaveBeenNthCalledWith(2, { source: "rewind", name: "RewindDefaultSkin" });
    expect(holder.getSkin()).toBe(fallback);
    expect(settings.settings.preferredSkinId).toBe(DEFAULT_SKIN_SETTINGS.preferredSkinId);
  });

  it("loads and persists the default when the stored skin ID cannot be parsed", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    settings.setPreferredSkinId("bad:skin");
    const fallback = { name: "Default" } as unknown as Skin;
    loadSkin.mockResolvedValueOnce(fallback);

    await manager.loadPreferredSkin();

    expect(loadSkin).toHaveBeenCalledTimes(1);
    expect(loadSkin).toHaveBeenCalledWith({ source: "rewind", name: "RewindDefaultSkin" });
    expect(holder.getSkin()).toBe(fallback);
    expect(settings.settings.preferredSkinId).toBe(DEFAULT_SKIN_SETTINGS.preferredSkinId);
  });

  it("keeps a newer user selection when the malformed preference's fallback fails later", async () => {
    const { loadSkin, settings, holder, manager } = fixture();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    settings.setPreferredSkinId("bad:skin");
    const fallback = deferredSkin();
    const selectedSkin = { name: "Second" } as unknown as Skin;
    loadSkin.mockReturnValueOnce(fallback.promise).mockResolvedValueOnce(selectedSkin);

    const startup = manager.loadPreferredSkin();
    await manager.loadSkin(secondId);
    fallback.reject(new Error("Obsolete fallback failed"));
    await expect(startup).resolves.toBeUndefined();

    expect(loadSkin).toHaveBeenCalledTimes(2);
    expect(holder.getSkin()).toBe(selectedSkin);
    expect(settings.settings.preferredSkinId).toBe("osu:Second");
  });
});
