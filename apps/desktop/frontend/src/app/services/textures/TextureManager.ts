import { injectable } from "inversify";
import { Texture } from "pixi.js";

@injectable()
export class TextureManager {
  async loadTexture(url: string) {
    try {
      return await Texture.fromURL(url);
    } catch (err) {
      return Texture.EMPTY;
    }
  }
}
