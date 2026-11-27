import { MAX_CLIP_FRAME_CHUNK_BYTES } from "../../../../../shared/clip-export";

/** Per-export staging storage. Consume/acknowledge each chunk before requesting the next one. */
export class ClipFrameChunkBuffer {
  private full?: Uint8ClampedArray;
  private tail?: Uint8ClampedArray;

  chunk(pixels: Uint8ClampedArray, offset: number): ArrayBuffer {
    const length = Math.min(pixels.byteLength - offset, MAX_CLIP_FRAME_CHUNK_BYTES);
    // 1080p fits in one IPC message. Borrow it until the encoder acknowledges
    // consumption; the recorder must not render the next frame before then.
    if (
      offset === 0 &&
      pixels.byteOffset === 0 &&
      length === pixels.byteLength &&
      pixels.byteLength === pixels.buffer.byteLength &&
      pixels.buffer instanceof ArrayBuffer
    )
      return pixels.buffer;

    // Larger frames need bounded messages. Reuse one full chunk and one exact
    // tail, rather than allocating another frame's worth of memory each time.
    const full = length === MAX_CLIP_FRAME_CHUNK_BYTES;
    let buffer = full ? this.full : this.tail;
    if (buffer?.length !== length) {
      buffer = new Uint8ClampedArray(length);
      if (full) this.full = buffer;
      else this.tail = buffer;
    }
    buffer.set(pixels.subarray(offset, offset + length));
    return buffer.buffer as ArrayBuffer;
  }
}
