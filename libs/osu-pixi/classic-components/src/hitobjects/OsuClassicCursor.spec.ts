import { Sprite, Texture } from "pixi.js";
import { OsuClassicCursor } from "./OsuClassicCursor";

describe("OsuClassicCursor skin layers", () => {
  let cursor: OsuClassicCursor;
  let textures: Texture[];

  beforeEach(() => {
    cursor = new OsuClassicCursor();
    textures = [];
  });

  afterEach(() => {
    cursor.container.destroy({ children: true });
    textures.forEach((texture) => texture.destroy(true));
  });

  function texture(width: number, height: number, resolution = 1, transparent = false): Texture {
    const pixels = new Uint8Array(width * height * 4).fill(transparent ? 0 : 255);
    const result = Texture.fromBuffer(pixels, width, height, { resolution });
    textures.push(result);
    return result;
  }

  it("shows the visible middle layer above a transparent main cursor without changing its trails", () => {
    const cursorTexture = texture(1, 1, 1, true);
    const cursorMiddleTexture = texture(64, 64);
    const cursorTrailTexture = texture(8, 8);
    const settings = {
      position: { x: 256, y: 192 },
      trailPositions: [
        { x: 252, y: 190 },
        { x: 248, y: 187 },
      ],
      cursorScale: 0.8,
      cursorTexture,
      cursorMiddleTexture,
      cursorTrailTexture,
    };

    cursor.prepare(settings);

    const children = cursor.container.children as Sprite[];
    const main = children.find((sprite) => sprite.texture === cursorTexture)!;
    const middle = children.find((sprite) => sprite.texture === cursorMiddleTexture)!;
    expect(middle).toBeDefined();
    expect(middle.visible).toBe(true);
    expect(middle.anchor.x).toBe(0.5);
    expect(middle.anchor.y).toBe(0.5);
    expect(middle.position.x).toBe(256);
    expect(middle.position.y).toBe(192);
    expect(middle.width).toBeCloseTo(51.2);
    expect(middle.height).toBeCloseTo(51.2);
    expect(main.width).toBeCloseTo(0.8);
    expect(main.position.x).toBe(256);
    expect(main.position.y).toBe(192);
    expect(children.indexOf(middle)).toBeGreaterThan(children.indexOf(main));

    const trails = children.filter((sprite) => sprite.texture === cursorTrailTexture);
    expect(trails).toHaveLength(8);
    expect(trails.every((sprite) => children.indexOf(sprite) < children.indexOf(main))).toBe(true);
    const activeTrails = trails.filter((sprite) => sprite.alpha > 0);
    expect(activeTrails.map((sprite) => [sprite.position.x, sprite.position.y, sprite.alpha])).toEqual([
      [248, 187, 0.5],
      [252, 190, 1],
    ]);
    expect(activeTrails.every((sprite) => sprite.scale.x === 0.8 && sprite.scale.y === 0.8)).toBe(true);
  });

  it("uses an @2x middle texture's logical size without halving it a second time", () => {
    const cursorMiddleTexture = texture(128, 128, 2);
    const settings = { cursorScale: 0.8, cursorMiddleTexture };

    cursor.prepare(settings);

    const middle = (cursor.container.children as Sprite[]).find((sprite) => sprite.texture === cursorMiddleTexture)!;
    expect(middle).toBeDefined();
    expect(middle.width).toBeCloseTo(51.2);
    expect(middle.height).toBeCloseTo(51.2);
  });

  it("clears the previous middle layer when the next skin supplies Texture.EMPTY", () => {
    const cursorMiddleTexture = texture(64, 64);
    const settings = { cursorScale: 0.8, cursorMiddleTexture };
    cursor.prepare(settings);
    const middle = (cursor.container.children as Sprite[]).find((sprite) => sprite.texture === cursorMiddleTexture)!;
    expect(middle).toBeDefined();

    const absentMiddle = { cursorScale: 1, cursorMiddleTexture: Texture.EMPTY };
    cursor.prepare(absentMiddle);

    expect(middle.texture).toBe(Texture.EMPTY);
    expect(middle.visible).toBe(false);
    expect((cursor.container.children as Sprite[]).some((sprite) => sprite.texture === cursorMiddleTexture)).toBe(
      false,
    );

    cursor.prepare(settings);
    expect(middle.texture).toBe(cursorMiddleTexture);
    expect(middle.visible).toBe(true);
    expect(middle.width).toBeCloseTo(51.2);
  });
});
