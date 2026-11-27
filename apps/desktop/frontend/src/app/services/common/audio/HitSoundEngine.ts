import {
  Beatmap,
  GameState,
  HitSampleInfo,
  isSlider,
  isSpinner,
  ReplayAnalysisEvent,
  ReplayAnalysisRuleset,
  spinnerBonusProgress,
  spinnerProgressForState,
} from "@osujs/core";
import { inject, injectable, postConstruct } from "inversify";
import { access, readFile } from "fs/promises";
import { constants } from "fs";
import { extname, isAbsolute, resolve } from "path";
import { GameSimulator } from "../game/GameSimulator";
import { GameplayClock } from "../game/GameplayClock";
import { AudioEngine } from "./AudioEngine";
import { SkinLoader } from "../local/SkinLoader";
import { SkinHolder, SkinSettingsStore } from "../skin";
import { stringToSkinId } from "../../../model/SkinId";
import { STAGE_TYPES } from "../../types";
import { buildHitSoundCues, buildStoryboardPlaybackStateResolver, HitSoundCue } from "./hit-sound-cues";
import { AudioContextLike } from "./AudioContextLike";

interface PreparedSample {
  buffer: AudioBuffer;
  volume: number;
}

interface PreparedHitSoundCue extends HitSoundCue {
  preparedSamples: PreparedSample[];
}

function descriptorKey(sample: HitSampleInfo): string {
  return [
    sample.customFilename ?? "",
    sample.bank ?? "",
    sample.name,
    sample.suffix ?? "",
    sample.customSampleBank,
    sample.volume,
  ].join("|");
}

function fileUrlSafePath(baseFolder: string, relativeFilename: string): string | null {
  if (!relativeFilename || isAbsolute(relativeFilename)) return null;
  const base = resolve(baseFolder);
  const candidate = resolve(base, relativeFilename);
  const prefix = `${base.toLocaleLowerCase()}\\`;
  return candidate.toLocaleLowerCase().startsWith(prefix) ? candidate : null;
}

async function firstReadable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path, constants.R_OK);
      return path;
    } catch {
      // Continue through beatmap, selected-skin, and bundled fallback candidates.
    }
  }
  return null;
}

export function usesBeatmapSampleOverride(sample: HitSampleInfo): boolean {
  return sample.customSampleBank > 0 || Boolean(sample.suffix);
}

@injectable()
export class HitSoundEngine {
  private beatmap: Beatmap = Beatmap.EMPTY_BEATMAP;
  private beatmapFolder = "";
  private readBeatmapSample?: (name: string) => Promise<Uint8Array | undefined>;
  private resourceEpoch = 0;
  private cues: PreparedHitSoundCue[] = [];
  private cueIndex = 0;
  private lastTime = 0;
  private pendingSeekBoundary?: number;
  private generation = 0;
  private sliderLoops = new Map<string, PreparedSample[]>();
  private activeSliderLoopIds = new Set<string>();
  private spinnerLoops = new Map<string, PreparedSample>();
  private spinnerBonusSamples = new Map<string, PreparedSample>();
  private activeSpinnerLoopIds = new Set<string>();
  private spinnerAngles = new Map<string, number>();
  private spinnerLastMovementTimes = new Map<string, number>();
  private spinnerBonusTriggers = new Map<string, { ruleset: ReplayAnalysisRuleset; count: number }>();
  private sampleCache = new Map<string, Promise<PreparedSample | null>>();

  constructor(
    private readonly gameSimulator: GameSimulator,
    private readonly gameClock: GameplayClock,
    private readonly audioEngine: AudioEngine,
    private readonly skinLoader: SkinLoader,
    private readonly skinSettingsStore: SkinSettingsStore,
    @inject(STAGE_TYPES.AUDIO_CONTEXT) private readonly audioContext: AudioContextLike,
    private readonly skinHolder: SkinHolder = new SkinHolder(),
  ) {}

  @postConstruct()
  initialize(): void {
    this.gameClock.seeked$.subscribe((time) => this.resetTimeline(time, true));
    this.gameSimulator.replayEvents$.subscribe((events) => {
      if (this.beatmap === Beatmap.EMPTY_BEATMAP) return;
      void this.prepare(events, true).catch(error => console.warn("Could not refresh hitsounds", error));
    });
  }

  async configure(beatmap: Beatmap, beatmapFolder: string): Promise<void> {
    this.resourceEpoch++;
    this.readBeatmapSample = undefined;
    this.beatmap = beatmap;
    this.beatmapFolder = resolve(beatmapFolder);
    this.sampleCache.clear();
    await this.prepare(this.gameSimulator.replayEvents$.getValue(), false);
  }

  async configureResources(beatmap: Beatmap, read: (name: string) => Promise<Uint8Array | undefined>): Promise<void> {
    this.resourceEpoch++;
    this.beatmap = beatmap;
    this.beatmapFolder = "";
    this.readBeatmapSample = read;
    this.sampleCache.clear();
    await this.prepare(this.gameSimulator.replayEvents$.getValue(), false);
  }

  clear(): void {
    this.resourceEpoch++;
    this.readBeatmapSample = undefined;
    this.generation += 1;
    this.beatmap = Beatmap.EMPTY_BEATMAP;
    this.beatmapFolder = "";
    this.cues = [];
    this.sliderLoops.clear();
    this.activeSliderLoopIds.clear();
    this.spinnerLoops.clear();
    this.spinnerBonusSamples.clear();
    this.activeSpinnerLoopIds.clear();
    this.spinnerAngles.clear();
    this.spinnerLastMovementTimes.clear();
    this.spinnerBonusTriggers.clear();
    this.sampleCache.clear();
    this.cueIndex = 0;
    this.lastTime = 0;
    this.pendingSeekBoundary = undefined;
    this.audioEngine.stopSamples();
  }

  update(time: number): void {
    if (!this.gameClock.isPlaying) {
      this.stopSliderLoops();
      this.stopSpinnerLoops();
      this.lastTime = this.gameClock.timeElapsedInMs;
      return;
    }
    if (this.pendingSeekBoundary !== undefined) {
      // A hit exactly at the seek target or clip in-point belongs to this pass. Pausing
      // after seeking must not consume it before playback actually starts.
      this.lastTime = this.pendingSeekBoundary - 0.501;
      this.pendingSeekBoundary = undefined;
    }
    if (time < this.lastTime || time - this.lastTime > 500) {
      this.resetTimeline(time);
      return;
    }

    while (this.cueIndex < this.cues.length && this.cues[this.cueIndex].time <= time + 0.5) {
      const cue = this.cues[this.cueIndex++];
      if (cue.time <= this.lastTime + 0.5) continue;
      for (const sample of cue.preparedSamples) {
        this.audioEngine.playSample(sample.buffer, sample.volume, this.samplePlaybackRate());
      }
    }
    const state = this.gameSimulator.getStateAt(time);
    this.syncSliderLoops(state);
    this.syncSpinnerLoops(time, state);
    this.lastTime = time;
  }

  private resetTimeline(time: number, includeBoundary = false): void {
    this.positionTimeline(time, includeBoundary);
    this.pendingSeekBoundary = includeBoundary ? time : undefined;
    this.stopSliderLoops();
    this.stopSpinnerLoops();
    this.spinnerAngles.clear();
    this.spinnerLastMovementTimes.clear();
    this.spinnerBonusTriggers.clear();
    this.audioEngine.stopSamples();
  }

  private positionTimeline(time: number, includeBoundary = false): void {
    this.lastTime = time;
    let low = 0;
    let high = this.cues.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (includeBoundary ? this.cues[middle].time < time : this.cues[middle].time <= time + 0.5) low = middle + 1;
      else high = middle;
    }
    this.cueIndex = low;
  }

  private preservePlaybackTimeline(time: number): void {
    this.positionTimeline(time);
    this.spinnerAngles.clear();
    this.spinnerLastMovementTimes.clear();
    this.spinnerBonusTriggers.clear();
    for (const [spinnerId, spinnerState] of this.gameSimulator.getStateAt(time)?.spinnerState ?? []) {
      this.spinnerAngles.set(spinnerId, spinnerState.totalSpunAngle);
      const ruleset = this.gameSimulator.getRulesetFocus();
      this.spinnerBonusTriggers.set(spinnerId, {
        ruleset,
        count: spinnerBonusProgress(this.beatmap.getSpinner(spinnerId), spinnerState, ruleset).soundTriggers,
      });
      if (spinnerState.tracking) this.spinnerLastMovementTimes.set(spinnerId, time);
    }
  }

  private sliderLoopKey(sliderId: string, sampleIndex: number): string {
    return `slider-loop:${sliderId}:${sampleIndex}`;
  }

  private spinnerLoopKey(spinnerId: string): string {
    return `spinner-loop:${spinnerId}`;
  }

  private samplePlaybackRate(): number {
    return this.beatmap.samplesMatchPlaybackRate ? this.gameClock.playbackRate : 1;
  }

  private stopSliderLoops(): void {
    for (const sliderId of this.activeSliderLoopIds) {
      const samples = this.sliderLoops.get(sliderId) ?? [];
      samples.forEach((_, index) => this.audioEngine.stopLoopingSample(this.sliderLoopKey(sliderId, index)));
    }
    this.activeSliderLoopIds.clear();
  }

  private stopSpinnerLoops(): void {
    for (const spinnerId of this.activeSpinnerLoopIds) {
      this.audioEngine.stopLoopingSample(this.spinnerLoopKey(spinnerId));
    }
    this.activeSpinnerLoopIds.clear();
  }

  private syncSliderLoops(state: GameState | undefined): void {
    const trackedSliderIds = new Set<string>();
    for (const [sliderId, bodyState] of state?.sliderBodyState ?? []) {
      if (bodyState.isTracking && this.sliderLoops.has(sliderId)) trackedSliderIds.add(sliderId);
    }

    for (const sliderId of Array.from(this.activeSliderLoopIds)) {
      if (trackedSliderIds.has(sliderId)) continue;
      const samples = this.sliderLoops.get(sliderId) ?? [];
      samples.forEach((_, index) => this.audioEngine.stopLoopingSample(this.sliderLoopKey(sliderId, index)));
      this.activeSliderLoopIds.delete(sliderId);
    }

    for (const sliderId of trackedSliderIds) {
      const samples = this.sliderLoops.get(sliderId) ?? [];
      if (this.activeSliderLoopIds.has(sliderId)) {
        samples.forEach((_, index) =>
          this.audioEngine.setLoopingSamplePlaybackRate(this.sliderLoopKey(sliderId, index), this.samplePlaybackRate()),
        );
        continue;
      }
      samples.forEach((sample, index) =>
        this.audioEngine.playLoopingSample(
          this.sliderLoopKey(sliderId, index),
          sample.buffer,
          sample.volume,
          this.samplePlaybackRate(),
        ),
      );
      if (samples.length > 0) this.activeSliderLoopIds.add(sliderId);
    }
  }

  private syncSpinnerLoops(time: number, state: GameState | undefined): void {
    const spinningIds = new Set<string>();

    for (const [spinnerId, spinnerState] of state?.spinnerState ?? []) {
      const spinner = this.beatmap.getSpinner(spinnerId);
      const angle = spinnerState.totalSpunAngle;
      const previousAngle = this.spinnerAngles.get(spinnerId);
      if (previousAngle !== undefined && angle > previousAngle + 0.001) {
        this.spinnerLastMovementTimes.set(spinnerId, time);
      }
      this.spinnerAngles.set(spinnerId, angle);

      const ruleset = this.gameSimulator.getRulesetFocus();
      const { soundTriggers } = spinnerBonusProgress(spinner, spinnerState, ruleset);
      const previousBonusTriggers = this.spinnerBonusTriggers.get(spinnerId);
      // Switching rulesets can reconstruct more spins at the same playback
      // time. Establish that ruleset's baseline without replaying past awards.
      if (previousBonusTriggers?.ruleset === ruleset && soundTriggers > previousBonusTriggers.count) {
        const bonusSample = this.spinnerBonusSamples.get(spinnerId);
        if (bonusSample) {
          for (let bonus = previousBonusTriggers.count; bonus < soundTriggers; bonus++) {
            this.audioEngine.playSample(bonusSample.buffer, bonusSample.volume, this.samplePlaybackRate());
          }
        }
      }
      this.spinnerBonusTriggers.set(spinnerId, { ruleset, count: soundTriggers });

      const lastMovement = this.spinnerLastMovementTimes.get(spinnerId);
      if (
        time >= spinner.startTime &&
        time < spinner.endTime &&
        spinnerState.tracking &&
        lastMovement !== undefined &&
        time - lastMovement <= 240 &&
        this.spinnerLoops.has(spinnerId)
      ) {
        spinningIds.add(spinnerId);
      }
    }

    for (const spinnerId of Array.from(this.activeSpinnerLoopIds)) {
      if (spinningIds.has(spinnerId)) continue;
      // Matches osu!'s spinner sample fade-out duration. Pausing and seeking
      // still use stopSpinnerLoops(), which intentionally stops immediately.
      this.audioEngine.stopLoopingSample(this.spinnerLoopKey(spinnerId), 240);
      this.activeSpinnerLoopIds.delete(spinnerId);
    }

    for (const spinnerId of spinningIds) {
      const prepared = this.spinnerLoops.get(spinnerId);
      const spinner = this.beatmap.getSpinner(spinnerId);
      const spinnerState = state?.spinnerState.get(spinnerId);
      if (!prepared || !spinnerState) continue;
      const progress = spinnerProgressForState(spinner, spinnerState);
      const modulation = this.skinHolder.getSkin().config.general.spinnerFrequencyModulate
        ? Math.min(100_000 / 44_100, 20_000 / 44_100 + progress * (40_000 / 44_100))
        : 1;
      const playbackRate = modulation * this.samplePlaybackRate();
      const key = this.spinnerLoopKey(spinnerId);
      if (this.activeSpinnerLoopIds.has(spinnerId)) {
        this.audioEngine.setLoopingSamplePlaybackRate(key, playbackRate);
      } else {
        // DrawableSpinner fades spinnerspin in over 300 ms using OutQuint.
        this.audioEngine.playLoopingSample(key, prepared.buffer, prepared.volume, playbackRate, 300);
        this.activeSpinnerLoopIds.add(spinnerId);
      }
    }
  }

  private async prepare(events: readonly ReplayAnalysisEvent[], preservePlayback: boolean): Promise<void> {
    const generation = ++this.generation;
    const storyboardState = buildStoryboardPlaybackStateResolver(
      this.beatmap,
      events,
      this.gameSimulator.getPrimaryReplay()?.lifeBar,
    );
    const rawCues = buildHitSoundCues(this.beatmap, events, storyboardState);
    const load = (sample: HitSampleInfo) => {
      const key = descriptorKey(sample);
      let promise = this.sampleCache.get(key);
      if (!promise) {
        promise = this.loadSample(sample);
        this.sampleCache.set(key, promise);
      }
      return promise;
    };
    const prepared = await Promise.all(
      rawCues.map(
        async (cue): Promise<PreparedHitSoundCue> => ({
          ...cue,
          preparedSamples: (
            await Promise.all(cue.samples.map(load))
          ).filter((sample): sample is PreparedSample => sample !== null),
        }),
      ),
    );
    const preparedSliderLoops = await Promise.all(
      this.beatmap.hitObjects
        .filter(isSlider)
        .map(
          async (slider) =>
            [
              slider.id,
              (
                await Promise.all(slider.loopSamples.map(load))
              ).filter((sample): sample is PreparedSample => sample !== null),
            ] as const,
        ),
    );
    const preparedSpinnerSamples = await Promise.all(
      this.beatmap.hitObjects.filter(isSpinner).map(async (spinner) => {
        const reference = spinner.samples[0];
        if (!reference) return [spinner.id, null, null] as const;
        const spinDescriptor = new HitSampleInfo(
          HitSampleInfo.SPINNER_SPIN,
          reference.bank,
          reference.suffix,
          reference.volume,
          null,
          reference.customSampleBank,
        );
        const bonusDescriptor = new HitSampleInfo(
          HitSampleInfo.SPINNER_BONUS,
          reference.bank,
          reference.suffix,
          reference.volume,
          null,
          reference.customSampleBank,
        );
        const [spin, bonus] = await Promise.all([load(spinDescriptor), load(bonusDescriptor)]);
        return [spinner.id, spin, bonus] as const;
      }),
    );
    if (generation !== this.generation) return;
    const time = this.gameClock.isPlaying ? this.audioEngine.cueTime() : this.gameClock.timeElapsedInMs;
    // Finish the old cue list through the current audio position before replacing
    // it, so an asynchronous ruleset refresh neither repeats nor skips that gap.
    if (preservePlayback && this.gameClock.isPlaying) this.update(time);
    this.cues = prepared;
    this.sliderLoops = new Map(preparedSliderLoops);
    this.spinnerLoops = new Map();
    this.spinnerBonusSamples = new Map();
    for (const [id, spin, bonus] of preparedSpinnerSamples) {
      if (spin) this.spinnerLoops.set(id, spin);
      if (bonus) this.spinnerBonusSamples.set(id, bonus);
    }
    if (preservePlayback) this.preservePlaybackTimeline(time);
    else this.resetTimeline(time);
  }

  private async loadSample(sample: HitSampleInfo): Promise<PreparedSample | null> {
    const epoch = this.resourceEpoch, read = this.readBeatmapSample;
    // Verification/cancellation failures must propagate. Only an explicitly absent sample
    // permits the existing skin fallback; an explicit custom filename remains map-only.
    if (read) {
      const stems = [`${sample.bank ?? "normal"}-${sample.name}`, sample.name];
      if (!sample.customFilename && stems.some(stem => extname(stem))) return null;
      const names = sample.customFilename ? [sample.customFilename] : usesBeatmapSampleOverride(sample)
        ? stems.flatMap(stem => [".wav", ".ogg", ".mp3"].map(extension => `${stem}${sample.suffix ?? ""}${extension}`)) : [];
      for (const name of names) {
        if (epoch !== this.resourceEpoch) return null;
        const bytes = await read(name);
        if (epoch !== this.resourceEpoch) return null;
        if (bytes !== undefined) {
          try {
            const buffer = await this.audioContext.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
            return epoch === this.resourceEpoch ? { buffer, volume: Math.max(0, Math.min(1, (sample.volume || 100) / 100)) } : null;
          } catch (error) { console.warn(`Could not decode hitsound '${name}'`, error); return null; }
        }
      }
      if (sample.customFilename) return null;
    }
    const path = await this.resolveSamplePath(sample);
    if (!path || epoch !== this.resourceEpoch) return null;
    try {
      const bytes = await readFile(path);
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buffer = await this.audioContext.decodeAudioData(data as ArrayBuffer);
      return epoch === this.resourceEpoch ? { buffer, volume: Math.max(0, Math.min(1, (sample.volume || 100) / 100)) } : null;
    } catch (error) {
      console.warn(`Could not load hitsound '${path}'`, error);
      return null;
    }
  }

  private async resolveSamplePath(sample: HitSampleInfo): Promise<string | null> {
    if (!this.beatmapFolder && !this.readBeatmapSample) return null;
    if (sample.customFilename) {
      const custom = fileUrlSafePath(this.beatmapFolder, sample.customFilename);
      return custom ? firstReadable([custom]) : null;
    }

    const bank = sample.bank ?? "normal";
    const suffix = sample.suffix ?? "";
    const stems = [`${bank}-${sample.name}`, sample.name];
    const extensions = [".wav", ".ogg", ".mp3"];
    const beatmapCandidates = this.beatmapFolder && usesBeatmapSampleOverride(sample)
      ? stems.flatMap((stem) =>
          extensions.map((extension) => resolve(this.beatmapFolder, `${stem}${suffix}${extension}`)),
        )
      : [];
    const preferredSkin = this.skinLoader.resolveToPath(
      stringToSkinId(this.skinSettingsStore.settings.preferredSkinId),
    );
    const defaultSkin = this.skinLoader.resolveToPath({ source: "rewind", name: "OsuDefaultSkin" });
    const skinCandidates = [preferredSkin, defaultSkin].flatMap((folder) =>
      stems.flatMap((stem) => extensions.map((extension) => resolve(folder, `${stem}${extension}`))),
    );

    // Explicitly reject an extension embedded in a generated name; only the
    // fixed osu! sample extensions above are considered.
    if (stems.some((stem) => extname(stem))) return null;
    return firstReadable([...beatmapCandidates, ...skinCandidates]);
  }
}
