import { inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "../common/ViewerLifecycleObserver";
import { BehaviorSubject } from "rxjs";
import { Texture } from "pixi.js";
import {
  Beatmap,
  Blueprint,
  BlueprintMetadata,
  buildBeatmap,
  modsToBitmask,
  isHitCircle,
  parseBlueprint,
  parseStoryboardSampleEvents,
  StoryboardSampleInfo,
} from "@osujs/core";
import { hitWindowsForOD } from "@osujs/math";
import { GameSimulator } from "../common/game/GameSimulator";
import { AudioService, disposeLoadedAudio } from "../common/audio/AudioService";
import { ReplayService } from "../common/local/ReplayService";
import { BeatmapManager } from "./BeatmapManager";
import { ReplayManager } from "./ReplayManager";
import { AnalysisSceneKeys, AnalysisSceneManager } from "./AnalysisSceneManager";
import { AudioEngine } from "../common/audio/AudioEngine";
import { GameplayClock } from "../common/game/GameplayClock";
import { GameLoop } from "../common/game/GameLoop";
import { PixiRendererManager } from "../renderers/PixiRendererManager";
import { basename, join } from "path";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { readFile, readdir } from "fs/promises";
import { BlueprintLocatorService } from "../common/local/BlueprintLocatorService";
import { OsuFolderService } from "../common/local/OsuFolderService";
import { BeatmapBackgroundSettingsStore } from "../common/beatmap-background";
import { TextureManager } from "../textures/TextureManager";
import { ReplayFileWatcher } from "../common/local/ReplayFileWatcher";
import { ModSettingsService } from "../analysis/mod-settings";
import { HitSoundEngine } from "../common/audio/HitSoundEngine";
import { OnlineBeatmapLookupService } from "../common/OnlineBeatmapLookupService";
import { PerformanceTimelineService } from "../analysis/performance/PerformanceTimelineService";
import { SliderTextureManager } from "../renderers/components/sliders/SliderTextureManager";
import { isLazerReplay } from "../../model/OsuReplay";
import { formatReplayMods, IDLE_LOAD_STATE, LoadedMap, ReplayLoadState } from "./replay-load-state";
import type { LibraryReplayResources } from "../library/library-replay-resources";
import { LibraryResourceCleanupError } from "../library/library-replay-resources";
import { isLibraryCurrentReplayReceipt } from "../../../../../shared/library-current-replay";
import type { LibraryCurrentReplayReceipt } from "../../../../../shared/library-current-replay";
import { currentReplayBinding } from "../library/library-current-replay-publisher";
import type { LibraryCurrentReplayPublisher } from "../library/library-current-replay-publisher";

interface LibraryReplaySource {
  open(id: string, signal: AbortSignal): Promise<LibraryReplayResources>;
  acquireForeground(): () => void;
}

interface LibraryCandidate {
  controller: AbortController;
  opening: Promise<LibraryReplayResources>;
  retirement?: Promise<void>;
  installed?: boolean;
}
interface PreparedLibraryReplay {
  attempt: number;
  owner: LibraryCandidate;
  resources: LibraryReplayResources;
  replay: Awaited<ReturnType<LibraryReplayResources["replay"]>>;
  rawBlueprint: string;
  blueprint: Blueprint;
}
interface PreparedFileReplay {
  attempt: number;
  replay: Awaited<ReturnType<ReplayService["retrieveReplay"]>>;
  rawBlueprint: string;
  blueprint: Blueprint;
  absoluteFolderPath: string;
  beatmapContentSha256: string;
}

interface Scenario {
  status: "LOADING" | "ERROR" | "DONE" | "INIT";
  errorMessage?: string;
  beatmapUrl?: string;
}

const cleanText = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);

async function externalStoryboardSamples(folder: string): Promise<StoryboardSampleInfo[]> {
  let filenames: string[];
  try {
    filenames = (await readdir(folder)).filter((filename) => filename.toLowerCase().endsWith(".osb")).sort();
  } catch (error) {
    console.warn(`Could not inspect external storyboards in '${folder}'`, error);
    return [];
  }

  const samples: StoryboardSampleInfo[] = [];
  for (const filename of filenames) {
    try {
      samples.push(...parseStoryboardSampleEvents(await readFile(join(folder, filename), "utf-8")));
    } catch (error) {
      console.warn(`Could not read storyboard samples from '${filename}'`, error);
    }
  }
  return samples;
}

@injectable()
export class ScenarioManager {
  public scenario$: BehaviorSubject<Scenario>;
  /** What the stage, inspector and dock show while a replay loads; `scenario$` is unchanged. */
  public readonly loadState$ = new BehaviorSubject<ReplayLoadState>(IDLE_LOAD_STATE);
  private loadSequence = 0;
  private loadAttemptSequence = 0;
  private comparisonLoadSequence = 0;
  private currentBlueprint?: Blueprint;
  private currentBeatmapMd5?: string;
  private initialized = false;
  private beforeReplayChange?: () => Promise<void>;
  private librarySource?: LibraryReplaySource;
  private libraryOwner?: { controller: AbortController; opening: Promise<LibraryReplayResources> };
  private libraryCandidate?: LibraryCandidate;
  private candidateSequence = 0;
  private candidateRetirement: Promise<void> = Promise.resolve();
  private resourceRetirement: Promise<void> = Promise.resolve();
  private libraryCleanupFailure?: Error;
  private libraryBackground?: Texture;
  private currentReplayPublisher?: Pick<LibraryCurrentReplayPublisher, "attach" | "clear" | "discard">;
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(
    private readonly gameClock: GameplayClock,
    private readonly renderer: PixiRendererManager,
    private readonly gameLoop: GameLoop,
    private readonly gameSimulator: GameSimulator,
    private readonly modSettingsService: ModSettingsService,
    private readonly blueprintLocatorService: BlueprintLocatorService,
    private readonly osuFolderService: OsuFolderService,
    private readonly audioService: AudioService,
    private readonly textureManager: TextureManager,
    private readonly replayService: ReplayService,
    private readonly beatmapBackgroundSettingsStore: BeatmapBackgroundSettingsStore,
    private readonly beatmapManager: BeatmapManager,
    private readonly replayManager: ReplayManager,
    private readonly sceneManager: AnalysisSceneManager,
    private readonly replayWatcher: ReplayFileWatcher,
    private readonly audioEngine: AudioEngine,
    private readonly hitSoundEngine: HitSoundEngine,
    private readonly onlineBeatmapLookupService: OnlineBeatmapLookupService,
    private readonly performanceTimeline: PerformanceTimelineService,
    private readonly sliderTextures: SliderTextureManager,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver,
  ) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    this.scenario$ = new BehaviorSubject<Scenario>({ status: "INIT" });
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-created", this);
  }

  public initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.replayWatcher.newReplays$.subscribe((replayId) => {
      void this.loadReplay(replayId, { automatic: true });
    });
  }

  getBeatmapMetadata(): Readonly<BlueprintMetadata> | undefined {
    return this.currentBlueprint?.blueprintInfo.metadata;
  }

  /** Finish cancelling an export before releasing the replay/audio it owns. */
  setBeforeReplayChange(callback: () => Promise<void>) {
    this.beforeReplayChange = callback;
  }

  setLibraryReplaySource(source: LibraryReplaySource): void { this.librarySource = source; }
  setCurrentReplayPublisher(publisher: Pick<LibraryCurrentReplayPublisher, "attach" | "clear" | "discard">): void { this.currentReplayPublisher = publisher; }

  async clearReplay() {
    const candidates = this.cancelLibraryCandidate();
    const sequence = ++this.loadSequence;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-clear-attempt", this, { sequence });
    this.currentReplayPublisher?.clear();
    if (this.beforeReplayChange) await this.beforeReplayChange();
    if (sequence !== this.loadSequence) return;
    await this.resetPlayback();
    await candidates;
    if (sequence !== this.loadSequence) return;
    this.scenario$.next({ status: "INIT" });
    this.loadState$.next(IDLE_LOAD_STATE);
  }

  /** Merge into the state of the load that still owns the sequence; a superseded load publishes nothing. */
  private updateLoadState(loadSequence: number, patch: Partial<ReplayLoadState>) {
    if (loadSequence !== this.loadSequence) return;
    const next: ReplayLoadState = { ...this.loadState$.getValue(), ...patch };
    // An unknown field is absent, not undefined.
    for (const key of Object.keys(next) as (keyof ReplayLoadState)[]) if (next[key] === undefined) delete next[key];
    this.loadState$.next(next);
  }

  private async resetPlayback() {
    const resetSequence = this.loadSequence;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-reset-attempt", this, { sequence: resetSequence });
    this.currentReplayPublisher?.clear();
    this.audioService.cancelPendingLoads();
    this.performanceTimeline.clear();
    this.comparisonLoadSequence += 1;
    this.gameClock.clear();
    this.replayManager.setMainReplay(null);
    this.replayManager.setComparisonCursorSource(null);
    this.audioEngine.destroy();
    this.hitSoundEngine.clear();
    this.renderer.getRenderer()?.clear();
    this.sliderTextures.clear();
    this.beatmapManager.setBeatmap(Beatmap.EMPTY_BEATMAP);
    this.gameSimulator.clear();
    this.currentBlueprint = undefined;
    this.currentBeatmapMd5 = undefined;
    this.gameLoop.stopTicker();
    // Export cancellation has completed before this method. Detach consumers before
    // revoking source URLs; route hiding deliberately does not call this method.
    if (this.libraryBackground) {
      this.beatmapBackgroundSettingsStore.texture$.next(Texture.EMPTY);
      this.libraryBackground.destroy(true); this.libraryBackground = undefined;
    }
    const owner = this.libraryOwner; this.libraryOwner = undefined;
    if (owner) {
      owner.controller.abort();
      const retiring = owner.opening.then(resources => resources.close(), error => {
        if (error instanceof LibraryResourceCleanupError) throw error;
        // The resource client releases even a failed/stalled open. Keep that failure
        // observable while allowing replacement after the cancelled acquisition settles.
        console.warn("Library acquisition ended during retirement", error);
      });
      this.resourceRetirement = Promise.all([this.resourceRetirement, retiring]).then(() => undefined).catch(error => {
        this.libraryCleanupFailure = error instanceof Error ? error : new Error("Library resource cleanup failed");
        console.error("Library resource cleanup failed; restart Hindsight before opening another library replay", error);
      });
    }
    await this.resourceRetirement;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-reset-completed", this, { sequence: resetSequence });
  }

  private retireLibraryCandidate(owner: LibraryCandidate): Promise<void> {
    if (owner.installed) return Promise.resolve();
    if (!owner.retirement) {
      owner.controller.abort();
      owner.retirement = owner.opening.then(async resources => {
        const receipt = "currentReplay" in resources.handle ? resources.handle.currentReplay : undefined;
        if (isLibraryCurrentReplayReceipt(receipt)) this.currentReplayPublisher?.discard(receipt);
        await resources.close();
      }, error => { if (error instanceof LibraryResourceCleanupError) throw error; }).catch(error => {
        this.libraryCleanupFailure = error instanceof Error ? error : new Error("Library resource cleanup failed");
      });
    }
    return owner.retirement;
  }

  private cancelLibraryCandidate(): Promise<void> {
    this.candidateSequence += 1;
    const owner = this.libraryCandidate; this.libraryCandidate = undefined;
    if (owner) this.candidateRetirement = Promise.all([this.candidateRetirement, this.retireLibraryCandidate(owner)]).then(() => undefined);
    return this.candidateRetirement;
  }

  async loadReplay(replayId: string, options?: { automatic?: boolean }) {
    if (options?.automatic && this.loadState$.value.phase === "ready") return this.loadAutomaticReplay(replayId);
    const candidates = this.cancelLibraryCandidate();
    const result = await this.loadReplayEntry(replayId, false);
    await candidates;
    return result;
  }

  /** Folder arrivals may be incomplete or have no installed map; keep the active viewer until verified. */
  private async loadAutomaticReplay(replayId: string): Promise<boolean> {
    const retiring = this.cancelLibraryCandidate();
    const candidate = this.candidateSequence, active = this.loadSequence;
    const current = () => candidate === this.candidateSequence && active === this.loadSequence;
    const attempt = ++this.loadAttemptSequence;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-load-attempt", this, { sequence: attempt, source: "file" });
    let committed = false;
    try {
      await retiring;
      if (!current()) return false;
      await this.osuFolderService.whenReady();
      if (!current()) return false;
      const replay = await this.replayService.retrieveReplay(replayId);
      if (!current()) return false;
      if (replay.gameMode !== undefined && replay.gameMode !== 0) throw new Error("Unsupported automatic replay mode");
      const map = await this.readExactFileMap(replay.beatmapMd5.trim().toLowerCase(), current);
      if (!current()) return false;
      if (!map) throw new Error("The automatic replay's exact beatmap is unavailable");
      const blueprint = parseBlueprint(map.rawBlueprint);
      if (this.beforeReplayChange) await this.beforeReplayChange();
      if (!current()) return false;
      committed = true;
      return await this.loadReplayEntry(replayId, false, undefined, { attempt, replay, blueprint, ...map });
    } catch (error) {
      if (!committed && current()) {
        console.warn("Could not prepare an automatic replay; the current viewer is retained", error);
        if (this.lifecycle.enabled) this.lifecycle.record("scenario-load-rejected", this, { sequence: attempt, current: true });
      }
      return false;
    } finally {
      if (!committed && this.lifecycle.enabled) this.lifecycle.record("scenario-load-settled", this, { sequence: attempt, current: current() });
    }
  }

  private async readExactFileMap(checksum: string, current: () => boolean) {
    let info = await this.blueprintLocatorService.getBlueprintByMD5(checksum);
    if (!current()) return undefined;
    for (let attempt = 0; attempt < 2 && info; attempt += 1) {
      const absoluteFolderPath = join(this.osuFolderService.songsFolder$.getValue(), info.folderName);
      try {
        const bytes = await readFile(join(absoluteFolderPath, info.osuFileName));
        if (!current()) return undefined;
        // osu!.db is only a locator; consume the verified bytes even if the file changes afterwards.
        if (createHash("md5").update(bytes).digest("hex") === checksum)
          return { absoluteFolderPath, rawBlueprint: bytes.toString("utf8"), beatmapContentSha256: createHash("sha256").update(bytes).digest("hex") };
      } catch (error) {
        if (!current()) return undefined;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (attempt === 0) {
        info = await this.blueprintLocatorService.getBlueprintByMD5(checksum, true);
        if (!current()) return undefined;
      }
    }
    return undefined;
  }

  /** Verify a candidate before retiring the installed viewer. Failed preflight leaves its generation valid. */
  async loadLibraryReplay(replayId: string): Promise<boolean> {
    const retiring = this.cancelLibraryCandidate();
    const sequence = this.candidateSequence;
    const release = this.librarySource?.acquireForeground();
    const attempt = ++this.loadAttemptSequence;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-load-attempt", this, { sequence: attempt, source: "library" });
    let owner: LibraryCandidate | undefined;
    let committed = false;
    let opened = false;
    let installedSequence: number | undefined;
    try {
      await retiring;
      if (sequence !== this.candidateSequence) return false;
      if (this.libraryCleanupFailure) throw this.libraryCleanupFailure;
      if (!this.librarySource) throw new Error("Library replay source is not ready");
      const controller = new AbortController();
      owner = { controller, opening: this.librarySource.open(replayId, controller.signal) };
      this.libraryCandidate = owner;
      const resources = await owner.opening;
      if (sequence !== this.candidateSequence) return false;
      const replay = await resources.replay();
      if (sequence !== this.candidateSequence) return false;
      if (replay.gameMode !== undefined && replay.gameMode !== 0) throw Error(`Unsupported replay mode ${replay.gameMode}; only osu!standard replays can be analysed`);
      const rawBlueprint = await resources.map();
      if (sequence !== this.candidateSequence) return false;
      const blueprint = parseBlueprint(rawBlueprint);
      if (this.beforeReplayChange) await this.beforeReplayChange();
      if (sequence !== this.candidateSequence) return false;
      committed = true;
      installedSequence = this.loadSequence + 1;
      opened = (await this.loadReplayEntry(replayId, true, { attempt, owner, resources, replay, rawBlueprint, blueprint })) === true;
    } catch (error) {
      if (!committed && this.lifecycle.enabled) this.lifecycle.record("scenario-load-rejected", this, { sequence: attempt, current: sequence === this.candidateSequence });
      if (sequence !== this.candidateSequence) return false;
      throw error;
    } finally {
      if (owner) {
        const retiring = this.retireLibraryCandidate(owner);
        this.candidateRetirement = Promise.all([this.candidateRetirement, retiring]).then(() => undefined);
        if (this.libraryCandidate === owner) this.libraryCandidate = undefined;
        await retiring;
      }
      release?.();
      if (!committed && this.lifecycle.enabled) this.lifecycle.record("scenario-load-settled", this, { sequence: attempt, current: sequence === this.candidateSequence });
    }
    return opened && installedSequence === this.loadSequence && sequence === this.candidateSequence;
  }

  private async loadReplayEntry(replayId: string, fromLibrary: boolean, prepared?: PreparedLibraryReplay, preparedFile?: PreparedFileReplay) {
    const loadSequence = ++this.loadSequence;
    const attempt = prepared?.attempt ?? preparedFile?.attempt ?? ++this.loadAttemptSequence;
    if (!prepared && !preparedFile && this.lifecycle.enabled) this.lifecycle.record("scenario-load-attempt", this, { sequence: attempt, source: "file" });
    this.currentReplayPublisher?.clear();
    const loadStartedAt = performance.now();
    let mayReplace = false;
    let issuedReceipt: LibraryCurrentReplayReceipt | undefined;
    let captureAttached = false;
    try {
      if (!prepared && !preparedFile && this.beforeReplayChange) await this.beforeReplayChange();
      mayReplace = true;
      if (loadSequence !== this.loadSequence) return false;
      console.log(`ScenarioManager loading replay with id = ${replayId}`);
      await this.resetPlayback();
      if (loadSequence !== this.loadSequence) return false;
      if (prepared?.owner.controller.signal.aborted) return false;
      this.scenario$.next({ status: "LOADING" });
      this.loadState$.next({ phase: "loading", step: "read-replay", ...(fromLibrary ? {} : { fileName: basename(replayId) }) });
      let resources: LibraryReplayResources | undefined;
      if (fromLibrary) {
        if (this.libraryCleanupFailure) throw this.libraryCleanupFailure;
        if (!prepared) throw new Error("Library replay was not prepared");
        prepared.owner.installed = true;
        this.libraryOwner = prepared.owner;
        if (this.libraryCandidate === prepared.owner) this.libraryCandidate = undefined;
        resources = prepared.resources;
        const offered = "currentReplay" in resources.handle ? resources.handle.currentReplay : undefined;
        if (isLibraryCurrentReplayReceipt(offered)) issuedReceipt = offered;
      } else if (!preparedFile) await this.osuFolderService.whenReady();
      if (loadSequence !== this.loadSequence) return false;
      const replay = prepared?.replay ?? preparedFile?.replay ?? await this.replayService.retrieveReplay(replayId);
      if (loadSequence !== this.loadSequence) return false;
      if (replay.gameMode !== undefined && replay.gameMode !== 0) {
        throw Error(`Unsupported replay mode ${replay.gameMode}; only osu!standard replays can be analysed`);
      }
      this.updateLoadState(loadSequence, {
        step: "find-beatmap",
        player: cleanText(replay.player),
        mods: formatReplayMods(replay.mods, replay.lazerMods),
        ruleset: isLazerReplay(replay) ? "Lazer" : "Stable",
      });

      const checksum = replay.beatmapMd5.trim().toLowerCase();
      let absoluteFolderPath = "";
      let rawBlueprint: string | undefined;
      let beatmapContentSha256: string | undefined;
      if (resources) {
        rawBlueprint = prepared?.rawBlueprint;
        beatmapContentSha256 = resources.handle.mapSha256;
      } else {
        const map = preparedFile ?? await this.readExactFileMap(checksum, () => loadSequence === this.loadSequence);
        if (loadSequence !== this.loadSequence) return false;
        if (map) ({ absoluteFolderPath, rawBlueprint, beatmapContentSha256 } = map);
      }
      if (rawBlueprint === undefined) {
        await this.showMissingBeatmap(replay.beatmapMd5, loadSequence);
        return false;
      }
      if (loadSequence !== this.loadSequence) return false;
      const blueprint = prepared?.blueprint ?? preparedFile?.blueprint ?? parseBlueprint(rawBlueprint);
      if (resources) {
        for (const name of resources.handle.storyboards) {
          const bytes = await resources.optionalAsset(name, 4 * 1024 * 1024);
          if (loadSequence !== this.loadSequence) return false;
          if (bytes) blueprint.blueprintInfo.storyboardSamples.push(...parseStoryboardSampleEvents(Buffer.from(bytes).toString("utf8")));
        }
      } else blueprint.blueprintInfo.storyboardSamples.push(...(await externalStoryboardSamples(absoluteFolderPath)));
      if (loadSequence !== this.loadSequence) return false;
      const { metadata } = blueprint.blueprintInfo;
      const backgroundHref = resources ? (metadata.backgroundFile ? await resources.backgroundUrl(metadata.backgroundFile) : undefined)
        : pathToFileURL(join(absoluteFolderPath, metadata.backgroundFile)).href;
      if (loadSequence !== this.loadSequence) return false;
      // A map without a background file would otherwise publish its folder as an image URL.
      const backgroundUrl = metadata.backgroundFile ? backgroundHref : undefined;
      const map: LoadedMap = {
        artist: cleanText(metadata.artist),
        title: cleanText(metadata.title) ?? "Unknown beatmap",
        difficulty: cleanText(metadata.difficultyName),
        mapper: cleanText(metadata.creator),
      };
      this.updateLoadState(loadSequence, { step: "simulate", map, backgroundUrl });

      const background = backgroundHref ? await this.textureManager.loadTexture(backgroundHref) : Texture.EMPTY;
      if (loadSequence !== this.loadSequence) {
        if (resources && background !== Texture.EMPTY) background.destroy(true);
        return false;
      }
      if (resources && background !== Texture.EMPTY) this.libraryBackground = background;
      this.beatmapBackgroundSettingsStore.texture$.next(background);

      const audio = resources ? await this.audioService.loadAudioResource(metadata.audioFile, () => resources.asset(metadata.audioFile))
        : await this.audioService.loadAudio(pathToFileURL(join(absoluteFolderPath, metadata.audioFile)).href);
      if (loadSequence !== this.loadSequence) {
        disposeLoadedAudio(audio);
        return false;
      }
      this.audioEngine.setSong(audio);

      // If building becomes too slow, this can move to a WebWorker. Keep the
      // existing builder so stacking/mod transforms remain shared with Rewind.
      const beatmap = buildBeatmap(blueprint, {
        addStacking: true,
        mods: replay.mods,
        lazerMods: replay.lazerMods,
      });
      const lateWindow =
        Math.max(
          hitWindowsForOD(beatmap.difficulty.overallDifficulty, false)[2],
          hitWindowsForOD(beatmap.difficulty.overallDifficulty, true)[2],
        ) + 1;
      const objectEnd = beatmap.hitObjects.reduce(
        (latest, object) => Math.max(latest, (isHitCircle(object) ? object.hitTime : object.endTime) + lateWindow),
        0,
      );
      const replayEnd = replay.frames.reduce((latest, frame) => Math.max(latest, frame.time), 0);
      this.gameClock.setAnalysisEnd(Math.max(objectEnd, replayEnd));
      const duration = Math.max(audio.duration * 1000, objectEnd, replayEnd);
      this.gameClock.setDuration(duration);
      this.gameSimulator.calculateDifficulties(rawBlueprint, duration, modsToBitmask(replay.mods), beatmap);
      audio.preservesPitch =
        replay.lazerMods !== undefined
          ? !(beatmap.lazerModSettings.adjustPitch ?? false)
          : !replay.mods.includes("NIGHT_CORE");

      console.log(`Beatmap built with ${beatmap.hitObjects.length} hitobjects`);
      console.log(`Replay loaded with ${replay.frames.length} frames`);
      const modHidden = replay.mods.includes("HIDDEN");
      const baseRate = beatmap.gameClockRate;

      this.modSettingsService.setHidden(modHidden);
      // Not supported yet
      this.modSettingsService.setFlashlight(false);

      this.gameClock.setBaseRate(baseRate);
      this.gameClock.setSpeed(1.0);
      this.gameClock.seekTo(0);
      this.beatmapManager.setBeatmap(beatmap);
      this.replayManager.setMainReplay(replay);
      this.currentBlueprint = blueprint;
      this.currentBeatmapMd5 = replay.beatmapMd5;

      // F2/drop/file loads remain unbound unless main supplied verified indexed identity.
      // Recording provenance is independent of comparison focus and playback speed.
      const receipt = resources && issuedReceipt && issuedReceipt.replayId === resources.handle.replayId &&
        issuedReceipt.replaySha256 === resources.handle.replaySha256 && issuedReceipt.replaySha256 === replay.replayContentSha256 &&
        issuedReceipt.mapSha256 === beatmapContentSha256 && issuedReceipt.mapMd5 === checksum ? issuedReceipt : undefined;
      const libraryReuseBinding = receipt ? currentReplayBinding(receipt,
        isLazerReplay(replay) ? beatmap.lazerModSettings.classic ? "lazer-classic" : "lazer" : "stable",
        beatmap.gameClockRate, beatmap.hitObjects.length) : undefined;
      this.gameSimulator.simulateReplay(beatmap, replay, {
        beatmapContentSha256,
        beatmapMd5: checksum,
        preparationIdentity: "BeatmapBuilder:addStacking=true",
        ...(libraryReuseBinding ? { libraryReuseBinding } : {}),
      });
      if (loadSequence !== this.loadSequence) return false;
      const capture = libraryReuseBinding ? this.gameSimulator.getLibraryReplayContext() : undefined;
      // Counters publish independently; media and hitsounds must be ready for playback.
      // The performance service discards results when this replay is replaced or cleared.
      const performanceLoad = capture ? this.performanceTimeline.load(rawBlueprint, this.gameSimulator.getPerformanceInputs(), capture)
        : this.performanceTimeline.load(rawBlueprint, this.gameSimulator.getPerformanceInputs());
      void performanceLoad.catch((error) => {
        if (loadSequence === this.loadSequence) console.warn("Replay performance preparation failed", error);
      });
      if (resources) await this.hitSoundEngine.configureResources(beatmap, name => resources.optionalAsset(name));
      else await this.hitSoundEngine.configure(beatmap, absoluteFolderPath);
      if (loadSequence !== this.loadSequence) return false;
      await this.sceneManager.changeToScene(AnalysisSceneKeys.ANALYSIS);
      if (loadSequence !== this.loadSequence) return false;

      this.gameLoop.startTicker();
      this.scenario$.next({ status: "DONE" });
      this.loadState$.next({ phase: "ready" });
      if (this.lifecycle.enabled) this.lifecycle.record("scenario-ready", this, { sequence: attempt });
      console.info(
        `[replay-load] INTERACTIVE replay=${replayId} elapsedMs=${Math.max(
          0,
          performance.now() - loadStartedAt,
        ).toFixed(2)}`,
      );
      if (receipt && capture && this.currentReplayPublisher) {
        try { this.currentReplayPublisher.attach(receipt, capture); captureAttached = true; }
        catch (error) { console.warn("Current replay library reuse unavailable", error); }
      }
      return true;
    } catch (error) {
      if (this.lifecycle.enabled) this.lifecycle.record("scenario-load-rejected", this, { sequence: attempt, current: loadSequence === this.loadSequence });
      if (!mayReplace) throw error;
      if (loadSequence !== this.loadSequence) return false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Could not load replay '${replayId}': ${errorMessage}`, error);
      try { await this.resetPlayback(); }
      catch (cleanup) { console.error("Replay resource cleanup failed", cleanup); }
      if (loadSequence !== this.loadSequence) return false;
      this.scenario$.next({ status: "ERROR", errorMessage });
      this.updateLoadState(loadSequence, {
        phase: "failed",
        step: undefined,
        failure: { kind: "other", message: errorMessage },
      });
      return false;
    } finally {
      if (issuedReceipt && !captureAttached) this.currentReplayPublisher?.discard(issuedReceipt);
      if (this.lifecycle.enabled) this.lifecycle.record("scenario-load-settled", this, { sequence: attempt, current: loadSequence === this.loadSequence });
    }
  }

  private async showMissingBeatmap(md5: string, loadSequence: number) {
    const result = await this.onlineBeatmapLookupService.lookupResult(md5);
    if (loadSequence !== this.loadSequence) return;
    const beatmap = result.status === "FOUND" ? result.beatmap : undefined;
    const beatmapUrl = beatmap
      ? `https://osu.ppy.sh/beatmapsets/${beatmap.beatmapsetId}#osu/${beatmap.beatmapId}`
      : undefined;
    this.scenario$.next(
      beatmapUrl
        ? {
            status: "ERROR",
            errorMessage:
              "This beatmap isn't installed. Download and install it from osu!, then open the replay again.",
            beatmapUrl,
          }
        : { status: "ERROR", errorMessage: "Beatmap not found online" },
    );
    this.updateLoadState(loadSequence, {
      phase: "failed",
      step: undefined,
      failure: beatmapUrl
        ? { kind: "beatmap-not-found", lookup: "found", beatmapUrl }
        : { kind: "beatmap-not-found", lookup: result.status === "NOT_FOUND" ? "not-found" : "unavailable" },
    });
  }

  // This is just the NM view of a beatmap
  async loadBeatmap(blueprintId: string) {
    await this.cancelLibraryCandidate();
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-beatmap-attempt", this);
    this.currentReplayPublisher?.clear();
    if (this.beforeReplayChange) await this.beforeReplayChange();
    this.gameSimulator.clearMissExplanations();
    // Set speed to 1.0
    this.gameClock.setBaseRate(1.0);
    this.gameClock.setSpeed(1.0);
    this.gameClock.seekTo(0);
    this.modSettingsService.setHidden(false);
    this.replayManager.setMainReplay(null);
    this.clearReplayComparison();
  }

  async loadComparisonReplay(replayId: string) {
    const sequence = ++this.comparisonLoadSequence;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-comparison-attempt", this, { sequence, action: "load" });
    if (this.beforeReplayChange) await this.beforeReplayChange();
    if (sequence !== this.comparisonLoadSequence) return;
    const ruleset = this.gameSimulator.getRulesetFocus();
    this.gameSimulator.setReplayComparisonLoading("replay");
    this.replayManager.setComparisonCursorSource(null);

    try {
      const primaryReplay = this.replayManager.getMainReplay();
      if (!primaryReplay || !this.currentBlueprint || !this.currentBeatmapMd5) {
        throw Error("Load a primary replay before adding a comparison replay");
      }

      const replay = await this.replayService.retrieveReplay(replayId);
      if (sequence !== this.comparisonLoadSequence) return;
      // A recording can start while this disk read is pending. Cancel it
      // before publishing a different comparison cursor or result.
      if (this.beforeReplayChange) await this.beforeReplayChange();
      if (sequence !== this.comparisonLoadSequence) return;
      if (replay.gameMode !== 0) {
        throw Error("The comparison replay must be an osu!standard replay");
      }
      if (replay.beatmapMd5.toLowerCase() !== this.currentBeatmapMd5.toLowerCase()) {
        throw Error("The comparison replay belongs to a different beatmap");
      }

      const beatmap = buildBeatmap(this.currentBlueprint, {
        addStacking: true,
        mods: replay.mods,
        lazerMods: replay.lazerMods,
      });
      const state = this.gameSimulator.compareReplay(beatmap, replay, ruleset);
      if (sequence !== this.comparisonLoadSequence) return;

      if (state.status === "READY") {
        this.replayManager.setComparisonCursorSource({
          id: state.secondary.id,
          label: state.secondary.label,
          kind: state.secondary.kind,
          frames: state.secondary.cursorFrames,
          excludedRanges: state.secondary.cursorExcludedRanges ?? [],
          coordinateComparable: state.result.compatibility.sameCoordinateTransform,
        });
      }
      return state;
    } catch (error) {
      if (sequence !== this.comparisonLoadSequence) return;
      const message = error instanceof Error ? error.message : "Could not load the comparison replay";
      this.replayManager.setComparisonCursorSource(null);
      return this.gameSimulator.setReplayComparisonError("replay", message);
    }
  }

  compareWithAutoplayReference() {
    this.comparisonLoadSequence += 1;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-comparison-attempt", this, { sequence: this.comparisonLoadSequence, action: "autoplay" });
    this.gameSimulator.setReplayComparisonLoading("autoplay-reference");
    this.replayManager.setComparisonCursorSource(null);
    const state = this.gameSimulator.compareAutoplayReference();
    if (state.status === "READY") {
      this.replayManager.setComparisonCursorSource({
        id: state.secondary.id,
        label: state.secondary.label,
        kind: state.secondary.kind,
        frames: state.secondary.cursorFrames,
        excludedRanges: state.secondary.cursorExcludedRanges ?? [],
        coordinateComparable: state.result.compatibility.sameCoordinateTransform,
      });
    }
    return state;
  }

  clearReplayComparison() {
    this.comparisonLoadSequence += 1;
    if (this.lifecycle.enabled) this.lifecycle.record("scenario-comparison-attempt", this, { sequence: this.comparisonLoadSequence, action: "clear" });
    this.replayManager.setComparisonCursorSource(null);
    this.gameSimulator.clearReplayComparison();
  }
}
