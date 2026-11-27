import { injectable } from "inversify";
import { Spinner, spinnerBonusProgress } from "@osujs/core";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { OsuClassicSpinner } from "@rewind/osu-pixi/classic-components";
import { GameSimulator } from "../../../common/game/GameSimulator";
import { ModSettingsService } from "../../../analysis/mod-settings";
import { SkinHolder } from "../../../common/skin";
import { rgbToInt } from "@osujs/math";

@injectable()
export class SpinnerFactory {
  constructor(
    private readonly gameClock: GameplayClock,
    private readonly gameSimulator: GameSimulator,
    private readonly modSettingsService: ModSettingsService,
    private readonly stageSkinService: SkinHolder,
  ) {}

  create(spinner: Spinner) {
    const skin = this.stageSkinService.getSkin();
    const time = this.gameClock.timeElapsedInMs;
    const { hidden } = this.modSettingsService.modSettings;

    if (
      spinner.startTime - spinner.fadeInDuration <= time &&
      time <= spinner.endTime + OsuClassicSpinner.FADE_OUT_DURATION
    ) {
      const visualState = this.gameSimulator.getCurrentSpinnerVisualState(spinner);
      const spinnerState = this.gameSimulator.getCurrentState()?.spinnerState.get(spinner.id);
      const bonus = spinnerBonusProgress(spinner, spinnerState, this.gameSimulator.getRulesetFocus());
      const gSpinner = new OsuClassicSpinner();
      gSpinner.prepare({
        approachCircleTexture: skin.getTexture("SPINNER_APPROACH_CIRCLE"),
        backgroundTexture: skin.getTexture("SPINNER_BACKGROUND"),
        bottomTexture: skin.getTexture("SPINNER_BOTTOM"),
        circleTexture: skin.getTexture("SPINNER_CIRCLE"),
        glowTexture: skin.getTexture("SPINNER_GLOW"),
        middleTexture: skin.getTexture("SPINNER_MIDDLE"),
        middle2Texture: skin.getTexture("SPINNER_MIDDLE2"),
        topTexture: skin.getTexture("SPINNER_TOP"),
        backgroundTint: rgbToInt(skin.config.colors.spinnerBackground),
        duration: spinner.duration,
        fadeInDuration: spinner.fadeInDuration,
        rotationDegrees: visualState.rotationDegrees,
        progress: visualState.progress,
        bonusScore: bonus.score,
        bonusAge: spinnerState?.lastSpinCompletionTime === undefined ? -1 : time - spinnerState.lastSpinCompletionTime,
        bonusIsMaximum: bonus.maximumScore !== undefined && bonus.score >= bonus.maximumScore,
        scoreTextures: skin.getScoreTextures(),
        scoreOverlap: skin.config.fonts.scoreOverlap,
        time: time - spinner.endTime,
        modHidden: hidden,
      });

      return gSpinner;
    }
    return undefined;
  }
}
