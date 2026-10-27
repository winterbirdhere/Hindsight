import { BaseTexture, Sprite, Texture } from "pixi.js";
import { OsuClassicNumber } from "./OsuClassicNumber";

function digitTextures(width: number): Texture[] {
  return Array.from({ length: 10 }, () => new Texture(new BaseTexture(undefined, { width, height: 16 })));
}

describe("OsuClassicNumber resource reuse", () => {
  it("reuses digit sprites while updating values, skin textures, and overlap", () => {
    const number = new OsuClassicNumber();
    const textures = digitTextures(10);
    const digits = [1, 2];
    number.prepare({ digits, textures, overlap: 2 });
    const [first, second] = number.children as Sprite[];
    expect(second.x).toBe(8);

    number.prepare({ digits: [3, 4], textures, overlap: 2 });
    expect(number.children[0]).toBe(first);
    expect(number.children[1]).toBe(second);
    expect(first.texture).toBe(textures[3]);
    expect(second.texture).toBe(textures[4]);

    const replacementTextures = digitTextures(20);
    number.prepare({ digits, textures: replacementTextures, overlap: 5 });
    number.prepare({ digits, textures: replacementTextures, overlap: 7 });
    expect(first.texture).toBe(replacementTextures[1]);
    expect(second.texture).toBe(replacementTextures[2]);
    expect(second.x).toBe(13);

    number.destroy({ children: true });
    [...textures, ...replacementTextures].forEach((texture) => texture.destroy(true));
  });

  it("destroys every surplus sprite without destroying shared skin textures", () => {
    const number = new OsuClassicNumber();
    const textures = digitTextures(10);
    number.prepare({ digits: [1, 2, 3], textures, overlap: 0 });
    const previousSprites = [...number.children];
    const destroyTexture = jest.spyOn(textures[2], "destroy");

    number.prepare({ digits: [1], textures, overlap: 0 });
    expect(number.children).toEqual([previousSprites[0]]);
    expect(previousSprites[1].destroyed).toBe(true);
    expect(previousSprites[2].destroyed).toBe(true);
    expect(destroyTexture).not.toHaveBeenCalled();
    expect(textures[2].baseTexture.destroyed).toBe(false);

    number.prepare({ digits: [], textures, overlap: 0 });
    expect(number.children).toHaveLength(0);
    expect(previousSprites[0].destroyed).toBe(true);
    number.destroy();
    textures.forEach((texture) => texture.destroy(true));
  });
});
