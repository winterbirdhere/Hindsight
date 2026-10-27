import { Container, inject, injectable, optional } from "inversify";
import { NOOP_VIEWER_LIFECYCLE, VIEWER_LIFECYCLE_OBSERVER, ViewerLifecycleObserver } from "./ViewerLifecycleObserver";
import { createViewerLifecycleObserver } from "./ViewerLifecycleObserverFactory";
import { migrateSettings } from "./settings-migration";
import { ReplayService } from "./local/ReplayService";
import { SkinLoader } from "./local/SkinLoader";
import { AudioService } from "./audio/AudioService";
import { createRewindAnalysisApp } from "../analysis/createRewindAnalysisApp";
import { AudioSettingsStore } from "./audio/settings";
import { BeatmapBackgroundSettingsStore } from "./beatmap-background";
import { PlayfieldBorderSettingsStore } from "./playfield-border";
import { AnalysisCursorSettingsStore } from "../analysis/analysis-cursor";
import { ReplayCursorSettingsStore } from "./replay-cursor";
import { SkinHolder, SkinManager, SkinSettingsStore } from "./skin";
import { PlaybarSettingsStore } from "./playbar";
import { OsuFolderService } from "./local/OsuFolderService";
import { OsuDBDao } from "./local/OsuDBDao";
import { BlueprintLocatorService } from "./local/BlueprintLocatorService";
import { BeatmapRenderService } from "./beatmap-render";
import { STAGE_TYPES } from "../types";
import { AppInfoService } from "./app-info";
import { OnlineBeatmapLookupService } from "./OnlineBeatmapLookupService";
import { LibraryClient } from "../library/library-client";
import { LibraryReplayResourceClient } from "../library/library-replay-resources";
import { LibraryCurrentReplayPublisher } from "../library/library-current-replay-publisher";
import { frontendAPI } from "../../api";

/**
 * Creates the services that support all the osu! tools such as the Analyzer.
 * Common settings are set here so that they can be shared with other tools.
 * Example: Preferred skin can be set at only one place and is shared among all tools.
 */
@injectable()
export class CommonManagers {
  private initialization: Promise<void> | undefined;
  private readonly lifecycle: ViewerLifecycleObserver;

  constructor(
    public readonly skinManager: SkinManager,
    public readonly skinSettingsStore: SkinSettingsStore,
    public readonly audioSettingsService: AudioSettingsStore,
    public readonly beatmapBackgroundSettingsStore: BeatmapBackgroundSettingsStore,
    public readonly beatmapRenderSettingsStore: BeatmapRenderService,
    public readonly analysisCursorSettingsStore: AnalysisCursorSettingsStore,
    public readonly replayCursorSettingsStore: ReplayCursorSettingsStore,
    public readonly playbarSettingsStore: PlaybarSettingsStore,
    public readonly appInfoService: AppInfoService,
    @inject(VIEWER_LIFECYCLE_OBSERVER) @optional() lifecycle?: ViewerLifecycleObserver,
  ) {
    this.lifecycle = lifecycle === undefined ? NOOP_VIEWER_LIFECYCLE : lifecycle;
    if (this.lifecycle.enabled) this.lifecycle.record("common-created", this);
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      if (this.lifecycle.enabled) this.lifecycle.record("common-initialize-attempt", this);
      this.initialization = this.skinManager.loadPreferredSkin().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }
}

interface Settings {
  rewindSkinsFolder: string;
  appVersion: string;
  appPlatform: string;
}

export function createRewindTheater({ rewindSkinsFolder, appPlatform, appVersion }: Settings) {
  migrateSettings(window.localStorage);
  // Regarding `skipBaseClassChecks`: https://github.com/inversify/InversifyJS/issues/522#issuecomment-682246076
  const container = new Container({ defaultScope: "Singleton" });
  const lifecycle = createViewerLifecycleObserver();
  container.bind(VIEWER_LIFECYCLE_OBSERVER).toConstantValue(lifecycle);
  if (lifecycle.enabled) lifecycle.record("theater-created", container);
  const audioContext = new AudioContext();
  container.bind(STAGE_TYPES.AUDIO_CONTEXT).toConstantValue(audioContext);
  if (lifecycle.enabled) lifecycle.record("audio-context-created", audioContext);
  container.bind(STAGE_TYPES.REWIND_SKINS_FOLDER).toConstantValue(rewindSkinsFolder);
  container.bind(STAGE_TYPES.APP_PLATFORM).toConstantValue(appPlatform);
  container.bind(STAGE_TYPES.APP_VERSION).toConstantValue(appVersion);
  container.bind(OsuFolderService).toSelf();
  container.bind(OsuDBDao).toSelf();
  container.bind(BlueprintLocatorService).toSelf();
  container.bind(OnlineBeatmapLookupService).toSelf();
  container.bind(ReplayService).toSelf();
  container.bind(SkinLoader).toSelf();
  container.bind(SkinHolder).toSelf();
  container.bind(AudioService).toSelf();
  container.bind(SkinManager).toSelf();
  container.bind(AppInfoService).toSelf();

  // General settings stores
  container.bind(AudioSettingsStore).toSelf();
  container.bind(AnalysisCursorSettingsStore).toSelf();
  container.bind(BeatmapBackgroundSettingsStore).toSelf();
  container.bind(BeatmapRenderService).toSelf();
  container.bind(PlayfieldBorderSettingsStore).toSelf();
  container.bind(ReplayCursorSettingsStore).toSelf();
  container.bind(SkinSettingsStore).toSelf();
  container.bind(PlaybarSettingsStore).toSelf();

  // Theater facade
  container.bind(CommonManagers).toSelf();

  const analyzer = createRewindAnalysisApp(container);
  const library = new LibraryClient(frontendAPI.library);
  library.connect(analyzer);
  const libraryResources = new LibraryReplayResourceClient(frontendAPI.library);
  const currentReplayPublisher = new LibraryCurrentReplayPublisher({ simulator: analyzer.gameSimulator,
    performance: analyzer.performanceTimeline, request: request => frontendAPI.library.request(request) });
  analyzer.scenarioManager.setCurrentReplayPublisher(currentReplayPublisher);
  analyzer.scenarioManager.setLibraryReplaySource({
    acquireForeground: () => library.acquireForeground(),
    open: async (id, signal) => { await library.whenReady(signal); signal.throwIfAborted(); return libraryResources.open(id, signal); },
  });
  const common = container.get(CommonManagers);
  if (lifecycle.enabled) lifecycle.record("theater-ready", container, {
    commonId: lifecycle.id(common), analyzerId: lifecycle.id(analyzer), scenarioId: lifecycle.id(analyzer.scenarioManager),
    clockId: lifecycle.id(analyzer.gameClock), contextId: lifecycle.id(audioContext),
  });
  return {
    common,
    analyzer,
    library,
    currentReplayPublisher,
  };
}

export type RewindTheater = ReturnType<typeof createRewindTheater>;
