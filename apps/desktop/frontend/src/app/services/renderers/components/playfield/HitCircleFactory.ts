import { injectable } from "inversify";
import { HitCircle } from "@osujs/core";
import { hitWindowsForOD } from "@osujs/math";
import { GameplayClock } from "../../../common/game/GameplayClock";
import {
  HitResult,
  OsuClassicApproachCircle,
  OsuClassicApproachCircleSettings,
  OsuClassicHitCircleArea,
  OsuClassicHitCircleAreaSettings,
} from "@rewind/osu-pixi/classic-components";
import type { ISkin } from "../../../../model/Skin";
import { GameSimulator } from "../../../common/game/GameSimulator";
import { TemporaryObjectPool } from "../../../../utils/pooling/TemporaryObjectPool";
import { ModSettingsService } from "../../../analysis/mod-settings";
import { SkinHolder } from "../../../common/skin";
import { classicNotelockShakeOffset, directEarlyMissResolved } from "./HitObjectVisualState";
import { HIT_OBJECT_FADE_OUT_MS } from "./HitObjectVisibilityIndex";

/**
 * Connected to all the different components and knows how to create the corresponding hit circle components (area +
 * approach circle).
 */
@injectable()
export class HitCircleFactory {
  hitAreaPool: TemporaryObjectPool<OsuClassicHitCircleArea>;
  private readonly approachPool = new TemporaryObjectPool(
    () => new OsuClassicApproachCircle({}),
    () => undefined,
    { initialSize: 50 },
  );

  constructor(
    private readonly gameClock: GameplayClock,
    private readonly gameSimulator: GameSimulator,
    private readonly modSettingsService: ModSettingsService,
    private readonly stageSkinService: SkinHolder,
  ) {
    this.hitAreaPool = new TemporaryObjectPool<OsuClassicHitCircleArea>(
      () => new OsuClassicHitCircleArea(),
      () => undefined,
      { initialSize: 50 },
    );
  }

  private getOsuClassicHitCircleArea(id: string) {
    return this.hitAreaPool.allocate(id)[0];
  }

  private getOsuClassicApproachCircle(id: string) {
    return this.approachPool.allocate(id)[0];
  }

  freeResources() {
    this.hitAreaPool.releaseUntouched();
    this.approachPool.releaseUntouched();
  }

  createHitCircle(hitCircle: HitCircle) {
    const time = this.gameClock.timeElapsedInMs;
    const modSettings = this.modSettingsService.modSettings;
    const skin = this.stageSkinService.getSkin();
    const gameplayState = this.gameSimulator.getCurrentState();
    const hitCircleState = gameplayState?.hitCircleVerdict[hitCircle.id];

    const modHidden = modSettings.hidden;

    const isVisible = hitCircle.spawnTime <= time && time <= hitCircle.hitTime + HIT_OBJECT_FADE_OUT_MS;

    if (!isVisible || directEarlyMissResolved(time, hitCircle.hitTime, hitCircleState)) return undefined;

    const area = this.getOsuClassicHitCircleArea(hitCircle.id);
    // TODO: Replace this with a service that can also be mocked and simulate AUTO play
    const hitResult = hitCircleState
      ? {
          hit: hitCircleState.type !== "MISS",
          timing: hitCircleState.judgementTime - hitCircle.hitTime,
        }
      : null;
    const beatmap = this.gameSimulator.getPrimaryBeatmap();
    const classic = this.gameSimulator.getRulesetFocus() === "lazer" ? beatmap?.lazerModSettings.classic : undefined;
    let idleFadeOut: readonly [number, number] | undefined;
    if (classic && beatmap) {
      const [, ok, meh] = hitWindowsForOD(beatmap.difficulty.overallDifficulty, true);
      idleFadeOut = classic.fadeHitCircleEarly ? [ok, meh] : [meh, meh + 100];
    }
    area.prepare({
      ...createHitCircleAreaSettings({ hitCircle, gameTime: time, modHidden, skin, hitResult }),
      idleFadeOut,
    });

    const approachCircle = this.getOsuClassicApproachCircle(hitCircle.id);
    approachCircle.prepare(createApproachCircleSettings({ hitCircle, skin, gameTime: time, modHidden, hitResult }));

    // Rewind's Stable view keeps slider heads fixed on rejected input while
    // retaining their notelock evidence. Lazer and standalone hit circles keep
    // their existing rejected-input shake.
    const suppressStableSliderShake =
      hitCircle.sliderId !== undefined && this.gameSimulator.getRulesetFocus() === "stable";
    const shakeOffset = suppressStableSliderShake
      ? 0
      : classicNotelockShakeOffset(time, gameplayState?.lastNotelockShakeTime[hitCircle.id]);
    area.container.position.x += shakeOffset;
    approachCircle.sprite.position.x += shakeOffset;

    return {
      hitCircleArea: area.container,
      approachCircle: approachCircle.sprite,
    };
  }
}

export function createApproachCircleSettings(s: {
  hitCircle: HitCircle;
  skin: ISkin;
  gameTime: number;
  modHidden?: boolean;
  hitResult?: HitResult | null;
}): Partial<OsuClassicApproachCircleSettings> {
  const { hitCircle, skin, gameTime, modHidden, hitResult } = s;
  return {
    time: gameTime - hitCircle.hitTime,
    texture: skin.getTexture("APPROACH_CIRCLE"),
    approachDuration: hitCircle.approachDuration,
    scale: hitCircle.scale,
    position: hitCircle.position,
    tint: skin.getComboColorForIndex(hitCircle.comboSetIndex),
    modHidden: modHidden,
    hitResult: hitResult ?? null,
    // fadeInDuration, numberScaling
  };
}

function createHitCircleAreaSettings(s: {
  hitCircle: HitCircle;
  skin: ISkin;
  gameTime: number;
  modHidden?: boolean;
  hitResult: HitResult | null;
}): Partial<OsuClassicHitCircleAreaSettings> {
  const { gameTime, hitCircle, skin, modHidden, hitResult } = s;
  return {
    time: gameTime - hitCircle.hitTime,
    numberTextures: skin.getHitCircleNumberTextures(),
    numberOverlap: skin.config.fonts.hitCircleOverlap,
    hitCircleOverlayAboveNumber: skin.config.general.hitCircleOverlayAboveNumber,

    hitCircleTexture: skin.getTexture("HIT_CIRCLE"),
    hitCircleOverlayTexture: skin.getTexture("HIT_CIRCLE_OVERLAY"),

    tint: skin.getComboColorForIndex(hitCircle.comboSetIndex),

    number: hitCircle.withinComboSetIndex + 1,
    approachDuration: hitCircle.approachDuration,

    modHidden,
    scale: hitCircle.scale,
    position: hitCircle.position,
    hitResult,
    // fadeInDuration, numberScaling
  };
}
