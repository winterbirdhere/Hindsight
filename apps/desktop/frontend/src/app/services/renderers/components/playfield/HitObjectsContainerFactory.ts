import { Container } from "pixi.js";
import { injectable } from "inversify";
import { HitCircle, isHitCircle, isSlider, Slider, Spinner } from "@osujs/core";
import { HitCircleFactory } from "./HitCircleFactory";
import { SliderFactory } from "./SliderFactory";
import { SpinnerFactory } from "./SpinnerFactory";
import { BeatmapManager } from "../../../manager/BeatmapManager";
import { GameplayClock } from "../../../common/game/GameplayClock";
import { HitObjectVisibilityIndex } from "./HitObjectVisibilityIndex";

export class HitObjectsContainer {
  approachCircleContainer: Container;
  spinnerProxies: Container;
  hitObjectContainer: Container;
  private visibility = new HitObjectVisibilityIndex([]);

  constructor(
    private readonly beatmapManager: BeatmapManager,
    private readonly hitCircleFactory: HitCircleFactory,
    private readonly sliderFactory: SliderFactory,
    private readonly spinnerFactory: SpinnerFactory,
    private readonly gameClock: GameplayClock,
  ) {
    this.approachCircleContainer = new Container();
    this.hitObjectContainer = new Container();
    this.spinnerProxies = new Container();
    this.beatmapManager.beatmap$.subscribe((beatmap) => {
      this.visibility = new HitObjectVisibilityIndex(beatmap.hitObjects);
    });
  }

  private createHitCircle(hitCircle: HitCircle) {
    const { hitCircleArea, approachCircle } = this.hitCircleFactory.createHitCircle(hitCircle) ?? {};
    if (hitCircleArea) this.hitObjectContainer.addChild(hitCircleArea);
    if (approachCircle) this.approachCircleContainer.addChild(approachCircle);
  }

  private createSlider(slider: Slider) {
    const body = this.sliderFactory.create(slider);
    if (body) this.hitObjectContainer.addChild(body);
    this.createHitCircle(slider.head);
  }

  private createSpinner(spinner: Spinner) {
    const spinnerGraphic = this.spinnerFactory.create(spinner);
    if (spinnerGraphic) this.spinnerProxies.addChild(spinnerGraphic.container);
  }

  updateHitObjects() {
    this.hitObjectContainer.removeChildren();
    this.spinnerProxies.removeChildren();
    this.approachCircleContainer.removeChildren();

    for (const hitObject of this.visibility.at(this.gameClock.timeElapsedInMs)) {
      if (isHitCircle(hitObject)) {
        this.createHitCircle(hitObject);
      } else if (isSlider(hitObject)) {
        this.createSlider(hitObject);
      } else {
        this.createSpinner(hitObject);
      }
    }

    this.hitCircleFactory.freeResources();
    this.sliderFactory.postUpdate();
  }
}

@injectable()
export class HitObjectsContainerFactory {
  constructor(
    private readonly beatmapManager: BeatmapManager,
    private readonly hitCirclePreparer: HitCircleFactory,
    private readonly sliderPreparer: SliderFactory,
    private readonly spinnerPreparer: SpinnerFactory,
    private readonly gameClock: GameplayClock,
  ) {}

  createHitObjectsContainer() {
    return new HitObjectsContainer(
      this.beatmapManager,
      this.hitCirclePreparer,
      this.sliderPreparer,
      this.spinnerPreparer,
      this.gameClock,
    );
  }
}
