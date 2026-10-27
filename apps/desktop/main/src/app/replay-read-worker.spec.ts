import { MessageChannel } from "worker_threads";
import { handleReplayRead } from "./replay-read-worker";
import { OsrReplay, read } from "@rewind/osu-local/osr-reader";
import { compress } from "lzma";
import { types } from "util";

function clone<T>(value: T): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  return new Promise(resolve => { port2.once("message", result => { port1.close(); port2.close(); resolve(result); }); port1.postMessage(value); });
}
it.each([20260904, 30000016])("preserves original reader fields through actual structured clone (%i)", async version => {
  const replay = new OsrReplay(); replay.gameVersion = version; replay.replay_data = "0|256|192|0,-12345|0|0|42,";
  let bytes = replay.serializeSync();
  if (version >= 30000001) { const data = Buffer.from(compress(JSON.stringify({ mods: [{ acronym: "DT", settings: { speed_change: 1.2 } }] }))); const size = Buffer.alloc(4); size.writeInt32LE(data.length); bytes = Buffer.concat([bytes, size, data]); }
  const before = Buffer.from(bytes), expected = await clone(await read(bytes));
  const result = await clone(await handleReplayRead({ id: 1, bytes: new Uint8Array(bytes) }));
  expect(result).toEqual({ id: 1, ok: true, replay: expected }); expect(bytes).toEqual(before);
  if (result.ok) expect(types.isDate(result.replay.timestamp)).toBe(true);
});
it("preserves original errors through structured clone without a parser fallback", async () => {
  const error = new TypeError("original malformed legacy input"), reader = jest.fn().mockRejectedValue(error);
  const result = await clone(await handleReplayRead({ id: 7, bytes: new Uint8Array() }, reader));
  expect(result.ok).toBe(false); if (!result.ok) { expect(types.isNativeError(result.error)).toBe(true); expect((result.error as Error).name).toBe("TypeError"); expect((result.error as Error).message).toBe(error.message); } expect(reader).toHaveBeenCalledTimes(1);
});
