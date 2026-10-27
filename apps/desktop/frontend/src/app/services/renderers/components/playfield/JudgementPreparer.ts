import { injectable } from "inversify";
import { Container } from "pixi.js";
import { OsuClassicJudgement, OsuLazerSliderMissJudgement } from "@rewind/osu-pixi/classic-components";
import { circleSizeToScale } from "@osujs/math";
import { HitObjectJudgement, MainHitObjectVerdict } from "@osujs/core";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { GameSimulator } from "../../../common/game/GameSimulator";
import { BeatmapManager } from "../../../manager/BeatmapManager";
import { SkinHolder } from "../../../common/skin";
import { collectLazerSliderMissFeedback } from "./LazerSliderJudgementFeedback";
import { SliderMissFeedbackTints } from "../../../../utils/constants";

function texturesForJudgement(t: MainHitObjectVerdict, lastInComboSet?: boolean) {
  switch (t) {
    case "GREAT":
      return lastInComboSet ? "HIT_300K" : "HIT_300";
    case "OK":
      return lastInComboSet ? "HIT_100K" : "HIT_100";
    case "MEH":
      return "HIT_50";
    case "MISS":
      return "HIT_0";
  }
}

export function classicJudgementAnimationAge(currentTime: number, judgement: HitObjectJudgement): number {
  const resolvedAge = currentTime - judgement.time;
  if (
    judgement.verdict !== "MISS" ||
    judgement.missReason !== "TIME_EXPIRED" ||
    resolvedAge < 0 ||
    judgement.objectTime === undefined
  )
    return resolvedAge;

  // A timeout MISS resolves after the 50 window. Starting the analysis sprite
  // from that already-elapsed nominal-object age avoids a nearly invisible
  // first frame when another error follows immediately, without displaying it
  // before the evaluator has actually resolved the miss.
  const nominalObjectAge = Math.max(0, currentTime - judgement.objectTime);
  return Math.max(resolvedAge, Math.min(OsuClassicJudgement.MISS_FADE_IN_DURATION, nominalObjectAge));
}

@injectable()
export class JudgementPreparer {
  private readonly container: Container;
  private readonly componentContainer: Container;

  constructor(
    private readonly gameClock: GameplayClock,
    private readonly stageSkinService: SkinHolder,
    private readonly beatmapManager: BeatmapManager,
    private readonly gameSimulator: GameSimulator,
  ) {
    this.container = new Container();
    this.componentContainer = new Container();
  }

  getContainer() {
    return this.container;
  }

  getComponentContainer() {
    return this.componentContainer;
  }

  private drawLazerSliderMissFeedback(time: number, scale: number) {
    if (this.gameSimulator.getRulesetFocus() !== "lazer") return;

    const skin = this.stageSkinService.getSkin();
    const feedbackEvents = collectLazerSliderMissFeedback(this.gameSimulator.replayEvents$.getValue());
    for (const feedback of feedbackEvents) {
      const age = time - feedback.time;
      if (age < 0 || age >= OsuLazerSliderMissJudgement.ANIMATION_DURATION) continue;

      const judgement = new OsuLazerSliderMissJudgement();
      judgement.prepare({
        time: age,
        position: feedback.position,
        scale,
        textures: skin.getTextures(feedback.kind === "SLIDER_END" ? "SLIDER_END_MISS" : "SLIDER_TICK_MISS"),
        animationFrameRate: skin.config.general.animationFrameRate ?? 60,
      });
      judgement.sprite.tint =
        feedback.kind === "SLIDER_END"
          ? SliderMissFeedbackTints.SLIDER_END_MISS
          : SliderMissFeedbackTints.SLIDER_TICK_MISS;
      this.componentContainer.addChild(judgement.sprite);
    }
  }

  updateJudgements() {
    this.container.removeChildren();
    this.componentContainer.removeChildren();
    const beatmap = this.beatmapManager.getBeatmap();
    const time = this.gameClock.timeElapsedInMs;
    const skin = this.stageSkinService.getSkin();
    const judgements = this.gameSimulator.judgements;
    // TODO: Order might not be correct
    for (const j of judgements) {
      const resolvedAge = time - j.time;
      if (!(resolvedAge >= 0 && resolvedAge < 3000) || j.verdict === "GREAT") continue;
      const animationAge = classicJudgementAnimationAge(time, j);

      const lastInComboSet = false;
      const textures = skin.getTextures(texturesForJudgement(j.verdict, lastInComboSet));
      const animationFrameRate = skin.config.general.animationFrameRate;
      const judgement = new OsuClassicJudgement();
      const scale = circleSizeToScale(beatmap.difficulty.circleSize);

      // TODO: Should be configurable, technically speaking sliderHeadJudgementSkip=false does not reflect osu!stable
      // (it resembles lazer) However, in this replay analysis tool this is more useful (?)
      const sliderHeadJudgementSkip = this.gameSimulator.getRulesetFocus() === "stable";
      if (sliderHeadJudgementSkip && j.isSliderHead) continue;
      judgement.prepare({
        time: animationAge,
        position: j.position,
        scale,
        animationFrameRate,
        textures,
        isMiss: j.verdict === "MISS",
      });
      // judgement.sprite.zIndex = -timeAgo;
      this.container.addChild(judgement.sprite);
    }
    this.drawLazerSliderMissFeedback(time, circleSizeToScale(beatmap.difficulty.circleSize));
    // this.judgementLayer.sortChildren();
  }
}
