import { Position } from "@osujs/math";
import { HitObjectType } from "./Types";
import { HasHitTime, HasId, HasPosition, HasSpawnTime } from "./Properties";
import { HitSampleInfo } from "../audio/HitSampleInfo";

export class HitCircle implements HasId, HasPosition, HasHitTime, HasSpawnTime {
  static OBJECT_RADIUS = 64;

  id = "";
  hitTime = 0;
  approachDuration = 0;

  comboSetIndex = 0;
  withinComboSetIndex = 0;

  scale = 1;
  /** Retained for lazer Classic's stacked-object input policy. */
  stackHeight = 0;
  position: Position = { x: 0, y: 0 };

  // Only used because there's a bug in the Flashlight difficulty processing
  unstackedPosition: Position = { x: 0, y: 0 };

  sliderId?: string;
  samples: HitSampleInfo[] = [];

  get type(): HitObjectType {
    return "HIT_CIRCLE";
  }

  get radius(): number {
    return HitCircle.OBJECT_RADIUS * this.scale;
  }

  get spawnTime(): number {
    return this.hitTime - this.approachDuration;
  }
}
