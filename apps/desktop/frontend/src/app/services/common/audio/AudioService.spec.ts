import { readFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { AudioService, disposeLoadedAudio } from "./AudioService";
import { ViewerLifecycleObserver } from "../ViewerLifecycleObserver";

jest.mock("fs/promises", () => ({ readFile: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function decodedAudio(): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate: 48000,
    length: 4,
    duration: 4 / 48000,
    copyFromChannel: jest.fn(),
    copyToChannel: jest.fn(),
    getChannelData: () => new Float32Array([0.75, -0.25, 0, 0.5]),
  } as AudioBuffer;
}

describe("accurately seekable song loading", () => {
  const originalAudio = globalThis.Audio;
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const fileUrl = pathToFileURL(resolve("audio-fixtures", "song # %23.mp3")).href;
  let audios: HTMLAudioElement[];
  let createObjectURL: jest.Mock;
  let revokeObjectURL: jest.Mock;
  let decodeAudioData: jest.Mock;
  let service: AudioService;

  beforeEach(() => {
    audios = [];
    let urls = 0;
    createObjectURL = jest.fn(() => `blob:decoded-song-${++urls}`);
    revokeObjectURL = jest.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: jest.fn(() => {
        const audio = document.createElement("audio");
        Object.defineProperty(audio, "duration", { configurable: true, writable: true, value: 4 / 48000 });
        audios.push(audio);
        return audio;
      }),
    });
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    (readFile as jest.Mock).mockResolvedValue(Buffer.from([9, 8, 1, 2, 3, 7]).subarray(2, 5));
    decodeAudioData = jest.fn().mockResolvedValue(decodedAudio());
    service = new AudioService({ decodeAudioData } as never);
  });

  afterEach(() => {
    service.cancelPendingLoads();
    for (const audio of audios) disposeLoadedAudio(audio);
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Object.defineProperty(globalThis, "Audio", { configurable: true, value: originalAudio });
    if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
    else delete (URL as unknown as Record<string, unknown>).createObjectURL;
    if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it("journals owned media release once and records failed decoding without leaking names", async () => {
    const events: Array<{ kind: string; fields: Readonly<Record<string, unknown>> }> = [];
    Object.assign(service, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
      record: (kind, _owner, fields) => events.push({ kind, fields }), count: () => undefined, invalidate: () => undefined }) });
    const loading = service.loadAudio(fileUrl);
    await flushMicrotasks(); audios[0].dispatchEvent(new Event("loadedmetadata"));
    const audio = await loading;
    disposeLoadedAudio(audio); disposeLoadedAudio(audio);
    const failure = new Error("invalid codec"); decodeAudioData.mockRejectedValueOnce(failure);
    await expect(service.loadAudio(fileUrl)).rejects.toBe(failure);
    expect(events.filter(event => event.kind === "audio-load-attempt")).toHaveLength(2);
    expect(events.filter(event => event.kind === "audio-load-settled")).toHaveLength(2);
    expect(events.filter(event => event.kind === "audio-media-created")).toHaveLength(1);
    expect(events.filter(event => event.kind === "audio-media-released")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(fileUrl);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not report media cleanup success when pause fails, while preserving the original revoke and exception", async () => {
    const events: string[] = [];
    Object.assign(service, { lifecycle: new ViewerLifecycleObserver({ id: () => 1,
      record: kind => events.push(kind), count: () => undefined, invalidate: () => undefined }) });
    const loading = service.loadAudio(fileUrl);
    await flushMicrotasks(); audios[0].dispatchEvent(new Event("loadedmetadata"));
    const audio = await loading, failure = new Error("media pause failed");
    jest.mocked(audio.pause).mockImplementationOnce(() => { throw failure; });
    expect(() => disposeLoadedAudio(audio)).toThrow(failure);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute("src")).not.toBeNull();
    expect(events.filter(kind => kind === "audio-media-release-attempt")).toHaveLength(1);
    expect(events.filter(kind => kind === "audio-media-released")).toHaveLength(0);
  });

  it("fully decodes the exact file bytes and gives media playback a PCM source instead of an MP3 seek target", async () => {
    const loading = service.loadAudio(fileUrl);
    await flushMicrotasks();
    expect(readFile).toHaveBeenCalledWith(fileURLToPath(fileUrl), { signal: expect.any(AbortSignal) });
    expect(new Uint8Array(decodeAudioData.mock.calls[0][0])).toEqual(new Uint8Array([1, 2, 3]));
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: "audio/wav" }));
    expect(audios[0].src).toBe("blob:decoded-song-1");
    expect(audios[0].preload).toBe("auto");
    audios[0].dispatchEvent(new Event("loadedmetadata"));
    expect(await loading).toBe(audios[0]);
    expect(audios[0].duration).toBe(4 / 48000);
    service.cancelPendingLoads();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("loads verified resource bytes through the existing PCM ownership path without reopening a file", async () => {
    const reader = jest.fn(async (_signal: AbortSignal) => Uint8Array.from([9, 8, 7]));
    const loading = service.loadAudioResource("native-song.mp3", reader);
    await flushMicrotasks(); expect(readFile).not.toHaveBeenCalled();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(decodeAudioData.mock.calls[0][0])).toEqual(Uint8Array.from([9, 8, 7]));
    audios[0].dispatchEvent(new Event("loadedmetadata")); const audio = await loading;
    disposeLoadedAudio(audio); expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("shares one decode queue between files and native resources and propagates cancellation to their reader", async () => {
    const oldDecode = deferred<AudioBuffer>(); decodeAudioData.mockReturnValueOnce(oldDecode.promise);
    const first = service.loadAudio(fileUrl); const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    let signal: AbortSignal | undefined;
    const reader = jest.fn(async (input: AbortSignal) => { signal = input; return Uint8Array.from([4, 5]); });
    const second = service.loadAudioResource("native-song.mp3", reader);
    const secondCancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks(); expect(reader).not.toHaveBeenCalled(); expect(decodeAudioData).toHaveBeenCalledTimes(1);
    oldDecode.resolve(decodedAudio()); await cancelled; await flushMicrotasks();
    expect(reader).toHaveBeenCalledTimes(1); service.cancelPendingLoads(); expect(signal?.aborted).toBe(true);
    await secondCancelled;
  });

  it("releases an owned Blob exactly once and leaves foreign audio alone", async () => {
    const loading = service.loadAudio(fileUrl);
    await flushMicrotasks();
    audios[0].dispatchEvent(new Event("loadedmetadata"));
    const audio = await loading;
    disposeLoadedAudio(audio);
    disposeLoadedAudio(audio);
    disposeLoadedAudio({ duration: 120 } as HTMLAudioElement);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:decoded-song-1");
  });

  it.each(["error", "invalid-duration"])("releases a failed PCM media load (%s)", async (failure) => {
    const loading = service.loadAudio(fileUrl);
    const rejection = expect(loading).rejects.toThrow(
      failure === "error" ? "Could not load decoded" : "invalid duration",
    );
    await flushMicrotasks();
    if (failure === "invalid-duration") Object.defineProperty(audios[0], "duration", { value: NaN });
    audios[0].dispatchEvent(new Event(failure === "error" ? "error" : "loadedmetadata"));
    await rejection;
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:decoded-song-1");
    expect(audios[0].hasAttribute("src")).toBe(false);
  });

  it("discards a stale decode without allocating its Blob and serializes the replacement decode", async () => {
    const oldDecode = deferred<AudioBuffer>();
    decodeAudioData.mockReturnValueOnce(oldDecode.promise);
    const first = service.loadAudio(fileUrl);
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    const second = service.loadAudio(fileUrl);
    await flushMicrotasks();
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    oldDecode.resolve(decodedAudio());
    await cancelled;
    await flushMicrotasks();
    expect(decodeAudioData).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    audios[0].dispatchEvent(new Event("loadedmetadata"));
    expect(await second).toBe(audios[0]);
  });

  it("cancels an in-flight metadata load, revokes its Blob, and ignores late events", async () => {
    const loading = service.loadAudio(fileUrl);
    const cancelled = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    service.cancelPendingLoads();
    await cancelled;
    audios[0].dispatchEvent(new Event("loadedmetadata"));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(audios[0].hasAttribute("src")).toBe(false);
  });

  it("cancels a file read and does not decode bytes that arrive after cancellation", async () => {
    const reading = deferred<Buffer>();
    (readFile as jest.Mock).mockReturnValueOnce(reading.promise);
    const loading = service.loadAudio(fileUrl);
    const cancelled = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    await flushMicrotasks();
    const signal: AbortSignal = (readFile as jest.Mock).mock.calls[0][1].signal;
    service.cancelPendingLoads();
    expect(signal.aborted).toBe(true);
    reading.resolve(Buffer.from([1, 2, 3]));
    await cancelled;
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("surfaces decode errors and allows a later load without silently falling back to MP3", async () => {
    decodeAudioData.mockRejectedValueOnce(new Error("Unsupported song codec"));
    await expect(service.loadAudio(fileUrl)).rejects.toThrow("Unsupported song codec");
    expect(audios).toHaveLength(0);
    const loading = service.loadAudio(fileUrl);
    await flushMicrotasks();
    audios[0].dispatchEvent(new Event("loadedmetadata"));
    await expect(loading).resolves.toBe(audios[0]);
    expect(audios[0].src).toBe("blob:decoded-song-1");
  });
});
