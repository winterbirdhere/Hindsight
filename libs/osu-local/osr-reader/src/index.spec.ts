import { OsrReplay, read, readSync } from "./index";
import { compress } from "lzma";

function replayBuffer(gameVersion = 30_000_016): Buffer {
  const replay = new OsrReplay();
  replay.gameMode = 0;
  replay.gameVersion = gameVersion;
  replay.playerName = "Player".repeat(30); // exercise a multi-byte ULEB128 string length
  replay.beatmapMD5 = "beatmap-md5";
  replay.replayMD5 = "replay-md5";
  replay.mods = 64;
  replay.number_300s = 3;
  replay.max_combo = 3;
  replay.replay_data = "0|256|192|0,1000|256|192|1,-12345|0|0|42,";
  return replay.serializeSync();
}

function extraData(value: unknown): Buffer {
  const compressed = Buffer.from(compress(JSON.stringify(value)));
  const length = Buffer.alloc(4);
  length.writeInt32LE(compressed.length);
  return Buffer.concat([length, compressed]);
}

describe("lazer replay score-info extension", () => {
  it("preserves native mods/settings and other source metadata in sync and async reads", async () => {
    const scoreInfo = {
      online_id: 123,
      mods: [
        { acronym: "DT", settings: { speed_change: 1.2, adjust_pitch: false } },
        { acronym: "DA", settings: { circle_size: 4.3, approach_rate: 9.5 } },
        { acronym: "CL", settings: { no_slider_head_accuracy: false } },
        { acronym: "FUTURE", settings: { label: "設定", nested: { enabled: true } } },
      ],
      statistics: { great: 3 },
      maximum_statistics: { great: 3 },
      client_version: "2026.101.0",
    };
    const buffer = Buffer.concat([replayBuffer(), extraData(scoreInfo)]);

    for (const replay of [readSync(buffer), await read(buffer)]) {
      expect(replay.lazerScoreInfo).toEqual(scoreInfo);
      expect(replay.lazerMods).toEqual(scoreInfo.mods);
      expect(replay.mods).toBe(64);
      expect(replay.number_300s).toBe(3);
      expect(replay.replay_data).toContain("1000|256|192|1");
    }
  });

  it("preserves an authoritative empty native mod list and callback reads", async () => {
    const buffer = Buffer.concat([replayBuffer(), extraData({ mods: [] })]);
    const replay = await new Promise<OsrReplay>((resolve, reject) => {
      read(buffer, (error, result) => {
        if (error) reject(error);
        else resolve(result as OsrReplay);
      });
    });
    expect(replay.lazerMods).toEqual([]);
    expect(replay.mods).toBe(64);
  });

  it.each([20_260_904, 30_000_000])("retains the legacy format for version %i", async (version) => {
    const buffer = replayBuffer(version);
    expect(readSync(buffer).lazerMods).toBeUndefined();
    expect((await read(buffer)).lazerScoreInfo).toBeUndefined();
  });

  it.each([0, -1])("retains legacy fields for an empty/null native score byte array (%i)", async (length) => {
    const marker = Buffer.alloc(4);
    marker.writeInt32LE(length);
    const buffer = Buffer.concat([replayBuffer(), marker]);
    for (const replay of [readSync(buffer), await read(buffer)]) {
      expect(replay.lazerMods).toBeUndefined();
      expect(replay.mods).toBe(64);
      expect(replay.replay_data).toContain("1000|256|192|1");
    }
  });

  it("rejects truncated native metadata rather than pretending custom settings are absent", async () => {
    const buffer = Buffer.concat([replayBuffer(), extraData({ mods: [{ acronym: "HT" }] })]);
    const truncated = buffer.subarray(0, buffer.length - 1);
    expect(() => readSync(truncated)).toThrow("Truncated lazer replay score data");
    await expect(read(truncated)).rejects.toThrow("Truncated lazer replay score data");
  });

  it.each([{}, { mods: [null] }, { mods: [{ acronym: "" }] }, { mods: [{ acronym: "DA", settings: [] }] }])(
    "rejects an invalid native mod list: %p",
    async (scoreInfo) => {
      const buffer = Buffer.concat([replayBuffer(), extraData(scoreInfo)]);
      expect(() => readSync(buffer)).toThrow("Invalid lazer replay mod settings");
      await expect(read(buffer)).rejects.toThrow("Invalid lazer replay mod settings");
    },
  );
});
