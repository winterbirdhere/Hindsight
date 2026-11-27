import { inject, injectable, optional, postConstruct } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../ViewerLifecycleObserver";
import { AudioSettings, AudioSettingsStore } from "./settings";
import { STAGE_TYPES } from "../../types";
import { GameplayClock } from "../game/GameplayClock";
import { AudioContextLike } from "./AudioContextLike";
import { AudioPresentationClock } from "./AudioPresentationClock";
import { disposeLoadedAudio } from "./AudioService";

export interface AudioCaptureSession {
  stream?: MediaStream;
  dispose(): void;
}

// HTML5 Audio supports time stretching without pitch changing (otherwise sounds like night core)
// Decoded PCM keeps HTML audio's pitch-preserving speed changes and accurate seeks.
// Audio cues follow its input position; graphics follow the destination's output clock.

// "AudioEngine"
@injectable()
export class AudioEngine {
  // Just like in osu!, we can change the volume of music and samples separately
  musicGain: GainNode;
  samplesGain: GainNode;
  masterGain: GainNode;

  musicUrl?: string;
  musicBuffer?: AudioBuffer;

  song?: MediaElementAudioSourceNode;
  private readonly presentationClock = new AudioPresentationClock();
  private captureSession?: AudioCaptureSession;
  private deferredAudioSettings?: AudioSettings;
  private silentTail?: { timeInMs: number; contextTime: number; rate: number };
  private readonly handleSongEnded = () => {
    // The media input can finish while its last samples are still queued at
    // the output. Keep ticking until those samples have reached presentation.
    const endTime = this.currentTime();
    if (!this.silentTail && this.gameClock.isPlaying) this.beginSilentTail(endTime);
    if (endTime > 0 && Number.isFinite(endTime)) this.gameClock.setDuration(endTime);
    if (this.presentationTime() >= this.gameClock.durationInMs) this.gameClock.pause();
  };
  private readonly handleSongDurationChanged = () => {
    const duration = this.durationInMs;
    if (Number.isFinite(duration) && duration > 0) this.gameClock.setDuration(duration);
  };
  private activeSamples = new Map<AudioBufferSourceNode, GainNode>();
  private loopingSamples = new Map<string, AudioBufferSourceNode>();

  // In seconds
  sampleWindow = 0.1;
  schedulePointer = 0;
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(
    private readonly audioSettingService: AudioSettingsStore,
    @inject(STAGE_TYPES.AUDIO_CONTEXT) private readonly audioContext: AudioContextLike,
    private readonly gameClock: GameplayClock,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver,
  ) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    this.masterGain = this.audioContext.createGain();
    this.musicGain = this.audioContext.createGain();
    this.musicGain.connect(this.masterGain);
    this.samplesGain = this.audioContext.createGain();
    this.samplesGain.connect(this.masterGain);
    this.masterGain.connect(this.audioContext.destination);
    if (this.lifecycle.enabled) this.lifecycle.record("audio-engine-created", this, {
      contextId: this.lifecycle.id(audioContext), masterGainId: this.lifecycle.id(this.masterGain),
      musicGainId: this.lifecycle.id(this.musicGain), samplesGainId: this.lifecycle.id(this.samplesGain),
    });

    // this.handleAudioSettingsChanged(this.audioSettingService.getSettings());
  }

  @postConstruct()
  postConstruct() {
    console.log("Initializing AudioEngine");
    this.setupListeners();
  }

  // async loadSong(songUrl: string) {
  //   // Disconnect other one?
  //   const audio = new HTMLAudioElement();
  //   audio.crossOrigin = "anonymous";
  //   audio.src = songUrl;
  //   this.song = this.audioContext.createMediaElementSource(audio);
  //   this.song.connect(this.musicGain);
  // }
  //
  setSong(audio: HTMLAudioElement) {
    if (this.lifecycle.enabled) this.lifecycle.record("audio-song-attempt", this, { mediaId: this.lifecycle.id(audio) });
    this.destroy();
    this.song = this.audioContext.createMediaElementSource(audio);
    if (this.lifecycle.enabled) this.lifecycle.record("audio-source-created", this, { sourceId: this.lifecycle.id(this.song), mediaId: this.lifecycle.id(audio) });
    this.song.connect(this.musicGain);
    audio.addEventListener("ended", this.handleSongEnded);
    audio.addEventListener("durationchange", this.handleSongDurationChanged);
    this.changePlaybackRate(this.gameClock.playbackRate);
    this.seekTo(this.gameClock.timeElapsedInMs);
    this.gameClock.setTimeSource(() => this.presentationTime());
    if (this.gameClock.isPlaying) this.start();
  }

  setupListeners() {
    this.gameClock.seeked$.subscribe(this.seekTo.bind(this));
    this.gameClock.isPlaying$.subscribe((isPlaying: boolean) => {
      if (isPlaying) this.start();
      else this.pause();
    });
    this.gameClock.playbackRate$.subscribe(this.changePlaybackRate.bind(this));

    this.audioSettingService.settings$.subscribe((value) => this.handleAudioSettingsChanged(value));
  }

  start() {
    const song = this.song;
    if (!song) return;
    if (this.silentTail) this.beginSilentTail(this.gameClock.timeElapsedInMs);
    void Promise.all([
      this.audioContext.resume(),
      this.silentTail ? Promise.resolve() : song.mediaElement.play(),
    ]).catch((error) => {
      if (this.song !== song || !this.gameClock.isPlaying) return;
      console.warn("Could not start song playback", error);
      this.gameClock.pause();
    });
  }

  pause() {
    if (this.song) {
      this.song.mediaElement.pause();
      this.schedulePointer = 0;
      // Freeze the displayed position, then restart music and cues from that
      // same point on resume instead of jumping over queued audio.
      if (Math.abs(this.currentTime() - this.gameClock.timeElapsedInMs) > 0.001) {
        this.gameClock.seekTo(this.gameClock.timeElapsedInMs);
      } else {
        this.presentationClock.reset(this.gameClock.timeElapsedInMs);
      }
    }
    this.stopSamples();
  }

  changePlaybackRate(newPlaybackRate: number) {
    if (this.silentTail) this.beginSilentTail(this.inputTime(), newPlaybackRate);
    if (this.song) {
      this.song.mediaElement.playbackRate = newPlaybackRate;
    }
  }

  currentTime() {
    return (this.song?.mediaElement.currentTime ?? 0) * 1000;
  }

  /** Music input time for samples that will enter the same audio output queue. */
  cueTime() {
    return this.song && this.gameClock.isPlaying ? this.inputTime() : this.gameClock.timeElapsedInMs;
  }

  private beginSilentTail(timeInMs: number, rate = this.gameClock.playbackRate) {
    this.silentTail = { timeInMs, contextTime: this.audioContext.currentTime, rate };
  }

  private inputTime() {
    if (!this.silentTail) return this.currentTime();
    if (!this.gameClock.isPlaying) return this.gameClock.timeElapsedInMs;
    return (
      this.silentTail.timeInMs +
      Math.max(0, this.audioContext.currentTime - this.silentTail.contextTime) * this.silentTail.rate * 1000
    );
  }

  private presentationTime() {
    if (!this.song) return this.gameClock.timeElapsedInMs;
    let outputTimestamp: AudioTimestamp | undefined;
    try {
      outputTimestamp = this.audioContext.getOutputTimestamp?.();
    } catch {
      // A changing output device can temporarily make its timestamp unavailable.
    }
    return this.presentationClock.read({
      mediaTimeInMs: this.inputTime(),
      contextTime: this.audioContext.currentTime,
      // A MediaStreamDestination records at the graph, before the physical
      // device queue. Its video must use that same clock during capture.
      outputTimestamp: this.captureSession
        ? { contextTime: this.audioContext.currentTime, performanceTime: performance.now() }
        : outputTimestamp,
      performanceTime: performance.now(),
      playbackRate: this.gameClock.playbackRate,
      isPlaying: this.gameClock.isPlaying,
      isSeeking: !this.silentTail && this.song.mediaElement.seeking,
      isInputStopped:
        !this.silentTail &&
        (this.song.mediaElement.paused || this.song.mediaElement.ended || this.song.mediaElement.readyState < 3),
      baseLatency: this.captureSession ? 0 : this.audioContext.baseLatency,
      outputLatency: this.captureSession ? 0 : this.audioContext.outputLatency,
      contextState: this.audioContext.state,
    });
  }

  seekTo(toInMs: number) {
    this.presentationClock.reset(toInMs);
    if (this.song) {
      const duration = this.durationInMs;
      const beyondMusic = Number.isFinite(duration) && toInMs >= duration;
      const wasSilent = this.silentTail !== undefined;
      this.silentTail = undefined;
      this.song.mediaElement.currentTime = Math.min(toInMs, Number.isFinite(duration) ? duration : toInMs) / 1000;
      if (beyondMusic) {
        this.song.mediaElement.pause();
        this.beginSilentTail(toInMs);
      } else if (wasSilent && this.gameClock.isPlaying) {
        this.start();
      }
    }
  }

  get isPlaying() {
    return Boolean(this.song) && this.gameClock.isPlaying;
  }

  togglePlaying(): boolean {
    this.gameClock.toggle();
    return this.isPlaying;
  }

  get durationInMs() {
    return (this.song?.mediaElement.duration ?? 1) * 1000;
  }

  /** Owns only an extra output of the existing mix; never opens an input device. */
  beginCapture(includeAudio: boolean): AudioCaptureSession {
    if (this.captureSession) throw new Error("An audio capture is already active");
    if (this.gameClock.isPlaying) throw new Error("Pause playback before preparing audio capture");
    const destination = includeAudio ? this.audioContext.createMediaStreamDestination?.() : undefined;
    if (includeAudio && !destination) throw new Error("Audio recording is unavailable in this runtime");
    if (destination) this.masterGain.connect(destination);
    let disposed = false;
    const session: AudioCaptureSession = {
      stream: destination?.stream,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (destination) {
          try {
            this.masterGain.disconnect(destination);
          } catch (error) {
            console.warn("Could not disconnect the clip audio tap", error);
          }
          destination.stream.getTracks().forEach((track) => {
            try {
              track.stop();
            } catch (error) {
              console.warn("Could not release a clip audio track", error);
            }
          });
        }
        if (this.captureSession === session) this.captureSession = undefined;
        this.presentationClock.reset(this.gameClock.timeElapsedInMs);
        const settings = this.deferredAudioSettings;
        this.deferredAudioSettings = undefined;
        if (settings) this.handleAudioSettingsChanged(settings);
      },
    };
    this.captureSession = session;
    this.presentationClock.reset(this.gameClock.timeElapsedInMs);
    return session;
  }

  /** Wait for an explicit seek to settle before starting a recording. */
  async prepareCapture(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Clip export cancelled");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("Clip export cancelled"));
      const timer = setTimeout(() => finish(new Error("Timed out while starting the audio device")), 10_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else
        Promise.resolve()
          .then(() => this.audioContext.resume())
          .then(() => finish(), finish);
    });
    if (signal.aborted) throw new Error("Clip export cancelled");
    const song = this.song;
    if (!song || this.silentTail) return;
    const media = song.mediaElement;
    if (!media.seeking && media.readyState >= 3) return;
    await new Promise<void>((resolve, reject) => {
      const events = ["seeked", "canplay", "error", "emptied"];
      const finish = (error?: Error) => {
        clearTimeout(timer);
        events.forEach((event) => media.removeEventListener(event, check));
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("Clip export cancelled"));
      const check = () => {
        if (this.song !== song || media.error) finish(new Error("The clip audio became unavailable"));
        else if (!media.seeking && media.readyState >= 3) finish();
      };
      const timer = setTimeout(() => finish(new Error("Timed out while preparing clip audio")), 10_000);
      events.forEach((event) => media.addEventListener(event, check));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }

  destroy() {
    if (this.lifecycle.enabled) this.lifecycle.record("audio-destroy-attempt", this, { sourceId: this.lifecycle.id(this.song) });
    this.captureSession?.dispose();
    this.gameClock.setTimeSource(undefined);
    this.stopSamples();
    if (this.song) {
      this.song.mediaElement.removeEventListener("ended", this.handleSongEnded);
      this.song.mediaElement.removeEventListener("durationchange", this.handleSongDurationChanged);
      this.song.mediaElement.pause();
      this.song.disconnect();
      disposeLoadedAudio(this.song.mediaElement as HTMLAudioElement);
      if (this.lifecycle.enabled) this.lifecycle.record("audio-source-released", this, { sourceId: this.lifecycle.id(this.song), mediaId: this.lifecycle.id(this.song.mediaElement) });
      this.song = undefined;
    }
    this.presentationClock.reset(this.gameClock.timeElapsedInMs);
    this.silentTail = undefined;
    // this.pause();
    // this.audioContext.close().then(() => {
    //   console.log("Audio context closed.");
    // });
  }

  playSample(buffer: AudioBuffer, volume = 1, playbackRate = 1): void {
    this.startSample(buffer, volume, playbackRate);
  }

  playLoopingSample(id: string, buffer: AudioBuffer, volume = 1, playbackRate = 1, fadeInMs = 0): void {
    if (this.loopingSamples.has(id)) return;
    this.startSample(buffer, volume, playbackRate, id, fadeInMs);
  }

  stopLoopingSample(id: string, fadeOutMs = 0): void {
    const source = this.loopingSamples.get(id);
    if (!source) return;
    if (fadeOutMs <= 0) {
      this.stopSampleSource(source);
      return;
    }

    const gain = this.activeSamples.get(source);
    if (!gain) return;
    const now = this.audioContext.currentTime;
    const duration = fadeOutMs / 1000;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);
    this.loopingSamples.delete(id);
    source.stop(now + duration);
  }

  setLoopingSamplePlaybackRate(id: string, playbackRate: number): void {
    const source = this.loopingSamples.get(id);
    if (source) source.playbackRate.value = Math.max(0.01, playbackRate);
  }

  private startSample(buffer: AudioBuffer, volume: number, playbackRate: number, loopId?: string, fadeInMs = 0): void {
    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    const targetVolume = Math.max(0, Math.min(1, volume));
    source.buffer = buffer;
    source.playbackRate.value = Math.max(0.01, playbackRate);
    source.loop = loopId !== undefined;
    if (fadeInMs > 0) {
      const now = this.audioContext.currentTime;
      gain.gain.setValueAtTime(0, now);
      // osu!'s spinner sample uses an OutQuint fade. A value curve keeps the
      // same shape in Web Audio instead of approximating it with a hard start.
      const curve = new Float32Array(32);
      for (let index = 0; index < curve.length; index++) {
        const progress = index / (curve.length - 1);
        curve[index] = targetVolume * (1 - Math.pow(1 - progress, 5));
      }
      gain.gain.setValueCurveAtTime(curve, now, fadeInMs / 1000);
    } else {
      gain.gain.value = targetVolume;
    }
    source.connect(gain);
    gain.connect(this.samplesGain);
    this.activeSamples.set(source, gain);
    if (loopId !== undefined) this.loopingSamples.set(loopId, source);
    source.onended = () => {
      this.releaseSampleSource(source, loopId);
    };
    source.start();
  }

  private releaseSampleSource(source: AudioBufferSourceNode, loopId?: string): void {
    const gain = this.activeSamples.get(source);
    this.activeSamples.delete(source);
    if (loopId !== undefined && this.loopingSamples.get(loopId) === source) this.loopingSamples.delete(loopId);
    source.disconnect();
    gain?.disconnect();
  }

  private stopSampleSource(source: AudioBufferSourceNode): void {
    const gain = this.activeSamples.get(source);
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A source may have naturally ended between lookup and stop().
    }
    this.activeSamples.delete(source);
    for (const [id, loopingSource] of this.loopingSamples) {
      if (loopingSource === source) this.loopingSamples.delete(id);
    }
    source.disconnect();
    gain?.disconnect();
  }

  stopSamples(): void {
    for (const source of Array.from(this.activeSamples.keys())) this.stopSampleSource(source);
    this.activeSamples.clear();
    this.loopingSamples.clear();
  }

  private handleAudioSettingsChanged(settings: AudioSettings) {
    if (this.captureSession) {
      this.deferredAudioSettings = settings;
      return;
    }
    const { muted, volume } = settings;
    this.masterGain.gain.value = muted ? 0 : volume.master;
    this.musicGain.gain.value = volume.music;
    this.samplesGain.gain.value = volume.effects;
  }
}
