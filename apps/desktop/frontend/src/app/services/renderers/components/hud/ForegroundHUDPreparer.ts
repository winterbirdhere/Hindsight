import { injectable } from "inversify";
import { GameSimulator } from "../../../common/game/GameSimulator";
import { Container, Text } from "pixi.js";
import {
  calculateDigits,
  OsuClassicAccuracy,
  OsuClassicHitErrorBar,
  OsuClassicNumber,
} from "@rewind/osu-pixi/classic-components";
import { ANALYSIS_LEFT_HUD_X, ANALYSIS_TIMING_HUD_TOP } from "../../constants";
import { hitWindowsForOD } from "@osujs/math";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { BeatmapManager } from "../../../manager/BeatmapManager";
import { sanitizeUrBarScale } from "../../../common/hit-error-bar";
import { SkinHolder } from "../../../common/skin";
import { ReplayDisplaySettings, ReplayDisplaySettingsStore } from "../../../analysis/replay-display-settings";
import { TimingHitIndex } from "./TimingHitIndex";
import { calculateAnalysisStageLayout, type HudAnchors } from "../stage/AnalysisStageLayout";

const EXPORT_HUD_ANCHORS: HudAnchors = calculateAnalysisStageLayout({ x: 0, y: 0, width: 0, height: 0 }).hud;

function formatTimingBias(count: number, bias: number) {
  if (count === 0) return "BIAS —";
  // Avoid displaying a negative zero when a tiny early bias rounds to zero.
  if (Math.abs(bias) < 0.05) return "BIAS +0.0 ms";

  return `BIAS ${bias < 0 ? "-" : "+"}${Math.abs(bias).toFixed(1)} ms`;
}

@injectable()
export class ForegroundHUDPreparer {
  container: Container;
  stats: Text;
  hitErrorBar: OsuClassicHitErrorBar;
  private readonly comboNumber = new OsuClassicNumber();
  private readonly accuracyNumber = new OsuClassicAccuracy();
  private hudAnchors: HudAnchors = EXPORT_HUD_ANCHORS;

  // Real-time offsets are also used by Rewind's existing timing-bias display.
  allHits: number[] = [];
  private recentHits: Array<{ timeAgo: number; offset: number; miss: boolean }> = [];
  private timingIndex?: TimingHitIndex;
  private indexedHits?: GameSimulator["hits"];
  private indexedLength = 0;
  private indexedRate = 1;
  private indexedRuleset?: ReturnType<GameSimulator["getRulesetFocus"]>;
  private recentHitTime?: number;

  constructor(
    private readonly beatmapManager: BeatmapManager,
    private readonly skinManager: SkinHolder,
    private readonly gameSimulator: GameSimulator,
    private readonly gameplayClock: GameplayClock,
    private readonly replayDisplaySettingsStore: ReplayDisplaySettingsStore,
  ) {
    this.container = new Container();
    this.stats = new Text("", {
      fontSize: 24,
      fill: 0xf4f7fb,
      fontFamily: "Arial",
      fontWeight: "600",
      align: "left",
    });
    this.stats.position.set(ANALYSIS_LEFT_HUD_X, ANALYSIS_TIMING_HUD_TOP);
    this.hitErrorBar = new OsuClassicHitErrorBar();
  }

  setHudAnchors(anchors: HudAnchors) {
    this.hudAnchors = anchors;
  }

  private get anchors(): HudAnchors {
    // Tests build this class without its constructor; fall back to the export geometry.
    return this.hudAnchors ?? EXPORT_HUD_ANCHORS;
  }

  private updateTimingPrefix(collectStats = true, collectHitErrorBar = true) {
    const time = this.gameplayClock.timeElapsedInMs;

    const beatmap = this.beatmapManager.getBeatmap();
    const gameClockRate = beatmap.gameClockRate;
    const ruleset = this.gameSimulator.getRulesetFocus();
    const hits = this.gameSimulator.hits;
    // Stable displays raw map-time UR, while lazer displays real-time UR.
    // Keep the bias offsets unchanged and restore Stable's rate only for UR.
    if (
      !this.timingIndex ||
      this.indexedHits !== hits ||
      this.indexedLength !== hits.length ||
      this.indexedRate !== gameClockRate ||
      this.indexedRuleset !== ruleset
    ) {
      this.timingIndex = new TimingHitIndex(hits, gameClockRate, ruleset === "lazer" ? 1 : gameClockRate);
      this.indexedHits = hits;
      this.indexedLength = hits.length;
      this.indexedRate = gameClockRate;
      this.indexedRuleset = ruleset;
      this.allHits.length = 0;
      this.recentHitTime = undefined;
    }
    const prefixEnd = this.timingIndex.prefixEnd(time);
    const count = collectStats ? this.timingIndex.sampleCount(prefixEnd) : 0;
    if (this.allHits.length > count) this.allHits.length = count;
    for (let index = this.allHits.length; index < count; index++) {
      this.allHits.push(this.timingIndex.successfulOffsets[index]);
    }
    if (collectHitErrorBar && this.recentHitTime !== time) {
      this.recentHits = this.timingIndex.recent(time, prefixEnd);
      this.recentHitTime = time;
    } else if (!collectHitErrorBar) {
      this.recentHits.length = 0;
      this.recentHitTime = undefined;
    }
  }

  private drawHitErrorBar(displaySettings: Readonly<ReplayDisplaySettings>) {
    const beatmap = this.beatmapManager.getBeatmap();
    const isLazer = this.gameSimulator.getRulesetFocus() === "lazer";
    const [hitWindow300, hitWindow100, hitWindow50] = hitWindowsForOD(beatmap.difficulty.overallDifficulty, isLazer);
    this.hitErrorBar.prepare({
      hitWindow50,
      hitWindow100,
      hitWindow300,
      hits: this.recentHits,
    });
    this.hitErrorBar.container.position.set(this.anchors.hitErrorBar.x, this.anchors.hitErrorBar.y);
    this.hitErrorBar.container.scale.set(sanitizeUrBarScale(displaySettings.hitErrorBarScale));
    this.container.addChild(this.hitErrorBar.container);
  }

  updateHitErrorBar() {
    this.updateTimingPrefix();
    this.drawHitErrorBar(this.replayDisplaySettingsStore.settings);
  }

  updateComboNumber(gameplayInfo = this.gameSimulator.getCurrentInfo()) {
    const skin = this.skinManager.getSkin();

    if (gameplayInfo) {
      const comboNumber = this.comboNumber;
      const textures = skin.getComboNumberTextures();
      const overlap = skin.config.fonts.comboOverlap;
      comboNumber.prepare({ digits: calculateDigits(gameplayInfo.currentCombo), textures, overlap });
      comboNumber.position.set(this.anchors.combo.x, this.anchors.combo.y);
      this.container.addChild(comboNumber);
    }
  }

  updateHUD(
    displaySettings: Readonly<ReplayDisplaySettings> = this.replayDisplaySettingsStore.settings,
    showHitErrorBar = displaySettings.hitErrorBarEnabled,
  ) {
    this.container.removeChildren();
    const showTimingText =
      displaySettings.statsStyle !== "compact" &&
      (displaySettings.unstableRateEnabled || displaySettings.timingBiasEnabled);
    const needsGameplayInfo = displaySettings.currentComboEnabled || displaySettings.accuracyEnabled;
    const gameplayInfo = needsGameplayInfo ? this.gameSimulator.getCurrentInfo() : undefined;

    if (displaySettings.currentComboEnabled) this.updateComboNumber(gameplayInfo);
    if (displaySettings.accuracyEnabled) this.updateAccuracy(gameplayInfo);

    if (showTimingText || showHitErrorBar) {
      // Statistics reuse immutable prefixes; only the visible 10-second bar
      // window needs fresh timeAgo values when the playhead changes.
      this.updateTimingPrefix(showTimingText, showHitErrorBar);
      if (showHitErrorBar) this.drawHitErrorBar(displaySettings);
      if (showTimingText) this.updateStats(displaySettings);
    } else {
      this.allHits.length = 0;
      this.recentHits.length = 0;
      this.recentHitTime = undefined;
    }
  }

  private updateAccuracy(gameplayInfo = this.gameSimulator.getCurrentInfo()) {
    const skin = this.skinManager.getSkin();
    if (gameplayInfo) {
      const accNumber = this.accuracyNumber;
      const digitTextures = skin.getScoreTextures();
      const dotTexture = skin.getTexture("SCORE_DOT");
      const percentageTexture = skin.getTexture("SCORE_PERCENT");
      const overlap = skin.config.fonts.scoreOverlap;
      accNumber.prepare({ accuracy: gameplayInfo.accuracy, digitTextures, dotTexture, percentageTexture, overlap });
      accNumber.container.position.set(this.anchors.accuracy.x, this.anchors.accuracy.y);
      this.container.addChild(accNumber.container);
    }
  }

  private updateStats(displaySettings: Readonly<ReplayDisplaySettings> = this.replayDisplaySettingsStore.settings) {
    const gameplayState = this.gameSimulator.getCurrentState();
    if (gameplayState) {
      const parts: string[] = [];
      if (displaySettings.unstableRateEnabled) {
        const unstableRate = this.timingIndex?.unstableRate(this.allHits.length) ?? "—";
        parts.push(`UR ${unstableRate}`);
      }
      if (displaySettings.timingBiasEnabled) {
        parts.push(formatTimingBias(this.allHits.length, this.timingIndex?.mean(this.allHits.length) ?? 0));
      }
      if (parts.length > 0) {
        this.stats.text = parts.join("  ·  ");
        this.container.addChild(this.stats);
      }
    }
  }
}
