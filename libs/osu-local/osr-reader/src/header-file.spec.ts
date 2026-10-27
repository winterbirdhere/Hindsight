import { open } from "fs/promises";
import { readReplayHeader } from "./header";

jest.mock("fs/promises", () => ({ open: jest.fn() }));

function fileFixture(shortRead = false) {
  const version = Buffer.alloc(5); version.writeInt32LE(20260904, 1);
  const bytes = Buffer.concat([version, Buffer.from([11, 32]), Buffer.from("a".repeat(32)),
    Buffer.from([11, 184, 23]), Buffer.from("P".repeat(3000)), Buffer.from([0]), Buffer.alloc(23), Buffer.from([0]), Buffer.alloc(12)]);
  const stamp = { isFile: () => true, size: BigInt(bytes.length), mtimeNs: BigInt(1), ctimeNs: BigInt(2) };
  const handle = {
    stat: jest.fn().mockResolvedValue(stamp), close: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = bytes.copy(buffer, offset, position, position + (shortRead ? Math.min(211, length) : length));
      return { bytesRead };
    }),
  };
  (open as jest.Mock).mockResolvedValue(handle);
  return { bytes, handle, stamp };
}

beforeEach(() => jest.clearAllMocks());

it.each([false, true])("grows bounded reads and handles short positive reads (%s)", async (short) => {
  const { handle } = fileFixture(short);
  expect((await readReplayHeader("source.osr")).player).toHaveLength(3000);
  expect(handle.read.mock.calls.length).toBeGreaterThan(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
});

it("closes after premature EOF and source changes instead of returning mixed observations", async () => {
  const incomplete = fileFixture();
  incomplete.handle.read.mockResolvedValueOnce({ bytesRead: 0 });
  await expect(readReplayHeader("source.osr")).rejects.toThrow(/truncated/i);
  expect(incomplete.handle.close).toHaveBeenCalledTimes(1);
  const changed = fileFixture();
  changed.handle.stat.mockResolvedValueOnce(changed.stamp).mockResolvedValue({ ...changed.stamp, mtimeNs: BigInt(3) });
  await expect(readReplayHeader("source.osr")).rejects.toThrow(/changed/i);
  expect(changed.handle.close).toHaveBeenCalledTimes(1);
});

it("closes on cancellation after opening and does not keep reading", async () => {
  const { handle } = fileFixture();
  const abort = new AbortController();
  handle.read.mockImplementationOnce(async () => { abort.abort(); return { bytesRead: 1 }; });
  await expect(readReplayHeader("source.osr", abort.signal)).rejects.toThrow(/abort/i);
  expect(handle.read).toHaveBeenCalledTimes(1);
  expect(handle.close).toHaveBeenCalledTimes(1);
});
