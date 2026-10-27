import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readOsuSkinInUse } from "./osu-skin-in-use";

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rewind-skin-in-use-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const writeCfg = (userName: string, text: string) => writeFile(join(folder, `osu!.${userName}.cfg`), text, "utf8");

describe("readOsuSkinInUse", () => {
  it("reads the Skin line", async () => {
    await writeCfg("Player", "# osu! config\r\nVolume = 80\r\nSkin = - WhiteCat 2.1 -\r\nDim = 70\r\n");
    expect(await readOsuSkinInUse(folder, "Player")).toBe("- WhiteCat 2.1 -");
  });

  it("returns undefined without the file", async () => {
    expect(await readOsuSkinInUse(folder, "Player")).toBeUndefined();
  });

  it("returns undefined without the line", async () => {
    await writeCfg("Player", "Volume = 80\nSkinSamples = 1\n# Skin = Commented\n");
    expect(await readOsuSkinInUse(folder, "Player")).toBeUndefined();
  });

  it("returns undefined for an empty value", async () => {
    await writeCfg("Player", "Skin = \nVolume = 80\n");
    expect(await readOsuSkinInUse(folder, "Player")).toBeUndefined();
    await writeCfg("Player", "Skin =    \n");
    expect(await readOsuSkinInUse(folder, "Player")).toBeUndefined();
  });

  it("returns undefined for an empty folder or user name", async () => {
    await writeCfg("Player", "Skin = Lain\n");
    expect(await readOsuSkinInUse("", "Player")).toBeUndefined();
    expect(await readOsuSkinInUse(folder, "")).toBeUndefined();
    expect(await readOsuSkinInUse("  ", "Player")).toBeUndefined();
  });

  it('keeps a name containing " = " and non-ASCII characters', async () => {
    await writeCfg("Player", "Skin = a = b ★ 雪 = c\n");
    expect(await readOsuSkinInUse(folder, "Player")).toBe("a = b ★ 雪 = c");
  });
});
