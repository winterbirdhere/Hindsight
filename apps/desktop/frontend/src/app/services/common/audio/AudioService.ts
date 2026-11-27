import { inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../ViewerLifecycleObserver";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { STAGE_TYPES } from "../../types";
import { AudioContextLike } from "./AudioContextLike";
import { createPcmWaveBlob } from "./PcmWave";

interface LoadedAudioOwnership {
  url: string;
  cancelLoading?: () => void;
  lifecycle?: ViewerLifecycleObserver;
}

const loadedAudios = new WeakMap<HTMLMediaElement, LoadedAudioOwnership>();

function cancelledLoad(): Error {
  const error = new Error("Song audio loading was cancelled");
  error.name = "AbortError";
  return error;
}

/** Releases only audio owned by this loader; safe for repeated or stale cleanup. */
export function disposeLoadedAudio(audio: HTMLMediaElement): void {
  const ownership = loadedAudios.get(audio);
  if (!ownership) return;
  loadedAudios.delete(audio);
  ownership.lifecycle?.record("audio-media-release-attempt", audio);
  ownership.cancelLoading?.();
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } finally {
    URL.revokeObjectURL(ownership.url);
  }
  ownership.lifecycle?.record("audio-media-released", audio);
}

function loadPcmAudio(blob: Blob, filePath: string, signal: AbortSignal, lifecycle: ViewerLifecycleObserver): Promise<HTMLAudioElement> {
  const audio = new Audio();
  if (lifecycle.enabled) lifecycle.record("audio-media-created", audio);
  audio.preload = "auto";
  const ownership: LoadedAudioOwnership = { url: URL.createObjectURL(blob) };
  if (lifecycle.enabled) ownership.lifecycle = lifecycle;
  loadedAudios.set(audio, ownership);
  return new Promise<HTMLAudioElement>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
      ownership.cancelLoading = undefined;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      disposeLoadedAudio(audio);
      reject(error);
    };
    const handleLoadedMetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        fail(new Error(`Decoded audio has an invalid duration for '${filePath}'`));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(audio);
    };
    const handleError = () => fail(new Error(`Could not load decoded song audio from '${filePath}'`));
    const handleAbort = () => fail(cancelledLoad());
    ownership.cancelLoading = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cancelledLoad());
    };
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("error", handleError);
    signal.addEventListener("abort", handleAbort);
    if (signal.aborted) {
      handleAbort();
      return;
    }
    try {
      audio.src = ownership.url;
      audio.load();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

@injectable()
export class AudioService {
  private pendingLoad?: AbortController;
  private loadQueue: Promise<void> = Promise.resolve();
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(@inject(STAGE_TYPES.AUDIO_CONTEXT) private readonly audioContext: AudioContextLike,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    if (this.lifecycle.enabled) this.lifecycle.record("audio-service-created", this, { contextId: this.lifecycle.id(audioContext) });
  }

  cancelPendingLoads(): void {
    this.pendingLoad?.abort();
    this.pendingLoad = undefined;
  }

  loadAudio(filePath: string): Promise<HTMLAudioElement> {
    return this.loadAudioResource(filePath, signal => readFile(fileURLToPath(filePath), { signal }));
  }

  /** Consume the verified resource bytes through the same serialized decoder and PCM lifetime. */
  loadAudioResource(name: string, read: (signal: AbortSignal) => Promise<Uint8Array>): Promise<HTMLAudioElement> {
    if (this.lifecycle.enabled) this.lifecycle.record("audio-load-attempt", this);
    this.cancelPendingLoads();
    const controller = new AbortController();
    this.pendingLoad = controller;
    const { signal } = controller;
    const checkCurrent = () => {
      if (signal.aborted) throw cancelledLoad();
    };
    // decodeAudioData cannot be interrupted. Serialize jobs so rapid replay
    // changes cannot retain several full decoded songs concurrently.
    const load = this.loadQueue
      .then(async () => {
        checkCurrent();
        const bytes = await read(signal);
        checkCurrent();
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (this.lifecycle.enabled) this.lifecycle.record("audio-decode-attempt", this);
        let decoded: AudioBuffer | undefined = await this.audioContext.decodeAudioData(data as ArrayBuffer);
        if (this.lifecycle.enabled) this.lifecycle.record("audio-decoded", this);
        checkCurrent();
        const wave = createPcmWaveBlob(decoded);
        decoded = undefined;
        const audio = await loadPcmAudio(wave, name, signal, this.lifecycle);
        if (signal.aborted) {
          disposeLoadedAudio(audio);
          throw cancelledLoad();
        }
        return audio;
      })
      .finally(() => {
        if (this.pendingLoad === controller) this.pendingLoad = undefined;
        if (this.lifecycle.enabled) this.lifecycle.record("audio-load-settled", this, { cancelled: signal.aborted });
      });
    this.loadQueue = load.then(
      () => undefined,
      () => undefined,
    );
    return load;
  }
}
