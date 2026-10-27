import { ControlPoint } from "./ControlPoint";

export class SampleControlPoint extends ControlPoint {
  static TYPE = "SampleControlPoint";
  static DEFAULT_BANK = "normal";
  static DEFAULT = new SampleControlPoint();

  sampleBank = SampleControlPoint.DEFAULT_BANK;
  sampleVolume = 100;
  customSampleBank = 0;

  isRedundant(existing: ControlPoint): boolean {
    if (existing.type !== SampleControlPoint.TYPE) return false;
    const e = existing as SampleControlPoint;
    return (
      this.sampleBank === e.sampleBank &&
      this.sampleVolume === e.sampleVolume &&
      this.customSampleBank === e.customSampleBank
    );
  }

  get type(): string {
    return SampleControlPoint.TYPE;
  }
}
