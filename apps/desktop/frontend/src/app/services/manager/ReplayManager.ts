// Holds the replays
import { injectable } from "inversify";
import { OsuReplay } from "../../model/OsuReplay";
import { BehaviorSubject } from "rxjs";
import type { ReplayFrame } from "@osujs/core";
import type { CursorExcludedTimeRange } from "../analysis/replay-comparison";

export interface ComparisonCursorSource {
  id: string;
  label: string;
  kind: "replay" | "autoplay-reference";
  frames: readonly ReplayFrame[];
  excludedRanges: readonly CursorExcludedTimeRange[];
  coordinateComparable: boolean;
}

@injectable()
export class ReplayManager {
  // mainReplay: OsuReplay | null = null;
  mainReplay$: BehaviorSubject<OsuReplay | null>;
  comparisonCursorSource$: BehaviorSubject<ComparisonCursorSource | null>;

  constructor() {
    this.mainReplay$ = new BehaviorSubject<OsuReplay | null>(null);
    this.comparisonCursorSource$ = new BehaviorSubject<ComparisonCursorSource | null>(null);
  }

  getMainReplay() {
    return this.mainReplay$.value;
  }

  setMainReplay(replay: OsuReplay | null) {
    this.mainReplay$.next(replay);
  }

  getComparisonCursorSource() {
    return this.comparisonCursorSource$.value;
  }

  setComparisonCursorSource(source: ComparisonCursorSource | null) {
    this.comparisonCursorSource$.next(source);
  }
}
