export class HitSampleInfo {
  static HIT_WHISTLE = "hitwhistle";
  static HIT_FINISH = "hitfinish";
  static HIT_NORMAL = "hitnormal";
  static HIT_CLAP = "hitclap";
  static SLIDER_SLIDE = "sliderslide";
  static SLIDER_WHISTLE = "sliderwhistle";
  static SPINNER_SPIN = "spinnerspin";
  static SPINNER_BONUS = "spinnerbonus";

  volume = 0;
  lookupNames?: IterableIterator<string>;

  static ALL_ADDITIONS = [HitSampleInfo.HIT_WHISTLE, HitSampleInfo.HIT_CLAP, HitSampleInfo.HIT_FINISH];

  // name could be one of those HIT_WHISTLE, ...
  name = "";
  // sample set such as drum, normal, soft
  bank: string | null;
  suffix: string | null;
  /** Explicit beatmap sample filename, relative to the beatmap folder. */
  customFilename: string | null;
  /** Legacy sample index. Zero uses skin/default resources; one or higher may use beatmap samples. */
  customSampleBank: number;

  constructor(
    name: string,
    bank: string | null = null,
    suffix: string | null = null,
    volume = 0,
    customFilename: string | null = null,
    customSampleBank = suffix ? Number(suffix) : 0,
  ) {
    this.name = name;
    this.bank = bank;
    this.suffix = suffix;
    this.volume = volume;
    this.customFilename = customFilename;
    this.customSampleBank = Number.isFinite(customSampleBank) ? customSampleBank : 0;
  }

  // with() for overriding
}
