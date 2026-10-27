import { ControlPoint } from "./ControlPoint";

export class DifficultyControlPoint extends ControlPoint {
  static DEFAULT: DifficultyControlPoint = new DifficultyControlPoint();
  static TYPE = "DifficultyControlPoint";
  speedMultiplier = 1;
  /** Original inherited timing value, retained for Stable float arithmetic. */
  sourceBeatLength?: number;

  get type(): string {
    return DifficultyControlPoint.TYPE;
  }

  isRedundant(existing: ControlPoint): boolean {
    return false;
  }
}
