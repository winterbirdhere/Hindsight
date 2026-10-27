import { ClipFrameChunkBuffer } from "./clip-frame-chunks";

describe("clip frame chunk storage", () => {
  it("borrows a complete frame at the message-size boundary", () => {
    const pixels = new Uint8ClampedArray(8388608);
    const chunks = new ClipFrameChunkBuffer();
    expect(chunks.chunk(pixels, 0) === pixels.buffer).toBe(true);
  });

  it("copies the correct regions and reuses full and partial chunks separately", () => {
    const pixels = new Uint8ClampedArray(8388611);
    pixels[0] = 11;
    pixels[8388607] = 12;
    pixels.set([21, 22, 23], 8388608);
    const chunks = new ClipFrameChunkBuffer();
    const full = chunks.chunk(pixels, 0);
    expect(full.byteLength).toBe(8388608);
    expect([new Uint8Array(full)[0], new Uint8Array(full)[8388607]]).toEqual([11, 12]);
    const tail = chunks.chunk(pixels, 8388608);
    expect(Array.from(new Uint8Array(tail))).toEqual([21, 22, 23]);
    pixels[0] = 31;
    pixels.set([41, 42, 43], 8388608);
    expect(chunks.chunk(pixels, 0) === full).toBe(true);
    expect(new Uint8Array(full)[0]).toBe(31);
    expect(chunks.chunk(pixels, 8388608) === tail).toBe(true);
    expect(Array.from(new Uint8Array(tail))).toEqual([41, 42, 43]);
  });

  it.each([0, 2])("does not send bytes outside a pixel view starting at %s", (offset) => {
    const backing = new Uint8ClampedArray([99, 98, 1, 2, 3, 97]);
    const pixels = backing.subarray(offset, offset + 3);
    const chunk = new ClipFrameChunkBuffer().chunk(pixels, 0);
    expect(chunk.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(chunk))).toEqual(offset === 0 ? [99, 98, 1] : [1, 2, 3]);
  });

  it("keeps independent exports' staging buffers separate", () => {
    const pixels = new Uint8ClampedArray(8388609).fill(7);
    const first = new ClipFrameChunkBuffer().chunk(pixels, 0);
    pixels.fill(8);
    const second = new ClipFrameChunkBuffer().chunk(pixels, 0);
    expect(first === second).toBe(false);
    expect(new Uint8Array(first)[100]).toBe(7);
    expect(new Uint8Array(second)[100]).toBe(8);
  });
});
