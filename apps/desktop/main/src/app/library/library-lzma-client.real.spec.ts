import { compress } from "lzma";
import { OsrReplay, readWithDecompressor } from "@rewind/osu-local/osr-reader";
import { LibraryLzmaClient } from "./library-lzma-client";

// Explicit opt-in: point only at the already compiled isolated QA helper.
const executable = process.env.HINDSIGHT_LIBRARY_DECODER_EXECUTABLE;
const real = executable ? describe : describe.skip;
real("compiled native replay decoder", () => {
  const client = () => new LibraryLzmaClient(() => executable as string);
  it("decodes native frames and custom settings through the real child process", async () => {
    const decoder = client();
    try {
      const replay = new OsrReplay();
      Object.assign(replay, { gameVersion: 30_000_016, beatmapMD5: "1234567890abcdef1234567890abcdef",
        playerName: "Fixture", replay_data: "0|256|192|0,1000|256|192|1,-12345|0|0|42,", unknown: 12345 });
      const info = { mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }], statistics: { great: 3 } };
      const extra = Buffer.from(compress(JSON.stringify(info)));
      const size = Buffer.alloc(4); size.writeInt32LE(extra.length);
      const bytes = Buffer.concat([replay.serializeSync(), size, extra]);
      const result = await readWithDecompressor(bytes, decoder.decode);
      expect(result.replay_data).toBe(replay.replay_data);
      expect(result.lazerScoreInfo).toEqual(info);
      expect(result).toHaveProperty("unknown", 12345);
    } finally { await decoder.close(); }
  });

  it("rejects partial failed output and can decode the next independent block", async () => {
    const decoder = client();
    const bytes = Buffer.from("XQAAgAD//////////wAYHwJDUQO0DobDyTn5IJJWkGpkOWvy5Kz+6pym7elVp+Mjqv/2twgA", "base64");
    try {
      await expect(decoder.decode(bytes, { role: "score-info", maxOutputBytes: 20 })).rejects.toThrow("failed");
      expect(Buffer.from(await decoder.decode(bytes, { role: "frames", maxOutputBytes: 100 })).toString())
        .toBe("0|256|192|0,1000|256|192|1,-12345|0|0|42,");
    } finally { await decoder.close(); }
  });

  it("cancels an actual owned child without returning its partial result", async () => {
    const decoder = client();
    const controller = new AbortController();
    try {
      const pending = decoder.decode(Buffer.alloc(13), { role: "frames", maxOutputBytes: 100, signal: controller.signal });
      controller.abort(new Error("selection replaced"));
      await expect(pending).rejects.toThrow("selection replaced");
    } finally { await decoder.close(); }
  });
});
