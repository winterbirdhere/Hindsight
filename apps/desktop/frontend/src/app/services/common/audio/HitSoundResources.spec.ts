import { Beatmap, HitSampleInfo } from "@osujs/core";
import { BehaviorSubject } from "rxjs";
import { access, readFile } from "fs/promises";
import { resolve } from "path";
import { HitSoundEngine } from "./HitSoundEngine";

jest.mock("fs/promises", () => ({ access: jest.fn(), readFile: jest.fn() }));
function fixture() {
  const decode = jest.fn(async (_data: ArrayBuffer) => ({} as AudioBuffer));
  const engine = new HitSoundEngine({ replayEvents$: new BehaviorSubject([]), getPrimaryReplay: () => undefined } as never,
    { isPlaying: false, timeElapsedInMs: 0 } as never, { stopSamples: jest.fn() } as never,
    { resolveToPath: (skin: { name: string }) => resolve("skins", skin.name) } as never,
    { settings: { preferredSkinId: "rewind:Fixture" } } as never, { decodeAudioData: decode } as never);
  const load = (sample: HitSampleInfo) => (engine as unknown as { loadSample(sample: HitSampleInfo): Promise<unknown> }).loadSample(sample);
  return { engine, decode, load };
}
beforeEach(() => { jest.clearAllMocks(); (access as jest.Mock).mockResolvedValue(undefined); (readFile as jest.Mock).mockResolvedValue(Buffer.from([9])); });

it("reads verified custom bytes without filesystem lookup and keeps custom missing separate from skin fallback", async () => {
  const f = fixture(), read = jest.fn(async (name: string) => name === "sample.wav" ? Uint8Array.from([1, 2]) : undefined);
  await f.engine.configureResources(Beatmap.EMPTY_BEATMAP, read);
  expect(await f.load(new HitSampleInfo("hitnormal", "normal", null, 70, "sample.wav"))).toMatchObject({ volume: .7 });
  expect(new Uint8Array(f.decode.mock.calls[0][0])).toEqual(Uint8Array.from([1, 2]));
  expect(await f.load(new HitSampleInfo("hitnormal", "normal", null, 70, "missing.wav"))).toBeNull();
  expect(access).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
});

it("uses the map override extension order, then skins, and skips map probes for default samples", async () => {
  const f = fixture(), read = jest.fn(async (_name: string) => undefined);
  await f.engine.configureResources(Beatmap.EMPTY_BEATMAP, read);
  await f.load(new HitSampleInfo("hitnormal", "normal", "2", 100, null, 2));
  expect(read.mock.calls.map(call => call[0])).toEqual(["normal-hitnormal2.wav", "normal-hitnormal2.ogg", "normal-hitnormal2.mp3", "hitnormal2.wav", "hitnormal2.ogg", "hitnormal2.mp3"]);
  expect(readFile).toHaveBeenCalledTimes(1);
  read.mockClear(); await f.load(new HitSampleInfo("hitnormal", "normal", null, 100)); expect(read).not.toHaveBeenCalled();
});

it("propagates verification failures without selecting another asset and drops a late decode after clear", async () => {
  const f = fixture(), read = jest.fn(async () => { throw new Error("SHA mismatch"); });
  await f.engine.configureResources(Beatmap.EMPTY_BEATMAP, read);
  await expect(f.load(new HitSampleInfo("hitnormal", "normal", null, 100, "sample.wav"))).rejects.toThrow("SHA mismatch");
  expect(readFile).not.toHaveBeenCalled();
  let finish!: (value: AudioBuffer) => void;
  f.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.engine.configureResources(Beatmap.EMPTY_BEATMAP, async () => Uint8Array.from([1]));
  const pending = f.load(new HitSampleInfo("hitnormal", "normal", null, 100, "sample.wav"));
  while (!finish) await Promise.resolve();
  f.engine.clear(); finish({} as AudioBuffer); expect(await pending).toBeNull();
});
